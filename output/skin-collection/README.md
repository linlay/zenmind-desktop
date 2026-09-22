# 主题皮肤集合

本次大溪地和黄金圣斗士升级至 **1.3.0**，schemaVersion 为 `1.1`。每包包含独立白天/黑夜背景，随 light/dark 自动切换。其余皮肤成品和源资源保持原样。

| 安装包 | 内容 |
| --- | --- |
| [tahiti.skin.zip](tahiti.skin.zip) | 白天：海、海岛、波利尼西亚支架独木舟；黑夜：海岛、星空与银河；16 张中英文浅深色透明手绘栏目艺术字 |
| [gold-saints.skin.zip](gold-saints.skin.zip) | 白天：阳光、圣域、雅典娜；黑夜：射手座、圣域、星空 |
| [pink-kitty.skin.zip](pink-kitty.skin.zip) | Hello Kitty，保留 |
| [walnut-song.skin.zip](walnut-song.skin.zip) | 宋式雅居，保留 |
| [wanyao-tulu-zhuan.skin.zip](wanyao-tulu-zhuan.skin.zip) | 万妖图录传，保留 |

按用户后续要求，大溪地白天也重新绘制。生成使用内置 image_gen，完整提示词见 [refresh-prompts.json](refresh-prompts.json)。背景控制视觉噪声，将主体集中在右侧，中央为聊天阅读空间。

四栏目为置顶 / Pinned、对话 / Chats、项目 / Projects、站点 / Sites。艺术字源图集与透明切片位于 tahiti-artwork/，浅深色、小尺寸合成见 [tahiti-headings-preview.png](tahiti-headings-preview.png)。

[preview.html](preview.html) 提供主题、浅深色、中英文切换，包含侧栏、输入框和推荐卡片遮挡示意。这是静态组合预览，不是生产 WebClient 截图。四张新 Electron 截图位于 previews/。

源清单与资源在 sources/。两个新包都覆盖每模式 36 个语义槽。为满足 64 条目上限，大溪地的相同项目/站点 PNG 复用；圣斗士昼夜共用原浅色红色停止盾牌图标，其余功能图标保持原资源。包内仅包含声明资源。

重建本次两个包并更新集合预览：

```sh
node output/skin-collection/slice-tahiti-headings.mjs
node output/skin-collection/build-refresh.mjs
```

项目实际清单与 ZIP 校验器检查路径、CRC、尺寸、总量、图片解码及语义槽，结果见 validation.json。macOS 隔离 Electron 校验：

```sh
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron output/skin-collection/check-refresh.cjs
```

Windows 请移除 ELECTRON_RUN_AS_NODE 后使用 node_modules/.bin/electron.cmd 运行同一脚本。本次未进行 Windows 真机及生产 WebClient 联调；平台原生窗口与业务状态需按 qa/manual-regression.md 验收。

安装：设置 → 外观 → 导入皮肤，选择新版本并应用；使用包内背景时不要保留已有自定义图片。
