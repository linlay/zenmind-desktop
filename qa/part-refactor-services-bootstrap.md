# B 组：服务与启动 part 重构报告

## 范围与结果

- 原清单中 B 组 **21** 个 part 文件全部删除，其中 19 个含实现、2 个为二次拆分聚合入口。
- 保留 6 个公共入口：`manager/index.ts`、`agent-webclient-host.ts`、`module-registry.ts`、`bootstrap/desktop-init.ts`、`runtime-environment.ts`、`manifest-utils.ts`。
- 从原切片重组为 **72 个职责文件**；按状态所有权、调用阶段和依赖方向划分，未按行数拼接/改名。
- Windows/macOS 分支、服务私有配置所有权、Frame Port 安全策略与 Kanban 原子协议调用均保留。未创建 worktree、切换分支、提交或暂存。
- 只变更组内源码及必要的外部引用和测试；未编辑公共架构文档、原始清单、检查脚本、package.json 或 zenmind/。

## 职责与状态边界

- 服务 manager 的会话状态集中于 `session-state.ts`；安装/部署、状态观察、验证、命令执行、启停、退出与升级通过直接导入协作，避免内部反向依赖公共聚合入口。
- WebClient 的 `hosts` 表与创建/停止逻辑在同一 runtime 模块；配置、静态文件、HTTP/WS 代理和鉴权策略不另建实例表。
- bootstrap 设置、Site 安装、升级备份和一次性应用各有入口。运行环境的 ZIP 校验先于导入/升级写入，保留原来的整体验证和失败语义。
- IPC 注册入口改为按领域装配。每个闭包仍绑定原 options/runtime；没有新增跨域全局 context 或平行状态。
- 本次是内部职责提取，不引入新的跨模块安全/状态机决策；公共设计文档无需新增不变量。

## 原文件到实际职责文件映射

表内列出一个旧切片拆散后实际涉及的所有新文件。二级聚合入口列出其后代实现的最终去向。

| 原文件 | 实际新文件 |
| --- | --- |
| `src/main/app/bootstrap/desktop-init.part-1.ts` | `src/main/app/bootstrap/desktop-init-settings.ts`<br>`src/main/app/bootstrap/desktop-init-sites.ts`<br>`src/main/app/bootstrap/desktop-init-state.ts` |
| `src/main/app/bootstrap/desktop-init.part-2.ts` | `src/main/app/bootstrap/desktop-init-apply.ts`<br>`src/main/app/bootstrap/desktop-init-settings.ts`<br>`src/main/app/bootstrap/desktop-init-state.ts`<br>`src/main/app/bootstrap/desktop-init-testing.ts`<br>`src/main/app/bootstrap/desktop-init-upgrade.ts` |
| `src/main/app/module-registry.part-1.ts` | `src/main/app/ipc-registration-contracts.ts`<br>`src/main/app/realtime-diagnostics.ts` |
| `src/main/app/module-registry.part-2.ts` | `src/main/app/ipc-assistant.ts`<br>`src/main/app/ipc-connected-runtimes.ts`<br>`src/main/app/ipc-platform-frame.ts`<br>`src/main/app/ipc-registration.ts`<br>`src/main/app/ipc-services-market.ts`<br>`src/main/app/ipc-shell-workpanel.ts` |
| `src/main/infrastructure/filesystem/runtime-environment.part-1.ts` | `src/main/infrastructure/filesystem/runtime-env-archive.ts`<br>`src/main/infrastructure/filesystem/runtime-env-contracts.ts`<br>`src/main/infrastructure/filesystem/runtime-env-paths.ts`<br>`src/main/infrastructure/filesystem/runtime-env-seed.ts` |
| `src/main/infrastructure/filesystem/runtime-environment.part-2.ts` | `src/main/infrastructure/filesystem/runtime-env-archive.ts`<br>`src/main/infrastructure/filesystem/runtime-env-bundle.ts`<br>`src/main/infrastructure/filesystem/runtime-env-import.ts`<br>`src/main/infrastructure/filesystem/runtime-env-reset.ts`<br>`src/main/infrastructure/filesystem/runtime-env-upgrade.ts` |
| `src/main/modules/services/agent-webclient-host.part-1.ts` | `src/main/modules/services/webclient-host-config.ts`<br>`src/main/modules/services/webclient-host-policy.ts`<br>`src/main/modules/services/webclient-host-runtime.ts`<br>`src/main/modules/services/webclient-host-types.ts`<br>`src/main/modules/services/webclient-http-utils.ts`<br>`src/main/modules/services/webclient-proxy-auth.ts`<br>`src/main/modules/services/webclient-proxy-policy.ts`<br>`src/main/modules/services/webclient-static-files.ts` |
| `src/main/modules/services/agent-webclient-host.part-2.ts` | `src/main/modules/services/webclient-host-runtime.ts`<br>`src/main/modules/services/webclient-host-testing.ts`<br>`src/main/modules/services/webclient-http-proxy.ts`<br>`src/main/modules/services/webclient-request-handler.ts`<br>`src/main/modules/services/webclient-websocket-proxy.ts` |
| `src/main/modules/services/manager/index.part-1.ts` | `src/main/modules/services/manager/execution-layout.ts`<br>`src/main/modules/services/manager/host-policy.ts`<br>`src/main/modules/services/manager/lifecycle-command-policy.ts`<br>`src/main/modules/services/manager/manager-contracts.ts`<br>`src/main/modules/services/manager/session-state.ts` |
| `src/main/modules/services/manager/index.part-2.ts` | `src/main/modules/services/manager/environment-bindings.ts`<br>`src/main/modules/services/manager/execution-layout.ts`<br>`src/main/modules/services/manager/installation.ts`<br>`src/main/modules/services/manager/lifecycle-command-policy.ts`<br>`src/main/modules/services/manager/manager-contracts.ts`<br>`src/main/modules/services/manager/service-state.ts`<br>`src/main/modules/services/manager/verification-policy.ts` |
| `src/main/modules/services/manager/index.part-3.ts` | `src/main/modules/services/manager/command-environment.ts`<br>`src/main/modules/services/manager/environment-bindings.ts`<br>`src/main/modules/services/manager/lifecycle-command-policy.ts`<br>`src/main/modules/services/manager/manager-contracts.ts`<br>`src/main/modules/services/manager/repair-policy.ts`<br>`src/main/modules/services/manager/startup-options.ts` |
| `src/main/modules/services/manager/index.part-4.part-1.ts` | `src/main/modules/services/manager/configuration.ts`<br>`src/main/modules/services/manager/log-stream.ts`<br>`src/main/modules/services/manager/manager-contracts.ts`<br>`src/main/modules/services/manager/repair-policy.ts`<br>`src/main/modules/services/manager/restore-policy.ts`<br>`src/main/modules/services/manager/service-stop.ts`<br>`src/main/modules/services/manager/shutdown.ts` |
| `src/main/modules/services/manager/index.part-4.part-2.ts` | `src/main/modules/services/manager/capability-requirements.ts`<br>`src/main/modules/services/manager/installation.ts`<br>`src/main/modules/services/manager/verification.ts` |
| `src/main/modules/services/manager/index.part-4.part-3.ts` | `src/main/modules/services/manager/service-command.ts`<br>`src/main/modules/services/manager/verification.ts` |
| `src/main/modules/services/manager/index.part-4.ts` | `src/main/modules/services/manager/capability-requirements.ts`<br>`src/main/modules/services/manager/configuration.ts`<br>`src/main/modules/services/manager/installation.ts`<br>`src/main/modules/services/manager/log-stream.ts`<br>`src/main/modules/services/manager/manager-contracts.ts`<br>`src/main/modules/services/manager/repair-policy.ts`<br>`src/main/modules/services/manager/restore-policy.ts`<br>`src/main/modules/services/manager/service-command.ts`<br>`src/main/modules/services/manager/service-stop.ts`<br>`src/main/modules/services/manager/shutdown.ts`<br>`src/main/modules/services/manager/verification.ts` |
| `src/main/modules/services/manager/index.part-5.part-1.ts` | `src/main/modules/services/manager/runtime-upgrade.ts`<br>`src/main/modules/services/manager/startup-services.ts` |
| `src/main/modules/services/manager/index.part-5.part-2.ts` | `src/main/modules/services/manager/restore-services.ts`<br>`src/main/modules/services/manager/service-start.ts` |
| `src/main/modules/services/manager/index.part-5.ts` | `src/main/modules/services/manager/restore-services.ts`<br>`src/main/modules/services/manager/runtime-upgrade.ts`<br>`src/main/modules/services/manager/service-start.ts`<br>`src/main/modules/services/manager/startup-services.ts` |
| `src/main/modules/services/manager/index.part-6.ts` | `src/main/modules/services/manager/startup-pipeline.ts`<br>`src/main/modules/services/manager/testing.ts` |
| `src/main/support/manifest/manifest-utils.part-1.ts` | `src/main/support/manifest/manifest-plugin-fields.ts`<br>`src/main/support/manifest/manifest-plugin-policy.ts`<br>`src/main/support/manifest/manifest-service-fields.ts`<br>`src/main/support/manifest/manifest-service-policy.ts`<br>`src/main/support/manifest/manifest-types.ts`<br>`src/main/support/manifest/manifest-values.ts` |
| `src/main/support/manifest/manifest-utils.part-2.ts` | `src/main/support/manifest/manifest-capabilities.ts`<br>`src/main/support/manifest/manifest-commands.ts`<br>`src/main/support/manifest/manifest-desktop.ts`<br>`src/main/support/manifest/manifest-hosting.ts`<br>`src/main/support/manifest/manifest-normalize.ts`<br>`src/main/support/manifest/manifest-reader.ts` |

## 最终文件职责与行数

行数包含导入、注释与空行，以本报告生成时源码为准。

| 文件 | 行数 | 职责 |
| --- | ---: | --- |
| `src/main/app/bootstrap/desktop-init-apply.ts` | 141 | 一次性 bootstrap 各段协调、失败保留与完成清理 |
| `src/main/app/bootstrap/desktop-init-settings.ts` | 327 | 按所属领域应用一次性 Desktop 设置与规范化默认值 |
| `src/main/app/bootstrap/desktop-init-sites.ts` | 272 | Website/WebApp seed 整体验证、路径安全和安装 |
| `src/main/app/bootstrap/desktop-init-state.ts` | 212 | bootstrap 类型、JSON/状态持久化、路径和输入基础校验 |
| `src/main/app/bootstrap/desktop-init-testing.ts` | 33 | bootstrap 既有测试入口 |
| `src/main/app/bootstrap/desktop-init-upgrade.ts` | 282 | canonical 配置升级输入验证、备份/恢复与升级应用 |
| `src/main/app/ipc-assistant.ts` | 69 | Assistant 与嵌入 CDP 的 IPC 依赖装配 |
| `src/main/app/ipc-connected-runtimes.ts` | 221 | SSO、企业聊天、Tunnel、Kanban、Web、Pet、设置 IPC 装配 |
| `src/main/app/ipc-platform-frame.ts` | 369 | Canonical Chat、Frame Port、原生文档动作与实时诊断闭包 |
| `src/main/app/ipc-registration-contracts.ts` | 80 | 既有 IPC 装配输入类型与文档版本响应头常量 |
| `src/main/app/ipc-registration.ts` | 16 | 公共注册入口，按原顺序调用领域装配并注册 Help |
| `src/main/app/ipc-services-market.ts` | 220 | 服务操作、环境升级/导入与 Marketplace/plugin 端口装配 |
| `src/main/app/ipc-shell-workpanel.ts` | 137 | Shell、WorkPanel 文档/资源、Artifact 的可信 IPC 依赖装配 |
| `src/main/app/realtime-diagnostics.ts` | 131 | 实时运行时诊断投影与 URL 清洗；供 IPC 和性能诊断复用 |
| `src/main/infrastructure/filesystem/runtime-env-archive.ts` | 205 | ZIP 路径规范化、越界/符号链接防护、版本校验及文件权限 |
| `src/main/infrastructure/filesystem/runtime-env-bundle.ts` | 115 | 已打包 env manifest 发现与完整性校验 |
| `src/main/infrastructure/filesystem/runtime-env-contracts.ts` | 109 | 环境包、导入/还原/升级结果类型与固定布局常量 |
| `src/main/infrastructure/filesystem/runtime-env-import.ts` | 163 | 导入标记、环境解压写入及 bundled import |
| `src/main/infrastructure/filesystem/runtime-env-paths.ts` | 260 | Windows/macOS 运行根、资源候选与桌面版本解析 |
| `src/main/infrastructure/filesystem/runtime-env-reset.ts` | 152 | 旧根冲突、备份隔离、还原失败结果与重建 |
| `src/main/infrastructure/filesystem/runtime-env-seed.ts` | 47 | 初始 env 包与摘要记录的持久化 |
| `src/main/infrastructure/filesystem/runtime-env-upgrade.ts` | 214 | 升级或手工导入 ZIP 的整体验证与 staging |
| `src/main/modules/services/manager/capability-requirements.ts` | 251 | 能力提供者和 HTTP 依赖验证、认证复用、preStart 要求 |
| `src/main/modules/services/manager/command-environment.ts` | 93 | Node 启动上下文和服务命令环境构造，不迁移服务私有配置 |
| `src/main/modules/services/manager/configuration.ts` | 133 | 配置读写、导入文件及插件资源刷新 |
| `src/main/modules/services/manager/environment-bindings.ts` | 96 | 仅按现有边界处理绑定模板、服务端口与插件环境绑定 |
| `src/main/modules/services/manager/execution-layout.ts` | 106 | 布局目录准备、资源签名刷新判断和非核心模板配置准备 |
| `src/main/modules/services/manager/host-policy.ts` | 78 | host-managed 判断、宿主地址与端口参数解析 |
| `src/main/modules/services/manager/installation.ts` | 457 | 内置包安装去重、校验解压、初始化事务和 deploy 能力输入 |
| `src/main/modules/services/manager/lifecycle-command-policy.ts` | 199 | deploy/start/stop 显式参数与目录标志构造，保留平台分支 |
| `src/main/modules/services/manager/log-stream.ts` | 197 | 日志元信息、分页读取、轮询订阅与取消 |
| `src/main/modules/services/manager/manager-contracts.ts` | 127 | 服务编排参数、状态读取/验证选项和固定服务集合；不保存可变运行状态 |
| `src/main/modules/services/manager/repair-policy.ts` | 39 | 缺失核心配置和安装状态的启动修复判定 |
| `src/main/modules/services/manager/restore-policy.ts` | 24 | 资源插件恢复资格和服务选择 |
| `src/main/modules/services/manager/restore-services.ts` | 76 | 恢复上次运行服务的有序编排 |
| `src/main/modules/services/manager/runtime-upgrade.ts` | 285 | 版本升级和手工环境导入的服务事务编排 |
| `src/main/modules/services/manager/service-command.ts` | 100 | 执行前安装校验、生命周期命令执行与状态返回 |
| `src/main/modules/services/manager/service-start.ts` | 271 | 启动、重新初始化、host/resource 分支与重启 |
| `src/main/modules/services/manager/service-state.ts` | 314 | 完整与响应式服务状态读取、先决条件检查与状态列表 |
| `src/main/modules/services/manager/service-stop.ts` | 122 | 正常停服、host/resource 分支与停止验证 |
| `src/main/modules/services/manager/session-state.ts` | 7 | 会话已启动集合、安装并发去重表、后台准备任务集合的唯一实例 |
| `src/main/modules/services/manager/shutdown.ts` | 138 | 退出停服并发协调、超时、运行服务记录与结果汇总 |
| `src/main/modules/services/manager/startup-options.ts` | 23 | 已准备服务的启动读取策略与调度让出 |
| `src/main/modules/services/manager/startup-pipeline.ts` | 198 | 公共准备、登录/Provider 门禁、核心并发启动与最终汇总 |
| `src/main/modules/services/manager/startup-services.ts` | 416 | 逐服务准备、可选服务恢复和后台安装任务管理 |
| `src/main/modules/services/manager/testing.ts` | 146 | 保留 manager 公共 __testInternals 兼容入口 |
| `src/main/modules/services/manager/verification-policy.ts` | 135 | 健康结果投影、依赖验证条件与超时选择 |
| `src/main/modules/services/manager/verification.ts` | 185 | 单轮健康采集、限时重试以及命令结果附加验证 |
| `src/main/modules/services/webclient-host-config.ts` | 141 | manifest hosting、目录、环境路由目标与运行配置脚本 |
| `src/main/modules/services/webclient-host-policy.ts` | 39 | 回环绑定、开发 CORS 常量与禁止 HTTP/WS 绕过 Frame Port 的路径策略 |
| `src/main/modules/services/webclient-host-runtime.ts` | 117 | hosts 实例表与 host start/stop/state 生命周期唯一所有者 |
| `src/main/modules/services/webclient-host-testing.ts` | 13 | 保留宿主公共 __testInternals 兼容入口 |
| `src/main/modules/services/webclient-host-types.ts` | 47 | 宿主配置、实例记录、token 回调及资源解析类型 |
| `src/main/modules/services/webclient-http-proxy.ts` | 87 | HTTP 代理请求、鉴权刷新重试与响应流转发 |
| `src/main/modules/services/webclient-http-utils.ts` | 62 | 请求 URL/header、CORS 和 JSON/代理错误响应 |
| `src/main/modules/services/webclient-proxy-auth.ts` | 199 | HTTP/WS token 获取刷新、鉴权失败与禁用响应 |
| `src/main/modules/services/webclient-proxy-policy.ts` | 72 | 代理路径匹配、上游 URL/header、SSE 请求策略 |
| `src/main/modules/services/webclient-request-handler.ts` | 105 | 按来源与路径选择静态响应、HTTP 或升级代理 |
| `src/main/modules/services/webclient-static-files.ts` | 111 | SPA/静态路径安全解析、MIME 与文件响应 |
| `src/main/modules/services/webclient-websocket-proxy.ts` | 123 | WebSocket 升级请求与 TCP/TLS 上游连接 |
| `src/main/support/manifest/manifest-capabilities.ts` | 136 | env bindings、能力提供者与要求规范化 |
| `src/main/support/manifest/manifest-commands.ts` | 27 | 可执行入口与 manifest command 解析 |
| `src/main/support/manifest/manifest-desktop.ts` | 62 | desktop 部分规范化及服务形态约束 |
| `src/main/support/manifest/manifest-hosting.ts` | 175 | desktop hosting/proxy routes 与 WebClient Frame Port hosting 校验 |
| `src/main/support/manifest/manifest-normalize.ts` | 79 | 将各字段规范化器组合成 ServiceDefinition |
| `src/main/support/manifest/manifest-plugin-fields.ts` | 253 | 插件 bridge/hooks/resources/settings 与 desktop actions |
| `src/main/support/manifest/manifest-plugin-policy.ts` | 25 | 插件旧 manifest 字段拒绝策略 |
| `src/main/support/manifest/manifest-reader.ts` | 25 | manifest 文件/归档读取与定位 |
| `src/main/support/manifest/manifest-service-fields.ts` | 181 | 服务形态、前后端、脚本、配置和 runtime 字段规范化 |
| `src/main/support/manifest/manifest-service-policy.ts` | 118 | 核心服务端口覆盖与测试端口基准策略 |
| `src/main/support/manifest/manifest-types.ts` | 88 | 服务定义、导入目标与 manifest 规范化选项 |
| `src/main/support/manifest/manifest-values.ts` | 67 | 不依赖业务的输入值读取和小型路径/响应复制 |

## 行为与引用验证

- 使用 TypeScript printer 去掉注释后的 AST 对照原切片：**415 个顶层声明全部一致**（排除专门重新组织的 `registerMainIpcHandlers`）。
- IPC 原 34 条顶层装配语句中，4 条为公共局部绑定；剩余 30 条有 29 条在新职责函数中原样且仅出现一次。Help 注册只将局部 `ipcMain/app` 改成 `options.ipcMain/options.app`，注册顺序不变。
- `performance-diagnostics.ts` 改为依赖 `realtime-diagnostics.ts`；`runtime-environment-provider-register.ts` 改为直接依赖 `runtime-env-paths.ts` 与 contracts，避免经过 barrel 产生依赖环。
- 更新服务验证测试的 state/policy/verification mock 目标、IPC 源码测试读取路径、WebClient 源码族读取以及 renderer-build 的 B 组入口映射。原兼容 ZIP 名称白名单跟随实际代码移至 runtime-env-archive.ts。
- `rg -n "(index\.part-|agent-webclient-host\.part-|module-registry\.part-|desktop-init\.part-|runtime-environment\.part-|manifest-utils\.part-)" src scripts test`：**零匹配**。
- B 组负责目录 `rg --files ... | rg part-`：**零文件**。

## 验证命令与结果

- `npx tsc -p tsconfig.main.json --noEmit`：通过。
- `node scripts/check-main-architecture.mjs`：通过；本轮检查 585 个源文件、20 个模块，无依赖环或边界违规。
- `npx tsc -p tsconfig.main.json --outDir /tmp/zenmind-b-validation/dist-electron`：通过，未读写共享 dist-electron 构建输出。
- 隔离测试目录通过链接已有 src/build/node_modules 读取资源；未运行 brand:sync 或重新生成共享资源。
- 13 套功能测试最终结果：**266 tests / 263 pass / 3 skipped / 0 fail**，耗时 166.7 秒。
- 执行方式：`node --test --test-concurrency=1 /tmp/zenmind-b-validation/test/{service-manager,service-verification,service-config-upgrade,desktop-init-bootstrap,agent-webclient-host-v2,agent-webclient-bridge-v2-manifest,user-paths,performance-diagnostics,service-refresh-decoupling,agent-webclient-auth-injection,agent-realtime-inspector,kanban-auth-wiring,env-bootstrap}.test.mjs`。
- 覆盖包含安装部署/启停/并发启动/退出、每轮 token 复用、手工导入与版本事务、bootstrap 设置/Site 安全、manifest、Frame Port HTTP 绕过阻断、静态宿主、用户路径与性能诊断。
- 3 项跳过均由测试自身的平台条件触发：Windows UI 响应式状态读取、非 ASCII PowerShell 脚本路径、非 ASCII PowerShell 参数；本机未实际执行这三项 Windows 原生用例。
- renderer-build 中引用 B 入口的 7 项源码测试：**2 通过、5 失败**。B 路径白名单已定点迁移后重新运行，结果不变；未将类型/架构通过等同于全部测试通过。
- 基线证据：用 `git archive HEAD src test scripts package.json` 将 **`1cb7b804488002fef528bcf6febaced989d5732e`** 导出到 `/tmp/zenmind-b-head-baseline`，在该目录以相同 `--test-name-pattern` 运行原始 `test/renderer-build.test.mjs`；结果也是 **2 通过、5 失败**，五项在相同断言处失败：

| 源码测试 | 当前与 HEAD 基线共同失败点 |
| --- | --- |
| public source keeps ZenMind literals out of shared paths except brand-specific defaults | 全局已有品牌字面量；B 的 ZIP 兼容名称已随职责提取迁移白名单 |
| sidebar translucency is fixed and not user configurable | macSidebarRule 的 `background: transparent` 断言 |
| Kanban route exposes native desktop api and page styles | `ReferenceError: zhCN is not defined` |
| website Copilot association is exposed across webs desktop api layers | `requestNavigate(buildSettingsSectionPath("websites"))` 旧形式匹配 |
| assistant navigation agents are exposed through dedicated ipc without changing pet agents | AppSidebar 的 Coder ACP checkbox UI 源码匹配 |

- 验证日志：功能测试 `/tmp/services-refactor-tests-unrestricted.log`；当前源码测试 `/tmp/services-renderer-tests-final.log`；HEAD 基线 `/tmp/services-renderer-head-baseline.log`。

## 未解决问题与验证限制

- 功能测试最初在沙箱中因回环监听 EPERM 和进程树权限失败，已通过自动审批在同一隔离输出下复跑；最终计数见上。
- 本机实际运行平台是 macOS；测试覆盖 Windows 显式分支和模拟平台条件，不代表执行过 Windows 安装器/Electron 手工回归。
- 当前源码无 B 组未解决类型或架构错误。额外 renderer 源码断言失败已通知源任务汇总。
