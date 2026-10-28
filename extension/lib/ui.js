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
