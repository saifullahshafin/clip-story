// Decide what a clip is and whether it is a secret. Errs on the side of sealing.
const KEY_PATTERNS = [
  /^sk-ant-[\w-]{20,}$/, /^sk-[\w-]{20,}$/, /^AIza[\w-]{30,}$/, /^gh[pousr]_\w{20,}$/, /^github_pat_\w{20,}$/,
  /^hf_\w{20,}$/, /^xox[abpr]-[\w-]{10,}$/, /^AKIA[0-9A-Z]{16}$/, /^eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}$/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /^[A-Za-z0-9+/]{40,}={0,2}$/,
];
const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const URL_RX = /^(https?:\/\/|www\.)\S+$/i;

function luhn(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = +digits[i];
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

function entropy(s) {
  const f = {};
  for (const ch of s) f[ch] = (f[ch] || 0) + 1;
  return Object.values(f).reduce((e, n) => e - (n / s.length) * Math.log2(n / s.length), 0);
}

function looksLikePassword(t, prev) {
  if (/\s/.test(t) || t.length < 8 || t.length > 64) return false;
  if (EMAIL.test(t) || URL_RX.test(t) || /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(t)) return false;
  if (/^[A-Za-z]:\\|^\/[\w.-]+\//.test(t)) return false; // file paths
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(t)).length;
  const afterLogin = prev.some(p => p.kind === 'email' && Date.now() - p.ts < 5 * 60_000);
  if (classes >= 3 && entropy(t) > 2.8) return true;
  if (classes >= 2 && t.length >= 12 && entropy(t) > 3.4) return true;
  return afterLogin && classes >= 2 && entropy(t) > 2.5;
}

function looksLikeCode(t) {
  if (!/\n/.test(t)) return /^\s*(SELECT|import|from|const|let|def|function|curl|npm|pip|git|python|docker)\b/.test(t) && /[=(.\-]/.test(t);
  const signals = [
    /^\s*(def|function|const|let|var|import|from|class|return|if|for|while|SELECT|INSERT|#include|public|async)\b/m,
    /[{};]\s*$/m, /=>|==|!=|\+=|::|->/, /^\s{2,}\S/m, /<\/?[a-z][\w-]*[\s>]/i, /\w\([^)]*\)/,
  ];
  return signals.filter(r => r.test(t)).length >= 2;
}

export function classify(text, prev = []) {
  const t = text.trim();
  if (KEY_PATTERNS.some(r => r.test(t))) return { kind: 'api_key', sensitive: true };
  if (EMAIL.test(t)) return { kind: 'email', sensitive: false };
  if (URL_RX.test(t)) return { kind: 'url', sensitive: false };
  const digits = t.replace(/[ -]/g, '');
  if (/^\d{13,19}$/.test(digits) && /^[\d -]+$/.test(t) && luhn(digits)) return { kind: 'card', sensitive: true };
  if (/^\d{4,8}$/.test(t)) return { kind: 'otp', sensitive: false };
  if (/^\+?[\d ()-]{7,18}$/.test(t) && digits.replace(/\D/g, '').length >= 7) return { kind: 'phone', sensitive: false };
  if (looksLikePassword(t, prev)) return { kind: 'password', sensitive: true };
  if (looksLikeCode(t)) return { kind: 'code', sensitive: false };
  return { kind: 'text', sensitive: false };
}

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

export function mask(len) {
  return '•'.repeat(Math.min(len, 12)) + ` (${len} chars)`;
}
