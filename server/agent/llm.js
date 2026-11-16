// Google Gemini client + helpers shared by the three agents. Server-side only: never import from src/.
// Key: GEMINI_API_KEY (from Google AI Studio). Model: GEMINI_MODEL (default below).
import { ApiError, GoogleGenAI } from '@google/genai'
import { AnalyzeError } from '../errors.js'

export const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash'

let client
export const getClient = () => (client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }))
export const isConfigured = () => Boolean(process.env.GEMINI_API_KEY)

// Tried in order when the main model is overloaded or unavailable (comma-separated in .env).
export const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.8-flash')
  .split(',')
  .map((m) => m.trim())
  .filter((m) => m && m !== MODEL)

const RETRYABLE = new Set([429, 500, 502, 503, 504])
/** A 429 that is a quota (per-day / billing) limit, not a short burst: retrying won't help. */
const isQuotaExhausted = (e) => e?.status === 429 && /exceeded your current quota|PerDay|free_tier/i.test(String(e.message))

/** Thrown when every model is out of quota or unavailable. */
export class GeminiUnavailableError extends Error {
  constructor(reason) {
    super(reason === 'quota' ? 'Gemini daily quota exhausted for all models' : 'All Gemini models unavailable')
    this.reason = reason
  }
}
const BACKOFF_MS = [2000, 6000, 15000]
const CALL_TIMEOUT_MS = Number(process.env.GEMINI_CALL_TIMEOUT_MS || 120000) // one request; a hung call moves on
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true })
  })

/**
 * generateContent with retries: each model gets up to 4 attempts (backoff 2s / 6s / 15s) on
 * overload or server errors, then the next model in FALLBACK_MODELS is tried.
 * A model that is gone for this account (404), or a call that hangs past CALL_TIMEOUT_MS, moves on straight away.
 * Within one conversation the model only changes when a call fails, never mid-turn.
 */
export async function generate(params, { log } = {}) {
  const signal = params.config?.abortSignal
  const models = [params.model || MODEL, ...FALLBACK_MODELS.filter((m) => m !== (params.model || MODEL))]
  let lastError
  let quotaHits = 0
  for (const model of models) {
    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
      const callTimeout = AbortSignal.timeout(CALL_TIMEOUT_MS)
      try {
        return await getClient().models.generateContent({
          ...params,
          model,
          config: { ...params.config, abortSignal: signal ? AbortSignal.any([signal, callTimeout]) : callTimeout },
        })
      } catch (e) {
        lastError = e
        if (signal?.aborted) throw e // the whole scan was cancelled or timed out
        if (callTimeout.aborted) {
          log?.(`model ${model} did not answer within ${CALL_TIMEOUT_MS / 1000}s, trying the next one`)
          break
        }
        if (!(e instanceof ApiError)) throw e
        if (isQuotaExhausted(e)) {
          quotaHits++
          log?.(`model ${model}: quota exhausted (${String(e.message).match(/limit: \d+/)?.[0] || 'daily limit'}), trying the next one`)
          break
        }
        if (e.status === 404) {
          log?.(`model ${model} not available (404), trying the next one`)
          break
        }
        if (!RETRYABLE.has(e.status)) throw e
        if (attempt === BACKOFF_MS.length) {
          log?.(`model ${model} still failing (${e.status}), trying the next one`)
          break
        }
        log?.(`model ${model} returned ${e.status}, retrying in ${BACKOFF_MS[attempt] / 1000}s`)
        await sleep(BACKOFF_MS[attempt], signal)
      }
    }
  }
  if (lastError instanceof ApiError && !isQuotaExhausted(lastError) && !RETRYABLE.has(lastError.status)) throw lastError
  throw new GeminiUnavailableError(quotaHits ? 'quota' : 'busy')
}

/** Our tool definitions ({name, description, input_schema}) -> Gemini function declarations. */
export const toFunctionDeclarations = (tools) =>
  tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema }))

/** Finish reasons where Gemini blocked the output. */
export const BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE'])

/** Maps SDK errors to plain sentences (the details go to the server log only). */
export function toAnalyzeError(e, log) {
  if (e instanceof AnalyzeError) return e
  if (e instanceof GeminiUnavailableError) {
    log?.(`AI error: ${e.message}`)
    return e.reason === 'quota'
      ? new AnalyzeError('Our analysis service has reached its daily limit. Please try again tomorrow.', 503)
      : new AnalyzeError('The analysis service is busy right now. Please try again in a few minutes.', 503)
  }
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return new AnalyzeError('The scan took too long and was stopped. Please try again.', 504)
  log?.(`AI error: ${e?.constructor?.name} ${e?.status ?? ''} ${String(e?.message ?? e).slice(0, 300)}`)
  if (e instanceof ApiError) {
    if (e.status === 400 && /api key/i.test(e.message)) return new AnalyzeError('The analysis service is not set up correctly. Please try again later.', 500)
    if (e.status === 401 || e.status === 403) return new AnalyzeError('The analysis service is not set up correctly. Please try again later.', 500)
    if (e.status === 429 || e.status === 503) return new AnalyzeError('The analysis service is busy right now. Please try again in a few minutes.', 503)
    return new AnalyzeError('The analysis service had a problem. Please try again.', 502)
  }
  return new AnalyzeError('Something went wrong while analysing the store. Please try again.', 500)
}
