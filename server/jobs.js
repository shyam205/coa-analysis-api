// In-memory job store for background scans.
// - jobs expire 1 hour after their last update
// - finished scans are cached per domain for 24 hours
// - two requests for the same store share one running crawl
import crypto from 'node:crypto'
import { AnalyzeError } from './errors.js'

const JOB_TTL_MS = 60 * 60 * 1000
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const SCAN_TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT_MS || 15 * 60 * 1000)
const MAX_CONCURRENT_SCANS = Number(process.env.MAX_CONCURRENT_SCANS || 3)

export const domainKey = (origin) => new URL(origin).hostname.replace(/^www\./, '').toLowerCase()

/**
 * @param {{ runScan: (opts: object) => Promise<object>, log?: Function }} deps
 */
export function createJobStore({ runScan, log = () => {} }) {
  const jobs = new Map() // id -> job
  const running = new Map() // domain -> job id
  const cache = new Map() // domain -> { at, result }

  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [id, job] of jobs) if (now - job.updatedAt > JOB_TTL_MS && job.status !== 'running') jobs.delete(id)
    for (const [k, c] of cache) if (now - c.at > CACHE_TTL_MS) cache.delete(k)
  }, 60 * 1000)
  sweep.unref()

  function newJob(domain, fields) {
    const job = {
      id: crypto.randomUUID(),
      domain,
      status: 'running',
      agent: 'crawler',
      step: 'Starting',
      done: 0,
      total: 1,
      result: null,
      message: null,
      evaluations: new Map(),
      lead: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...fields,
    }
    jobs.set(job.id, job)
    return job
  }

  /** Starts (or joins) a scan for an already-validated origin. Returns the job. */
  function start(origin) {
    const domain = domainKey(origin)
    const cached = cache.get(domain)
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return newJob(domain, { status: 'done', agent: 'extractor', step: 'Done (cached result)', done: 1, total: 1, result: cached.result, cached: true })
    }
    const existing = running.get(domain)
    if (existing && jobs.get(existing)?.status === 'running') return jobs.get(existing)
    if (running.size >= MAX_CONCURRENT_SCANS) {
      throw new AnalyzeError('We’re analysing a lot of stores right now. Please try again in a few minutes.', 503)
    }

    const job = newJob(domain)
    running.set(domain, job.id)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS)
    const report = ({ agent, step, done, total }) => {
      if (job.status !== 'running') return
      Object.assign(job, { agent, step, done, total, updatedAt: Date.now() })
    }
    const jobLog = (m) => log(`[${domain}] ${m}`)

    runScan({ url: origin, report, signal: controller.signal, deadline: Date.now() + SCAN_TIMEOUT_MS - 30_000, log: jobLog })
      .then((result) => {
        Object.assign(job, { status: 'done', step: 'Done', done: job.total, result, updatedAt: Date.now() })
        cache.set(domain, { at: Date.now(), result })
        jobLog(`done in ${Math.round((Date.now() - job.createdAt) / 1000)}s`)
      })
      .catch((e) => {
        const message =
          e instanceof AnalyzeError ? e.message : controller.signal.aborted ? 'The scan took too long and was stopped. Please try again.' : 'Something went wrong while analysing the store. Please try again.'
        if (!(e instanceof AnalyzeError)) jobLog(`failed: ${e?.stack || e}`)
        else jobLog(`failed: ${e.message}`)
        Object.assign(job, { status: 'error', message, updatedAt: Date.now() })
      })
      .finally(() => {
        clearTimeout(timer)
        running.delete(domain)
      })
    return job
  }

  const get = (id) => (typeof id === 'string' ? jobs.get(id) : undefined)
  const touch = (job) => (job.updatedAt = Date.now())

  return { start, get, touch, stop: () => clearInterval(sweep) }
}
