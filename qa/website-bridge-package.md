# 网站桥包示例与制作

设置 → 网站桥支持导入、导入更新、导出 ZIP、启停、卸载，以及查看页面规则和脚本。可先导出内置论坛包，解压修改后再导入。更新使用相同 `id`，保留原启用状态；每个 origin 同时只能启用一个包。

ZIP 根目录结构（也接受单层包目录包裹）：

```text
bridge.json
pages/forum.js
pages/new-post.js
pages/post.js
pages/notifications.js
```

`bridge.json` 示例：

```json
{
  "schemaVersion": 1,
  "id": "qiuer-forum",
  "name": "1024 Forum",
  "version": "1.2.3",
  "origin": "https://1024.qiuer.net",
  "pages": [
    { "path": "/forum", "script": "pages/forum.js" },
    { "path": "/forum/new", "script": "pages/new-post.js" },
    { "path": "/forum/posts/:postId", "script": "pages/post.js" },
    { "path": "/forum/notifications", "script": "pages/notifications.js" }
  ]
}
```

一个网站一个包；每条规则匹配浏览器当前页面 pathname，选择一个 JS。JS 内可注册多个动作。路径忽略 query/hash 和末尾斜杠，支持整段 `:postId` 参数；静态路由优先。origin 必须精确匹配，不支持任意子域通配。规则不匹配接口请求地址。字段及限制以 `src/shared/website-bridge.ts` 为准。

每个 JS 是同步函数体，不使用 ESM import/export，也不依赖 Node。Desktop 提供只读 `context`，包含 `pathname`、解码后的 `params`、本次脚本的 `revision`、卸载时取消的 `signal`。脚本设置 `globalThis.awcp`，暴露 AWCP v1 的 manual/invoke/cancel；使用 `context.revision` 作为手册版本。异步业务放在 invoke 内，初始化不能返回 Promise。初始化可返回清理函数，负责停止观察器、移除监听器和取消请求。可以参考导出的论坛脚本，它已包含多个动作、参数校验及取消逻辑。

```js
// 这里创建自己的 AWCP v1 实现；可以包含多个动作。
const protocol = createYourAwcpProtocol(context);
globalThis.awcp = protocol;
return () => protocol.dispose();
```

上述片段是生命周期示意，`createYourAwcpProtocol` 需要在包内脚本中自行实现。完整可导入的论坛包由以下命令生成：

```sh
npm run build:main:types
node qa/build-website-bridge-example.mjs
```

输出 `build/examples/website-bridges/qiuer-forum-1.2.3.zip`。ZIP 只包含 manifest 和引用的 JS，不包含 Cookie 或 Desktop 凭据。登录使用 Desktop 网页自己的会话。

持久化资源在 `<desktop-data-root>/data/website-bridges/<id>/<内容摘要>/`，安装和启用清单在 `<desktop-data-root>/config/website-bridges/website-bridges.json`。默认品牌的数据根为品牌运行目录中的 `.desktop`，路径来源沿用 Desktop 的平台路径函数。

验证：`node --test test/website-bridge.test.mjs`；真实设置页交互：`node qa/website-bridges-smoke.mjs`（临时目录、隔离 Electron profile）。macOS 和 Windows 的完整人工流程见 `qa/manual-regression.md`。

发帖页提供 `forum.compose.fill`、`forum.compose.publish`。填写返回实际表单内容和 `draftToken`，确认内容后向 publish 传入该 token；填写本身不发布。正文及元数据若被用户修改，旧 token 不再有效。当前流程仅支持纯文字，不处理上传图片或附件。发送动作点击页面原生发布按钮，由网站处理校验、CSRF、请求及跳转。返回 submitted 仅确认表单提交事件，不宣称服务端发布成功；后续通过页面结果确认，不重复点击。

隔离 React 表单回归：`node qa/forum-compose-smoke.mjs`。其网络完全模拟，不连接真实论坛，也不发布测试帖子。
