import * as db from './lib/db.js';
import { classify, domainOf, mask } from './lib/classify.js';
import { hmac, seal, openSealed, deviceKeys, getBackup } from './lib/crypto.js';

const MAX_CHARS = 100_000;
const CONTEXT_WINDOW_MS = 4000;     // page copy event <-> clipboard poll pairing
const RECOPY_WINDOW_MS = 24 * 3600_000;
const SYNC_HOLD_MS = 60_000;        // let a late "pasted into password field" signal land before upload
const DEFAULTS = { server: 'http://127.0.0.1:8790', token: '', ignoreDomains: [], localDays: 30, pausedUntil: 0, recall: true };

const settings = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get('settings')).settings });
const saveSettings = async patch => chrome.storage.local.set({ settings: { ...(await settings()), ...patch } });
const setStatus = patch => chrome.storage.local.get('status').then(({ status }) =>
  chrome.storage.local.set({ status: { ...status, ...patch } }));

// ---------- offscreen clipboard reader ----------
async function ensureOffscreen() {
  const has = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (has.length) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['CLIPBOARD'],
      justification: 'Read the system clipboard to keep a personal clipboard history.',
    });
  } catch (e) {
    if (!String(e).includes('single offscreen')) console.warn('offscreen', e);
  }
}

// ---------- capture ----------
let pendingContext = null; // { url, title, domain, ts, h } from the last in-page copy

function attachContext(clip, ctx) {
  clip.url = ctx.url; clip.title = ctx.title; clip.domain = ctx.domain; clip.source = 'page';
}

// A page copy only belongs to a clip if the selected text matches (or the page gave no selection,
// e.g. a "copy" button). This stops a page's URL landing on an unrelated clip from another app.
const ctxMatches = (ctx, h) => ctx && Date.now() - ctx.ts < CONTEXT_WINDOW_MS && (!ctx.h || ctx.h === h);

async function onClip(rawText) {
  const s = await settings();
  if (s.pausedUntil > Date.now()) return;
  const text = rawText.length > MAX_CHARS ? rawText.slice(0, MAX_CHARS) : rawText;
  if (!text.trim()) return;
  const now = Date.now();
  const h = await hmac(text);
  const ctx = ctxMatches(pendingContext, h) ? pendingContext : null;
  if (ctx) pendingContext = null;
  if (ctx && s.ignoreDomains.includes(ctx.domain)) return;

  const same = await db.byHmac(h);
  const knownSecret = same.find(c => c.sensitive);
  const latest = same[0];
  if (latest && now - latest.last_seen < RECOPY_WINDOW_MS) {
    latest.last_seen = now;
    latest.copy_count = (latest.copy_count || 1) + 1;
    if (ctx && !latest.url) attachContext(latest, ctx);
    latest.synced = false;
    await db.putClip(latest);
    return;
  }

  const prev = await db.recent(5);
  const cls = knownSecret ? { kind: knownSecret.kind, sensitive: true } : classify(text, prev);
  const clip = {
    id: crypto.randomUUID(), ts: now, last_seen: now, copy_count: 1,
    kind: cls.kind, sensitive: cls.sensitive, length: text.length, hmac: h,
    url: null, title: null, domain: null, source: 'system', pinned: false, uses: [], tags: [], synced: false,
  };
  if (ctx) attachContext(clip, ctx);
  if (cls.sensitive) await makeSecret(clip, text);
  else { clip.text = text; clip.preview = text.slice(0, 200); }
  await db.putClip(clip);
}

async function makeSecret(clip, text) {
  clip.sensitive = true;
  clip.preview = mask(text.length);
  clip.sealed = await seal(text);
  clip.text = null;
}

async function onCopyContext(msg, sender) {
  const url = sender.url || sender.tab?.url || msg.url;
  const ctx = { url, title: sender.tab?.title || msg.title, domain: domainOf(url), ts: Date.now(),
    h: msg.selection ? await hmac(msg.selection.slice(0, MAX_CHARS)) : null };
  // The poll may already have stored this copy: attach to it instead of waiting.
  const [last] = await db.recent(1);
  if (last && !last.url && Date.now() - last.ts < CONTEXT_WINDOW_MS && ctx.h && last.hmac === ctx.h) {
    const s = await settings();
    if (s.ignoreDomains.includes(ctx.domain)) return db.deleteClip(last.id);
    attachContext(last, ctx);
    last.synced = false;
    return db.putClip(last);
  }
  pendingContext = ctx;
}

async function onPaste(msg, sender) {
  if (!msg.text) return;
  const domain = domainOf(sender.url || sender.tab?.url || msg.url);
  const [clip] = await db.byHmac(await hmac(msg.text.slice(0, MAX_CHARS)));
  if (!clip) return;
  clip.uses = [...(clip.uses || []), { domain, ts: Date.now(), field: msg.field }].slice(-20);
  if (msg.field === 'password') {
    // Retroactive: it went into a password box, so it is a password for this site.
    if (!clip.sensitive) { clip.kind = 'password'; await makeSecret(clip, msg.text); }
    clip.tags = [...new Set([...(clip.tags || []), `login:${domain}`])];
  } else if (msg.field === 'username') {
    clip.tags = [...new Set([...(clip.tags || []), `user:${domain}`])];
  }
  clip.synced = false;
  await db.putClip(clip);
}

// ---------- Login Recall: offer the email + password you used on this exact site before ----------
async function findLogin(domain) {
  if (!domain) return null;
  const rows = await db.recent(5000);
  const pass = rows.find(c => c.sensitive && (c.tags || []).includes(`login:${domain}`));
  const user = rows.find(c => !c.sensitive && ((c.tags || []).includes(`user:${domain}`) ||
    (c.kind === 'email' && (c.uses || []).some(u => u.domain === domain))));
  return pass || user ? { pass, user } : null;
}

async function onRecall(sender, fill) {
  if (!(await settings()).recall) return null;
  const domain = domainOf(sender.url); // frame's own origin, never what the page claims
  const login = await findLogin(domain);
  if (!login) return null;
  if (!fill) return { domain, user: login.user?.text || null, hasPassword: !!login.pass };
  return { user: login.user?.text || null, password: login.pass ? await openSealed(login.pass.sealed) : null };
}

// ---------- sync to ARM ----------
const SERVER_FIELDS = ['id', 'ts', 'last_seen', 'copy_count', 'kind', 'sensitive', 'text', 'sealed', 'preview',
  'length', 'hmac', 'url', 'title', 'domain', 'source', 'pinned', 'tags', 'uses', 'deleted'];

async function api(path, opts = {}) {
  const s = await settings();
  if (!s.token) throw new Error('No server token set');
  const res = await fetch(s.server + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}`, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

let syncing = false;
async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    const now = Date.now();
    const all = await db.unsynced();
    const ready = all.filter(c => now - c.last_seen > SYNC_HOLD_MS && !(c.sensitive && !c.sealed));
    for (let i = 0; i < ready.length; i += 200) {
      const batch = ready.slice(i, i + 200);
      await api('/api/clips', { method: 'POST', body: JSON.stringify({ clips: batch.map(c => Object.fromEntries(SERVER_FIELDS.map(f => [f, c[f] ?? null]))) }) });
      for (const c of batch) { c.synced = true; await db.putClip(c); }
    }
    const backup = await getBackup();
    const { vaultUploaded } = await chrome.storage.local.get('vaultUploaded');
    if (backup && vaultUploaded !== backup.created) {
      await api('/api/vault', { method: 'POST', body: JSON.stringify({ vault: backup }) });
      await chrome.storage.local.set({ vaultUploaded: backup.created });
    }
    await setStatus({ online: true, lastSync: Date.now(), queued: all.length - ready.length, error: null });
    await refreshBadge();
  } catch (e) {
    const queued = (await db.unsynced()).length;
    await setStatus({ online: false, queued, error: String(e.message || e).slice(0, 160), lastTry: Date.now() });
  } finally {
    syncing = false;
  }
}

async function refreshBadge() {
  try {
    const { loops } = await api('/api/loops');
    const open = loops.filter(l => !l.done).length;
    await chrome.action.setBadgeBackgroundColor({ color: '#f0b65a' });
    await chrome.action.setBadgeText({ text: open ? String(open) : '' });
  } catch { /* offline: keep the last badge */ }
}

async function prune() {
  const s = await settings();
  const cutoff = Date.now() - s.localDays * 86400_000;
  for (const c of await db.range(0, cutoff)) {
    if (c.synced && !c.pinned) await db.deleteClip(c.id);
  }
}

// ---------- wiring ----------
// Popup, dashboard and offscreen page; content scripts report the web page's URL instead.
const isExtensionPage = sender => sender.id === chrome.runtime.id && (sender.url || '').startsWith(chrome.runtime.getURL(''));

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handlers = {
    clip: () => onClip(msg.text),
    'copy-context': () => onCopyContext(msg, sender),
    paste: () => onPaste(msg, sender),
    recall: () => onRecall(sender, false),
    'recall-fill': () => onRecall(sender, true),
    // Everything below is only for the popup and dashboard, never for web pages.
    'sync-now': () => isExtensionPage(sender) && sync().then(() => chrome.storage.local.get('status')),
    'make-secret': async () => {
      if (!isExtensionPage(sender)) return false;
      const c = await db.getClip(msg.id);
      if (!c || c.sensitive) return false;
      const text = c.text; c.kind = 'password'; await makeSecret(c, text); c.synced = false; await db.putClip(c); return true;
    },
    pause: () => isExtensionPage(sender) && saveSettings({ pausedUntil: msg.minutes ? Date.now() + msg.minutes * 60_000 : 0 }),
    api: () => { if (!isExtensionPage(sender)) throw new Error('forbidden'); return api(msg.path, msg.opts); },
    badge: () => isExtensionPage(sender) && refreshBadge(),
  };
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve().then(h).then(r => reply({ ok: true, result: r }), e => reply({ ok: false, error: String(e.message || e) }));
  return true;
});

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'tick') { ensureOffscreen(); sync(); }
  if (a.name === 'prune') prune();
});

async function boot() {
  await ensureOffscreen();
  await deviceKeys();
  chrome.alarms.create('tick', { periodInMinutes: 1 });
  chrome.alarms.create('prune', { periodInMinutes: 24 * 60 });
}
chrome.runtime.onStartup.addListener(boot);
chrome.runtime.onInstalled.addListener(d => {
  boot();
  if (d.reason === 'install') chrome.tabs.create({ url: 'dashboard.html#settings' });
});
boot();
