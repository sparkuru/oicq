'use strict';
// oicq host runtime — injected into the QQNT main process.
//
// This file is embedded into the shared library at build time and written to
// <tmp>/oicq/boot.cjs by the native layer. The native side only knows how to
// prepend `require('<that file>')`; everything below is plain JavaScript and is
// meant to be edited freely — it is the mod, not a reconstruction of anything.
//
// Responsibilities
//   1. own the data root (<root>/config.json, plugins/, data/, logs/)
//   2. host plugins in isolated vm contexts with a small permission model
//   3. serve the renderer UI over IPC (window.oicq in the renderer)
//   4. expose globalThis.__oicq__ so the inject expression is one-shot
//
// Channel names are defined exactly once, here and in renderer.js.

(function installOicq() {
  if (globalThis.__oicq__) return;

  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const vm = require('vm');

  const VERSION = '0.2.2';
  const API_VERSION = 2;

  const CHANNELS = {
    request: 'oicq:request',
    bundle: 'oicq:bundle',
    invoke: 'oicq:invoke',
    push: 'oicq:push',
  };

  const DEFAULT_CONFIG = {
    enabled: true,
    ui: {
      enabled: true,
      hotkey: 'CmdOrCtrl+Shift+O',
      palette: 'CmdOrCtrl+K',
      accent: '#5b8cff',
      density: 'comfortable',
      dock: 'right',
      width: 344,
      autoOpen: false,
    },
    plugins: { enabled: null, disabled: [] },
    // Test-only automation for the login window. Off by default; the panel
    // never exposes it.
    test: {
      autoLogin: false,
      dumpLogin: false,
      autoOpenChat: false,
      sendSelf: '',
      sendSelfCurrent: false,
      sendSelfDry: false,
      dumpDom: false,
      markFirst: false,
    },
    // Second switch for the kernel bridge: QQ's launcher strips unknown
    // environment variables on Linux, so a config flag is the only reliable
    // opt-in there. Both are off by default; either one enables the bridge.
    kernel: { hooks: false },
    log: { level: 'info' },
  };

  // ---------------------------------------------------------------- data root
  function resolveRoot() {
    const configured = process.env.OICQ_DATA_DIR;
    if (configured && path.isAbsolute(configured)) return configured;
    return path.join(os.homedir(), '.oicq');
  }

  const root = resolveRoot();
  const paths = {
    root,
    config: path.join(root, 'config.json'),
    plugins: path.join(root, 'plugins'),
    data: path.join(root, 'data'),
    logs: path.join(root, 'logs'),
    logFile: path.join(root, 'logs', 'runtime.log'),
  };

  function ensureDirs() {
    for (const dir of [paths.root, paths.plugins, paths.data, paths.logs]) {
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch (error) {
        // A read-only root must not take the client down; logging degrades.
      }
    }
  }

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  function writeJson(file, value) {
    const temp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
      fs.renameSync(temp, file);
      return true;
    } catch {
      try {
        fs.unlinkSync(temp);
      } catch {
        /* nothing to clean */
      }
      return false;
    }
  }

  ensureDirs();

  // ---------------------------------------------------------------------- log
  const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
  let config = mergeConfig(DEFAULT_CONFIG, readJson(paths.config, {}));
  let level = LEVELS[config.log && config.log.level] ?? LEVELS.info;

  function mergeConfig(base, patch) {
    if (!patch || typeof patch !== 'object') return { ...base };
    const out = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      if (value && typeof value === 'object' && !Array.isArray(value) &&
          base[key] && typeof base[key] === 'object') {
        out[key] = mergeConfig(base[key], value);
      } else if (value !== undefined) {
        out[key] = value;
      }
    }
    return out;
  }

  function stamp() {
    return new Date().toISOString().replace('T', ' ').replace('Z', '');
  }

  // Logging must never stall the main process. QQNT's own console output bursts
  // during login, and one synchronous append per line (plus a stat for rotation)
  // is enough to make the app look hung and get relaunched by its watchdog.
  // Lines are buffered and flushed asynchronously; rotation is checked at most
  // once a minute.
  let pending = [];
  let flushTimer = null;
  let lastRotateCheck = 0;

  // `sync` is for explicit drains (process exit, diagnostics); the hot path
  // always goes through the async flush.
  function flush(sync = false) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pending.length === 0) return;
    const chunk = `${pending.join('\n')}\n`;
    pending = [];
    try {
      if (sync) fs.appendFileSync(paths.logFile, chunk);
      else fs.appendFile(paths.logFile, chunk, () => {});
    } catch {
      /* never break the host over a log line */
    }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, 250);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  }

  function maybeRotate() {
    const now = Date.now();
    if (now - lastRotateCheck < 60_000) return;
    lastRotateCheck = now;
    // stat() on the data root is one of the paths the observation-surface layer
    // answers with ENOENT, so size is read through a descriptor: open() is not
    // part of the hidden surface.
    try {
      const fd = fs.openSync(paths.logFile, 'r');
      let size = 0;
      try {
        size = fs.fstatSync(fd).size;
      } finally {
        fs.closeSync(fd);
      }
      if (size > 2 * 1024 * 1024) fs.renameSync(paths.logFile, `${paths.logFile}.1`);
    } catch {
      /* no file yet */
    }
  }

  function log(lvl, ...parts) {
    const value = LEVELS[lvl] ?? LEVELS.info;
    if (value > level) return;
    const text = parts
      .map((part) => (typeof part === 'string' ? part : stringify(part)))
      .join(' ')
      .replace(/\s+/g, ' ')
      .slice(0, 600);
    const line = `${stamp()} ${lvl.toUpperCase().padEnd(5)} ${text}`;
    if (lvl === 'error' || lvl === 'warn') process.stderr.write(`[oicq] ${line}\n`);
    pending.push(line);
    if (pending.length > 400) flush();
    else scheduleFlush();
    maybeRotate();
  }

  function stringify(value) {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  // ------------------------------------------------------------------ command
  const commands = new Map(); // id -> {id, title, hint, run, plugin}
  const listeners = new Map(); // event -> Set<{fn, owner}>
  const pipelines = new Map(); // kind -> [{owner, fn}]

  function registerCommand(entry) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.run !== 'function') {
      throw new Error('command needs {id, run}');
    }
    if (commands.has(entry.id)) throw new Error(`duplicate command ${entry.id}`);
    commands.set(entry.id, {
      id: entry.id,
      title: entry.title || entry.id,
      hint: entry.hint || '',
      plugin: entry.plugin || null,
      run: entry.run,
    });
  }

  function on(event, handler, owner = null) {
    if (typeof handler !== 'function') throw new Error('listener must be a function');
    if (!listeners.has(event)) listeners.set(event, new Set());
    const entry = { fn: handler, owner };
    listeners.get(event).add(entry);
    return () => listeners.get(event)?.delete(entry);
  }

  async function emit(event, payload) {
    // Host events run through the same interceptor shape as command:run, so a
    // plugin can rewrite or veto its own delivery without wrapping emit.
    const chain = pipelines.get('event');
    if (chain && chain.length) {
      const context = await runPipeline('event', {
        kind: 'event',
        event,
        payload,
        cancel: false,
      });
      if (context.cancel) return [];
      payload = context.payload;
    }
    const handlers = listeners.get(event);
    if (!handlers) return [];
    const results = [];
    for (const entry of handlers) {
      try {
        results.push(await entry.fn(payload));
      } catch (error) {
        log('warn', `listener ${event} failed:`, error && error.message);
      }
    }
    return results;
  }

  // Interceptors. These are the host's own entry points, not QQNT's IPC: a
  // plugin registers a function, the host runs it in registration order before
  // it acts, and `{cancel:true}` on the context stops the chain and the action.
  // That keeps the capability equivalent to a middleware chain while leaving
  // `ipcMain`/`sender.send` untouched (see docs/12-visibility.md).
  function addPipeline(owner, kind, fn) {
    if (typeof kind !== 'string' || !kind) throw new Error('pipeline kind must be a string');
    if (typeof fn !== 'function') throw new Error('pipeline handler must be a function');
    if (!pipelines.has(kind)) pipelines.set(kind, []);
    const entry = { owner, fn };
    pipelines.get(kind).push(entry);
    return () => {
      const chain = pipelines.get(kind);
      if (!chain) return false;
      const index = chain.indexOf(entry);
      if (index === -1) return false;
      chain.splice(index, 1);
      if (!chain.length) pipelines.delete(kind);
      return true;
    };
  }

  function removePipelines(owner) {
    for (const [kind, chain] of pipelines) {
      const kept = chain.filter((entry) => entry.owner !== owner);
      if (kept.length) pipelines.set(kind, kept);
      else pipelines.delete(kind);
    }
  }

  async function runPipeline(kind, context) {
    const chain = pipelines.get(kind);
    if (!chain || !chain.length) return context;
    for (const entry of chain.slice()) {
      if (context.cancel) break;
      try {
        const result = await entry.fn(context);
        if (result && typeof result === 'object') Object.assign(context, result);
      } catch (error) {
        log('warn', `pipeline ${kind} (${entry.owner || 'host'}) failed:`,
            error && error.message);
      }
    }
    return context;
  }

  function pipelineSummary() {
    return [...pipelines.entries()].map(([kind, chain]) => ({
      kind,
      handlers: chain.map((entry) => entry.owner || 'host'),
    }));
  }

  // ------------------------------------------------------------- kernel hooks
  // Synchronous, matcher-scoped interceptors for the optional kernel bridge
  // (runtime/kernel.js). Kept separate from `pipelines` on purpose: an IPC frame
  // cannot await, so an async handler here would silently lose its effect.
  const kernelHooks = { receive: [], send: [] };
  let kernelBridge = null;
  // Frame counters: enough to prove the bridge parses real traffic without
  // turning every IPC into a log line. The first frames also go to debug.
  const kernelStats = { receive: 0, send: 0, methods: new Map(), events: new Map() };
  let frameLogBudget = 40;

  function noteKernelFrame(stage, context) {
    kernelStats[stage] += 1;
    const key = stage === 'receive'
      ? context.method
      : (context.eventName || context.cmd);
    if (key) {
      const table = stage === 'receive' ? kernelStats.methods : kernelStats.events;
      if (table.size < 200 || table.has(key)) table.set(key, (table.get(key) || 0) + 1);
    }
    if (frameLogBudget > 0) {
      frameLogBudget -= 1;
      log(
        'debug',
        `kernel ${stage}`,
        context.channel || '-',
        stage === 'receive' ? (context.method || '-') : (context.eventName || context.cmd || '-'),
        stage === 'receive' ? `callback=${context.callbackId}` : `cmd=${context.cmd || '-'}`,
      );
    }
  }

  // One gate for every kernel capability. The bridge installs only with
  // OICQ_KERNEL_HOOKS=1, and a plugin that asks for a hook while it is off gets
  // a hard failure instead of a registration that never fires.
  const kernelEnabled = () => Boolean(kernelBridge && kernelBridge.isInstalled());
  const kernelHooksRequested = () =>
    process.env.OICQ_KERNEL_HOOKS === '1'
    || Boolean(config.kernel && config.kernel.hooks === true);

  function makeKernelMatcher(spec) {
    if (!spec || typeof spec !== 'object') return () => true;
    const test = (value, want) => {
      if (want === undefined || want === null) return true;
      if (Array.isArray(want)) return want.includes(value);
      if (want instanceof RegExp) return want.test(String(value));
      return value === want;
    };
    return (context) =>
      test(context.channel, spec.channel) &&
      test(context.method, spec.method) &&
      test(context.eventName, spec.event) &&
      test(context.cmd, spec.cmd);
  }

  function addKernelHook(stage, owner, spec, fn) {
    if (!kernelEnabled()) {
      throw new Error('kernel hooks are disabled (start with OICQ_KERNEL_HOOKS=1)');
    }
    if (typeof fn !== 'function') throw new Error('kernel hook must be a function');
    if (fn.constructor && fn.constructor.name === 'AsyncFunction') {
      throw new Error('kernel hooks are synchronous; use api.pipeline for async work');
    }
    const entry = { owner, matcher: makeKernelMatcher(spec), fn };
    kernelHooks[stage].push(entry);
    return () => {
      const chain = kernelHooks[stage];
      const index = chain.indexOf(entry);
      if (index === -1) return false;
      chain.splice(index, 1);
      return true;
    };
  }

  function removeKernelHooks(owner) {
    for (const stage of ['receive', 'send']) {
      kernelHooks[stage] = kernelHooks[stage].filter((entry) => entry.owner !== owner);
    }
  }

  function dispatchKernel(stage, context) {
    noteKernelFrame(stage, context);
    for (const entry of kernelHooks[stage].slice()) {
      if (context.cancel) break;
      if (!entry.matcher(context)) continue;
      try {
        const result = entry.fn(context);
        if (result && typeof result.then === 'function') {
          log('warn', `kernel ${stage} hook ${entry.owner} returned a promise; ignored`);
        } else if (result && typeof result === 'object') {
          Object.assign(context, result);
        }
      } catch (error) {
        log('warn', `kernel ${stage} hook ${entry.owner} failed:`, error && error.message);
      }
    }
    return context;
  }

  function kernelSummary() {
    const top = (table) => [...table.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    return {
      installed: Boolean(kernelBridge && kernelBridge.isInstalled()),
      receive: kernelHooks.receive.map((entry) => entry.owner),
      send: kernelHooks.send.map((entry) => entry.owner),
      frames: {
        receive: kernelStats.receive,
        send: kernelStats.send,
        methods: top(kernelStats.methods),
        events: top(kernelStats.events),
      },
    };
  }

  // --------------------------------------------------------------- plugin host
  const plugins = new Map(); // id -> {manifest, api, state}

  function validateRendererContribution(contribution) {
    const validFile = (file) =>
      typeof file === 'string' && file.length > 0 && !file.includes('..');
    if (contribution == null) return null;
    if (typeof contribution === 'string') {
      return validFile(contribution) ? null : 'invalid renderer contribution';
    }
    if (typeof contribution === 'object' && !Array.isArray(contribution)) {
      for (const [route, file] of Object.entries(contribution)) {
        // "*" applies everywhere; anything else must be a hash route such as
        // "#/setting/settings", which is what the client puts in location.hash.
        if (route !== '*' && !route.startsWith('#/')) return `invalid renderer route ${route}`;
        if (!validFile(file)) return `invalid renderer contribution ${route}`;
      }
      return null;
    }
    return 'invalid renderer contribution';
  }

  function validateManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') return 'manifest is not an object';
    if (typeof manifest.id !== 'string' || !/^[a-z0-9_.-]+$/i.test(manifest.id)) {
      return 'invalid id';
    }
    if (manifest.api !== API_VERSION) return `unsupported api ${manifest.api}`;
    if (Array.isArray(manifest.permissions) && manifest.permissions.includes('kernel')) {
      return 'kernel permission is builtin-only';
    }
    if (Array.isArray(manifest.requires) && manifest.requires.includes('kernel')) {
      return 'kernel requirement is builtin-only';
    }
    if (typeof manifest.main !== 'string' || manifest.main.includes('..')) {
      return 'invalid main';
    }
    if (manifest.contributes && manifest.contributes.renderer) {
      return validateRendererContribution(manifest.contributes.renderer);
    }
    return null;
  }

  function pluginApi(manifest, pluginDir, lifecycle) {
    const permissions = new Set(Array.isArray(manifest.permissions) ? manifest.permissions : []);
    const dataFile = path.join(paths.data, `${manifest.id}.json`);
    const deny = (what) => {
      throw new Error(`permission denied: ${what}`);
    };
    const scopedFs = {
      read(file) {
        if (!permissions.has('fs')) return deny('fs');
        const resolved = path.resolve(pluginDir, file);
        if (!resolved.startsWith(pluginDir + path.sep)) return deny('fs scope');
        return fs.readFileSync(resolved, 'utf8');
      },
      readData() {
        return readJson(dataFile, {});
      },
      writeData(value) {
        if (!permissions.has('storage')) return deny('storage');
        return writeJson(dataFile, value);
      },
    };
    return Object.freeze({
      version: API_VERSION,
      id: manifest.id,
      log: (...parts) => log('info', `[${manifest.id}]`, ...parts),
      debug: (...parts) => log('debug', `[${manifest.id}]`, ...parts),
      fs: scopedFs,
      commands: {
        register: (entry) => registerCommand({ ...entry, plugin: manifest.id }),
        list: () => [...commands.values()].filter((c) => c.plugin === manifest.id),
      },
      events: {
        on: (event, handler) => on(event, handler, manifest.id),
        emit,
      },
      lifecycle: {
        onDispose: (fn) => lifecycle.addDispose(fn),
      },
      pipeline: {
        before: (kind, fn) => addPipeline(manifest.id, kind, fn),
        list: () => pipelineSummary(),
      },
      // Kernel hooks are builtin-only: an external plugin has no signature and
      // must not be able to observe or rewrite every IPC frame. `enabled` is
      // false unless OICQ_KERNEL_HOOKS=1 actually installed the bridge.
      kernel: manifest.builtin
        ? Object.freeze({
          // Ask before registering: with the gate closed there is no bridge to
          // observe, so a plugin must report itself unavailable instead of
          // pretending to work.
          get available() {
            return kernelEnabled();
          },
          receive: (spec, fn) => addKernelHook('receive', manifest.id, spec, fn),
          send: (spec, fn) => addKernelHook('send', manifest.id, spec, fn),
        })
        : null,
      ui: {
        notify: (text) => push({ kind: 'toast', text: String(text) }),
        refresh: () => push({ kind: 'refresh' }),
        // Arbitrary payload for this plugin's renderer contribution. The page
        // routes it to handlers registered with oicq.onMessage(payload, id).
        push: (payload) => push({ kind: 'plugin', id: manifest.id, payload }),
      },
    });
  }

  function loadPlugin(entry) {
    const pluginDir = path.join(paths.plugins, entry);
    const manifest = readJson(path.join(pluginDir, 'manifest.json'), null);
    const error = validateManifest(manifest);
    if (error) {
      log('warn', `skip ${entry}: ${error}`);
      return null;
    }
    if (manifest.id !== entry) {
      log('warn', `skip ${entry}: id mismatch (${manifest.id})`);
      return null;
    }
    // A reload must tear the old instance down before the new one registers:
    // unloading afterwards would delete the commands, listeners and
    // interceptors the new instance just added (they carry the same owner id).
    if (plugins.has(manifest.id)) unloadPlugin(manifest.id);
    let source;
    try {
      source = fs.readFileSync(path.join(pluginDir, manifest.main), 'utf8');
    } catch (readError) {
      log('warn', `skip ${entry}: cannot read ${manifest.main}`);
      return null;
    }
    const lifecycle = createLifecycle();
    const api = pluginApi(manifest, pluginDir, lifecycle);
    const sandbox = {
      console: {
        log: (...a) => api.log(...a),
        info: (...a) => api.log(...a),
        warn: (...a) => log('warn', `[${manifest.id}]`, ...a),
        error: (...a) => log('error', `[${manifest.id}]`, ...a),
      },
      require: (name) => {
        if (name !== 'oicq/api') throw new Error(`module ${name} is not available`);
        return api;
      },
      module: { exports: {} },
      exports: {},
      process: { env: { OICQ_DATA_DIR: paths.data }, platform: process.platform },
      __filename: path.join(pluginDir, manifest.main),
      __dirname: pluginDir,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    };
    sandbox.globalThis = sandbox;
    sandbox.exports = sandbox.module.exports;
    try {
      vm.runInNewContext(source, sandbox, {
        filename: path.join(pluginDir, manifest.main),
        timeout: 5000,
      });
    } catch (runError) {
      log('error', `failed ${manifest.id}:`, runError && runError.message);
      return null;
    }
    const record = {
      manifest,
      api,
      dir: pluginDir,
      entry: manifest.id,
      disposers: lifecycle.disposers,
      exports: sandbox.module.exports,
    };
    plugins.set(manifest.id, record);
    log('info', `loaded ${manifest.id}@${manifest.version || '0'}`);
    return record;
  }

  // Teardown order: exported dispose first (it may still want the host), then
  // every api.lifecycle.onDispose callback, then strip the registrations the
  // plugin made. Anything it forgot is removed here, so "disabled" really means
  // no commands, no listeners, no interceptors.
  function unloadPlugin(id) {
    const record = plugins.get(id);
    if (!record) return false;
    plugins.delete(id);
    if (record.exports && typeof record.exports.dispose === 'function') {
      try {
        record.exports.dispose();
      } catch (error) {
        log('warn', `${id} dispose failed:`, error && error.message);
      }
    }
    for (const fn of record.disposers) {
      try {
        fn();
      } catch (error) {
        log('warn', `${id} disposer failed:`, error && error.message);
      }
    }
    record.disposers.clear();
    for (const [commandId, command] of commands) {
      if (command.plugin === id) commands.delete(commandId);
    }
    for (const [event, set] of listeners) {
      for (const entry of set) {
        if (entry.owner === id) set.delete(entry);
      }
      if (!set.size) listeners.delete(event);
    }
    removePipelines(id);
    removeKernelHooks(id);
    log('info', `unloaded ${id}`);
    return true;
  }

  function listPluginDirs() {
    try {
      return fs
        .readdirSync(paths.plugins, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name)
        .sort();
    } catch {
      return [];
    }
  }

  // Live enable/disable. The reference implementation does the same thing with
  // one disposer per built-in plugin; here it is one code path for every
  // plugin, and it never reloads the ones that did not change.
  function setPluginEnabled(id, enabled) {
    if (typeof id !== 'string' || !id) return { ok: false, error: 'plugin id required' };
    const isBuiltin = id.startsWith('builtin:');
    const known = isBuiltin
      ? fs.existsSync(path.join(__dirname, builtinFileFor(id)))
      : listPluginDirs().includes(id);
    if (!known && !plugins.has(id)) {
      return { ok: false, error: `unknown plugin ${id}` };
    }
    config.plugins = config.plugins && typeof config.plugins === 'object' ? config.plugins : {};
    const disabled = new Set(
      Array.isArray(config.plugins.disabled) ? config.plugins.disabled : [],
    );
    const allow = Array.isArray(config.plugins.enabled)
      ? new Set(config.plugins.enabled)
      : null;
    if (enabled) {
      disabled.delete(id);
      if (allow) allow.add(id);
    } else {
      disabled.add(id);
      if (allow) allow.delete(id);
    }
    // Config is updated before the load because the loader consults the
    // disabled list; a failed load rolls the switch back so the file never
    // claims a plugin is on when it is not.
    const previousDisabled = Array.isArray(config.plugins.disabled)
      ? [...config.plugins.disabled]
      : [];
    config.plugins.disabled = [...disabled];
    if (allow) config.plugins.enabled = [...allow];
    if (enabled) {
      if (!plugins.has(id)) {
        const record = id.startsWith('builtin:')
          ? loadBuiltin(builtinFileFor(id), id)
          : loadPlugin(id);
        if (!record) {
          config.plugins.disabled = previousDisabled;
          return { ok: false, error: `cannot load ${id}` };
        }
      }
    } else {
      unloadPlugin(id);
    }
    writeJson(paths.config, config);
    log('info', `${enabled ? 'enabled' : 'disabled'} ${id}`);
    push({ kind: 'refresh' });
    return { ok: true, state: state() };
  }

  function createLifecycle() {
    return {
      disposers: new Set(),
      addDispose(fn) {
        if (typeof fn !== 'function') return () => {};
        this.disposers.add(fn);
        return () => this.disposers.delete(fn);
      },
    };
  }

  // Builtin plugins ship inside the payload as `builtin-<name>.cjs` and are the
  // in-process counterpart of an external plugin: same api object, same
  // lifecycle, plus api.kernel and host.require. There is no manifest file; the
  // record is built here so state(), the panel and enable/disable treat them
  // exactly like external plugins (ids are namespaced `builtin:`).
  // Two layouts exist on purpose: the embedded payload is flat
  // (`builtin-<name>.cjs`, because the native writer creates no subdirectories),
  // while the source tree keeps `runtime/builtin/<name>.js`. Both are
  // enumerated here so `node tests/runtime_smoke.js` exercises the real files.
  function builtinFiles() {
    const found = new Map();
    const add = (id, file) => {
      if (!found.has(id)) found.set(id, file);
    };
    try {
      for (const name of fs.readdirSync(__dirname)) {
        if (name.startsWith('builtin-') && name.endsWith('.cjs')) {
          add(`builtin:${name.slice('builtin-'.length, -'.cjs'.length)}`, name);
        }
      }
    } catch {
      /* payload directory is always readable; a failure means no builtins */
    }
    try {
      const dir = path.join(__dirname, 'builtin');
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.js')) {
          add(`builtin:${name.slice(0, -'.js'.length)}`, path.join('builtin', name));
        }
      }
    } catch {
      /* source tree without builtins */
    }
    return [...found.entries()]
      .map(([id, file]) => ({ id, file }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  function builtinFileFor(id) {
    const base = id.slice('builtin:'.length);
    const flat = `${base}.cjs`;
    if (fs.existsSync(path.join(__dirname, flat))) return flat;
    return path.join('builtin', `${base}.js`);
  }

  function hostHandle() {
    return {
      require,
      log,
      paths,
      config: () => config,
      electron,
      kernel: kernelBridge,
      version: VERSION,
      api: API_VERSION,
      openExternal(url) {
        try {
          if (electron && electron.shell) {
            electron.shell.openExternal(String(url));
            return true;
          }
        } catch (error) {
          log('warn', 'openExternal failed:', error && error.message);
        }
        return false;
      },
      openPath(file) {
        try {
          if (electron && electron.shell) {
            electron.shell.openPath(String(file));
            return true;
          }
        } catch (error) {
          log('warn', 'openPath failed:', error && error.message);
        }
        return false;
      },
    };
  }

  function loadBuiltin(file, id) {
    const pluginId = id || `builtin:${path.basename(file).replace(/^builtin-/, '').replace(/\.(c|j)s$/, '')}`;
    const disabled = new Set(
      (config.plugins && Array.isArray(config.plugins.disabled) ? config.plugins.disabled : []),
    );
    if (disabled.has(pluginId)) {
      log('info', `skip ${pluginId}: disabled`);
      return null;
    }
    let source;
    try {
      source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    } catch (error) {
      log('warn', `cannot read ${file}:`, error && error.message);
      return null;
    }
    const manifest = {
      id: pluginId,
      name: pluginId.slice('builtin:'.length),
      version: VERSION,
      api: API_VERSION,
      builtin: true,
      permissions: ['fs', 'storage', 'kernel'],
    };
    const lifecycle = createLifecycle();
    const api = pluginApi(manifest, __dirname, lifecycle);
    let result;
    try {
      // Builtins run in the host realm (no vm context): they are part of the
      // payload, not third-party code, and they need host.require to touch the
      // kernel bridge and the filesystem. `module`/`exports` are passed in
      // explicitly so the file cannot reach the host module's own exports.
      const host = hostHandle();
      const mod = { exports: {} };
      const factory = vm.compileFunction(
        source,
        ['api', 'host', 'module', 'exports'],
        { filename: file },
      );
      factory(api, host, mod, mod.exports);
      if (typeof mod.exports !== 'function') {
        throw new Error('builtin must export an activate(api, host) function');
      }
      result = mod.exports(api, host);
    } catch (error) {
      log('error', `failed ${pluginId}:`, error && (error.stack || error.message));
      return null;
    }
    const exported = typeof result === 'function' ? { dispose: result } : result || {};
    const unavailable = exported.status === 'unavailable'
      ? String(exported.reason || 'unavailable')
      : null;
    const record = {
      manifest,
      api,
      dir: __dirname,
      entry: pluginId,
      disposers: lifecycle.disposers,
      exports: exported,
      rendererSource: typeof exported.renderer === 'string' ? exported.renderer : null,
      builtin: true,
      unavailable,
    };
    if (plugins.has(pluginId)) unloadPlugin(pluginId);
    plugins.set(pluginId, record);
    log('info', `loaded ${pluginId}`);
    return record;
  }

  function scanBuiltins() {
    for (const entry of builtinFiles()) loadBuiltin(entry.file, entry.id);
  }

  function scanPlugins() {
    const disabled = new Set(
      (config.plugins && Array.isArray(config.plugins.disabled) ? config.plugins.disabled : []),
    );
    const allow = config.plugins && Array.isArray(config.plugins.enabled)
      ? new Set(config.plugins.enabled)
      : null;
    for (const entry of listPluginDirs()) {
      if (entry.startsWith('_')) continue; // template / scratch directories
      if (disabled.has(entry)) continue;
      if (allow && !allow.has(entry)) continue;
      loadPlugin(entry);
    }
  }

  // ------------------------------------------------------------- renderer side
  let electron = null;
  try {
    electron = require('electron');
  } catch {
    log('info', 'electron not resolvable; renderer UI disabled');
  }

  // The UI script is pushed into the page from the main process. Nothing is
  // registered on the session: the reference implementation on Linux does the
  // same, and a session-level preload is an extra, host-visible surface.
  // Existence is decided by the read itself: access()/stat() on the payload
  // directory are answered with ENOENT by the observation-surface layer, while
  // open() still resolves, so a probe would reject a file that reads fine.
  function rendererSource() {
    const candidates = [process.env.OICQ_RENDERER_PATH, path.join(__dirname, 'renderer.js')]
      .filter(Boolean);
    for (const candidate of candidates) {
      try {
        return fs.readFileSync(candidate, 'utf8');
      } catch {
        continue;
      }
    }
    log('warn', 'renderer.js not found next to the runtime');
    return null;
  }

  // A contribution is either one file (loaded everywhere) or a map from
  // location.hash to file. "*" is always injected; an exact route adds its file
  // on top of it. This is the reference implementation's `frontendInjection[hash]`
  // idea, but the host decides when to inject (on load and on in-page
  // navigation) instead of the page polling its own hash every second.
  function contributionsFor(hash) {
    const route = typeof hash === 'string' ? hash : '';
    const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
    const out = [];
    for (const record of plugins.values()) {
      if (record.rendererSource) {
        // Builtins carry their renderer as source, not as a file next to them.
        out.push({ id: record.manifest.id, key: '*', source: record.rendererSource });
      }
      const contribution = record.manifest.contributes && record.manifest.contributes.renderer;
      if (!contribution) continue;
      if (typeof contribution === 'string') {
        out.push({ id: record.manifest.id, key: '*', file: contribution });
        continue;
      }
      if (has(contribution, '*')) {
        out.push({ id: record.manifest.id, key: '*', file: contribution['*'] });
      }
      if (route && route !== '*' && has(contribution, route)) {
        out.push({ id: record.manifest.id, key: route, file: contribution[route] });
      }
    }
    return out;
  }

  function rendererSnippets(hash) {
    const snippets = [];
    for (const item of contributionsFor(hash)) {
      if (typeof item.source === 'string') {
        snippets.push({ id: item.id, key: item.key, source: item.source });
        continue;
      }
      const record = plugins.get(item.id);
      if (!record) continue;
      try {
        snippets.push({
          id: item.id,
          key: item.key,
          source: fs.readFileSync(path.join(record.dir, item.file), 'utf8'),
        });
      } catch {
        log('warn', `renderer contribution missing for ${item.id} (${item.file})`);
      }
    }
    return snippets;
  }

  function currentHash(contents) {
    try {
      return new URL(contents.getURL()).hash || '';
    } catch {
      return '';
    }
  }

  function push(message) {
    if (!electron || !electron.BrowserWindow) return;
    const payload = JSON.stringify(message);
    for (const window of electron.BrowserWindow.getAllWindows()) {
      try {
        if (window.isDestroyed()) continue;
        const contents = window.webContents;
        if (!contents || contents.isDestroyed()) continue;
        contents
          .executeJavaScript(`window.__oicq_push__ && window.__oicq_push__(${payload})`)
          .catch(() => {});
      } catch {
        /* window went away between the check and the push */
      }
    }
  }

  // The panel must be able to re-enable what it just disabled, so the listing
  // is the union of "directories on disk" and "instances in memory", not just
  // the loaded ones. `enabled` is the switch state, `loaded` is the runtime
  // state; a plugin can be enabled but failed to load, and the panel shows it.
  function pluginSummary() {
    const disabled = new Set(
      (config.plugins && Array.isArray(config.plugins.disabled) ? config.plugins.disabled : []),
    );
    const rows = [];
    const seen = new Set();
    const describe = (id, manifest, record) => ({
      id,
      name: manifest.name || id,
      version: manifest.version || '0',
      description: manifest.description || '',
      enabled: !disabled.has(id),
      loaded: Boolean(record),
      builtin: Boolean(manifest.builtin),
      requires: Array.isArray(manifest.requires) ? manifest.requires : [],
      unavailable: record && record.unavailable ? record.unavailable : null,
      commands: record
        ? [...commands.values()]
          .filter((command) => command.plugin === id)
          .map((command) => command.id)
        : [],
      pipelines: record
        ? [...pipelines.entries()]
          .filter(([, chain]) => chain.some((entry) => entry.owner === id))
          .map(([kind]) => kind)
        : [],
    });
    // Builtins that are switched off have no record and no directory, so they
    // are listed from the payload itself; otherwise the switch could not be
    // turned back on.
    for (const entry of builtinFiles()) {
      const id = entry.id;
      if (seen.has(id)) continue;
      seen.add(id);
      const record = plugins.get(id) || null;
      const manifest = record
        ? record.manifest
        : { id, name: id.slice('builtin:'.length), version: VERSION, api: API_VERSION, builtin: true };
      rows.push(describe(id, manifest, record));
    }
    for (const id of listPluginDirs()) {
      if (id.startsWith('_')) continue; // template / scratch directories
      const record = plugins.get(id) || null;
      const manifest = record
        ? record.manifest
        : readJson(path.join(paths.plugins, id, 'manifest.json'), null);
      if (!manifest) continue;
      seen.add(id);
      rows.push(describe(id, manifest, record));
    }
    // A plugin whose directory vanished mid-run stays listed until unloaded.
    for (const record of plugins.values()) {
      if (seen.has(record.manifest.id)) continue;
      rows.push(describe(record.manifest.id, record.manifest, record));
    }
    return rows;
  }

  function state() {
    return {
      version: VERSION,
      api: API_VERSION,
      root: paths.root,
      config,
      plugins: pluginSummary(),
      pipelines: pipelineSummary(),
      kernel: kernelSummary(),
      commands: [...commands.values()].map(({ id, title, hint, plugin }) => ({
        id,
        title,
        hint,
        plugin,
      })),
    };
  }

  async function invoke(request) {
    const type = request && request.type;
    log('debug', 'invoke', type);
    switch (type) {
      case 'state':
        return state();
      case 'config:set': {
        config = mergeConfig(config, request.patch || {});
        level = LEVELS[config.log && config.log.level] ?? level;
        writeJson(paths.config, config);
        push({ kind: 'refresh' });
        return state();
      }
      case 'command:run': {
        const command = commands.get(request.id);
        if (!command) return { ok: false, error: `unknown command ${request.id}` };
        const context = {
          kind: 'command:run',
          id: request.id,
          payload: request.payload,
          plugin: command.plugin || null,
          cancel: false,
        };
        await runPipeline('command:run', context);
        if (context.cancel) {
          return { ok: false, cancelled: true, error: 'cancelled by pipeline' };
        }
        try {
          const value = await command.run(context.payload);
          return { ok: true, value: value === undefined ? null : value };
        } catch (error) {
          log('warn', `command ${request.id} failed:`, error && error.message);
          return { ok: false, error: String((error && error.message) || error) };
        }
      }
      case 'plugin:enable':
        return setPluginEnabled(request.id, true);
      case 'plugin:disable':
        return setPluginEnabled(request.id, false);
      case 'plugin:list':
        return { ok: true, plugins: pluginSummary(), pipelines: pipelineSummary() };
      case 'log:tail': {
        const limit = Math.min(Number(request.lines) || 80, 400);
        try {
          const text = fs.readFileSync(paths.logFile, 'utf8');
          return { ok: true, lines: text.trim().split('\n').slice(-limit) };
        } catch {
          return { ok: true, lines: [] };
        }
      }
      case 'plugin:reload': {
        for (const id of [...plugins.keys()]) unloadPlugin(id);
        scanBuiltins();
        scanPlugins();
        push({ kind: 'refresh' });
        return state();
      }
      case 'window:devtools': {
        if (electron && electron.BrowserWindow) {
          const focused = electron.BrowserWindow.getFocusedWindow();
          if (focused) focused.webContents.toggleDevTools();
        }
        return { ok: true };
      }
      default:
        return { ok: false, error: `unknown request ${String(type)}` };
    }
  }

  // The UI rides on a session preload instead of a patched preload script, so
  // nothing in QQNT's own bootstrap has to change.
  const MAIN_UI_URL = /(^|[\\/])renderer\/index\.html(\?|#|$)/;
  const isMainUi = (url) => MAIN_UI_URL.test(String(url || ''));
  const WINDOW_EVENTS = new Set([
    'close', 'closed', 'hide', 'show', 'blur', 'focus', 'minimize',
    'restore', 'unresponsive', 'responsive', 'session-end', 'destroyed',
  ]);
  let protocol = null;

  function eligibleWindow(contents) {
    if (!isMainUi(contents.getURL())) return null;
    const window = electron.BrowserWindow.fromWebContents(contents);
    if (!window || window.isDestroyed()) return null;
    const bounds = window.getBounds();
    // Auxiliary windows (settings, about) are small; the main window is not.
    if (bounds.width < 640 || bounds.height < 480) return null;
    return { window, bounds };
  }

  function deliverUi(contents) {
    const target = eligibleWindow(contents);
    if (!target) {
      log('debug', `no UI for ${contents.id} (${contents.getURL()})`);
      return;
    }
    const source = rendererSource();
    if (!source) return;
    const hash = currentHash(contents);
    const prelude = `window.__oicq_boot__ = ${JSON.stringify({
      version: VERSION,
      config,
      hash,
      snippets: rendererSnippets(hash),
    })};`;
    contents
      .executeJavaScript(prelude)
      .then(() => contents.executeJavaScript(source))
      .then(() => {
        // Anything route-matched after the first paint is added the same way
        // an in-page navigation adds it.
        deliverContributions(contents);
        log('debug', 'renderer UI delivered', contents.id, JSON.stringify(target.bounds));
        maybeAutoOpenChat(contents).catch((error) =>
          log('warn', 'auto-open-chat failed:', error && error.message));
        maybeSendSelf(contents).catch((error) =>
          log('warn', 'send-self failed:', error && error.message));
        maybeDumpDom(contents).catch((error) =>
          log('warn', 'dom dump failed:', error && error.message));
        maybeMarkFirst(contents).catch((error) =>
          log('warn', 'mark self-test failed:', error && error.message));
      })
      .catch((error) =>
        log('warn', `renderer UI failed for ${contents.id}:`, error && error.message));
  }

  // Route-scoped contributions. Each snippet carries an id and a key, and the
  // page keeps a set of `<id>#<key>` already evaluated, so re-running this on
  // every hash change only adds what is new and never duplicates a tab.
  function deliverContributions(contents) {
    if (!eligibleWindow(contents)) return;
    for (const snippet of rendererSnippets(currentHash(contents))) {
      const payload = JSON.stringify(snippet);
      contents
        .executeJavaScript(`window.__oicq_contrib__ && window.__oicq_contrib__(${payload})`)
        .catch((error) =>
          log('warn', `contribution ${snippet.id} failed:`, error && error.message));
    }
  }

  async function handleAction(contents, action) {
    const reply = (payload) => {
      try {
        if (contents.isDestroyed()) return;
        contents
          .executeJavaScript(
            `window.__oicq_reply__ && window.__oicq_reply__(${JSON.stringify(action.id)}, ${JSON.stringify(payload)})`,
          )
          .catch(() => {});
      } catch {
        /* window already gone */
      }
    };
    reply(await invoke(action));
  }

  // Login-window automation for the local test harness. Mirrors ref's
  // AutoLoginPlugin (launcher.js `g0`): wait for the login page, optionally
  // expand the account list and pick an avatar by its style substring, then
  // click the login button. ref injects with `$$$`; this is the same thing via
  // executeJavaScript. Off by default, only reachable through config.
  async function maybeAutoLogin(contents) {
    const test = config.test || {};
    if (!test.autoLogin && !test.dumpLogin) return;
    let url = '';
    try {
      url = contents.getURL();
    } catch {
      return;
    }
    if (!/login\.html/.test(url)) return;

    const style = (() => {
      try {
        return electron.app.commandLine.getSwitchValue('auto-login-qq') || '';
      } catch {
        return '';
      }
    })();
    // ref waits 3 s after the page is up before touching the DOM.
    await new Promise((resolve) => setTimeout(resolve, 3000));

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (contents.isDestroyed()) return;
      let result = null;
      try {
        result = await contents.executeJavaScript(`(async () => {
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const style = ${JSON.stringify(style)};
          const visible = (el) => el && el.getBoundingClientRect().width > 0;
          const buttons = [...document.querySelectorAll('button, .q-button, .auto-login button')]
            .filter(visible)
            .slice(0, 40)
            .map((el) => ({
              tag: el.tagName,
              cls: String(el.className || '').slice(0, 80),
              text: String(el.textContent || '').trim().slice(0, 30),
            }));
          const avatars = [...document.querySelectorAll('.avatar')]
            .slice(0, 20)
            .map((el) => ({ style: String(el.getAttribute('style') || '').slice(0, 120) }));
          const hasAutoLogin = Boolean(document.querySelector('.auto-login button'));
          let clicked = '';
          if (style) {
            document.querySelector('[aria-label="更多帐号"]')?.click();
            await sleep(30);
            document.querySelector('.avatar[style*="' + style + '"]')?.click();
            await sleep(100);
            if (document.querySelector('.auto-login button')) {
              document.querySelector('.auto-login button').click();
              clicked = 'auto-login+avatar';
            }
          }
          if (!clicked) {
            const auto = document.querySelector('.auto-login button');
            if (auto && !auto.disabled) {
              auto.click();
              clicked = 'auto-login';
            }
          }
          if (!clicked) {
            const target = [...document.querySelectorAll('button, .q-button')].find(
              (el) => visible(el) && !el.disabled && /登录|登 录|Sign in|Login/i.test(el.textContent || ''),
            );
            if (target) {
              target.click();
              clicked = 'text:' + String(target.textContent || '').trim().slice(0, 20);
            }
          }
          return { buttons, avatars, hasAutoLogin, clicked };
        })()`);
      } catch (error) {
        log('debug', 'auto-login probe failed:', error && error.message);
      }
      if (result && test.dumpLogin && attempt === 0) {
        log('info', 'login dom', JSON.stringify({
          hasAutoLogin: result.hasAutoLogin,
          buttons: result.buttons,
          avatars: result.avatars,
        }));
      }
      if (result && test.dumpLogin && !test.autoLogin) return;
      if (result && result.clicked) {
        log('info', 'auto-login clicked', result.clicked, style ? `style=${style}` : '');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    log('warn', 'auto-login: no enabled login button found');
  }

  // Test-only: open the first conversation so the client loads message history
  // through the normal kernel path. This is how the harness gets message frames
  // without sending anything.
  async function maybeAutoOpenChat(contents) {
    if (!(config.test && config.test.autoOpenChat)) return;
    const openChatSwitch = (() => {
      try {
        return electron.app.commandLine.getSwitchValue('oicq-test-open-chat') || '';
      } catch {
        return '';
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (contents.isDestroyed()) return;
      let result = null;
      try {
        result = await contents.executeJavaScript(`(() => {
          const forced = ${JSON.stringify(openChatSwitch)};
          const selectors = [
            '.recent-contact-item', '.recent-contact-list .item',
            '.chat-list-item', '.contact-list-item',
            '[class*="recent-contact"] [class*="item"]',
          ];
          const candidates = [];
          if (forced) {
            const item = [...document.querySelectorAll('.recent-contact-item')]
              .find((el) => (el.textContent || '').includes(forced));
            if (item) {
              const rect = item.getBoundingClientRect();
              return {
                clicked: 'forced',
                count: 1,
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
              };
            }
          }
          for (const sel of selectors) {
            const nodes = [...document.querySelectorAll(sel)].filter(
              (el) => el.getBoundingClientRect().width > 0,
            );
            if (nodes.length) {
              nodes[0].click();
              return { clicked: sel, count: nodes.length };
            }
            candidates.push(sel + ':' + document.querySelectorAll(sel).length);
          }
          const classes = [...document.querySelectorAll('*')]
            .map((el) => String(el.className || ''))
            .filter((name) => /contact|chat/i.test(name))
            .slice(0, 20);
          return { clicked: '', candidates, classes };
        })()`);
      } catch (error) {
        log('debug', 'auto-open-chat probe failed:', error && error.message);
      }
      if (result && result.clicked) {
        try {
          if (result.x != null) {
            contents.sendInputEvent({ type: 'mouseDown', x: result.x, y: result.y, button: 'left', clickCount: 1 });
            contents.sendInputEvent({ type: 'mouseUp', x: result.x, y: result.y, button: 'left', clickCount: 1 });
            contents.sendInputEvent({ type: 'mouseDown', x: result.x, y: result.y, button: 'left', clickCount: 2 });
            contents.sendInputEvent({ type: 'mouseUp', x: result.x, y: result.y, button: 'left', clickCount: 2 });
          }
        } catch {
          /* input injection unavailable */
        }
        log('info', 'auto-open-chat clicked', result.clicked, `count=${result.count}`,
            `url=${contents.getURL()}`);
        return;
      }
      if (result && attempt === 0) {
        log('info', 'auto-open-chat miss', JSON.stringify(result));
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  // Test-only: send a message to "文件传输助手" so the outbound path
  // (sendMsg -> pangu -> kernel) can be verified without touching a real peer.
  async function maybeSendSelf(contents) {
    const switchText = (() => {
      try {
        return electron.app.commandLine.getSwitchValue('oicq-test-text') || '';
      } catch {
        return '';
      }
    })();
    const switchChat = (() => {
      try {
        return electron.app.commandLine.getSwitchValue('oicq-test-chat') || '';
      } catch {
        return '';
      }
    })();
    const text = switchText || (config.test && config.test.sendSelf);
    if (!text) return;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (contents.isDestroyed()) return;
      let prep = null;
      try {
        prep = await contents.executeJavaScript(`(async () => {
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const visible = (el) => el && el.getBoundingClientRect().width > 0;
          const forcedChat = ${JSON.stringify(switchChat)};
          const names = ['我的手机', '我的电脑', '我的设备', '文件传输助手', 'File Transfer'];
          const current = ${JSON.stringify(Boolean(config.test && config.test.sendSelfCurrent))};
          const items = [...document.querySelectorAll('.recent-contact-item')];
          const target = current
            ? null
            : items.find((el) => {
              if (forcedChat) return (el.textContent || '').includes(forcedChat);
              return names.some((n) => (el.textContent || '').includes(n));
            });
          if (!current && !target) {
            return { ok: false, reason: 'contact-missing', count: items.length };
          }
          if (target) {
            target.click();
            await sleep(900);
          }
          // Update / announcement dialogs grab focus; dismiss the known ones
          // before typing or the keystrokes land on the close button.
          const dismiss = [...document.querySelectorAll('button, .q-button, .q-dialog-close')]
            .find((el) => visible(el)
              && /下次再说|稍后|关闭|Later|Not now/.test(el.textContent || ''));
          if (dismiss) {
            dismiss.click();
            await sleep(400);
          }
          const editors = [...document.querySelectorAll(
            '[contenteditable="true"], .ck-content, div[contenteditable], textarea',
          )].filter((el) => {
            if (el.disabled) return false;
            if (/ck-content/.test(String(el.className || ''))) return true;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.bottom > innerHeight * 0.5;
          });
          if (!editors.length) {
            return { ok: false, reason: 'editor-missing' };
          }
          const editor = editors
            .map((el) => ({ el, rect: el.getBoundingClientRect() }))
            .filter((item) => item.rect.width > 100 && item.rect.height > 10)
            .sort((a, b) => b.rect.bottom - a.rect.bottom)[0];
          if (!editor) return { ok: false, reason: 'editor-zero-size' };
          editor.el.scrollIntoView({ block: 'center' });
          const rect = editor.el.getBoundingClientRect();
          return {
            ok: true,
            via: String(editor.el.className || editor.el.tagName),
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
          };
        })()`);
      } catch (error) {
        log('debug', 'send-self probe failed:', error && error.message);
      }
      if (prep && prep.ok) {
        if (config.test && config.test.sendSelfDry) {
          log('info', 'send-self ok', 'dry', prep.via);
          return;
        }
        try {
          // insertText goes through the renderer's real input pipeline; a DOM
          // `execCommand` plus synthetic Enter did not reach the kernel.
          // Focus first with a real click at the editor's center: CKEditor
          // ignores programmatic .focus() in this client.
          contents.sendInputEvent({
            type: 'mouseDown', x: prep.x, y: prep.y, button: 'left', clickCount: 1,
          });
          contents.sendInputEvent({
            type: 'mouseUp', x: prep.x, y: prep.y, button: 'left', clickCount: 1,
          });
          await new Promise((resolve) => setTimeout(resolve, 200));
          contents.insertText(String(text));
          await new Promise((resolve) => setTimeout(resolve, 150));
          try {
            const state = await contents.executeJavaScript(`(() => {
              const el = document.activeElement;
              const buttons = [...document.querySelectorAll('button, .q-button')]
                .filter((b) => {
                  const r = b.getBoundingClientRect();
                  return r.width > 0 && r.bottom > innerHeight * 0.55;
                })
                .slice(0, 10)
                .map((b) => ({
                  cls: String(b.className || '').slice(0, 60),
                  text: String(b.textContent || '').trim().slice(0, 12),
                }));
              return {
                tag: el ? el.tagName : '',
                cls: el ? String(el.className || '').slice(0, 60) : '',
                len: el ? String(el.innerText || el.value || '').length : 0,
                buttons,
              };
            })()`);
            log('debug', 'send-self editor state', JSON.stringify(state));
          } catch (error) {
            log('debug', 'send-self state failed:', error && error.message);
          }
          contents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
          contents.sendInputEvent({ type: 'char', keyCode: '\r' });
          contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
          log('info', 'send-self submitted', prep.via);
        } catch (error) {
          log('warn', 'send-self submit failed:', error && error.message);
        }
        return;
      }
      if (prep && prep.reason) {
        log('debug', 'send-self attempt', attempt, JSON.stringify(prep));
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    log('warn', 'send-self: gave up');
  }

  // Test-only: dump the message container structure so selectors are based on
  // the real DOM instead of guesses.
  async function maybeDumpDom(contents) {
    if (!(config.test && config.test.dumpDom)) return;
    try {
      const win = electron.BrowserWindow.fromWebContents(contents);
      if (win) {
        win.show();
        win.focus();
      }
    } catch {
      /* headless */
    }
    await new Promise((resolve) => setTimeout(resolve, 9000));
    if (contents.isDestroyed()) return;
    try {
      const dump = await contents.executeJavaScript(`(() => {
        const area = document.querySelector('.chat-msg-area')
          || document.querySelector('.ml-list')
          || document.querySelector('[class*="chat-msg"]');
        if (!area) return { error: 'no-area' };
        const classes = [...new Set([...area.querySelectorAll('*')]
          .map((el) => String(el.className || ''))
          .filter((name) => /msg|bubble|item|row|container|time/i.test(name)))]
          .slice(0, 120);
        const sample = [...area.querySelectorAll('*')]
          .filter((el) => /bubble|msg-item|message-container|ml-item/i.test(String(el.className || '')))
          .slice(0, 5)
          .map((el) => ({
            cls: String(el.className || '').slice(0, 80),
            attrs: [...el.attributes].map((a) => a.name + '=' + String(a.value).slice(0, 30)),
          }));
        return {
          classes,
          sample,
          count: area.querySelectorAll('*').length,
          vlist: document.querySelectorAll('.chat-msg-area__vlist > *').length,
          frames: [...document.querySelectorAll('iframe, webview')]
            .map((el) => el.tagName + ':' + (el.src || '')),
          bodyLen: document.body.innerHTML.length,
        };
      })()`);
      const frameUrls = [];
      try {
        const walk = (frame) => {
          frameUrls.push(frame.url);
          for (const child of frame.frames) walk(child);
        };
        walk(contents.mainFrame);
      } catch {
        /* older Electron */
      }
      log('info', 'dom dump', JSON.stringify(dump), 'frames=' + JSON.stringify(frameUrls));
    } catch (error) {
      log('warn', 'dom dump failed:', error && error.message);
    }
  }

  // Test-only: mark the first rendered message as recalled to verify the
  // renderer styling without waiting for a real revoke.
  async function maybeMarkFirst(contents) {
    if (!(config.test && config.test.markFirst)) return;
    await new Promise((resolve) => setTimeout(resolve, 8000));
    if (contents.isDestroyed()) return;
    try {
      const forcedId = (() => {
        try {
          return electron.app.commandLine.getSwitchValue('oicq-test-mark-id') || '';
        } catch {
          return '';
        }
      })();
      const msgId = forcedId || await contents.executeJavaScript(
        "(() => { const rows = [...document.querySelectorAll('.ml-item[id]')];"
        + " const el = rows.find((row) => row.querySelector('.mix-message__container--pic')) || rows[0];"
        + " return el ? el.id : ''; })()",
      );
      if (!msgId) {
        log('warn', 'mark self-test: no message row found');
        return;
      }
      push({ kind: 'plugin', id: 'builtin:anti-recall-pro', payload: { type: 'recalled', msgId } });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const state = await contents.executeJavaScript(`(() => {
        const rows = [...document.querySelectorAll('.ml-item[id]')];
        const imageRows = rows.filter((row) => row.querySelector('[class*="image"], img, canvas')).map((row) => ({
          id: row.id,
          cls: String(row.className || ''),
          all: [...row.querySelectorAll('*')]
            .map((el) => el.tagName + '.' + String(el.className || ''))
            .slice(0, 14),
        }));
        const tail = rows.slice(-8).map((row) => ({
          id: row.id,
          text: String(row.innerText || '').replace(/\s+/g, ' ').slice(0, 30),
          cls: String(row.className || ''),
          kids: [...row.querySelectorAll('*')]
            .map((el) => String(el.className || ''))
            .filter((name) => /image|pic|msg-content|message-content|bubble/i.test(name))
            .slice(0, 6),
          marked: Boolean(row.querySelector('.oq-recalled-bubble')),
        }));
        const picRows = [...document.querySelectorAll('.ml-item.oq-recalled-bubble')]
          .filter((row) => row.querySelector('.mix-message__container--pic'))
          .slice(0, 5)
          .map((row) => {
            const img = row.querySelector('img');
            return {
              id: row.id,
              src: img ? String(img.src || '').slice(0, 80) : '',
              w: img ? img.naturalWidth : 0,
            };
          });
        const target = document.getElementById(${JSON.stringify(msgId)});
        const bubble = target && target.querySelector('.msg-content-container');
        const after = bubble ? getComputedStyle(bubble, '::after').content : '';
        return {
          picRows,
          imageRows,
          tail,
          after,
          bubble: bubble ? String(bubble.className || '').slice(0, 60) : '',
          dim: document.querySelectorAll('.oq-recalled-bubble').length,
          tag: document.querySelectorAll('.oq-recalled-inline').length,
          imageRows,
        };
      })()`);
      try {
        const image = await contents.capturePage();
        fs.writeFileSync('/tmp/oicq-mark.png', image.toPNG());
      } catch (error) {
        log('debug', 'mark self-test capture failed:', error && error.message);
      }
      log('info', 'mark self-test', msgId, JSON.stringify(state));
    } catch (error) {
      log('warn', 'mark self-test failed:', error && error.message);
    }
  }

  function wireRenderer() {
    if (!electron || !electron.app) return;
    if (process.env.OICQ_NO_UI === '1') {
      log('info', 'OICQ_NO_UI=1: renderer UI disabled for this run');
      return;
    }
    try {
      protocol = require(path.join(__dirname, 'protocol.js'));
    } catch (error) {
      log('warn', 'protocol.js missing; renderer actions unavailable:', error && error.message);
    }

    // Window lifecycle: QQNT's own handlers call app.quit() from window events,
    // so the event name (and which window) is the missing half of every
    // "back to the login screen" report.
    electron.app.on('browser-window-created', (_event, window) => {
      try {
        log('debug', `window created id=${window.id}`);
        const originalEmit = window.emit.bind(window);
        window.emit = function emitWithLog(name, ...args) {
          try {
            if (WINDOW_EVENTS.has(name)) log('debug', `window ${window.id} event ${name}`);
          } catch {
            /* window already gone */
          }
          return originalEmit(name, ...args);
        };
      } catch (error) {
        log('warn', 'cannot instrument window:', error && error.message);
      }
    });

    electron.app.on('web-contents-created', (_event, contents) => {
      try {
        log('debug', `web-contents ${contents.id} type=${contents.getType()}`);
        if (kernelBridge) kernelBridge.wrapContents(contents);
        contents.on('did-finish-load', () => {
          try {
            deliverUi(contents);
          } catch (error) {
            log('warn', 'deliverUi failed:', error && error.message);
          }
          maybeAutoLogin(contents).catch((error) =>
            log('warn', 'auto-login failed:', error && error.message));
        });
        // Single-page navigation: QQNT's settings view is a hash route inside
        // the main window, so the document does not reload. Inject whatever
        // that route contributes, without a page-side polling loop.
        contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
          if (isMainFrame === false) return;
          try {
            deliverContributions(contents);
          } catch (error) {
            log('warn', 'deliverContributions failed:', error && error.message);
          }
        });
        contents.on('console-message', (_e, severity, message, line, source) => {
          try {
            const action = protocol ? protocol.parse(message) : null;
            if (action) {
              handleAction(contents, action).catch((error) =>
                log('warn', 'action failed:', error && error.message));
              return;
            }
            if (severity < 2 && process.env.OICQ_VERBOSE_CONSOLE !== '1') return;
            log('debug', `console[${severity}] ${String(message).slice(0, 300)} (${source}:${line})`);
          } catch {
            /* window already gone */
          }
        });
        contents.on('preload-error', (_e, preloadPath, error) => {
          try {
            log('error', `preload-error ${preloadPath}: ${error && error.message}`);
          } catch {
            /* window already gone */
          }
        });
      } catch (error) {
        log('warn', 'cannot instrument web-contents:', error && error.message);
      }
    });
  }

  // Anything that kills a process must leave a trace in runtime.log: a restart
  // that only shows up as "back to the login screen" is undebuggable otherwise.
  // Who quits the app? QQNT relaunches itself when the main window path throws,
  // and a bare exit(0) leaves no trace. Wrapping the three entry points turns
  // "back to the login screen" into a stack trace.
  function wireQuitDiagnostics() {
    if (!electron || !electron.app) return;
    if (kernelBridge) {
      const timer = setInterval(() => {
        const summary = kernelSummary().frames;
        log('debug', 'kernel frames', JSON.stringify({
          receive: summary.receive,
          send: summary.send,
          methods: summary.methods.slice(0, 6),
          events: summary.events.slice(0, 6),
        }));
      }, 10_000);
      if (typeof timer.unref === 'function') timer.unref();
    }
    for (const name of ['quit', 'exit', 'relaunch']) {
      const original = electron.app[name];
      if (typeof original !== 'function') continue;
      const wrapped = function wrappedQuit(...args) {
        log('error', `app.${name}() called with`, JSON.stringify(args),
            new Error(`app.${name}`).stack);
        return original.apply(electron.app, args);
      };
      try {
        electron.app[name] = wrapped;
      } catch {
        try {
          Object.defineProperty(electron.app, name, { value: wrapped, configurable: true });
        } catch (error) {
          log('warn', `cannot wrap app.${name}:`, error && error.message);
        }
      }
    }
    electron.app.on('before-quit', () => {
      log('error', 'before-quit');
      if (kernelBridge) log('info', 'kernel frames at quit', JSON.stringify(kernelSummary().frames));
    });
    electron.app.on('will-quit', () => log('error', 'will-quit'));
    electron.app.on('window-all-closed', () => log('error', 'window-all-closed'));
    process.on('exit', (code) => {
      log('error', 'process exit', code);
      flush(true);
    });
  }

  function wireCrashDiagnostics() {
    if (!electron) return;
    try {
      electron.app.on('render-process-gone', (_event, contents, details) =>
        log('error', `renderer gone id=${contents.id} reason=${details.reason} exitCode=${details.exitCode}`));
      electron.app.on('child-process-gone', (_event, details) =>
        log('error', `child gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`));
      electron.app.on('gpu-process-crashed', () => log('error', 'gpu process crashed'));
    } catch (error) {
      log('warn', 'crash diagnostics unavailable:', error && error.message);
    }
    process.on('uncaughtException', (error) =>
      log('error', 'uncaughtException', error && (error.stack || error.message)));
    // QQNT itself produces benign rejections (TLS teardown, internal handlers);
    // keep them visible at debug instead of filling the error stream.
    process.on('unhandledRejection', (reason) => log('debug', 'unhandledRejection', String(reason)));
  }

  // ------------------------------------------------------------- bootstrapping
  const runtime = {
    version: VERSION,
    api: API_VERSION,
    root: paths.root,
    channels: CHANNELS,
    config: () => config,
    log,
    flushLogs: () => flush(true),
    invoke,
    on,
    emit,
    commands: { register: registerCommand, list: () => [...commands.values()] },
    plugins: {
      list: pluginSummary,
      reload: () => invoke({ type: 'plugin:reload' }),
      enable: (id) => setPluginEnabled(id, true),
      disable: (id) => setPluginEnabled(id, false),
    },
    pipeline: {
      before: (kind, fn) => addPipeline('host', kind, fn),
      run: runPipeline,
      list: pipelineSummary,
    },
    kernel: kernelSummary,
    // Route-scoped renderer contributions for a given hash; also the seam the
    // harness uses to verify routing without an Electron window.
    contributions: (hash) => contributionsFor(hash),
    notify: (text) => push({ kind: 'toast', text: String(text) }),
  };

  globalThis.__oicq__ = runtime;

  if (config.enabled === false) {
    log('info', 'disabled by config');
    return;
  }

  log('info', `runtime ${VERSION} root=${paths.root}`);
  if (kernelHooksRequested()) {
    try {
      const createBridge = require(path.join(__dirname, 'kernel.js'));
      const bridge = createBridge({
        ipcMain: electron && electron.ipcMain,
        log,
        dispatch: dispatchKernel,
      });
      if (bridge.install()) {
        kernelBridge = bridge;
        log('info', 'kernel bridge installed');
      } else {
        log('warn', 'kernel bridge requested but ipcMain is unavailable');
      }
    } catch (error) {
      log('warn', 'kernel bridge failed:', error && error.message);
    }
  }
  scanBuiltins();
  scanPlugins();
  log('info', 'kernel hooks', JSON.stringify(kernelSummary()));
  wireRenderer();
  wireCrashDiagnostics();
  wireQuitDiagnostics();
  emit('ready', state()).catch(() => {});
})();
