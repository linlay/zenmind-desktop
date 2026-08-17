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
- [ ] 再次启动复用已安装版本和用户数据，不重复初始化、不覆盖服务自有配置。
- [ ] 全新 Desktop 数据根且 seed Chat 存在时打开固定 Bootstrap Chat；同一进程只消费一次首装导航。
- [ ] 全新 Desktop 数据根但 seed Chat 已删除时打开 Bootstrap Agent 新 Chat，不恢复或覆盖用户 Chats。
- [ ] Bootstrap Agent 不可用时回退默认 Chat Agent；侧边栏、全局搜索和空路由的新 Chat 始终使用默认 Chat Agent。
- [ ] Desktop 数据根已存在时，普通启动、覆盖安装、版本更新及保留数据后的重装均不进入 Bootstrap；`OWNER.md` 缺失、创建和删除都不改变导航。
- [ ] 某一核心服务启动失败时，界面显示可诊断、可重试状态；其他事务不会被误报为成功。
- [ ] 中断安装或强制结束进程后重启，临时目录被回收，稳定版本仍可用或事务可安全重试。
- [ ] 正常退出按依赖顺序停止服务；超时服务不会无限阻塞应用退出。
- [ ] macOS 关闭窗口与退出应用语义正确；Windows 关闭、托盘恢复和退出语义正确。

## P0：登录、恢复与嵌入页面

- [ ] 未配置 SSO 时只显示可用的未配置状态，不恢复旧身份。
- [ ] 交互式登录完成 session、用户信息与 access token，各嵌入页面只在显式 capability 下刷新。
- [ ] 重启后先校验上游会话再发布已登录状态；不能只依据磁盘文件显示登录成功。
- [ ] 上游明确退出时清除身份文件、派生 Cookie 和头像缓存；无关网站 Cookie 保留。
- [ ] 临时断网时当前运行 fail closed，恢复网络后单次重试并刷新相关 surface。
- [ ] 切换账号不会短暂显示上一账号资料或使用上一账号 token。
- [ ] `agent-webclient` 的 HTTP 与 Platform Frame Port 可用，guest 不建立真实 `/ws`，且 storage、页面全局、URL 和 frame 中均看不到 access token；普通 Website/WebApp 无法调用 Agent WebClient bridge。
- [ ] 外链、下载、新窗口、导航回退和崩溃恢复均遵守所属 surface 策略。

## P0：智能助理与页面协作

- [ ] Main Assistant 可创建或继续 Chat，流式事件按 run 归属展示并正确到达终态。
- [ ] 断线不会自动重复提交已接受的 query；新请求可重新建立连接。
- [ ] 同时运行 Main Assistant、导航 Push、桌宠、两个 Desktop WS `ap` 客户端和可信 WebClient bridge 时，Main 诊断仍只有一个 Agent Platform 物理连接。
- [ ] About 连点五次开启 Debug 后，每个 webview 浮层同时显示脱敏 URL 与 `surfaceId`；设置页可打开并重复聚焦唯一的独立 Realtime Inspector，主窗口切换页面不关闭观察器。观察器能区分 Platform 物理 WS 收发和各 `surfaceId` 的 Bridge 收发，按方向、链路层、历史/当前 surface 和文本筛选不串线；冻结仅停止视图刷新而不停止后台采集，清空后不恢复旧条目。
- [ ] Debug 浮层和 Realtime Inspector 使用 canonical 短 ID，并显示 `parent › role · surfaceId`；Overview/Debug 不暴露原始 chatId、runId 或 URL，且保持只读。
- [ ] macOS 与 Windows 分别验证 Browser 多标签只登记一个 `browser` surface；打开新 URL 或执行长时间 Office 操作不会新增 surface，收藏 Website/WebApp 重启后仍得到相同 `site:` / `app:` ID。
- [ ] 全页面 Copilot 与右侧 Copilot Dock 分别显示 `copilot-chat` 和 `copilot-dock`；切换 Browser、Website、WebApp 和原生页面时，Dock 会话按 context 恢复且父级关系不会串到前一个页面。
- [ ] 已接受 Run 断线后从 `lastSeq` attach；过期 replay 游标返回明确错误，不伪造或跳过事件。
- [ ] Platform 连续发送 N 条 delta 时，active Chat guest 收到 N 条独立 message，seq、streamId、timestamp、reason 与内容不变，源码和产物不存在 Run batch timer/queue。
- [ ] Main Chat、Copilot Chat、Kanban Chat 任意切换时 active live surface 始终不超过一个；抓包确认旧 `/api/detach` 先于新 `/api/query` 或 `/api/attach`，detach 后后台 Run 不被 interrupt。
- [ ] Main Chat 仍是唯一 live surface；WorkPanel Overview/Debug 首次打开各只 HTTP replay 一次，隐藏再显示时各只再 replay 一次，全程不产生 query、attach、detach 或轮询。
- [ ] 新 Chat URL 只在关联 stream bootstrap identity 后晋升；`chat.created` push 只更新列表，不能猜测 query 归属。
- [ ] 离开 Main Chat 页面、关闭 Copilot 或退出 Kanban Chat 页面时，存在 stream 的 observer 各只 detach 一次；进入对应页面时先请求 `/api/chat` replay，只有响应仍含 `activeRun` 才从服务端 `lastSeq` attach，identity 尚未返回的 query 在 bootstrap 后补 detach。左侧 Nav 只产生页面选择并展示 push 状态，不直接发 query/attach/detach。
- [ ] 非 active、伪造或独立 Overview/Debug surface 的 query/attach 返回同 request id 的标准 Platform error frame；interrupt/submit/steer/access-level 保留真实 Platform `ApiError` 语义。
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
- [ ] 下载校验、取消、重试和缓存清理行为一致，恶意路径与不匹配摘要被拒绝。
- [ ] Website 新增、排序、禁用和删除只影响 Desktop 入口，不误删站点自身数据。
- [ ] Website 的 SSO、Copilot 与刷新能力按 manifest 显式生效，不依据 URL 猜测。
- [ ] WebApp v2 完成包校验、后端启动、gateway 访问、bridge 授权、停止和卸载。
- [ ] WebApp 进程崩溃、端口冲突或 runtime 缺失时给出可恢复状态，不暴露任意本地端口。
- [ ] 桌宠安装、窗口显示、状态订阅和 Agent 绑定正确；关闭或卸载后释放窗口与监听器。

## P1：Desktop Action 与协议

- [ ] WebSocket 握手验证 scope/device，会话心跳、临期刷新与订阅重连正常。
- [ ] HTTP bridge 仅监听 loopback，并拒绝超大、畸形、未知或越权请求。
- [ ] 只读与变更动作按定义执行；变更动作显示脱敏摘要并支持拒绝、仅本次和有限授权。
- [ ] 等待确认期间切换页面或关闭目标，原请求被拒绝而不是作用到新页面。
- [ ] CDP 页面控制只绑定当前活动 surface；导航到不受信任来源后旧 target 失效。
- [ ] WorkPanel 的 WebClient/Web item 去重、激活和保活正确；切换 Chat/路由/item 不卸载 guest，关闭 item 只回收所属 guest 与临时 partition。
- [ ] 可信 Agent WebClient 中的 WorkPanel 打开/激活/关闭按钮直接执行且不弹出 Desktop Action 确认；HTTP bridge、Desktop WS 和调试工作台的同名变更动作仍进入确认流程。
- [ ] WorkPanel workspace 相互隔离；非法 URL/路径/跨 workspace 目标被拒绝，空 Native allowlist 返回 `unsupported_native_surface`，旧 Chat WorkPanel action 仍可映射到 item id。
- [ ] 仅 Main Chat 显示 Desktop WorkPanel 右上按钮；新对话尚无稳定 `chatId` 时按钮禁用，管理页、Copilot、Website、WebApp 和 Standalone WebClient 均无该 Desktop 入口，Desktop Agent guest 自身右上快捷组为空。
- [ ] 首次点击右上按钮创建当前 Chat 的 Overview item；再次点击只隐藏，tabs、guest、active item 与宽度保持；再次打开恢复原 active item且不重建 guest。分别在两个 Chat 隐藏/恢复时 workspace 不串线，隐藏期间收到 Planning/Artifact/Web `openItem` 或 `activateItem` 会自动显示目标 workspace。
- [ ] 关闭最后一个 tab、删除 Chat 或执行 `closeWorkspace` 后 workspace 与可见状态同时清理；右上按钮的“关闭”只 hide，不改变 `closeWorkspace` 的销毁语义。
- [ ] WorkPanel 外层标签栏在浅色/深色主题下均呈现 Chrome 式 active/inactive/hover/focus 状态；无论由 Overview、产物或其他 item 打开，Overview 始终固定在第一位、按当前语言标题内容自适应宽度且不可关闭，其他 tab 保持弹性；每个 tab 显示匹配的 SVG 图标和省略标题，关闭按钮隐藏时不占宽度、仅以无底色图标在 hover/focus-within 覆盖标题末端，并提供宽于图标的横向点击区和标题渐隐区，其他 pinned/non-closable tab 不显示按钮且不渐隐；tab 右键可刷新并全屏显示/恢复工作面板，网页 tab 可复制当前实际 URL，内部 WebClient tab 不复制服务地址，且 Web item 内部不再显示重复标签栏。
- [ ] WorkPanel 固定在 main-chat 右侧；鼠标拖动分隔条跨过 WebView 时不中断，键盘左右方向键每次调整 16px、Home/End 到最小/最大；WorkPanel 与 main-chat 均至少 420px，WorkPanel 不设固定最大宽度，仅由当前可用宽度和 main-chat 保底宽度限制。
- [ ] macOS 与 Windows 分别检查 Main Chat 右上按钮偏移、窗口拖拽区、深浅主题、hover/active/disabled、`aria-pressed` 与键盘 focus ring；按钮不得被标题栏拖拽层或 WorkPanel resizer 遮挡。
- [ ] 调整 WorkPanel 宽度后重启 Desktop、切换 Chat、切换深浅主题，宽度作为全局偏好保持；非法存储值恢复为 `clamp(420px, 42vw, 680px)` 默认语义，窗口宽度允许时 main-chat 与 WorkPanel 均遵守 420px 保底宽度。
- [ ] WorkPanel 的 tab/header/WebView 获得焦点后，macOS `Cmd+W`、Windows `Ctrl+W` 可连续关闭当前 closable tab，最后一个关闭后销毁 workspace；auto-repeat、额外修饰键、keyUp 和 pinned tab 不触发关闭。
- [ ] 普通 Chat、Browser、Website 及其他非 WorkPanel WebView 中的 `Cmd+W`/`Ctrl+W` 保持原行为，Main 不依据 URL 误判 WorkPanel guest。
- [ ] macOS 隐藏面板前清除 first responder、下一 animation frame 恢复焦点；Windows 隐藏前 blur，且只在 active、`dom-ready` 和窗口聚焦时恢复。
- [ ] 调试工作台仍经过正式执行器和确认策略，不成为权限旁路。
- [ ] 断线不重放非幂等动作，重复 request identity 得到确定性处理。

## P1：导航与通用界面

- [ ] 主导航、Chats、Projects、搜索、设置和帮助入口在展开/收起状态均可达。
- [ ] surface 间切换保留必要的相对路由，但不把 token、code 等敏感查询写入恢复状态。
- [ ] webview 右键菜单、选择工具条和外部打开行为只在允许的页面生效。
- [ ] 空状态、加载、错误、重试和无权限状态可区分，键盘焦点不被弹层或隐藏窗口困住。
- [ ] 深浅主题、缩放、窗口最小尺寸和中英文关键流程无阻断问题。

## P0：打包、升级与卸载

- [ ] 安装包只包含目标品牌、平台和架构需要的资源，manifest 与资源摘要匹配。
- [ ] 分别构建 ZenMind 与 CuteJ，核对 App/EXE、安装器、About、renderer 品牌标记和托盘图标均属于当前品牌且未串包。
- [ ] macOS 核对 Finder、Dock 与 App 图标；Windows 核对 EXE、NSIS、安装后快捷方式、任务栏与托盘图标。
- [ ] 使用相同 bundle id 覆盖安装图标不同的新版本，重新启动 Finder/Dock/任务栏场景后仍显示新图标，不回退到缓存中的旧图标。
- [ ] macOS DMG 和 Windows NSIS 在干净机器可安装、首次启动、退出与再次启动。
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
