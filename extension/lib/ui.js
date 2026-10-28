// Shared helpers for popup and dashboard.
export const $ = (s, el = document) => el.querySelector(s);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function bg(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra }).then(r => {
    if (!r) throw new Error('No response from background');
    if (!r.ok) throw new Error(r.error);
    return r.result;
  });
}
export const api = (path, opts) => bg('api', { path, opts });

const TAGS = { url: 'URL', email: 'MAIL', password: 'PASS', api_key: 'KEY', card: 'CARD', otp: 'OTP', phone: 'TEL', code: 'CODE', text: 'TXT' };
export function tagHtml(c) {
  const cls = c.sensitive ? 'secret' : c.kind === 'url' ? 'url' : c.kind === 'code' ? 'code' : c.kind === 'email' ? 'email' : '';
  return `<span class="tag ${cls}">${TAGS[c.kind] || 'TXT'}</span>`;
}

export function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
export const clock = ts => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export function toast(msg) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.append(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 1600);
}

export function statusLine(st, settings) {
  if (settings?.pausedUntil > Date.now()) return { cls: 'warn', text: `Paused until ${clock(settings.pausedUntil)}` };
  if (!settings?.token) return { cls: 'warn', text: 'Local only. Add ARM token in Settings' };
  if (!st) return { cls: '', text: 'Waiting for first sync' };
  if (st.online) return { cls: 'ok', text: `ARM synced ${ago(st.lastSync)}${st.queued ? ` · ${st.queued} held` : ''}` };
  return { cls: 'err', text: `ARM offline · ${st.queued || 0} queued` };
}

// Small, safe markdown: headings, lists, checkboxes, bold, italics, code, links as text.
export function md(src) {
  const inline = s => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, '$1<em>$2</em>');
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(src || '').split('\n')) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { close(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
    else if ((m = line.match(/^\s*[-*]\s+\[( |x)\]\s+(.*)/i))) {
      if (list !== 'ul') { close(); out.push('<ul class="todo">'); list = 'ul'; }
      out.push(`<li><label><input type="checkbox" ${m[1].trim() ? 'checked' : ''}> ${inline(m[2])}</label></li>`);
    }
    else if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!line.trim()) close();
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join('');
}

// ---------- "More" panel: where a clip came from and what happened to it ----------
const mmss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const fullTime = ts => new Date(ts).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function detailHtml(c, related = []) {
  const x = c.context || {};
  const v = x.video || null;
  const open = (label, url, primary) => url ? `<button class="${primary ? 'primary' : ''}" data-open="${esc(url)}">${label}</button>` : '';
  const kv = (k, val) => val ? `<div class="kv"><span>${k}</span><div>${val}</div></div>` : '';
  const sel = c.sensitive ? '' : esc((c.text || '').slice(0, 300)) + ((c.text || '').length > 300 ? '...' : '');
  const snippet = !c.sensitive && (x.before || x.after)
    ? `<div class="snip">${x.before ? '...' + esc(x.before.slice(-180)) : ''}<mark>${sel}</mark>${x.after ? esc(x.after.slice(0, 180)) + '...' : ''}</div>` : '';
  const source = c.url
    ? `<div class="src">${x.favicon ? `<img src="${esc(x.favicon)}" alt="">` : ''}<div><b>${esc(x.site || c.domain)}</b>
        <div class="faint">${esc((c.title || '').slice(0, 140))}</div></div></div>`
    : `<div class="src"><div><b>Outside the browser</b><div class="faint">Copied from another app on this PC</div></div></div>`;
  const pasted = (c.uses || []).map(u => `${esc(u.domain || '?')} <span class="faint">${clock(u.ts)}${u.field && u.field !== 'other' ? ' · ' + u.field + ' field' : ''}</span>`).join('<br>');
  return `${source}
    <div class="btns">${open('Open exact spot', x.fragment, true)}${v ? open(`Open video at ${mmss(v.t)}`, v.url || c.url, !x.fragment) : ''}${open('Open page', c.url, !x.fragment && !v)}</div>
    ${snippet}
    ${kv('Section', esc(x.heading))}
    ${kv('Inside link', x.link ? `${esc(x.link.text || x.link.href)} <span class="faint">${esc(x.link.href.slice(0, 80))}</span>` : '')}
    ${kv('Video', v ? `${esc(v.videoTitle || c.title || '')}${v.channel ? ' · ' + esc(v.channel) : ''} · at ${mmss(v.t)} of ${mmss(v.duration)}` : '')}
    ${kv('On the page', [x.element && `in a &lt;${esc(x.element)}&gt;`, x.scrollPct != null && c.url ? `${x.scrollPct}% down the page` : '', x.frame ? 'inside an embedded frame' : '', x.lang ? `language ${esc(x.lang)}` : ''].filter(Boolean).join(' · '))}
    ${kv('Copied', `${fullTime(c.ts)}${c.copy_count > 1 ? ` · ${c.copy_count} times, last ${clock(c.last_seen)}` : ''}`)}
    ${kv('Pasted on', pasted)}
    ${kv('Type', `${esc(c.kind)} · ${c.length || (c.text || '').length} characters${c.sensitive ? ' · encrypted' : ''}`)}
    ${kv('Page summary', esc(x.description))}
    ${related.length ? kv('Also copied here', related.map(r => `<div class="rel">${esc(r.sensitive ? r.preview : (r.text || '').slice(0, 90))} <span class="faint">${clock(r.ts)}</span></div>`).join('')) : ''}
    <div class="btns">
      <button data-d="copy" class="primary">Copy</button>
      <button data-d="pin">${c.pinned ? 'Unpin' : 'Pin'}</button>
      ${c.sensitive ? '' : '<button data-d="seal">Mark as secret</button>'}
      <button data-d="delete" class="danger">Delete</button>
    </div>`;
}
