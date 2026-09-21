# Part 文件功能拆分总结报告

日期：2026-09-21。基线：`1cb7b804488002fef528bcf6febaced989d5732e`。三个独立任务在同一目录完成；没有创建 worktree。本文记录重构完成并准备提交时的代码快照；报告与重构代码一并纳入提交。

## 总体结论

原 **61 个 part 文件、19 组公共入口全部完成职责重组**。当前对应范围为 **208 个职责文件 + 19 个保留入口 = 227 个文件**。原范围为 61 个切片 + 19 个入口 = 80 个文件，净增加 147 个文件；Main 架构扫描从 438 增至 585 个源文件，领域模块仍为 20 个。

计数已统一：A 报告的 55 包含 5 个公共入口；B 的 72 和 C 的 86 不包含各自的 6 和 8 个入口。因此不能直接把三个报告数字相加当作全部最终文件数。下方附录逐文件从磁盘核对行数，三份组报告的行数均与当前代码一致。

| 组别 | 原 part | 职责文件 | 保留入口 | 最终范围文件 | 最大文件行数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| A：动作、协议、助理、WebApp | 17 | 50 | 5 | 55 | 722 |
| B：服务、启动、环境、Manifest | 21 | 72 | 6 | 78 | 457 |
| C：身份、看板、桌宠、市场、窗口 | 23 | 86 | 8 | 94 | 820 |
| 合计 | 61 | 208 | 19 | 227 | 820 |

## 19 组原文件现在如何划分

以下均为 src/main 下的相对路径；完整逐旧文件到多个目标的映射见各组报告。

| 原文件组 | 现在的职责划分 |
| --- | --- |
| modules/desktop-actions/runtime | 请求契约和值解析、来源门禁、动作分派、确认策略/展示/对话框、HTTP 服务、页面权限、WebApp 原生/工程工具/结果投影、看板/桌宠/文件动作 |
| modules/desktop-protocol/ws-server | 协议契约、编解码、认证、请求路由、AP 适配、会话和服务状态、监听器生命周期 |
| modules/agent-platform/bridge.shared | 事件规范化、聊天投影、输出文本、图片事件、HTTP 响应、类型与基础值 |
| modules/assistant/navigation-status-client | API、数据投影、实时推送、工作区/Git、契约和值；客户端统一持有快照与订阅状态 |
| modules/webs/webapps/runtime | 健康探针、进程控制、启动上下文、状态持久化；runtime 统一持有 records 和启停流程 |
| app/bootstrap/desktop-init | 设置、Site 种子安装、状态、应用编排、升级和测试入口 |
| app/module-registry | IPC 契约、实时诊断，以及助理、Frame Port、服务市场、窗口工作面板、关联运行时的装配 |
| infrastructure/filesystem/runtime-environment | 路径、ZIP 安全校验、包校验、种子、导入、重置、升级和契约 |
| modules/services/agent-webclient-host | 配置/策略、唯一 host 实例表、静态文件、HTTP/WS 代理、认证、请求分派和测试入口 |
| modules/services/manager/index | 安装部署、环境/命令策略、状态查询、验证、启停、启动流水线、退出、恢复、升级、日志和唯一会话状态 |
| support/manifest/manifest-utils | 基础值/类型、读取、服务/插件字段与策略、命令、hosting、能力及最终组合规范化 |
| modules/identity/oidc-sso | 配置、会话、HTTP、claims、授权、token 验证、回调、代理、登录恢复、浏览器会话和唯一 SSO 状态 |
| modules/identity/sso-controller | 控制器契约、浏览器 Cookie/响应/导航、统一恢复与刷新控制器 |
| modules/kanban/local-store | 数据库生命周期、编解码、查询/写入、云快照、游标、outbox、命令/运行回执与测试入口 |
| modules/kanban/ws-client | 协议、传输、payload 规范化、基础值、模型；单一连接状态机持有 socket/pending/重连 |
| modules/pet/controller | 活动跟踪、导航/状态投影、位置持久化、拖拽、窗口、预览控制器 |
| modules/pet/desktop-pet | 资产、设置、状态、路径、窗口尺寸/布局、类型及测试入口 |
| modules/marketplace/common | HTTP/认证、配置、路径、目录规范化/查询/投影、安装记录、下载与平台资源选择 |
| modules/shell/window-manager | 主窗口选项/事件/生命周期/激活/WebContents、guest attach 策略/事件/快捷键、媒体权限和类型 |

## 具体例子与依赖边界

用户最初指出的 runtime.part-3.ts 已拆到 renderer-action-results.ts、web-resource-actions.ts、webapp-action-results.ts、webapp-tooling-actions.ts。它们分别承担 renderer 结果投影、网站/应用动作、应用结果与诊断、可信工作区工程工具。来自其他旧 part 的同类声明也合并进入这些职责文件，所以不是一对一改名。

服务 manager 的 index.part-4.part-*、index.part-5.part-* 二次切片已消除，安装、验证、启动、停止、退出与恢复可以按文件名定位。SSO 的同类 HTTP/授权/会话声明也从多个旧切片重新归并。

公共调用仍从既有入口进入，内部实现直接依赖职责模块，避免回指聚合入口形成环。关键可变状态保留唯一所有者：服务 session-state、WebClient host runtime、WebApp runtime、导航客户端、SSO state/controller 和 Kanban connection。

各组声明比对证据：A 505 项中 504 项正文一致，唯一变化是 WS 连接把具体 bridge 类类型收窄为 forwardRequest/close 端口；B 415 项移出声明 AST 一致，IPC 除等价参数改写外保持装配内容与顺序；C 718 项正文一致。这些是移动完整性证据，不能替代运行测试。

## 最终验证

父任务在三组结束后重新执行：

- Main TypeScript：`tsc -p tsconfig.main.json --noEmit` 通过。
- 架构检查：`npm run architecture:check` 通过，585 个源文件 / 20 个领域模块。
- `git diff --check` 通过。
- `src` 文件名中的 part-N：0；`src/scripts/test` 中旧 .part-N 引用：0。QA 原始清单与映射报告仍保留历史文件名供追溯。
- 当前全仓 i18n strict 扫描仍不通过，输出位于 /tmp/part-refactor-final-i18n.log；未对所有命中逐项完成基线归因。

以下功能测试为三个执行任务的最终隔离输出结果，父任务没有重复执行全部套件；存在测试重叠，不合并成去重总数：

| 范围 | 最终结果 |
| --- | --- |
| A：12 文件功能回归 | 229/229 通过 |
| A：鉴权接线、Broker 静态门禁、Windows/WebApp shutdown 定向 | 1/1、3/3、3/3 通过 |
| B：13 套服务/启动集成测试 | 263 通过、3 跳过、0 失败 |
| C：15 套身份/看板/桌宠/市场/窗口回归 | 305/305 通过 |
| C：Windows titlebar 与 Kanban detail 源码约束 | 8/8 通过 |
| 完整 renderer-build 源码断言（A 最后一次执行） | 114/174 通过，60 失败 |
| B 所选 renderer-build 子集 | 2 通过、5 失败；HEAD 基线相同 5 项、相同断言失败 |

不能称为全仓测试全绿。A 为 dictionary、project ACP 与 ownership shutdown 三个具体正则提供了 HEAD 不匹配证据；B 为其 5 个失败提供了独立基线测试证据。未对完整 renderer-build 的所有失败统一归因，不能据此认为它们全是历史问题。ownership shutdown 也没有全文件最终通过的结论。

3 项跳过均为 Windows 原生平台条件用例。本机为 macOS，自动测试覆盖部分平台分支；Windows/macOS 的真实 Electron UI、安装器和 qa/manual-regression.md 手工回归尚未执行。

## 拆分质量判断与后续事项

现状已解决编号文件无法表达职责的问题，也保留了状态所有权与公共入口；类型和依赖检查通过。1,000 行仍只是维护建议，不阻断检查，不能当作拆分目标。

文件数量从 80 增至 227，导航成本相应增加。有些文件只有十几行，尤其权限解析、基础值、状态容器与测试入口；部分独立有明确依赖/状态边界价值，但不应把文件越小当作越好。下一轮应基于调用关系评估是否合并无独立职责的小模块，而不是继续追求行数。当前最大三个职责文件为 Kanban ws-connection（820）、SSO controller runtime（770）及 SSO config（750），没有必要仅为继续缩短它们而拆散状态机。

发布前应优先完成 renderer-build 失败的逐项基线归因、全仓 i18n 检查清理和双平台关键流程手工回归。本报告不以这些未完成项否定已通过的局部验证，也不将重构直接视为可发布状态。

## 详细映射报告

- [A：动作与通信](part-refactor-actions-communication.md)
- [B：服务与启动](part-refactor-services-bootstrap.md)
- [C：身份与桌面交互](part-refactor-identity-desktop.md)
- [原始 61 文件清单](part-files-inventory.md)

## 全部最终文件与磁盘行数

包含 19 个原公共入口；行数计入 import、空行和导出，末尾换行不额外计一行。

| 组别 | 文件 | 行数 | 职责 |
| --- | --- | ---: | --- |
| A | [src/main/modules/agent-platform/assistant-output-text.ts](../src/main/modules/agent-platform/assistant-output-text.ts) | 146 | 输出文本提取与 JSONL 尾部结果读取 |
| A | [src/main/modules/agent-platform/bridge-contracts.ts](../src/main/modules/agent-platform/bridge-contracts.ts) | 188 | Platform DTO、运行态及资源上限类型 |
| A | [src/main/modules/agent-platform/bridge-values.ts](../src/main/modules/agent-platform/bridge-values.ts) | 40 | ID、基础值与访问模式解析 |
| A | [src/main/modules/agent-platform/bridge.shared.ts](../src/main/modules/agent-platform/bridge.shared.ts) | 9 | Platform shared 兼容导出入口 |
| A | [src/main/modules/agent-platform/chat-projections.ts](../src/main/modules/agent-platform/chat-projections.ts) | 206 | 聊天列表、搜索、历史消息 DTO 投影 |
| A | [src/main/modules/agent-platform/image-generation-events.ts](../src/main/modules/agent-platform/image-generation-events.ts) | 120 | 图片生成提示词与事件结果归并 |
| A | [src/main/modules/agent-platform/platform-event-normalizer.ts](../src/main/modules/agent-platform/platform-event-normalizer.ts) | 202 | Platform 时间与 awaiting/event 校验 |
| A | [src/main/modules/agent-platform/platform-http-response.ts](../src/main/modules/agent-platform/platform-http-response.ts) | 119 | 受限响应读取、API 错误与上传数据转换 |
| A | [src/main/modules/assistant/navigation-api.ts](../src/main/modules/assistant/navigation-api.ts) | 122 | 导航 HTTP 查询和快照组装 |
| A | [src/main/modules/assistant/navigation-contracts.ts](../src/main/modules/assistant/navigation-contracts.ts) | 223 | 导航数据结构、刷新/列表限制与事件集合 |
| A | [src/main/modules/assistant/navigation-projections.ts](../src/main/modules/assistant/navigation-projections.ts) | 445 | Agent/Chat 列表映射、排序合并与未读派生 |
| A | [src/main/modules/assistant/navigation-push.ts](../src/main/modules/assistant/navigation-push.ts) | 661 | 实时事件解析、游标/已读保护及不可变列表更新 |
| A | [src/main/modules/assistant/navigation-status-client.ts](../src/main/modules/assistant/navigation-status-client.ts) | 640 | 快照、刷新调度、Broker 订阅与状态日志的单一所有者 |
| A | [src/main/modules/assistant/navigation-values.ts](../src/main/modules/assistant/navigation-values.ts) | 136 | 时间、计数、awaiting 与基本值校验 |
| A | [src/main/modules/assistant/navigation-workspace.ts](../src/main/modules/assistant/navigation-workspace.ts) | 145 | 工作区存在性、平台 Git 命令与分支缓存/富化 |
| A | [src/main/modules/desktop-actions/action-contracts.ts](../src/main/modules/desktop-actions/action-contracts.ts) | 178 | 动作依赖端口、调用来源与请求/响应类型 |
| A | [src/main/modules/desktop-actions/action-dispatch.ts](../src/main/modules/desktop-actions/action-dispatch.ts) | 582 | 动作名称到所属能力的分派 |
| A | [src/main/modules/desktop-actions/action-handlers.ts](../src/main/modules/desktop-actions/action-handlers.ts) | 184 | 调用来源门禁、确认与统一响应规范化 |
| A | [src/main/modules/desktop-actions/action-http-server.ts](../src/main/modules/desktop-actions/action-http-server.ts) | 206 | loopback HTTP 服务、入口校验与启停状态 |
| A | [src/main/modules/desktop-actions/action-permissions.ts](../src/main/modules/desktop-actions/action-permissions.ts) | 11 | 权限模式解析 |
| A | [src/main/modules/desktop-actions/action-values.ts](../src/main/modules/desktop-actions/action-values.ts) | 184 | 动作响应构造与资源参数读取 |
| A | [src/main/modules/desktop-actions/cdp-handler.ts](../src/main/modules/desktop-actions/cdp-handler.ts) | 82 | CDP 请求协议校验与执行适配 |
| A | [src/main/modules/desktop-actions/confirmation-dialog.ts](../src/main/modules/desktop-actions/confirmation-dialog.ts) | 30 | renderer/原生确认对话框交互 |
| A | [src/main/modules/desktop-actions/confirmation-policy.ts](../src/main/modules/desktop-actions/confirmation-policy.ts) | 219 | 写动作、敏感读取及页面控制确认策略 |
| A | [src/main/modules/desktop-actions/confirmation-presentation.ts](../src/main/modules/desktop-actions/confirmation-presentation.ts) | 204 | 确认界面的脱敏摘要与展示内容 |
| A | [src/main/modules/desktop-actions/help-routing.ts](../src/main/modules/desktop-actions/help-routing.ts) | 35 | 帮助主题与允许路由解析 |
| A | [src/main/modules/desktop-actions/kanban-actions.ts](../src/main/modules/desktop-actions/kanban-actions.ts) | 83 | Kanban 动作参数验证及运行时调用 |
| A | [src/main/modules/desktop-actions/local-file-actions.ts](../src/main/modules/desktop-actions/local-file-actions.ts) | 94 | 本地文件输入校验与一次性 claim 编排 |
| A | [src/main/modules/desktop-actions/market-action-input.ts](../src/main/modules/desktop-actions/market-action-input.ts) | 52 | 市场配置输入校验与预览 |
| A | [src/main/modules/desktop-actions/page-context-values.ts](../src/main/modules/desktop-actions/page-context-values.ts) | 18 | 页面快照 URL 与 origin 读取 |
| A | [src/main/modules/desktop-actions/page-control-policy.ts](../src/main/modules/desktop-actions/page-control-policy.ts) | 163 | 页面风险判定与有限期授权缓存 |
| A | [src/main/modules/desktop-actions/pet-actions.ts](../src/main/modules/desktop-actions/pet-actions.ts) | 66 | 桌宠动作适配 |
| A | [src/main/modules/desktop-actions/platform-http.ts](../src/main/modules/desktop-actions/platform-http.ts) | 122 | Platform HTTP 鉴权重试及响应解析 |
| A | [src/main/modules/desktop-actions/renderer-action-results.ts](../src/main/modules/desktop-actions/renderer-action-results.ts) | 361 | renderer 动作结果的最小公共投影 |
| A | [src/main/modules/desktop-actions/runtime.ts](../src/main/modules/desktop-actions/runtime.ts) | 46 | 动作兼容入口与测试 hook |
| A | [src/main/modules/desktop-actions/web-export-actions.ts](../src/main/modules/desktop-actions/web-export-actions.ts) | 250 | 网页导出 Provider 校验、载荷及落盘 |
| A | [src/main/modules/desktop-actions/web-resource-actions.ts](../src/main/modules/desktop-actions/web-resource-actions.ts) | 486 | Website/WebApp 安装、生命周期与发布动作编排 |
| A | [src/main/modules/desktop-actions/webapp-action-results.ts](../src/main/modules/desktop-actions/webapp-action-results.ts) | 197 | WebApp 成败结果、诊断与脱敏投影 |
| A | [src/main/modules/desktop-actions/webapp-image-input.ts](../src/main/modules/desktop-actions/webapp-image-input.ts) | 90 | 图片请求约束及在途请求索引 |
| A | [src/main/modules/desktop-actions/webapp-native-actions.ts](../src/main/modules/desktop-actions/webapp-native-actions.ts) | 316 | WebApp 原生权限、速率限制和系统交互 |
| A | [src/main/modules/desktop-actions/webapp-tooling-actions.ts](../src/main/modules/desktop-actions/webapp-tooling-actions.ts) | 127 | 可信 Run workspace 下的 WebApp 工程工具动作 |
| A | [src/main/modules/desktop-protocol/ws-action-routing.ts](../src/main/modules/desktop-protocol/ws-action-routing.ts) | 465 | 公开动作别名、命名空间与请求分派 |
| A | [src/main/modules/desktop-protocol/ws-authentication.ts](../src/main/modules/desktop-protocol/ws-authentication.ts) | 135 | JWT/device 校验及认证刷新 |
| A | [src/main/modules/desktop-protocol/ws-contracts.ts](../src/main/modules/desktop-protocol/ws-contracts.ts) | 168 | WS 帧、会话、依赖端口与连接类型 |
| A | [src/main/modules/desktop-protocol/ws-platform-adapter.ts](../src/main/modules/desktop-protocol/ws-platform-adapter.ts) | 151 | 共享 Realtime Broker 的 AP namespace consumer |
| A | [src/main/modules/desktop-protocol/ws-server-state.ts](../src/main/modules/desktop-protocol/ws-server-state.ts) | 41 | 服务器/隧道会话集合及 bind/runtime 状态 |
| A | [src/main/modules/desktop-protocol/ws-server.ts](../src/main/modules/desktop-protocol/ws-server.ts) | 208 | 原生 socket/listener 生命周期与兼容公共入口 |
| A | [src/main/modules/desktop-protocol/ws-session.ts](../src/main/modules/desktop-protocol/ws-session.ts) | 102 | 协议会话绑定、心跳及断开清理 |
| A | [src/main/modules/desktop-protocol/ws-values.ts](../src/main/modules/desktop-protocol/ws-values.ts) | 27 | 协议基本值解析与 session identity |
| A | [src/main/modules/desktop-protocol/ws-wire.ts](../src/main/modules/desktop-protocol/ws-wire.ts) | 180 | WS 编解码、upgrade 响应与帧发送 |
| A | [src/main/modules/webs/webapps/runtime-health.ts](../src/main/modules/webs/webapps/runtime-health.ts) | 101 | 端口预留、TCP/HTTP 探针与启动健康等待 |
| A | [src/main/modules/webs/webapps/runtime-launcher.ts](../src/main/modules/webs/webapps/runtime-launcher.ts) | 62 | launcher context、记录 token 和 monitor 清理 |
| A | [src/main/modules/webs/webapps/runtime-process.ts](../src/main/modules/webs/webapps/runtime-process.ts) | 104 | 子进程日志、平台终止与退出验证 |
| A | [src/main/modules/webs/webapps/runtime-state.ts](../src/main/modules/webs/webapps/runtime-state.ts) | 184 | WebApp 运行状态持久化、默认状态及记录类型 |
| A | [src/main/modules/webs/webapps/runtime.ts](../src/main/modules/webs/webapps/runtime.ts) | 722 | WebApp records、启动/停止和健康监测的单一运行时所有者及兼容入口 |
| B | [src/main/app/bootstrap/desktop-init-apply.ts](../src/main/app/bootstrap/desktop-init-apply.ts) | 141 | 一次性 bootstrap 各段协调、失败保留与完成清理 |
| B | [src/main/app/bootstrap/desktop-init-settings.ts](../src/main/app/bootstrap/desktop-init-settings.ts) | 327 | 按所属领域应用一次性 Desktop 设置与规范化默认值 |
| B | [src/main/app/bootstrap/desktop-init-sites.ts](../src/main/app/bootstrap/desktop-init-sites.ts) | 272 | Website/WebApp seed 整体验证、路径安全和安装 |
| B | [src/main/app/bootstrap/desktop-init-state.ts](../src/main/app/bootstrap/desktop-init-state.ts) | 212 | bootstrap 类型、JSON/状态持久化、路径和输入基础校验 |
| B | [src/main/app/bootstrap/desktop-init-testing.ts](../src/main/app/bootstrap/desktop-init-testing.ts) | 33 | bootstrap 既有测试入口 |
| B | [src/main/app/bootstrap/desktop-init-upgrade.ts](../src/main/app/bootstrap/desktop-init-upgrade.ts) | 282 | canonical 配置升级输入验证、备份/恢复与升级应用 |
| B | [src/main/app/bootstrap/desktop-init.ts](../src/main/app/bootstrap/desktop-init.ts) | 6 | 保留原公共入口，聚合职责模块导出 |
| B | [src/main/app/ipc-assistant.ts](../src/main/app/ipc-assistant.ts) | 69 | Assistant 与嵌入 CDP 的 IPC 依赖装配 |
| B | [src/main/app/ipc-connected-runtimes.ts](../src/main/app/ipc-connected-runtimes.ts) | 221 | SSO、企业聊天、Tunnel、Kanban、Web、Pet、设置 IPC 装配 |
| B | [src/main/app/ipc-platform-frame.ts](../src/main/app/ipc-platform-frame.ts) | 369 | Canonical Chat、Frame Port、原生文档动作与实时诊断闭包 |
| B | [src/main/app/ipc-registration-contracts.ts](../src/main/app/ipc-registration-contracts.ts) | 80 | 既有 IPC 装配输入类型与文档版本响应头常量 |
| B | [src/main/app/ipc-registration.ts](../src/main/app/ipc-registration.ts) | 16 | 公共注册入口，按原顺序调用领域装配并注册 Help |
| B | [src/main/app/ipc-services-market.ts](../src/main/app/ipc-services-market.ts) | 220 | 服务操作、环境升级/导入与 Marketplace/plugin 端口装配 |
| B | [src/main/app/ipc-shell-workpanel.ts](../src/main/app/ipc-shell-workpanel.ts) | 137 | Shell、WorkPanel 文档/资源、Artifact 的可信 IPC 依赖装配 |
| B | [src/main/app/module-registry.ts](../src/main/app/module-registry.ts) | 3 | 保留原公共入口，聚合职责模块导出 |
| B | [src/main/app/realtime-diagnostics.ts](../src/main/app/realtime-diagnostics.ts) | 131 | 实时运行时诊断投影与 URL 清洗；供 IPC 和性能诊断复用 |
| B | [src/main/infrastructure/filesystem/runtime-env-archive.ts](../src/main/infrastructure/filesystem/runtime-env-archive.ts) | 205 | ZIP 路径规范化、越界/符号链接防护、版本校验及文件权限 |
| B | [src/main/infrastructure/filesystem/runtime-env-bundle.ts](../src/main/infrastructure/filesystem/runtime-env-bundle.ts) | 115 | 已打包 env manifest 发现与完整性校验 |
| B | [src/main/infrastructure/filesystem/runtime-env-contracts.ts](../src/main/infrastructure/filesystem/runtime-env-contracts.ts) | 109 | 环境包、导入/还原/升级结果类型与固定布局常量 |
| B | [src/main/infrastructure/filesystem/runtime-env-import.ts](../src/main/infrastructure/filesystem/runtime-env-import.ts) | 163 | 导入标记、环境解压写入及 bundled import |
| B | [src/main/infrastructure/filesystem/runtime-env-paths.ts](../src/main/infrastructure/filesystem/runtime-env-paths.ts) | 260 | Windows/macOS 运行根、资源候选与桌面版本解析 |
| B | [src/main/infrastructure/filesystem/runtime-env-reset.ts](../src/main/infrastructure/filesystem/runtime-env-reset.ts) | 152 | 旧根冲突、备份隔离、还原失败结果与重建 |
| B | [src/main/infrastructure/filesystem/runtime-env-seed.ts](../src/main/infrastructure/filesystem/runtime-env-seed.ts) | 47 | 初始 env 包与摘要记录的持久化 |
| B | [src/main/infrastructure/filesystem/runtime-env-upgrade.ts](../src/main/infrastructure/filesystem/runtime-env-upgrade.ts) | 214 | 升级或手工导入 ZIP 的整体验证与 staging |
| B | [src/main/infrastructure/filesystem/runtime-environment.ts](../src/main/infrastructure/filesystem/runtime-environment.ts) | 10 | 保留原公共入口，聚合职责模块导出 |
| B | [src/main/modules/services/agent-webclient-host.ts](../src/main/modules/services/agent-webclient-host.ts) | 12 | 保留原公共入口，聚合职责模块导出 |
| B | [src/main/modules/services/manager/capability-requirements.ts](../src/main/modules/services/manager/capability-requirements.ts) | 251 | 能力提供者和 HTTP 依赖验证、认证复用、preStart 要求 |
| B | [src/main/modules/services/manager/command-environment.ts](../src/main/modules/services/manager/command-environment.ts) | 93 | Node 启动上下文和服务命令环境构造，不迁移服务私有配置 |
| B | [src/main/modules/services/manager/configuration.ts](../src/main/modules/services/manager/configuration.ts) | 133 | 配置读写、导入文件及插件资源刷新 |
| B | [src/main/modules/services/manager/environment-bindings.ts](../src/main/modules/services/manager/environment-bindings.ts) | 96 | 仅按现有边界处理绑定模板、服务端口与插件环境绑定 |
| B | [src/main/modules/services/manager/execution-layout.ts](../src/main/modules/services/manager/execution-layout.ts) | 106 | 布局目录准备、资源签名刷新判断和非核心模板配置准备 |
| B | [src/main/modules/services/manager/host-policy.ts](../src/main/modules/services/manager/host-policy.ts) | 78 | host-managed 判断、宿主地址与端口参数解析 |
| B | [src/main/modules/services/manager/index.ts](../src/main/modules/services/manager/index.ts) | 33 | 保留原公共入口，聚合职责模块导出 |
| B | [src/main/modules/services/manager/installation.ts](../src/main/modules/services/manager/installation.ts) | 457 | 内置包安装去重、校验解压、初始化事务和 deploy 能力输入 |
| B | [src/main/modules/services/manager/lifecycle-command-policy.ts](../src/main/modules/services/manager/lifecycle-command-policy.ts) | 199 | deploy/start/stop 显式参数与目录标志构造，保留平台分支 |
| B | [src/main/modules/services/manager/log-stream.ts](../src/main/modules/services/manager/log-stream.ts) | 197 | 日志元信息、分页读取、轮询订阅与取消 |
| B | [src/main/modules/services/manager/manager-contracts.ts](../src/main/modules/services/manager/manager-contracts.ts) | 127 | 服务编排参数、状态读取/验证选项和固定服务集合；不保存可变运行状态 |
| B | [src/main/modules/services/manager/repair-policy.ts](../src/main/modules/services/manager/repair-policy.ts) | 39 | 缺失核心配置和安装状态的启动修复判定 |
| B | [src/main/modules/services/manager/restore-policy.ts](../src/main/modules/services/manager/restore-policy.ts) | 24 | 资源插件恢复资格和服务选择 |
| B | [src/main/modules/services/manager/restore-services.ts](../src/main/modules/services/manager/restore-services.ts) | 76 | 恢复上次运行服务的有序编排 |
| B | [src/main/modules/services/manager/runtime-upgrade.ts](../src/main/modules/services/manager/runtime-upgrade.ts) | 285 | 版本升级和手工环境导入的服务事务编排 |
| B | [src/main/modules/services/manager/service-command.ts](../src/main/modules/services/manager/service-command.ts) | 100 | 执行前安装校验、生命周期命令执行与状态返回 |
| B | [src/main/modules/services/manager/service-start.ts](../src/main/modules/services/manager/service-start.ts) | 271 | 启动、重新初始化、host/resource 分支与重启 |
| B | [src/main/modules/services/manager/service-state.ts](../src/main/modules/services/manager/service-state.ts) | 314 | 完整与响应式服务状态读取、先决条件检查与状态列表 |
| B | [src/main/modules/services/manager/service-stop.ts](../src/main/modules/services/manager/service-stop.ts) | 122 | 正常停服、host/resource 分支与停止验证 |
| B | [src/main/modules/services/manager/session-state.ts](../src/main/modules/services/manager/session-state.ts) | 7 | 会话已启动集合、安装并发去重表、后台准备任务集合的唯一实例 |
| B | [src/main/modules/services/manager/shutdown.ts](../src/main/modules/services/manager/shutdown.ts) | 138 | 退出停服并发协调、超时、运行服务记录与结果汇总 |
| B | [src/main/modules/services/manager/startup-options.ts](../src/main/modules/services/manager/startup-options.ts) | 23 | 已准备服务的启动读取策略与调度让出 |
| B | [src/main/modules/services/manager/startup-pipeline.ts](../src/main/modules/services/manager/startup-pipeline.ts) | 198 | 公共准备、登录/Provider 门禁、核心并发启动与最终汇总 |
| B | [src/main/modules/services/manager/startup-services.ts](../src/main/modules/services/manager/startup-services.ts) | 416 | 逐服务准备、可选服务恢复和后台安装任务管理 |
| B | [src/main/modules/services/manager/testing.ts](../src/main/modules/services/manager/testing.ts) | 146 | 保留 manager 公共 __testInternals 兼容入口 |
| B | [src/main/modules/services/manager/verification-policy.ts](../src/main/modules/services/manager/verification-policy.ts) | 135 | 健康结果投影、依赖验证条件与超时选择 |
| B | [src/main/modules/services/manager/verification.ts](../src/main/modules/services/manager/verification.ts) | 185 | 单轮健康采集、限时重试以及命令结果附加验证 |
| B | [src/main/modules/services/webclient-host-config.ts](../src/main/modules/services/webclient-host-config.ts) | 141 | manifest hosting、目录、环境路由目标与运行配置脚本 |
| B | [src/main/modules/services/webclient-host-policy.ts](../src/main/modules/services/webclient-host-policy.ts) | 39 | 回环绑定、开发 CORS 常量与禁止 HTTP/WS 绕过 Frame Port 的路径策略 |
| B | [src/main/modules/services/webclient-host-runtime.ts](../src/main/modules/services/webclient-host-runtime.ts) | 117 | hosts 实例表与 host start/stop/state 生命周期唯一所有者 |
| B | [src/main/modules/services/webclient-host-testing.ts](../src/main/modules/services/webclient-host-testing.ts) | 13 | 保留宿主公共 __testInternals 兼容入口 |
| B | [src/main/modules/services/webclient-host-types.ts](../src/main/modules/services/webclient-host-types.ts) | 47 | 宿主配置、实例记录、token 回调及资源解析类型 |
| B | [src/main/modules/services/webclient-http-proxy.ts](../src/main/modules/services/webclient-http-proxy.ts) | 87 | HTTP 代理请求、鉴权刷新重试与响应流转发 |
| B | [src/main/modules/services/webclient-http-utils.ts](../src/main/modules/services/webclient-http-utils.ts) | 62 | 请求 URL/header、CORS 和 JSON/代理错误响应 |
| B | [src/main/modules/services/webclient-proxy-auth.ts](../src/main/modules/services/webclient-proxy-auth.ts) | 199 | HTTP/WS token 获取刷新、鉴权失败与禁用响应 |
| B | [src/main/modules/services/webclient-proxy-policy.ts](../src/main/modules/services/webclient-proxy-policy.ts) | 72 | 代理路径匹配、上游 URL/header、SSE 请求策略 |
| B | [src/main/modules/services/webclient-request-handler.ts](../src/main/modules/services/webclient-request-handler.ts) | 105 | 按来源与路径选择静态响应、HTTP 或升级代理 |
| B | [src/main/modules/services/webclient-static-files.ts](../src/main/modules/services/webclient-static-files.ts) | 111 | SPA/静态路径安全解析、MIME 与文件响应 |
| B | [src/main/modules/services/webclient-websocket-proxy.ts](../src/main/modules/services/webclient-websocket-proxy.ts) | 123 | WebSocket 升级请求与 TCP/TLS 上游连接 |
| B | [src/main/support/manifest/manifest-capabilities.ts](../src/main/support/manifest/manifest-capabilities.ts) | 136 | env bindings、能力提供者与要求规范化 |
| B | [src/main/support/manifest/manifest-commands.ts](../src/main/support/manifest/manifest-commands.ts) | 27 | 可执行入口与 manifest command 解析 |
| B | [src/main/support/manifest/manifest-desktop.ts](../src/main/support/manifest/manifest-desktop.ts) | 62 | desktop 部分规范化及服务形态约束 |
| B | [src/main/support/manifest/manifest-hosting.ts](../src/main/support/manifest/manifest-hosting.ts) | 175 | desktop hosting/proxy routes 与 WebClient Frame Port hosting 校验 |
| B | [src/main/support/manifest/manifest-normalize.ts](../src/main/support/manifest/manifest-normalize.ts) | 79 | 将各字段规范化器组合成 ServiceDefinition |
| B | [src/main/support/manifest/manifest-plugin-fields.ts](../src/main/support/manifest/manifest-plugin-fields.ts) | 253 | 插件 bridge/hooks/resources/settings 与 desktop actions |
| B | [src/main/support/manifest/manifest-plugin-policy.ts](../src/main/support/manifest/manifest-plugin-policy.ts) | 25 | 插件旧 manifest 字段拒绝策略 |
| B | [src/main/support/manifest/manifest-reader.ts](../src/main/support/manifest/manifest-reader.ts) | 25 | manifest 文件/归档读取与定位 |
| B | [src/main/support/manifest/manifest-service-fields.ts](../src/main/support/manifest/manifest-service-fields.ts) | 181 | 服务形态、前后端、脚本、配置和 runtime 字段规范化 |
| B | [src/main/support/manifest/manifest-service-policy.ts](../src/main/support/manifest/manifest-service-policy.ts) | 118 | 核心服务端口覆盖与测试端口基准策略 |
| B | [src/main/support/manifest/manifest-types.ts](../src/main/support/manifest/manifest-types.ts) | 88 | 服务定义、导入目标与 manifest 规范化选项 |
| B | [src/main/support/manifest/manifest-utils.ts](../src/main/support/manifest/manifest-utils.ts) | 12 | 保留原公共入口，聚合职责模块导出 |
| B | [src/main/support/manifest/manifest-values.ts](../src/main/support/manifest/manifest-values.ts) | 67 | 不依赖业务的输入值读取和小型路径/响应复制 |
| C | [src/main/modules/identity/oidc-sso.ts](../src/main/modules/identity/oidc-sso.ts) | 22 | 保留原公共入口，聚合职责模块导出 |
| C | [src/main/modules/identity/sso-authorization.ts](../src/main/modules/identity/sso-authorization.ts) | 174 | 授权/登出 URL、PKCE 和 token 请求参数 |
| C | [src/main/modules/identity/sso-browser-cookies.ts](../src/main/modules/identity/sso-browser-cookies.ts) | 141 | 浏览器 Set-Cookie 解析与 Session 写入 |
| C | [src/main/modules/identity/sso-browser-navigation.ts](../src/main/modules/identity/sso-browser-navigation.ts) | 91 | 浏览器 Cookie 请求、导航重写及登录后焦点恢复 |
| C | [src/main/modules/identity/sso-browser-response.ts](../src/main/modules/identity/sso-browser-response.ts) | 80 | 浏览器换票错误与稳定用户身份解析 |
| C | [src/main/modules/identity/sso-browser-session.ts](../src/main/modules/identity/sso-browser-session.ts) | 336 | Cookie SSO 会话与用户步骤、派生 Cookie 和 canonical token 发布 |
| C | [src/main/modules/identity/sso-callback-page.ts](../src/main/modules/identity/sso-callback-page.ts) | 59 | 回调 HTML、转义与响应输出 |
| C | [src/main/modules/identity/sso-callback-params.ts](../src/main/modules/identity/sso-callback-params.ts) | 45 | OIDC/code/ticket 回调参数与防重放校验 |
| C | [src/main/modules/identity/sso-callback-server.ts](../src/main/modules/identity/sso-callback-server.ts) | 287 | 动态回环监听器、登录回调处理和响应后清理 |
| C | [src/main/modules/identity/sso-claims.ts](../src/main/modules/identity/sso-claims.ts) | 101 | JWT/用户 claims 解析与规范化 |
| C | [src/main/modules/identity/sso-config-values.ts](../src/main/modules/identity/sso-config-values.ts) | 174 | 配置基础值读取、provider 与 PKCE 策略判定 |
| C | [src/main/modules/identity/sso-config.ts](../src/main/modules/identity/sso-config.ts) | 750 | 完整配置解析、嵌套配置校验和磁盘配置加载 |
| C | [src/main/modules/identity/sso-controller-model.ts](../src/main/modules/identity/sso-controller-model.ts) | 88 | Electron 登录控制器依赖端口、返回类型及恢复错误 |
| C | [src/main/modules/identity/sso-controller-runtime.ts](../src/main/modules/identity/sso-controller-runtime.ts) | 770 | 单一控制器拥有恢复/刷新单飞、账号代次和交互登录流程 |
| C | [src/main/modules/identity/sso-controller.ts](../src/main/modules/identity/sso-controller.ts) | 5 | 保留原公共入口，聚合职责模块导出 |
| C | [src/main/modules/identity/sso-cookie-token.ts](../src/main/modules/identity/sso-cookie-token.ts) | 267 | Cookie 换票、JWT 候选选择与 issuer/audience 匹配 |
| C | [src/main/modules/identity/sso-defaults.ts](../src/main/modules/identity/sso-defaults.ts) | 112 | OIDC/Google 默认配置、回调与凭据文件常量 |
| C | [src/main/modules/identity/sso-http.ts](../src/main/modules/identity/sso-http.ts) | 92 | Electron fetch 选择、JSON 请求与错误诊断 |
| C | [src/main/modules/identity/sso-login.ts](../src/main/modules/identity/sso-login.ts) | 239 | 交互登录、取消和登出的生命周期编排 |
| C | [src/main/modules/identity/sso-model.ts](../src/main/modules/identity/sso-model.ts) | 251 | 身份配置、凭据、回调与浏览器 Cookie 类型契约 |
| C | [src/main/modules/identity/sso-paths.ts](../src/main/modules/identity/sso-paths.ts) | 31 | 品牌隔离身份配置和凭据路径及旧重复 token 文件清理 |
| C | [src/main/modules/identity/sso-proxy-urls.ts](../src/main/modules/identity/sso-proxy-urls.ts) | 90 | 代理 URL、来源和 Set-Cookie 重写规则 |
| C | [src/main/modules/identity/sso-proxy.ts](../src/main/modules/identity/sso-proxy.ts) | 260 | 登录 HTTP 代理与代理 Cookie 状态维护 |
| C | [src/main/modules/identity/sso-restore.ts](../src/main/modules/identity/sso-restore.ts) | 139 | 状态呈现与启动恢复候选分类、临时不可用和本地退出 |
| C | [src/main/modules/identity/sso-session.ts](../src/main/modules/identity/sso-session.ts) | 452 | 凭据与用户文件持久化、会话步骤完成、撤销与失败处理 |
| C | [src/main/modules/identity/sso-state.ts](../src/main/modules/identity/sso-state.ts) | 145 | 唯一进程内 SSO 状态、一次性代码集合与状态 DTO 构造 |
| C | [src/main/modules/identity/sso-test-internals.ts](../src/main/modules/identity/sso-test-internals.ts) | 94 | 保留既有 OIDC 测试观察入口 |
| C | [src/main/modules/identity/sso-token-validation.ts](../src/main/modules/identity/sso-token-validation.ts) | 252 | 签名验证、用户信息补充与有效 OIDC 登录完成 |
| C | [src/main/modules/kanban/local-store.ts](../src/main/modules/kanban/local-store.ts) | 16 | 保留原公共入口，聚合职责模块导出 |
| C | [src/main/modules/kanban/store-cloud-details.ts](../src/main/modules/kanban/store-cloud-details.ts) | 121 | 云详情只读缓存的合并和数据库读写 |
| C | [src/main/modules/kanban/store-cloud-snapshot.ts](../src/main/modules/kanban/store-cloud-snapshot.ts) | 316 | Server 权威快照投影与派发 issue 幂等落地 |
| C | [src/main/modules/kanban/store-command-receipts.ts](../src/main/modules/kanban/store-command-receipts.ts) | 162 | 派发命令回执、精确运行身份和已上报状态 |
| C | [src/main/modules/kanban/store-database.ts](../src/main/modules/kanban/store-database.ts) | 374 | 数据库路径、连接生命周期、schema 初始化与种子记录 |
| C | [src/main/modules/kanban/store-issue-writes.ts](../src/main/modules/kanban/store-issue-writes.ts) | 140 | 底层 issue 行写入与位置计算 |
| C | [src/main/modules/kanban/store-issues.ts](../src/main/modules/kanban/store-issues.ts) | 287 | 本地 issue 用例、运行态更新、位置调整、云 tombstone 和单项读取 |
| C | [src/main/modules/kanban/store-local-issue-model.ts](../src/main/modules/kanban/store-local-issue-model.ts) | 161 | 本地 issue 创建模型与字段更新计算 |
| C | [src/main/modules/kanban/store-model.ts](../src/main/modules/kanban/store-model.ts) | 204 | SQLite 行、云快照、同步游标和运行回执类型 |
| C | [src/main/modules/kanban/store-outbox.ts](../src/main/modules/kanban/store-outbox.ts) | 95 | 现有云 mutation 与 run event outbox 持久化及尝试记录 |
| C | [src/main/modules/kanban/store-project-writes.ts](../src/main/modules/kanban/store-project-writes.ts) | 126 | 项目/绑定写入、存在性及默认绑定维护 |
| C | [src/main/modules/kanban/store-queries.ts](../src/main/modules/kanban/store-queries.ts) | 124 | 问题、项目和绑定集合查询 |
| C | [src/main/modules/kanban/store-row-codec.ts](../src/main/modules/kanban/store-row-codec.ts) | 202 | SQLite 行及云 project/binding 到领域 DTO 的转换 |
| C | [src/main/modules/kanban/store-run-receipts.ts](../src/main/modules/kanban/store-run-receipts.ts) | 61 | Desktop 手动运行回执 |
| C | [src/main/modules/kanban/store-sync-cursor.ts](../src/main/modules/kanban/store-sync-cursor.ts) | 85 | revision 与云同步游标的持久化 |
| C | [src/main/modules/kanban/store-test-internals.ts](../src/main/modules/kanban/store-test-internals.ts) | 9 | 保持存储测试观察入口 |
| C | [src/main/modules/kanban/store-values.ts](../src/main/modules/kanban/store-values.ts) | 179 | 存储常量、字段归一化与 issue detail 编码 |
| C | [src/main/modules/kanban/ws-client.ts](../src/main/modules/kanban/ws-client.ts) | 6 | 保留原公共入口，聚合职责模块导出 |
| C | [src/main/modules/kanban/ws-connection.ts](../src/main/modules/kanban/ws-connection.ts) | 820 | 唯一 Kanban socket、pending 请求、重连和交付处理状态机 |
| C | [src/main/modules/kanban/ws-model.ts](../src/main/modules/kanban/ws-model.ts) | 147 | Kanban 连接依赖、消息与交付结果类型 |
| C | [src/main/modules/kanban/ws-payloads.ts](../src/main/modules/kanban/ws-payloads.ts) | 166 | snapshot、delivery、issue event、run 参数规范化 |
| C | [src/main/modules/kanban/ws-protocol.ts](../src/main/modules/kanban/ws-protocol.ts) | 99 | 协议版本、消息分类和云 payload 隐私限制 |
| C | [src/main/modules/kanban/ws-transport.ts](../src/main/modules/kanban/ws-transport.ts) | 81 | WebSocket 构造器、地址、请求 ID、原始消息解码与诊断 |
| C | [src/main/modules/kanban/ws-values.ts](../src/main/modules/kanban/ws-values.ts) | 11 | 协议基础标量和对象校验 |
| C | [src/main/modules/marketplace/asset-download.ts](../src/main/modules/marketplace/asset-download.ts) | 94 | 受限响应读取、下载、摘要和扩展名 |
| C | [src/main/modules/marketplace/asset-selection.ts](../src/main/modules/marketplace/asset-selection.ts) | 145 | 语义版本、平台候选及 Desktop 兼容性判断 |
| C | [src/main/modules/marketplace/catalog-client.ts](../src/main/modules/marketplace/catalog-client.ts) | 125 | 远端目录加载及安装资源解析 |
| C | [src/main/modules/marketplace/catalog-normalization.ts](../src/main/modules/marketplace/catalog-normalization.ts) | 378 | catalog、资源、依赖及平台规格校验 |
| C | [src/main/modules/marketplace/catalog-projection.ts](../src/main/modules/marketplace/catalog-projection.ts) | 104 | catalog 与本地安装状态合并、列表呈现和条目定位 |
| C | [src/main/modules/marketplace/catalog-values.ts](../src/main/modules/marketplace/catalog-values.ts) | 42 | 外部 catalog 基础类型归一化 |
| C | [src/main/modules/marketplace/common.ts](../src/main/modules/marketplace/common.ts) | 11 | 保留原公共入口，聚合职责模块导出 |
| C | [src/main/modules/marketplace/installed-records.ts](../src/main/modules/marketplace/installed-records.ts) | 85 | 安装记录增删改与资源键去重 |
| C | [src/main/modules/marketplace/market-http.ts](../src/main/modules/marketplace/market-http.ts) | 227 | 认证 provider 状态、设备头、公开/认证请求与 token 刷新 |
| C | [src/main/modules/marketplace/market-model.ts](../src/main/modules/marketplace/market-model.ts) | 98 | 市场端口、记录与目录类型以及协议常量 |
| C | [src/main/modules/marketplace/market-paths.ts](../src/main/modules/marketplace/market-paths.ts) | 41 | 市场目录和通用 JSON 文件持久化 |
| C | [src/main/modules/marketplace/market-settings.ts](../src/main/modules/marketplace/market-settings.ts) | 126 | 市场地址安全策略与配置读写 |
| C | [src/main/modules/pet/activity-trackers.ts](../src/main/modules/pet/activity-trackers.ts) | 116 | 活动 Run 计数与完成预览去重状态 |
| C | [src/main/modules/pet/controller-model.ts](../src/main/modules/pet/controller-model.ts) | 102 | 桌宠控制器输入、窗口/拖拽依赖端口 |
| C | [src/main/modules/pet/controller.ts](../src/main/modules/pet/controller.ts) | 8 | 保留原公共入口，聚合职责模块导出 |
| C | [src/main/modules/pet/desktop-pet.ts](../src/main/modules/pet/desktop-pet.ts) | 20 | 保留原公共入口，聚合职责模块导出 |
| C | [src/main/modules/pet/drag-controller.ts](../src/main/modules/pet/drag-controller.ts) | 279 | 拖动会话、光标增量和跨平台边界更新 |
| C | [src/main/modules/pet/navigation-projection.ts](../src/main/modules/pet/navigation-projection.ts) | 207 | 共享导航快照到任务和消息列表的只读投影 |
| C | [src/main/modules/pet/pet-assets.ts](../src/main/modules/pet/pet-assets.ts) | 290 | 用户宠物清单、资产路径安全与 manifest 校验 |
| C | [src/main/modules/pet/pet-model.ts](../src/main/modules/pet/pet-model.ts) | 96 | 桌宠设置/状态/资产类型与配置常量 |
| C | [src/main/modules/pet/pet-paths.ts](../src/main/modules/pet/pet-paths.ts) | 26 | 桌宠配置/状态/资产目录路径 |
| C | [src/main/modules/pet/pet-settings.ts](../src/main/modules/pet/pet-settings.ts) | 194 | 配置与未读运行态分离读写、设置归一化 |
| C | [src/main/modules/pet/pet-state.ts](../src/main/modules/pet/pet-state.ts) | 281 | 本地与绑定状态合成、最终桌宠 DTO 和上下文菜单 |
| C | [src/main/modules/pet/pet-status-values.ts](../src/main/modules/pet/pet-status-values.ts) | 29 | 摘要过滤与默认本地状态构造 |
| C | [src/main/modules/pet/pet-test-internals.ts](../src/main/modules/pet/pet-test-internals.ts) | 69 | 保留桌宠测试观察入口 |
| C | [src/main/modules/pet/pet-window-layout.ts](../src/main/modules/pet/pet-window-layout.ts) | 431 | 显示器约束、边缘停靠、预览面板布局和逻辑位置换算 |
| C | [src/main/modules/pet/pet-window-metrics.ts](../src/main/modules/pet/pet-window-metrics.ts) | 89 | 窗口尺寸、可见足迹及边缘参数 |
| C | [src/main/modules/pet/position-persistence.ts](../src/main/modules/pet/position-persistence.ts) | 72 | 位置变化判断及偏移持久化计算 |
| C | [src/main/modules/pet/preview-controller.ts](../src/main/modules/pet/preview-controller.ts) | 232 | 预览状态、完成摘要与预览清理控制器 |
| C | [src/main/modules/pet/state-projection.ts](../src/main/modules/pet/state-projection.ts) | 134 | 运行表现刷新与窗口模式选择 |
| C | [src/main/modules/pet/window-controller.ts](../src/main/modules/pet/window-controller.ts) | 190 | 显示/关闭/异常恢复与启用状态回滚 |
| C | [src/main/modules/shell/main-window-activation.ts](../src/main/modules/shell/main-window-activation.ts) | 78 | 主窗口唤醒、聚焦与平台激活行为 |
| C | [src/main/modules/shell/main-window-events.ts](../src/main/modules/shell/main-window-events.ts) | 114 | 主窗口事件、渲染异常诊断与平台外观同步 |
| C | [src/main/modules/shell/main-window-lifecycle.ts](../src/main/modules/shell/main-window-lifecycle.ts) | 245 | 关闭/隐藏/全屏退出状态、定时器与生命周期 |
| C | [src/main/modules/shell/main-window-options.ts](../src/main/modules/shell/main-window-options.ts) | 115 | 主窗口平台选项、Windows AppDetails 与 renderer 加载/DevTools |
| C | [src/main/modules/shell/main-window-web-contents.ts](../src/main/modules/shell/main-window-web-contents.ts) | 165 | 主窗口 WebContents、隔离登录 guest 与事件装配 |
| C | [src/main/modules/shell/media-permissions.ts](../src/main/modules/shell/media-permissions.ts) | 63 | 按受信窗口和 session 限制媒体授权 |
| C | [src/main/modules/shell/webview-attach-policy.ts](../src/main/modules/shell/webview-attach-policy.ts) | 87 | guest attach 参数、partition、preload 与安全偏好校验 |
| C | [src/main/modules/shell/webview-events.ts](../src/main/modules/shell/webview-events.ts) | 310 | 已挂载 guest 导航、弹窗、编辑与 WorkPanel 消息 |
| C | [src/main/modules/shell/webview-shortcuts.ts](../src/main/modules/shell/webview-shortcuts.ts) | 64 | guest 编辑和 WorkPanel 快捷键判定与执行 |
| C | [src/main/modules/shell/window-manager.ts](../src/main/modules/shell/window-manager.ts) | 10 | 保留原公共入口，聚合职责模块导出 |
| C | [src/main/modules/shell/window-model.ts](../src/main/modules/shell/window-model.ts) | 153 | Shell 窗口/guest 窄端口类型与平台常量 |
