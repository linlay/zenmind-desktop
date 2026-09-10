# Desktop 外观验收

## 自动检查

在已经安装仓库依赖、准备好品牌输入的 macOS 或 Windows 开发机上运行：

```sh
npm run test:appearance
```

此命令按顺序检查架构与中英文键、构建 Main/preload/renderer、执行外观与相关配置路径测试，再执行两组 Electron 验收。默认使用构建系统选中的品牌；其他品牌沿用仓库的 `BRAND` 配置方式。

测试不启动业务服务，不读取用户 Desktop profile，也不替换安装版。图片、配置和 Chromium profile 都位于系统临时目录；输出包含截图与 JSON 报告位置。键盘测试会短暂显示并聚焦一个独立测试窗口，随后关闭。日志中预期出现的保存失败及非主窗口调用拒绝用于验证回滚与权限边界，最终结果以退出码和 `ok` 报告为准。

### 检查覆盖

| 检查 | 自动验证内容 |
| --- | --- |
| 状态和存储 | 旧 profile、启动缓存、快速切换、异步迟到、串行保存、写入失败回滚、恢复刷新、跨字段保存 |
| 图片 | PNG/JPEG、字节与像素上限、缩放、透明通道、中文/空格/特殊文件名、取消、原图删除、损坏副本、恢复背景 |
| 主界面 | 明暗与系统跟随、原生及 Ant 控件、选中/悬停/按下/禁用、body 浮层、图片失败回退、无 Shell 或 guest 重建 |
| 平台样式 | macOS/Windows CSS 分支、Windows 系统栏布局、默认透明合成恢复、窗口缩放及滚动 |
| 运行产物 | 实际开发 preload、实际品牌发布 preload、生产 CSP、从 renderer 发布 bundle 提取的两个背景资源 |
| 跨进程 | 退出写入进程后另开 Electron 进程，恢复主题、皮肤、自定义背景和语言 |
| 交互 | 真实键盘 Tab/Enter 与焦点框、最小窗口尺寸、英文长文案、125% 缩放、输入内容保留 |
| 所有权 | 非主窗口及子 frame 拒绝，文件路径不经 renderer 传入，导入不修改原图 |

单独运行 `node qa/desktop-appearance-smoke.mjs` 或 `node qa/desktop-appearance-release.mjs` 时，必须先构建 Main 和 renderer。前者提供交互预览和控件截图；后者加载实际 preload、测试生产资源并完成跨进程验证。预览组件来自源码；生产资源和 preload 检查直接读取构建产物，不在测试里重新打包这些 preload。

前者还通过真实 Main 导入一张山湖图片，并输出 `photo-mac-light.png`、`photo-mac-dark.png` 和 Windows 样式的对应截图。将其输出的 `preview/` 目录作为静态站点打开，访问 `?background=photo` 即可直接看整张图片铺在界面底层的效果，或在设置页导入自己的图片。素材与生成提示词见 [图片背景演示素材](assets/alpine-lake.md)。

## 真机边界

CSS 的 Windows 分支检查不能证明 Windows 原生窗口已验收。发布前分别在两种系统运行以上命令，并按 [手工回归清单](manual-regression.md) 验证系统文件选择器取消与关闭、traffic lights/Windows 窗口按钮、标题栏拖拽、双击、最大化和全屏。报告中的 `nativePlatform` 表示实际宿主，`windowsNativeVerified` 只有在 Windows 宿主上运行成功才为 true。

背景一致性仅覆盖 Desktop 主窗口。WebView 继续保持原有 guest 背景与明暗契约，WebClient 的背景协作属于独立任务，不通过 CSS 注入或重载实现。
