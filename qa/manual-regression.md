# Desktop 手工回归清单

## 品牌应用与托盘图标

- Windows 开发模式分别以 `BRAND=zenmind` 和 `BRAND=cutej` 启动，确认任务栏使用当前品牌生成的 ICO，不受已安装旧版本、开始菜单快捷方式或图标缓存影响。
- Windows 分别让同品牌正式安装版与开发版同时运行，确认正式版使用品牌正式 AppUserModelID、开发版使用其 `.dev` 身份，并显示为两个独立任务栏分组；ZenMind 与 CuteJ 之间也不得互相分组。
- Windows 开发模式和安装包分别检查主托盘区与溢出面板，确认使用透明品牌 tray 图，图标周围没有应用 ICO 的白色底板或淡色方框。
- macOS 分别检查两品牌 Dock 和菜单栏图标，确认 Dock 图标尺寸不变，菜单栏仍按 template image 渲染。

## Windows 主窗口系统栏

- 在 Kanban、设置和 Agent WebClient 页面确认薄系统栏独立横跨主窗口顶部，侧栏与内容从系统栏下方开始；浅色、深色和最大化状态下均无重叠或跳动。
- Windows 主导航模式下确认搜索、侧栏开关、后退、前进和智能体面板五个按钮紧跟在 Logo 与品牌名后，侧栏顶部不再重复显示；设置与能力目录继续使用各自的二级导航头部。
- CuteJ 品牌确认系统栏只显示 Logo、不显示 `CuteJ` 文字；ZenMind 仍显示 Logo 与品牌名。
- 逐一点击系统栏五个按钮，确认搜索弹层、侧栏展开/收起、历史前进后退及智能体面板行为与迁移前一致；不可用的历史方向和智能体入口保持禁用且不可聚焦。
- 使用真实鼠标分别点击按钮图标中心与空白拖动区：按钮点击不得触发窗口拖动，空白区仍可正常拖动窗口。
- 在主 renderer 与聚焦 webview 中分别按 `Ctrl+Shift+I`，确认都只切换主 renderer 的停靠式 DevTools；按钮始终留在 ZenMind 系统栏。按 `Ctrl+Shift+D` 仍只为当前 focus webview 打开独立 DevTools。
- 点击最小化、最大化/还原，确认状态图标及时更新；分别通过系统栏关闭按钮、`Alt+F4` 和任务栏右键“关闭窗口”触发关闭，确认只显示一个现有的退出确认框，取消后窗口保持显示，确认后完成受管任务与服务清理并真正退出。托盘菜单“退出”仍直接执行安全退出；打开全局搜索或可信 guest 模态层时窗口按钮被遮罩且不可点击。
- macOS 确认仍使用原生 traffic lights，标题栏、全屏和 `Cmd+W` 行为不变。

## WorkPanel 自由新增 Tab

- 在 macOS 与 Windows 分别打开一个稳定 Chat，确认 Overview 固定首项，`32×32px` 的 `+` 紧跟最后一个 tab 并随横向溢出滚动。
- 在浅色、深色、Windows 标题栏偏移和 WorkPanel 全屏下检查菜单定位、圆角、hover/focus、Esc、方向键、Home/End 与 Enter。
- 确认菜单顺序为 Terminal、Web、Files、Side Chat、Project、WebApp；Terminal 禁用且没有快捷键或 PTY。
- Web 输入无协议域名时补 `https://`；拒绝凭据和非 HTTP(S) URL。重复 URL 激活已有 tab，不共享 Website/SSO partition；popup 留在所属 Chat。
- 激活普通 Web tab 时确认标签栏下只增加一行浏览器工具栏：后退、前进、刷新按真实导航状态启用；地址可直接点击输入并以 Enter 导航、Esc 取消。“编辑”进入网页元素批注并变为“完成”，不承担地址解锁。可批注的 `openLocalFile` HTML 与仍由 Resource Viewer 承载的 Artifact/Reference HTML 显示各自受限评审工具栏；原生图片、WebApp 与其他 item 不复用这行 WebView 工具栏。
- 从 Main Chat 打开 PNG/JPEG/WebP Artifact 与 Reference，确认 Desktop WorkPanel 创建原生图片 tab 且不创建 Agent WebClient Resource Viewer WebView；PDF、HTML、SVG、GIF 与签名不匹配资源继续使用或拒绝进入既有 Viewer。Standalone Agent WebClient 不受影响。
- 用截断或浏览器无法解码但签名仍匹配的图片回归原生预览：WorkPanel 保持可操作，不显示错误条或错误占位文案，编辑入口禁用，其他 tab 与 Main Chat 不受影响。
- 原生图片预览态显示文件信息、源尺寸、10%–800% 比例、缩放、中性背景的编辑入口与打开方式；验证适合窗口、100%、比例直接输入、触控板/Cmd/Ctrl 缩放、拖拽平移、默认/其他应用打开、窄 WorkPanel、拉宽、全屏和窗口 resize。顶部宽度不足时换行，不出现横向滚动条。
- 编辑态确认图片工具位于左侧 44px 单列图标栏，hover 可见工具名，顶部只保留完成、撤销/重做、缩放与保存；验证批注、裁剪、90°旋转、水平/垂直翻转、尺寸、曝光/对比度/饱和度、矩形/椭圆/套索/画笔选区、添加/减去/反选/清除及 50 步撤销上限。像素修改前有批注时必须确认清除；超出 8192 单边或 4000 万像素时编辑入口禁用。
- 验证擦除对象必须有选区，移除/替换背景、扩图和增强每次只产生一个 Zenmi 候选，运行中仍可缩放/平移且可取消；失败不丢草稿，结果不自动写入 Artifact。
- 每次保存都重新选择，弹窗中的取消、覆盖原 Artifact、生成新 Artifact 在同一行等宽排列；Reference 只显示取消与生成新 Artifact。Artifact 默认生成新 Artifact且可覆盖；透明结果不覆盖 JPEG；revision 冲突禁用覆盖。新 Artifact 打开新 tab，覆盖保留原 tab并清空 dirty/undo。
- macOS 验证 `.app`、Windows 验证 `.exe` 的无 shell 外部打开；有草稿时先提示只打开原文件。外部修改在无草稿时自动刷新，有草稿时只允许丢弃重载或另存新 Artifact；远端缓存先下载副本并明确不会回写。
- 在浅色、深色、默认窄 WorkPanel、拉宽与全屏状态检查分段按钮、地址截断、编辑按钮和键盘 focus；窄宽度仍保留完整编辑入口，地址安全截断且不挤出工具栏。
- 连续新增两个 Side Chat，确认都导航 `/btw/:chatId` 且 guest/instance 独立；active BTW 可调用 BTW/attach，不能 query；切换、隐藏、关闭不取消后台 Run。
- KBASE 显示可用 Project；CODER 仅在 workspace 有效时可用，并携带当前 chatId 与 lastRunId；普通 Agent 不显示 Project。

## WebView 生命周期与 Main Chat mirror

- 在 Main Chat、Website/Browser 的 Copilot Dock 与 Kanban Chat 之间切换并分别发起对话，确认同一时刻只有当前 surface 持有 live observer；Dock 继续加载内部 `/copilot/:agentKey`，Desktop 不再挂载全页 `copilot-chat`。
- macOS 与 Windows 分别固定一个 Main Chat 和一个 WorkPanel WebClient guest，记录 `webContentsId` 后反复切换 Chat、WorkPanel tab、面板显示/隐藏和 active 状态；同一 generation 只能出现一次 `listeners-attached`，普通状态变化不得出现 `listeners-detached`，guest 被替换或卸载时才允许成对解绑。
- 在 Main Chat guest 尚未 `dom-ready` 时快速触发 A→B→C 三次路由变化，确认只应用 C；过渡期 Registry 可返回 `route_not_aligned`，但不得高频重试、回滚到 A/B 或更换仍存活 guest 的 `webContentsId`。
- 连续至少 30 次从 WorkPanel 打开当前 visible Run mirror，并穿插 Main Chat 快速切换；确认没有 `primary_stream_not_ready`。打包环境正常操作不得持续写入 attach/detach/navigation debug，开发环境重复 debug 应在 500ms 窗口聚合。

## Chat information

- 从 Chat 上下文菜单打开信息弹窗，确认标题为 `Chat information`，没有重复说明或分区标题；详情字段、逐项复制、`Copy all`、`Copy JSON`、关闭按钮及键盘 Esc 均正常，浅色与深色主题下紧凑、层级清晰。
- macOS 点击 `Reveal in Finder`，Windows 点击 `Show in File Explorer`；有 Chat 目录时定位该目录，只有持久化 JSONL 时定位该文件。成功后不显示冗余状态行，失败时才显示错误；renderer 返回值和错误信息均不包含绝对路径。
- 使用包含 `/`、`\\` 或 `..` 的伪造 Chat ID 调用 reveal IPC，确认请求被拒绝且不会打开任意目录。

## WebApp 单一展示所有权

- 导入一个新的 workspace WebApp（至少包含 CSS、JS 和图片资源），确认首次导航后主工作区立即显示完整页面；`.canonical-webapp-layer` 的 computed position 为 `absolute`，layer、surface 与 webview 均为非零尺寸，资源正常加载不能只停留在不可见 WebContents。
- 运行中的 WebApp 从主工作区移到当前 WorkPanel，再跨 Chat 移动并移回主区；每次确认 DOM 中只有一个 webview 且 `guestWebContentsId` 不变，旧位置引用在同一提交消失。
- 隐藏 WorkPanel、切换 Chat和恢复时确认 guest 保持 mounted/inactive；关闭 WebApp tab 时 guest 销毁但 runtime 继续，再次打开产生新 guest。
- 在 WorkPanel 调整宽度、窗口缩放和 WorkPanel 全屏下确认 canonical WebApp 始终覆盖 active item body，不遮挡 tab strip、窗口控制或新增菜单。
- WebApp 已在独立窗口时，WorkPanel 菜单显示已在浮窗并只聚焦窗口，不创建 tab。
- WorkPanel presentation 不进入公开 CDP current，但页面 gateway/bridge、Cmd/Ctrl+W、popup 和上下文菜单仍按 WorkPanel 归属工作。
- 停止、启动失败、卸载和退出应用后确认所有 WorkPanel 引用与 canonical guest 被回收；WorkPanel 转移不改变持久 `openMode`。
- 人为构造一次 Surface Registry 拒绝，确认 Main 只记录结构化 reason、surface/renderer/guest 身份和去重汇总，不记录 URL、token、Cookie、页面正文、identity key 或原始 Chat ID。

## 本地文件安全宿主

- 多选 HTML、PDF、图片、文本、音频、视频、Office、压缩包和未知格式；支持格式内嵌预览，其他格式只显示系统定位和默认应用打开。
- 在 Main Chat RightSidebar 与 WorkPanel Artifact/Reference 中分别打开 DOCX、XLSX、PPTX、ZIP 和未知格式，确认双按钮由 WebClient 渲染在 `.content-viewer-panel` 中央，Desktop 外层没有重复操作层；操作成功保持静默，失败显示本地化错误且 guest 消息、renderer/IPC 响应均不包含绝对路径。
- 从带 canonical Chat grant 的内部 Platform Run 调用 `desktop.workpanel.openLocalFile`，确认 workspace 相对路径可打开；绝对路径、`file://`、`..`、缺失 workspace 及所有 HTTP/WS/WebApp/调试入口均失败且不弹确认。
- 重复选择同一文件激活已有 tab；关闭 tab、关闭 workspace、移除 Chat 和退出 renderer 后句柄释放。
- HTML 同目录相对图片/样式可加载；确认 HTTP(S)、WebSocket、FTP、外部导航和 popup 均被阻止，并且没有 Desktop SSO、Token、WebApp bridge、Node 或权限能力。用户手选与内部 Platform Agent 打开的本地文件必须使用相同隔离策略。

## WorkPanel HTML/图片评审批注

- 在 canonical Coder workspace 中分别打开 HTML 与图片；确认 Tab 右键出现“进入编辑模式”，HTML 内容区同时显示刷新、文件名和编辑工具栏。普通 HTTP(S) Web 的工具栏与 Tab 右键也提供网页元素批注入口；Artifact/Reference 的 HTML 与图片 Resource Viewer 外层显示同风格工具栏并在 capability 就绪后启用编辑。WebApp、用户手选的项目外文件、PDF/文本及不支持 capability 的 Resource Viewer 不提供可用编辑入口。
- 图片在默认窄宽度、宽 WorkPanel、全屏、滚动和窗口缩放下框选多个区域；进入批注模式后确认顶部出现“拖动框选/单击建框”提示，拖动中实时显示红色框，松开后右下角输入框自动聚焦，单击图片也能创建默认大小的批注框。确认画面与列表编号一致，坐标按原图像素显示，删除中间区域后连续重新编号，最多 50 条且每条要求最多 1000 字。
- 打开左栏底部智能图片工具，分别用矩形/椭圆/套索/画笔选区及批注区域执行“按选区 / 批注修改”；确认区域状态可见，修改要求随 PNG 白色蒙版交给 Zenmi，成功后清除已消费的选区与批注。擦除对象仍要求区域；移除/替换背景、扩图和增强入口继续可用。
- 本地、普通 Web 与 Artifact/Reference HTML 分别进入元素选择后悬停并点击同名兄弟元素；确认页面链接、表单与按钮不执行，批注显示唯一 Full XPath。滚动后定位框跟随；普通 Web 导航/刷新、资源版本变化或删除目标元素后显示失效且不能交给智能体。Resource Viewer iframe 继续没有 `allow-same-origin`，其内部嵌套 iframe、Shadow DOM、伪元素、文字范围和自由画笔保持不支持。
- 在已有 Composer 内容时交接图片评审；确认原内容不被覆盖、使用分隔符追加固定格式草稿，并出现带编号矩形的临时 PNG。发送前观察网络请求，确认没有附件上传；点击发送后才上传并随 query 发送。取消、插入失败或图片导出失败时原批注仍保留。
- 交接 HTML 时确认只包含 Full XPath 与修改要求，不包含完整 DOM、密码/表单值、Token、绝对路径或资源鉴权 URL。workspace 草稿要求原位修改；Artifact/Reference 草稿要求保留原资源并生成新版本；普通 Web 草稿包含安全页面 URL，并在无法定位对应源码时明确说明限制。
- 含草稿 tab、关闭其他 tab 和关闭 workspace 都出现确认；取消后草稿保留，确认后清理。退出应用后不恢复批注。分别在 macOS/Windows、浅色/深色、窄布局与 WorkPanel 全屏回归工具栏、底部抽屉/右栏、键盘焦点和不可点击数量徽标。
- 覆盖 `..`、URL 编码穿越、符号链接；Windows 额外覆盖 junction/reparse point，所有目录越界均返回 404。
- macOS 使用 Finder 定位和默认应用，Windows 使用 Explorer 定位和系统文件关联；renderer/API 响应中不出现绝对路径。

## WebApp Zenmi 图片桥

- 在图片工坊中确认能力状态显示为 `Zenmi 智能体 / Desktop`，文生图会创建新的候选图层，响应中不出现 Platform token、绝对路径或完整提示词日志。
- 导入 PNG、JPEG、WebP，建立矩形、椭圆、套索和画笔选区后分别执行图生图与局部重绘；确认原图与 PNG 蒙版经一次性上传，Zenmi 调用 `image_generate`，未选区域和原图图层保留。
- 伪造跨 WebApp uploadId、非图片签名、MIME 不匹配、超过 20 MiB 的单文件、无原图蒙版以及缺少局部重绘蒙版，确认请求在 Main 侧失败且不会启动 Run。
- 生成期间点击取消，确认只中止调用方自己的 Run；重复 requestId 冲突、附件上传失败、工具失败、超时及资源哈希不符都显示可重试错误，不自动转为 Mock。
- 在普通浏览器直接打开开发服务器，确认明确显示开发态 Mock；在 ZenMind Desktop 中不得静默回退 Mock。macOS 与 Windows 均检查 WebApp workspace、WorkPanel 和独立窗口的同源上传与结果显示。

## 设备身份与 Realtime 稳定性

- 在 Windows 启动 Desktop 后从 Debug 记录 deviceId，运行长对话并同时进行高磁盘负载操作；确认 deviceId、Realtime physical generation 与当前 Run 保持稳定，不出现 `realtime identity was invalidated`。
- 模拟启动时 MachineGuid 暂时不可读且已有有效设备身份，确认 Debug 仍显示原 deviceId，身份文件未改写，`lastMachineMismatchAt` 未更新，日志只记录保留已有身份的脱敏诊断。
- 关闭 Desktop 后模拟有效 MachineGuid 发生变化并重新启动，确认首次读取重新生成 deviceId、更新 `lastMachineMismatchAt`，旧 Realtime generation 不被恢复或自动重放。
- 在 macOS 重复上述稳定性检查，确认 IOPlatformUUID 临时不可读时同样保留已有身份，且正常启动不重复执行系统机器标识探测。
