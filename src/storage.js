export function createStorageAdapter(host) {
  const pendingReads = new Set();

  function read(key, timeoutMs = 2000) {
    return new Promise((resolve) => {
      const pendingRead = { key, resolve };
      pendingReads.add(pendingRead);
      host.storage({ type: "read", key });
      setTimeout(() => {
        if (pendingReads.delete(pendingRead)) {
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  function write(key, data) {
    host.storage({ type: "write", key, data });
  }

  function resolvePendingRead(event) {
    if (event?.name !== "storageRead") return false;
    const key = event?.payload?.key;
    let resolved = false;
    for (const pendingRead of Array.from(pendingReads)) {
      if (pendingRead.key === key) {
        pendingReads.delete(pendingRead);
        pendingRead.resolve(event.payload?.value ?? null);
        resolved = true;
      }
    }
    return resolved;
  }

  return { read, write, resolvePendingRead };
}
