'use strict';
// Harness for runtime/builtin/anti-recall-pro.js.
//
//   node tests/anti_recall_pro_test.js
//
// The plugin only talks to `api.kernel.send`, `api.commands.register` and
// `api.lifecycle.onDispose`, so a fake api is enough to drive a full
// receive/remember/revoke/restore cycle without Electron.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const activate = require(path.join(__dirname, '..', 'runtime', 'builtin', 'anti-recall-pro.js'));

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

function makeHarness({ kernel = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oicq-pro-'));
  const hooks = [];
  const receives = [];
  const commands = new Map();
  const disposers = [];
  const logs = [];
  const api = {
    kernel: {
      available: kernel,
      send(spec, fn) {
        hooks.push(fn);
        return () => hooks.splice(hooks.indexOf(fn), 1);
      },
      receive(spec, fn) {
        receives.push(fn);
        return () => receives.splice(receives.indexOf(fn), 1);
      },
    },
    commands: {
      register(entry) {
        commands.set(entry.id, entry);
      },
    },
    lifecycle: {
      onDispose(fn) {
        disposers.push(fn);
      },
    },
    log: (...parts) => logs.push(parts.join(' ')),
    debug: (...parts) => logs.push(parts.join(' ')),
  };
  const host = {
    paths: { root },
    require: (name) => require(name),
    log: (...parts) => logs.push(parts.join(' ')),
    debug: (...parts) => logs.push(parts.join(' ')),
  };
  const result = activate(api, host);
  // One generic send hook in the plugin; feed a frame through all of them.
  const frames = (payload) => hooks.forEach((fn) => {
    try {
      fn({ stage: 'send', payload });
    } catch {
      /* the host isolates hook failures the same way */
    }
  });
  return { root, hooks, receives, frames, commands, disposers, logs, result };
}

check('stays unavailable while the kernel gate is closed', () => {
  const { result, root } = makeHarness({ kernel: false });
  assert.strictEqual(result.status, 'unavailable');
  assert.ok(result.reason.includes('OICQ_KERNEL_HOOKS'));
  fs.rmSync(root, { recursive: true, force: true });
});

const h = makeHarness();

check('subscribes to the outbound stream', () => {
  assert.ok(h.hooks.length >= 1);
});

const original = {
  msgId: '12345678abcdef',
  chatType: 2,
  peerUid: 'u_1',
  elements: [{ elementType: 1, textElement: { content: 'hello' } }],
};

check('remembers a normal message', () => {
  h.frames({ msgList: [original] });
  const stats = h.commands.get('anti-recall.stats').run();
  assert.strictEqual(stats.cached, 1);
  assert.strictEqual(stats.restored, 0);
});

check('restores a revoke frame from the cache', () => {
  const revoke = {
    msgId: original.msgId,
    chatType: 2,
    peerUid: 'u_1',
    elements: [{ elementType: 8, grayTipElement: { revokeElement: { operatorNick: 'peer' } } }],
  };
  h.frames({ msgList: [revoke] });
  assert.strictEqual(revoke.elements.length, 1);
  assert.strictEqual(revoke.elements[0].textElement.content, 'hello');
  const stats = h.commands.get('anti-recall.stats').run();
  assert.strictEqual(stats.restored, 1);
  assert.strictEqual(stats.cached, 1);
});

check('accepts the getMsgsIncludeSelf response shape', () => {
  const older = {
    msgId: 'aaaabbbbcccc',
    chatType: 1,
    peerUid: 'u_2',
    elements: [{ textElement: { content: 'older' } }],
  };
  h.frames({ result: { msgList: [older] } });
  assert.strictEqual(h.commands.get('anti-recall.stats').run().cached, 2);
});

check('caches a single-message send response', () => {
  h.frames({ msgId: 'single-1', chatType: 2, peerUid: 'u_1', elements: [{ textElement: { content: 'self' } }] });
  assert.strictEqual(h.commands.get('anti-recall.stats').run().cached, 3);
});

check('restores a revoke delivered as a single message', () => {
  const before = h.commands.get('anti-recall.stats').run().restored;
  h.frames({ msgId: 'single-1', elements: [{ grayTipElement: { revokeElement: {} } }] });
  const after = h.commands.get('anti-recall.stats').run().restored;
  assert.strictEqual(after, before + 1);
});

check('flush writes the store and is idempotent', () => {
  const first = h.commands.get('anti-recall.flush').run();
  assert.strictEqual(first.flushed, true);
  const second = h.commands.get('anti-recall.flush').run();
  assert.strictEqual(second.flushed, false);
  const saved = JSON.parse(fs.readFileSync(path.join(h.root, 'anti-recall-pro.json'), 'utf8'));
  assert.strictEqual(saved.length, 3);
  assert.ok(saved.some((item) => item.msgId === original.msgId));
});

check('dispose flushes and clears the timer', () => {
  h.disposers.forEach((fn) => fn());
  h.result.dispose();
  const stats = h.commands.get('anti-recall.stats').run();
  assert.ok(stats.writes >= 1);
});

check('bounded cache drops the oldest entry', () => {
  const bulk = makeHarness();
  for (let i = 0; i < 2005; i += 1) {
    bulk.frames({
        msgList: [{
          msgId: `bulk-${i}`,
          chatType: 1,
          peerUid: 'u',
          elements: [{ textElement: { content: String(i) } }],
        }],
    });
  }
  const stats = bulk.commands.get('anti-recall.stats').run();
  assert.strictEqual(stats.cached, 2000);
  assert.ok(stats.dropped >= 5);
  bulk.disposers.forEach((fn) => fn());
  bulk.result.dispose();
  fs.rmSync(bulk.root, { recursive: true, force: true });
});

fs.rmSync(h.root, { recursive: true, force: true });
console.log(checks.join('\n'));
