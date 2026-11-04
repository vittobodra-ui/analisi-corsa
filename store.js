// Archivio delle sessioni nel browser (IndexedDB), con esportazione e importazione in un file.
const DB = 'analisi-corsa', STORE = 'sessions';
function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode), req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); res(req?.result); };
    t.onerror = t.onabort = () => { db.close(); rej(t.error); };
  });
}
export const saveSession = (s) => tx('readwrite', (o) => o.put(s));
export const getSession = (id) => tx('readonly', (o) => o.get(id));
export const deleteSession = (id) => tx('readwrite', (o) => o.delete(id));
export const allSessions = async () => (await tx('readonly', (o) => o.getAll())).sort((a, b) => b.createdAt - a.createdAt);
