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

  const VERSION = '0.2.1';
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
    try {
      const { size } = fs.statSync(paths.logFile);
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
  const listeners = new Map(); // event -> Set<fn>

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

  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event)?.delete(handler);
  }

  async function emit(event, payload) {
    const handlers = listeners.get(event);
    if (!handlers) return [];
    const results = [];
    for (const handler of handlers) {
      try {
        results.push(await handler(payload));
      } catch (error) {
        log('warn', `listener ${event} failed:`, error && error.message);
      }
    }
    return results;
  }

  // --------------------------------------------------------------- plugin host
  const plugins = new Map(); // id -> {manifest, api, state}

  function validateManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') return 'manifest is not an object';
    if (typeof manifest.id !== 'string' || !/^[a-z0-9_.-]+$/i.test(manifest.id)) {
      return 'invalid id';
    }
    if (manifest.api !== API_VERSION) return `unsupported api ${manifest.api}`;
    if (typeof manifest.main !== 'string' || manifest.main.includes('..')) {
      return 'invalid main';
    }
    if (manifest.contributes && manifest.contributes.renderer &&
        (typeof manifest.contributes.renderer !== 'string' ||
         manifest.contributes.renderer.includes('..'))) {
      return 'invalid renderer contribution';
    }
    return null;
  }

  function pluginApi(manifest, pluginDir) {
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
      fs: scopedFs,
      commands: {
        register: (entry) => registerCommand({ ...entry, plugin: manifest.id }),
        list: () => [...commands.values()].filter((c) => c.plugin === manifest.id),
      },
      events: {
        on,
        emit,
      },
      ui: {
        notify: (text) => push({ kind: 'toast', text: String(text) }),
        refresh: () => push({ kind: 'refresh' }),
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
    let source;
    try {
      source = fs.readFileSync(path.join(pluginDir, manifest.main), 'utf8');
    } catch (readError) {
      log('warn', `skip ${entry}: cannot read ${manifest.main}`);
      return null;
    }
    const api = pluginApi(manifest, pluginDir);
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
    const record = { manifest, api, dir: pluginDir, entry: manifest.id };
    plugins.set(manifest.id, record);
    log('info', `loaded ${manifest.id}@${manifest.version || '0'}`);
    return record;
  }

  function scanPlugins() {
    let entries = [];
    try {
      entries = fs
        .readdirSync(paths.plugins, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name)
        .sort();
    } catch {
      entries = [];
    }
    const disabled = new Set(
      (config.plugins && Array.isArray(config.plugins.disabled) ? config.plugins.disabled : []),
    );
    const allow = config.plugins && Array.isArray(config.plugins.enabled)
      ? new Set(config.plugins.enabled)
      : null;
    for (const entry of entries) {
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
  function rendererSource() {
    const candidates = [process.env.OICQ_RENDERER_PATH, path.join(__dirname, 'renderer.js')]
      .filter(Boolean);
    for (const candidate of candidates) {
      try {
        fs.accessSync(candidate);
        return fs.readFileSync(candidate, 'utf8');
      } catch {
        continue;
      }
    }
    log('warn', 'renderer.js not found next to the runtime');
    return null;
  }

  // Plugins may contribute an extra renderer file; it is evaluated after the
  // panel script in the page, inside a function with its own `oicq` handle.
  function rendererSnippets() {
    const snippets = [];
    for (const record of plugins.values()) {
      const contribution = record.manifest.contributes && record.manifest.contributes.renderer;
      if (!contribution) continue;
      try {
        snippets.push({
          id: record.manifest.id,
          source: fs.readFileSync(path.join(record.dir, contribution), 'utf8'),
        });
      } catch {
        log('warn', `renderer contribution missing for ${record.manifest.id}`);
      }
    }
    return snippets;
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

  function pluginSummary() {
    return [...plugins.values()].map((record) => ({
      id: record.manifest.id,
      name: record.manifest.name || record.manifest.id,
      version: record.manifest.version || '0',
      description: record.manifest.description || '',
      commands: [...commands.values()]
        .filter((command) => command.plugin === record.manifest.id)
        .map((command) => command.id),
    }));
  }

  function state() {
    return {
      version: VERSION,
      api: API_VERSION,
      root: paths.root,
      config,
      plugins: pluginSummary(),
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
        try {
          const value = await command.run(request.payload);
          return { ok: true, value: value === undefined ? null : value };
        } catch (error) {
          log('warn', `command ${request.id} failed:`, error && error.message);
          return { ok: false, error: String((error && error.message) || error) };
        }
      }
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
        plugins.clear();
        commands.clear();
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
    const prelude = `window.__oicq_boot__ = ${JSON.stringify({
      version: VERSION,
      config,
      snippets: rendererSnippets(),
    })};`;
    contents
      .executeJavaScript(prelude)
      .then(() => contents.executeJavaScript(source))
      .then(() =>
        log('debug', 'renderer UI delivered', contents.id, JSON.stringify(target.bounds)))
      .catch((error) =>
        log('warn', `renderer UI failed for ${contents.id}:`, error && error.message));
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
        contents.on('did-finish-load', () => {
          try {
            deliverUi(contents);
          } catch (error) {
            log('warn', 'deliverUi failed:', error && error.message);
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
    electron.app.on('before-quit', () => log('error', 'before-quit'));
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
    on,
    emit,
    commands: { register: registerCommand, list: () => [...commands.values()] },
    plugins: { list: pluginSummary, reload: () => invoke({ type: 'plugin:reload' }) },
    notify: (text) => push({ kind: 'toast', text: String(text) }),
  };

  globalThis.__oicq__ = runtime;

  if (config.enabled === false) {
    log('info', 'disabled by config');
    return;
  }

  log('info', `runtime ${VERSION} root=${paths.root}`);
  scanPlugins();
  wireRenderer();
  wireCrashDiagnostics();
  wireQuitDiagnostics();
  emit('ready', state()).catch(() => {});
})();
