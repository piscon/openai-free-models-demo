'use strict';
/* OpenAI 免费模型速查 — 前端逻辑
   数据只读：优先 /api/models（Worker），失败时回退同目录的 models.json。
   前端没有任何触发官方抓取的能力，抓取只发生在 Worker 的定时任务里。 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const state = { data: null, filter: 'all', query: '', tier: localStorage.getItem('ofm-tier') || 'build' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
const fmt = (n) => n.toLocaleString('en-US');
const todayISO = () => new Date().toISOString().slice(0, 10);

function statusOf(m) {
  if (!m.shutdownDate) return null;
  return m.shutdownDate <= todayISO() ? 'gone' : 'upcoming';
}
function daysLeft(m) {
  return Math.round((Date.parse(m.shutdownDate) - Date.parse(todayISO())) / 86400000);
}

/* ---------- theme ---------- */
function initTheme() {
  const saved = localStorage.getItem('theme');
  const theme = saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
  $('#themeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
  });
}

/* ---------- toast + copy ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('已复制 ' + text);
  if (btn) {
    const old = btn.textContent;
    btn.textContent = '已复制 ✓';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = old; btn.classList.remove('copied'); }, 1200);
  }
}

/* ---------- render: quota ---------- */
// Compat: data served from an older deployment's KV may still be v1
// (pools carried quotaBuild/quotaLaunchGrow, no tiers). Synthesize tiers.
function tiersOf(data) {
  if (Array.isArray(data.tiers) && data.tiers.length) return data.tiers;
  const lg = Object.fromEntries((data.pools || []).map((p) => [p.key, p.quotaLaunchGrow]));
  const bd = Object.fromEntries((data.pools || []).map((p) => [p.key, p.quotaBuild]));
  return [
    { key: 'free', name: 'Free', qualification: '所在地区受支持即可，无需付费', monthlyLimit: '$100 / 月', quotas: { large: 0, small: 0 }, eligible: false },
    { key: 'build', name: 'Build', qualification: '累计购买额度满 $5', monthlyLimit: '$500 / 月', quotas: bd, eligible: true },
    { key: 'launch', name: 'Launch', qualification: '累计购买额度满 $100', monthlyLimit: '$5,000 / 月', quotas: lg, eligible: true },
    { key: 'grow', name: 'Grow', qualification: '累计购买额度满 $500', monthlyLimit: '$200,000 / 月', quotas: lg, eligible: true },
  ];
}

// Display strings for a tier, derived from the scraped facts
// (purchaseUsd / monthlyCapUsd) when present; older datasets that still
// carry qualification / monthlyLimit strings use those instead.
function tierFacts(t) {
  const usd = (n) => '$' + Number(n).toLocaleString('en-US');
  return {
    qualification: t.purchaseUsd != null
      ? (t.purchaseUsd === 0 ? '所在地区受支持即可，无需付费' : `累计购买额度满 ${usd(t.purchaseUsd)}`)
      : (t.qualification || ''),
    monthlyLimit: t.monthlyCapUsd != null ? `${usd(t.monthlyCapUsd)} / 月` : (t.monthlyLimit || ''),
  };
}

function renderQuota(data) {
  const tiers = tiersOf(data);
  if (!tiers.some((t) => t.key === state.tier)) state.tier = 'build';
  const tier = tiers.find((t) => t.key === state.tier);
  const facts = tierFacts(tier);

  $('#tierChips').innerHTML = tiers.map((t) =>
    `<button class="chip${t.key === state.tier ? ' is-active' : ''}" data-tier="${esc(t.key)}" type="button">${esc(t.name)}</button>`).join('');
  $$('#tierChips .chip').forEach((c) => c.addEventListener('click', () => {
    state.tier = c.dataset.tier;
    localStorage.setItem('ofm-tier', state.tier);
    renderQuota(state.data);
  }));
  $('#tierNote').textContent = tier.eligible
    ? `${tier.name}：${facts.qualification} · 月用量上限 ${facts.monthlyLimit}`
    : `${tier.name}：${facts.qualification} · 月用量上限 ${facts.monthlyLimit} · 不在此计划内`;

  const cards = data.pools.map((p) => {
    const q = tier.quotas[p.key] ?? 0;
    return `
    <div class="quota-card${tier.eligible ? '' : ' is-zero'}">
      <div class="pool">${esc(p.label)} · 每日免费额度（同池共享）</div>
      <div class="big">${fmt(q)} <small>tokens / 天 · ${esc(tier.name)} 层级</small></div>
      <div class="sub">${tier.eligible
        ? '同池内所有模型共用这一份额度'
        : '⚠ Free 层级拿不到免费额度：先累计购买满 $5 升到 Build 才能参加'}</div>
    </div>`;
  }).join('');
  $('#quotaGrid').innerHTML = cards + `
    <div class="reset-chip" style="grid-column:1/-1">
      ⏳ 距下次额度重置（UTC 00:00）还有 <span id="resetCd">--:--:--</span>
    </div>`;
  const tick = () => {
    const now = new Date();
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    let s = Math.floor((next - now.getTime()) / 1000);
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    const el = $('#resetCd');
    if (el) el.textContent = `${h}:${m}:${sec}`;
  };
  tick();
  setInterval(tick, 1000);
}

function renderMeta(data) {
  const total = data.taskGroups.reduce((n, g) => n + g.models.length, 0);
  let txt = `共 ${total} 个模型 · 名单核实于 ${esc(data.verifiedAt)}`;
  if (data.runtime && data.runtime.deprecationsCheckedAt) {
    txt += ` · 下架信息同步于 ${esc(String(data.runtime.deprecationsCheckedAt).slice(0, 10))}`;
  }
  if (data.runtime && data.runtime.helpArticleStatus && data.runtime.helpArticleStatus !== 'reachable') {
    txt += ' · <span class="warn">官方帮助原文暂不可机读，名单以核实日数据为准</span>';
  }
  $('#metaLine').innerHTML = txt;
}

/* ---------- render: groups ---------- */
function modelMatches(m) {
  const st = statusOf(m);
  if (state.filter === 'latest' && !m.isLatest) return false;
  if (state.filter === 'upcoming' && st !== 'upcoming') return false;
  if (state.filter === 'gone' && st !== 'gone') return false;
  if (state.query && !m.name.toLowerCase().includes(state.query)) return false;
  return true;
}

function tagsHtml(m, poolLabel) {
  const tags = [`<span class="tag pool">${esc(poolLabel)}</span>`];
  if (m.isLatest) tags.push('<span class="tag latest">新锐</span>');
  const st = statusOf(m);
  if (st === 'gone') {
    tags.push(`<span class="tag gone">已关停 · ${esc(m.shutdownDate)}</span>`);
  } else if (st === 'upcoming') {
    tags.push(`<span class="tag upcoming">落幕 · ${esc(m.shutdownDate)} 关停（剩 ${daysLeft(m)} 天）</span>`);
  }
  if (m.replacement) {
    tags.push(`<span class="tag repl">官方接班 → ${esc(m.replacement)}</span>`);
  }
  return tags.join('');
}

function renderGroups(data) {
  const poolLabel = Object.fromEntries(data.pools.map((p) => [p.key, p.label]));
  let anyVisible = false;
  $('#groups').innerHTML = data.taskGroups.map((g) => {
    const visible = g.models.filter(modelMatches);
    if (visible.length === 0) return '';
    anyVisible = true;
    const rows = visible.map((m) => `
      <div class="row">
        <div class="row-main">
          <div class="mname">${esc(m.name)}</div>
          ${m.note ? `<div class="mnote">${esc(m.note)}</div>` : ''}
          <div class="tags">${tagsHtml(m, poolLabel[m.pool])}</div>
        </div>
        <button class="copy-btn" type="button" data-copy="${esc(m.name)}">复制</button>
      </div>`).join('');
    return `
      <section class="group">
        <div class="group-head">
          <h2>${esc(g.title)}</h2>
          <span class="blurb">${esc(g.blurb)} · ${visible.length} 个</span>
          <button class="group-copy" type="button" data-group-copy="${esc(g.key)}">复制整组</button>
        </div>
        ${rows}
      </section>`;
  }).join('');
  $('#emptyState').hidden = anyVisible;

  document.querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', () => copyText(b.dataset.copy, b)));
  document.querySelectorAll('[data-group-copy]').forEach((b) =>
    b.addEventListener('click', () => {
      const g = data.taskGroups.find((x) => x.key === b.dataset.groupCopy);
      const names = g.models.filter(modelMatches).map((m) => m.name).join('\n');
      if (names) copyText(names, b);
    }));
}

/* ---------- render: migration table (guide) ---------- */
function renderMigration(data) {
  const rows = [];
  for (const g of data.taskGroups) {
    for (const m of g.models) if (m.shutdownDate) rows.push(m);
  }
  rows.sort((a, b) => a.shutdownDate.localeCompare(b.shutdownDate));
  $('#migrationBody').innerHTML = rows.map((m) => {
    const st = statusOf(m);
    return `<tr>
      <td>${esc(m.name)}</td>
      <td>${esc(m.shutdownDate)}</td>
      <td>${st === 'gone' ? '已关停' : `剩 ${daysLeft(m)} 天`}</td>
      <td>${esc(m.replacement || '—')}</td>
    </tr>`;
  }).join('');
}

/* ---------- views / tabs ---------- */
function setView(view) {
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('is-active', t.dataset.view === view));
  $('#view-lookup').hidden = view !== 'lookup';
  $('#view-guide').hidden = view !== 'guide';
  history.replaceState(null, '', view === 'guide' ? '#guide' : '#lookup');
}

/* ---------- boot ---------- */
async function loadData() {
  try {
    const r = await fetch('/api/models');
    if (!r.ok) throw new Error('api');
    return await r.json();
  } catch {
    const r = await fetch('./models.json');
    if (!r.ok) throw new Error('seed');
    return await r.json();
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => setView(t.dataset.view)));
  if (location.hash === '#guide') setView('guide');

  $('#searchInput').addEventListener('input', (e) => {
    state.query = e.target.value.trim().toLowerCase();
    if (state.data) renderGroups(state.data);
  });
  document.querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach((x) => x.classList.remove('is-active'));
      c.classList.add('is-active');
      state.filter = c.dataset.filter;
      if (state.data) renderGroups(state.data);
    }));

  try {
    state.data = await loadData();
    renderQuota(state.data);
    renderMeta(state.data);
    renderGroups(state.data);
    renderMigration(state.data);
  } catch {
    $('#metaLine').textContent = '数据加载失败，请刷新页面重试。';
  }
});
