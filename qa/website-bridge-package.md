# 网站桥包结构与制作

设置 → 网站桥支持导入、导入更新、导出 ZIP、启停、卸载，以及查看页面规则和功能脚本。更新使用相同 `id`，保留原启用状态；两个包只要声明了任一相同域名就不能同时启用。字段及限制以 `src/shared/website-bridge.ts` 为准。

## 包结构

一个网站桥是一个 ZIP，根目录结构固定（也接受单层包目录包裹）：

```text
bridge.json            清单：身份、版本、域名、页面 → 功能
features/<功能名>.js    一个业务功能一个文件
shared.js              可选：本包各功能共用的页面辅助代码
```

包内不允许其他文件：被页面引用的功能缺文件、有文件但没有页面引用、出现说明或测试文件，都会被拒绝。

## bridge.json

```json
{
  "schemaVersion": 2,
  "id": "shop",
  "name": "示例商城",
  "version": "1.0.0",
  "description": "站点级说明，进入 AWCP 手册目录。",
  "origins": {
    "store": "https://store.example.test",
    "mall": "https://mall.example.test"
  },
  "pages": [
    { "origin": "store", "path": "/item.htm", "features": ["product-read"] },
    { "origin": "mall", "path": "/item.htm", "description": "本页专属提示。", "features": ["product-read", "cart-add"] }
  ]
}
```

- **域名只写在 `origins`**：标识到精确 origin（协议＋主机＋端口）的映射，不支持子域通配。其余位置只用标识和根相对路径。切换环境只改这里。
- **单域名网站**：`origins` 只有一项时，页面可以省略 `origin`。
- **`pages[].features`**：功能名固定对应 `features/<功能名>.js`，清单不写脚本路径。同一功能可用于多个页面和多个域名。
- **匹配**：按当前页面的 origin 与 pathname 选择规则；忽略 query/hash 和末尾斜杠，支持整段 `:postId` 参数，静态路由优先；不匹配接口请求地址。
- **版本**：只在 `version` 记录；功能脚本和 README 不各自维护版本，ZIP 文件名由 `<id>-<version>.zip` 推导。

## 功能脚本

每个功能是一个同步函数体，不使用 ESM import/export，不依赖 Node。Desktop 注入只读的 `context`，脚本返回它提供的业务动作：

```js
// features/cart-add.js
return {
  actions: {
    'cart.add': {
      title: '加入购物车',
      description: '核对已选规格后点击原生加购按钮，并观察结果。',
      inputSchema: { type: 'object', properties: {} },
      async run(args, signal) {
        // 只操作页面原生控件。
        return { ok: true, result: { status: 'submitted' } };
      },
    },
  },
  dispose() {},
};
```

- `run(args, signal)` 返回 `{ ok: true, result }` 或 `{ ok: false, error: { code, message, details? } }`；抛出的异常由运行时转为失败结果。
- `actions` 也可以是函数，用于从当前可见界面派生动作；此时手册 revision 跟随声明内容变化。
- `dispose` 可选，负责停止观察器、移除监听器。初始化不能返回 Promise。
- 功能脚本不设置 `globalThis.awcp`，不写域名，不写版本。

`context` 字段：

| 字段 | 含义 |
| --- | --- |
| `bridge` | `{ id, version }`，来自清单 |
| `originKey`、`origin` | 当前页命中的域名标识和完整 origin |
| `pathname`、`params` | 当前页路径和解码后的路径参数 |
| `revision`、`signal` | 本次安装的修订标识；卸载或离开页面时取消的信号 |
| `resolve(path, originKey?)` | 根相对路径转完整 URL；同域只传路径，跨域加域名标识 |
| `shared` | `shared.js` 的返回值；没有该文件时为 `undefined` |

跨域目标在动作参数和返回结果中写成 `{ origin: "mall", path: "/item.htm?id=1" }`；多域名包的手册目录会附上域名标识映射。

## 运行时

Desktop 的页面运行时把当前页的功能组合成唯一的 `globalThis.awcp`（AWCP v1 的 manual / invoke / cancel），并统一处理手册目录、参数 Schema 校验、重复 requestId 防护、30 秒超时、取消和页面切换清理。Schema 支持 `object`、`array`、`string`、`integer`、`number`、`boolean` 及 `enum`、长度与范围约束；对象默认拒绝未声明字段。

同页两个功能声明同名动作、功能返回值不合约或初始化抛错时，整页不安装。页面已有原生 AWCP 时不覆盖。

## 制作与验证

桥包源码、打包脚本和各桥的隔离回归保存在环境仓库的 `web-bridges-center/`。ZIP 只包含清单和脚本，不包含 Cookie 或 Desktop 凭据；登录使用 Desktop 网页自己的会话。

持久化资源在 `<desktop-data-root>/data/website-bridges/<id>/`，安装和启用清单在 `<desktop-data-root>/config/website-bridges/website-bridges.json`。默认品牌的数据根为品牌运行目录中的 `.desktop`，路径来源沿用 Desktop 的平台路径函数。

升级前安装的旧格式包（`schemaVersion: 1`）不再加载，在设置中显示“需要更新”；导入同 ID 的新版包即可恢复，启用状态保留。

验证：`node --test test/website-bridge.test.mjs test/awcp-addons.test.mjs`；真实设置页交互：`node qa/website-bridges-smoke.mjs`（临时目录、隔离 Electron profile）。macOS 和 Windows 的完整人工流程见 `qa/manual-regression.md`。
