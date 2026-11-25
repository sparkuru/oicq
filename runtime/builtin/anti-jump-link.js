'use strict';
// builtin: anti-jump-link — skip the "you are leaving" interstitial.
//
// QQNT asks the kernel whether a URL is safe (`checkMsgWithUrl`) before showing
// a confirmation page. Answering with jumpResult 15 lets the link open directly;
// cancelling the real call stops the client from overwriting the fake reply.

module.exports = function activate(api) {
  if (!api.kernel.available) {
    return { status: 'unavailable', reason: 'kernel hooks are off (OICQ_KERNEL_HOOKS=1)' };
  }

  const off = api.kernel.receive({ method: 'nodeIKernelMsgService/checkMsgWithUrl' }, (ctx) => {
    const info = ctx.args[0] && ctx.args[0].checkUrlInfo;
    const urls = info && Array.isArray(info.urls) ? info.urls : [];
    if (!urls.length) return;
    ctx.cancel = true;
    ctx.reply({
      result: 0,
      errMsg: '',
      checkUrlsResult: urls.map((url) => ({
        url,
        result: 0,
        jumpResult: 15,
        jumpUrl: url,
      })),
    });
  });

  return { dispose: off };
};
