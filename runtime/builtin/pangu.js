'use strict';
// builtin: pangu — put a space between CJK and latin/digits before sending.
//
// `,,` (or full-width `，，`) at the start is a local escape: the prefix is
// stripped and the text is sent untouched. A leading `/` marks a command and is
// skipped entirely.

module.exports = function activate(api) {
  if (!api.kernel.available) {
    return { status: 'unavailable', reason: 'kernel hooks are off (OICQ_KERNEL_HOOKS=1)' };
  }
  const CJK = '\\u2e80-\\u9fff\\uf900-\\ufaff';
  const between = new RegExp(`([${CJK}])([A-Za-z0-9])`, 'g');
  const around = new RegExp(`([A-Za-z0-9])([${CJK}])`, 'g');

  const spacing = (text) => text.replace(between, '$1 $2').replace(around, '$1 $2');

  const off = api.kernel.receive({ method: 'nodeIKernelMsgService/sendMsg' }, (ctx) => {
    const params = ctx.args[0];
    api.debug('sendMsg seen', `args=${ctx.args.length}`,
        `elements=${params && Array.isArray(params.msgElements) ? params.msgElements.length : 'n/a'}`);
    if (!params || !Array.isArray(params.msgElements)) return;
    const changes = [];
    for (const element of params.msgElements) {
      const text = element && element.textElement;
      if (!text || typeof text.content !== 'string') continue;
      const before = text.content;
      if (before.startsWith(',,') || before.startsWith('，，')) {
        text.content = before.slice(2);
        changes.push([before, text.content, 'escape']);
        continue;
      }
      if (before.startsWith('/') || before.startsWith(' /')) continue;
      const after = spacing(before).replaceAll('～', '~');
      if (after !== before) {
        text.content = after;
        changes.push([before, after, 'spacing']);
      }
    }
    if (changes.length) {
      api.debug('rewrote', JSON.stringify(changes.slice(0, 3)));
    }
  });

  // Discovery aid for the manual send test: log the first few methods whose
  // name mentions send, so a version that renames sendMsg is visible.
  let seen = 0;
  const probe = api.kernel.receive({}, (ctx) => {
    if (seen >= 20) return;
    if (ctx.method && /send|msg/i.test(ctx.method)) {
      seen += 1;
      api.debug('method probe', ctx.method);
    }
  });

  return {
    dispose() {
      off();
      probe();
    },
  };
};
