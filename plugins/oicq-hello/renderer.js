'use strict';
// Example plugin — renderer side.
//
// Evaluated by runtime/renderer.js inside `new Function('oicq', source)`, so it
// gets the frozen `oicq` UI handle and nothing else. Anything drawn here is the
// plugin's own DOM; the panel only hands over a body element.

oicq.registerTab('示例', (body) => {
  body.innerHTML = `
    <p style="margin:0 0 12px;font-size:12px;opacity:.75">
      这个标签页由插件渲染，宿主不关心它长什么样。
    </p>
    <button class="oq-switch oq-on" style="width:auto;padding:0 12px;height:28px"
            id="hello-ping">调用 hello.say</button>
  `;
  body.querySelector('#hello-ping').addEventListener('click', async () => {
    const result = await oicq.invoke('command:run', { id: 'hello.say' });
    oicq.toast(result && result.ok ? `第 ${result.value.counter} 次` : '调用失败');
  });
});
