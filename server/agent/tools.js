// Tool definitions + implementations shared by Agent 1 (crawler) and Agent 2 (extractor).
// The prompt rules are also enforced here in code: allowed URLs, robots.txt, budgets.
// The toolbox records every URL that was actually fetched, so findings can be checked later.
import { extractText, getDocumentProxy } from 'unpdf'
import { isPublicHostname } from '../fetcher.js'

const MAX_MAIN_CHARS = 12000
const MAX_CHROME_CHARS = 1500
const MAX_MAIN_LINKS = 150
const MAX_CHROME_LINKS = 40
const MAX_PDF_CHARS = 8000
const MAX_PDF_BYTES = 15 * 1024 * 1024

const FORBIDDEN_PATH = /^\/(cart|checkout|checkouts|account|search|login|admin|orders)(\/|$)/i
const COA_HINT = /(coa|lab|test|certificate|analysis|batch|lot|result|report)/i

// Third-party lab-report widgets. They load their COA panel with JavaScript in the shopper's browser,
// so the server only sees an empty placeholder tag; we detect the placeholder itself.
const COA_WIDGETS = [
  { provider: 'LabTested', test: /<labtested-widget\b|\/\/app\.labtested\.co\//i },
]
// Any other custom element or script whose name says COA / lab report / lab results.
// (custom element names must contain a hyphen; the keyword must be a whole name segment, so "coach-marks" doesn't match)
const GENERIC_WIDGET = /<(?=[a-z0-9-]*-)(?:[a-z0-9]+-)*(?:coa|lab-?tests?|lab-?tested|lab-?reports?|lab-?results?)(?:-[a-z0-9]+)*[\s>/]|<script\b[^>]*\bsrc\s*=\s*["'][^"']*(?:[/._-]coa[/._-]|lab-?tested|lab-?reports?|lab-?results?)[^"']*["']/i

/** Name of the embedded lab-report widget on this page, or null. */
export function detectCoaWidget(html) {
  const known = COA_WIDGETS.find((w) => w.test.test(html))
  if (known) return known.provider
  return GENERIC_WIDGET.test(html) ? 'an embedded lab-report widget' : null
}

const urlSchema = { type: 'object', properties: { url: { type: 'string', description: 'Absolute URL' } }, required: ['url'], additionalProperties: false }
const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] }

export const FETCH_PAGE_TOOL = {
  name: 'fetch_page',
  description:
    "Fetch a public page on the store and return its visible text and links. Main content and header/nav/footer are returned in separate sections so you can ignore site chrome when judging a product page. Only the store's own domain is allowed, plus lab-portal pages or files the store links to. Image files return their type and size only.",
  input_schema: urlSchema,
  strict: true,
}

export const READ_PDF_TOOL = {
  name: 'read_pdf',
  description:
    'Download a PDF COA document that the store links to and return its text plus flags: hasBatch, hasDate, hasLab, hasResults, scanned (true when the PDF has no extractable text, i.e. an image scan).',
  input_schema: urlSchema,
  strict: true,
}

export const REPORT_PAGES_TOOL = {
  name: 'report_pages',
  description: 'Agent 1 only. Submit the list of relevant pages and COA documents you found. Call exactly once, at the end.',
  input_schema: {
    type: 'object',
    properties: {
      pages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            kind: { type: 'string', enum: ['testing', 'product', 'faq', 'homepage', 'lab_portal', 'other'] },
            why: { type: 'string', description: 'One line: what on this page matters for COAs' },
          },
          required: ['url', 'kind', 'why'],
          additionalProperties: false,
        },
      },
      coa_documents: {
        type: 'array',
        items: {
          type: 'object',
          properties: { url: { type: 'string' }, found_on: { type: 'string' }, label: { type: 'string' } },
          required: ['url', 'found_on', 'label'],
          additionalProperties: false,
        },
      },
      category_guess: { type: 'string', enum: ['baby', 'sports', 'supplements', 'food', 'cosmetics', 'pet', 'other'] },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['pages', 'coa_documents', 'category_guess', 'notes'],
    additionalProperties: false,
  },
  strict: true,
}

const signal = { type: 'object', properties: { found: { type: 'boolean' }, url: nullableString }, required: ['found', 'url'], additionalProperties: false }

export const REPORT_EVIDENCE_TOOL = {
  name: 'report',
  description: 'Agent 2 only. Submit the final evidence JSON. Call exactly once, at the end.',
  input_schema: {
    type: 'object',
    properties: {
      category_guess: { type: 'string', enum: ['baby', 'sports', 'supplements', 'food', 'cosmetics', 'pet', 'other'] },
      products_checked: {
        type: 'array',
        items: {
          type: 'object',
          properties: { url: { type: 'string' }, title: { type: 'string' }, coa_link: nullableString, testing_info: { type: 'boolean' }, batch_on_page: { type: 'boolean' } },
          required: ['url', 'title', 'coa_link', 'testing_info', 'batch_on_page'],
          additionalProperties: false,
        },
      },
      testing_pages: {
        type: 'array',
        items: { type: 'object', properties: { url: { type: 'string' }, summary: { type: 'string' } }, required: ['url', 'summary'], additionalProperties: false },
      },
      coa_documents: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            found_on: { type: 'string' },
            product: { type: 'string' },
            batch: nullableString,
            lab: nullableString,
            date: nullableString,
            has_results: { type: 'boolean' },
            scanned_image: { type: 'boolean' },
          },
          required: ['url', 'found_on', 'product', 'batch', 'lab', 'date', 'has_results', 'scanned_image'],
          additionalProperties: false,
        },
      },
      batch_lookup: signal,
      matching_instructions: signal,
      email_request: signal,
      qr_mention: signal,
      homepage_testing_claim: signal,
      access_methods: { type: 'array', items: { type: 'string', enum: ['product_page', 'separate_page', 'batch_lookup', 'email', 'none'] } },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: [
      'category_guess', 'products_checked', 'testing_pages', 'coa_documents', 'batch_lookup', 'matching_instructions',
      'email_request', 'qr_mention', 'homepage_testing_claim', 'access_methods', 'notes',
    ],
    additionalProperties: false,
  },
  strict: true,
}

// ---------- helpers ----------

const decode = (s) =>
  s
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
const toText = (html) =>
  decode(html.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()

function cap(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n[... truncated, ${text.length - max} more characters]` : text
}

/** Canonical form used to compare URLs: no hash, no trailing slash, host without www. */
export function urlKey(raw) {
  try {
    const u = new URL(raw)
    u.hash = ''
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${u.pathname.replace(/\/+$/, '') || '/'}${u.search}`
  } catch {
    return String(raw || '')
  }
}

function extractLinks(html, baseUrl) {
  return [...html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map(([, href, inner]) => {
      try {
        const u = new URL(decode(href), baseUrl)
        if (!/^https?:$/.test(u.protocol)) return null
        u.hash = ''
        return { url: u.href, text: toText(inner).slice(0, 80) }
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

// ---------- state shared across one scan (both agents) ----------

/**
 * @param {{ origin: string, fetcher: any, robots: { allows: (u: URL) => boolean }, maxFetches: number, maxPdfs: number }} opts
 * limits.maxFetches can be raised between agents (the extractor gets a small extra budget).
 */
export function createToolbox({ origin, fetcher, robots, maxFetches, maxPdfs }) {
  const baseHost = new URL(origin).hostname.replace(/^www\./, '')
  const limits = { maxFetches, maxPdfs }
  const state = {
    fetches: 0,
    pdfs: 0,
    fetched: [], // [{ url, ok, title, kind }]
    fetchedKeys: new Set(), // urlKey of every page/file that loaded successfully
    pdfKeys: new Set(),
    linkedKeys: new Set(), // every link seen on a fetched page (rule 2 exception + coa_link check)
    pageText: new Map(), // urlKey -> tool output text, handed to the extractor
    coaWidgets: new Map(), // urlKey -> { url, title, provider } for pages with an embedded lab-report widget
  }
  const linkedRaw = new Set()
  const isStore = (u) => u.hostname.replace(/^www\./, '') === baseHost

  function checkUrl(raw) {
    let u
    try {
      u = new URL(raw)
    } catch {
      return { error: 'Invalid URL. Use an absolute https:// URL.' }
    }
    u.hash = ''
    if (!/^https?:$/.test(u.protocol) || !isPublicHostname(u.hostname)) return { error: 'URL not allowed.' }
    if (isStore(u)) {
      if (FORBIDDEN_PATH.test(u.pathname)) return { error: 'Not allowed: /cart, /checkout, /account and /search are off-limits (rule 1).' }
      if (!robots.allows(u)) return { error: "Not allowed: the store's robots.txt disallows this path." }
      return { url: u }
    }
    if (linkedRaw.has(u.href) || state.linkedKeys.has(urlKey(u.href))) return { url: u }
    return { error: 'Off-domain URL not allowed unless the store links to it from a page you fetched (rule 2).' }
  }

  const markFetched = (...urls) => urls.forEach((u) => u && state.fetchedKeys.add(urlKey(u)))
  const budgetLine = () => `BUDGET: fetch_page ${state.fetches}/${limits.maxFetches}, read_pdf ${state.pdfs}/${limits.maxPdfs}`

  async function fetchPage({ url }) {
    if (state.fetches >= limits.maxFetches) return { error: `fetch_page budget exhausted (${limits.maxFetches}/${limits.maxFetches}). Finish now with what you have.` }
    const check = checkUrl(url)
    if (check.error) return check
    state.fetches++
    const res = await fetcher.get(check.url.href)
    if (!res.ok) {
      state.fetched.push({ url: check.url.href, ok: false })
      return { error: `Could not load ${check.url.href} (${res.reason}). ${budgetLine()}.` }
    }
    const finalUrl = res.url

    if (res.contentType === 'application/pdf') {
      return { error: `This URL is a PDF. Use read_pdf for it. ${budgetLine()}.` }
    }
    if (res.contentType.startsWith('image/')) {
      markFetched(check.url.href, finalUrl)
      state.fetched.push({ url: finalUrl, ok: true, title: 'image', kind: 'image' })
      const text = `URL: ${finalUrl}\nIMAGE: ${res.contentType}, ${Math.round(res.body.length / 1024)} KB. This is an image file (possibly a scanned report); its text cannot be read.\n${budgetLine()}`
      state.pageText.set(urlKey(finalUrl), text)
      return { text }
    }
    if (!/html|xml|text\/plain/.test(res.contentType || 'text/html')) {
      return { error: `Unsupported content type (${res.contentType}). ${budgetLine()}.` }
    }

    const html = res.body.toString('utf8')
    const chromeHtml = (html.match(/<(header|nav|footer)\b[\s\S]*?<\/\1>/gi) || []).join('\n')
    const mainHtml = html.replace(/<(script|style|noscript|svg|template|header|nav|footer)\b[\s\S]*?<\/\1>/gi, ' ')

    const mainLinks = extractLinks(mainHtml, finalUrl)
    const chromeLinks = extractLinks(chromeHtml, finalUrl)
    ;[...mainLinks, ...chromeLinks].forEach((l) => {
      linkedRaw.add(l.url)
      state.linkedKeys.add(urlKey(l.url))
    })

    const title = toText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '')
    const mainText = toText(mainHtml)
    const images = [...mainHtml.matchAll(/<img\b[^>]*>/gi)]
      .map(([tag]) => ({ src: (tag.match(/\bsrc\s*=\s*["']([^"']+)/i) || [])[1], alt: (tag.match(/\balt\s*=\s*["']([^"']*)/i) || [])[1] || '' }))
      .filter((i) => i.src && COA_HINT.test(`${i.src} ${i.alt}`))
      .slice(0, 20)
      .map((i) => {
        try {
          const abs = new URL(decode(i.src), finalUrl).href
          linkedRaw.add(abs)
          state.linkedKeys.add(urlKey(abs))
          return { ...i, src: abs }
        } catch {
          return i
        }
      })
    const frames = [...html.matchAll(/<(iframe|embed|object)\b[^>]*\b(?:src|data)\s*=\s*["']([^"']+)/gi)].map((m) => m[2]).slice(0, 10)
    frames.forEach((f) => {
      try {
        const abs = new URL(f, finalUrl).href
        linkedRaw.add(abs)
        state.linkedKeys.add(urlKey(abs))
      } catch {}
    })

    const widget = detectCoaWidget(html)
    if (widget) state.coaWidgets.set(urlKey(finalUrl), { url: finalUrl, title, provider: widget })

    const dedupe = (links) => [...new Map(links.map((l) => [l.url, l])).values()]
    markFetched(check.url.href, finalUrl)
    state.fetched.push({ url: finalUrl, ok: true, title, kind: 'page' })
    const sections = [
      `URL: ${finalUrl}`,
      `TITLE: ${title}`,
      budgetLine(),
      mainText.length < 200 ? 'NOTE: very little visible text. The page may be JavaScript-rendered or empty.' : null,
      widget
        ? `\n== EMBEDDED LAB-REPORT WIDGET ==\nThis page embeds ${widget === 'LabTested' ? 'the LabTested lab-report widget' : widget}. It loads the COA / lab test results in the shopper's browser, so the results are NOT in the text below, but shoppers do see them on this page. Count it as a COA shown on this page: for a product page set coa_link to this page's URL and testing_info to true.`
        : null,
      '',
      '== MAIN CONTENT (header, nav and footer removed) ==',
      cap(mainText, MAX_MAIN_CHARS),
      '',
      '== LINKS IN MAIN CONTENT ==',
      ...dedupe(mainLinks).slice(0, MAX_MAIN_LINKS).map((l) => `- ${l.text || '(no text)'} -> ${l.url}`),
      '',
      '== HEADER / NAV / FOOTER TEXT (site chrome) ==',
      cap(toText(chromeHtml), MAX_CHROME_CHARS),
      '',
      '== LINKS IN HEADER / NAV / FOOTER ==',
      ...dedupe(chromeLinks).slice(0, MAX_CHROME_LINKS).map((l) => `- ${l.text || '(no text)'} -> ${l.url}`),
      images.length ? '\n== IMAGES THAT MAY BE REPORTS ==' : null,
      ...images.map((i) => `- alt="${i.alt}" src=${i.src}`),
      frames.length ? '\n== IFRAMES / EMBEDS (possible lab portals) ==' : null,
      ...frames.map((f) => `- ${f}`),
    ]
    const text = sections.filter((s) => s !== null).join('\n')
    state.pageText.set(urlKey(finalUrl), text)
    return { text }
  }

  async function readPdf({ url }) {
    if (state.pdfs >= limits.maxPdfs) return { error: `read_pdf budget exhausted (${limits.maxPdfs}/${limits.maxPdfs}). Record remaining documents as unread in notes.` }
    const check = checkUrl(url)
    if (check.error) return check
    state.pdfs++
    const res = await fetcher.get(check.url.href, { timeoutMs: 30000, maxBytes: MAX_PDF_BYTES, accept: 'application/pdf,*/*' })
    if (!res.ok) return { error: `Could not download the PDF (${res.reason}).` }
    const bytes = new Uint8Array(res.body)
    if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') return { error: 'The URL did not return a PDF (it may be an HTML page or image; try fetch_page).' }

    let text = ''
    let pages = 0
    try {
      const pdf = await getDocumentProxy(bytes)
      const out = await extractText(pdf, { mergePages: true })
      pages = out.totalPages
      text = (Array.isArray(out.text) ? out.text.join('\n') : out.text || '').replace(/[ \t]+/g, ' ').trim()
    } catch {
      return { error: 'The PDF could not be parsed.' }
    }

    const resultHits = (text.match(/\b(results?|LOQ|LOD|ND|not detected|mg\/g|mg\/ml|ppm|ppb|cfu|pass(ed)?|fail(ed)?|absent|<\s*\d)/gi) || []).length
    const flags = {
      hasBatch: /\b(batch|lot)\b\s*(#|no\.?|number|id|code)?\s*[:\-]?\s*[A-Z0-9][A-Z0-9-]{2,}/i.test(text),
      hasDate: /\b(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/i.test(text),
      hasLab: /\b(laborator(y|ies)|labs?|analytical|ISO\s*\/?\s*IEC\s*17025|17025|accredit\w*)\b/i.test(text),
      hasResults: resultHits >= 3,
      scanned: text.length < 100,
    }
    markFetched(check.url.href, res.url)
    state.pdfKeys.add(urlKey(check.url.href))
    state.pdfKeys.add(urlKey(res.url))
    state.fetched.push({ url: res.url, ok: true, title: 'PDF', kind: 'pdf', pages, ...flags })
    return {
      text: [
        `URL: ${check.url.href}`,
        `PAGES: ${pages}`,
        `FLAGS: ${JSON.stringify(flags)}`,
        `BUDGET: read_pdf ${state.pdfs}/${limits.maxPdfs}`,
        '',
        '== TEXT ==',
        flags.scanned ? '(no extractable text: likely a scanned image)' : cap(text, MAX_PDF_CHARS),
      ].join('\n'),
    }
  }

  return { fetchPage, readPdf, state, limits }
}
