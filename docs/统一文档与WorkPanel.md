# 统一文档与 WorkPanel

## 文档定位

本文定义 WorkPanel 打开、展示、编辑、批注与保存文档的长期边界。精确字段、分类枚举和 bridge 结构以 shared contract 与测试为准。

这一模型不包含用户从系统文件选择器临时打开的项目外文件；它们继续由 host-only 本地文件能力承载。

## 两个正交维度

文档来源决定身份、权限和保存语义，内容类型决定 renderer 和可用能力；二者不得互相推断。

| 来源 | 权威身份 | 默认保存 |
| --- | --- | --- |
| Workspace File | Agent 与规范 workspace 相对路径 | 带预期 revision 原位覆盖 |
| Artifact | Chat、Artifact 与相对路径 | 创建新 Artifact；用户可明确选择带 revision 覆盖 |
| Reference | Chat、Reference 与相对路径 | 只能创建新 Artifact |
| Live Project Web | loopback URL 与 owner Chat 对应的 Coder workspace | 不写 DOM；批注交给 Coder 修改源码 |
| 普通 Web | HTTP(S) URL | 不保存页面，仅交接 DOM 批注 |

revision 在所有客户端中都是不透明值。Platform 在提交时重新验证来源身份、路径、权限和 revision；冲突不得静默覆盖。

## 内容类型与宿主所有权

Desktop 只原生承载 HTML 和图片。Markdown、文本、代码、PDF、Office、音视频、压缩包和未知二进制都由 Agent WebClient Document Surface 承载，因而 Desktop 内嵌与 Standalone 共用一份实现。

| 内容类型 | Desktop | Standalone | 可变更能力 |
| --- | --- | --- | --- |
| HTML | 原生隔离 Surface | WebClient 源码与 sandbox 预览 | 静态文件可编辑源码和 DOM 批注；实时站点只批注交接 |
| 图片 | 原生图片 Surface | WebClient 可解码预览与基础 Canvas | PNG/JPEG/WebP 可编辑保存；动画、SVG 及其他格式只读 |
| Markdown/文本/代码 | WebClient | WebClient | Monaco 编辑、范围批注与带 revision 保存 |
| PDF | WebClient | WebClient | PDF.js 只读预览、页码、缩放与搜索 |
| Office/音视频 | WebClient | WebClient | 只读预览或元信息；Desktop 可使用系统打开与定位 |
| 压缩包/未知二进制 | WebClient | WebClient | 元信息与显式下载，不伪装为文本 |

Platform 的 MIME、签名和文本探测是加载后最终事实。WebClient 可以用扩展名做加载前临时分类；Desktop 在创建 HTML/图片原生 Surface 前必须从权威来源重新检查，不信任 guest 自报类型。

## 统一打开流程

Main Chat 卡片、Markdown 链接、Project 文件、Artifact 和 Reference 只提交语义来源，不自行选择 Viewer。打开流程先规范化来源并获得内容类型；Desktop 的 HTML/图片调用 canonical `openDocument` 进入原生 registry，其他内容产生 WebClient descriptor。Standalone 始终进入 WebClient Document Surface。

WorkPanel item 的 stable identity 只取决于来源，不取决于 renderer。只有 `unsupported_native_type` 可以由 Desktop 原生打开退回 WebClient；身份、路径、缺失、越界或 revision 失败一律 fail closed。历史 `/file-viewer` 与 `/resource-viewer` 路由保留，但内部共用 Document Surface。

## Desktop 原生安全边界

Document Registry 只接收语义来源，并用绑定 sender、owner Chat 与 renderer generation 的一次性 claim 下发 opaque handle。Renderer 不获得绝对路径、Platform Token 或内部 descriptor。

HTML 脚本在隔离预览中运行，不获得 Node、Desktop bridge、popup 和任意权限。源码修改先只更新内存预览。批注仅保存有界 selector/XPath、坐标和脱敏摘要；文档重建后无法定位的批注显式失效。

图片 Surface 对 PNG/JPEG/WebP 保留像素编辑、撤销/重做、AI 工具和区域批注。非编辑格式只读，不得通过错误扩展名或隐式栅格化覆盖原件；JPEG 不接受含透明像素的覆盖结果。系统打开、定位和解码链路必须分别回归 macOS 与 Windows。

## 实时 loopback 项目

`localhost`、`*.localhost`、`127.0.0.0/8` 和 `[::1]` 是 loopback。当 owner Chat 是绑定有效 workspace 的 Coder 时，WorkPanel 为该 Web item 赋予 `live-project-web` 交接语义，但不赋予页面任何新权限。preload 只可交付脱敏 DOM 摘要、selector/XPath、坐标、URL 和可选截图；Coder 修改 workspace 后再通过 HMR 或刷新验证。顶层导航离开 loopback 后立即退化为普通 Web。

## 状态、标题与兼容

WebClient 文档和 Desktop 原生 Surface 都向 WorkPanel 提交当前 item 绑定的 dirty、busy 和 annotation count。关闭当前、关闭其他、切换原生编辑器和 WorkPanel 全屏生命周期共用同一未保存保护规则。

File descriptor 的 tab 标题固定为“显式 title > 路径 basename > `file`”，同时支持 POSIX、Windows 与 UNC 分隔符。WebClient 主动生成，Desktop 对旧 bundle 再做相同兜底；该修复不改 stable key、`surfaceId` 或 descriptor schema。

canonical Desktop/WebClient bridge v6 增加 `openDocument`，同时保留旧方法供历史 bundle 运行。`DESKTOP_APP=true` 时的版本不兼容必须显式失败，不得偷偷转为 Standalone。
