// Scores the evidence + answers. Deterministic: the same input always gives the same score.
// The agents collect facts and write text; all scoring lives here, never in the LLM or the widget.
// Formula ported from the "COA Presentation Assessment" design: five equally weighted dimensions,
// each combining website findings (from the evidence) with the owner's answers.
import { CATEGORIES, DIMENSIONS, TESTS, TRUEBATCH, points } from '../../shared/questions.js'

const arr = (v) => (Array.isArray(v) ? v : [])
const found = (v) => Boolean(v && typeof v === 'object' && v.found)
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0)
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)))

/** Website-only scores (0-100) for the four dimensions a storefront can show. */
export function webScores(ev) {
  const products = arr(ev.products_checked)
  const docs = arr(ev.coa_documents)
  const methods = new Set(arr(ev.access_methods))
  const realDocs = docs.filter((d) => d.has_results)
  const widgets = arr(ev.coa_widgets) // embedded lab-report panels count as published reports with results
  const withCoa = products.filter((p) => p.coa_link)
  const withInfo = products.filter((p) => p.testing_info || p.coa_link)
  const withBatchDocs = docs.filter((d) => d.batch)
  const withBatchPages = products.filter((p) => p.batch_on_page)
  const hasTestingPage = arr(ev.testing_pages).length > 0 || methods.has('separate_page')
  const coverage = pct(withCoa.length, products.length)

  const avail = clamp((realDocs.length || widgets.length ? 40 : docs.length ? 25 : found(ev.email_request) ? 10 : 0) + coverage * 0.45 + (hasTestingPage ? 15 : 0))
  const access = clamp(
    (hasTestingPage ? 25 : 0) + (methods.has('product_page') || withCoa.length ? 20 : 0) + coverage * 0.25 + (found(ev.batch_lookup) ? 20 : 0) + (docs.length || widgets.length ? 10 : found(ev.email_request) ? 5 : 0),
  )
  const trace = clamp(pct(withBatchDocs.length, docs.length) * 0.5 + pct(withBatchPages.length, products.length) * 0.15 + (found(ev.batch_lookup) ? 25 : 0) + (found(ev.matching_instructions) ? 10 : 0))
  const present = clamp(pct(withInfo.length, products.length) * 0.6 + coverage * 0.25 + (found(ev.homepage_testing_claim) ? 15 : 0))
  return { avail, access, trace, present }
}

export const tier = (score, key) => DIMENSIONS[key][score >= 75 ? 1 : score >= 50 ? 2 : 3]
export const scoreLabel = (s) => (s >= 80 ? 'Strong' : s >= 60 ? 'Developing' : s >= 40 ? 'Emerging' : 'Early stage')
const priority = (s) => (s < 50 ? 'high' : s < 75 ? 'medium' : 'low')

const REC = {
  avail: ['Extend report coverage to every product', 'Add the missing products and formats to your testing programme documentation and publish what you have.'],
  access: ['Make COAs reachable from every product page', 'Add a "Lab reports" link or panel directly on each product page so shoppers do not need to leave the purchase flow.'],
  trace: ['Connect each report to its batch or lot', 'Show lot numbers on reports and give customers a way to match the lot printed on their pack, such as a lot lookup or a variant-level link.'],
  present: ['Show testing information at the point of purchase', 'Add a short summary of what was tested and the headline result near the add-to-cart area, with a link to the full report.'],
  internal: ['Standardise internal COA management', 'Move reports into one system with consistent naming (product, variant, lot, date) and a review reminder for expiring reports.'],
}

/** A URL from the evidence that illustrates each dimension (or null). */
function evidenceUrlFor(key, ev) {
  const products = arr(ev.products_checked)
  const docs = arr(ev.coa_documents)
  if (key === 'avail') return arr(ev.testing_pages)[0]?.url || docs[0]?.url || null
  if (key === 'access') return products.find((p) => !p.coa_link)?.url || arr(ev.testing_pages)[0]?.url || null
  if (key === 'trace') return docs.find((d) => !d.batch)?.url || products.find((p) => !p.batch_on_page)?.url || null
  if (key === 'present') return products.find((p) => !p.testing_info)?.url || null
  return null
}

/**
 * @param {object} ev evidence (already pruned to fetched URLs)
 * @param {object} a validated answers
 * @param {string} cat assessment category key (baby | sports | vit | func | other)
 * @param {{ id, status, label, text }[]} findings from buildFindings (for strengths / gaps)
 */
export function scoreEvidence(ev, a = {}, cat = 'other', findings = []) {
  const w = webScores(ev)
  const c = CATEGORIES[cat] || CATEGORIES.other
  const q9 = arr(a.q9)
  const notBabyOrSports = cat !== 'baby' && cat !== 'sports'

  const q9max = Math.max(0, ...q9.map((v) => points('q9', v)))
  const q2 = a.q2 === 'periodic' && notBabyOrSports ? 80 : points('q2', a.q2)
  const shared = q9.length && !q9.includes('none') ? 85 : 0
  const ansAv = shared * 0.4 + points('q1', a.q1) * 0.3 + q2 * 0.3
  const q10 = q9.includes('none') || !q9.length ? 10 : points('q10', a.q10)
  const q6 = a.q6 === 'product' && a.q2 === 'periodic' && notBabyOrSports ? 75 : points('q6', a.q6)
  const presentAns = q9.includes('page') ? 100 : q9.includes('qr') ? 60 : 20
  const internal = (points('q5', a.q5) + q6 + points('q7', a.q7) + points('q8', a.q8)) / 4

  const d = {
    avail: clamp(w.avail * 0.5 + ansAv * 0.5),
    access: clamp(w.access * 0.5 + q9max * 0.5),
    trace: clamp(w.trace * 0.5 + (q10 * 0.6 + q6 * 0.4) * 0.5),
    present: clamp(w.present * 0.6 + presentAns * 0.4),
    internal: clamp(internal),
  }
  const total = Math.round(Object.values(d).reduce((x, y) => x + y, 0) / 5)
  const keys = Object.keys(d).sort((x, y) => d[x] - d[y]) // weakest first

  // ---- fixes (rule-based; Agent 3 may reword them) ----
  const recKeys = keys.slice(0, Math.max(3, keys.filter((k) => d[k] < 75).length)).slice(0, 5)
  const fixes = recKeys.map((k) => {
    let action = REC[k][1]
    if (k === 'internal' && a.q5 === 'drive') action = 'Move reports from the shared drive into one structured system with consistent naming (product, variant, lot, date) and a review reminder for expiring reports.'
    if (k === 'trace' && a.q6 === 'sku') action = 'Your reports are organised by SKU, so add lot numbers to each report and surface them on the matching variant.'
    if (k === 'access' && q9.includes('email')) action = 'Replace on-request email sharing with a visible "Lab reports" link on each product page, and keep email for questions only.'
    return { dimension: k, title: REC[k][0], why: c.why[k], action, priority: priority(d[k]), evidence_url: evidenceUrlFor(k, ev) }
  })

  // ---- strengths / opportunities ----
  const strengths = []
  Object.keys(d).filter((k) => d[k] >= 70).forEach((k) => strengths.push({ title: DIMENSIONS[k][0], text: tier(d[k], k) }))
  findings.filter((f) => f.status === 'found' && f.id !== 'category').forEach((f) => strengths.push({ title: f.label, text: f.text }))
  if (a.q1 === 'batch') strengths.push({ title: 'Batch-wise testing', text: 'You test every batch, which gives you strong material to share with customers.' })
  if (a.q8 === 'tracked') strengths.push({ title: 'Report lifecycle tracked', text: 'Updated and expiring reports are handled through a defined review process.' })
  if (arr(a.q3).length >= 3) strengths.push({ title: 'Broad testing scope', text: `You test across ${a.q3.length} areas (${a.q3.map((k) => TESTS[k].toLowerCase()).join(', ')}).` })

  const opportunities = keys.filter((k) => d[k] < 75).map((k) => ({ title: DIMENSIONS[k][0], text: tier(d[k], k) }))
  if (a.q8 === 'manual' || (a.q5 === 'drive' && a.q7 === 'slow')) opportunities.push({ title: 'Manual report handling', text: 'Finding and updating reports depends on manual effort, which slows storefront updates.' })
  if (a.q4 === 'unsure') opportunities.push({ title: 'Testing requirements not defined by product line', text: 'Documenting what applies to each line makes storefront messaging clearer.' })
  findings.filter((f) => f.status === 'missing').forEach((f) => opportunities.push({ title: f.label, text: f.text }))

  const summary =
    total >= 75
      ? 'Your COAs are well presented. The remaining gains are in consistency and effort.'
      : total >= 55
        ? 'You have a solid base. Making reports easier to reach and tie to batches would have the most impact.'
        : 'You have testing to show, but customers will struggle to find or use it. Presentation is the main opportunity.'

  return {
    overall: total,
    label: scoreLabel(total),
    scores: Object.keys(d).map((k) => ({ id: k, label: DIMENSIONS[k][0], value: d[k], tier: tier(d[k], k) })),
    strongest: DIMENSIONS[keys[4]][0],
    biggest_gap: DIMENSIONS[keys[0]][0],
    summary,
    fixes,
    strengths: strengths.slice(0, 6),
    opportunities: opportunities.slice(0, 6),
    category_insights: c.insights.map(([title, text]) => ({ title, text })),
    missing_tests: c.tests.filter((k) => !arr(a.q3).includes(k)).map((k) => TESTS[k]),
    truebatch: TRUEBATCH,
  }
}
