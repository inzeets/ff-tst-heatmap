(() => {
  const KILL = ['heat-older', 'heat-oldest'];
  const req = indexedDB.open('PermanentStorage');
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction('backgroundCaches', 'readwrite');
    const os = tx.objectStore('backgroundCaches');
    os.getAll().onsuccess = function () {
      let recs = 0, tabsCleaned = 0;
      for (const rec of this.result) {
        const tabs = rec?.value?.tabs;
        if (!Array.isArray(tabs)) continue;
        let dirty = false;
        for (const t of tabs) {
          const s = t?.$TST?.states;
          if (Array.isArray(s)) {
            const next = s.filter(x => !KILL.includes(x));
            if (next.length !== s.length) { t.$TST.states = next; tabsCleaned++; dirty = true; }
          }
        }
        if (dirty) { os.put(rec); recs++; }
      }
      tx.oncomplete = () => console.log(`rewrote ${recs} record(s), cleaned ${tabsCleaned} tab(s)`);
      tx.onerror = () => console.log('tx error', tx.error);
    };
  };
  req.onerror = () => console.log('open error', req.error);
})();
