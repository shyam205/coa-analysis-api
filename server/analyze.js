// Runs the analysis for one store URL. Server-side only (never import this from src/).
//   runScan:       homepage check -> candidates -> Agent 1 (crawler) -> Agent 2 (extractor) -> prune + findings
//   runEvaluation: answers -> score.js (fixed code) -> Agent 3 (evaluator) -> results
// Pages are fetched directly by this server (server/fetcher.js). No scraping service is used.
import { AnalyzeError } from './errors.js'
import { createFetcher, normaliseUrl, readRobots } from './fetcher.js'
import { buildCandidates } from './agent/candidates.js'
import { createToolbox, urlKey } from './agent/tools.js'
import { MAX_FETCHES, MAX_PDFS, runCrawler, runExtractor } from './agent/run.js'
import { buildFindings, pruneEvidence } from './agent/evidence.js'
import { scoreEvidence } from './agent/score.js'
import { runEvaluator } from './agent/evaluator.js'
import { CATEGORIES, categoryKey } from '../shared/questions.js'

export { AnalyzeError, normaliseUrl }

const CRAWLER_SHARE = 0.6 // share of the scan time budget the crawler may use

function looksPasswordProtected(res) {
  if (res.status === 401) return true
  try {
    if (/^\/password\/?$/.test(new URL(res.url).pathname)) return true
  } catch {}
  const html = res.text || ''
  return /<form[^>]+action=["'][^"']*\/password["']/i.test(html) || /template-password|password-page/i.test(html)
}

/** Loads the homepage once to resolve redirects (e.g. -> www.) and catch unusable stores early. */
async function openStore(input, fetcher) {
  const start = normaliseUrl(input)
  const res = await fetcher.getText(start)
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new AnalyzeError('This store blocked our request, so we can’t check its pages. Please try again later or contact us.', 422)
    }
    if (res.reason === 'blocked address') throw new AnalyzeError('That address isn’t a public website.', 400)
    if (res.status === 404) throw new AnalyzeError('We couldn’t find a store at that address. Check the spelling and try again.', 422)
    throw new AnalyzeError('We couldn’t reach that website. Check the address and try again.', 422)
  }
  if (looksPasswordProtected(res)) {
    throw new AnalyzeError('This store is password-protected, so we can’t see its pages. Remove the password or try another store.', 422)
  }
  if (!/html/.test(res.contentType || 'text/html')) throw new AnalyzeError('That address doesn’t lead to a web page.', 422)
  return new URL(res.url).origin
}

/**
 * Agents 1 + 2. Pass `agents` to swap in test doubles (runCrawler, runExtractor, createFetcher).
 * @param {{ url: string, report: (p: {agent: string, step: string, done: number, total: number}) => void, signal?: AbortSignal, deadline: number, log?: Function, agents?: object }} opts
 */
export async function runScan({ url, report, signal, deadline, log = () => {}, agents = {} }) {
  const crawler = agents.runCrawler || runCrawler
  const extractor = agents.runExtractor || runExtractor
  const started = Date.now()
  const fetcher = (agents.createFetcher || createFetcher)({ signal })

  report({ agent: 'crawler', step: 'Opening the store', done: 0, total: 1 })
  const origin = await openStore(url, fetcher)

  report({ agent: 'crawler', step: 'Reading the sitemap', done: 0, total: 1 })
  const robots = await readRobots(origin, fetcher)
  const candidates = await buildCandidates(origin, fetcher, robots)
  log(`candidates: ${JSON.stringify(candidates.counts)}`)

  const toolbox = createToolbox({ origin, fetcher, robots, maxFetches: MAX_FETCHES, maxPdfs: MAX_PDFS })
  const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0, turns: 0 }
  const crawlDeadline = started + (deadline - started) * CRAWLER_SHARE
  const ctx = { origin, toolbox, signal, report, log, usage }

  const crawl = await crawler({ ...ctx, candidates, deadline: crawlDeadline })
  if (!toolbox.state.fetchedKeys.size) {
    throw new AnalyzeError('We couldn’t open any pages on this store. It may block automated visits.', 422)
  }
  const rawEvidence = await extractor({ ...ctx, crawl, deadline })

  // Drop anything that points at a URL we never fetched.
  const { evidence, dropped } = pruneEvidence(rawEvidence, toolbox.state)
  if (dropped.length) log(`dropped ${dropped.length} unverified finding(s): ${dropped.slice(0, 5).join(', ')}`)
  if (evidence.category_guess === 'other' && crawl.category_guess) evidence.category_guess = crawl.category_guess

  const category = categoryKey(evidence.category_guess)
  const pages = toolbox.state.fetched.filter((f) => f.ok && f.kind !== 'pdf').map((f) => f.url)
  const documents = toolbox.state.fetched.filter((f) => f.ok && (f.kind === 'pdf' || f.kind === 'image')).map((f) => f.url)
  return {
    url: origin,
    category,
    category_name: CATEGORIES[category].name,
    findings: buildFindings(evidence, CATEGORIES[category].name),
    checked: { pages: [...new Set(pages)], documents: [...new Set(documents)] },
    evidence,
    stats: {
      pages_fetched: toolbox.state.fetches,
      pdfs_read: toolbox.state.pdfs,
      requests: fetcher.stats.requests,
      dropped_findings: dropped.length,
      ai: { ...usage, seconds: Math.round((Date.now() - started) / 1000) },
    },
  }
}

/**
 * score.js + Agent 3.
 * @param {{ scan: object, answers: object, log?: Function, agents?: object }} opts
 */
export async function runEvaluation({ scan, answers, log = () => {}, agents = {} }) {
  const evaluator = agents.runEvaluator || runEvaluator
  const scored = scoreEvidence(scan.evidence, answers, scan.category, scan.findings)
  const checkedUrls = [...scan.checked.pages, ...scan.checked.documents]
  const { results, source } = await evaluator({
    evidence: scan.evidence,
    findings: scan.findings,
    answers,
    scored,
    category: scan.category,
    checkedUrls,
    log,
  })
  // evidence_url must point at something we actually checked.
  const checked = new Set(checkedUrls.map(urlKey))
  results.fixes = results.fixes.map((f) => ({ ...f, evidence_url: f.evidence_url && checked.has(urlKey(f.evidence_url)) ? f.evidence_url : null }))
  return {
    scores: { overall: scored.overall, label: scored.label, items: scored.scores },
    results: { ...results, missing_tests: scored.missing_tests },
    source,
  }
}
