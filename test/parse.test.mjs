// Parser test: runs the real deprecations parser against a saved copy of
// OpenAI's official Deprecations page and compares the merged result with
// the seed's verified shutdown data (34 models, 23 with shutdown dates).
//
// Usage:  node test/parse.test.mjs [path-to-deprecations.html]
// Without a file argument, a small built-in fixture is used instead.
import { readFileSync } from 'node:fs';
import { parseDeprecations, mergeShutdowns, parseUsageTiers, mergeTiers } from '../src/parse.js';

const seed = JSON.parse(readFileSync(new URL('../data/models.json', import.meta.url), 'utf8'));

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + msg);
  if (!cond) failures += 1;
};

// --- dataset integrity ---
const counts = seed.taskGroups.map((g) => g.models.length);
check(JSON.stringify(counts) === '[11,5,4,5,9]', `group counts 11/5/4/5/9 (got ${counts})`);
const all = seed.taskGroups.flatMap((g) => g.models);
check(all.length === 34, `34 models (got ${all.length})`);
check(all.filter((m) => m.isLatest).length === 7, '7 latest flags');
check(all.filter((m) => m.shutdownDate).length === 23, '23 seed shutdown entries');
check(new Set(all.map((m) => m.name)).size === 34, 'model names unique');

// --- parser ---
const fixture = process.argv[2]
  ? readFileSync(process.argv[2], 'utf8')
  : `<table><tbody>
     <tr><td>Dec 11, 2026</td><td><code>gpt-5</code> | <code>gpt-5-2025-08-07</code></td><td><code>gpt-5.6-sol</code></td></tr>
     <tr><td>January 14, 2027</td><td>GPT-4o (<code>gpt-4o-2024-08-06</code>)</td><td><code>gpt-6-luna</code></td></tr>
     </tbody></table>`;
const depMap = parseDeprecations(fixture);
console.log(`parsed ${depMap.size} model ids from deprecations source`);
check(depMap.size >= 2, 'parser extracted entries');

const { data, matched } = mergeShutdowns(seed, depMap);
const merged = Object.fromEntries(
  data.taskGroups.flatMap((g) => g.models).map((m) => [m.name, m]),
);

if (process.argv[2]) {
  // Full-page run: every seed shutdown entry must be reproduced exactly.
  let exact = 0;
  for (const m of all) {
    const got = merged[m.name];
    if ((got.shutdownDate || null) === (m.shutdownDate || null) &&
        (got.replacement || null) === (m.replacement || null)) {
      exact += 1;
    } else {
      console.log(`  diff ${m.name}: seed=${m.shutdownDate}/${m.replacement} parsed=${got.shutdownDate}/${got.replacement}`);
    }
  }
  check(matched === 23, `parser matched all 23 shutdown models (got ${matched})`);
  check(exact === 34, `all 34 models reproduce seed exactly (got ${exact})`);
} else {
  check(merged['gpt-5-2025-08-07'].shutdownDate === '2026-12-11', 'fixture: gpt-5 date');
  check(merged['gpt-4o-2024-08-06'].replacement === 'gpt-6-luna', 'fixture: 4o replacement');
}

// --- usage tiers: fixture + optional live regression ---
const tiersFixture = `<table><tr><th>Tier</th><th>Qualification</th><th>Usage limits</th></tr>
<tr><td>Free</td><td>User must be in an <a href="#">allowed geography</a></td><td>$100 / month</td></tr>
<tr><td>Build</td><td>$5 in total credit purchases</td><td>$500 / month</td></tr>
<tr><td>Launch</td><td>$100 in total credit purchases</td><td>$5,000 / month</td></tr>
<tr><td>Grow</td><td>$500 in total credit purchases</td><td>$200,000 / month</td></tr></table>
<table><tr><td>Build</td><td>Astra, Sol, Terra</td><td>5,000</td><td>1,000,000</td></tr></table>`;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tm = parseUsageTiers(tiersFixture);
check(tm.size === 4, 'tiers fixture: 4 tiers parsed');
check(eq(tm.get('Free'), { purchaseUsd: 0, monthlyCapUsd: 100 }), 'tiers fixture: Free facts');
check(eq(tm.get('Build'), { purchaseUsd: 5, monthlyCapUsd: 500 }), 'tiers fixture: Build facts');
check(eq(tm.get('Launch'), { purchaseUsd: 100, monthlyCapUsd: 5000 }), 'tiers fixture: Launch facts');
check(eq(tm.get('Grow'), { purchaseUsd: 500, monthlyCapUsd: 200000 }), 'tiers fixture: Grow facts');
const mergedT = mergeTiers(seed, tm);
check(mergedT.updated === 4, 'tiers merge: 4 updated');
check(mergedT.data.tiers.find((x) => x.key === 'grow').monthlyCapUsd === 200000, 'tiers merge: Grow cap applied');
// seed v2 shape: four tiers with scraped-fact fields + complimentary quotas
check(seed.version === 2, 'seed version 2');
check(eq(seed.tiers.map((x) => x.key), ['free', 'build', 'launch', 'grow']), 'seed tiers order');
const sq = Object.fromEntries(seed.tiers.map((x) => [x.key, x.quotas]));
check(eq(sq.free, { large: 0, small: 0 }), 'seed quotas: Free 0');
check(eq(sq.build, { large: 250000, small: 2500000 }), 'seed quotas: Build');
check(eq(sq.launch, { large: 1000000, small: 10000000 }), 'seed quotas: Launch');
check(eq(sq.grow, { large: 1000000, small: 10000000 }), 'seed quotas: Grow');
check(seed.tiers.find((x) => x.key === 'free').eligible === false, 'seed Free not eligible');
check(eq(seed.tiers.map((x) => [x.purchaseUsd, x.monthlyCapUsd]), [[0, 100], [5, 500], [100, 5000], [500, 200000]]), 'seed tier facts match official guide');
if (process.argv[3]) {
  const live = parseUsageTiers(readFileSync(process.argv[3], 'utf8'));
  check(live.size === 4, 'tiers live: 4 tiers parsed');
  check(eq(live.get('Build'), { purchaseUsd: 5, monthlyCapUsd: 500 }), 'tiers live: Build facts');
  check(eq(live.get('Grow'), { purchaseUsd: 500, monthlyCapUsd: 200000 }), 'tiers live: Grow facts');
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
