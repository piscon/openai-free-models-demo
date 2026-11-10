// OpenAI Free Models — Cloudflare Worker
//
// What this Worker does:
//   1. Serves the static site from ./public (static assets are free and
//      unmetered on Cloudflare).
//   2. Serves the current dataset at GET /api/models (read-only, cached).
//      There is deliberately NO endpoint, button, or query parameter that
//      triggers a fetch of the official sources. The site is public; a
//      visitor-triggerable refresh would burn the free-tier quota
//      (Workers KV free tier allows only 1,000 writes/day).
//   3. Once a day, the Cron Trigger (see wrangler.jsonc, 03:17 UTC) runs
//      the scheduled() handler below, which re-reads OpenAI's official
//      Deprecations page (shutdown dates / replacements) and the Rate
//      limits guide's Usage tiers table (tier thresholds / monthly caps),
//      updating both in KV.
//      Safeguards: a 20-hour minimum gap between attempts, ETag
//      conditional requests, a content hash so unchanged pages cost no
//      KV write, and a sanity check that aborts the update if parsing
//      looks broken. Failures keep the previous data; there is no retry
//      until the next scheduled run.
//
// The complimentary-token model list and quotas come from the seed file
// data/models.json: help.openai.com returns 403 to plain fetches, so that
// list cannot be scraped reliably by a Worker. It changes rarely and is
// updated by editing the seed file (the page always shows the date the
// seed was last verified against the official article).

import seedData from '../data/models.json';
import { parseDeprecations, mergeShutdowns, parseUsageTiers, mergeTiers, fnv1a } from './parse.js';

const DEPRECATIONS_URL = 'https://developers.openai.com/api/docs/deprecations';
const RATE_LIMITS_URL = seedData.sources.tiers || 'https://developers.openai.com/api/docs/guides/rate-limits';
const HELP_URL = seedData.sources.program;
const DATA_KEY = 'models:v1';
const META_KEY = 'meta:v1';
const MIN_GAP_MS = 20 * 60 * 60 * 1000; // 20 hours between fetch attempts

function jsonResponse(obj, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=600',
      ...extraHeaders,
    },
  });
}

async function currentData(env) {
  if (env.MODELS_KV) {
    try {
      const stored = await env.MODELS_KV.get(DATA_KEY, 'json');
      if (stored && Array.isArray(stored.taskGroups)) {
        const meta = await env.MODELS_KV.get(META_KEY, 'json');
        return { ...stored, runtime: meta?.runtime ?? null };
      }
    } catch {
      // fall through to the bundled seed
    }
  }
  return { ...seedData, runtime: null };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/models' || url.pathname === '/data/models.json') {
      // Read-only data endpoint. Served from the edge cache when possible.
      const cache = caches.default;
      const cacheKey = new Request(url.origin + '/api/models', { method: 'GET' });
      let res = await cache.match(cacheKey);
      if (!res) {
        const data = await currentData(env);
        res = jsonResponse(data);
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
      }
      return res;
    }

    if (url.pathname.startsWith('/api/')) {
      // No other API exists — in particular, nothing here can trigger a
      // re-fetch of the official sources.
      return jsonResponse({ error: 'not found' }, { 'cache-control': 'no-store' });
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refresh(env));
  },
};

async function refresh(env) {
  if (!env.MODELS_KV) return; // nowhere to persist; seed-only mode
  const kv = env.MODELS_KV;
  const now = Date.now();

  let meta = (await kv.get(META_KEY, 'json')) || {};
  if (meta.lastAttempt && now - meta.lastAttempt < MIN_GAP_MS) return; // self-guard
  meta = { ...meta, lastAttempt: now };

  const storedData = await kv.get(DATA_KEY, 'json');
  let base = null; // dataset to persist if anything changed
  let changed = false;
  const startFrom = () =>
    base ??
    (storedData && Array.isArray(storedData.taskGroups)
      ? JSON.parse(JSON.stringify(storedData))
      : JSON.parse(JSON.stringify(seedData)));

  // 1) Deprecations page: plain fetch works (verified), fully parseable.
  try {
    const headers = {};
    if (meta.deprecationsEtag) headers['if-none-match'] = meta.deprecationsEtag;
    const res = await fetch(DEPRECATIONS_URL, { headers, cf: { cacheTtl: 0 } });
    if (res.status === 200) {
      const html = await res.text();
      const hash = fnv1a(html);
      if (hash !== meta.deprecationsHash) {
        const depMap = parseDeprecations(html);
        const { matched } = mergeShutdowns(seedData, depMap);
        // Sanity check: the page currently matches 23 of the 34 seed
        // models. If parsing suddenly finds almost nothing, the page
        // structure has changed — keep the old data instead of wiping
        // every shutdown badge.
        if (depMap.size >= 20 && matched >= 10) {
          base = mergeShutdowns(seedData, depMap).data;
          changed = true;
          meta.deprecationsHash = hash;
          meta.deprecationsEtag = res.headers.get('etag');
          meta.lastSuccess = now;
          meta.matched = matched;
        }
      } else {
        meta.lastSuccess = meta.lastSuccess ?? now;
      }
    }
  } catch {
    // Keep previous data; try again at the next scheduled run.
  }

  // 2) Usage tiers: the Rate limits guide publishes the tier table
  // (thresholds and monthly caps) and is fetchable the same way. Only
  // those facts are refreshed; the complimentary quotas per tier are
  // program parameters stated in the help article and stay with the seed.
  try {
    const headers = {};
    if (meta.tiersEtag) headers['if-none-match'] = meta.tiersEtag;
    const res = await fetch(RATE_LIMITS_URL, { headers, cf: { cacheTtl: 0 } });
    if (res.status === 200) {
      const html = await res.text();
      const hash = fnv1a(html);
      if (hash !== meta.tiersHash) {
        const tierMap = parseUsageTiers(html);
        if (tierMap.size >= 3) {
          const merged = mergeTiers(startFrom(), tierMap);
          if (merged.updated >= 3) {
            base = merged.data;
            changed = true;
            meta.tiersHash = hash;
            meta.tiersEtag = res.headers.get('etag');
            meta.tiersCheckedAt = now;
            meta.tiersUpdated = merged.updated;
          }
        }
      }
    }
  } catch {
    // Keep previous tier facts; try again at the next scheduled run.
  }

  // 2) The help article: probed only. It currently answers 403 to plain
  // fetches; the status is recorded so the site can show honestly whether
  // the seed list could be machine-checked. The model list itself is
  // never auto-rewritten from this probe.
  try {
    const res = await fetch(HELP_URL, { cf: { cacheTtl: 0 } });
    meta.helpArticleStatus = res.status === 200 ? 'reachable' : `http-${res.status}`;
  } catch {
    meta.helpArticleStatus = 'unreachable';
  }

  const runtime = {
    deprecationsCheckedAt: meta.lastSuccess
      ? new Date(meta.lastSuccess).toISOString()
      : null,
    helpArticleStatus: meta.helpArticleStatus ?? 'seed-only',
  };
  if (changed && base) {
    base.runtime = runtime;
    await kv.put(DATA_KEY, JSON.stringify(base));
  }
  // currentData() overlays meta.runtime at read time, so the runtime
  // block stays current even when the dataset itself did not change.
  meta.runtime = runtime;
  await kv.put(META_KEY, JSON.stringify(meta));
}
