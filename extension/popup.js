import * as db from './lib/db.js';
import { $, esc, bg, api, tagHtml, ago, toast, statusLine } from './lib/ui.js';
import { openSealed } from './lib/crypto.js';

let filter = 'all';
let clips = [];
let answer = null; // { text, ids }

function matches(c, q) {
  if (filter === 'secret' && !c.sensitive) return false;
  if (filter === 'pinned' && !c.pinned) return false;
  if (!['all', 'secret', 'pinned'].includes(filter) && c.kind !== filter) return false;
  if (!q) return true;
  const hay = `${c.sensitive ? '' : c.text || ''} ${c.title || ''} ${c.domain || ''} ${(c.tags || []).join(' ')}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every(w => hay.includes(w));
}

function row(c) {
  const where = c.domain || (c.source === 'system' ? 'outside browser' : '');
  const login = (c.tags || []).find(t => t.startsWith('login:'));
  const uses = (c.uses || []).length ? ` · pasted ${c.uses.length}x` : '';
  return `<div class="clip" data-id="${c.id}">
    ${tagHtml(c)}
    <div class="body">
      <div class="txt ${c.sensitive ? 'secret' : ''}" data-val>${esc(c.sensitive ? c.preview : (c.text || '').slice(0, 300))}</div>
      <div class="meta">${esc(login ? 'login for ' + login.slice(6) : where)} · ${ago(c.ts)}${c.copy_count > 1 ? ` · ×${c.copy_count}` : ''}${uses}${c.pinned ? ' · pinned' : ''}</div>
    </div>
    <div class="acts">
      ${c.sensitive ? '<button class="ghost" data-a="show" title="Show for 10 s">Show</button>' : ''}
      <button class="ghost" data-a="pin" title="Pin">${c.pinned ? 'Unpin' : 'Pin'}</button>
      ${c.sensitive ? '' : '<button class="ghost" data-a="vault" title="Treat as a secret">Seal</button>'}
    </div>
  </div>`;
}

async function renderLoops() {
  $('#list').innerHTML = '<div class="empty">Loading...</div>';
  try {
    const { loops } = await api('/api/loops');
    $('#list').innerHTML = loops.length ? loops.map(l => `<label class="loop ${l.done ? 'done' : ''}" data-key="${esc(l.key)}">
        <input type="checkbox" ${l.done ? 'checked' : ''}>
        <div><div class="t">${esc(l.text)}</div><div class="meta faint" style="font-size:11px">${esc(l.session || '')} · ${ago(l.ts)}</div></div></label>`).join('')
      : '<div class="empty">Nothing unfinished. Loops appear after the AI reads your sessions.</div>';
  } catch (e) { $('#list').innerHTML = `<div class="empty">ARM unreachable. ${esc(e.message)}</div>`; }
}

async function render() {
  if (filter === 'loops') return renderLoops();
  const q = $('#q').value.trim();
  let shown = clips.filter(c => matches(c, answer ? '' : q));
  let head = '';
  if (answer) {
    const ids = new Set(answer.ids);
    shown = [...clips.filter(c => ids.has(c.id)), ...shown.filter(c => !ids.has(c.id)).slice(0, 20)];
    head = `<div class="answer"><div class="lbl">YOUR CLIPBOARD SAYS</div>${esc(answer.text)}</div>`;
  }
  shown = shown.slice(0, 150);
  $('#list').innerHTML = head + (shown.length ? shown.map(row).join('')
    : `<div class="empty">${clips.length ? 'No match. Press Enter to ask the AI.' : 'Copy anything, anywhere. It lands here.'}</div>`);
}

async function load() {
  clips = await db.recent(2000);
  render();
  const { status, settings } = await chrome.storage.local.get(['status', 'settings']);
  const s = statusLine(status, settings);
  $('#dot').className = `dot ${s.cls}`;
  $('#statusText').textContent = s.text;
  $('#pause').textContent = settings?.pausedUntil > Date.now() ? 'Resume' : 'Pause';
}

async function mergeRemote(remote) {
  const have = new Set(clips.map(c => c.id));
  clips = [...clips, ...remote.filter(c => !have.has(c.id))].sort((a, b) => b.ts - a.ts);
}

async function ask(question) {
  $('#list').innerHTML = '<div class="answer"><div class="lbl">THINKING</div>Reading your clipboard history...</div>';
  try {
    const r = await api('/api/ask', { method: 'POST', body: JSON.stringify({ question }) });
    if (r.clip_ids.length) await mergeRemote((await api(`/api/clips?ids=${r.clip_ids.join(',')}&limit=50`)).clips);
    answer = { text: r.answer, ids: r.clip_ids };
  } catch (e) { answer = { text: 'ARM unreachable, so I can only filter what is on this laptop. ' + e.message, ids: [] }; }
  render();
}

$('#q').addEventListener('input', () => { answer = null; render(); });
$('#q').addEventListener('keydown', e => { if (e.key === 'Enter' && $('#q').value.trim()) ask($('#q').value.trim()); });
$('#chips').addEventListener('click', e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  filter = b.dataset.f;
  document.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b));
  render();
});

$('#list').addEventListener('change', async e => {
  const l = e.target.closest('.loop');
  if (!l) return;
  l.classList.toggle('done', e.target.checked);
  await api('/api/loops/done', { method: 'POST', body: JSON.stringify({ key: l.dataset.key, done: e.target.checked }) }).catch(() => toast('ARM unreachable'));
  bg('badge');
});

$('#list').addEventListener('click', async e => {
  const el = e.target.closest('.clip');
  if (!el) return;
  const c = clips.find(x => x.id === el.dataset.id);
  const act = e.target.dataset.a;
  if (act === 'pin') {
    const local = await db.getClip(c.id);
    if (local) { local.pinned = !local.pinned; local.synced = false; await db.putClip(local); }
    return load();
  }
  if (act === 'vault') {
    await bg('make-secret', { id: c.id });
    toast('Marked as secret');
    return load();
  }
  if (act === 'show') {
    const v = el.querySelector('[data-val]');
    v.textContent = await openSealed(c.sealed);
    setTimeout(() => { v.textContent = c.preview; }, 10000);
    return;
  }
  const text = c.sensitive ? await openSealed(c.sealed) : (c.text || '');
  await navigator.clipboard.writeText(text);
  toast(c.sensitive ? 'Password copied' : 'Copied');
});

$('#pause').addEventListener('click', async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await bg('pause', { minutes: settings?.pausedUntil > Date.now() ? 0 : 60 });
  toast(settings?.pausedUntil > Date.now() ? 'Capture resumed' : 'Paused for 1 hour');
  load();
});
$('#open').addEventListener('click', () => chrome.tabs.create({ url: 'dashboard.html' }));

load();
