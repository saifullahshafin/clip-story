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

  document.addEventListener('copy', () => send({ type: 'copy-context', selection: selection(), ...ctx() }), true);
  document.addEventListener('cut', () => send({ type: 'copy-context', selection: selection(), ...ctx() }), true);

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
