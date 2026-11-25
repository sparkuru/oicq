'use strict';
// builtin: no-update — drop the client's config-driven update push.
//
// `nodeIKernelUnitedConfigListener/onUnitedConfigUpdate` is the frame that makes
// the client re-read remote switches (including update prompts). Cancelling it
// in the kernel → renderer stream is enough; nothing else touches the kernel.

module.exports = function activate(api) {
  if (!api.kernel.available) {
    return { status: 'unavailable', reason: 'kernel hooks are off (OICQ_KERNEL_HOOKS=1)' };
  }

  const off = api.kernel.send(
    { event: 'nodeIKernelUnitedConfigListener/onUnitedConfigUpdate' },
    (ctx) => {
      ctx.cancel = true;
    },
  );

  return { dispose: off };
};
