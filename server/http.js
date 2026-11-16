// JSON API for the widget. Used by server/dev-server.js (and any Node host).
//   POST /api/scan          {url}                  -> 202 {ok, jobId}
//   GET  /api/scan/:id                             -> {status, agent, step, done, total, result?, message?}
//   POST /api/evaluate      {jobId, answers}       -> {ok, scores, results}
//   POST /api/lead          {jobId, name, email}   -> {ok}
// Every request is short; the long crawl runs as a background job (server/jobs.js).
import { AnalyzeError } from './errors.js'
import { normaliseUrl, runEvaluation, runScan } from './analyze.js'
import { createJobStore } from './jobs.js'
import { isConfigured } from './agent/run.js'
import { validateAnswers } from '../shared/questions.js'

// Comma-separated. Entries may use "*" as a wildcard, e.g. https://*.myshopify.com
const allowedOrigins = (
  process.env.ALLOWED_ORIGINS ||
  'http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:9292,http://localhost:9292,https://shyammunda.myshopify.com'
)
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean)
const originPatterns = allowedOrigins.map((o) => new RegExp(`^${o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+')}$`, 'i'))
const isAllowedOrigin = (origin) => Boolean(origin) && originPatterns.some((re) => re.test(origin))
const warnedOrigins = new Set()

const MAX_BODY = 50_000
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i

/** CORS only for ALLOWED_ORIGINS. Other origins get no Allow-Origin header, so browsers block them. */
export function corsHeaders(origin) {
  const headers = { Vary: 'Origin' }
  if (origin && !isAllowedOrigin(origin) && !warnedOrigins.has(origin)) {
    warnedOrigins.add(origin)
    console.warn(`[api] CORS: blocked origin ${origin}. Add it to ALLOWED_ORIGINS in .env (comma-separated) and restart.`)
  }
  if (isAllowedOrigin(origin)) {
    Object.assign(headers, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      // Lets https://*.myshopify.com pages call http://localhost during development (Chrome Private Network Access)
      'Access-Control-Allow-Private-Network': 'true',
    })
  }
  return headers
}

function rateLimiter(limitPerHour) {
  const hits = new Map()
  return (ip) => {
    const now = Date.now()
    const list = (hits.get(ip) || []).filter((t) => now - t < 3600_000)
    list.push(now)
    hits.set(ip, list)
    if (hits.size > 10_000) hits.clear()
    return list.length > limitPerHour
  }
}

async function readJson(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > MAX_BODY) throw new AnalyzeError('The request is too large.', 413)
  }
  try {
    const body = JSON.parse(raw || '{}')
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
    return body
  } catch {
    throw new AnalyzeError('The request was not valid.', 400)
  }
}

/** Public view of a job (never internal fields). */
function jobView(job) {
  const view = { status: job.status, agent: job.agent, step: job.step, done: job.done, total: job.total }
  if (job.status === 'done') view.result = job.result
  if (job.status === 'error') view.message = job.message
  if (job.cached) view.cached = true
  return view
}
 
/**
 * @param {{ agents?: { runCrawler?, runExtractor?, runEvaluator? }, configured?: () => boolean, log?: Function }} deps
 *   agents lets tests swap in fakes; production uses the real Claude agents.
 */
export function createApi({ agents = {}, configured = isConfigured, log = (m) => console.log(`[api] ${m}`) } = {}) {
  const store = createJobStore({ runScan: (opts) => runScan({ ...opts, agents }), log })
  const scanLimit = rateLimiter(Number(process.env.RATE_LIMIT_PER_HOUR || 10))
  const otherLimit = rateLimiter(Number(process.env.RATE_LIMIT_PER_HOUR || 10) * 6)

  const routes = { 
    async 'POST /api/scan'({ body, ip }) {
      const origin = normaliseUrl(body.url) // throws a plain message for bad input
      if (!configured()) {
        log('scan refused: GEMINI_API_KEY is not set')
        throw new AnalyzeError('The analysis service isn’t set up yet. Please try again later.', 503)
      }
      if (scanLimit(ip)) throw new AnalyzeError('You’ve run a lot of scans. Please try again in an hour.', 429)
      const job = store.start(origin)
      return { status: 202, body: { ok: true, jobId: job.id } }
    },

    async 'GET /api/scan/:id'({ id }) {
      const job = store.get(id)
      if (!job) throw new AnalyzeError('This scan has expired. Please start a new one.', 404)
      return { status: 200, body: jobView(job) }
    },

    async 'POST /api/evaluate'({ body, ip }) {
      if (otherLimit(ip)) throw new AnalyzeError('Too many requests. Please wait a moment and try again.', 429)
      const job = store.get(body.jobId)
      if (!job) throw new AnalyzeError('This scan has expired. Please start a new one.', 404)
      if (job.status !== 'done') throw new AnalyzeError('The scan hasn’t finished yet.', 409)
      const checked = validateAnswers(body.answers, job.result.category)
      if (!checked.ok) throw new AnalyzeError(checked.message, 400)

      const key = JSON.stringify(checked.answers)
      let pending = job.evaluations.get(key)
      if (!pending) {
        pending = runEvaluation({ scan: job.result, answers: checked.answers, agents, log: (m) => log(`[${job.domain}] ${m}`) })
        job.evaluations.set(key, pending)
        pending.catch(() => job.evaluations.delete(key))
      }
      const { scores, results } = await pending
      store.touch(job)
      return { status: 200, body: { ok: true, scores, results } }
    },

    async 'POST /api/lead'({ body, ip }) {
      if (otherLimit(ip)) throw new AnalyzeError('Too many requests. Please wait a moment and try again.', 429)
      const job = store.get(body.jobId)
      if (!job) throw new AnalyzeError('This scan has expired. Please start a new one.', 404)
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const email = typeof body.email === 'string' ? body.email.trim() : ''
      if (!name || name.length > 100) throw new AnalyzeError('Please enter your name.', 400)
      if (!EMAIL_RE.test(email) || email.length > 200) throw new AnalyzeError('Please enter a valid email address.', 400)
      job.lead = { name, email, at: new Date().toISOString() }
      store.touch(job)
      // TODO(lead): send the lead to your CRM / email tool here (e.g. HubSpot, Klaviyo, a webhook).
      // Include job.domain, job.result?.category and the latest evaluation if you need them.
      // Do not log the email address in production logs.
      log(`[${job.domain}] lead captured`)
      return { status: 200, body: { ok: true } }
    },
  }

  /** Node http handler. */
  return async function handle(req, res) {
    const headers = { ...corsHeaders(req.headers.origin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    const send = (status, body) => res.writeHead(status, headers).end(JSON.stringify(body))
    const { pathname } = new URL(req.url, 'http://localhost')

    if (req.method === 'OPTIONS' && pathname.startsWith('/api/')) return res.writeHead(204, headers).end()

    let route
    let id
    const scanMatch = pathname.match(/^\/api\/scan\/([A-Za-z0-9-]{1,64})$/)
    if (req.method === 'GET' && scanMatch) ((route = routes['GET /api/scan/:id']), (id = scanMatch[1]))
    else route = routes[`${req.method} ${pathname}`]
    if (!route) return send(404, { ok: false, message: 'Not found.' })

    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown'
    const started = Date.now()
    try {
      const body = req.method === 'POST' ? await readJson(req) : {}
      const out = await route({ body, ip, id })
      if (req.method === 'POST') log(`${req.method} ${pathname} ${out.status} (${Date.now() - started}ms)`)
      return send(out.status, out.body)
    } catch (e) {
      if (e instanceof AnalyzeError) {
        log(`${req.method} ${pathname} ${e.status} ${e.message}`)
        return send(e.status, { ok: false, message: e.message })
      }
      log(`${req.method} ${pathname} 500 ${e?.stack || e}`)
      return send(500, { ok: false, message: 'Something went wrong. Please try again.' })
    }
  }
}
