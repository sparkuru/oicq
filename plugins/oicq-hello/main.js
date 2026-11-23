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
