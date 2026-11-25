'use strict';
// oicq renderer UI.
//
// Runs in the page world of the main QQNT window, pushed there by the host.
// It owns its whole surface: a shadow-rooted panel (no host CSS leaks either
// way), a draggable launcher, a command palette, toasts, and a settings view
// that writes back over the console channel defined in runtime/protocol.js.
//
// Everything here is product code and free to change. The native layer never
// looks at it.

(function oicqUi() {
  if (window.__oicq_ui__) return;
  window.__oicq_ui__ = true;

  const boot = window.__oicq_boot__;
  if (!boot) {
    console.warn('[oicq] host did not deliver a boot payload; UI skipped');
    return;
  }

  // Transport. The host pushes this script into the page; there is no preload
  // and no ipcRenderer here. Actions go back as one line-prefixed console
  // message (webContents.on('console-message') receives it), replies come back
  // through window.__oicq_reply__ from an executeJavaScript call.
  const ACTION_PREFIX = '[oicq-action]';
  const transport = { seq: 0, pending: new Map() };
  const pushHandlers = new Set();
  const pluginHandlers = new Set();

  function send(type, payload) {
    const id = ++transport.seq;
    return new Promise((resolve) => {
      transport.pending.set(id, resolve);
      console.log(ACTION_PREFIX + JSON.stringify({ id, type, ...(payload || {}) }));
    });
  }

  window.__oicq_reply__ = (id, data) => {
    const resolve = transport.pending.get(id);
    if (!resolve) return;
    transport.pending.delete(id);
    resolve(data);
  };

  window.__oicq_push__ = (message) => {
    if (message && message.kind === 'plugin') {
      for (const handler of pluginHandlers) {
        try {
          handler(message.payload, message.id);
        } catch (error) {
          console.error('[oicq] plugin message handler', error);
        }
      }
      return;
    }
    for (const handler of pushHandlers) {
      try {
        handler(message);
      } catch (error) {
        console.error('[oicq] push handler', error);
      }
    }
  };

  const state = {
    config: boot.config || {},
    panels: { overview: true, plugins: true, logs: true, appearance: true },
    active: 'overview',
    open: false,
    pluginRows: [],
    commands: [],
    pipelines: [],
    logs: [],
    query: '',
  };

  const storageKey = 'oicq.ui.v1';
  const persisted = (() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || '{}');
    } catch {
      return {};
    }
  })();

  function savePersisted() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(persisted));
    } catch {
      /* private mode */
    }
  }

  // ------------------------------------------------------------------ styles
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .oq-root {
      position: fixed; inset: 0; pointer-events: none;
      font: 13px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: var(--oq-fg); --oq-accent: ${state.config.ui && state.config.ui.accent || '#5b8cff'};
      --oq-fg: #eef2f8; --oq-dim: #97a3b6; --oq-line: rgba(255,255,255,.08);
      --oq-bg: rgba(22,26,34,.92); --oq-bg-soft: rgba(255,255,255,.04);
      z-index: 2147483000;
    }
    .oq-orb {
      pointer-events: auto; position: absolute; width: 44px; height: 44px; border-radius: 14px;
      display: grid; place-items: center; cursor: grab; user-select: none;
      background: linear-gradient(160deg, var(--oq-accent), #2a3550);
      box-shadow: 0 10px 30px rgba(0,0,0,.45); border: 1px solid rgba(255,255,255,.14);
      font-weight: 700; letter-spacing: .5px; font-size: 14px; color: #fff;
      transition: transform .16s ease, box-shadow .16s ease;
    }
    .oq-orb:hover { transform: translateY(-1px) scale(1.03); }
    .oq-orb.oq-dragging { cursor: grabbing; transition: none; }
    .oq-panel {
      pointer-events: auto; position: absolute; top: 64px; width: 344px; height: 0;
      opacity: 0; transform: translateY(-8px); overflow: hidden;
      background: var(--oq-bg); backdrop-filter: blur(18px) saturate(140%);
      border: 1px solid var(--oq-line); border-radius: 16px;
      box-shadow: 0 24px 60px rgba(0,0,0,.5); display: flex; flex-direction: column;
      transition: opacity .18s ease, transform .18s ease, height .22s ease;
    }
    .oq-panel.oq-open { height: 460px; opacity: 1; transform: none; }
    .oq-head { display: flex; align-items: center; gap: 8px; padding: 14px 14px 10px; }
    .oq-title { font-size: 14px; font-weight: 650; }
    .oq-badge { font-size: 10px; color: var(--oq-dim); border: 1px solid var(--oq-line);
      padding: 1px 6px; border-radius: 999px; }
    .oq-spacer { flex: 1; }
    .oq-icon { width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center;
      color: var(--oq-dim); cursor: pointer; background: transparent; border: 0; font-size: 13px; }
    .oq-icon:hover { background: var(--oq-bg-soft); color: var(--oq-fg); }
    .oq-tabs { display: flex; gap: 4px; padding: 0 12px 10px; border-bottom: 1px solid var(--oq-line); }
    .oq-tab { padding: 5px 10px; border-radius: 8px; font-size: 12px; color: var(--oq-dim);
      cursor: pointer; border: 0; background: transparent; }
    .oq-tab.oq-active { background: var(--oq-bg-soft); color: var(--oq-fg); }
    .oq-body { flex: 1; overflow: auto; padding: 12px 14px; }
    .oq-body::-webkit-scrollbar { width: 8px; }
    .oq-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,.12); border-radius: 8px; }
    .oq-row { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 10px; }
    .oq-row:hover { background: var(--oq-bg-soft); }
    .oq-row h4 { margin: 0; font-size: 12.5px; font-weight: 600; }
    .oq-row p { margin: 2px 0 0; font-size: 11.5px; color: var(--oq-dim); }
    .oq-grow { flex: 1; min-width: 0; }
    .oq-kv { display: flex; justify-content: space-between; padding: 7px 2px; font-size: 12px;
      border-bottom: 1px dashed var(--oq-line); }
    .oq-kv span:last-child { color: var(--oq-dim); }
    .oq-switch { width: 34px; height: 20px; border-radius: 999px; background: rgba(255,255,255,.14);
      position: relative; cursor: pointer; border: 0; flex: none; }
    .oq-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
      border-radius: 50%; background: #fff; transition: transform .16s ease; }
    .oq-switch.oq-on { background: var(--oq-accent); }
    .oq-switch.oq-on::after { transform: translateX(14px); }
    .oq-field { display: flex; align-items: center; gap: 8px; margin: 10px 0; font-size: 12px; }
    .oq-field input[type=text] { flex: 1; background: var(--oq-bg-soft); border: 1px solid var(--oq-line);
      color: var(--oq-fg); border-radius: 8px; padding: 6px 9px; font: inherit; outline: none; }
    .oq-field input[type=text]:focus { border-color: var(--oq-accent); }
    .oq-log { font: 11.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; color: #c8d3e2;
      white-space: pre-wrap; word-break: break-all; margin: 0; }
    .oq-toast { pointer-events: none; position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%);
      display: flex; flex-direction: column; gap: 8px; align-items: center; }
    .oq-toast > div { background: rgba(20,24,32,.94); border: 1px solid var(--oq-line);
      padding: 8px 14px; border-radius: 10px; font-size: 12px; box-shadow: 0 12px 30px rgba(0,0,0,.45);
      animation: oq-in .18s ease; }
    @keyframes oq-in { from { opacity: 0; transform: translateY(6px); } }
    .oq-palette { pointer-events: auto; position: absolute; top: 18%; left: 50%; width: 460px;
      transform: translateX(-50%); background: var(--oq-bg); border: 1px solid var(--oq-line);
      border-radius: 14px; box-shadow: 0 30px 70px rgba(0,0,0,.55); overflow: hidden; display: none; }
    .oq-palette.oq-open { display: block; }
    .oq-palette input { width: 100%; border: 0; outline: 0; padding: 14px 16px; font: inherit;
      background: transparent; color: var(--oq-fg); border-bottom: 1px solid var(--oq-line); }
    .oq-palette ul { list-style: none; margin: 0; padding: 6px; max-height: 300px; overflow: auto; }
    .oq-palette li { padding: 8px 10px; border-radius: 8px; cursor: pointer; display: flex; gap: 10px; }
    .oq-palette li.oq-sel, .oq-palette li:hover { background: var(--oq-bg-soft); }
    .oq-palette li em { font-style: normal; color: var(--oq-dim); margin-left: auto; font-size: 11px; }
    .oq-empty { color: var(--oq-dim); font-size: 12px; padding: 18px 4px; }
  `;

  const host = document.createElement('div');
  host.id = 'oicq-ui-host';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.appendChild(style);
  const root = document.createElement('div');
  root.className = 'oq-root';
  shadow.appendChild(root);

  // ------------------------------------------------------------------- markup
  root.innerHTML = `
    <div class="oq-orb" title="oicq (${boot.version})">oq</div>
    <section class="oq-panel">
      <header class="oq-head">
        <span class="oq-title">oicq</span>
        <span class="oq-badge">v${boot.version}</span>
        <span class="oq-spacer"></span>
        <button class="oq-icon" data-act="refresh" title="重新加载插件">⟳</button>
        <button class="oq-icon" data-act="palette" title="命令面板">⌘</button>
        <button class="oq-icon" data-act="close" title="关闭">✕</button>
      </header>
      <nav class="oq-tabs">
        <button class="oq-tab oq-active" data-tab="overview">概览</button>
        <button class="oq-tab" data-tab="plugins">插件</button>
        <button class="oq-tab" data-tab="logs">日志</button>
        <button class="oq-tab" data-tab="appearance">外观</button>
      </nav>
      <div class="oq-body"></div>
    </section>
    <div class="oq-palette">
      <input type="text" placeholder="输入命令…" />
      <ul></ul>
    </div>
    <div class="oq-toast"></div>
  `;

  const orb = root.querySelector('.oq-orb');
  const panel = root.querySelector('.oq-panel');
  const body = root.querySelector('.oq-body');
  const palette = root.querySelector('.oq-palette');
  const paletteInput = palette.querySelector('input');
  const paletteList = palette.querySelector('ul');
  const toastBox = root.querySelector('.oq-toast');

  document.documentElement.appendChild(host);

  // Placement: the orb remembers where the user dropped it.
  const dock = (state.config.ui && state.config.ui.dock) || 'right';
  const orbPos = persisted.orb || (dock === 'left' ? { right: null, left: 24, top: 96 } : { right: 24, left: null, top: 96 });
  placeOrb(orbPos);
  panel.style.width = `${(state.config.ui && state.config.ui.width) || 344}px`;
  if (dock === 'left') {
    panel.style.left = '16px';
  } else {
    panel.style.right = '16px';
  }
  panel.style.top = `${(orbPos.top || 96) + 56}px`;

  function placeOrb(pos) {
    if (pos.left != null) {
      orb.style.left = `${pos.left}px`;
      orb.style.right = '';
    } else {
      orb.style.right = `${pos.right ?? 24}px`;
      orb.style.left = '';
    }
    orb.style.top = `${pos.top ?? 96}px`;
  }

  function persistOrb() {
    persisted.orb = {
      left: orb.style.left ? parseInt(orb.style.left, 10) : null,
      right: orb.style.left ? null : parseInt(orb.style.right || '24', 10),
      top: parseInt(orb.style.top || '96', 10),
    };
    savePersisted();
  }

  // ---------------------------------------------------------------- data flow
  async function call(type, payload) {
    try {
      return await send(type, payload);
    } catch (error) {
      toast(`调用失败: ${type}`);
      return null;
    }
  }

  async function refresh() {
    const next = await call('state');
    if (next && next.config) {
      state.config = next.config;
      state.pluginRows = next.plugins || [];
      state.commands = next.commands || [];
      state.pipelines = next.pipelines || [];
    }
    render();
  }

  function toast(text) {
    const item = document.createElement('div');
    item.textContent = text;
    toastBox.appendChild(item);
    setTimeout(() => item.remove(), 2600);
  }

  // -------------------------------------------------------------------- views
  function render() {
    if (state.active === 'overview') return renderOverview();
    if (state.active === 'plugins') return renderPlugins();
    if (state.active === 'logs') return renderLogs();
    return renderAppearance();
  }

  function renderOverview() {
    const ui = state.config.ui || {};
    body.innerHTML = `
      <div class="oq-kv"><span>版本</span><span>${boot.version}</span></div>
      <div class="oq-kv"><span>插件</span><span>${state.pluginRows.length}</span></div>
      <div class="oq-kv"><span>命令</span><span>${state.commands.length}</span></div>
      <div class="oq-kv"><span>拦截器</span><span>${state.pipelines.reduce((n, item) => n + item.handlers.length, 0)}</span></div>
      <div class="oq-kv"><span>面板热键</span><span>${ui.hotkey || '—'}</span></div>
      <div class="oq-kv"><span>命令面板</span><span>${ui.palette || '—'}</span></div>
      <p class="oq-empty">注入点：V8 编译前改写源码；运行时：runtime/main.js。界面与交互全部由本文件实现。</p>
    `;
  }

  function renderPlugins() {
    if (!state.pluginRows.length) {
      body.innerHTML = '<p class="oq-empty">没有插件。把目录放到 &lt;data root&gt;/plugins/&lt;id&gt; 即可。</p>';
      return;
    }
    body.innerHTML = '';
    for (const plugin of state.pluginRows) {
      const row = document.createElement('div');
      row.className = 'oq-row';
      row.innerHTML = `
        <div class="oq-grow">
          <h4></h4>
          <p></p>
        </div>
        <button class="oq-switch oq-on" title="启用/停用"></button>
      `;
      row.querySelector('h4').textContent = `${plugin.name} · ${plugin.version}`;
      row.querySelector('p').textContent = plugin.description || plugin.id;
      const toggle = row.querySelector('.oq-switch');
      // `enabled` is the switch, `loaded` is whether the instance is live.
      // A disabled plugin stays in the list so it can be switched back on.
      const on = plugin.enabled !== false;
      toggle.classList.toggle('oq-on', on);
      if (!plugin.loaded) row.style.opacity = '0.55';
      toggle.addEventListener('click', async () => {
        const enabling = !on;
        // Live enable/disable: the host tears the plugin down (commands,
        // listeners, interceptors) or loads it without reloading the rest.
        const result = await call(enabling ? 'plugin:enable' : 'plugin:disable', {
          id: plugin.id,
        });
        if (!result || !result.ok) {
          toast(`失败: ${(result && result.error) || plugin.id}`);
          return;
        }
        toast(`${enabling ? '已启用' : '已停用'} ${plugin.id}`);
        await refresh();
      });
      body.appendChild(row);
    }
  }

  async function renderLogs() {
    const result = await call('log:tail', { lines: 120 });
    const lines = (result && result.lines) || [];
    const pre = document.createElement('pre');
    pre.className = 'oq-log';
    pre.textContent = lines.join('\n') || '(空)';
    body.innerHTML = '';
    body.appendChild(pre);
  }

  function renderAppearance() {
    const ui = state.config.ui || {};
    body.innerHTML = `
      <label class="oq-field">强调色
        <input type="text" data-key="accent" value="${ui.accent || '#5b8cff'}" />
      </label>
      <label class="oq-field">停靠
        <input type="text" data-key="dock" value="${ui.dock || 'right'}" />
      </label>
      <label class="oq-field">面板宽度
        <input type="text" data-key="width" value="${ui.width || 344}" />
      </label>
    `;
    body.querySelectorAll('input[data-key]').forEach((input) => {
      input.addEventListener('change', async () => {
        const key = input.getAttribute('data-key');
        const value = key === 'width' ? parseInt(input.value, 10) || 344 : input.value;
        await call('config:set', { patch: { ui: { [key]: value } } });
        if (key === 'accent') root.style.setProperty('--oq-accent', value);
        if (key === 'width') panel.style.width = `${value}px`;
        toast('已保存');
      });
    });
  }

  // ------------------------------------------------------------ interactions
  function setTab(name) {
    state.active = name;
    root.querySelectorAll('.oq-tab').forEach((tab) => {
      tab.classList.toggle('oq-active', tab.getAttribute('data-tab') === name);
    });
    render();
  }

  function togglePanel(force) {
    state.open = force === undefined ? !state.open : force;
    panel.classList.toggle('oq-open', state.open);
    if (state.open) refresh();
  }

  root.querySelectorAll('.oq-tab').forEach((tab) => {
    tab.addEventListener('click', () => setTab(tab.getAttribute('data-tab')));
  });

  root.querySelectorAll('[data-act]').forEach((button) => {
    button.addEventListener('click', async () => {
      const act = button.getAttribute('data-act');
      if (act === 'close') togglePanel(false);
      if (act === 'palette') openPalette();
      if (act === 'refresh') {
        await call('plugin:reload');
        toast('插件已重载');
        refresh();
      }
    });
  });

  orb.addEventListener('click', (event) => {
    if (orb.dataset.dragged === '1') return;
    togglePanel();
    event.stopPropagation();
  });

  // Drag the orb anywhere; the dock corner is just the initial position.
  let drag = null;
  orb.addEventListener('pointerdown', (event) => {
    const rect = orb.getBoundingClientRect();
    drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    orb.classList.add('oq-dragging');
    orb.setPointerCapture(event.pointerId);
    orb.dataset.dragged = '0';
  });
  orb.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const x = Math.max(8, Math.min(window.innerWidth - 52, event.clientX - drag.dx));
    const y = Math.max(8, Math.min(window.innerHeight - 52, event.clientY - drag.dy));
    orb.style.left = `${x}px`;
    orb.style.right = '';
    orb.style.top = `${y}px`;
    orb.dataset.dragged = '1';
  });
  orb.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    orb.classList.remove('oq-dragging');
    persistOrb();
    setTimeout(() => {
      orb.dataset.dragged = '0';
    }, 0);
  });

  // Command palette: fuzzy substring filter, arrow keys, Enter to run.
  let paletteIndex = 0;
  let paletteItems = [];

  function openPalette() {
    palette.classList.add('oq-open');
    paletteInput.value = '';
    paletteIndex = 0;
    renderPalette('');
    paletteInput.focus();
  }

  function closePalette() {
    palette.classList.remove('oq-open');
  }

  function renderPalette(query) {
    const needle = query.trim().toLowerCase();
    paletteItems = state.commands.filter((command) => {
      if (!needle) return true;
      return `${command.title} ${command.id}`.toLowerCase().includes(needle);
    });
    paletteList.innerHTML = '';
    if (!paletteItems.length) {
      const li = document.createElement('li');
      li.textContent = '没有匹配的命令';
      paletteList.appendChild(li);
      return;
    }
    paletteItems.forEach((command, index) => {
      const li = document.createElement('li');
      if (index === paletteIndex) li.classList.add('oq-sel');
      li.innerHTML = `<span></span><em></em>`;
      li.firstChild.textContent = command.title;
      li.lastChild.textContent = command.plugin || 'builtin';
      li.addEventListener('click', () => runCommand(command.id));
      paletteList.appendChild(li);
    });
  }

  async function runCommand(id) {
    closePalette();
    const result = await call('command:run', { id });
    toast(result && result.ok ? `已执行 ${id}` : `失败: ${(result && result.error) || id}`);
  }

  paletteInput.addEventListener('input', (event) => {
    paletteIndex = 0;
    renderPalette(event.target.value);
  });

  paletteInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      paletteIndex = Math.min(paletteIndex + 1, paletteItems.length - 1);
      renderPalette(paletteInput.value);
      event.preventDefault();
    } else if (event.key === 'ArrowUp') {
      paletteIndex = Math.max(paletteIndex - 1, 0);
      renderPalette(paletteInput.value);
      event.preventDefault();
    } else if (event.key === 'Enter' && paletteItems[paletteIndex]) {
      runCommand(paletteItems[paletteIndex].id);
      event.preventDefault();
    } else if (event.key === 'Escape') {
      closePalette();
      event.preventDefault();
    }
  });

  // Hotkeys are parsed from the configured strings rather than hard-coded.
  function comboMatches(combo, event) {
    const parts = String(combo || '')
      .split('+')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    const wants = {
      ctrl: parts.includes('ctrl') || parts.includes('control'),
      meta: parts.includes('cmd') || parts.includes('command') || parts.includes('meta'),
      shift: parts.includes('shift'),
      alt: parts.includes('alt') || parts.includes('option'),
      key: parts.filter((part) => !['ctrl', 'control', 'cmd', 'command', 'meta', 'shift', 'alt', 'option', 'cmdorctrl'].includes(part)).pop(),
    };
    const platformMeta =
      typeof process !== 'undefined' ? process.platform === 'darwin' : /Mac/.test(navigator.platform);
    const comboWantsMeta = parts.includes('cmdorctrl') ? platformMeta : wants.meta;
    const comboWantsCtrl = parts.includes('cmdorctrl') ? !platformMeta : wants.ctrl;
    if (event.ctrlKey !== comboWantsCtrl) return false;
    if (event.metaKey !== comboWantsMeta) return false;
    if (event.shiftKey !== wants.shift) return false;
    if (event.altKey !== wants.alt) return false;
    return (event.key || '').toLowerCase() === (wants.key || '');
  }

  window.addEventListener(
    'keydown',
    (event) => {
      const hotkey = (state.config.ui && state.config.ui.hotkey) || 'CmdOrCtrl+Shift+O';
      const paletteKey = (state.config.ui && state.config.ui.palette) || 'CmdOrCtrl+K';
      if (comboMatches(paletteKey, event)) {
        openPalette();
        event.preventDefault();
      } else if (comboMatches(hotkey, event)) {
        togglePanel();
        event.preventDefault();
      } else if (event.key === 'Escape' && state.open) {
        togglePanel(false);
      }
    },
    true,
  );

  pushHandlers.add((message) => {
    if (!message) return;
    if (message.kind === 'toast') toast(message.text);
    if (message.kind === 'refresh' && state.open) refresh();
  });

  // Plugin renderer snippets: each gets its own function scope plus a
  // read-only handle on the oicq UI, so a snippet cannot clobber the panel.
  // The host may deliver more snippets later (route-scoped contributions), so
  // installation is idempotent per `<id>#<key>` and tabs are reused by name.
  const tabs = new Map(); // name -> {button, draw}
  const installed = new Set();

  function registerTab(name, draw) {
    const existing = tabs.get(name);
    if (existing) {
      existing.draw = draw;
      return existing.button;
    }
    const tab = document.createElement('button');
    tab.className = 'oq-tab';
    tab.textContent = name;
    tab.addEventListener('click', () => {
      const current = tabs.get(name);
      state.active = 'custom';
      root.querySelectorAll('.oq-tab').forEach((item) => item.classList.remove('oq-active'));
      tab.classList.add('oq-active');
      body.innerHTML = '';
      if (current) current.draw(body);
    });
    root.querySelector('.oq-tabs').appendChild(tab);
    tabs.set(name, { button: tab, draw });
    return tab;
  }

  // Page-level styles. Plugins get one id per sheet so re-applying replaces the
  // old one instead of stacking; `addStyle(id, '')` removes the effect.
  const pageStyles = new Map();

  function addStyle(id, css) {
    const key = String(id || 'default');
    let element = pageStyles.get(key);
    if (!css) {
      if (element) element.textContent = '';
      return;
    }
    if (!element) {
      element = document.createElement('style');
      element.setAttribute('data-oicq', key);
      document.head.appendChild(element);
      pageStyles.set(key, element);
    }
    element.textContent = String(css);
  }

  const oicqHandle = Object.freeze({
    version: boot.version,
    bridgePort: boot.bridgePort || 0,
    toast,
    invoke: call,
    openPanel: () => togglePanel(true),
    closePanel: () => togglePanel(false),
    registerTab,
    addStyle,
    // Receive payloads pushed by this plugin's main-process half.
    onMessage: (handler) => {
      pluginHandlers.add(handler);
      return () => pluginHandlers.delete(handler);
    },
  });

  function installSnippet(snippet) {
    if (!snippet || typeof snippet.id !== 'string' || typeof snippet.source !== 'string') return;
    const key = `${snippet.id}#${snippet.key || '*'}`;
    if (installed.has(key)) return;
    installed.add(key);
    try {
      // eslint-disable-next-line no-new-func
      new Function('oicq', snippet.source)(oicqHandle);
    } catch (error) {
      console.error(`[oicq] renderer snippet ${snippet.id}`, error);
    }
  }

  window.__oicq_contrib__ = installSnippet;
  for (const snippet of boot.snippets || []) installSnippet(snippet);

  if (state.config.ui && state.config.ui.autoOpen) togglePanel(true);
  refresh();
})();
