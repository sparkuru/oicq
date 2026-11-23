'use strict';
// oicq minimal runtime — the "did the injection land?" payload.
//
// OICQ_RUNTIME=minimal selects this file instead of the full host. It exists so
// the native half (symbol resolution, hook, splice, payload write) can be
// verified on a machine where plugins and UI must stay out of the picture.

(function minimal() {
  const marker = globalThis.__oicq__;
  if (marker) return;
  globalThis.__oicq__ = Object.freeze({
    version: 'minimal',
    api: 0,
    root: process.env.OICQ_DATA_DIR || null,
    log: (...parts) => console.log('[oicq:minimal]', ...parts),
  });
  console.log('[oicq:minimal] injected');
})();
