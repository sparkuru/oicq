# 插件模板

复制整个目录到数据根的 `plugins/` 下，改目录名与 `manifest.json` 的 `id`，
两者必须一致。以 `_` 开头的目录不会被扫描，所以这份模板留在这里不会加载。

```bash
cp -r plugins/_template ~/.oicq/plugins/your-plugin
# 然后把 manifest.json 的 id 改成 your-plugin
```

## 文件

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | 身份、版本、权限、贡献点；`api` 必须是 2 |
| `main.js` | 主进程侧，`vm` 内执行，只能 `require('oicq/api')` |
| `renderer.js` | 渲染侧，`new Function('oicq', source)` 执行，拿到冻结的 UI 句柄 |
| `settings.js`（可选） | 按路由注入的额外前端脚本，见下 |

## manifest 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | `[a-z0-9_.-]`，必须等于目录名 |
| `name` | 否 | 面板显示名，缺省用 id |
| `version` | 否 | 字符串，仅展示 |
| `api` | 是 | 固定 `2` |
| `main` | 是 | 入口文件，不能含 `..` |
| `permissions` | 否 | 目前只有 `fs`、`storage`；`kernel` 是内置专用 |
| `contributes.renderer` | 否 | 字符串（所有路由）或 `{ "*": f, "#/setting/settings": g }` |
| `contributes.commands` | 否 | 仅作文档；命令必须在代码里 `api.commands.register` |

## 能力边界

- `fs.read` 只能读插件目录内的文件；`fs.readData`/`writeData` 读写 `<root>/data/<id>.json`。
- 没有网络、`child_process`、`eval`、`new Function`。
- 第三方插件不能申请内核钩子：`permissions: ["kernel"]` 会被直接拒绝加载。
- 需要内核级能力时，做成 `runtime/builtin/` 内置插件，并参考 docs/14-plugin-framework.md。

## 启停

面板里的开关调用 `plugin:enable` / `plugin:disable`。停用时宿主依次调用
`module.exports.dispose()`、`api.lifecycle.onDispose` 注册的回调，再按 owner 清掉
残留的命令、监听器与拦截器。插件自己注册的清理函数负责停掉定时器与外部资源。

## 验收

```bash
node tests/runtime_smoke.js
node tests/kernel_test.js
```
