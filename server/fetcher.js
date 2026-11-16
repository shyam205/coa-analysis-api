// Direct HTTP fetching for the agents. No third-party scraping service: the server requests
// public pages itself, with guards so a submitted URL can never reach private/internal hosts.
import dns from 'node:dns/promises'
import net from 'node:net'
import { AnalyzeError } from './errors.js'

const UA = 'Mozilla/5.0 (compatible; TrueBatchCOACheck/1.0)'
const MAX_REDIRECTS = 5
const DEFAULT_TIMEOUT_MS = 20000
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024
const CONCURRENCY = 4
const MAX_SITEMAPS = 10
const RETRY_STATUS = new Set([403, 429, 503])
const RETRY_DELAYS_MS = [1500, 4000]

export const PRODUCT_URL = /\/(products?|shop|item|p)\/[^/?#]+/i
export const SKIP = /\.(jpe?g|png|gif|webp|svg|css|js|ico|woff2?|ttf|mp4|zip|xml|pdf|json)(\?|$)|\/(cart|account|checkout|login|search|admin|cdn-cgi|wp-admin|wp-json|feed|policies)\b|[?&](variant|sort|sort_by|page|filter)=/i

// ---------- address safety ----------

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    )
  }
  const v = ip.toLowerCase()
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7))
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')
}

export function isPublicHostname(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(h)) return !isPrivateIp(h)
  return /\.[a-z]{2,}$/i.test(h) && !/(^|\.)(localhost|local|internal|lan|home|corp)$/i.test(h)
}

async function assertPublic(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '')
  if (!isPublicHostname(h)) throw new Error('blocked host')
  if (net.isIP(h)) return
  const addrs = await dns.lookup(h, { all: true })
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('blocked address')
}

/** Validates what a shopper typed and returns the https origin. Throws AnalyzeError with a plain message. */
export function normaliseUrl(input) {
  let value = String(input || '').trim()
  if (!value) throw new AnalyzeError('Please enter your store address.')
  if (value.length > 300) throw new AnalyzeError('That address is too long. Enter just the domain, such as yourstore.com.')
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`
  let u
  try {
    u = new URL(value)
  } catch {
    throw new AnalyzeError('That doesn’t look like a website address. Try something like yourstore.com.')
  }
  if (u.username || u.password || !isPublicHostname(u.hostname) || net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) {
    throw new AnalyzeError('That doesn’t look like a public store address. Try something like yourstore.com.')
  }
  return `https://${u.hostname.toLowerCase()}`
}

// ---------- fetching ----------

async function readLimited(res, maxBytes) {
  const reader = res.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > maxBytes) {
      await reader.cancel().catch(() => {})
      const err = new Error('too large')
      err.code = 'TOO_LARGE'
      throw err
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)))
}

/**
 * Creates a fetcher for one scan. Every request (including each redirect hop) is checked
 * against private address ranges, size-capped and time-limited.
 * get(url) -> { ok:true, status, url, contentType, body:Buffer } | { ok:false, status?, reason }
 */
export function createFetcher({ signal } = {}) {
  const stats = { requests: 0 }
  let active = 0
  const waiting = []
  const acquire = () => (active < CONCURRENCY ? (active++, Promise.resolve()) : new Promise((r) => waiting.push(r)))
  const release = () => {
    const next = waiting.shift()
    next ? next() : active--
  }

  async function get(url, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, accept = 'text/html,application/xhtml+xml,*/*;q=0.8' } = {}) {
    await acquire()
    try {
      let current = new URL(url)
      let retries = 0
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (!/^https?:$/.test(current.protocol)) return { ok: false, reason: 'unsupported protocol' }
        try {
          await assertPublic(current.hostname)
        } catch {
          return { ok: false, reason: 'blocked address' }
        }
        const timeout = AbortSignal.timeout(timeoutMs)
        let res
        try {
          stats.requests++
          res = await fetch(current, {
            redirect: 'manual',
            headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en' },
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          })
        } catch (e) {
          return { ok: false, reason: e?.name === 'TimeoutError' ? 'timeout' : signal?.aborted ? 'cancelled' : 'unreachable' }
        }
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          await res.body?.cancel().catch(() => {})
          current = new URL(res.headers.get('location'), current)
          continue
        }
        const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
        if (!res.ok) {
          await res.body?.cancel().catch(() => {})
          // CDNs (e.g. cdn.shopify.com) sometimes reject a burst of requests with 403/429/503:
          // wait and try the same URL again (up to 2 more times) before giving up.
          if (RETRY_STATUS.has(res.status) && retries < RETRY_DELAYS_MS.length) {
            await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[retries++] + Math.random() * 500))
            hop--
            continue
          }
          return { ok: false, status: res.status, url: current.href, reason: `HTTP ${res.status}` }
        }
        try {
          const body = await readLimited(res, maxBytes)
          return { ok: true, status: res.status, url: current.href, contentType, body }
        } catch (e) {
          return { ok: false, url: current.href, reason: e.code === 'TOO_LARGE' ? 'too large' : 'download failed' }
        }
      }
      return { ok: false, reason: 'too many redirects' }
    } finally {
      release()
    }
  }

  async function getText(url, opts) {
    const r = await get(url, opts)
    return r.ok ? { ...r, text: r.body.toString('utf8') } : r
  }

  return { get, getText, stats }
}

// ---------- discovery (robots.txt + sitemaps) ----------

export async function readRobots(origin, fetcher) {
  const r = await fetcher.getText(`${origin}/robots.txt`, { accept: 'text/plain,*/*', maxBytes: 512 * 1024 })
  const txt = r.ok ? r.text : ''
  const disallow = []
  const sitemaps = []
  let applies = false
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    const i = line.indexOf(':')
    if (i < 0) continue
    const key = line.slice(0, i).trim().toLowerCase()
    const val = line.slice(i + 1).trim()
    if (key === 'user-agent') applies = val === '*'
    else if (key === 'disallow' && applies && val) {
      const anchored = val.endsWith('$')
      const pat = val.replace(/\$$/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
      disallow.push(new RegExp('^' + pat + (anchored ? '$' : '')))
    } else if (key === 'sitemap' && val) sitemaps.push(val)
  }
  return { disallow, sitemaps, allows: (u) => !disallow.some((re) => re.test(u.pathname + u.search)) }
}

export async function readSitemaps(origin, robotsSitemaps, fetcher) {
  const queue = robotsSitemaps.length ? [...new Set(robotsSitemaps)] : [`${origin}/sitemap.xml`]
  const urls = []
  let fetched = 0
  while (queue.length && fetched < MAX_SITEMAPS && urls.length < 10000) {
    const smUrl = queue.shift()
    fetched++
    const r = await fetcher.getText(smUrl, { accept: 'application/xml,text/xml,*/*', maxBytes: 8 * 1024 * 1024 })
    const xml = r.ok ? r.text : ''
    if (!/<(urlset|sitemapindex)/i.test(xml)) continue
    const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/gi)].map((m) => m[1].replace(/&amp;/g, '&'))
    if (/<sitemapindex/i.test(xml)) {
      const score = (u) => (/page|coa|lab/i.test(u) ? 0 : /product/i.test(u) ? 1 : 2)
      queue.push(...locs.sort((a, b) => score(a) - score(b)))
    } else urls.push(...locs)
  }
  return urls
}
