// Post-processing of Agent 2's evidence, in plain code:
//  1. pruneEvidence: drops every finding whose URL was not actually fetched during the scan.
//  2. buildFindings: turns the evidence into the list of findings the widget shows.
import { urlKey } from './tools.js'
import { PRODUCT_URL } from '../fetcher.js'

const arr = (v) => (Array.isArray(v) ? v : [])
const SIGNALS = ['batch_lookup', 'matching_instructions', 'email_request', 'qr_mention', 'homepage_testing_claim']
const CATEGORIES = ['baby', 'sports', 'supplements', 'food', 'cosmetics', 'pet', 'other']
const METHODS = ['product_page', 'separate_page', 'batch_lookup', 'email', 'none']
const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '')
const strOrNull = (v, max = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/**
 * @param {object} raw evidence from Agent 2
 * @param {{ fetchedKeys: Set<string>, linkedKeys: Set<string>, coaWidgets?: Map<string, {url:string,title:string,provider:string}> }} state toolbox state
 */
export function pruneEvidence(raw, state) {
  const ev = raw && typeof raw === 'object' ? raw : {}
  const fetched = (u) => typeof u === 'string' && state.fetchedKeys.has(urlKey(u))
  const seen = (u) => typeof u === 'string' && (state.fetchedKeys.has(urlKey(u)) || state.linkedKeys.has(urlKey(u)))
  const dropped = []
  const keep = (list, test, label) =>
    arr(list).filter((item) => {
      const ok = item && typeof item === 'object' && test(item)
      if (!ok && item?.url) dropped.push(`${label}: ${item.url}`)
      return ok
    })

  const out = {
    category_guess: CATEGORIES.includes(ev.category_guess) ? ev.category_guess : 'other',
    products_checked: keep(ev.products_checked, (p) => fetched(p.url), 'product').map((p) => ({
      url: p.url,
      title: str(p.title, 200),
      // a COA link must be a link that was actually on a fetched page (or a fetched document)
      coa_link: seen(p.coa_link) ? p.coa_link : null,
      testing_info: Boolean(p.testing_info),
      batch_on_page: Boolean(p.batch_on_page),
    })),
    testing_pages: keep(ev.testing_pages, (p) => fetched(p.url), 'testing page').map((p) => ({ url: p.url, summary: str(p.summary) })),
    coa_documents: keep(ev.coa_documents, (d) => fetched(d.url), 'document').map((d) => ({
      url: d.url,
      found_on: typeof d.found_on === 'string' ? d.found_on : null,
      product: str(d.product, 200),
      batch: strOrNull(d.batch),
      lab: strOrNull(d.lab),
      date: strOrNull(d.date, 40),
      has_results: Boolean(d.has_results),
      scanned_image: Boolean(d.scanned_image),
    })),
    access_methods: [...new Set(arr(ev.access_methods).filter((m) => METHODS.includes(m)))],
    notes: arr(ev.notes).filter((n) => typeof n === 'string').map((n) => n.slice(0, 300)).slice(0, 12),
  }
  for (const key of SIGNALS) {
    const s = ev[key]
    if (s && s.found && fetched(s.url)) out[key] = { found: true, url: s.url }
    else {
      if (s && s.found) dropped.push(`${key}: ${s.url || '(no url)'}`)
      out[key] = { found: false, url: null }
    }
  }
  addCoaWidgets(out, [...(state.coaWidgets?.values() || [])])
  return { evidence: out, dropped }
}

/**
 * Pages with an embedded lab-report widget (detected in the HTML by the toolbox, not by the LLM)
 * show their COA in the shopper's browser. Record them in code so the result never depends on the
 * extractor noticing: a product page with a widget has its COA on the page.
 */
function addCoaWidgets(out, widgets) {
  out.coa_widgets = widgets.map((w) => ({ url: w.url, provider: w.provider }))
  for (const w of widgets) {
    const key = urlKey(w.url)
    const product = out.products_checked.find((p) => urlKey(p.url) === key)
    if (product) {
      product.coa_link ||= w.url
      product.testing_info = true
      product.coa_widget = w.provider
    } else if (PRODUCT_URL.test(w.url)) {
      out.products_checked.push({ url: w.url, title: str(w.title, 200), coa_link: w.url, testing_info: true, batch_on_page: false, coa_widget: w.provider })
    } else if (!out.testing_pages.some((t) => urlKey(t.url) === key)) {
      out.testing_pages.push({ url: w.url, summary: `Lab results shown in ${w.provider === 'LabTested' ? 'a LabTested' : 'an embedded'} lab-report panel.` })
    }
  }
  if (out.products_checked.some((p) => p.coa_widget) && !out.access_methods.includes('product_page')) {
    out.access_methods = [...out.access_methods.filter((m) => m !== 'none'), 'product_page']
  }
}

const pathOf = (u) => {
  try {
    return decodeURIComponent(new URL(u).pathname) || '/'
  } catch {
    return u
  }
}

/**
 * The seven findings rows shown after the scan (same rows as the assessment design).
 * @param {object} ev pruned evidence
 * @param {string} categoryName human name of the detected category
 * @returns {{ id: string, label: string, status: 'found'|'partial'|'missing', text: string, urls: string[] }[]}
 */
export function buildFindings(ev, categoryName) {
  const products = ev.products_checked
  const docs = ev.coa_documents
  const withCoa = products.filter((p) => p.coa_link)
  const withInfo = products.filter((p) => p.testing_info)
  const realDocs = docs.filter((d) => d.has_results)
  const withBatch = docs.filter((d) => d.batch)
  const scanned = docs.filter((d) => d.scanned_image)
  const testing = ev.testing_pages
  const widgets = arr(ev.coa_widgets)
  const widgetProducts = products.filter((p) => p.coa_widget)
  const panel = widgets.length ? `${widgets[0].provider === 'LabTested' ? 'LabTested' : 'embedded'} lab-report panel` : ''
  const f = []
  const add = (id, label, status, text, urls = []) => f.push({ id, label, status, text, urls: [...new Set(urls.filter(Boolean))] })
  const s = (n) => (n === 1 ? '' : 's')

  add('category', 'Product category', ev.category_guess === 'other' ? 'partial' : 'found',
    ev.category_guess === 'other' ? 'Category not confidently identified; assessed generally.' : `Identified category: ${categoryName}${products.length ? ` (${products.length} product page${s(products.length)} reviewed)` : ''}.`)

  if (widgets.length) {
    const where = products.length ? `on ${widgetProducts.length} of ${products.length} product page${s(products.length)} reviewed` : 'on the store'
    add('availability', 'COA availability', 'found', `COA found: lab results shown ${where} (${panel})${docs.length ? `, plus ${docs.length} report file${s(docs.length)}` : ''}.`, [...widgets.map((w) => w.url), ...docs.map((d) => d.url)])
  } else if (!docs.length) add('availability', 'COA availability', 'missing', ev.email_request.found ? 'No reports published; they are available on request only.' : 'No lab reports found on the pages we reviewed.', [ev.email_request.url])
  else if (products.length && withCoa.length >= products.length * 0.75 && realDocs.length) add('availability', 'COA availability', 'found', `Reports found for ${withCoa.length} of ${products.length} products reviewed.`, docs.map((d) => d.url))
  else add('availability', 'COA availability', 'partial', `Some COAs publicly available: ${docs.length} report${s(docs.length)} found${products.length ? `, linked from ${withCoa.length} of ${products.length} products reviewed` : ''}.`, docs.map((d) => d.url))

  if (ev.batch_lookup.found || (products.length && withCoa.length === products.length)) add('accessibility', 'COA accessibility', 'found', ev.batch_lookup.found ? 'Customers can look up a report directly.' : 'Every product page reviewed links straight to its report.', [ev.batch_lookup.url, ...withCoa.map((p) => p.url)])
  else if (testing.length || withCoa.length) add('accessibility', 'COA accessibility', 'partial', testing.length ? `Reports reachable through ${pathOf(testing[0].url)}${withCoa.length ? ' and some product pages' : ', not from product pages'}.` : 'A report link appears on some product pages but not on others.', [...testing.map((t) => t.url), ...withCoa.map((p) => p.url)])
  else add('accessibility', 'COA accessibility', 'missing', ev.email_request.found ? 'Available on request only.' : 'Hard to locate; no path to reports found from the pages reviewed.', [ev.email_request.url])

  if (!products.length) add('product_pages', 'Product-page testing information', 'missing', 'No product pages could be reviewed.')
  else {
    const n = Math.max(withInfo.length, withCoa.length)
    add('product_pages', 'Product-page testing information', n === products.length ? 'found' : n ? 'partial' : 'missing', n ? `Present on ${n} of ${products.length} product pages reviewed.` : 'Limited visibility on product pages.', products.map((p) => p.url))
  }

  if (ev.batch_lookup.found) add('batch', 'Batch or lot identification', 'found', 'A lot lookup lets customers match their pack to its report.', [ev.batch_lookup.url])
  else if (withBatch.length) add('batch', 'Batch or lot identification', withBatch.length === docs.length && ev.matching_instructions.found ? 'found' : 'partial', `Lot numbers appear on ${withBatch.length} of ${docs.length} reports${ev.matching_instructions.found ? ', with instructions for matching a pack' : ', but there is no way to match a pack to its report'}.`, [...withBatch.map((d) => d.url), ev.matching_instructions.url])
  else if (widgets.length) add('batch', 'Batch or lot identification', 'partial', `Lot details may be shown inside the ${panel}, but we couldn’t read them from the page.`, widgets.map((w) => w.url))
  else add('batch', 'Batch or lot identification', 'missing', docs.length ? 'Reports are not linked to individual batches or lots.' : 'No lot reference found.')

  if (widgets.length && !scanned.length) add('format', 'COA presentation format', 'found', `Results are shown in an interactive ${panel} on the page, readable on a phone.`, widgets.map((w) => w.url))
  else if (!docs.length) add('format', 'COA presentation format', 'partial', 'No public reports to assess.')
  else if (scanned.length) add('format', 'COA presentation format', 'partial', `${scanned.length} report${scanned.length === 1 ? ' is a scanned image' : 's are scanned images'}, hard to read on a phone.`, scanned.map((d) => d.url))
  else add('format', 'COA presentation format', testing.length ? 'found' : 'partial', testing.length ? 'Readable reports with a page that brings them together.' : 'Reports are PDF downloads with no summary.', docs.map((d) => d.url))

  const claim = ev.homepage_testing_claim
  if (claim.found && withInfo.length) add('visibility', 'Visibility of testing information', 'found', 'Testing is shown on the homepage and on product pages.', [claim.url])
  else if (claim.found || testing.length || withInfo.length) add('visibility', 'Visibility of testing information', 'partial', claim.found ? 'Testing commitment is shown on the homepage, but not consistently on product pages.' : 'Testing is mentioned, but not prominently.', [claim.url, testing[0]?.url])
  else add('visibility', 'Visibility of testing information', 'missing', 'No testing information is visible on the pages reviewed.')

  return f
}
