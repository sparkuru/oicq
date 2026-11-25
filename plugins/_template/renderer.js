'use strict';
// Plugin template — renderer side.
//
// Evaluated as `new Function('oicq', source)`: only the frozen handle exists.
// `registerTab` is idempotent by tab name; `addStyle` owns one <style> per id
// and replaces its content on every call, so re-injection is safe.

oicq.registerTab('模板', (body) => {
  body.innerHTML = [
    '<p style="margin:0 0 12px;font-size:12px;opacity:.75">',
    '  这个标签页由插件渲染，宿主只提供 body 容器。',
    '</p>',
    '<button class="oq-switch oq-on" style="width:auto;padding:0 12px;height:28px"',
    '        id="tpl-ping">调用 your-plugin.ping</button>',
  ].join('');
  body.querySelector('#tpl-ping').addEventListener('click', async () => {
    const result = await oicq.invoke('command:run', { id: 'your-plugin.ping', payload: {} });
    oicq.toast(result && result.ok ? `返回: ${result.value}` : '调用失败');
  });
});

// Page CSS is opt-in: keep the id stable so a reload replaces the old sheet.
oicq.addStyle('your-plugin', '');
