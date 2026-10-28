// Tells Clip Story which page a copy came from and where a clip got pasted,
// and offers Login Recall on sign-in fields where you pasted a login before.
(() => {
  const send = msg => { try { return chrome.runtime.sendMessage(msg).catch(() => null); } catch { return Promise.resolve(null); } };
  const ctx = () => ({ url: location.href, title: document.title });
  const selection = () => {
    const a = document.activeElement;
    if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'password')) && a.selectionEnd > a.selectionStart)
      return a.value.slice(a.selectionStart, a.selectionEnd);
    return String(getSelection() || '');
  };
  const fieldKind = t => !t || t.tagName !== 'INPUT' ? 'other'
    : t.type === 'password' || /pass/i.test(t.autocomplete || '') ? 'password'
    : t.type === 'email' || /user|email|login|account/i.test((t.name || '') + (t.id || '') + (t.autocomplete || '')) ? 'username'
    : 'other';

  // Exactly where the copy happened: surrounding text, section, link, video moment, jump-back link.
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const fragEnc = s => encodeURIComponent(s).replace(/-/g, '%2D');

  function fragmentUrl(text) {
    const t = clean(text);
    if (!t || t.length > 2000) return null;
    const base = location.href.split('#')[0];
    const words = t.split(' ');
    if (words.length <= 10) return `${base}#:~:text=${fragEnc(t)}`;
    return `${base}#:~:text=${fragEnc(words.slice(0, 5).join(' '))},${fragEnc(words.slice(-5).join(' '))}`;
  }

  function nearestHeading(el) {
    let best = null;
    for (const h of document.querySelectorAll('h1,h2,h3,h4')) {
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING || h.contains(el)) best = h; else break;
    }
    return best ? clean(best.innerText).slice(0, 140) : null;
  }

  function videoMoment() {
    const v = [...document.querySelectorAll('video')].find(x => x.currentTime > 0 && x.duration);
    if (!v) return null;
    const t = Math.floor(v.currentTime);
    const out = { t, duration: Math.floor(v.duration) };
    const id = new URLSearchParams(location.search).get('v');
    if (/youtube\.com$/.test(location.hostname) && id) {
      out.url = `https://www.youtube.com/watch?v=${id}&t=${t}s`;
      out.channel = clean(document.querySelector('ytd-video-owner-renderer #channel-name a, #owner #channel-name a')?.textContent) || null;
      out.videoTitle = clean(document.querySelector('h1.ytd-watch-metadata, #title h1')?.textContent) || null;
    } else if (/youtu\.be$/.test(location.hostname)) {
      out.url = `${location.origin}${location.pathname}?t=${t}`;
    }
    return out;
  }

  function sourceDetails() {
    const text = selection();
    const s = getSelection();
    const a = document.activeElement;
    const inField = a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT');
    let node = inField ? a : (s && s.rangeCount ? s.getRangeAt(0).commonAncestorContainer : null);
    const el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
    const block = el && !inField ? el.closest('p,li,td,th,pre,code,blockquote,h1,h2,h3,h4,h5,h6,dd,figcaption,article,section,div') : null;
    const blockText = block ? clean(block.innerText).slice(0, 4000) : '';
    const sel = clean(text);
    const i = sel ? blockText.indexOf(sel.slice(0, 200)) : -1;
    const link = el?.closest('a[href]');
    const meta = n => document.querySelector(`meta[property="${n}"],meta[name="${n}"]`)?.content || null;
    const icon = document.querySelector('link[rel~="icon"]')?.href;
    const scroll = document.documentElement.scrollHeight - innerHeight;
    return {
      before: i > 0 ? blockText.slice(Math.max(0, i - 220), i) : null,
      after: i >= 0 ? blockText.slice(i + sel.length, i + sel.length + 220) : null,
      heading: el ? nearestHeading(el) : null,
      element: el ? (inField ? `${a.tagName.toLowerCase()}${a.type ? ':' + a.type : ''}` : (block || el).tagName.toLowerCase()) : null,
      link: link ? { href: link.href, text: clean(link.innerText).slice(0, 120) } : null,
      fragment: inField ? null : fragmentUrl(text),
      video: videoMoment(),
      site: meta('og:site_name'),
      description: (meta('og:description') || meta('description') || '').slice(0, 240) || null,
      favicon: icon || `${location.origin}/favicon.ico`,
      scrollPct: scroll > 0 ? Math.round((scrollY / scroll) * 100) : 0,
      lang: document.documentElement.lang || null,
      frame: window !== top,
    };
  }

  const onCopy = () => {
    let details = null;
    try { details = sourceDetails(); } catch { /* odd pages: still send the basics */ }
    send({ type: 'copy-context', selection: selection(), details, ...ctx() });
  };
  document.addEventListener('copy', onCopy, true);
  document.addEventListener('cut', onCopy, true);

  document.addEventListener('paste', e => {
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (text) send({ type: 'paste', text, field: fieldKind(e.target), ...ctx() });
  }, true);

  // ---------- Login Recall ----------
  let chip = null, offer = null, asked = false;

  function setValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findFields(near) {
    const form = near.form || document;
    const inputs = [...form.querySelectorAll('input')].filter(i => i.offsetParent !== null);
    return {
      pass: inputs.find(i => i.type === 'password'),
      user: inputs.find(i => fieldKind(i) === 'username' && i.type !== 'password') ||
            inputs.find(i => ['text', 'email'].includes(i.type)),
    };
  }

  function hideChip() { chip?.remove(); chip = null; }

  function showChip(input) {
    hideChip();
    const host = document.createElement('div');
    const r = input.getBoundingClientRect();
    Object.assign(host.style, { position: 'absolute', zIndex: 2147483647, left: `${r.left + scrollX}px`, top: `${r.bottom + scrollY + 4}px` });
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      button{all:initial;font:500 12px/1 "Segoe UI",system-ui,sans-serif;color:#e4e7eb;background:#111419;border:1px solid #2e3540;
        border-radius:6px;padding:8px 11px;cursor:pointer;display:flex;gap:8px;align-items:center;box-shadow:0 6px 18px rgba(0,0,0,.35)}
      button:hover{border-color:#7cc4ff} b{color:#7cc4ff;font:600 10px/1 Consolas,monospace;letter-spacing:.16em}
      span{color:#8b95a3}</style>
      <button><b>CLIP/STORY</b> Fill your login for ${offer.domain}<span>${offer.user ? ' · ' + offer.user.replace(/[<>&]/g, '') : ''}</span></button>`;
    root.querySelector('button').addEventListener('mousedown', async e => {
      e.preventDefault();
      const res = await send({ type: 'recall-fill' });
      const data = res?.ok && res.result;
      if (!data) return hideChip();
      const f = findFields(input);
      if (data.user && f.user) setValue(f.user, data.user);
      if (data.password && f.pass) setValue(f.pass, data.password);
      hideChip();
    });
    document.documentElement.append(host);
    chip = host;
  }

  document.addEventListener('focusin', async e => {
    const t = e.target;
    if (fieldKind(t) === 'other') return;
    if (!asked) {
      asked = true;
      const res = await send({ type: 'recall' });
      offer = res?.ok ? res.result : null;
    }
    if (offer) showChip(t);
  }, true);
  document.addEventListener('focusout', () => setTimeout(hideChip, 150), true);
})();
