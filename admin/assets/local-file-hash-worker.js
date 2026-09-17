/* Incremental hashing runs off the UI thread, with bounded 8 MiB reads. */
importScripts('../../assets/vendor/sha256-0.11.1.js');
self.onmessage = async ({data: file}) => {
  try {
    const hash = sha256.create();
    for (let offset = 0; offset < file.size; offset += 8 * 1024 * 1024) {
      hash.update(await file.slice(offset, offset + 8 * 1024 * 1024).arrayBuffer());
      self.postMessage({current: Math.min(file.size, offset + 8 * 1024 * 1024), total: file.size});
    }
    self.postMessage({sha256: hash.hex()});
  } catch (error) { self.postMessage({error: error.message}); }
};
