'use strict';
// builtin: anti-recall — keep revoked messages and put them back.
//
// Hooks the kernel → renderer stream (`onRecvMsg`). A normal message is cached
// on disk under <root>/savedMessages/<msgId[0:8]>/<msgId[8:]>; when the same id
// arrives with a revoke gray-tip, the cached elements replace it in place, so
// the client renders the original again.

module.exports = function activate(api, host) {
  if (!api.kernel.available) {
    return { status: 'unavailable', reason: 'kernel hooks are off (OICQ_KERNEL_HOOKS=1)' };
  }
  const fs = host.require('node:fs');
  const path = host.require('node:path');
  const root = path.join(host.paths.root, 'savedMessages');
  const LIMIT = 500;
  const cache = new Map();

  const fileFor = (msgId) => {
    const id = String(msgId);
    return path.join(root, id.slice(0, 8), id.slice(8));
  };

  const persist = (message) => {
    try {
      const file = fileFor(message.msgId);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(message));
    } catch (error) {
      api.log('cannot persist', message.msgId, error.message);
    }
  };

  const load = (msgId) => {
    if (cache.has(msgId)) return cache.get(msgId);
    try {
      const saved = JSON.parse(fs.readFileSync(fileFor(msgId), 'utf8'));
      cache.set(msgId, saved);
      return saved;
    } catch {
      return null;
    }
  };

  const isRevoke = (message) => Boolean(
    message
    && Array.isArray(message.elements)
    && message.elements[0]
    && message.elements[0].grayTipElement
    && message.elements[0].grayTipElement.revokeElement,
  );

  const remember = (message) => {
    if (!message || !message.msgId || !Array.isArray(message.elements)) return;
    cache.set(message.msgId, message);
    if (cache.size > LIMIT) cache.delete(cache.keys().next().value);
    persist(message);
  };

  const restore = (message) => {
    const saved = load(message.msgId);
    if (!saved || !Array.isArray(saved.elements)) return false;
    // Replace only the rendered content: the client already holds a reference
    // to this message object, so assigning elements is enough.
    message.elements = saved.elements;
    return true;
  };

  const off = api.kernel.send({ event: 'nodeIKernelMsgListener/onRecvMsg' }, (ctx) => {
    const list = ctx.payload && ctx.payload.msgList;
    if (!Array.isArray(list)) return;
    for (const message of list) {
      if (!message || !message.msgId) continue;
      if (isRevoke(message)) {
        if (restore(message)) api.log('restored', message.msgId);
      } else {
        remember(message);
      }
    }
  });

  return { dispose: off };
};
