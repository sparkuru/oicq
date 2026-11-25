'use strict';
// builtin: appearance — user CSS plus font/background settings.
//
// Pure UI: no kernel hooks, so it stays available with the bridge off. The
// settings live in <root>/appearance.json; the renderer contribution adds a tab
// that writes them back through commands and applies the CSS immediately.

module.exports = function activate(api, host) {
  const fs = host.require('node:fs');
  const path = host.require('node:path');
  const file = path.join(host.paths.root, 'appearance.json');
  const defaults = { css: '', font: '', background: '' };
  let theme = { ...defaults };
  try {
    theme = { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    /* first run or unreadable */
  }

  const save = () => {
    try {
      fs.writeFileSync(file, `${JSON.stringify(theme, null, 2)}\n`);
      return true;
    } catch (error) {
      api.log('cannot save appearance:', error.message);
      return false;
    }
  };

  api.commands.register({
    id: 'appearance.get',
    title: '读取外观配置',
    hint: '返回 css/font/background',
    run: () => ({ ...theme }),
  });
  api.commands.register({
    id: 'appearance.set',
    title: '保存外观配置',
    hint: '只接受 css/font/background 三个字符串',
    run(patch) {
      if (!patch || typeof patch !== 'object') return { ...theme };
      for (const key of Object.keys(defaults)) {
        if (typeof patch[key] === 'string') theme[key] = patch[key];
      }
      save();
      return { ...theme };
    },
  });
  api.commands.register({
    id: 'appearance.reset',
    title: '恢复默认外观',
    run() {
      theme = { ...defaults };
      save();
      return { ...theme };
    },
  });

  const renderer = [
    "oicq.registerTab('外观增强', (body) => {",
    "  body.innerHTML = [",
    "    '<p style=\"margin:0 0 8px;font-size:12px;opacity:.75\">自定义 CSS 注入当前页面，刷新后仍生效。</p>',",
    "    '<textarea id=\"ap-css\" style=\"width:100%;height:120px;background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:8px;font:11px/1.5 monospace\"></textarea>',",
    "    '<div style=\"display:flex;gap:8px;margin-top:8px\">',",
    "    '<button class=\"oq-switch oq-on\" id=\"ap-save\" style=\"width:auto;padding:0 12px;height:28px\">应用</button>',",
    "    '<button class=\"oq-switch\" id=\"ap-reset\" style=\"width:auto;padding:0 12px;height:28px\">恢复默认</button>',",
    "    '</div>',",
    "  ].join('');",
    "  const area = body.querySelector('#ap-css');",
    "  oicq.invoke('command:run', { id: 'appearance.get' }).then((result) => {",
    "    const value = result && result.ok && result.value ? result.value : {};",
    "    area.value = value.css || '';",
    "    oicq.addStyle('appearance', value.css || '');",
    "  });",
    "  body.querySelector('#ap-save').addEventListener('click', async () => {",
    "    const result = await oicq.invoke('command:run', {",
    "      id: 'appearance.set', payload: { css: area.value },",
    "    });",
    "    if (result && result.ok) { oicq.addStyle('appearance', area.value); oicq.toast('外观已应用'); }",
    "    else oicq.toast('保存失败');",
    "  });",
    "  body.querySelector('#ap-reset').addEventListener('click', async () => {",
    "    await oicq.invoke('command:run', { id: 'appearance.reset' });",
    "    area.value = '';",
    "    oicq.addStyle('appearance', '');",
    "    oicq.toast('已恢复默认');",
    "  });",
    '});',
  ].join('\n');

  return { renderer };
};
