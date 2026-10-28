// Secrets are encrypted with a device key that is created automatically, so they stay one click away.
// ARM only ever stores ciphertext. An optional backup passphrase wraps the private key so it can be
// restored on another browser (PBKDF2 -> AES-GCM); without it, the device key lives only in this profile.
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const ITERATIONS = 310000;
const RSA = { name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };

// Keyed hash for dedupe and password-reuse detection. The key never leaves this browser,
// so ARM cannot brute-force a password from its hash.
let hmacKeyP = null;
async function hmacKey() {
  if (hmacKeyP) return hmacKeyP;
  hmacKeyP = (async () => {
    let { hmacRaw } = await chrome.storage.local.get('hmacRaw');
    if (!hmacRaw) {
      hmacRaw = b64(crypto.getRandomValues(new Uint8Array(32)));
      await chrome.storage.local.set({ hmacRaw });
    }
    return crypto.subtle.importKey('raw', unb64(hmacRaw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  })();
  return hmacKeyP;
}

export async function hmac(text) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(text));
  return b64(sig).slice(0, 32);
}

// ---------- device key ----------
let keysP = null;
export function deviceKeys() {
  if (keysP) return keysP;
  keysP = (async () => {
    let { keys } = await chrome.storage.local.get('keys');
    if (!keys) {
      const pair = await crypto.subtle.generateKey(RSA, true, ['encrypt', 'decrypt']);
      keys = {
        created: Date.now(),
        pub: b64(await crypto.subtle.exportKey('spki', pair.publicKey)),
        priv: b64(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
      };
      await chrome.storage.local.set({ keys });
    }
    return {
      ...keys,
      pubKey: await crypto.subtle.importKey('spki', unb64(keys.pub), RSA, false, ['encrypt']),
      privKey: await crypto.subtle.importKey('pkcs8', unb64(keys.priv), RSA, false, ['decrypt']),
    };
  })();
  return keysP;
}

export async function seal(text) {
  const { pubKey } = await deviceKeys();
  const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc.encode(text));
  const k = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pubKey, await crypto.subtle.exportKey('raw', aes));
  return { v: 1, alg: 'RSA-OAEP-3072+AES-256-GCM', k: b64(k), iv: b64(iv), ct: b64(ct) };
}

export async function openSealed(sealed) {
  if (typeof sealed === 'string') sealed = JSON.parse(sealed);
  const { privKey } = await deviceKeys();
  const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privKey, unb64(sealed.k));
  const aes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) }, aes, unb64(sealed.ct)));
}

// ---------- optional backup (restore on another browser) ----------
async function passKey(passphrase, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function getBackup() {
  return (await chrome.storage.local.get('vault')).vault || null;
}

export async function createBackup(passphrase) {
  if (!passphrase || passphrase.length < 10) throw new Error('Use at least 10 characters.');
  const keys = await deviceKeys();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await passKey(passphrase, salt), unb64(keys.priv));
  const vault = { v: 1, created: Date.now(), iterations: ITERATIONS, pub: keys.pub, wrapped: b64(wrapped), salt: b64(salt), iv: b64(iv) };
  await chrome.storage.local.set({ vault });
  return vault;
}

// Replace this browser's device key with the one from a backup (e.g. after reinstalling).
export async function restoreBackup(vault, passphrase) {
  let pkcs8;
  try {
    pkcs8 = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) },
      await passKey(passphrase, unb64(vault.salt)), unb64(vault.wrapped));
  } catch {
    throw new Error('Wrong passphrase.');
  }
  await chrome.storage.local.set({ keys: { created: Date.now(), pub: vault.pub, priv: b64(pkcs8) }, vault });
  keysP = null;
}
