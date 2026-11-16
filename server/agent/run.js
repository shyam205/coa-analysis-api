// Agent 1 (crawler) and Agent 2 (extractor): Google Gemini + function calling in a manual loop.
// The loop enforces tool budgets, a turn cap and a deadline, and ends when the model calls
// its final tool (report_pages / report). Server-side only: never import this from src/.
import { AnalyzeError } from '../errors.js'
import { buildCrawlerPrompt, buildExtractorPrompt } from './prompt.js'
import { FETCH_PAGE_TOOL, READ_PDF_TOOL, REPORT_EVIDENCE_TOOL, REPORT_PAGES_TOOL, urlKey } from './tools.js'
import { BLOCKED, MODEL, generate, getClient, isConfigured, toAnalyzeError, toFunctionDeclarations } from './llm.js'

export { MODEL, isConfigured, getClient, toAnalyzeError }
export const MAX_FETCHES = Number(process.env.AGENT_MAX_FETCHES || 25)
export const MAX_PDFS = Number(process.env.AGENT_MAX_PDFS || 8)
const EXTRA_FETCHES = Number(process.env.EXTRACTOR_MAX_FETCHES || 5)
const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS || 40)
const MAX_PAGE_CHARS_FOR_EXTRACTOR = 8000

/**
 * Runs one agent until it calls `finalTool`. Returns that tool's arguments.
 * handlers: { [toolName]: async (input) => ({ text } | { error }) }
 */
async function runToolLoop({ name, system, userContent, tools, handlers, finalTool, deadline, signal, log, usage }) {
  const contents = [{ role: 'user', parts: [{ text: userContent }] }]
  const functionDeclarations = toFunctionDeclarations(tools)
  let forceFinal = false // after a nudge, only the final tool may be called
  let nudged = false
  let retries = 0
  let turns = 0

  const nudge = (text) => {
    contents.push({ role: 'user', parts: [{ text }] })
    forceFinal = true
  }

  while (turns < MAX_TURNS) {
    if (Date.now() > deadline && !forceFinal) {
      if (nudged) break
      nudged = true
      nudge(`Time is up. Call ${finalTool} now with what you have.`)
    }

    let response
    try {
      response = await generate(
        {
        model: MODEL,
        contents,
        config: {
          systemInstruction: system,
          tools: [{ functionDeclarations }],
          toolConfig: forceFinal ? { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [finalTool] } } : undefined,
          maxOutputTokens: 16000,
          abortSignal: signal,
        },
        },
        { log },
      )
    } catch (e) {
      throw toAnalyzeError(e, log)
    }
    turns++
    usage.turns++
    const u = response.usageMetadata || {}
    usage.input += u.promptTokenCount || 0
    usage.output += (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)
    usage.cache_read += u.cachedContentTokenCount || 0

    const candidate = response.candidates?.[0]
    if (!candidate || BLOCKED.has(candidate.finishReason) || response.promptFeedback?.blockReason) {
      throw new AnalyzeError('We couldn’t analyse this store. Please try a different one.', 422)
    }
    if (candidate.finishReason === 'MALFORMED_FUNCTION_CALL' || !candidate.content?.parts?.length) {
      // Empty or malformed tool call: ask again (up to twice), forcing the final tool.
      if (++retries > 2) break
      nudge(`Your last reply was empty or had an invalid tool call. Call ${finalTool} now with valid arguments.`)
      continue
    }
    // Keep the model's turn exactly as returned (it carries Gemini's thought signatures).
    contents.push(candidate.content)

    const calls = response.functionCalls || []
    if (!calls.length) {
      if (candidate.finishReason === 'MAX_TOKENS') throw new AnalyzeError('The analysis was cut short. Please try again.', 502)
      if (nudged) break
      nudged = true
      nudge(`You must finish by calling the ${finalTool} tool. Call it now.`)
      continue
    }

    const finalCall = calls.find((c) => c.name === finalTool)
    if (finalCall && finalCall.args && typeof finalCall.args === 'object') return finalCall.args

    // Run tools in parallel; all results go back in ONE user turn, in call order.
    const parts = await Promise.all(
      calls.map(async (c) => {
        const handler = handlers[c.name]
        const out = handler && typeof c.args?.url === 'string' ? await handler(c.args) : { error: `Unknown tool or missing url: ${c.name}` }
        log(`${name} ${c.name} ${c.args?.url ?? ''} ${out.error ? `-> ${out.error.slice(0, 80)}` : 'ok'}`)
        return { functionResponse: { id: c.id, name: c.name, response: out.error ? { error: out.error } : { output: out.text } } }
      }),
    )
    contents.push({ role: 'user', parts })
  }
  throw new AnalyzeError('The analysis did not finish. Please try again.', 502)
}

/**
 * Agent 1: explores the store and opens the relevant pages.
 * @param {{ origin: string, candidates: { text: string }, toolbox: any, deadline: number, signal?: AbortSignal, report: Function, log: Function, usage: object }} ctx
 */
export async function runCrawler({ origin, candidates, toolbox, deadline, signal, report, log, usage }) {
  const total = toolbox.limits.maxFetches
  report({ agent: 'crawler', step: 'Reading pages', done: 0, total })
  const fetchPage = async (input) => {
    const out = await toolbox.fetchPage(input)
    report({ agent: 'crawler', step: 'Reading pages', done: toolbox.state.fetches, total })
    return out
  }
  const input = await runToolLoop({
    name: 'crawler',
    system: buildCrawlerPrompt({ maxFetches: total }),
    userContent: `Inspect this store: ${origin}\n\nCandidate URLs:\n${candidates.text}`,
    tools: [FETCH_PAGE_TOOL, REPORT_PAGES_TOOL],
    handlers: { fetch_page: fetchPage },
    finalTool: 'report_pages',
    deadline,
    signal,
    log,
    usage,
  })
  report({ agent: 'crawler', step: 'Pages collected', done: total, total })
  return {
    pages: Array.isArray(input.pages) ? input.pages : [],
    coa_documents: Array.isArray(input.coa_documents) ? input.coa_documents : [],
    category_guess: input.category_guess || 'other',
    notes: Array.isArray(input.notes) ? input.notes : [],
  }
}

/** Agent 2: reads the crawled pages + COA documents and writes the evidence JSON. */
export async function runExtractor({ origin, crawl, toolbox, deadline, signal, report, log, usage }) {
  toolbox.limits.maxFetches = toolbox.state.fetches + EXTRA_FETCHES
  const docs = crawl.coa_documents
  const total = Math.max(1, Math.min(MAX_PDFS, docs.length) + 1) // + 1 for writing the evidence
  let done = 0
  report({ agent: 'extractor', step: 'Reading lab reports', done, total })
  const counted = (fn) => async (input) => {
    const out = await fn(input)
    done = Math.min(total - 1, done + 1)
    report({ agent: 'extractor', step: 'Reading lab reports', done, total })
    return out
  }

  // Hand over every page the crawler opened (relevant ones first), each capped.
  const kindOf = new Map(crawl.pages.map((p) => [urlKey(p.url), p]))
  const pages = [...toolbox.state.pageText.entries()].sort(([a], [b]) => (kindOf.has(a) ? 0 : 1) - (kindOf.has(b) ? 0 : 1))
  const pageBlocks = pages.map(([key, text]) => {
    const meta = kindOf.get(key)
    const head = meta ? `### [${meta.kind}] ${meta.why}` : '### [other]'
    return `${head}\n${text.length > MAX_PAGE_CHARS_FOR_EXTRACTOR ? `${text.slice(0, MAX_PAGE_CHARS_FOR_EXTRACTOR)}\n[... truncated]` : text}`
  })

  const userContent = [
    `Store: ${origin}`,
    `Agent 1 category guess: ${crawl.category_guess}`,
    '',
    `## COA documents found by Agent 1 (${docs.length})`,
    ...(docs.length ? docs.map((d) => `- ${d.url} (found on ${d.found_on}${d.label ? `; "${d.label}"` : ''})`) : ['(none)']),
    '',
    '## Agent 1 notes',
    ...(crawl.notes.length ? crawl.notes.map((n) => `- ${n}`) : ['(none)']),
    '',
    `## Pages Agent 1 opened (${pages.length})`,
    ...pageBlocks,
  ].join('\n')

  const evidence = await runToolLoop({
    name: 'extractor',
    system: buildExtractorPrompt({ maxPdfs: toolbox.limits.maxPdfs, extraFetches: EXTRA_FETCHES }),
    userContent,
    tools: [READ_PDF_TOOL, FETCH_PAGE_TOOL, REPORT_EVIDENCE_TOOL],
    handlers: { read_pdf: counted(toolbox.readPdf), fetch_page: counted(toolbox.fetchPage) },
    finalTool: 'report',
    deadline,
    signal,
    log,
    usage,
  })
  report({ agent: 'extractor', step: 'Evidence written', done: total, total })
  return evidence
}
