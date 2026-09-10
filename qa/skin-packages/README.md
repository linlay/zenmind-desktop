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

- `schemaVersion` 为 `1`；`id` 使用小写字母开头的字母数字标识，可用点或连字符分段；`version` 使用三段版本，例如 `1.0.0`。
- `name` 是展示名称，`author` 可选，`preview` 可选并引用包内 PNG/JPEG。省略预览图时使用背景图生成缩略图。
- `variants` 同时提供 `light` 和 `dark`。每套包含 `tokens`，也可提供 `background.path` 与 `background.position`。背景按 cover 填充，位置支持 `center`、`top`、`left top` 等组合，或 `50% 40%` 这样的百分比对。
- 颜色 token 接受 HEX、逗号分隔的 `rgb()` / `rgba()` 和 `transparent`；圆角接受 `0px` 到 `32px`。缺省值继承 Desktop 默认外观。允许的完整字段和 token 以 [共享校验器](../../src/shared/desktop-skin-package.ts) 为准。
- 图片必须是包内相对路径引用的 PNG/JPEG，不能使用网络地址、绝对路径或 `..`。未声明的额外文件、脚本和任意 CSS 会被拒绝。
- ZIP 最大 32 MB，展开总量最大 48 MB，单个图片最大 16 MB、3200 万像素，最多 64 个条目。最多安装 20 个包；同 ID 同版本不能重复安装，不同版本可独立保存。

导入会复制并优化资源，因此原 ZIP 或解压目录移动、删除后仍可使用。内置皮肤与已导入皮肤共用主窗口外观层；本格式不改变 WebView 或 Agent WebClient 的背景协议。
