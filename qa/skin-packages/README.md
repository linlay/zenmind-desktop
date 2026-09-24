# Desktop ZIP 皮肤包

在项目根目录运行 `npm run build:skin-example`，生成 `build/qa/alpine-lake.skin.zip`。Desktop 的「设置 → 外观 → 导入皮肤」选择此文件，导入成功后点击「山湖」卡片应用。切换浅色/深色验证两套配色，应用包时可选择保留已有自定义图片。删除当前包会回到默认皮肤。

示例 JSON 位于 [alpine-lake/skin.json](alpine-lake/skin.json)，打包脚本将 [山湖背景](../assets/alpine-lake.png) 放进包内的 `assets/background.png`。解压生成的示例 ZIP 就能得到完整、可编辑的皮肤目录。

```text
alpine-lake.skin.zip
├── skin.json
└── assets/
    └── background.png
```

## 制作自己的包

复制示例目录并修改 JSON 和图片，将 `skin.json` 与 `assets/` 一起压缩成 ZIP。也支持 ZIP 内只有一个外层目录的布局，例如 `my-skin/skin.json`。Finder 生成的 `__MACOSX` 和 `.DS_Store` 会被忽略。

- `schemaVersion` 为字符串 `"1.1"`（旧 `1` 包不再接受）；`id` 使用小写字母开头的字母数字标识，可用点或连字符分段；`version` 使用三段版本，例如 `1.0.0`。
- `name` 是展示名称，`author` 可选，`preview` 可选并引用包内 PNG/JPEG。省略预览图时使用背景图生成缩略图。
- `variants` 同时提供 `light` 和 `dark`。每套包含 `tokens`，也可提供 `background.path` 与 `background.position`。背景按 cover 填充，位置支持 `center`、`top`、`left top` 等组合，或 `50% 40%` 这样的百分比对。
- 颜色 token 接受 HEX、逗号分隔的 `rgb()` / `rgba()` 和 `transparent`；圆角接受 `0px` 到 `32px`。缺省值继承 Desktop 默认外观。允许的完整字段和 token 以 [共享校验器](../../src/shared/desktop-skin-package.ts) 为准。
- 图片必须是包内相对路径引用的 PNG/JPEG，不能使用网络地址、绝对路径或 `..`。未声明的额外文件、脚本和任意 CSS 会被拒绝。
- ZIP 最大 32 MB，展开总量最大 48 MB，单个图片最大 16 MB、3200 万像素，最多 64 个条目。最多安装 20 个包；同 ID 同版本不能重复安装，不同版本可独立保存。

导入会复制并优化资源，因此原 ZIP 或解压目录移动、删除后仍可使用。内置皮肤与已导入皮肤共用主窗口外观层；本格式不改变 WebView 或 Agent WebClient 的背景协议。


## 颜色 token 的透明度

同一个变量的 alpha 是它语义的一部分：切换浅色 / 深色只应改变 RGB，不应改变透明度。否则同一个 `--line` 在浅色下浓度 0.18、深色下 0.07，同一个 `--surface` 在浅色下近乎全透、深色下完全不透，图层关系就失去稳定含义，皮肤看起来也不再和默认色板是同一套设计。

皮肤包的值必须是字面颜色（HEX、`rgb()`、`rgba()`、`transparent`），不接受 `var()` 与 `color-mix()`，因此 alpha 需要显式写出。下表是白名单中全部半透明变量在两套明暗下的取值；未列出的白名单变量是实色或非颜色 token（含 `--control-radius*`、`--overlay-radius`、各类 `--*-text` / `--*-color`），没有透明度约束。

| 变量 | 浅色 alpha | 深色 alpha |
| --- | --- | --- |
| `--accent-glow` | 0.12 | 0.20 |
| `--accent-soft` | 0.16 | 0.16 |
| `--control-active-bg` | 0.16 | 0.22 |
| `--control-border` | 0.25 | 0.25 |
| `--control-button-bg` | 0.85 | 0.20 |
| `--control-disabled-bg` | 0.07 | 0.09 |
| `--control-disabled-opacity` | 0.68 | 0.68 |
| `--control-hover-bg` | 0.09 | 0.13 |
| `--control-input-bg` | 0.92 | 0.92 |
| `--control-popover-bg` | 0.96 | 0.96 |
| `--control-select-bg` | 0.92 | 0.92 |
| `--control-tab-hover-bg` | 0.60 | 0.12 |
| `--line` | 0.13 | 0.13 |
| `--line-strong` | 0.25 | 0.25 |
| `--modal-mask-bg` | 0.18 | 0.18 |
| `--nav-accent-selected-bg` | 0.13 | 0.13 |
| `--nav-hover-bg` | 0.09 | 0.13 |
| `--nav-selected-bg` | 0.14 | 0.18 |
| `--shell-content-bg` | 0.58 | 0.70 |
| `--shell-sidebar-bg` | 0.87 | 0.87 |
| `--shell-titlebar-bg` | 0.90 | 0.90 |
| `--sidebar-operation-menu-bg` | 0.96 | 0.96 |
| `--sidebar-operation-menu-border` | 0.19 | 0.22 |
| `--surface` | 0.72 | 0.72 |
| `--surface-sidebar` | 0.90 | 0.90 |
| `--surface-soft` | 0.90 | 0.90 |
| `--surface-strong` | 0.96 | 0.96 |

两列数值不同的 10 个变量是有意的不对称，不要把它们「对齐」：`--control-active-bg`、`--control-button-bg`、`--control-disabled-bg`、`--control-hover-bg`、`--control-tab-hover-bg`、`--nav-hover-bg`、`--nav-selected-bg` 是控件层级的中性提亮量——浅色下以深色墨色叠加、深色下以白色叠加，数值必然不同；`--shell-content-bg` 在深色下需要更多衬底才能保障浅色文字可读；`--sidebar-operation-menu-border` 在深色下需要更高描边浓度才与浅色等距可见；`--accent-glow` 是光学量，同一 alpha 在黑底与白底上的视觉重量本就不同。除此之外，同一变量在皮肤之间也必须一致：`--control-input-bg` 跟随 `--control-select-bg`，`--control-border` 跟随 `--line-strong`，`--control-popover-bg` 跟随 `--sidebar-operation-menu-bg`，`--nav-hover-bg` 跟随 `--control-hover-bg`，`--control-panel-bg` 跟随 `--accent-soft`——只写前者即可，透明度会一起跟随。

`--shell-sidebar-bg`、`--shell-content-bg`、`--shell-titlebar-bg` 只在有图片背景时被消费；没有图片时外壳使用实色回退，改这三个值不影响无壁纸外观。`--new-chat-surface` 与 `--main-chat-surface` 不在此表，见下面的「聊天页面遮罩」。

校验：`npm run test:skin-visuals` 会解析所有可发现的包并逐变量比对生效 alpha。`qa/skin-packages/alpine-lake` 是本表的参考实现，两态零偏差；`output/skin-collection/sources` 下由脚本生成的主题集合尚未迁移，脚本只对它们报告、不阻断。alpha 之外的颜色仍可按设计自由选择。

## 1.1 图标、艺术字与未读样式

运行 `npm run build:skin-bow-example` 生成 `build/qa/bow-1.1.skin.zip`。这是可直接导入的蝴蝶结风格示例，两套明暗包含功能图标、栏目艺术字和未读心形/数字徽章。

保留现有 Kitty 包的背景与配色时，可执行：

```sh
node qa/skin-packages/build-bow-example.mjs --base /absolute/path/hello-kitty.skin.zip --output build/qa/hello-kitty-1.1.skin.zip
```

该制作工具读取旧包并另存新包，不修改原文件；运行时安装器不做旧包迁移。生成中文艺术字时，macOS 显式使用黑体、Windows 显式使用微软雅黑；其他平台通过 `--font /absolute/path/font.ttf` 指定包含中文字形的字体。

在每个 variant 中增加 `visuals`，例如：

```json
{
  "tokens": { "--accent": "#cb6a93" },
  "visuals": {
    "images": {
      "navigation.search": "visuals/search.png",
      "entry.kanban": "visuals/kanban.png",
      "chat.send": "visuals/send.png",
      "chat.stop": "visuals/stop.png",
      "heading.chats.zh-CN": "visuals/chats-zh.png",
      "heading.chats.en-US": "visuals/chats-en.png"
    },
    "styles": {
      "unread": "#c33170",
      "unreadText": "#ffffff",
      "unreadShape": "heart",
      "badgeShape": "round",
      "headingStyle": "rounded"
    }
  }
}
```

- 视觉图片只接受透明 PNG，单张最多 256 KiB、最大边长 1024，全部视觉图片合计最多 4 MiB；目录条目计入原有 64 条 ZIP 限制。不同槽或明暗模式可复用同一图片路径。
- `images` 使用固定语义槽；允许槽全集见 canonical contract 中的 `SKIN_VISUAL_SLOTS`。未配置、缺图或解码失败时回退现有图标/文本。
- 固定艺术字按 `zh-CN` / `en-US` 提供，动态项目名和对话名保持文本。数字徽章保留真实数字，不制作数字图片。
- 状态颜色只接受不透明三位/六位 HEX；`unreadShape` 为 `circle` / `heart`，`badgeShape` 为 `round` / `pill`，`headingStyle` 为 `default` / `rounded`。待处理颜色可独立提供 `pending` / `pendingText`。
- 图标图片显示在原按钮范围内，必须准备可识别的发送和停止形状，避免用相同装饰替代两者。macOS 红黄绿和 Windows 窗口控制不在普通图标槽中。

两端都需运行本次 1.1 代码。Desktop 负责安装，WebClient 从只读外观资源桥按需获取当前 PNG，不必再次导入，也不会读取本地路径或保存宿主图片到自己的数据库。

## 聊天页面遮罩

在 `variants.light.tokens` / `variants.dark.tokens` 中分别设置 `--new-chat-surface`（新建对话）和 `--main-chat-surface`（已有对话）。可直接填写 `rgba(r, g, b, a)`，alpha 是不透明度：0 完全透明，1 完全不透明；也接受其他受控颜色格式。每项独立可选，仅在有图片背景时使用。

这两项不在上表的透明度契约内：它们没有 `theme.css` 缺省值，只在图片背景下生效，属于和 `--shell-content-bg` 同一类的壁纸衬底，因此浅深两态取值不同是正常的——深色需要更多衬底才能保住浅色文字。但同样的原则适用：它们是让正文可读的半透明衬底，不是不透明底板，不要写成 alpha 为 1 的实色；`--new-chat-surface` 通常比 `--main-chat-surface` 更透，浅色 New Chat 的缺省值就是 `transparent`。

```json
{
  "variants": {
    "light": {
      "tokens": {
        "--new-chat-surface": "rgba(255, 255, 255, 0)",
        "--main-chat-surface": "rgba(255, 255, 255, 0.8)"
      }
    },
    "dark": {
      "tokens": {
        "--new-chat-surface": "rgba(16, 16, 16, 0.2)",
        "--main-chat-surface": "rgba(16, 16, 16, 0.85)"
      }
    }
  }
}
```

以上是需要合并到完整清单的片段，显示当前缺省值。省略任一项时沿用该页面的默认值；浅色 New Chat 缺省为 `transparent`。输入框与推荐卡片的底色不受这两个配置影响。需要同时更新 Desktop 和 WebClient 消费端，旧版本会拒绝不认识的 token。

`chat.screenshot` 已不支持定制；旧包中的该字段会被静默忽略，不校验其值，也不加载所指资源。截图菜单使用客户端原生图标。
