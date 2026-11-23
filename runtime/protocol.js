'use strict';
// Wire format between the injected page script and the main-process host.
//
// Why not ipcRenderer: the host must not register session preloads. The
// reference implementation on Linux never touches the session at all — its UI
// is pushed into the page from the main process — and every session-level hook
// is something the host can notice. So the panel talks back over a line-prefixed
// console message, which `webContents.on('console-message')` already receives.
//
// One direction each way:
//   page -> main   console.log('[oicq-action]{"id":1,"type":"state"}')
//   main -> page   contents.executeJavaScript('__oicq_reply__(1, {...})')

const ACTION_PREFIX = '[oicq-action]';
const MAX_MESSAGE = 64 * 1024;

function encode(action) {
  return ACTION_PREFIX + JSON.stringify(action);
}

// Returns null for anything that is not one of our messages, so the console
// stream (QQNT logs a lot) can be passed through untouched.
function parse(message) {
  if (typeof message !== 'string') return null;
  if (!message.startsWith(ACTION_PREFIX)) return null;
  const body = message.slice(ACTION_PREFIX.length);
  if (body.length > MAX_MESSAGE) return null;
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object') return null;
    if (typeof value.type !== 'string') return null;
    if (value.id != null && typeof value.id !== 'number') return null;
    return value;
  } catch {
    return null;
  }
}

module.exports = { ACTION_PREFIX, encode, parse };
