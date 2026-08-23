# Desktop 手工回归清单

## 使用方式

本清单验证跨模块和用户可见工作流，不替代自动化测试，也不记录临时 UI 尺寸、完整字段表或测试数据。每次变更只执行受影响章节；发布候选需覆盖 P0，并在 macOS、Windows 分别记录结果。

结果建议记录：版本、品牌、平台、安装方式、测试账号、通过/失败/阻塞、证据和关联 issue。失败时保留主进程日志、服务日志与复现步骤，但移除 token、消息正文和用户文件。

## 环境矩阵

- [ ] macOS：全新安装、覆盖安装、正常退出后重启。
- [ ] Windows：全新安装、覆盖安装、正常退出后重启。
- [ ] 至少验证一个生产品牌和一个非默认品牌，确认目录、图标、文案与数据隔离。
- [ ] 分别覆盖有网、临时断网和服务不可用场景。
- [ ] 准备有效 SSO 账号、无权限账号、插件/WebApp 示例包及可恢复的测试数据。

## P0：启动、恢复与核心服务

- [ ] 首次启动完成资源发现、安装事务与核心服务启动，主窗口不会在未就绪时暴露失效入口。
- [ ] macOS 删除品牌运行根与 Desktop 数据根后首次启动，启动过程新建的空 `.desktop` 不触发旧数据迁移弹窗，并按全新安装导入环境。
- [ ] 再次启动复用已安装版本和用户数据，不重复初始化、不覆盖服务自有配置。
- [ ] 全新 Desktop 数据根且 seed Chat 存在时打开固定 Bootstrap Chat；同一进程只消费一次首装导航。
- [ ] 全新 Desktop 数据根但 seed Chat 已删除时打开 Bootstrap Agent 新 Chat，不恢复或覆盖用户 Chats。
- [ ] 首装侧栏“开始使用”和“帮助”黄框分别在点击对应入口后立即消失；未操作时两个黄框最多显示 60 秒；“开始使用”文字与普通对话标题保持相同缩进。
- [ ] Bootstrap Agent 不可用时回退默认 Chat Agent；侧边栏、全局搜索和空路由的新 Chat 始终使用默认 Chat Agent。
- [ ] Desktop 数据根已存在时，普通启动、覆盖安装、版本更新及保留数据后的重装均不进入 Bootstrap；`OWNER.md` 缺失、创建和删除都不改变导航。
- [ ] 某一核心服务启动失败时，界面显示可诊断、可重试状态；其他事务不会被误报为成功。
- [ ] 中断安装或强制结束进程后重启，临时目录被回收，稳定版本仍可用或事务可安全重试。
- [ ] 正常退出按依赖顺序停止服务；超时服务不会无限阻塞应用退出。
- [ ] macOS 关闭窗口与退出应用语义正确；Windows 关闭、托盘恢复和退出语义正确。
- [ ] macOS 将测试用 `docker` 软链接指向 `/Volumes/Docker/Docker.app` 或 AppTranslocation 后启动并反复刷新控制中心，Container Hub 显示安装位置不安全，界面仍可点击输入，三个默认核心服务正常 running，普通 Chat 可收到回复；日志中无 `docker info`。
- [ ] 用测试脚本模拟容器 CLI 在 `version` 探测中派生多个子进程并永久等待，确认事件循环持续响应，探测在预算内失败且父子进程全部退出；连续刷新只共享一次进行中的探测。Windows 同场景确认完整进程树被清理。
- [ ] 分别验证 Docker daemon 可用、Docker 不可达但 Podman 可用、两者均不可用三种状态；可用引擎被正确选择，两者均不可用时只禁用 Container Hub，不阻塞核心启动和普通对话。

## P0：登录、恢复与嵌入页面

- [ ] 未配置 SSO 时只显示可用的未配置状态，不恢复旧身份。
- [ ] 交互式登录完成 session、用户信息与 access token，各嵌入页面只在显式 capability 下刷新。
- [ ] 重启后先校验上游会话再发布已登录状态；不能只依据磁盘文件显示登录成功。
- [ ] 上游明确退出时清除身份文件、派生 Cookie 和头像缓存；无关网站 Cookie 保留。
- [ ] 临时断网时当前运行 fail closed，恢复网络后单次重试并刷新相关 surface。
- [ ] 切换账号不会短暂显示上一账号资料或使用上一账号 token。
- [ ] Cookie SSO 通过官网会话换取 canonical access token 后，Kanban、Market、Tunnel Hub、会话分享和 WebApp Tunnel 发布均可复用；磁盘只存在 `state/desktop/sso-access-token.txt`，启动会删除旧 `secrets/sso-site-token.json`，刷新和退出后不会重新创建第二份 token。
- [ ] `agent-webclient` 的 HTTP 与 Platform Frame Port 可用，guest 不建立真实 `/ws`，且 storage、页面全局、URL 和 frame 中均看不到 access token；普通 Website/WebApp 无法调用 Agent WebClient bridge。
- [ ] macOS 与 Windows 冷启动后直接进入 Main Chat；即使首个 WebClient 数据请求是 Frame Port `/api/agent` 且没有 `/api/agents` 预热，页面也不出现 `Failed to load agent`。Realtime Inspector 中只出现一个有效逻辑 Session 与唯一物理 WS，随后 `/api/chat` 正常返回，不出现 `capability_denied` 或对应 Platform HTTP 请求。
- [ ] 人为让可信 Main Chat 的 Frame Port open 早于 Surface Registry 登记：1500ms 内完成登记时握手继续且期间没有 token/Broker 访问；永久缺失、错误 origin/service、非可信 session 或 guest 销毁时 fail closed，且 Platform 不收到请求。
- [ ] 外链、下载、新窗口、导航回退和崩溃恢复均遵守所属 surface 策略。

## P0：智能助理与页面协作

- [ ] Main Assistant 可创建或继续 Chat，流式事件按 run 归属展示并正确到达终态。
- [ ] 分别点击 Chats 标题栏和 Projects 内项目标题栏的“新建对话”，切换到 New Chat 后输入框立即获得焦点并可直接输入；Cmd+K 的 New Chat 保持相同行为。macOS 与 Windows 均验证。
- [ ] 分别从 Chats 和 Projects 点击普通或“等待回答”Chat，切换完成后 Main Chat 立即获得键盘焦点；“等待回答”Chat 无需额外点击页面即可直接用数字键 `1`/`2`/`3` 选择问题选项。macOS 与 Windows 均验证。
- [ ] 断线不会自动重复提交已接受的 query；新请求可重新建立连接。
- [ ] 执行 `sleep 120`：103 秒附近不出现第二次 logical open 或 `WS_DISCONNECTED`，逻辑 Session ID 与请求关联不变；`run.finished` 直接到达原 Chat，无需切换 Chat 刷新。连续 30 分钟重复多次静默仍无误断线、重复 Run 或丢终态。
- [ ] Run 中途强制断开唯一物理 WS：UI 显示 reconnecting，逻辑 Session 不关闭；Platform Run 不重复启动，重连后只执行一次 `attach(lastSeq)` 并从原 stream 连续显示。重连期间新的一次性请求返回可重试 `PLATFORM_CONNECTION_UNAVAILABLE`。
- [ ] 覆盖 Platform 长时间不可用、协议版本不匹配、非法握手存活参数、身份轮换、应用休眠唤醒、Surface 重建和 stale generation；不匹配明确返回 `PLATFORM_WS_PROTOCOL_MISMATCH`/`DESKTOP_BRIDGE_INCOMPATIBLE`，不回退旧 Bridge、Guest `/ws` 或 HTTP Run transport。
- [ ] 同时运行 Main Assistant、导航 Push、桌宠、两个 Desktop WS `ap` 客户端和可信 WebClient bridge 时，Main 诊断仍只有一个 Agent Platform 物理连接。
- [ ] About 连点五次开启 Debug 后，每个 webview 浮层同时显示脱敏 URL 与 Surface 身份；鼠标移入浮层显示“复制全部”，复制内容包含浮层中的 Surface 标签与脱敏 URL，不额外暴露 ownerChatId 等内部字段，成功/失败反馈清晰；设置页可打开并重复聚焦唯一的独立 Realtime Inspector，主窗口切换页面不关闭观察器。观察器能区分 Platform 物理 WS 收发和各 `surfaceId` 的 Bridge 收发，按方向、链路层、历史/当前 surface 和文本筛选不串线；冻结仅停止视图刷新而不停止后台采集，清空后不恢复旧条目。
- [ ] Debug 浮层和 Realtime Inspector 使用 canonical 短 ID；根 Surface 的 role 与 ID 相同时只显示一次，子 Surface 显示 `parent › role · surfaceId`。Overview/Debug 不暴露原始 chatId、runId 或 URL，且保持只读。
- [ ] macOS 与 Windows 分别验证 Browser 多标签只登记一个 `browser` surface；打开新 URL 或执行长时间 Office 操作不会新增 surface，收藏 Website/WebApp 重启后仍得到相同 `site:` / `app:` ID。
- [ ] 全页面 Copilot 与右侧 Copilot Dock 分别显示 `copilot-chat` 和 `copilot-dock`；切换 Browser、Website、WebApp 和原生页面时，Dock 会话按 context 恢复且父级关系不会串到前一个页面。
- [ ] Website、WebApp、Browser、Service 和原生页面共用右侧 Copilot Dock 宽度；鼠标拖拽及方向键/Home/End 均限制在 320–640px，并为左侧正文保留至少 800px。切换页面、关闭重开和重启应用后恢复全局首选宽度；可用内容不足 1120px 时切换为非全屏的右侧覆盖模式，宽度仍按全局首选值且最大 640px，同时停止拖拽；空间恢复后还原侧边布局。macOS/Windows 及亮色/暗色主题均无拖拽中断或残留遮罩。
- [ ] Website、WebApp 与 Browser 在 Copilot 关闭时只在页面最右上角显示宿主打开按钮，位置与 Main Chat 的 WorkPanel 按钮一致；打开后入口隐藏，Copilot WebView 右上角显示 Desktop 原生关闭按钮，且不与 `/copilot` 顶栏操作重叠。macOS/Windows、侧边与右侧覆盖模式、亮色/暗色主题下均可点击并有清晰焦点态。
- [ ] 已接受 Run 断线后从 `lastSeq` attach；过期 replay 游标返回明确错误，不伪造或跳过事件。
- [ ] Platform 连续发送 N 条 delta 时，active Chat guest 收到 N 条独立 message，seq、streamId、timestamp、reason 与内容不变，源码和产物不存在 Run batch timer/queue。
- [ ] Main Chat、Copilot Chat、Kanban Chat 任意切换时 active live surface 始终不超过一个；抓包确认旧 `/api/detach` 先于新 `/api/query` 或 `/api/attach`，detach 后后台 Run 不被 interrupt。
- [ ] 在 Main Chat 连续切换多个普通、运行中和空消息 Chat；每次只请求目标 `chatId`，owner Chat/registry 元数据更新不产生伪造的 inactive→active lifecycle，也不强制 replay 上一个 Chat。
- [ ] macOS 与 Windows 分别从 `/agent/A?newChat=...` 和 `/agent/A?chatId=...` 在 guest 内切换到 Agent B：外层 route replace 为 `/agent/B?newChat=<新13位nonce>`、复用同一个 WebView、不重复 active lifecycle，旧 owner 清除且旧 observer 只 detach 一次；首条消息属于 B，并最终由匹配 query stream 收敛为 `/agent/B?chatId=...`。选择 B 的明确历史 Chat 时保留其 `chatId` 且不生成 `newChat`。
- [ ] Main Chat 快速执行 A→B→C 时只有 C 的 ownerless `newChat` source 能登记和发送，A/B 的迟到导航不能抢回 URL。切换后立即发送时，在 payload owner、guest 实际 Agent 路由、Registry URL 和 Desktop page route 全部一致前返回本地 `protocol_error`，抓包确认 Agent Platform 未产生错误 Agent 的后台 Chat；跨域、错误路径、管理页、非 active surface 不触发切换。
- [ ] Agent key 含非 ASCII、空格和 `%` 时，切换后的 `/agent/:agentKey` 保持单层编码，刷新、canonical `chatId` 收敛及历史 Chat 跳转均不出现 `%25E...` 二次编码。
- [ ] Main Chat 仍是唯一上游 live surface；WorkPanel Overview/Debug 首次打开先做一次 HTTP replay，再以 `lastSeq` 订阅 Main Chat 当前 visible Run 的 Desktop 本地镜像。主聊天后续 Planning、Plan Task、File Change 与内容事件无需切换标签即同步；抓包确认 Overview/Debug 不新增 Platform query/attach/detach 或轮询，隐藏时只释放本地 consumer，再显示时 replay/虚拟订阅恢复且不丢不重。构造超过 2000 条或 4 MiB 的本地 replay 后用旧游标打开 Overview，首次 `seq_expired` 自动刷新 `/api/chat` 并重新订阅；持续过期时停止自动刷新、显示本地化错误和手动重试，Realtime Inspector 中错误包含 `requestedLastSeq`、`firstAvailableSeq`、`latestSeq`、事件数与字节数，且全程不出现第二条上游 observer。
- [ ] 普通新 Chat 收到关联 query stream 的 `chat.start` 后立即把 `newChat` 原位替换为 canonical `chatId`，并在 `run.start` 前完成 Main Chat surface owner 登记；`chat.created` push 只更新列表，不能猜测 query 归属。
- [ ] 从已有 Main Chat 点击“新对话重问”：准备期间不清空来源、不发送 query；成功后只创建一个运行中的新 Chat，地址最终只含 canonical `chatId`，侧栏和历史栈不残留无 `chatId` 的空白 New Chat，返回可回到来源 Chat。快速双击、宿主拒绝、登记超时和网络失败均不产生后台 Chat；macOS 与 Windows 分别验证。
- [ ] 新 Chat 先上传 DOCX 等附件、附件暂存预建 canonical Chat 后，query stream 即使不重复 `chat.start`，也只在服务端 `request.query` 完整回显 outbound `requestId + chatId + owner` 后提升路由并登记 owner；首次回复调用 `desktop.workpanel.openWeb` 能当场打开编辑器，无需切出再切回 Chat。
- [ ] 新 Chat 缺失合法 `chat.start`/匹配 `request.query`、Chat/Run 身份冲突、nonce/generation 过期、或 canonical surface 登记完成前用户切走时，WorkPanel 动作 fail closed 且不抢回导航；同一 canonical Run 后续 attach 可恢复 grant，旧同步失败不能覆盖新 generation。已有 canonical `ownerChatId` 的 Chat 即使 guest `currentUrl` 仍短暂保留旧 `newChat`，也可直接发起续聊并以匹配的 `run.start` 继续。
- [ ] Chat A 的 Run 已建立 WorkPanel grant 后切到 Chat B：旧 observer 正常 detach，Chat A 的 `desktop.workpanel.openWeb` 仍在其隐藏 workspace 中先创建 Overview 再加载 WebView，Chat B 不跳转也不显示 Chat A 内容；切回 Chat A 后编辑器已加载。Run 完成、失败或取消后拒绝新的 Run 动作，但已创建 workspace 仍可查看。macOS 与 Windows 均验证。
- [ ] 离开 Main Chat 页面、关闭 Copilot 或退出 Kanban Chat 页面时，存在 stream 的 observer 各只 detach 一次；进入对应页面时先请求 `/api/chat` replay，只有响应仍含 `activeRun` 才从服务端 `lastSeq` attach，identity 尚未返回的 query 在 bootstrap 后补 detach。左侧 Nav 只产生页面选择并展示 push 状态，不直接发 query/attach/detach。
- [ ] Overview/Debug 的 query 始终拒绝；非 active、伪造、跨 owner Chat、父级不是 Main Chat 或目标不是当前 visible Run 的 attach 返回同 request id 的标准 Platform error frame。合法只读虚拟 attach 只读取本地 replay/live fanout，interrupt/submit/steer/access-level 保留真实 Platform `ApiError` 语义。
- [ ] 附件上传失败时请求不会伪装成功，取消后临时资源被清理。
- [ ] Copilot 在 Website/WebApp 间切换时更新页面上下文，旧 surface 失去控制权。
- [ ] 页面选择、截图和文件等不同内容来源具有清晰的用户确认与结果反馈。
- [ ] Agent Platform 未就绪、token 临期或事件时间非法时显示可恢复错误，不伪造运行状态。

## P0：看板与云同步

- [ ] 云端 issue 作为只读缓存展示，Desktop 不出现通用编辑、迁移状态或标签写入入口。
- [ ] claim、run prepare、chat bind/unbind 和 run event 使用 Server 返回的身份，重试不产生重复 run。
- [ ] 多 Chat 切换、断线恢复和快照重建后，issue/run/chat 关系不串线。
- [ ] Desktop 离线时明确显示旧缓存；恢复后由 Server 快照对账，不以本地内容覆盖云端。
- [ ] Review 或其他未授权公共 issue 操作不可从 Desktop 动作或 UI 绕过限制。

## P0：企业聊天

- [ ] 使用 canonical SSO token 在主进程换取 IM session，renderer 与日志看不到 token/ticket。
- [ ] 私聊、群聊、历史同步和断线续传保持消息顺序与去重。
- [ ] 图片、文件、截图上传下载有大小/类型限制、进度和失败反馈。
- [ ] 远程桌面动作仍经过 Desktop 动作校验与用户确认。
- [ ] 切换账号、退出登录或撤销会话后立即停止旧连接并清理内存凭据。
- [ ] 服务端中继或对象存储失败时安全降级，不向对端泄露原始局域网地址或本地路径。

## P1：插件、市场与扩展资源

- [ ] 插件包校验、安装、启用、停止、升级和卸载保持事务完整；失败不破坏上一稳定版本。
- [ ] 插件脚本只获得 manifest 声明和用户批准的能力，不能越权读写其他资源目录。
- [ ] 市场 catalog 与本地安装状态分离；刷新失败时不丢失已安装资源。
- [ ] Skill 严格按 SemVer 比较版本；云端版本较新时默认市场和“我安装的”均显示可更新，更新成功后旧版本不再标记可更新。
- [ ] Skill 页“查找技能”和“创建技能”均打开默认 Chat Agent 的空白新对话并预填可编辑草稿，不弹出重复编辑框、不自动发送或创建 Run；意图参数消费后从 URL 消失，刷新不重复覆盖用户输入。查找流程在安装前确认精确市场条目，创建流程在写入前展示预览并通过 Skill 校验。
- [ ] 下载校验、取消、重试和缓存清理行为一致，恶意路径与不匹配摘要被拒绝。
- [ ] Website 新增、排序、禁用和删除只影响 Desktop 入口，不误删站点自身数据。
- [ ] Website 的 SSO、Copilot 与刷新能力按 manifest 显式生效，不依据 URL 猜测。
- [ ] macOS 与 Windows 生产包均包含 `Resources/scripts/webapp-tooling.mjs`，从该路径可完成 manifest 初始化、项目校验、ZIP 构建与归档复验，且 `app.asar` 内不再携带重复副本。
- [ ] `agent-platform` 启动环境的 `DESKTOP_WEBAPP_TOOLING_PATH` 精确指向当前生产包 Tooling；旧 Skill 通过过渡 `DESKTOP_ROOT` 也能直接命中，不扫描用户目录或源码仓库。
- [ ] WebApp v2 完成包校验、后端启动、gateway 访问、bridge 授权、停止和卸载。
- [ ] WebApp 进程崩溃、端口冲突或 runtime 缺失时给出可恢复状态，不暴露任意本地端口。
- [ ] 桌宠安装、窗口显示、状态订阅和 Agent 绑定正确；关闭或卸载后释放窗口与监听器。

## P1：Desktop Action 与协议

- [ ] WebSocket 握手验证 scope/device，会话心跳、临期刷新与订阅重连正常。
- [ ] HTTP bridge 仅监听 loopback，并拒绝超大、畸形、未知或越权请求。
- [ ] 只读与变更动作按定义执行；变更动作显示脱敏摘要并支持拒绝、仅本次和有限授权。
- [ ] `desktop.runtime.info` 与 Desktop WS `runtime.info` 返回相同的启动缓存产品名、版本和构建时间；`desktop.runtime.diagnostics` 默认先显示仅含数据类别的确认，取消时不读取，允许后只返回设备、路径、运行时、canonical SSO token 末四位摘要和服务状态，响应与日志均不出现 token 原文或 token 文件路径；WebApp page/backend 调用被拒绝。
- [ ] 等待确认期间切换页面或关闭目标，原请求被拒绝而不是作用到新页面。
- [ ] CDP 页面控制只绑定当前活动 surface；导航到不受信任来源后旧 target 失效。
- [ ] WorkPanel 的 WebClient/Web item 按 `module/context` 去重、按 `route` 导航，激活和保活正确；切换 Chat/路由/item 不卸载 guest，关闭 item 只回收所属 guest 与临时 partition。
- [ ] 可信 Agent WebClient 中的 WorkPanel 打开/激活/关闭按钮直接执行且不弹出 Desktop Action 确认；HTTP bridge、Desktop WS 和调试工作台的同名变更动作仍进入确认流程。
- [ ] Platform 反向 `desktop.workpanel.openWeb/refreshWeb` 仅在匹配的 Run grant 已就绪时不弹确认；grant 缺失、身份冲突或过期仍 fail closed，Platform 的其他 WorkPanel 动作以及 HTTP bridge、Desktop WS、企业聊天和普通 Action handler 不获得该豁免。
- [ ] WorkPanel workspace 相互隔离；非法 URL、Project/File Diff 的绝对或 `..` 路径、跨 workspace 目标被拒绝，File descriptor 的相对、POSIX、Windows 盘符与 UNC 请求路径被接受，空 Native allowlist 返回 `unsupported_native_surface`；动作列表与执行器只接受当前 `desktop.workpanel.*` 契约。
- [ ] `desktop.workpanel.openWeb` 按规范化 HTTP(S) URL 打开或激活网页 item；网页内普通链接在当前 WorkPanel tab 导航，`target="_blank"`、`window.open()` 和内容右键“在新工作面板标签打开”创建同一 owner Chat 的新外层 Web item，不切换到 Desktop Browser 根路由、不创建隐藏的内部标签或额外窗口；加载期间外层 tab 显示 spinner、内容顶部显示细进度条，完成/失败后清除；`desktop.workpanel.refreshWeb` 仅刷新并激活同一 owner Chat 中 URL 匹配的现有 WebView，非法 URL、缺失 workspace、跨 Chat 或不存在的网页均被拒绝。
- [ ] 仅 Main Chat 显示 Desktop WorkPanel 右上按钮；新对话尚无稳定 `chatId` 时按钮禁用，管理页、Copilot、Website、WebApp 和 Standalone WebClient 均无该 Desktop 入口，Desktop Agent guest 自身右上快捷组为空。
- [ ] 首次点击右上按钮创建当前 Chat 的 Overview item；再次点击只隐藏，tabs、guest、active item 与宽度保持；再次打开恢复原 active item且不重建 guest。分别在两个 Chat 隐藏/恢复时 workspace 不串线，隐藏期间收到 Planning/Artifact/Web `openTab` 或 `activateTab` 会自动显示目标 workspace。
- [ ] WorkPanel Overview、Debug、BTW 分别使用 `/overview/:chatId`、`/debug/:chatId`、`/btw/:chatId`；Source 与 Planning 使用各自身份作为 path 参数；Workspace File、Project 与 Diff 使用 canonical route，并保持路径仅编码一次。WebClient 缺少 `currentWorker.workspaceDir` 时，点击 `cli-excelx/README.md` 的绝对链接仍立即创建 `/file-viewer/:agentKey` WorkPanel 并通过 `/api/file` 加载；POSIX、Windows 盘符与 UNC 文件路径即使含有 `Project/project` 也必须登记为 File management surface，真正的 Project 页面仍登记为 Project surface。
- [ ] 从可信 WebClient 的 Skill 胶囊打开 `/skill-viewer/:key` WorkPanel；descriptor context 只包含非空 `key`，重复打开同一 Skill 只激活已有标签，空 key 或夹带 Agent、Chat、路径及凭据字段的请求被拒绝。
- [ ] 从 Desktop 独立 Overview 点击 Planning 后，同一 Chat 的 WorkPanel 立即打开对应 `/planning-viewer/:planningId?chatId=...` 标签；重复点击只激活已有标签，不重复创建。Team Chat 在无唯一 `agentKey` 时仍可打开，不同 Chat 不串线，Standalone Planning 行为不变。
- [ ] 在 Standalone 和 Desktop WorkPanel Overview 中点击文件修改行时，首次点击均在当前 Overview 内展开 original/current 差异并显示加载或错误状态，再次点击收起，加载成功后重复展开复用缓存；Desktop 不创建新的 File Diff tab，独立 File Diff Surface 仍可从原有入口打开。
- [ ] Artifact 与 Reference 保留各自 module/context 和稳定去重身份，但都打开 `/resource-viewer/:agentKey?chatId=...&file=...`；缺少合法 preview URL 时不创建 item，Desktop 不生成 `/artifact-view/:agentKey`、`/reference-view/:agentKey` 或旧的 Overview/Debug/BTW Agent 路径。
- [ ] File、Artifact 与 Reference 均先打开面板再请求 Platform：Standalone 使用 Sidebar，Desktop 使用 WorkPanel；File 调用 `/api/file`，Artifact/Reference 调用 `/api/resource`。请求 `/etc/hosts`、跨 ChatScope、symlink 或 workspace 外资源时面板保持打开并显示 Platform 403，不静默写入 debugLines，也不由 Desktop/WebClient 依据本地 workspace 元数据提前拒绝。
- [ ] 删除 Chat、执行 `closeWorkpanel`，或在已无 closable tab 时通过关闭快捷键回收 WorkPanel 后，workspace 与可见状态同时清理；固定 Overview 不可单独关闭，右上按钮的“关闭”只 hide，不改变面板销毁语义。
- [ ] WorkPanel 外层标签栏在浅色/深色主题下均呈现 Chrome 式 active/inactive/hover/focus 状态；无论由 Overview、产物或其他 item 打开，Overview 始终固定在第一位、按当前语言标题内容自适应宽度且不可关闭；其他 tab 同样按图标与标题内容决定宽度，仅受 88px 最小宽度和 240px 最大宽度约束，不主动瓜分空白空间；每个 tab 显示匹配的 SVG 图标和省略标题，关闭按钮隐藏时不占宽度、仅以无底色图标在 hover/focus-within 覆盖标题末端，并提供宽于图标的横向点击区和标题渐隐区，其他 pinned/non-closable tab 不显示按钮且不渐隐；Artifact/Reference 的 HTML、PDF、图片、文本、音频和视频保持正常预览且不显示宿主按钮，Office 与未知格式才在内容区正中央以上下排列显示“在访达/文件资源管理器中显示”和“用默认应用打开”两个 Settings 风格按钮；tab 右键按类型显示菜单：网页可刷新并显示“复制当前地址”，Artifact 可“下载产物文件”，Reference 可“下载资源文件”，两种 Resource Viewer 都可在文件管理器中显示、复制文件名、刷新预览和“用默认应用打开”，其他内部 WebClient 不复制服务地址；分别在 macOS/Windows 用现有 `chats/<chatId>/artifacts/...` 下的 `.html`、`.pdf`、`.docx`、`.xlsx` 验证预览与按钮分流，Finder/文件资源管理器定位原文件且默认应用直接启动，不出现保存/下载对话框、不产生临时副本，且普通“下载”仍保持原行为；绝对路径、`..`、错误 Chat、错误目录前缀和 symlink 越界均拒绝；所有 tab 均显示“全屏显示”，进入后主窗口原生全屏且整个 Desktop 只保留 WorkPanel tab 与内容，导航、主内容、面板开关、Copilot 和普通浮层均不可见且不可聚焦，guest 不重建；通过菜单或 Esc 退出时仅撤销 WorkPanel 自己触发的原生全屏，进入前已原生全屏则保持；通过系统方式退出原生全屏、切换 Chat、隐藏或回收 workspace 时同步恢复 Desktop 布局；closable tab 可关闭当前/其他标签且必须保留 Overview、pinned 与 non-closable item；Web item 内部不再显示重复标签栏。
- [ ] WorkPanel 固定在 main-chat 右侧；鼠标拖动分隔条跨过 WebView 时不中断，键盘左右方向键每次调整 16px、Home/End 到最小/最大；WorkPanel 与 main-chat 均至少 420px，WorkPanel 不设固定最大宽度，仅由当前可用宽度和 main-chat 保底宽度限制。
- [ ] macOS 与 Windows 分别检查 Main Chat 右上按钮偏移、窗口拖拽区、深浅主题、hover/active/disabled、`aria-pressed` 与键盘 focus ring；展开 WorkPanel 后按钮视觉上保持在 WorkPanel 右上角和相同屏幕坐标，DOM 宿主不重建，鼠标不移动即可再次点击收起；按钮不得被标题栏拖拽层、标签或 WorkPanel resizer 遮挡。快速连续开关面板不得把 Main Chat 或 WorkPanel 的整个外层 `<webview>` 选成灰蓝色块，也不得触发窗口拖拽或最小化，同时 guest 内消息、Markdown 与代码文字仍可正常选择。
- [ ] 调整 WorkPanel 宽度后重启 Desktop、切换 Chat、切换深浅主题，宽度作为全局偏好保持；非法存储值恢复为 `clamp(420px, 42vw, 680px)` 默认语义，窗口宽度允许时 main-chat 与 WorkPanel 均遵守 420px 保底宽度。
- [ ] 点击或键盘聚焦 WorkPanel 的 tab/header/WebView 后，即使后续焦点进入其 `<webview>` 或关闭 tab 导致 DOM 焦点变化，macOS `Cmd+W`、Windows `Ctrl+W` 仍每次先关闭 active closable tab；若当前为固定 Overview 等不可关闭项，则关闭最后一个 closable tab；没有 closable tab 时下一次关闭整个 WorkPanel（包含 Overview），再下一次恢复为 Desktop 窗口默认关闭/隐藏。点击 WorkPanel 外部会立即恢复窗口默认行为；auto-repeat、额外修饰键和 keyUp 不触发该序列。
- [ ] 普通 Chat、Browser、Website 及其他非 WorkPanel WebView 中的 `Cmd+W`/`Ctrl+W` 保持原行为；WorkPanel 被回收、隐藏或用户点击面板外部后 Main 立即释放拦截，且不依据 URL 误判 WorkPanel guest。
- [ ] macOS `Cmd+Shift+D`、Windows `Ctrl+Shift+D` 始终为当前实际聚焦的 WebView 打开独立 DevTools；在 main-chat 与包含 Overview、Artifact、Web 等多个 guest 的 WorkPanel 间逐一点击并触发时目标正确，隐藏 WorkPanel 后不再命中陈旧的 `/overview`；没有 WebView 焦点时才使用 Copilot 或当前页面快照兜底。
- [ ] macOS 隐藏面板前清除 first responder、下一 animation frame 恢复焦点；Windows 隐藏前 blur，且只在 active、`dom-ready` 和窗口聚焦时恢复。
- [ ] 调试工作台仍经过正式执行器和确认策略，不成为权限旁路。
- [ ] 在普通主 Run 中用 `run_query` 创建独立新对话；父 Run 结束后，子 Run 连续执行三次 `desktop.website.add`、一次 `desktop.pet.show` 和一次 `desktop.theme.set({themeMode:"dark"})` 均到达当前 Desktop Main，不出现 `run_target_missing`，响应 request ID 不串线。
- [ ] 独立 Run 没有 WorkPanel grant 时，`desktop.workpanel.*` 已到达 Desktop 但返回 `source_chat_not_ready`；已有合法 grant 的直接 Run 行为不变，不能打开其他 Chat 的 workspace。
- [ ] Desktop Main 断开时新动作返回 `desktop_main_disconnected`；同一 device 重连后后续动作恢复，断线期间已发送的 Website/Theme 等变更动作不自动重放。Standalone 仍返回原有 run target/unsupported 错误。
- [ ] 断线不重放非幂等动作，重复 request identity 得到确定性处理。

## P1：导航与通用界面

- [ ] 主导航、Chats、Projects、搜索、设置和帮助入口在展开/收起状态均可达。
- [ ] Chats 列表和各智能体最近对话的更多按钮、右键及键盘上下文菜单均在末尾显示“对话信息”；弹窗先展示摘要，再加载完整字段，支持逐项复制、复制全部、复制完整 JSON、失败重试和关闭后忽略旧响应。macOS/Windows、亮色/暗色和窄窗口下保持 Desktop 弹窗样式，首装引导占位项不显示该动作。
- [ ] macOS 与 Windows 切换到其他应用使主窗口失焦后，在顶部拖拽条、侧栏空白区或内置浏览器顶部空白区直接按住拖动；第一次按下即可同时聚焦并移动窗口。macOS Agent WebClient 顶部拖拽命中区保持 8px 高并透明覆盖在主内容最上沿，不参与内容布局、不绘制独立背景或白边，只显示一根在当前主内容宽度内水平居中的轻量短线；WorkPanel 打开时拖拽区只覆盖左侧主内容宽度，短线随主内容重新居中，右侧 Panel 不属于拖拽区且原有标签栏布局、顶部 padding 和视觉样式保持不变。不得通过 `padding`、`margin` 或位置偏移把主聊天、WorkPanel、网页内容整体下移；点击 guest WebView 内容后，下一次从顶部拖拽区按下也必须立即移动窗口，不得只完成焦点切换；区域内控件仍可正常点击。
- [ ] surface 间切换保留必要的相对路由，但不把 token、code 等敏感查询写入恢复状态。
- [ ] webview 右键菜单、选择工具条和外部打开行为只在允许的页面生效。
- [ ] Windows 在主内容区的 Agent WebClient 打开重命名、删除等带遮罩弹窗时，右上角最小化、最大化和关闭按钮并入遮罩；关闭弹窗后恢复，多个弹窗/全局搜索状态交叠时不提前恢复。macOS 窗口按钮行为保持不变。
- [ ] 空状态、加载、错误、重试和无权限状态可区分，键盘焦点不被弹层或隐藏窗口困住。
- [ ] 深浅主题、缩放、窗口最小尺寸和中英文关键流程无阻断问题。

## P0：打包、升级与卸载

- [ ] 安装包只包含目标品牌、平台和架构需要的资源，manifest 与资源摘要匹配。
- [ ] 分别构建 ZenMind 与 CuteJ，核对 App/EXE、安装器、About、renderer 品牌标记和托盘图标均属于当前品牌且未串包。
- [ ] macOS 核对 Finder、Dock 与 App 图标；Windows 核对 EXE、NSIS、安装后快捷方式、任务栏与托盘图标。
- [ ] 使用相同 bundle id 覆盖安装图标不同的新版本，重新启动 Finder/Dock/任务栏场景后仍显示新图标，不回退到缓存中的旧图标。
- [ ] macOS DMG 和 Windows NSIS 在干净机器可安装、首次启动、退出与再次启动。
- [ ] Windows NSIS 数据目录默认显示为 `C:\Users\<用户>\.cutej`；手动删除或修改末尾 `.cutej` 时，输入框上方显示红色格式错误并禁用继续安装，恢复后提示消失且可继续；浏览选择普通目录和盘符根目录时分别自动补成 `<目录>\.cutej` 与 `D:\.cutej`。
- [ ] 覆盖安装应用新版本后，品牌数据和服务自有数据保留，内置程序版本按事务升级。
- [ ] 旧版升级失败时可继续使用上一稳定版本，临时/下载目录可回收。
- [ ] 普通卸载删除应用程序和 Desktop 所有的程序数据；用户内容与服务自有数据按产品策略处理。
- [ ] 明确选择清除用户数据时显示影响范围，并在 macOS、Windows 分别验证结果。
- [ ] 卸载后重装不会读取已声明删除的凭据、旧进程或孤立端口。

## 结束条件

> Frame Port Desktop、匹配的 Agent WebClient bundle、vendored contract hash 与内置资源必须作为一个不可混用的发布单元验证。任何旧 Realtime Bridge、旧 Program bundle 或重新暴露 guest `/ws` 的 manifest 都不得标记为发布候选。

- [ ] 所有受影响 P0 通过；P1 失败已有明确风险判断和跟踪项。
- [ ] 自动化测试、构建产物与手工测试使用同一版本和品牌配置。
- [ ] 发现架构边界或不变量变化时同步更新 `docs/`；实现细节差异只更新源码、契约或测试。
