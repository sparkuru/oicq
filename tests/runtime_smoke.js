'use strict';
// Harness for the host runtime: loads runtime/main.js in plain Node (no
// Electron), with a temporary data root and the example plugin installed.
//
//   node tests/runtime_smoke.js
//
// Verifies: data root creation, plugin discovery, command registration, plugin
// storage, log file, the one-shot marker the inject expression relies on,
// live enable/disable with teardown, the interceptor chain, and route-scoped
// renderer contributions.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oicq-runtime-'));
process.env.OICQ_DATA_DIR = root;
// The config flag is the second gate input (the Linux launcher strips unknown
// environment variables). With no ipcMain in this harness the bridge cannot
// install, which is exactly the fallback path we want to observe.
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ kernel: { hooks: true } }));

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

function logText() {
  runtime.flushLogs();
  return fs.readFileSync(path.join(root, 'logs', 'runtime.log'), 'utf8');
}

(async () => {
  check('runtime marker installed', () => assert.ok(runtime));
  check('version reported', () => assert.strictEqual(typeof runtime.version, 'string'));
  check('data root honoured', () => assert.strictEqual(runtime.root, root));
  check('logs directory created', () => assert.ok(fs.existsSync(path.join(root, 'logs'))));
  check('plugin discovered', () => {
    const ids = runtime.plugins.list().map((plugin) => plugin.id);
    assert.ok(ids.includes('oicq-hello'), `got ${ids.join(',')}`);
  });
  check('builtin plugins ship with the runtime', () => {
    const ids = runtime.plugins.list().filter((entry) => entry.builtin).map((entry) => entry.id);
    for (const id of [
      'builtin:anti-recall', 'builtin:anti-recall-pro', 'builtin:pangu',
      'builtin:anti-jump-link',
      'builtin:no-update', 'builtin:anti-miniapp', 'builtin:image-viewer',
      'builtin:appearance',
    ]) {
      assert.ok(ids.includes(id), `${id} missing from ${ids.join(',')}`);
    }
  });
  check('config flag requests the bridge, missing ipcMain keeps it inactive', () => {
    const text = logText();
    assert.ok(text.includes('kernel bridge requested but ipcMain is unavailable'), text.slice(-400));
    assert.strictEqual(runtime.kernel().installed, false);
  });
  check('kernel-dependent builtins report unavailable without the gate', () => {
    const recall = runtime.plugins.list().find((entry) => entry.id === 'builtin:anti-recall');
    assert.ok(recall && recall.unavailable, 'anti-recall must flag itself unavailable');
    assert.ok(recall.unavailable.includes('OICQ_KERNEL_HOOKS'));
    const pro = runtime.plugins.list().find((entry) => entry.id === 'builtin:anti-recall-pro');
    assert.ok(pro && pro.unavailable, 'anti-recall-pro must flag itself unavailable');
    assert.ok(!runtime.commands.list().some((command) => command.id === 'anti-recall.stats'));
    assert.strictEqual(runtime.kernel().installed, false);
  });
  check('appearance works without the kernel gate', () => {
    const ids = runtime.commands.list().map((command) => command.id);
    for (const id of ['appearance.get', 'appearance.set', 'appearance.reset']) {
      assert.ok(ids.includes(id), `${id} missing`);
    }
    const appearance = runtime.plugins.list().find((entry) => entry.id === 'builtin:appearance');
    assert.strictEqual(appearance.unavailable, null);
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
    assert.ok(logText().includes('runtime'));
  });
  check('plugins only see the oicq api', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, 'plugins', 'oicq-hello', 'manifest.json'), 'utf8'),
    );
    assert.strictEqual(manifest.api, 2);
  });

  // ------------------------------------------------------- live enable/disable
  check('plugin interceptors visible in state', () => {
    const plugin = runtime.plugins.list().find((entry) => entry.id === 'oicq-hello');
    assert.deepStrictEqual(plugin.pipelines, ['command:run']);
  });

  const disabled = runtime.plugins.disable('oicq-hello');
  check('disable returns updated state', () => {
    assert.ok(disabled && disabled.ok);
    const row = disabled.state.plugins.find((entry) => entry.id === 'oicq-hello');
    assert.ok(row, 'a disabled plugin must stay listed so it can be re-enabled');
    assert.strictEqual(row.enabled, false);
    assert.strictEqual(row.loaded, false);
  });
  check('disable removes command and interceptor', () => {
    assert.ok(!runtime.commands.list().some((command) => command.id === 'hello.say'));
    assert.ok(!runtime.pipeline.list().some((entry) => entry.kind === 'command:run'));
  });
  check('disable calls module dispose then lifecycle hooks', () => {
    const text = logText();
    assert.ok(text.includes('dispose: module export'), 'module dispose missing');
    assert.ok(text.includes('dispose: lifecycle hook'), 'lifecycle hook missing');
  });
  check('disable persisted to config', () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    assert.deepStrictEqual(config.plugins.disabled, ['oicq-hello']);
  });

  const enabled = runtime.plugins.enable('oicq-hello');
  check('enable reloads the plugin', () => {
    assert.ok(enabled && enabled.ok);
    assert.ok(runtime.plugins.list().some((plugin) => plugin.id === 'oicq-hello'));
    assert.ok(runtime.commands.list().some((command) => command.id === 'hello.say'));
  });
  check('enable clears the disabled entry', () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    assert.deepStrictEqual(config.plugins.disabled, []);
  });

  // --------------------------------------------------------------- pipelines
  let seen = 0;
  const off = runtime.pipeline.before('command:run', (context) => {
    seen += 1;
    context.payload = { ...(context.payload || {}), host: true };
  });
  const ran = await runtime.invoke({ type: 'command:run', id: 'hello.say' });
  check('host interceptor ran before the command', () => {
    assert.strictEqual(seen, 1);
    assert.ok(ran && ran.ok);
  });
  off();
  await runtime.invoke({ type: 'command:run', id: 'hello.say' });
  check('interceptor disposer removes only its own entry', () => assert.strictEqual(seen, 1));

  const cancelOff = runtime.pipeline.before('command:run', (context) => {
    context.cancel = true;
  });
  const cancelled = await runtime.invoke({ type: 'command:run', id: 'hello.say' });
  cancelOff();
  check('cancel stops the command', () => {
    assert.ok(cancelled && cancelled.cancelled === true);
    assert.strictEqual(cancelled.ok, false);
  });

  const reloaded = await runtime.invoke({ type: 'plugin:reload' });
  check('reload replaces registrations instead of stacking them', () => {
    assert.ok(reloaded && reloaded.api === 2);
    const commandIds = runtime.commands.list().filter((entry) => entry.id === 'hello.say');
    assert.strictEqual(commandIds.length, 1);
    const chain = runtime.pipeline.list().find((entry) => entry.kind === 'command:run');
    assert.strictEqual(chain.handlers.length, 1, JSON.stringify(chain));
  });

  // ------------------------------------------------------------ builtin toggle
  const offAppearance = runtime.plugins.disable('builtin:appearance');
  check('disabling a builtin keeps it listed', () => {
    assert.ok(offAppearance && offAppearance.ok);
    const row = offAppearance.state.plugins.find((entry) => entry.id === 'builtin:appearance');
    assert.ok(row && row.builtin, 'builtin row missing');
    assert.strictEqual(row.enabled, false);
    assert.strictEqual(row.loaded, false);
  });
  check('disabling a builtin removes its commands', () => {
    assert.ok(!runtime.commands.list().some((command) => command.id === 'appearance.get'));
  });
  const onAppearance = runtime.plugins.enable('builtin:appearance');
  check('enabling a builtin reloads it', () => {
    assert.ok(onAppearance && onAppearance.ok);
    assert.ok(runtime.commands.list().some((command) => command.id === 'appearance.get'));
  });

  // ------------------------------------------------------- renderer routing
  const tags = (hash) => runtime.contributions(hash).map((item) => `${item.id}#${item.key}`);
  check('every route gets the "*" contributions', () => {
    const all = tags('');
    assert.ok(all.includes('oicq-hello#*'), all.join(','));
    assert.ok(all.includes('builtin:appearance#*'), all.join(','));
  });
  check('a route contribution is added on top of "*"', () => {
    const settings = tags('#/setting/settings');
    assert.ok(settings.includes('oicq-hello#*'));
    assert.ok(settings.includes('oicq-hello##/setting/settings'), settings.join(','));
  });
  check('unrelated routes do not get the settings file', () => {
    const other = tags('#/main');
    assert.ok(other.includes('oicq-hello#*'));
    assert.ok(!other.some((tag) => tag.includes('#/setting/settings')), other.join(','));
  });

  // An external plugin must not be able to ask for kernel hooks: the manifest
  // is rejected and the plugin never loads.
  const bad = path.join(root, 'plugins', 'bad-kernel');
  fs.cpSync(pluginSource, bad, { recursive: true });
  const badManifest = JSON.parse(fs.readFileSync(path.join(bad, 'manifest.json'), 'utf8'));
  badManifest.id = 'bad-kernel';
  badManifest.permissions = ['kernel'];
  fs.writeFileSync(path.join(bad, 'manifest.json'), JSON.stringify(badManifest));
  await runtime.invoke({ type: 'plugin:reload' });
  check('external plugins cannot request kernel hooks', () => {
    const row = runtime.plugins.list().find((entry) => entry.id === 'bad-kernel');
    assert.ok(row && row.loaded === false, 'bad-kernel must not load');
    assert.ok(logText().includes('kernel permission is builtin-only'));
  });

  console.log(checks.join('\n'));
})()
  .catch((error) => {
    checks.push(`FAIL harness: ${error && error.stack}`);
    process.exitCode = 1;
    console.log(checks.join('\n'));
  })
  .finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
