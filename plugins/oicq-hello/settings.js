'use strict';
// Example plugin — settings route contribution.
//
// Declared as `{"#/setting/settings": "settings.js"}` in the manifest. The host
// injects it when the main window navigates to that hash (and on load if the
// window already sits there), so a single-page app can grow tabs per route
// without a polling loop in the page.

oicq.registerTab('示例 · 设置页', (body) => {
  body.innerHTML = `
    <p style="margin:0 0 12px;font-size:12px;opacity:.75">
      这个标签页只在 <code>#/setting/settings</code> 路由下注入。
    </p>
    <button class="oq-switch oq-on" style="width:auto;padding:0 12px;height:28px"
            id="hello-state">读取宿主状态</button>
  `;
  body.querySelector('#hello-state').addEventListener('click', async () => {
    const result = await oicq.invoke('plugin:list');
    const count = result && result.plugins ? result.plugins.length : 0;
    oicq.toast(`已加载 ${count} 个插件`);
  });
});
