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
