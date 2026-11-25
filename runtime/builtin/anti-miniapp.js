'use strict';
// builtin: anti-miniapp — open the underlying link instead of the mini app.
//
// Ark cards carry `meta.detail_1.url` (the mini-app entry) and `qqdocurl` (the
// real page). Cards are remembered from the message stream; when the client
// asks to open a mini app whose URL matches a remembered entry, the external
// browser opens the document URL and the mini-app call is cancelled.

module.exports = function activate(api, host) {
  if (!api.kernel.available) {
    return { status: 'unavailable', reason: 'kernel hooks are off (OICQ_KERNEL_HOOKS=1)' };
  }
  const LIMIT = 300;
  const cards = new Map();

  const offSend = api.kernel.send({ event: 'nodeIKernelMsgListener/onRecvMsg' }, (ctx) => {
    const list = ctx.payload && ctx.payload.msgList;
    if (!Array.isArray(list)) return;
    for (const message of list) {
      const bytes = message
        && Array.isArray(message.elements)
        && message.elements[0]
        && message.elements[0].arkElement
        && message.elements[0].arkElement.bytesData;
      if (!bytes) continue;
      try {
        const card = JSON.parse(bytes);
        const detail = card && card.meta && card.meta.detail_1;
        if (!detail || !detail.url || !detail.qqdocurl) continue;
        cards.set(detail.url, detail.qqdocurl);
        if (cards.size > LIMIT) cards.delete(cards.keys().next().value);
      } catch {
        /* not a json card */
      }
    }
  });

  const offReceive = api.kernel.receive({ method: 'openMiniApp' }, (ctx) => {
    const raw = ctx.args[0] && ctx.args[0].url;
    if (!raw) return;
    let url = String(raw);
    try {
      url = decodeURIComponent(url);
    } catch {
      /* keep the raw form */
    }
    for (const [entry, doc] of cards) {
      if (!url.includes(entry)) continue;
      ctx.cancel = true;
      host.openExternal(doc);
      return;
    }
  });

  return {
    dispose() {
      offSend();
      offReceive();
    },
  };
};
