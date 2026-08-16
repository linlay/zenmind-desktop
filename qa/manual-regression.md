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
- [ ] 已接受 Run 断线后从 `lastSeq` attach；过期 replay 游标返回明确错误，不伪造或跳过事件。
- [ ] Platform 连续发送 N 条 delta 时，active Chat guest 收到 N 条独立 message，seq、streamId、timestamp、reason 与内容不变，源码和产物不存在 Run batch timer/queue。
- [ ] Main Chat、Copilot Chat、Kanban Chat 任意切换时 active live surface 始终不超过一个；抓包确认旧 `/api/detach` 先于新 `/api/query` 或 `/api/attach`，detach 后后台 Run 不被 interrupt。
- [ ] 同一 Chat 内 Chat/Overview/Debug 切换不产生 query、attach 或 detach，并保持同一 `RunExecution`；独立 `/overview`、`/debug` 只 replay，不申请 live capability。
- [ ] 新 Chat URL 只在关联 stream bootstrap identity 后晋升；`chat.created` push 只更新列表，不能猜测 query 归属。
- [ ] inactive 后返回 Chat 时先 replay，再从 `lastSeq` attach；同一次切换只 detach/attach 一次，identity 尚未返回的 query 在 bootstrap 后补 detach。
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
- [ ] WorkPanel workspace 相互隔离；非法 URL/路径/跨 workspace 目标被拒绝，空 Native allowlist 返回 `unsupported_native_surface`，旧 Chat WorkPanel action 仍可映射到 item id。
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
