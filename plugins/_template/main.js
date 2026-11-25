'use strict';
// Plugin template — main process side.
//
// Copy this directory to <data root>/plugins/<your-id>/ and change the id in
// manifest.json to match the directory name. Runs inside a vm context: only
// `require('oicq/api')` resolves, `eval`/`new Function` are not available, and
// the api object is frozen.

const api = require('oicq/api');

// ---------------------------------------------------------------- commands
api.commands.register({
  id: 'your-plugin.ping',
  title: 'Ping',
  hint: '返回 pong',
  run(payload) {
    api.log('ping', payload === undefined ? '' : JSON.stringify(payload));
    return 'pong';
  },
});

// ------------------------------------------------------------- interceptors
// `command:run` sees every command before it runs. Rewrite ctx.payload, or set
// ctx.cancel = true to stop both the chain and the command. Async is allowed
// here; the host awaits the chain.
const offCommand = api.pipeline.before('command:run', (ctx) => {
  if (ctx.id === 'your-plugin.ping') ctx.payload = { ...(ctx.payload || {}), seen: true };
});

// ---------------------------------------------------------------- lifecycle
api.events.on('ready', () => api.log('ready'));

api.lifecycle.onDispose(() => {
  offCommand();
  api.log('dispose');
});

// Optional second teardown style: the host calls this first, while the rest of
// the api is still usable.
module.exports = {
  dispose() {
    api.log('module dispose');
  },
};
