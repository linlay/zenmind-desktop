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

## 项目侧边栏

- 展开“项目”分组，确认标题栏显示“全部展开/全部收起项目”“刷新项目”和“新增项目”；收起外层分组后只保留“新增项目”，重新展开后前两个操作恢复，各项目原有展开状态保持不变，但“查看更多”恢复为首批 5 条。
- 在外层项目分组展开时逐一悬浮“全部展开/全部收起项目”“刷新项目”和“新增项目”，确认每个按钮只显示一份自定义提示，不再同时出现浏览器原生 `title` 提示；外层收起时“新增项目”仍可正常打开创建流程。
- 比较“全部展开/全部收起项目”与相邻刷新、新增图标，确认箭头和分隔线充分占满 16px 图标画布，视觉尺寸与描边重量一致，切换状态时按钮热区和标题栏布局不跳动。

## 对话侧边栏

- 展开“对话”分组，确认标题栏显示默认助手选择器、排序和“新建对话”；收起外层分组后隐藏默认助手选择器与排序，只保留标题、展开箭头、状态数量和“新建对话”，重新展开后完整操作恢复。
- 在对话分组收起状态点击“新建对话”，确认使用当前默认助手直接创建且不自动展开分组；展开状态下悬浮排序与新建按钮时各只显示一份自定义提示，不再叠加浏览器原生 `title` 提示。完整侧边栏收成窄栏后的对话 Popover 仍显示原有完整操作。

## WorkPanel 自由新增 Tab

- 在 macOS 与 Windows 分别打开一个稳定 Chat，确认 Overview 固定首项，`32×32px` 的 `+` 紧跟最后一个 tab 并随横向溢出滚动。
- 在浅色、深色、Windows 标题栏偏移和 WorkPanel 全屏下检查菜单定位、圆角、hover/focus、Esc、方向键、Home/End 与 Enter。
- 确认菜单顺序为 Terminal、Web、Files、Side Chat、Project、WebApp；Terminal 禁用且没有快捷键或 PTY。
- Web 输入无协议域名时补 `https://`；拒绝 URL 中的用户名密码和非 HTTP(S) URL。重复 URL 激活已有 tab；Website、普通 WorkPanel Web 与其 popup 共享 Desktop 应用浏览器 Cookie partition，popup 仍留在所属 Chat。分别在登录、刷新 access token、退出登录和 Desktop 重启后验证 `HttpOnly`、`SameSite` 与重定向 Cookie 按 Chromium 原生规则生效；本地文件、WebApp、Help、内置 Browser 和服务页不得继承。
- 激活普通 Web 或 loopback tab 时确认标签栏下只增加一行浏览器工具栏：预览模式显示后退、前进、刷新、可直接输入的地址与“编辑”；进入 HTML 编辑模式后，同一行只保留“返回预览”和元素选择提示，导航/刷新/地址不再与批注操作混用，也不得再出现“完成 + 退出”两个重复出口。Workspace File、Artifact、Reference 和 Desktop 原生静态文档不显示这行浏览器工具栏。
- 从 Main Chat 分别打开 Workspace File、Artifact 与 Reference 来源的 HTML 和图片，确认 Desktop 创建原生 document tab；Markdown、文本、代码、PDF、Office、媒体、压缩包与未知二进制仍由 WebClient Document Surface 承载。Standalone 全部使用 WebClient，不显示 Desktop-only 操作。
- 用截断或浏览器无法解码但签名仍匹配的图片回归原生预览：WorkPanel 保持可操作，不显示错误条或错误占位文案，编辑入口禁用，其他 tab 与 Main Chat 不受影响。
- 原生图片预览态顶部固定为单行，不直接显示文件名；hover 或键盘 focus 信息按钮时显示完整文件名、格式/大小和源尺寸。验证 10%–800% 比例、缩放、中性背景的编辑入口与打开方式，以及适合窗口、100%、比例直接输入、触控板/Cmd/Ctrl 缩放、拖拽平移、默认/其他应用打开、窄 WorkPanel、拉宽、全屏和窗口 resize；不得出现第二行或横向滚动条。
- 编辑态确认图片工具位于左侧 44px 单列图标栏，hover 后立即在右侧显示工具名，禁用项也能显示。顶部只保留“返回预览”、撤销/重做、缩放与保存；窄 WorkPanel 中仅次要按钮收敛为图标，普通样式的“返回预览”始终显示返回箭头和四字文案，整行无换行、无横向滚动；未修改时保存为普通禁用样式，产生可保存修改后才显示蓝色强调。左栏“变换”hover/focus 后在右侧显示旋转、水平/垂直翻转和自由变换二级菜单；图片尺寸与画布尺寸各自独立，画布尺寸扩大或缩小时原图像素不拉伸。建立矩形、椭圆、套索或画笔选区后启动自由变换，确认原选区像素被提取到可拖动边框，四角可缩放且角度可输入，取消不改图、应用只增加一步历史。批注、按批注修改、对象擦除、背景移除/替换、扩图、增强必须作为连续紫色按钮平铺在“调整”之后，不得再出现机器人总入口、聚合 AI 工具对话框或“选区/批注二选一”的重复入口。验证普通选区只用于自由变换和对象擦除，按批注修改只接受已经圈选且逐条填写要求的批注；批注面板以摘要列表呈现且仅展开当前一条。拖动批注面板标题和其他设置浮层手柄，确认可移开被遮区域且不会拖出画布容器；内容过多时只在浮层内部滚动，图片显示尺寸和适合窗口比例不发生跳变。再验证裁剪、尺寸、曝光/对比度/饱和度、选区添加/减去/反选/清除及 50 步撤销上限。像素修改前有批注时必须确认清除；超出 8192 单边或 4000 万像素时编辑入口禁用。
- 在浅色和深色主题下逐项悬浮并用键盘聚焦图片编辑器按钮：画布尺寸、调整、自由变换、AI 参数、批注与保存弹窗中的主操作始终保持蓝色且文字可见；裁剪确认保持蓝色；普通按钮显示中性反馈；选中工具不丢失 active 底色；紫色 AI 工具不退化为透明背景；禁用按钮不响应 hover。默认窄 WorkPanel、拉宽和全屏下结果一致。
- 验证擦除对象必须有选区，移除/替换背景、扩图和增强每次只产生一个 Zenmi 候选，运行中仍可缩放/平移且可取消；失败不丢草稿，结果不自动写入 Artifact。
- 每次保存都重新选择，弹窗中的取消、覆盖原 Artifact、生成新 Artifact 在同一行等宽排列；Reference 只显示取消与生成新 Artifact。Artifact 默认生成新 Artifact且可覆盖；透明结果不覆盖 JPEG；revision 冲突禁用覆盖。新 Artifact 打开新 tab，覆盖保留原 tab并清空 dirty/undo。
- macOS 验证 `.app`、Windows 验证 `.exe` 的无 shell 外部打开；有草稿时先提示只打开原文件。外部修改在无草稿时自动刷新，有草稿时只允许丢弃重载或另存新 Artifact；远端缓存先下载副本并明确不会回写。
- 在浅色、深色、默认窄 WorkPanel、拉宽与全屏状态检查普通 Web 的分段按钮、地址截断、编辑按钮和键盘 focus；窄宽度仍保留完整编辑入口，地址安全截断且不挤出工具栏。Markdown/TXT/代码不得出现地址栏或第二行宿主工具栏。
- 连续新增两个 Side Chat，确认都导航 `/btw/:chatId` 且 guest/instance 独立；active BTW 可调用 BTW/attach，不能 query；切换、隐藏、关闭不取消后台 Run。
- KBASE 显示可用 Project；CODER 仅在 workspace 有效时可用，并携带当前 chatId 与 lastRunId；普通 Agent 不显示 Project。

## WorkPanel 统一文档 Surface

- 以显式 title、相对路径、macOS/POSIX 绝对路径、Windows 驱动器路径、UNC 路径、中文/空格、空 basename 和超长名称创建 File descriptor；Tab 标题必须为“显式 title > basename > file”，不 URL decode，且 stable key 和 `surfaceId` 不变。分别使用新旧 WebClient bundle 验证 Desktop 兜底。
- 对 Workspace File、Artifact 和 Reference 遍历 HTML、PNG/JPEG/WebP、动画图、SVG、Markdown、TXT、代码、PDF、Office、音视频、压缩包与未知二进制；Desktop 只原生打开 HTML/图片，其他类型使用 WebClient。伪造扩展名、错误 MIME、Office ZIP、SVG 和无后缀 UTF-8 文本必须以 Platform 最终分类为准。
- 原生 HTML 打开后直接占满 WorkPanel 内容区；header 工具条在预览态同时显示安全语义 URL 与“批注”按钮，不出现“源码/预览/分屏”、源码输入框、覆盖、保存或另存按钮。进入批注后 header 显示“返回预览”、选择提示和实时批注数量；悬停元素必须出现虚线选择框，点击后阻止页面原动作并新增批注，填写要求后可交给智能体。返回预览后页面恢复正常交互。默认窄宽度、拉宽、全屏和窗口 resize 下均不得露出底部空白背景。
- 在 Markdown/TXT/代码中验证 Monaco、查找替换、选区批注和 revision 冲突。Markdown 首开及切换文档后默认显示净化预览，只有“预览 / 源码”两种模式，不出现分屏；在预览中选取文字可添加批注，源码中可直接编辑。点击保存必须先弹出“如何保存”：Workspace 主操作为“保存（覆盖）”且不能新建产物；Artifact 主操作为创建新产物且可选覆盖原产物；Reference 只能创建新产物。外部 revision 变更后批注必须失效而不漂移。
- 发布中文/英文、UTF-8 BOM、空文件的 `.md/.markdown/.mdx/.txt` 产物，确认 Artifact manifest 与 Resource GET/HEAD 通过 `X-Document-Kind` 与 `X-Document-Revision` 返回一致的 Markdown/Text kind 和源 revision，并保持 UTF-8 MIME 与 size，WorkPanel 进入 Monaco。响应缺少 kind 时仍按 provisional 扩展名预览；UTF-16、无效 UTF-8、含 NUL 的文本扩展名文件只显示“文本编码不受支持”和下载入口。
- 确认 Workspace File、Artifact、Reference 文档只显示 Tab 与最多一行文档工具栏；文件名不在内容区重复，完整路径只在 Tab tooltip/右键菜单。Markdown/TXT/代码等 WebClient 文档的更多菜单可重新加载权威 revision，dirty 时先确认丢弃；原生 HTML 仍只提供批注入口。普通 Web 与 loopback 仍显示地址栏和刷新。
- 验证 PDF.js 页码、缩放和搜索；Office、压缩包和未知二进制不显示伪文本也不自动下载。Desktop 的系统打开/定位在 macOS 与 Windows 分别回归，Standalone 不显示这些操作。
- 在有效 Coder owner Chat 打开 `localhost`、一个 `*.localhost`、`127.0.0.1` 和 `[::1]` 站点；元素批注只交接脱敏摘要、selector/XPath、坐标、URL 和可选截图，页面不获得文件系统、Node、Token 或 Desktop API。Coder 修改 workspace 后用 HMR/刷新验证；顶层导航离开 loopback 后交接语义立即退化为普通 Web。
- 分别在原生与 WebClient 文档中制造 dirty、busy 和批注，再关闭当前 Tab、关闭其他 Tab、隐藏/恢复 WorkPanel、切换原生编辑器和进出全屏；未保存保护必须绑定当前可信 item，guest replacement 不得用旧状态阻塞新 Tab。

## WebView 生命周期与全局 Realtime Broker

- 在 Main Chat、Website/Browser 的 Copilot Dock 与 Kanban Chat 之间切换并分别发起对话，确认同一时刻只有当前 surface 持有 live observer；Dock 继续加载内部 `/copilot/:agentKey`，Desktop 不再挂载全页 `copilot-chat`。
- macOS 与 Windows 分别固定一个 Main Chat 和一个 WorkPanel WebClient guest，记录 `webContentsId` 后反复切换 Chat、WorkPanel tab、面板显示/隐藏和 active 状态；同一 generation 只能出现一次 `listeners-attached`，普通状态变化不得出现 `listeners-detached`，guest 被替换或卸载时才允许成对解绑。
- 从 Sidebar 依次打开同 Agent 与跨 Agent 的多个历史 Chat，再通过 Cmd+K、新建按钮触发 New Chat 和继续对话；确认 Desktop route、Main Chat guest URL、WebClient Router、页面内容与 Registry owner 一致切换，`webContentsId` 保持不变。暖态历史 Chat 点击后首个可绘制帧应出现骨架，人工或性能标记测得不超过 100ms；快速 `/api/chat` 也完整显示约 160ms，再用约 80ms 渐隐。目标历史 Chat 已有 active Run 时仍显示骨架；同 Chat 后台恢复、New Chat 首次创建和 `newChat → chatId` live promotion 不出现历史切换骨架；加载错误立即显示可重试错误层。地址栏已到目标但 Router 尚未切换时，bridge 仍必须完成 Router replace；正常日志为 `main-chat-router-ready → chat-route-bridge-queued → main-chat-router-applied-received → main-chat-router-applied-accepted`，并包含 `desiredToReadyMs`、`sentToAppliedMs` 与 `totalElapsedMs`，不得出现 retry、timeout、fallback、Main Chat `history.pushState` 或 reload。人为分别阻断 READY 和 APPLIED 时，从 desired route 建立累计 1000ms 后只能记录一次 `main-chat-router-timeout` 并执行一次 `loadURL`；reload 后恢复 status listener，应以相同最新 revision 完成且不得形成 reload 循环。错误 revision、Router location、WebContents/document generation 的 APPLIED 只能 rejected，不能取消 watchdog。在历史 Chat A/B 分别输入未发送草稿，多次切换后必须分别恢复；New Chat 草稿在相同或不同 Agent 返回时仍恢复，发送后才清空。Inspector 中 Primary 物理 WS 全程保持同一条；旧 Chat 有 active Run 时只出现一次 detach，无 active Run 时不产生 detach，切换后的 `/api/chat` 仍在原 LogicalSession/Primary WS 上完成。快速 A→B→C 只展示和加载 C，骨架可连续保持但不能闪回 A/B；Realtime 诊断中每次稳定 Chat 切换只允许一次目标 `chatId` 加载，不得在 surface active 恢复时紧随发出旧 `chatId` 的 `forceReload`。
- 在 macOS 与 Windows 的展开侧栏分别点击全局 Chats 和某个 Project 内的 Chat，确认焦点留在所点行；逐次按 `↑` / `↓` 时只在当前可见 Chat 列表内切换并同步选中态与页面，跳过分组标题、“查看更多”和“查看历史”，首尾不循环，长按不连续切换。按 `Enter` 后焦点进入 Main Chat WebView；键盘拖拽排序期间方向键只用于排序，不触发 Chat 导航。Cmd+K、历史弹窗和新建 Chat 仍在导航后聚焦 Main Chat。
- 准备一个不在 WebClient 当前列表缓存中的 unread Chat，分别从 Cmd+K、Sidebar 和桌宠打开。确认目标内容提交显示后只有 WebClient 经 Frame Port 发出一次单 Chat `/api/read`，Desktop 没有 `assistant.markChatRead` IPC、Sidebar fallback 或桌宠直写；Platform 的 `chat.read` 到达前 Sidebar 圆点保持，到达后全局 Chats、Project recentChats、activity 和 Agent 计数同时更新。让 read Push 在 Navigation 刷新旧快照期间到达，确认快照完成后仍为 read；再注入同 Run/旧 Run 的晚到 unread，确认被忽略，而更新 Run 的 unread 能恢复圆点。点击“全部标为已读”时确认 Desktop 只发送 Agent 级请求，UI 等待 `chat.read_all` Push，不做本地乐观清除。
- 处于 `?newChat=` 空白页时通过 WebClient 切换到另一个 Agent；确认 Desktop 只生成一次目标 Agent 的新 nonce，WebClient Router、worker 选择和空白 Timeline 同步切换，旧 Agent 内容不得继续显示。ACK 前宿主目标造成的 guest URL 回声不得再次触发 Agent switch 或持续改写 `newChat=timestamp`；快速连续切换 Agent 时只提交最后一个真实目标，日志中的 `main-chat-route-transition-replaced` 应能明确列出前后 revision/target，不得被物理 URL 相等的判断吞掉。
- 在稳定 Chat A 中首次选择此前未打开过的 Chat B，并在页面尚未完成切换时立即发送 Query、点击 WorkPanel：Registry 应先把 Main Chat 标为 inactive，待 Desktop route、guest URL 与 owner 收敛到 B 后再提交 active B；原 Query 在既有 1500ms 窗口内继续成功，WorkPanel 无需切走再返回即可自动打开。日志中的同一 revision 应能看到 `switching → ready`，不得出现 `Main Chat identity did not converge before query authorization`。
- 在 A→B→C 快速切换期间点击 B 的 WorkPanel 后继续切到 C，确认 B 的迟到导航/注册不能提交，B 的 pending intent 被取消；返回 B 时不得意外自动打开。再 reload Main Chat 或替换 guest generation，确认旧 `webContentsId` 的注册和 pending 同样失效。
- 进入带新 nonce 的 Main Chat 后立即发送第一条消息；确认 Registry 已登记同一 `agentKey + newChat` 的 active ownerless surface，query 不进入 1500ms convergence wait，而是只通过现有 Primary WS 到达 Platform 一次。随后 `chat.start/run.start` 正常把同一 generation 提升为 canonical owner；不得出现 loading 在约 1500ms 后静默结束或 `Main Chat identity did not converge before query authorization`。
- 在 Main Chat guest 尚未 `dom-ready` 时快速触发 A→B→C 三次路由变化，确认只应用 C；过渡期 Registry 可返回 `route_not_aligned`，但不得高频重试、回滚到 A/B 或更换仍存活 guest 的 `webContentsId`。
- 未使用 Side Chat 时在 Realtime Inspector 确认 Primary WS 为 1、BTW WS 为 0；首次 BTW 后变为 1+1。随后并发多个普通 Run、多个 BTW Run，并跨 Chat、WorkPanel 和 BTW tab 切换，确认物理 WS 总数始终不超过 2，RunChannel 数可以独立增加。
- 分别开启和关闭桌宠发送 Main Chat Query，并覆盖 `run.started` Push 早于、晚于 Query `run.start` 两种顺序；两种情况下都只允许一次 `/api/query`。确认桌宠不注册独立 Broker consumer、不单独请求 `/api/agents` 或 `/api/chats`、不消费 Assistant Run 逐事件流，只在 Navigation 应用 `desktop-main` Primary Push 并发布新快照后更新，不得创建 RunChannel、发送 `/api/attach` 或导致 `duplicate_id`。
- 构造 Chats unread=2、pending=1，Projects unread=4、pending=2，确认 Nav Bar 分组数字分别保持该值，桌宠同时显示蓝色 unread=6 与橙色 pending=3；将对应 Chat read、awaiting answered 后，两处必须在同一 Navigation Push 投影后一起减少。折叠/展开 Chats、从 8 条增加到 24 条不改变统计口径；重启及 Primary 断线重连后不得恢复消息缓存或本地持久化中的旧数字。
- 展开桌宠“对话概览”，确认仅显示七天内的 unread 与 awaiting 会话，视窗完整容纳三条并可用滚轮继续浏览；chat name 与正文均为 13px，item 间有清晰的 1px 分割线，unread 为蓝点、awaiting 为橙色时钟且不显示回复入口。关闭按钮默认不占位且仅在 item hover/focus 时叠加出现；关闭只在当前桌宠投影中 dismiss，回复成功只提交新 Run，两者都不得调用 `/api/read`。打开对话只导航到 Main Chat，必须等内容显示后由 WebClient 发 read，并在 Platform `chat.read` Push 到达后让桌宠与 Sidebar 同步转为 read；单纯 hover、滚动和展开列表不得标记已读。
- Main Chat surface 获得可信 active 登记后、任何 live frame 到达前，在 Realtime Inspector 确认 Root Observer 与 Overview lease 已同时存在；未打开 WorkPanel 时不得创建 Overview WebView、UI subscriber 或额外 upstream attach。ownerless 新 Chat 先显示 `pending_chat_identity`，canonical Chat 建立后在同一 context epoch 内变为 `ready`。
- 连续至少 30 次交错 Main Chat surface 登记、Frame Port open、Main attach/query 与 Overview attach，并穿插 A→B→C 快速切换；确认无需重试即可从本地 replay 连续收到事件，不产生 Overview upstream attach，关闭 clone 不产生 detach。正常首开、切换和恢复中不得出现 `Main Chat clone parent was released`、`sender is not a trusted Agent WebClient surface`、`parent_observer_closed: active Main Chat observer is unavailable`，也不得出现 `primary_stream_not_ready` 或其他基于等待时长的错误。
- Main Chat 离开、owner Chat/context 变化、surface generation 替换和 guest 销毁时，确认 Overview/Debug subscriber 同步失效，正常切换的旧 Overview 以本地 `detached` 完成；每个变为无 observer 的非终态 RunChannel 只发送一次 upstream detach，Platform Run 继续执行。返回原 Chat 后从 Inspector 显示的 lastSeq attach，query 不得重发。隐藏、显示或关闭 WorkPanel 只改变 pending/UI subscriber 数，Overview lease 始终由当前 active Main Chat 持有；隐藏的所有 guest 必须保持 mounted 且 inactive。
- 制造 detach/reattach 紧邻交接：detach 尚未写出时新 observer 应取消旧 detach；detach 已写出时新 attach 必须等待响应后从 lastSeq 开始。确认旧 generation 的迟到完成不会覆盖新 observer，且不重新出现 listeners attach/detach 高频抖动。
- 分别断开 Primary 和 BTW，确认另一 lane 的 Inspector phase 与活动 Run 不被标记为断线；账号、endpoint 或 device identity 变化时两条 lane 一起轮换。Primary 收到 BTW runId 的 `run.finished` 后能收敛对应 BTW RunChannel。
- 进入 Kanban 前先在其他页面打开 Copilot Dock；进入 `/kanban` 后确认 Dock guest 立即 inactive 并卸载，Launcher、System Bar、程序化 open/toggle 和旧 Kanban session 都不能恢复 Dock。Kanban Chat、claim、run prepare、native run 与事件同步继续正常；离开 Kanban 后其他页面原有 Dock session 可以恢复。
- 打包环境正常操作不得持续写入 attach/detach/navigation debug，开发环境重复 debug 应在 500ms 窗口聚合；Inspector 和日志不得包含 token、Cookie、用户正文或完整业务帧。
- 从设置的调试分类打开“桌面运行时观察器”，确认独立窗口可持续列出所有 Registry Surface、每个已打开 WebView 及未登记 WebView；Surface、WebContents ID、PID、owner、URL（不含查询参数/凭据）和 active/loading/crashed 状态与实际运行一致。
- 在观察器中按 RSS、5 分钟增量和 CPU 排序，确认多个 WebView 共享 renderer PID 时显示同一进程 RSS 并明确标记 shared，不把进程内存伪装成单 WebView 独占内存；macOS 与 Windows 都能持续刷新且冻结后数值停止变化。
- 选择任一存活 WebView 后切换概览、内存、事件和原始数据，确认复制快照不包含 URL query、hash、用户名或密码；“打开 DevTools”只对仍存活的 WebView 可用，guest 销毁后返回不可用而不误开其他页面。
- 切换 Targets、Events、Topology、System，确认原有 Primary/BTW、Frame Port、Run 恢复和跟踪帧诊断仍可查看；清空只删除有界 trace，不销毁 Surface、WebView 或 Broker 状态。

## 首装引导 Chat

- 准备至少 16 条 Platform Chats，并让固定 seed Chat `00000000-0000-4000-8000-000000000001` 位于第 16 条；首次安装默认显示 8 条时，确认列表严格等于 Platform 前 8 条，不出现额外的“开始使用”行或聊天引导气泡。
- 点击首装引导卡中的“打开开始使用对话”，确认即使 seed Chat 当前不可见，也导航到带该固定 `chatId` 的真实历史对话，不进入 New Chat 或“初始化助手对话”。
- 点击“查看更多”展开到 16 条，确认真实“开始使用”只在 Platform 排序位置出现一次；点击后路由、页面内容与侧栏选中态都绑定固定 `chatId`。收起 Chats 分组并重新展开恢复前 8 条后，该行和聊天引导气泡都不再显示。
- 分别在 `recent` 与 `manual` 模式重复上述检查，确认 Desktop 不对 seed Chat 置顶、重排或合成。删除 seed Chat 后重新执行首次安装引导，确认引导卡打开 Bootstrap Agent 的 New Chat，但 Chats 列表仍不伪造“开始使用”行。

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

- 在 canonical Coder workspace 中分别打开 HTML 与图片；确认静态文档内容区只显示原生单行文档工具栏，不显示浏览器地址栏或重复文件名。普通 HTTP(S)/loopback Web 的工具栏与 Tab 右键提供网页元素批注入口；WebApp、用户手选的项目外文件、PDF/文本及不支持 capability 的 Resource Viewer 不提供网页元素编辑入口。
- 图片在默认窄宽度、宽 WorkPanel、全屏、滚动和窗口缩放下框选多个区域；进入批注模式后确认顶部出现“拖动框选/单击建框”提示，拖动中实时显示红色框，松开后右下角输入框自动聚焦，单击图片也能创建默认大小的批注框。确认画面与列表编号一致，坐标按原图像素显示，删除中间区域后连续重新编号，最多 50 条且每条要求最多 1000 字。
- 打开左栏底部智能图片工具，分别用矩形/椭圆/套索/画笔选区及批注区域执行“按选区 / 批注修改”；确认区域状态可见，修改要求随 PNG 白色蒙版交给 Zenmi，成功后清除已消费的选区与批注。擦除对象仍要求区域；移除/替换背景、扩图和增强入口继续可用。
- 本地、普通 Web 与 Artifact/Reference HTML 分别从预览模式进入编辑模式，确认顶部与图片编辑态一致显示“返回预览”，批注面板只展开当前一条修改要求；悬停并点击同名兄弟元素时页面链接、表单与按钮不执行，批注显示唯一 Full XPath。滚动后定位框跟随；返回预览后页面恢复正常交互且不显示编辑提示。普通 Web 资源版本变化或删除目标元素后显示失效且不能交给智能体。Resource Viewer iframe 继续没有 `allow-same-origin`，其内部嵌套 iframe、Shadow DOM、伪元素、文字范围和自由画笔保持不支持。
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
