// Agent 3 (evaluator): writes the results text from evidence + answers + the fixed scores.
// Output is validated in code; invalid output is retried once, then replaced by the rule-based result
// from score.js (which follows the assessment design word for word).
import { BLOCKED, MODEL, generate, isConfigured, toAnalyzeError } from './llm.js'
import { EVALUATOR_PROMPT } from './prompt.js'
import { CATEGORIES, QUESTIONS, questionOptions } from '../../shared/questions.js'
import { urlKey } from './tools.js'

const TIMEOUT_MS = Number(process.env.EVALUATOR_TIMEOUT_MS || 90000)
const PRIORITIES = ['high', 'medium', 'low']
const DIMS = ['avail', 'access', 'trace', 'present', 'internal']

const item = { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' } }, required: ['title', 'text'], additionalProperties: false }
const RESULTS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    strongest: { type: 'string' },
    biggest_gap: { type: 'string' },
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          dimension: { type: 'string', enum: DIMS },
          title: { type: 'string' },
          why: { type: 'string' },
          action: { type: 'string' },
          priority: { type: 'string', enum: PRIORITIES },
          evidence_url: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['dimension', 'title', 'why', 'action', 'priority', 'evidence_url'],
        additionalProperties: false,
      },
    },
    strengths: { type: 'array', items: item },
    opportunities: { type: 'array', items: item },
    category_insights: { type: 'array', items: item },
  },
  required: ['summary', 'strongest', 'biggest_gap', 'fixes', 'strengths', 'opportunities', 'category_insights'],
  additionalProperties: false,
}

/** Returns a list of problems (empty = valid). */
export function validateResults(r, checkedKeys) {
  const errors = []
  const text = (v, name, max) => {
    if (typeof v !== 'string' || !v.trim()) errors.push(`${name} must be a non-empty string`)
    else if (v.length > max) errors.push(`${name} is too long (max ${max} characters)`)
  }
  if (!r || typeof r !== 'object') return ['output is not a JSON object']
  text(r.summary, 'summary', 600)
  text(r.strongest, 'strongest', 80)
  text(r.biggest_gap, 'biggest_gap', 80)
  if (!Array.isArray(r.fixes) || r.fixes.length < 3 || r.fixes.length > 5) errors.push('fixes must have 3 to 5 items')
  ;(Array.isArray(r.fixes) ? r.fixes : []).forEach((f, i) => {
    if (!DIMS.includes(f?.dimension)) errors.push(`fixes[${i}].dimension must be one of ${DIMS.join(', ')}`)
    text(f?.title, `fixes[${i}].title`, 90)
    text(f?.why, `fixes[${i}].why`, 400)
    text(f?.action, `fixes[${i}].action`, 600)
    if (!PRIORITIES.includes(f?.priority)) errors.push(`fixes[${i}].priority must be high, medium or low`)
    if (f?.evidence_url != null && !checkedKeys.has(urlKey(f.evidence_url))) errors.push(`fixes[${i}].evidence_url is not one of the CHECKED URLS: ${f.evidence_url}`)
  })
  for (const key of ['strengths', 'opportunities', 'category_insights']) {
    const list = r[key]
    if (!Array.isArray(list) || list.length > 6 || list.some((x) => !x || typeof x.title !== 'string' || !x.title.trim() || typeof x.text !== 'string' || !x.text.trim() || x.title.length > 90 || x.text.length > 400)) {
      errors.push(`${key} must be a list of at most 6 {title, text} items`)
    }
  }
  if (Array.isArray(r.category_insights) && r.category_insights.length < 3) errors.push('category_insights must have at least 3 items')
  return errors
}

/** The rule-based result (score.js), used when Agent 3 is unavailable or invalid. */
export function fallbackResults(scored) {
  const { summary, strongest, biggest_gap, fixes, strengths, opportunities, category_insights } = scored
  return { summary, strongest, biggest_gap, fixes, strengths, opportunities, category_insights }
}

function buildInput({ evidence, findings, answers, scored, category, checkedUrls }) {
  const answerLines = QUESTIONS.filter((q) => answers[q.id] !== undefined).map((q) => {
    const opts = questionOptions(q, category)
    const labels = [].concat(answers[q.id]).map((v) => opts.find((o) => o[0] === v)?.[1] || v)
    return `- ${q.text} -> ${labels.join('; ')}`
  })
  return [
    `CATEGORY: ${CATEGORIES[category]?.name || 'Other'}`,
    '',
    'SCORES (final, from the scoring system):',
    `- Overall: ${scored.overall}/100 (${scored.label})`,
    ...scored.scores.map((s) => `- ${s.id} = ${s.label}: ${s.value}/100 (${s.tier})`),
    '',
    'FINDINGS:',
    ...findings.map((f) => `- [${f.status}] ${f.label}: ${f.text}`),
    '',
    'ANSWERS:',
    ...(answerLines.length ? answerLines : ['(none)']),
    '',
    'DRAFT RESULTS FROM THE SCORING SYSTEM (keep the fix dimensions and priorities; improve the wording and make it specific to this store):',
    JSON.stringify(fallbackResults(scored)),
    '',
    'EVIDENCE (JSON):',
    JSON.stringify(evidence),
    '',
    'CHECKED URLS:',
    ...checkedUrls.map((u) => `- ${u}`),
  ].join('\n')
}

async function callEvaluator(prompt, signal, log) {
  const response = await generate({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      systemInstruction: EVALUATOR_PROMPT,
      responseMimeType: 'application/json',
      responseJsonSchema: RESULTS_SCHEMA,
      maxOutputTokens: 8000,
      abortSignal: signal,
    },
  }, { log })
  const candidate = response.candidates?.[0]
  const stop = !candidate || BLOCKED.has(candidate.finishReason) || response.promptFeedback?.blockReason ? 'blocked' : candidate.finishReason === 'MAX_TOKENS' ? 'max_tokens' : null
  return { stop, text: response.text || '' }
}

/** @returns {Promise<{ results: object, source: 'agent'|'fallback' }>} */
export async function runEvaluator({ evidence, findings, answers, scored, category, checkedUrls, log = () => {} }) {
  const fallback = () => ({ results: fallbackResults(scored), source: 'fallback' })
  if (!isConfigured()) return fallback()

  const checkedKeys = new Set(checkedUrls.map(urlKey))
  let prompt = buildInput({ evidence, findings, answers, scored, category, checkedUrls })
  const signal = AbortSignal.timeout(TIMEOUT_MS)

  for (let attempt = 1; attempt <= 2; attempt++) {
    let out
    try {
      out = await callEvaluator(prompt, signal, log)
    } catch (e) {
      toAnalyzeError(e, log) // logs the cause
      return fallback() // timeout / API error: no retry, use the rule-based result
    }
    let parsed = null
    let errors
    if (out.stop) errors = [`stopped: ${out.stop}`]
    else {
      try {
        parsed = JSON.parse(out.text)
        errors = validateResults(parsed, checkedKeys)
      } catch {
        errors = ['output is not valid JSON']
      }
    }
    if (!errors.length) {
      const { summary, strongest, biggest_gap, fixes, strengths, opportunities, category_insights } = parsed
      return { results: { summary, strongest, biggest_gap, fixes, strengths, opportunities, category_insights }, source: 'agent' }
    }
    log(`evaluator attempt ${attempt} invalid: ${errors.slice(0, 5).join('; ')}`)
    if (out.stop === 'blocked') break
    // Retry once with the problems listed after the original input.
    prompt = `${prompt}\n\nA previous attempt was rejected for these reasons. Avoid them:\n- ${errors.join('\n- ')}`
  }
  return fallback()
}
