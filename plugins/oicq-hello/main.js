'use strict';
// Example plugin — main process side.
//
// Runs inside a vm context: only `require('oicq/api')` is available, and the
// API is frozen. Storage writes land in <data root>/data/oicq-hello.json.

const api = require('oicq/api');

let counter = (api.fs.readData() || {}).counter || 0;

api.commands.register({
  id: 'hello.say',
  title: '打个招呼',
  hint: '第几次被调用会写进存储',
  run() {
    counter += 1;
    api.fs.writeData({ counter, at: new Date().toISOString() });
    api.log('hello.say', counter);
    api.ui.notify(`你好，这是第 ${counter} 次`);
    return { counter };
  },
});

api.events.on('ready', () => {
  api.log('runtime ready, counter =', counter);
});

// Interceptor demo. `command:run` runs before every command, the context is
// shared between handlers, and `{cancel:true}` stops both the chain and the
// command. This is the host-owned equivalent of a middleware chain — nothing
// here touches QQNT's IPC.
const offCommandHook = api.pipeline.before('command:run', (context) => {
  if (context.id === 'hello.say') context.payload = { ...(context.payload || {}), via: 'oicq-hello' };
});

api.events.on('ready', () => api.log('pipelines', JSON.stringify(api.pipeline.list())));

// Two teardown styles, both supported: a module-level dispose export (called
// first, while the rest of the host is still up) and lifecycle callbacks (run
// after it). The host also removes whatever the plugin forgot, so disabling a
// plugin never leaves a stale command or interceptor behind.
api.lifecycle.onDispose(() => {
  offCommandHook();
  api.log('dispose: lifecycle hook');
});

module.exports = {
  dispose() {
    api.log('dispose: module export');
  },
};
