// Métricas de uso em IndexedDB local (nunca sincronizado). Cada registro guarda
// apenas data, tokens e tamanho do texto: o texto revisado nunca é gravado.
(function (root) {
  'use strict';

  const DB_NAME = 'aitr-metrics';
  const STORE = 'usage';

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function run(mode, fn) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  root.AITRDB = {
    add: (record) => run('readwrite', (s) => s.add(record)),
    getAll: () => run('readonly', (s) => s.getAll()),
    clear: () => run('readwrite', (s) => s.clear()),
  };
})(globalThis);
