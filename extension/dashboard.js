import * as db from './lib/db.js';
import { $, esc, bg, api, tagHtml, ago, clock, toast, statusLine, md, detailHtml } from './lib/ui.js';
import { getBackup, createBackup, restoreBackup, openSealed } from './lib/crypto.js';

const CHAIN_COLORS = ['#7cc4ff', '#6fd39a', '#f0b65a', '#b9a6ff', '#ff9fb2', '#5fd6d0'];
let focusId = null;

// ---------- routing ----------
const TABS = ['stories', 'timeline', 'vault', 'settings'];
function route() {
  const [tab, arg] = (location.hash.slice(1) || 'stories').split(':');
  const t = TABS.includes(tab) ? tab : 'stories';
  focusId = arg || null;
  for (const id of TABS) $('#' + id).hidden = id !== t;
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.hash === '#' + t));
  ({ stories: loadStories, timeline: loadTimeline, vault: loadVault, settings: loadSettings })[t]();
}
window.addEventListener('hashchange', route);

async function header() {
  const { status, settings } = await chrome.storage.local.get(['status', 'settings']);
  const s = statusLine(status, settings);
  $('#dot').className = `dot ${s.cls}`;
  $('#statusText').textContent = s.text;
}

// Server first, local cache as fallback.
async function allClips(sinceMs) {
  const local = await db.range(sinceMs);
  let remote = [];
  try { remote = (await api(`/api/clips?since=${sinceMs}&limit=5000`)).clips; } catch { /* offline */ }
  const byId = new Map(remote.map(c => [c.id, c]));
  for (const c of local) byId.set(c.id, { ...byId.get(c.id), ...c });
  return [...byId.values()].filter(c => !c.deleted).sort((a, b) => a.ts - b.ts);
}

// ---------- stories ----------
async function loadStories() {
  header();
  const local = await db.recent(100000);
  let st = null, reports = [];
  try { [st, { reports }] = await Promise.all([api('/api/stats'), api('/api/reports')]); } catch { /* offline */ }
  const secrets = local.filter(c => c.sensitive).length;
  $('#stats').innerHTML = [
    [st?.clips ?? local.length, st ? 'clips on ARM' : 'clips on laptop'],
    [st?.secrets ?? secrets, 'sealed secrets'],
    [st?.stories ?? 0, 'stories found'],
    [st?.reports ?? 0, 'reports'],
  ].map(([n, l]) => `<div><b>${n}</b><span>${l}</span></div>`).join('');
  for (const [p, j] of Object.entries(st?.jobs || {})) if (j.state === 'running') pollJob(p);

  $('#reports').innerHTML = reports.length ? reports.map(r => `<a href="#stories:${r.id}" data-id="${r.id}">
      ${esc(r.data?.headline || r.period + ' report')}
      <small>${r.period.toUpperCase()} · ${new Date(r.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</small></a>`).join('')
    : `<div class="empty">${st ? 'No reports yet.' : 'ARM offline. Reports live on the server.'}</div>`;
  const pick = focusId || reports[0]?.id;
  if (pick) showReport(pick);
}

async function showReport(id) {
  document.querySelectorAll('#reports a').forEach(a => a.classList.toggle('on', a.dataset.id === id));
  try {
    const { report } = await api(`/api/reports/${id}`);
    const reuse = report.data?.stats?.password_reuse || [];
    $('#report').innerHTML = md(report.markdown) +
      (reuse.length ? `<h2>Detected without decrypting</h2><p class="warn">Same password used on: ${reuse.map(g => esc(g.join(', '))).join(' | ')}</p>` : '') +
      `<p class="faint mono" style="margin-top:28px;font-size:11px">${esc(report.model)} · ${report.data?.session_ids?.length || 0} sessions analysed</p>`;
  } catch (e) { $('#report').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

document.addEventListener('click', async e => {
  const run = e.target.closest('[data-run]');
  if (!run) return;
  const period = run.dataset.run;
  try { await bg('sync-now'); await api('/api/stories/run', { method: 'POST', body: JSON.stringify({ period }) }); pollJob(period); }
  catch (err) { toast(err.message.startsWith('409') ? 'Already writing that one' : 'Could not start: ' + err.message); }
});

const polling = new Set();
function pollJob(period) {
  if (polling.has(period)) return;
  polling.add(period);
  const btn = document.querySelector(`[data-run="${period}"]`);
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Reading your week...';
  const h = setInterval(async () => {
    try {
      const j = (await api('/api/stats')).jobs?.[period];
      if (j?.state === 'running') return;
      clearInterval(h); polling.delete(period); btn.disabled = false; btn.textContent = label;
      if (j?.state === 'done') { toast(j.report_id ? 'Report ready' : 'No clips in that period'); focusId = j.report_id; loadStories(); }
      else toast('Report failed: ' + (j?.error || 'unknown'));
    } catch { /* keep polling */ }
  }, 3000);
}

$('#askForm').addEventListener('submit', async e => {
  e.preventDefault();
  const question = $('#askQ').value.trim();
  if (!question) return;
  $('#askOut').hidden = false;
  $('#askOut').innerHTML = '<span class="muted">Reading your clipboard history...</span>';
  try {
    const r = await api('/api/ask', { method: 'POST', body: JSON.stringify({ question }) });
    const found = r.clip_ids.length ? (await api(`/api/clips?ids=${r.clip_ids.join(',')}&limit=50`)).clips : [];
    $('#askOut').innerHTML = `<p style="margin:0 0 8px">${esc(r.answer)}</p>` + found.map(c => `<div class="clip" data-ask="${c.id}">${tagHtml(c)}
      <div class="body"><div class="txt ${c.sensitive ? 'secret' : ''}">${esc(c.sensitive ? c.preview : (c.text || '').slice(0, 300))}</div>
      <div class="meta">${esc(c.domain || 'outside browser')} · ${ago(c.ts)} · click to copy</div></div><span></span></div>`).join('');
    $('#askOut').onclick = async ev => {
      const el = ev.target.closest('[data-ask]');
      if (!el) return;
      const c = found.find(x => x.id === el.dataset.ask);
      try { await navigator.clipboard.writeText(c.sensitive ? await openSealed(c.sealed) : c.text); toast('Copied'); }
      catch { toast('Sealed by another browser'); }
    };
  } catch (err) { $('#askOut').innerHTML = `<span class="warn">${esc(err.message)}</span>`; }
});

// ---------- timeline ----------
async function loadTimeline() {
  header();
  const since = Date.now() - 14 * 86400_000;
  const clips = await allClips(since);
  let sessions = [];
  try { sessions = (await api(`/api/sessions?since=${since}&limit=500`)).sessions; } catch { /* offline */ }
  const sessById = new Map(sessions.map(s => [s.id, s]));
  const clipSession = new Map();
  for (const s of sessions) for (const id of s.clip_ids || []) clipSession.set(id, s.id);

  // Group: AI session if known, else a local 10-minute-gap session.
  const groups = [];
  let cur = null;
  for (const c of clips) {
    const sid = clipSession.get(c.id) || c.session_id;
    if (cur && ((sid && cur.sid === sid) || (!sid && !cur.sid && c.ts - cur.end < 10 * 60_000))) {
      cur.clips.push(c); cur.end = c.ts;
    } else {
      cur = { sid: sid || null, clips: [c], start: c.ts, end: c.ts };
      groups.push(cur);
    }
  }
  if (!groups.length) { $('#sessions').innerHTML = '<div class="empty">Nothing in the last 14 days yet.</div>'; return; }

  let lastDay = '';
  $('#sessions').innerHTML = groups.reverse().map(g => {
    const s = g.sid ? sessById.get(g.sid) : null;
    const color = new Map();
    (s?.chains || []).forEach((ch, i) => ch.clip_ids.forEach(id => color.set(id, CHAIN_COLORS[i % CHAIN_COLORS.length])));
    const day = new Date(g.start).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    const dayHtml = day !== lastDay ? `<div class="day">${day}</div>` : '';
    lastDay = day;
    return `${dayHtml}<div class="card session">
      <div class="head">
        <div class="title">${esc(s?.title || 'Not analysed yet')}
          ${s?.category ? `<span class="tag">${esc(s.category.toUpperCase())}</span>` : ''}
          ${s?.importance ? `<span class="imp">${'■'.repeat(s.importance)}${'□'.repeat(5 - s.importance)}</span>` : ''}
          <span class="faint mono" style="font-size:11px;font-weight:400">${clock(g.start)}–${clock(g.end)} · ${g.clips.length} copies</span>
          ${g.clips.some(c => c.kind === 'url' || c.url) ? `<button class="ghost" data-reopen="${esc(JSON.stringify([...new Set(g.clips.map(c => c.kind === 'url' ? c.text : c.url).filter(Boolean))]))}" style="margin-left:auto">Reopen links</button>` : ''}</div>
        ${s?.story ? `<div class="story">${esc(s.story)}</div>` : '<div class="note">Runs with the next report, or press "Today" on the Stories tab.</div>'}
        ${s?.open_loops?.length ? `<ul class="loops">${s.open_loops.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      </div>
      ${g.clips.map(c => `<div class="clip" data-id="${c.id}">
        <span class="chainbar" style="background:${color.get(c.id) || 'transparent'}"></span>
        ${tagHtml(c)}<span class="mono faint" style="font-size:11px">${clock(c.ts)}</span>
        <div class="body"><div class="txt ${c.sensitive ? 'secret' : ''}">${esc(c.sensitive ? c.preview : (c.text || '').slice(0, 400))}</div>
        <div class="meta">${esc(c.domain || 'outside browser')}${c.title ? ' · ' + esc(c.title.slice(0, 80)) : ''}${(c.uses || []).length ? ' · pasted on ' + esc([...new Set(c.uses.map(u => u.domain))].join(', ')) : ''}</div></div>
        <button class="ghost" data-more>More</button>
      </div>`).join('')}
    </div>`;
  }).join('');
}

$('#sessions').addEventListener('click', async e => {
  const re = e.target.closest('[data-reopen]');
  if (re) { for (const u of JSON.parse(re.dataset.reopen).slice(0, 12)) chrome.tabs.create({ url: /^https?:/.test(u) ? u : 'https://' + u, active: false }); return toast('Story reopened'); }
  const open = e.target.closest('[data-open]');
  if (open) return chrome.tabs.create({ url: open.dataset.open });
  const all = await allClips(0);
  const d = e.target.closest('[data-d]');
  if (d) {
    const c = all.find(x => x.id === d.closest('.detail').dataset.for);
    if (d.dataset.d === 'copy') { await navigator.clipboard.writeText(c.sensitive ? await openSealed(c.sealed) : (c.text || '')); return toast('Copied'); }
    if (d.dataset.d === 'pin') { const l = await db.getClip(c.id); if (l) { l.pinned = !l.pinned; l.synced = false; await db.putClip(l); } return toast(l?.pinned ? 'Pinned' : 'Unpinned'); }
    if (d.dataset.d === 'seal') { await bg('make-secret', { id: c.id }); toast('Marked as secret'); return loadTimeline(); }
    if (d.dataset.d === 'delete') {
      if (!d.dataset.armed) { d.dataset.armed = '1'; d.textContent = 'Click again to delete'; return; }
      await bg('delete-clip', { id: c.id, clip: c }); toast('Deleted'); return loadTimeline();
    }
    return;
  }
  if (e.target.closest('.detail')) return;
  // Clicking a row (or More) opens where it came from; Copy lives in the panel.
  const el = e.target.closest('.clip');
  if (!el) return;
  const c = all.find(x => x.id === el.dataset.id);
  const wasOpen = el.nextElementSibling?.classList.contains('detail');
  document.querySelectorAll('#sessions .detail').forEach(x => x.remove());
  if (!wasOpen && c) {
    const related = c.url ? all.filter(x => x.url === c.url && x.id !== c.id).slice(-5) : [];
    el.insertAdjacentHTML('afterend', `<div class="detail" data-for="${c.id}">${detailHtml(c, related)}</div>`);
    el.nextElementSibling.querySelectorAll('img').forEach(i => i.addEventListener('error', () => i.remove()));
  }
});

// ---------- vault ----------
async function loadVault() {
  header();
  const backup = await getBackup();
  let remote = null;
  if (!backup) { try { remote = (await api('/api/vault')).vault; } catch { /* offline */ } }
  const secrets = (await allClips(0)).filter(c => c.sensitive).reverse();
  $('#vaultBody').innerHTML = `<div class="card">
    <div style="padding:12px 16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><b>${secrets.length} secrets</b>
      <span class="note">Click Copy to use one. Login Recall also offers them on the site where you used them.</span>
      <input id="vq" placeholder="Filter by site..." style="max-width:240px;margin-left:auto"></div>
    ${secrets.map(c => `<div class="vrow ${c.id === focusId ? 'hl' : ''}" data-id="${c.id}" data-hay="${esc((c.domain || '') + ' ' + (c.title || '') + ' ' + (c.tags || []).join(' '))}">
      ${tagHtml(c)}
      <div><div class="val" data-val>${esc(c.preview)}</div>
        <div class="meta faint" style="font-size:11px">${esc(c.domain || 'outside browser')} · ${ago(c.ts)}${(c.tags || []).filter(t => t.startsWith('login:')).map(t => ' · login for ' + esc(t.slice(6))).join('')}</div></div>
      <div style="display:flex;gap:6px"><button data-v="show">Show</button><button data-v="copy" class="primary">Copy</button></div>
    </div>`).join('') || '<div class="empty">No secrets yet. Passwords, API keys and card numbers you copy land here.</div>'}</div>
  <div class="card form" style="margin-top:16px">
    <b>Backup passphrase (optional)</b>
    ${backup ? `<div class="note">Backup set ${new Date(backup.created).toLocaleDateString()}. It is stored on ARM, wrapped by your passphrase, so you can restore your secrets in a new browser.</div>`
      : remote ? `<div class="note warn">A backup from another browser exists on ARM. Restore it to open secrets copied there.</div>
        <label>Backup passphrase <input type="password" id="rp"></label><div><button class="primary" id="restore">Restore</button></div>`
      : `<div class="note">Without a backup, your secrets can only be opened in this browser profile. Set a passphrase to be able to restore them elsewhere. There is no reset if you forget it.</div>
        <label>Passphrase <input type="password" id="p1" autocomplete="new-password"></label>
        <label>Repeat <input type="password" id="p2" autocomplete="new-password"></label>
        <div><button class="primary" id="create">Save backup</button></div>`}
  </div>`;
  $('#vq').oninput = e => document.querySelectorAll('.vrow').forEach(r =>
    r.hidden = !r.dataset.hay.toLowerCase().includes(e.target.value.toLowerCase()));
  if ($('#create')) $('#create').onclick = async () => {
    if ($('#p1').value !== $('#p2').value) return toast('Passphrases differ');
    try { await createBackup($('#p1').value); bg('sync-now'); toast('Backup saved'); loadVault(); } catch (e) { toast(e.message); }
  };
  if ($('#restore')) $('#restore').onclick = async () => {
    try { await restoreBackup(remote, $('#rp').value); toast('Restored'); loadVault(); } catch (e) { toast(e.message); }
  };
  document.querySelector('.vrow.hl')?.scrollIntoView({ block: 'center' });
}

$('#vaultBody').addEventListener('click', async e => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  const rowEl = b.closest('.vrow');
  const c = (await allClips(0)).find(x => x.id === rowEl.dataset.id);
  let text;
  try { text = await openSealed(c.sealed); } catch { return toast('Sealed by another browser. Restore its backup first.'); }
  if (b.dataset.v === 'show') { rowEl.querySelector('[data-val]').textContent = text; setTimeout(() => rowEl.querySelector('[data-val]').textContent = c.preview, 15000); }
  else { await navigator.clipboard.writeText(text); toast('Copied'); }
});

// ---------- settings ----------
async function loadSettings() {
  header();
  const { settings = {} } = await chrome.storage.local.get('settings');
  $('#server').value = settings.server || 'http://127.0.0.1:8790';
  $('#token').value = settings.token || '';
  $('#ignore').value = (settings.ignoreDomains || []).join('\n');
  $('#localDays').value = settings.localDays || 30;
}
async function patchSettings(p) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, ...p } });
}
$('#saveConn').onclick = async () => {
  await patchSettings({ server: $('#server').value.trim().replace(/\/$/, ''), token: $('#token').value.trim() });
  try { const st = await api('/api/stats'); $('#connResult').textContent = `Connected. ${st.clips} clips on ARM.`; bg('sync-now').then(header); }
  catch (e) { $('#connResult').textContent = 'Failed: ' + e.message + ' (is the tunnel running?)'; }
};
$('#saveCap').onclick = async () => {
  await patchSettings({
    ignoreDomains: $('#ignore').value.split('\n').map(s => s.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*/, '')).filter(Boolean),
    localDays: Math.max(1, +$('#localDays').value || 30),
  });
  toast('Saved');
};
$('#importFile').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const r = await bg('import-items', { items: JSON.parse(await f.text()) });
    toast(`Imported ${r.added} clips${r.merged ? `, merged ${r.merged} duplicates` : ''}`);
  } catch (err) { toast('Import failed: ' + err.message); }
  e.target.value = '';
};
document.querySelectorAll('[data-pause]').forEach(b => b.onclick = async () => {
  await bg('pause', { minutes: +b.dataset.pause }); header(); toast(+b.dataset.pause ? `Paused ${b.dataset.pause} min` : 'Resumed');
});

route();
