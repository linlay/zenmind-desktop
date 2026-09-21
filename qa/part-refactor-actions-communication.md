# A 组 part 重构完成报告

日期：2026-09-21。范围：Desktop Actions、Desktop WS、Agent Platform shared、Assistant navigation、WebApp runtime，共 17 个原 part 文件。直接修改当前目录，未创建 worktree、未切换分支、未提交或暂存。

## 结果与边界

- 按声明职责跨原 part 重新归组，保留五个原公共入口；没有逐个 part 改名，也没有恢复单一巨型实现。
- 授权缓存、WebApp 图片在途索引、WS 服务/隧道连接集合、导航 Git 缓存、导航客户端快照和 WebApp records 各保留唯一所有者。
- 505 个顶层声明逐项与基线 `1cb7b804488002fef528bcf6febaced989d5732e` 比对：504 个声明正文完全相同；唯一差异为 `DesktopWsConnection.agentPlatformBridge` 从具体类类型改为 `{ forwardRequest(req): Promise<void>; close(): void }` 窄结构端口。实例仍由原 `AgentPlatformWsBridge` 创建，未改变构造、调用或清理；该调整消除了 contracts → adapter → wire → contracts 类型依赖环，类型检查及 WS 路由/认证测试通过。
- 确认流程拆为纯权限解析/页面值、展示脱敏、对话框适配、授权风险与确认策略，依赖有向无环。
- Windows/macOS 分支、服务配置所有权、WebApp token scope、Run workspace 门禁与 Kanban 调用语义的函数体均保持原样；未增加新的跨领域设计决策。父任务如需记录内部端口收窄，可引用本报告。

## 原文件到实际模块的映射

下表按声明实际归属统计；同一目标可接收多个原 part 的声明。路径均相对于 `src/main/modules/`，目标与原文件同目录。

| 原文件 | 目标职责文件 |
| --- | --- |
| `desktop-actions/runtime.part-1.ts` | `action-contracts.ts`, `action-http-server.ts`, `action-values.ts`, `confirmation-presentation.ts`, `help-routing.ts`, `market-action-input.ts`, `page-control-policy.ts`, `platform-http.ts`, `web-export-actions.ts`, `webapp-image-input.ts`, `webapp-native-actions.ts` |
| `desktop-actions/runtime.part-7.ts` | `action-http-server.ts`, `cdp-handler.ts`, `runtime.ts` |
| `desktop-actions/runtime.part-4.ts` | `web-resource-actions.ts`, `webapp-native-actions.ts` |
| `desktop-actions/runtime.part-2.ts` | `action-permissions.ts`, `confirmation-dialog.ts`, `confirmation-policy.ts`, `confirmation-presentation.ts`, `page-context-values.ts`, `page-control-policy.ts`, `platform-http.ts`, `renderer-action-results.ts` |
| `desktop-actions/runtime.part-5.ts` | `kanban-actions.ts`, `local-file-actions.ts`, `pet-actions.ts`, `web-export-actions.ts` |
| `desktop-actions/runtime.part-3.ts` | `renderer-action-results.ts`, `web-resource-actions.ts`, `webapp-action-results.ts`, `webapp-tooling-actions.ts` |
| `desktop-actions/runtime.part-6.ts` | `action-dispatch.ts`, `action-handlers.ts` |
| `desktop-protocol/ws-server.part-1.ts` | `ws-action-routing.ts`, `ws-authentication.ts`, `ws-contracts.ts`, `ws-platform-adapter.ts`, `ws-server-state.ts`, `ws-session.ts`, `ws-values.ts`, `ws-wire.ts` |
| `desktop-protocol/ws-server.part-2.ts` | `ws-action-routing.ts`, `ws-contracts.ts`, `ws-server.ts`, `ws-session.ts`, `ws-wire.ts` |
| `agent-platform/bridge.shared.part-1.ts` | `assistant-output-text.ts`, `bridge-contracts.ts`, `bridge-values.ts`, `image-generation-events.ts`, `platform-event-normalizer.ts`, `platform-http-response.ts` |
| `agent-platform/bridge.shared.part-2.ts` | `assistant-output-text.ts`, `bridge-values.ts`, `chat-projections.ts`, `platform-event-normalizer.ts` |
| `assistant/navigation-status-client.part-1.ts` | `navigation-api.ts`, `navigation-contracts.ts`, `navigation-projections.ts`, `navigation-values.ts`, `navigation-workspace.ts` |
| `assistant/navigation-status-client.part-2.ts` | `navigation-contracts.ts`, `navigation-projections.ts`, `navigation-push.ts`, `navigation-workspace.ts` |
| `assistant/navigation-status-client.part-3.ts` | `navigation-api.ts`, `navigation-push.ts` |
| `assistant/navigation-status-client.part-4.ts` | `navigation-status-client.ts` |
| `webs/webapps/runtime.part-1.ts` | `runtime-health.ts`, `runtime-launcher.ts`, `runtime-process.ts`, `runtime-state.ts` |
| `webs/webapps/runtime.part-2.ts` | `runtime.ts` |

## 最终模块与行数

行数包含 import、空行与兼容导出。`bridge.shared.ts` 为纯兼容 re-export 入口，其余部分入口同时保留适合由该入口拥有的运行时类或测试 hook。

| 路径（src/main/modules/） | 行数 | 职责 |
| --- | ---: | --- |
| `agent-platform/assistant-output-text.ts` | 146 | 输出文本提取与 JSONL 尾部结果读取 |
| `agent-platform/bridge-contracts.ts` | 188 | Platform DTO、运行态及资源上限类型 |
| `agent-platform/bridge-values.ts` | 40 | ID、基础值与访问模式解析 |
| `agent-platform/bridge.shared.ts` | 9 | Platform shared 兼容导出入口 |
| `agent-platform/chat-projections.ts` | 206 | 聊天列表、搜索、历史消息 DTO 投影 |
| `agent-platform/image-generation-events.ts` | 120 | 图片生成提示词与事件结果归并 |
| `agent-platform/platform-event-normalizer.ts` | 202 | Platform 时间与 awaiting/event 校验 |
| `agent-platform/platform-http-response.ts` | 119 | 受限响应读取、API 错误与上传数据转换 |
| `assistant/navigation-api.ts` | 122 | 导航 HTTP 查询和快照组装 |
| `assistant/navigation-contracts.ts` | 223 | 导航数据结构、刷新/列表限制与事件集合 |
| `assistant/navigation-projections.ts` | 445 | Agent/Chat 列表映射、排序合并与未读派生 |
| `assistant/navigation-push.ts` | 661 | 实时事件解析、游标/已读保护及不可变列表更新 |
| `assistant/navigation-status-client.ts` | 640 | 快照、刷新调度、Broker 订阅与状态日志的单一所有者 |
| `assistant/navigation-values.ts` | 136 | 时间、计数、awaiting 与基本值校验 |
| `assistant/navigation-workspace.ts` | 145 | 工作区存在性、平台 Git 命令与分支缓存/富化 |
| `desktop-actions/action-contracts.ts` | 178 | 动作依赖端口、调用来源与请求/响应类型 |
| `desktop-actions/action-dispatch.ts` | 582 | 动作名称到所属能力的分派 |
| `desktop-actions/action-handlers.ts` | 184 | 调用来源门禁、确认与统一响应规范化 |
| `desktop-actions/action-http-server.ts` | 206 | loopback HTTP 服务、入口校验与启停状态 |
| `desktop-actions/action-permissions.ts` | 11 | 权限模式解析 |
| `desktop-actions/action-values.ts` | 184 | 动作响应构造与资源参数读取 |
| `desktop-actions/cdp-handler.ts` | 82 | CDP 请求协议校验与执行适配 |
| `desktop-actions/confirmation-dialog.ts` | 30 | renderer/原生确认对话框交互 |
| `desktop-actions/confirmation-policy.ts` | 219 | 写动作、敏感读取及页面控制确认策略 |
| `desktop-actions/confirmation-presentation.ts` | 204 | 确认界面的脱敏摘要与展示内容 |
| `desktop-actions/help-routing.ts` | 35 | 帮助主题与允许路由解析 |
| `desktop-actions/kanban-actions.ts` | 83 | Kanban 动作参数验证及运行时调用 |
| `desktop-actions/local-file-actions.ts` | 94 | 本地文件输入校验与一次性 claim 编排 |
| `desktop-actions/market-action-input.ts` | 52 | 市场配置输入校验与预览 |
| `desktop-actions/page-context-values.ts` | 18 | 页面快照 URL 与 origin 读取 |
| `desktop-actions/page-control-policy.ts` | 163 | 页面风险判定与有限期授权缓存 |
| `desktop-actions/pet-actions.ts` | 66 | 桌宠动作适配 |
| `desktop-actions/platform-http.ts` | 122 | Platform HTTP 鉴权重试及响应解析 |
| `desktop-actions/renderer-action-results.ts` | 361 | renderer 动作结果的最小公共投影 |
| `desktop-actions/runtime.ts` | 46 | 动作兼容入口与测试 hook |
| `desktop-actions/web-export-actions.ts` | 250 | 网页导出 Provider 校验、载荷及落盘 |
| `desktop-actions/web-resource-actions.ts` | 486 | Website/WebApp 安装、生命周期与发布动作编排 |
| `desktop-actions/webapp-action-results.ts` | 197 | WebApp 成败结果、诊断与脱敏投影 |
| `desktop-actions/webapp-image-input.ts` | 90 | 图片请求约束及在途请求索引 |
| `desktop-actions/webapp-native-actions.ts` | 316 | WebApp 原生权限、速率限制和系统交互 |
| `desktop-actions/webapp-tooling-actions.ts` | 127 | 可信 Run workspace 下的 WebApp 工程工具动作 |
| `desktop-protocol/ws-action-routing.ts` | 465 | 公开动作别名、命名空间与请求分派 |
| `desktop-protocol/ws-authentication.ts` | 135 | JWT/device 校验及认证刷新 |
| `desktop-protocol/ws-contracts.ts` | 168 | WS 帧、会话、依赖端口与连接类型 |
| `desktop-protocol/ws-platform-adapter.ts` | 151 | 共享 Realtime Broker 的 AP namespace consumer |
| `desktop-protocol/ws-server-state.ts` | 41 | 服务器/隧道会话集合及 bind/runtime 状态 |
| `desktop-protocol/ws-server.ts` | 208 | 原生 socket/listener 生命周期与兼容公共入口 |
| `desktop-protocol/ws-session.ts` | 102 | 协议会话绑定、心跳及断开清理 |
| `desktop-protocol/ws-values.ts` | 27 | 协议基本值解析与 session identity |
| `desktop-protocol/ws-wire.ts` | 180 | WS 编解码、upgrade 响应与帧发送 |
| `webs/webapps/runtime-health.ts` | 101 | 端口预留、TCP/HTTP 探针与启动健康等待 |
| `webs/webapps/runtime-launcher.ts` | 62 | launcher context、记录 token 和 monitor 清理 |
| `webs/webapps/runtime-process.ts` | 104 | 子进程日志、平台终止与退出验证 |
| `webs/webapps/runtime-state.ts` | 184 | WebApp 运行状态持久化、默认状态及记录类型 |
| `webs/webapps/runtime.ts` | 722 | WebApp records、启动/停止和健康监测的单一运行时所有者及兼容入口 |

最终上述模块合计 55 个文件、10438 行；最大文件为 `webs/webapps/runtime.ts`（722 行）。1000 行仅为软性建议，未改检查策略。

## 引用与测试调整

- 源码：只重定向 desktop-actions 已有 web-surface、assistant、connector、Kanban、permissions、platform-client 对旧 part 的私有导入。
- 测试：更新 desktop-action-bridge、kanban-action-validation、kanban-auth-wiring（仅动作路径）、enterprise-chat-remote-actions、agent-platform-realtime-ownership、webapp-publish-flow、shutdown-lifecycle（仅 WebApp process 路径）。
- renderer-build：为 A 五个入口追加职责 re-export 读取，保留 B 组 helper；pet 断言读取专属动作文件，不再用下一个无关类型声明作为截断标记。
- `rg` 扫描 `src/ scripts/ test/`：A 五族旧 part 路径引用为 0；A 范围剩余 part 文件为 0。原始 qa 清单未改。

## 验证结果

- `./node_modules/.bin/tsc -p tsconfig.main.json --noEmit`：通过。
- `node scripts/check-main-architecture.mjs`：通过（最后运行时 585 个 source files、20 modules；其他组同时工作，文件数为该次快照）。
- `./node_modules/.bin/tsc -p tsconfig.main.json --outDir /tmp/zenmind-a-verify/dist-electron`：通过。复制 test 到隔离目录、symlink 仓库依赖与只读源码供测试读取，没有写共享 dist-electron。
- `node --test --test-concurrency=1 /tmp/zenmind-a-verify/test/{desktop-action-bridge,desktop-action-diagnostics,desktop-ws-server,desktop-ws-protocol,assistant-navigation-status-client,agent-platform-assistant-bridge,webapp-publication-runtime,kanban-action-validation,enterprise-chat-remote-actions,webs,webapp-publish-flow,webapp-connector}.test.mjs`：最终 **229/229 通过**。首次受 sandbox loopback EPERM 影响，获准使用 require_escalated 后执行；首轮 179 项全过，扩展后 228/229（旧源码读取路径 1 项），更新该路径后最终全集复跑通过。
- `node --test test/kanban-auth-wiring.test.mjs`：1/1 通过。
- `node --test --test-name-pattern="only the physical|Broker consumers|known non-Agent" test/agent-platform-realtime-ownership.test.mjs`：3/3 通过。
- `node --test --test-name-pattern="Windows|WebApp removal" /tmp/zenmind-a-verify/test/shutdown-lifecycle.test.mjs`：3/3 通过，覆盖 Windows graceful taskkill 后存活验证、force cleanup 分支及停止失败禁止删除。macOS 本机 WebApp 运行/停止路径由 webs 功能测试覆盖；没有执行真实 Windows 主机测试。
- `node --test test/renderer-build.test.mjs`：最终 **114/174 通过，60 项失败**，不是全绿。A Desktop Action Bridge 目标 case 通过；此全文件含 renderer、B/C 与其他功能源码正则，未擅自修改范围外实现。
- 三个 renderer 目标用例复跑：Desktop Action Bridge 通过；WebApp dictionary、project ACP dialog 断言失败。realtime ownership 全文件首轮 3/4 通过，shutdown 断言失败；最终仅重跑前三项，没有把它表述为全文件通过。
- `git diff --check`（本组源码和定点测试）：通过。

## 尚存问题与基线证据

没有已知 A 运行行为或类型检查失败。全仓 renderer 源码断言套件仍未全绿，其他 58 项失败未逐项做基线归因，标为范围外待核实。以下三个具体断言已直接读取 `git show 1cb7b804488002fef528bcf6febaced989d5732e:<path>` 并应用相同正则，基线也返回 false：

| 断言 | 基线文件与结果 |
| --- | --- |
| shutdown：preparing 后紧邻 EMPTY_WORK_PANEL_STATE 清理 | `src/renderer/app-shell/AppShell.tsx`：false |
| project ACP：projectType/useAcp 到 sidebar.project.acpProxy 的旧结构 | `src/renderer/app-shell/AppShell.tsx`：false |
| 中文 sidebar.webapp.remove 值为“卸载网站应用” | `src/shared/i18n/dictionaries/zhCN.ts`：false |

这证明上述三个具体正则不匹配并非 A 重构新增；不据此推断全部 60 个 renderer 失败都是基线问题。未改公共架构文档、package.json、生成物、其他组源码或 zenmind/ 未跟踪目录。
