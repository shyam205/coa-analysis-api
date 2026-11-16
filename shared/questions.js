// Assessment content shared by the widget (to render it) and the server (to validate + score).
// Ported from the "COA Presentation Assessment" lead-magnet design. Plain data, no secrets.
// Scores are only ever calculated on the server (server/agent/score.js).

/** Testing types (q3 options depend on the category). */
export const TESTS = {
  micro: 'Microbiological',
  metals: 'Heavy metals & contaminants',
  potency: 'Potency / composition',
  label: 'Label-claim comparison',
  banned: 'Banned-substance screening',
  allergen: 'Allergen / ingredient-specific',
  nutrient: 'Nutrient composition',
  shelf: 'Shelf-life / stability',
  identity: 'Ingredient identity',
  dissolution: 'Dissolution / disintegration',
}

/** Categories: name, relevant tests, insights [title, text], and per-dimension "why it matters". */
export const CATEGORIES = {
  baby: {
    name: 'Baby Food & Infant/Toddler Nutrition',
    tests: ['micro', 'metals', 'allergen', 'nutrient', 'shelf'],
    insights: [
      ['Microbiological testing', 'Powdered and ready-to-eat infant products are often reviewed for pathogens and spoilage organisms. Parents look for clear, plainly worded results rather than raw lab tables.'],
      ['Heavy metals and contaminants', 'Arsenic, lead, cadmium and mercury are widely discussed in infant nutrition. Showing which are tested per batch, and reported against what limit, builds context.'],
      ['Ingredient and product-specific testing', 'Different bases (rice, fruit, dairy) carry different considerations. Reports should match the specific product, not a family of products.'],
      ['Batch traceability', 'A parent holding a pouch should be able to match its lot code to a report in a few taps.'],
      ['Communicating with parents', 'Short summaries, defined terms and a link to the full report work better than documents written for lab staff.'],
    ],
    why: {
      avail: 'Parents expect testing information to exist and be easy to confirm for infant products.',
      access: 'Parents are often shopping on a phone and will not tolerate a multi-step search for a report.',
      trace: 'Lot codes are printed on packs, so matching a report to a lot is the natural way parents check.',
      present: 'Plain-language context helps parents understand what was tested without reading a raw lab document.',
      internal: 'Infant lines often have frequent batches, so manual report handling can slow updates.',
    },
  },
  sports: {
    name: 'Sports Nutrition & Protein Supplements',
    tests: ['potency', 'metals', 'micro', 'label', 'banned'],
    insights: [
      ['Potency and composition', 'Protein, amino acid and active ingredient levels are common points of scrutiny. Showing results beside the label makes the relationship easier to understand.'],
      ['Heavy metal testing', 'Plant-based proteins and cocoa-flavoured products are often discussed for heavy metals. Reporting what was tested per batch adds clarity.'],
      ['Microbiological testing', 'Powders and ready-to-drink formats may be tested for microbial counts. A short summary beside the full report helps shoppers.'],
      ['Label claims and lab results', 'Customers increasingly compare label values with lab results. Reports should be easy to compare with the product page.'],
      ['Batch-specific documentation', 'Flavours and sizes often share a report. Say which variants a report covers, and which lot.'],
    ],
    why: {
      avail: 'Performance-minded customers actively look for third-party testing documents.',
      access: 'Serious buyers compare brands, so reports that are hard to find work against you.',
      trace: 'With many flavours and sizes, a single generic report may not match the tub in the customer’s hand.',
      present: 'Showing key results at the point of purchase turns testing into a buying signal.',
      internal: 'Frequent launches and reformulations make a spreadsheet or shared drive hard to keep current.',
    },
  },
  vit: {
    name: 'Vitamins & Supplements',
    tests: ['potency', 'metals', 'micro', 'identity', 'dissolution'],
    insights: [
      ['Identity and potency', 'Reports commonly cover whether active ingredients are present and at what level against the label. Clear mapping to each product helps.'],
      ['Heavy metals', 'Botanical and mineral products are often reviewed for contaminant levels. State which metals were tested.'],
      ['Microbiological testing', 'Capsules, powders and gummies may be tested for microbial counts. Relevance depends on format.'],
      ['Dissolution and format considerations', 'Some formats are tested for disintegration or dissolution. Not every product needs every test, so explain what applies.'],
      ['Consistent product-level documentation', 'With many SKUs, customers expect the same documentation pattern on every product page.'],
    ],
    why: {
      avail: 'Larger catalogues often have uneven coverage, which customers notice when comparing products.',
      access: 'Inconsistent access across products can raise more questions than having none.',
      trace: 'Matching reports to lots matters most where products are reformulated or sourced from several suppliers.',
      present: 'A consistent testing block on every product page sets expectations across the catalogue.',
      internal: 'Many products multiply the reports to organise, track and refresh.',
    },
  },
  func: {
    name: 'Functional Foods & Beverages',
    tests: ['micro', 'metals', 'nutrient', 'shelf', 'allergen'],
    insights: [
      ['Microbiological and shelf-life testing', 'Ready-to-drink and fresh formats are often reviewed for microbial stability across shelf life.'],
      ['Functional ingredient levels', 'Where a product highlights an active (adaptogens, probiotics, caffeine), customers may want levels confirmed by a lab.'],
      ['Contaminant testing', 'Plant-based ingredients may warrant contaminant review depending on sourcing.'],
      ['Allergen and ingredient considerations', 'Shared facilities and flavour changes can affect allergen documentation.'],
      ['Presentation by flavour and batch', 'Flavour variants often differ materially; reports should name which variants they cover.'],
    ],
    why: {
      avail: 'Functional claims invite questions that lab documents can answer.',
      access: 'Shoppers decide quickly in food and drink, so documents should be a click away.',
      trace: 'Flavour variants and seasonal runs make variant-level clarity important.',
      present: 'Short callouts about functional ingredient testing support the claims you already make.',
      internal: 'Short shelf-life products create more frequent batches to document.',
    },
  },
  other: {
    name: 'Other product categories',
    tests: ['identity', 'micro', 'metals', 'nutrient', 'shelf'],
    insights: [
      ['Choose tests that fit the product', 'Relevant testing differs by format and ingredient. Document why each test applies.'],
      ['Identity and composition', 'Confirming what is in the product, and how much, is a common starting point.'],
      ['Contaminant considerations', 'Depending on ingredients, consider contaminant and microbiological review.'],
      ['Batch-level documentation', 'Whatever you test, tying each report to a lot makes it usable.'],
      ['Clear customer-facing summaries', 'Pair full reports with a short explanation of what was tested and why.'],
    ],
    why: {
      avail: 'Making any third-party testing visible helps customers evaluate you.',
      access: 'Reports are only useful when customers can find them.',
      trace: 'Report-to-lot matching makes documents more meaningful.',
      present: 'A short summary on the product page makes testing visible at the point of purchase.',
      internal: 'A simple, consistent system saves time as the catalogue grows.',
    },
  },
}

/** Maps the agents' category_guess onto an assessment category. */
export function categoryKey(guess) {
  return { baby: 'baby', sports: 'sports', supplements: 'vit', vit: 'vit', food: 'func', func: 'func' }[guess] || 'other'
}

/** Scoring dimensions: [name, tier text >=75, tier 50-74, tier <50]. */
export const DIMENSIONS = {
  avail: ['COA availability', 'Reports exist and cover most products.', 'Reports exist for some products or formats.', 'Few reports are available to customers.'],
  access: ['COA accessibility', 'Customers can reach reports quickly.', 'Reports are reachable but take several steps.', 'Customers will struggle to find reports.'],
  trace: ['Batch-level traceability', 'Reports map clearly to batches or lots.', 'Reports map to products, but only partly to batches.', 'Customers cannot tell which batch a report covers.'],
  present: ['Testing information presentation', 'Testing information is visible at the point of purchase.', 'Some testing information is shown, but not consistently.', 'Testing information is hard to see on product pages.'],
  internal: ['Internal COA management', 'Reports are organised and easy to retrieve and update.', 'Internal management works but relies on manual steps.', 'Report handling is ad hoc and hard to scale.'],
}

/** What TrueBatch does for each dimension (shown under each fix). */
export const TRUEBATCH = {
  avail: 'one place to upload every report and see which products still need one.',
  access: 'a COA panel on each product page, so reports are one tap away.',
  trace: 'a lot lookup: customers enter the code from their pack and see the matching report.',
  present: 'a product-page panel that shows what was tested next to the buy button.',
  internal: 'reports organised by product, variant and lot, with review reminders for expiring ones.',
}

/**
 * Questions. Options are [value, label, points]. q3's options come from the category's tests.
 * `exclusive` values cannot be combined with others. `show(answers, category)` hides a question.
 */
export const QUESTIONS = [
  { id: 'q1', group: 'Testing practices', text: 'How often are your products tested?', type: 'one', options: [['batch', 'Every batch', 100], ['quarterly', 'Quarterly or more often', 70], ['annual', 'Annually', 40], ['adhoc', 'Ad hoc or when requested', 20]] },
  { id: 'q2', group: 'Testing practices', text: 'Is testing batch-wise or periodic?', type: 'one', options: [['batch', 'Batch-wise', 100], ['mixed', 'A mix of both', 75], ['periodic', 'Periodic, by product', 55]] },
  { id: 'q3', group: 'Testing practices', text: 'Which testing types do you conduct? (select all that apply)', type: 'multi' },
  { id: 'q4', group: 'Testing practices', text: 'Do testing requirements differ across your product lines?', type: 'one', show: (a, c) => c !== 'baby' && c !== 'sports', options: [['yes', 'Yes, by product line', 0], ['no', 'No, the same across products', 0], ['unsure', 'Not formally defined', 0]] },
  { id: 'q5', group: 'COA management', text: 'How do you currently manage laboratory reports?', type: 'one', options: [['portal', 'A dedicated system or lab portal', 100], ['drive', 'Shared drive with a folder structure', 65], ['email', 'Email threads or personal folders', 30], ['none', 'No consistent system', 10]] },
  { id: 'q6', group: 'COA management', text: 'How are reports organised?', type: 'one', options: [['batch', 'By batch or lot', 100], ['sku', 'By SKU', 80], ['product', 'By product', 55], ['none', 'Not consistently', 10]] },
  { id: 'q7', group: 'COA management', text: 'How easily can your team find the right COA for a specific batch?', type: 'one', options: [['fast', 'Within a few minutes', 100], ['slow', 'It takes some digging or asking around', 55], ['hours', 'Hours, often involving the lab', 25], ['no', 'We often cannot', 5]] },
  { id: 'q8', group: 'COA management', text: 'How are updated or expired reports handled?', type: 'one', options: [['tracked', 'Tracked with dates and a review process', 100], ['manual', 'Replaced manually when someone remembers', 50], ['rare', 'Rarely updated', 20], ['none', 'No process', 5]] },
  { id: 'q9', group: 'Customer accessibility', text: 'How can customers access your COAs? (select all that apply)', type: 'multi', exclusive: ['none'], options: [['page', 'Directly on product pages', 100], ['qr', 'QR code on packaging', 75], ['sep', 'A separate testing or COA page', 60], ['email', 'On request by email', 35], ['none', 'Not shared with customers', 0]] },
  { id: 'q10', group: 'Customer accessibility', text: 'Can a customer tell which batch a report corresponds to?', type: 'one', show: (a) => Array.isArray(a.q9) && a.q9.length > 0 && !a.q9.includes('none'), options: [['yes', 'Yes, they can match lot numbers', 100], ['partial', 'Partially, for some products', 55], ['no', 'No', 15]] },
]

export function questionOptions(q, category) {
  if (q.id === 'q3') return (CATEGORIES[category] || CATEGORIES.other).tests.map((k) => [k, TESTS[k], 0])
  return q.options
}

/** Questions shown for these answers and category (q10 depends on q9, q4 on the category). */
export function visibleQuestions(answers, category) {
  return QUESTIONS.filter((q) => !q.show || q.show(answers || {}, category))
}

/** Points for an answer value (0 when unknown). */
export function points(id, value) {
  const q = QUESTIONS.find((x) => x.id === id)
  return q?.options?.find((o) => o[0] === value)?.[2] ?? 0
}

/** Validates answers. Returns { ok: true, answers } (only visible questions) or { ok: false, message }. */
export function validateAnswers(answers, category) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return { ok: false, message: 'Please answer the questions first.' }
  const clean = {}
  for (const q of QUESTIONS) {
    if (q.show && !q.show(clean, category)) continue
    const values = new Set(questionOptions(q, category).map((o) => o[0]))
    const a = answers[q.id]
    if (q.type === 'multi') {
      if (!Array.isArray(a) || !a.length || !a.every((v) => values.has(v))) return { ok: false, message: `Please answer: “${q.text}”` }
      if (a.length > 1 && a.some((v) => (q.exclusive || []).includes(v))) return { ok: false, message: `“Not shared” can’t be combined with other options for: “${q.text}”` }
      clean[q.id] = [...new Set(a)]
    } else {
      if (typeof a !== 'string' || !values.has(a)) return { ok: false, message: `Please answer: “${q.text}”` }
      clean[q.id] = a
    }
  }
  return { ok: true, answers: clean }
}
