// Local IndexedDB cache. Same origin for the service worker and every extension page.
const DB_NAME = 'clipstory';
const STORE = 'clips';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: 'id' });
      s.createIndex('ts', 'ts');
      s.createIndex('hmac', 'hmac');
      s.createIndex('synced', 'synced_flag');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
    t.onerror = () => reject(t.error);
  }));
}

export const putClip = clip => {
  clip.synced_flag = clip.synced ? 1 : 0; // booleans are not indexable
  return tx('readwrite', s => s.put(clip));
};
export const getClip = id => tx('readonly', s => s.get(id));
export const deleteClip = id => tx('readwrite', s => s.delete(id));

export function recent(limit = 50) {
  return open().then(db => new Promise((resolve, reject) => {
    const out = [];
    const req = db.transaction(STORE).objectStore(STORE).index('ts').openCursor(null, 'prev');
    req.onsuccess = () => {
      const c = req.result;
      if (!c || out.length >= limit) return resolve(out);
      out.push(c.value);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  }));
}

export function byHmac(h) {
  return tx('readonly', s => s.index('hmac').getAll(h)).then(rows => rows.sort((a, b) => b.ts - a.ts));
}

export const unsynced = () => tx('readonly', s => s.index('synced').getAll(0));

export function range(since, until = Date.now() + 1) {
  return tx('readonly', s => s.index('ts').getAll(IDBKeyRange.bound(since, until)));
}
