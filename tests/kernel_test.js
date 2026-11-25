'use strict';
// Harness for runtime/kernel.js — the optional kernel-IPC bridge.
//
//   node tests/kernel_test.js
//
// Verifies frame parsing, argument rewriting, cancel + forged reply, the
// renderer → kernel and kernel → renderer directions, and that non-IPC traffic
// on ipcMain.emit is passed through untouched.

const assert = require('assert');
const EventEmitter = require('events');
const path = require('path');

const createBridge = require(path.join(__dirname, '..', 'runtime', 'kernel.js'));

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push(`ok   ${name}`);
  } catch (error) {
    checks.push(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

const logs = [];
const hooks = { receive: [], send: [] };
function dispatch(stage, context) {
  for (const hook of hooks[stage]) hook(context);
  return context;
}

const ipc = new EventEmitter();
const bridge = createBridge({
  ipcMain: ipc,
  log: (...parts) => logs.push(parts.join(' ')),
  dispatch,
});

check('install replaces emit and is idempotent', () => {
  assert.strictEqual(bridge.install(), true);
  assert.strictEqual(bridge.install(), true);
  assert.strictEqual(bridge.isInstalled(), true);
});

// ---------------------------------------------------------------- receive side
let received = null;
ipc.on('ns-ntApi-2', (event, meta, args) => {
  received = { meta, args };
});

let realReceived = null;
ipc.on('RM_IPCFROM_RENDERER1', (event, meta, cmd) => {
  realReceived = { meta, cmd };
});

const sender = {
  id: 7,
  sent: [],
  send(channel, ...args) {
    this.sent.push([channel, ...args]);
  },
};
const frame = Object.assign(new EventEmitter(), { sender });

check('parses method, args and callbackId', () => {
  const seen = [];
  hooks.receive.push((context) => seen.push({
    method: context.method,
    args: context.args,
    eventName: context.eventName,
    callbackId: context.callbackId,
  }));
  ipc.emit(
    'ns-ntApi-2',
    frame,
    { eventName: 'ns-ntApi-2', callbackId: 11 },
    ['nodeIKernelMsgService/sendMsg', { msgId: '1' }],
  );
  hooks.receive.length = 0;
  assert.deepStrictEqual(seen, [{
    method: 'nodeIKernelMsgService/sendMsg',
    args: [{ msgId: '1' }],
    eventName: 'ns-ntApi-2',
    callbackId: 11,
  }]);
  assert.strictEqual(received.args[1].msgId, '1');
});

check('rewrites args in place before the original handler', () => {
  hooks.receive.push((context) => {
    context.args[0] = { msgId: 'rewritten' };
  });
  ipc.emit(
    'ns-ntApi-2',
    frame,
    { eventName: 'ns-ntApi-2', callbackId: 12 },
    ['nodeIKernelMsgService/sendMsg', { msgId: 'original' }],
  );
  hooks.receive.length = 0;
  assert.strictEqual(received.args[1].msgId, 'rewritten');
});

check('cancel stops the handler and forges a reply', () => {
  let called = false;
  ipc.on('ns-ntApi-9', () => {
    called = true;
  });
  hooks.receive.push((context) => {
    context.cancel = true;
    context.reply({ result: 0 });
  });
  ipc.emit('ns-ntApi-9', frame, { callbackId: 21 }, ['someMethod', {}]);
  hooks.receive.length = 0;
  assert.strictEqual(called, false, 'original handler must not run');
  assert.deepStrictEqual(sender.sent.pop(), [
    'IPC_DOWN_7',
    { callbackId: 21, promiseStatue: 'full', type: 'response', eventName: 'ns-ntApi-2' },
    { result: 0 },
  ]);
});

check('non-IPC emit traffic is passed through', () => {
  let called = false;
  ipc.on('internal', () => {
    called = true;
  });
  ipc.emit('internal', { noSender: true });
  assert.strictEqual(called, true);
});

// ------------------------------------------------------------------- send side
const contents = {
  id: 3,
  calls: [],
  send(channel, ...args) {
    this.calls.push([channel, ...args]);
  },
};

check('wraps webContents.send once', () => {
  bridge.wrapContents(contents);
  const wrapped = contents.send;
  bridge.wrapContents(contents);
  assert.strictEqual(contents.send, wrapped);
});

check('rewrites the payload object in place', () => {
  hooks.send.push((context) => {
    context.payload.msgList.push({ msgId: 'injected' });
  });
  contents.send('IPC_DOWN_3', { eventName: 'nodeIKernelMsgListener/onRecvMsg', msgList: [] });
  hooks.send.length = 0;
  const [channel, payload] = contents.calls.pop();
  assert.strictEqual(channel, 'IPC_DOWN_3');
  assert.deepStrictEqual(payload.msgList, [{ msgId: 'injected' }]);
});

check('cancel drops the frame', () => {
  hooks.send.push((context) => {
    context.cancel = true;
  });
  contents.send('IPC_DOWN_3', { eventName: 'nodeIKernelUnitedConfigListener/onUnitedConfigUpdate' });
  hooks.send.length = 0;
  assert.strictEqual(contents.calls.length, 0);
});

check('replacing payload sends the replacement', () => {
  hooks.send.push((context) => {
    context.payload = { eventName: 'replaced' };
  });
  contents.send('IPC_DOWN_3', { eventName: 'original' });
  hooks.send.length = 0;
  const [, payload] = contents.calls.pop();
  assert.strictEqual(payload.eventName, 'replaced');
});

// --------------------------------------------------------- real 3.2.x shapes
const real = {
  id: 9,
  calls: [],
  send(channel, ...args) {
    this.calls.push([channel, ...args]);
  },
};

check('parses the cmdName/payload envelope', () => {
  const seen = [];
  hooks.receive.push((context) => seen.push({
    method: context.method,
    args: context.args,
    eventName: context.eventName,
    callbackId: context.callbackId,
    cmdType: context.cmdType,
  }));
  ipc.emit(
    'RM_IPCFROM_RENDERER1',
    frame,
    { type: 'invoke', eventName: 'ntApi', peerId: 1, callbackId: 'cb-1' },
    {
      cmdName: 'nodeIKernelMsgService/sendMsg',
      cmdType: 'invoke',
      payload: [{ msgId: '1' }],
    },
  );
  hooks.receive.length = 0;
  assert.deepStrictEqual(seen, [{
    method: 'nodeIKernelMsgService/sendMsg',
    args: [{ msgId: '1' }],
    eventName: 'ntApi',
    callbackId: 'cb-1',
    cmdType: 'invoke',
  }]);
});

check('rewrites cmdName payload in place', () => {
  hooks.receive.push((context) => {
    context.args[0] = { msgId: 'rewritten-real' };
  });
  ipc.emit(
    'RM_IPCFROM_RENDERER1',
    frame,
    { type: 'invoke', callbackId: 'cb-2' },
    {
      cmdName: 'nodeIKernelMsgService/sendMsg',
      cmdType: 'invoke',
      payload: [{ msgId: 'original' }],
    },
  );
  hooks.receive.length = 0;
  assert.strictEqual(realReceived.cmd.cmdName, 'nodeIKernelMsgService/sendMsg');
  assert.strictEqual(realReceived.cmd.payload[0].msgId, 'rewritten-real');
});

check('parses the meta/body send envelope', () => {
  bridge.wrapContents(real);
  const seen = [];
  hooks.send.push((context) => seen.push({
    eventName: context.eventName,
    cmd: context.cmd,
    payload: context.payload,
  }));
  real.send(
    'RM_IPCFROM_MAIN1',
    { callbackId: 'cb-3', promiseStatue: 'full', type: 'response', eventName: 'ntApi' },
    { msgList: [] },
  );
  hooks.send.length = 0;
  assert.strictEqual(seen[0].eventName, 'ntApi');
  assert.deepStrictEqual(seen[0].payload, { msgList: [] });
});

check('rewrites only the body of a meta/body frame', () => {
  hooks.send.push((context) => {
    context.payload = { msgList: [{ msgId: 'x' }] };
  });
  real.send(
    'RM_IPCFROM_MAIN1',
    { callbackId: 'cb-4', eventName: 'ntApi' },
    { msgList: [] },
  );
  hooks.send.length = 0;
  const [, meta, body] = real.calls.pop();
  assert.strictEqual(meta.callbackId, 'cb-4');
  assert.deepStrictEqual(body.msgList, [{ msgId: 'x' }]);
});

console.log(checks.join('\n'));
