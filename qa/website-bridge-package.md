# 网站桥包结构与制作

设置 → 网站桥支持导入、导入更新、导出 ZIP、启停、卸载，以及查看页面规则、共享模块和页面脚本。更新使用相同 `id`，保留原启用状态；两个包只要声明了任一相同域名就不能同时启用。字段及限制以 `src/shared/website-bridge.ts` 为准。

## 包结构

一个网站桥是一个 ZIP，根目录结构固定（也接受单层包目录包裹）：

```text
bridge.json                  清单：身份、版本、域名（站点系统）、页面
pages/<页面ID>.js             一个页面一个文件
shared/<模块>.js              与站点系统无关、可被所有页面引用的共享模块
shared/<域名标识>/<模块>.js    属于该域名系统的共享模块，只服务该域名的页面
```

包内不允许其他文件：页面缺脚本、被引用的模块缺文件、有模块但没有页面引用、出现说明或测试文件，都会被拒绝。

## bridge.json

```json
{
  "schemaVersion": 2,
  "id": "office",
  "name": "示例办公",
  "version": "1.0.0",
  "description": "站点级说明，进入 AWCP 手册目录。",
  "origins": {
    "portal": { "url": "https://portal.example.test", "name": "流程平台", "description": "Ant 表单；人员用平台用户选择弹窗。" },
    "kms": "https://kms.example.test"
  },
  "pages": {
    "home": { "origin": "portal", "path": "/home", "name": "首页" },
    "flow": { "origin": "portal", "path": "/flow", "name": "未识别流程" },
    "leave-request": {
      "origin": "portal", "path": "/flow", "name": "请假申请",
      "match": [
        { "hashQuery": { "bizkey": "HR/Leave" } },
        { "title": "请假申请" }
      ],
      "shared": ["core", "portal/form", "portal/user-picker"]
    },
    "kms": { "origin": "kms", "path": "/web", "shared": ["core", "kms/form"] }
  }
}
```

- **域名只写在 `origins`**：标识到精确 origin（协议＋主机＋端口）的映射，不支持子域通配。值可以是 URL 字符串，或 `{ url, name?, description? }`；一个域名是一套站点系统，名称与说明进入手册，提示调用者各系统的控件与附件实现不同。其余位置只用标识和根相对路径。切换环境只改这里。
- **单域名网站**：`origins` 只有一项时，页面可以省略 `origin`。
- **`pages`**：键是页面 ID，固定对应 `pages/<页面ID>.js`，清单不写脚本路径。`name`、`description` 可选，进入手册站点说明。
- **URL 粗选**：按当前页面的 origin 与 pathname 选出最具体的 URL 形状下的全部页面；忽略 query/hash 和末尾斜杠，支持整段 `:postId` 参数，静态路由优先；不匹配接口请求地址。同一 URL 形状的页面必须写同一路径，最多一个不带 `match`。
- **`match` 细选**：规则数组，任一规则命中即算命中；一条规则内的条件全部满足。条件全部精确相等，比较前会压缩页面上的空白，所以值本身不能含首尾或连续空白：

  | 条件 | 含义 |
  | --- | --- |
  | `hashQuery` | URL hash 中 `?` 之后的参数，每个参数恰好出现一次且等于给定值 |
  | `title` | `document.title` 等于给定值 |
  | `text` | 某个可见元素自身的文字（不含子元素）等于给定值 |

  恰好一个带 `match` 的页面命中时加载该页；没有命中或多页命中时，使用同一 URL 形状下不带 `match` 的页面，没有则无业务动作。不支持选择器、包含/前后缀匹配或字段指纹。只有记录 ID 的路由（保存后、办理中）用标题或固定文字识别；新建页可用业务参数识别。
- **`shared`**：按顺序加载的共享模块名。`core` 对应 `shared/core.js`，`portal/form` 对应 `shared/portal/form.js`，后者只能被 `origin` 为 `portal` 的页面引用。
- **版本**：只在 `version` 记录；脚本和 README 不各自维护版本，ZIP 文件名由 `<id>-<version>.zip` 推导。

## 共享模块与页面脚本

两者都是同步函数体，不使用 ESM import/export，不依赖 Node，都收到只读的 `context`。共享模块返回工具对象（可带 `dispose`），不声明动作；页面脚本返回它提供的业务动作：

```js
// shared/portal/user-picker.js
const { core } = context.shared;
return {
  async choose(field, names, signal) { /* 打开原生用户选择、搜索、确认并回读 */ },
};
```

```js
// pages/leave-request.js
const { core, 'portal/form': form, 'portal/user-picker': picker } = context.shared;
return {
  actions: () => ({
    'leave.read': {
      title: '读取请假申请',
      description: '只读回读当前字段与按钮。',
      inputSchema: { type: 'object', properties: {} },
      async run() { return { ok: true, result: form.read() }; },
    },
  }),
  dispose() {},
};
```

- `run(args, signal)` 返回 `{ ok: true, result }` 或 `{ ok: false, error: { code, message, details? } }`；抛出的异常由运行时转为失败结果。
- `actions` 也可以是函数，用于从当前可见界面派生动作；手册 revision 跟随所选页面与声明内容变化。
- `dispose` 可选，负责停止观察器、移除监听器；换页、离开规则或卸载时调用。初始化不能返回 Promise。
- 脚本不设置 `globalThis.awcp`，不写域名，不写版本。

`context` 字段：

| 字段 | 含义 |
| --- | --- |
| `bridge` | `{ id, version }`，来自清单 |
| `page` | `{ id, name, via }`：所选页面与命中的条件键（如 `hashQuery`、`title`），仅按路径选中时 `via` 为 `null` |
| `originKey`、`origin` | 当前页命中的域名标识和完整 origin |
| `pathname`、`params` | 当前页路径和解码后的路径参数 |
| `revision`、`signal` | 本次安装的修订标识；换页、卸载或离开页面时取消的信号 |
| `resolve(path, originKey?)` | 根相对路径转完整 URL；同域只传路径，跨域加域名标识 |
| `shared` | 已加载模块的返回值，以模块名为键；页面脚本看到它声明的全部模块，模块只看到排在它前面的模块 |

模块实例在每次选中页面时重新创建，同一页面的模块与脚本共享这些实例；换页后不保留任何页面内状态。跨域目标在动作参数和返回结果中写成 `{ origin: "kms", path: "/web/#/..." }`。

## 运行时

Desktop 的页面运行时把所选页面的动作作为唯一的 `globalThis.awcp`（AWCP v1 的 manual / invoke / cancel），并统一处理手册目录、参数 Schema 校验、重复 requestId 防护、30 秒超时、取消和页面切换清理。Schema 支持 `object`、`array`、`string`、`integer`、`number`、`boolean` 及 `enum`、长度与范围约束；对象默认拒绝未声明字段。

AWCP v1 目录没有页面字段：站点说明依次包含清单说明、各域名系统、当前页面名称与识别依据、页面说明，以及未识别、歧义或换页失败的原因。hash 导航和每次读取手册都会重新识别；所选页面变化时，在途请求被取消、旧脚本与模块被回收。

注入时选中的页面脚本或模块返回值不合约、返回 Promise 或初始化抛错时，整页不安装；之后换页失败只在站点说明报告且不提供动作。页面已有原生 AWCP 时不覆盖。

## 制作与验证

桥包源码、打包脚本和各桥的隔离回归保存在环境仓库的 `web-bridges-center/`。ZIP 只包含清单和脚本，不包含 Cookie 或 Desktop 凭据；登录使用 Desktop 网页自己的会话。

持久化资源在 `<desktop-data-root>/data/website-bridges/<id>/`，安装和启用清单在 `<desktop-data-root>/config/website-bridges/website-bridges.json`。默认品牌的数据根为品牌运行目录中的 `.desktop`，路径来源沿用 Desktop 的平台路径函数。

升级前安装的旧格式包（`schemaVersion: 1` 的 `pages[].script`，以及 `pages` 数组、`features/`、`shared.js` 的功能布局）不再加载，在设置中显示“需要更新”；导入同 ID 的新版包即可恢复，启用状态保留。

验证：`node --test test/website-bridge.test.mjs test/awcp-addons.test.mjs`；真实设置页交互：`node qa/website-bridges-smoke.mjs`（临时目录、隔离 Electron profile）。macOS 和 Windows 的完整人工流程见 `qa/manual-regression.md`。
