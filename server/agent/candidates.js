// Builds the candidate URL list the crawler starts from: sitemap + products.json,
// with keyword hits marked [likely]. Plain direct requests made by the server.
import { readSitemaps, PRODUCT_URL, SKIP } from '../fetcher.js'

const KEYWORDS = /\b(coas?|lab|labs|laborator(y|ies)|tested|testing|tests?|certificates?|certified|analysis|batch|lot|quality|purity|potency|third[- ]party)\b/i
const KEYWORD_URL = /(coa|lab|test|certificate|analysis|batch|lot|quality|purity|faq)/i
const MAX_LIKELY_PRODUCTS = 40
const MAX_OTHER_PRODUCTS = 40
const MAX_PAGES = 60

async function shopifyProducts(origin, fetcher) {
  const products = []
  for (let page = 1; page <= 4; page++) {
    const r = await fetcher.getText(`${origin}/products.json?limit=250&page=${page}`, { accept: 'application/json', maxBytes: 8 * 1024 * 1024 })
    const raw = r.ok ? r.text : null
    if (!raw) break
    let json
    try {
      json = JSON.parse(raw)
    } catch {
      break
    }
    const batch = json.products || []
    for (const p of batch) {
      const text = `${p.title || ''} ${p.body_html || ''} ${(p.tags || []).join?.(' ') ?? p.tags ?? ''}`.replace(/<[^>]+>/g, ' ')
      products.push({ url: `${origin}/products/${p.handle}`, title: p.title || p.handle, likely: KEYWORDS.test(text) })
    }
    if (batch.length < 250) break
  }
  return products
}

/** @returns {Promise<{ text: string, isShopify: boolean, counts: object }>} */
export async function buildCandidates(origin, fetcher, robots) {
  const [sitemapUrls, products] = await Promise.all([readSitemaps(origin, robots.sitemaps, fetcher), shopifyProducts(origin, fetcher)])

  const sameSite = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '') === new URL(origin).hostname.replace(/^www\./, '')
    } catch {
      return false
    }
  }
  const clean = (u) => u.replace(/[#?].*$/, '').replace(/\/$/, '')

  // Products: products.json when available (has titles + descriptions), else sitemap product URLs.
  const productMap = new Map(products.map((p) => [clean(p.url), p]))
  for (const u of sitemapUrls) {
    if (!sameSite(u) || !PRODUCT_URL.test(new URL(u).pathname)) continue
    const k = clean(u)
    if (!productMap.has(k)) productMap.set(k, { url: k, title: '', likely: KEYWORD_URL.test(new URL(u).pathname) })
  }
  const allProducts = [...productMap.values()]
  const likelyProducts = allProducts.filter((p) => p.likely).slice(0, MAX_LIKELY_PRODUCTS)
  const otherAll = allProducts.filter((p) => !p.likely)
  const step = Math.max(1, Math.floor(otherAll.length / MAX_OTHER_PRODUCTS))
  const otherProducts = otherAll.filter((_, i) => i % step === 0).slice(0, MAX_OTHER_PRODUCTS)

  // Non-product pages: pages, blogs, collections etc. Keyword URLs first.
  const pages = [...new Set(sitemapUrls.filter((u) => sameSite(u) && !PRODUCT_URL.test(new URL(u).pathname) && !SKIP.test(u)).map(clean))]
  const likelyPages = pages.filter((u) => KEYWORD_URL.test(new URL(u).pathname))
  const otherPages = pages.filter((u) => !KEYWORD_URL.test(new URL(u).pathname) && /\/pages\//.test(u))
  const pageList = [...likelyPages, ...otherPages].slice(0, MAX_PAGES)

  const line = (u, likely, title) => `- ${likely ? '[likely] ' : ''}${u}${title ? `  (${title})` : ''}`
  const text = [
    `Homepage: ${origin}`,
    '',
    `## Pages (${pageList.length} of ${pages.length} non-product pages in the sitemap)`,
    ...(pageList.length ? pageList.map((u) => line(u, KEYWORD_URL.test(new URL(u).pathname))) : ['(none found in sitemap; discover them from the homepage links)']),
    '',
    `## Products (${likelyProducts.length + otherProducts.length} of ${allProducts.length} products)`,
    ...likelyProducts.map((p) => line(p.url, true, p.title)),
    ...otherProducts.map((p) => line(p.url, false, p.title)),
    ...(allProducts.length ? [] : ['(no products found in sitemap or products.json; discover them from the homepage links)']),
  ].join('\n')

  return {
    text,
    isShopify: products.length > 0,
    counts: { sitemap_urls: sitemapUrls.length, products_total: allProducts.length, likely_products: likelyProducts.length, pages_total: pages.length, likely_pages: likelyPages.length },
  }
}
