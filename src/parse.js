// Parse OpenAI's official Deprecations page (developers.openai.com) and
// extract, for every model id mentioned in a shutdown table, its shutdown
// date (ISO yyyy-mm-dd) and OpenAI's recommended replacement.
//
// The page renders each deprecation as a 3-column table row:
//   <tr><td>Dec 11, 2026</td><td><code>gpt-5</code> | <code>gpt-5-2025-08-07</code></td><td><code>gpt-5.6-sol</code></td></tr>
// Older tables use ISO dates ("2026-09-24", sometimes with non-breaking
// hyphens) and a "Substitute model" header. Both shapes are handled.
//
// Pure string processing, no dependencies: runs in a Worker and in Node.

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function stripTags(s) {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function codeContents(s) {
  const out = [];
  const re = /<code[^>]*>([^<]+)<\/code>/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[1].trim());
  return out;
}

// Accepts "Dec 11, 2026", "January 14, 2027", "Apr 1, 2027", "2026-09-24".
// Returns ISO "yyyy-mm-dd" or null.
export function parseDateText(raw) {
  if (!raw) return null;
  const text = raw.replace(/[‐-―]/g, '-').trim();
  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = text.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (!mon) return null;
    return `${m[3]}-${mon}-${m[2].padStart(2, '0')}`;
  }
  return null;
}

// Returns a Map: modelId -> { shutdownDate, replacement }
export function parseDeprecations(html) {
  const map = new Map();
  if (!html || typeof html !== 'string') return map;
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  let row;
  while ((row = rowRe.exec(html)) !== null) {
    const cells = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let td;
    while ((td = tdRe.exec(row[1])) !== null) cells.push(td[1]);
    if (cells.length < 3) continue;
    const shutdownDate = parseDateText(stripTags(cells[0]));
    if (!shutdownDate) continue;
    let ids = codeContents(cells[1]);
    if (ids.length === 0) {
      // Legacy rows list the model as plain text (no <code>), e.g.
      // <td>2025-07-14</td><td>gpt-4.5-preview</td><td>gpt-4.1</td>
      ids = stripTags(cells[1])
        .split(/[\s,|()]+/)
        .filter((t) => /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(t) && /\d/.test(t));
    }
    if (ids.length === 0) continue;
    const replCodes = codeContents(cells[2]);
    let replacement = replCodes.length > 0 ? replCodes[0] : stripTags(cells[2]);
    replacement = replacement.replace(/\*+$/, '').trim();
    if (!replacement || replacement === '—' || replacement === '-') replacement = null;
    for (const id of ids) {
      // First occurrence wins: the page lists upcoming deprecations first.
      if (!map.has(id)) map.set(id, { shutdownDate, replacement });
    }
  }
  return map;
}

// Merge freshly parsed shutdown info into the seed dataset.
// The deprecations page is authoritative for shutdown status: a known model
// that no longer appears there loses its shutdown badge. Models that are new
// on the page but unknown to the seed are ignored (the complimentary-token
// model list itself only changes through a seed update).
// Returns { data, matched } where matched = how many seed models got a date.
export function mergeShutdowns(seedData, depMap) {
  const data = JSON.parse(JSON.stringify(seedData));
  let matched = 0;
  for (const group of data.taskGroups) {
    for (const model of group.models) {
      // Exact snapshot id first; the legacy table lists some models only
      // by their alias (e.g. "o1-preview" for o1-preview-2024-09-12), so
      // fall back to the name without its -yyyy-mm-dd snapshot suffix.
      const base = model.name.replace(/-\d{4}-\d{2}-\d{2}$/, '');
      const hit = depMap.get(model.name) || (base !== model.name ? depMap.get(base) : undefined);
      if (hit) {
        model.shutdownDate = hit.shutdownDate;
        model.replacement = hit.replacement;
        matched += 1;
      } else {
        model.shutdownDate = null;
        model.replacement = null;
      }
    }
  }
  return { data, matched };
}

// Parse the Usage tiers table from OpenAI's official Rate limits guide
// (developers.openai.com/api/docs/guides/rate-limits). The table rows are:
//   | Free   | User must be in an allowed geography | $100 / month |
//   | Build  | $5 in total credit purchases         | $500 / month |
//   | Launch | $100 in total credit purchases       | $5,000 / month |
//   | Grow   | $500 in total credit purchases       | $200,000 / month |
// Only the facts are extracted (tier name, cumulative-purchase threshold,
// monthly usage cap); display wording is derived from them by the caller.
// Returns a Map: tierName -> { purchaseUsd, monthlyCapUsd }
const TIER_NAMES = ['Free', 'Build', 'Launch', 'Grow'];
export function parseUsageTiers(html) {
  const map = new Map();
  if (!html || typeof html !== 'string') return map;
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  let row;
  while ((row = rowRe.exec(html)) !== null) {
    const cells = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let td;
    while ((td = tdRe.exec(row[1])) !== null) cells.push(stripTags(td[1]));
    if (cells.length < 3) continue;
    const name = cells[0];
    if (!TIER_NAMES.includes(name) || map.has(name)) continue;
    // Disambiguate from the per-model rate-limit tables further down the
    // page (their rows also start with a tier name): the usage-tiers table
    // is the one whose qualification mentions credit purchases / geography
    // and whose limit is a dollar amount.
    if (!/credit purchases|allowed geography/i.test(cells[1])) continue;
    const cap = cells[2].match(/\$\s*([\d,]+)/);
    if (!cap) continue;
    const buy = cells[1].match(/\$\s*([\d,]+)/);
    map.set(name, {
      purchaseUsd: buy ? parseInt(buy[1].replace(/,/g, ''), 10) : 0,
      monthlyCapUsd: parseInt(cap[1].replace(/,/g, ''), 10),
    });
  }
  return map;
}

// Refresh the tier facts (purchase threshold / monthly cap) in a dataset
// from a parsed usage-tiers map. Complimentary quotas and eligibility are
// program parameters stated only in the help article, so they stay with
// the seed; only the doc-published facts are overwritten here.
export function mergeTiers(dataObj, tierMap) {
  const data = JSON.parse(JSON.stringify(dataObj));
  let updated = 0;
  for (const tier of data.tiers || []) {
    const hit = tierMap.get(tier.name);
    if (hit) {
      tier.purchaseUsd = hit.purchaseUsd;
      tier.monthlyCapUsd = hit.monthlyCapUsd;
      updated += 1;
    }
  }
  return { data, updated };
}

// Small, fast, non-cryptographic hash used only for change detection.
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}
