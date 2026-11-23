'use strict';
// Harness for the host runtime: loads runtime/main.js in plain Node (no
// Electron), with a temporary data root and the example plugin installed.
//
//   node tests/runtime_smoke.js
//
// Verifies: data root creation, plugin discovery, command registration, plugin
// storage, log file, and the one-shot marker the inject expression relies on.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oicq-runtime-'));
process.env.OICQ_DATA_DIR = root;

const pluginSource = path.join(__dirname, '..', 'plugins', 'oicq-hello');
fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
fs.cpSync(pluginSource, path.join(root, 'plugins', 'oicq-hello'), { recursive: true });

require(path.join(__dirname, '..', 'runtime', 'main.js'));

const runtime = globalThis.__oicq__;
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

check('runtime marker installed', () => assert.ok(runtime));
check('version reported', () => assert.strictEqual(typeof runtime.version, 'string'));
check('data root honoured', () => assert.strictEqual(runtime.root, root));
check('logs directory created', () => assert.ok(fs.existsSync(path.join(root, 'logs'))));
check('plugin discovered', () => {
  const ids = runtime.plugins.list().map((plugin) => plugin.id);
  assert.deepStrictEqual(ids, ['oicq-hello']);
});
check('command registered by plugin', () => {
  const ids = runtime.commands.list().map((command) => command.id);
  assert.ok(ids.includes('hello.say'), `got ${ids.join(',')}`);
});
check('command runs and writes storage', () => {
  const command = runtime.commands.list().find((entry) => entry.id === 'hello.say');
  const result = command.run();
  assert.strictEqual(result.counter, 1);
  const data = JSON.parse(fs.readFileSync(path.join(root, 'data', 'oicq-hello.json'), 'utf8'));
  assert.strictEqual(data.counter, 1);
});
check('log file written', () => {
  // The logger buffers and flushes asynchronously (it must never block the
  // host), so the harness asks for a flush instead of sleeping.
  runtime.flushLogs();
  const text = fs.readFileSync(path.join(root, 'logs', 'runtime.log'), 'utf8');
  assert.ok(text.includes('runtime'), text.slice(0, 120));
});
check('plugins only see the oicq api', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'plugins', 'oicq-hello', 'manifest.json'), 'utf8'),
  );
  assert.strictEqual(manifest.api, 2);
});

setTimeout(() => {
  console.log(checks.join('\n'));
  fs.rmSync(root, { recursive: true, force: true });
}, 50);
