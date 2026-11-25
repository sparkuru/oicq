'use strict';
// Optional kernel-IPC bridge. Design and boundaries: docs/14-plugin-framework.md.
//
// Two surfaces are wrapped, both synchronously:
//   ipcMain.emit(channel, event, ...rest)  — renderer → kernel calls
//   webContents.send(channel, ...args)     — kernel → renderer events
//
// Only builtin plugins receive hooks (api.kernel), and the bridge installs only
// when OICQ_KERNEL_HOOKS=1. Frames pass through unchanged unless a hook cancels
// the context, rewrites ctx.args, or replaces ctx.payload. Asynchronous hooks
// are rejected at registration: these paths cannot wait for a promise.

const WRAPPED = Symbol.for('oicq.kernel.send');

// QQNT frames: ipcMain.emit(channel, event, {eventName, callbackId}, [method, ...args])
// The same emitter carries internal traffic, so every field is discovered
// defensively and anything missing simply means "do not match".
// QQNT 3.2.x frame shapes, verified on the Linux client:
//
//   renderer → main: ipcMain.emit(channel, event,
//                       {type, eventName, peerId, callbackId?},
//                       {cmdName, cmdType, payload: [arg, ...]})
//   main → renderer: contents.send(channel,
//                       {callbackId, promiseStatue, type, eventName, peerId},
//                       body)
//
// Older builds (and ref's 0.5.10) used `[method, ...args]` as the last
// argument, so both shapes are parsed; the command object wins when present.
function describeReceive(rest) {
  const meta = rest.find(
    (value) => value && typeof value === 'object' && !Array.isArray(value)
      && ('eventName' in value || 'callbackId' in value),
  ) || {};
  const cmd = rest.find(
    (value) => value && typeof value === 'object' && !Array.isArray(value)
      && typeof value.cmdName === 'string',
  );
  if (cmd) {
    return {
      method: cmd.cmdName,
      args: Array.isArray(cmd.payload) ? cmd.payload : [],
      eventName: meta.eventName || null,
      callbackId: meta.callbackId === undefined ? null : meta.callbackId,
      cmd,
      legacy: false,
    };
  }
  const list = rest.find((value) => Array.isArray(value)) || [];
  const method = typeof list[0] === 'string' ? list[0] : null;
  return {
    method,
    args: method === null ? list.slice() : list.slice(1),
    eventName: meta.eventName || null,
    callbackId: meta.callbackId === undefined ? null : meta.callbackId,
    cmd: null,
    legacy: true,
  };
}

function describeSend(args) {
  const first = args[0];
  const hasMeta = args.length > 1
    && first && typeof first === 'object' && !Array.isArray(first)
    && ('callbackId' in first || 'eventName' in first);
  const body = hasMeta ? args[args.length - 1] : first;
  const cmd = (body && body.cmdName) || (hasMeta && first.cmdName);
  return {
    eventName: (hasMeta && first.eventName) || (body && body.eventName) || null,
    cmd: Array.isArray(cmd) ? cmd[0] : cmd || null,
    payload: body,
    hasMeta,
  };
}

module.exports = function createKernelBridge({ ipcMain, log, dispatch }) {
  let installed = false;

  function reply(event, callbackId, payload) {
    if (callbackId === null || !event || !event.sender) return false;
    try {
      event.sender.send(`IPC_DOWN_${event.sender.id}`, {
        callbackId,
        promiseStatue: 'full',
        type: 'response',
        eventName: 'ns-ntApi-2',
      }, payload);
      return true;
    } catch (error) {
      log('warn', 'kernel reply failed:', error && error.message);
      return false;
    }
  }

  function install() {
    if (installed) return true;
    if (!ipcMain || typeof ipcMain.emit !== 'function') return false;
    installed = true;
    const originalEmit = ipcMain.emit;
    ipcMain.emit = function emitWithKernelHooks(channel, event, ...rest) {
      if (typeof channel !== 'string' || !event || !event.sender) {
        return originalEmit.call(this, channel, event, ...rest);
      }
      const meta = describeReceive(rest);
      const ctx = {
        stage: 'receive',
        channel,
        raw: rest,
        method: meta.method,
        args: meta.args,
        eventName: meta.eventName,
        callbackId: meta.callbackId,
        cmdType: meta.cmd ? meta.cmd.cmdType : null,
        cancel: false,
        reply: (payload) => reply(event, meta.callbackId, payload),
      };
      try {
        dispatch('receive', ctx);
      } catch (error) {
        log('warn', 'kernel receive dispatch:', error && error.message);
      }
      if (ctx.cancel) return true;
      if (meta.cmd) {
        meta.cmd.payload = ctx.args;
      } else {
        const list = rest.find((value) => Array.isArray(value));
        if (list) list.splice(1, list.length - 1, ...ctx.args);
      }
      return originalEmit.call(this, channel, event, ...rest);
    };
    return true;
  }

  function wrapContents(contents) {
    if (!installed || !contents || contents[WRAPPED]) return;
    const originalSend = contents.send;
    if (typeof originalSend !== 'function') return;
    contents[WRAPPED] = true;
    contents.send = function sendWithKernelHooks(channel, ...args) {
      if (typeof channel !== 'string') return originalSend.apply(this, arguments);
      const meta = describeSend(args);
      const ctx = {
        stage: 'send',
        channel,
        raw: args,
        eventName: meta.eventName,
        cmd: meta.cmd,
        payload: meta.payload,
        cancel: false,
      };
      try {
        dispatch('send', ctx);
      } catch (error) {
        log('warn', 'kernel send dispatch:', error && error.message);
      }
      if (ctx.cancel) return undefined;
      let next = args;
      if (ctx.payload !== meta.payload) {
        next = meta.hasMeta
          ? [...args.slice(0, -1), ctx.payload]
          : [ctx.payload];
      }
      return originalSend.apply(this, [channel, ...next]);
    };
  }

  return { install, wrapContents, isInstalled: () => installed };
};
