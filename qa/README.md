# Desktop 验收入口

`qa/` 保留与当前源码匹配的回归清单、可执行验收脚本和可复用夹具。架构与长期边界见 [设计文档](../docs/README.md)，精确行为见 `src/`、`contracts/` 和 `test/`。

| 范围 | 入口 |
| --- | --- |
| 发布工作流与平台差异 | [手工回归清单](manual-regression.md) |
| 外观、皮肤与 WebClient 外观桥 | [外观验收](desktop-appearance.md)；`npm run test:appearance`、`npm run test:skin-visuals`、`npm run test:webclient-appearance` |
| 皮肤包与图片夹具 | [皮肤包制作](skin-packages/README.md)、[背景素材](assets/alpine-lake.md)；`npm run build:skin-example`、`npm run build:skin-bow-example` |
| 更新签名与双平台交付 | [更新验收](updates/README.md) |
| 性能与首装诊断 | [Windows / macOS 对照采集](windows-performance.md) |
| Desktop / Platform 连接器联调 | [真实接口验收](connector-platform-bridge.md)；`test/connector-platform-bridge.test.mjs` 与 `test/fixtures/platform-connector-bridge.go` |
| WebApp execute 连接池与长请求 | 构建 Main 后运行 `npx electron qa/webapp-execute-electron-smoke.cjs --hold-ms 310000`；真实 Chromium 页面、受管 electron-node 后端和 Broker WS v2 夹具；额外加 `--verify-timeout` 实际等待十分钟并验证两种入口的 assistant_timeout、精确 interrupt 与连接回收。结果输出至 build/qa/webapp-execute-electron.json，十分钟结果单独输出为 webapp-execute-electron-timeout.json |
| 浏览器观察性能 | `BROWSER_USE_TEST_CHROME_FOR_TESTING=/path/to/chrome node qa/browser-use-observation-benchmark.mjs --samples=5 --warmups=1`；官方扩展隔离 profile，分别记录 0/32/128/256 控件的观察和动作后观察指标，结果不包含页面内容或授权码 |
| Provider 环境交付 | [登记样例](provider-registration/README.md) |
| 网站桥制作与加载 | [桥包验收](website-bridge-package.md)、`website-bridges-smoke.mjs` |
| 网站密码与登录采集 | `website-credentials-smoke.mjs`、`website-credentials-capture-smoke.mjs` |
| 设置、能力导航与资料库 | `web-settings-smoke.mjs`、`capability-navigation-smoke.mjs`、`library-smoke.mjs`（旧 `artifact-management-smoke.mjs` 转到此入口） |
| WorkPanel 与本地文档 | `work-panel-browser-smoke.cjs`、`work-panel-browser-smoke.mjs`、`work-panel-local-document-smoke.mjs`、`local-document-open-native-smoke.cjs`；新标签与 WebApp 显示切换运行 `work-panel-new-tab-webapp-smoke.mjs`，验证真实 guest 保留、输入命中、草稿及跨 Chat/面板切换 |
| 窗口与原生平台交互 | `work-panel-fullscreen-smoke.mjs`、`work-panel-main-chat-tab-smoke.mjs`（拖满后固定对话页签、原 Chat guest/草稿/滚动保留与分栏恢复）、`windows-fullscreen-smoke.cjs`、`mac-application-menu-smoke.cjs`、`screenshot-native-macos.mjs` |
| ACP Codex 产品链路 | `acp-plugin-import-smoke.cjs`（Electron Node 模式）；`ACP_LIVE_AUTH=1` 允许隔离复用登录态和真实对话，`ACP_UI=1` 验证实际 WebClient 组件，`ACP_CHAT_UI=1` 验证完整 WebClient `/agent/:key` 聊天页，`ACP_LIVE_INTERACTIONS=1` 验证 HTTP/SSE 提问及取消；先构建主进程类型与 Codex 包，依赖相邻 Platform/WebClient 源码。该入口仅覆盖 macOS；完整 WebClient 页使用 Standalone HTTP/WS 传输，Desktop Frame Port Broker 使用下述主壳入口，Windows 单列验收。 |
| 插件、连接器、企业聊天与 WebApp | 对应的 `*-smoke.cjs` / `*-smoke.mjs`，按脚本依赖准备构建产物 |

从仓库根目录运行命令。独立 `.mjs` 入口使用 `node qa/<文件名>.mjs`，直接使用 Electron 的 `.cjs` 入口使用 `npx electron qa/<文件名>.cjs`；`*-checks.cjs` 是配套 runner，由对应 `.mjs` 设置夹具和环境后启动。需要 `dist-electron` 或 renderer 发布资源的脚本先按对应说明构建；不要把浏览器预览或 Windows CSS 模拟当作原生 Windows 验收。

维护时按实际有效性判断：保留仍有源码、契约、测试或执行入口支撑的材料；删除已完成改造的阶段报告、失效方案与脱离当前契约的演示副本。截图、日志和测试通过率属于当次执行证据，输出到临时目录或忽略的构建目录；历史材料从 Git 查询，不在此目录另建归档。

ACP-012 完整聊天 UI 先在 `agent-webclient` 用现有 Webpack 构建，不替换生产入口：

```sh
./node_modules/.bin/webpack --mode production --output-path "$PWD/../zenmind-desktop/build/qa/acp-product/webclient"
```

然后在 Desktop 执行 `ACP_CHAT_UI=1 ACP_LIVE_AUTH=1 ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron qa/acp-plugin-import-smoke.cjs`。该模式打开真实聊天页，通过 Composer 和审批按钮操作；API 只辅助准备和断言结果。完整页与隔离组件模式分开运行，当前通过条件及待填写报告见 [ACP 手工标准](acp-acceptance.md)；历史实验日志不替代候选包验收。


ACP-012 Desktop 主壳入口：先从当前源码生成 Platform/WebClient 的 macOS arm64 release，并用现有 `sync:assets` 同步核心服务，再执行 Desktop 的 `build:main:prepared` 和 `build:renderer:prepared`。准备 Codex `0.1.0/darwin-arm64` 插件 ZIP、本地 Codex 登录态及 `127.0.0.1:7890` 代理后，在 Desktop 仓库运行：

```sh
ACP_LIVE_AUTH=1 node qa/acp-desktop-shell-smoke.cjs
```

此入口创建隔离 home，并在忽略的构建目录复制、临时签名 Electron；通过真实主进程、preload、renderer 和受管服务验证本地插件导入、目录同步、创建项目、两轮聊天及正常服务重启后的 Broker 重连。仅原生文件选择器使用固定 ZIP/目录输入，实际对话消耗已有账户配额。隔离 profile 在退出时删除；截图、请求类型和通过标记保存在 `build/qa/acp-product/shell-*`。它不代替活动 Run 异常断连、新账号 OAuth、市场下载或 Windows 原生验收。


在主壳命令前增加 `ACP_DISCONNECT=1`，会在真实 Codex 文件审批等待中通过本地 TCP 转发器中断主 lane 3 秒，验证原 Run/游标重新 attach、审批和草稿保持、批准后文件内容与终态唯一、Query 不自动重发。转发器不记录认证 URL 或请求正文；证据为 `shell-disconnect.*`。此场景验证网络闪断，不替代 Platform/Adapter 强杀。普通产品链路入口现在连续执行两次认证，每次必须由新进程复核成功，之后继续 Query 和进程重启恢复。

重复认证推荐使用 `ACP_BROWSER_AUTH=1 ACP_LIVE_AUTH=1 ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron qa/acp-plugin-import-smoke.cjs`：从空 profile 由用户完成一次浏览器登录，再在同一 profile 内重复认证及恢复。不会复制本地刷新令牌；避免将不同副本的刷新结果误认为宿主死锁。已有登录态复制模式仍用于此前明确授权的场景，不能替代独立登录验收。

ACP-014 Platform 强杀产品验收：运行 `ACP_PLATFORM_KILL=1 ACP_LIVE_AUTH=1 ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron qa/acp-plugin-import-smoke.cjs`。沿用真实 ZIP 安装与 Go App HTTP 宿主，在真实 `request_user_input` 等待中强杀该隔离宿主（PID 来自 QA 启动实例），检查所有已记录的子进程退出、重启后唯一终态、迟到回答 409，以及显式下一轮记忆标记恢复。该模式复用已准备成功的隔离登录态，不重复登录；模型 HTTP 等待为 300 秒，生产期限不变。`platform-kill.json` 只记录收尾子阶段；完整命令退出 0 才代表后续模型恢复也通过。它不替代 Desktop 主壳 Frame Port/UI 或 Windows 原生验收。原测试模式、产品 UI 和外部协议不变。


ACP-014 主壳强杀：`ACP_PLATFORM_KILL=1 ACP_LIVE_AUTH=1 node qa/acp-desktop-shell-smoke.cjs`。沿用真实 Electron/主壳/Frame Port/Broker 与 release Platform，在文件审批等待中 SIGKILL 本次隔离实例；检查整树退出、唯一终态、旧审批 409、文件不写入、草稿保留、显式下一轮恢复首轮记忆、4 次显式 Query 且不自动重发。该模式与 `ACP_DISCONNECT` 分开运行。固定代理通过现有 services.writeConfig 在安装启用前写入服务所属 runtime 配置并重启；候选预检已提前到启用阶段，不能等项目创建后才设置。引擎同步须 applied 且创建项 available，不能只检查目录包含 engineId。会话配置已失效时通过原准备按钮刷新并显式重试尚未发送的草稿，最多一次；不重发已提交 Query。证据为 `shell-platform-kill.json/png` 和完整命令退出码；失败不推导后续阶段通过。草稿须在审批出现前写入 #message-input；审批会替换 Composer，不能把隐藏测量 textarea 当作输入框。终态恢复后再检查真实草稿。

ACP-014 真实跨版本：`ACP_UPGRADE_ARCHIVE=<绝对 ZIP 路径> ACP_LIVE_AUTH=1 ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron qa/acp-plugin-import-smoke.cjs`。与 `ACP_PLATFORM_KILL` 互斥。在提问 HITL 时安装候选，验证旧快照/绑定保留，提交原问题后旧 Run 排空并回收旧快照；新版 prepare 后显式模型恢复随机记忆，session/profile 保留、历史不重复。可选文本备注不当作必答选项。失败先取消本测试 Run 再关闭宿主，清理隔离登录态。`cross-version.json` 记录摘要和断言，不含认证材料；完整命令退出 0 才算通过。已实测 CLI 0.164.0→0.165.0，Adapter 2.3.0 不变；候选的源码锁和 ZIP 保存在 `build/qa/acp014/codex-0.1.1-candidate`，不修改生产插件版本。


ACP-013 Claude 主壳：沿用同一入口与 release 构建准备，在 Desktop 执行：

```bash
ACP_ENGINE=claude ACP_CLAUDE_INTERACTIONS=1 ACP_LIVE_AUTH=1 node qa/acp-desktop-shell-smoke.cjs
```

使用独立 Claude 0.1.0 ZIP、现有本机 `~/.claude/settings.json` 中已授权的网关认证；只复制 `env` 中 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 到隔离产品 profile，不复制 hooks/MCP/历史。退出删除该 profile。固定代理仍通过服务配置设置。

真实 UI 选择 Haiku 后验证首轮、正常 Platform 重启、Write 单次批准/同文件下一轮拒绝、待审批刷新、AskUserQuestion（可选备注留空）、Stop、工具后重启并显式询问首轮记忆，以及冷回放/七次 Query 无自动重发。断言只通过公共 Chat 读取和隔离工作区文件辅助检查，不伪造模型回答或审批。完整退出 0 才代表全部步骤通过；事件与截图在 `build/qa/acp013`，日志建议重定向到同目录。默认入口仍为 Codex；Claude 工具/认证场景与强杀场景分开运行；`ACP_DISCONNECT` 暂为 Codex 专用。

现有网关配置复用不等于新认证 UI、直连 Anthropic API key 或订阅登录已通过；Windows、Claude 跨版本和双插件活动隔离另列门禁，见 [ACP 手工标准](acp-acceptance.md) 的认证和生命周期章节。


ACP-013 现有网关配置复用回归（不启动浏览器登录）：

```bash
ACP_ENGINE=claude ACP_CLAUDE_AUTH=1 ACP_LIVE_AUTH=1 node qa/acp-desktop-shell-smoke.cjs
```

先以空 profile 检查 prepare 不误报 authenticated、显式 Query 认证失败后原认证按钮可见且不能发送；再按已有白名单配置隔离 profile，正常重启后完成两轮。随后只删除本次测试 profile 的 settings.json，重启并验证凭据缺失的失败与认证状态，恢复已授权配置再显式续问。安装/配置写入仅为隔离测试准备，不能作为新用户产品录入入口；本机原配置始终不改写。记录真实 Query 数，禁止重放失败 prompt；不要与 ACP_CLAUDE_INTERACTIONS 同跑。

增加 `ACP_CLAUDE_INVALID_TOKEN=1` 时，用虚构无效 Token 替代删除配置，目标仍为已授权网关。该场景另行记录，60 秒内未收尾就是未通过（仅 QA 观察期限，不修改生产 Run 超时），不能用缺失配置通过替代无效 Token 通过。本次候选结果与限制按 [ACP 手工标准](acp-acceptance.md) 记录；截图/事件在 build/qa/acp013，认证值不进入输出。


ACP-014 Claude 活动会话强杀与记忆恢复（macOS，复用上述既有网关配置）：

```bash
ACP_ENGINE=claude ACP_PLATFORM_KILL=1 ACP_LIVE_AUTH=1 node qa/acp-desktop-shell-smoke.cjs
```

复用同一主壳脚本和强杀分支。Claude 保持原 Manual 模式，要求 Write 单次审批；首轮发送随机标记，审批等待时只对隔离 Platform 执行 SIGKILL。断言所属进程树退出、文件未写、旧 Run 唯一终态、迟到提交 409、原草稿保留；再通过原准备/发送入口显式续问，正确回答首轮标记，4 次 Query 无重发。与 Claude 认证/完整工具七轮分别运行。`build/qa/acp-product/shell-platform-kill.json` 记录 engine，事件与截图在同目录；阶段证据归档到 `build/qa/acp014/`，只以完整命令退出 0 计通过。Windows、登录辅助或后台子任务、跨版本不由此覆盖。


ACP-014 Claude 活动升级与跨版本恢复：

```bash
ACP_ENGINE=claude ACP_UPGRADE_ARCHIVE=/absolute/path/to/candidate.zip ACP_LIVE_AUTH=1 node qa/acp-desktop-shell-smoke.cjs
```

候选必须来自原插件构建流程，具有不同插件版本、真实锁定的 SDK/CLI 和可核对摘要；不以改版本标签替代跨版本验收。脚本在真实 Write 审批等待期间经原插件导入 UI 安装候选，确认 Platform PID 不变、旧 binding/快照/审批保持；批准后旧 Run 完成、文件正确、旧快照回收。随后显式下一轮检查原 session/profile、模型及模式选择、随机记忆和刚写入文件的上下文，恰好 4 次 Query。与强杀、网络闪断、Claude 认证及七轮工具场景分开运行。结果写入 `build/qa/acp-product/shell-upgrade.json`、事件和截图；完整退出 0 后归档到 `build/qa/acp014/`，不能以导入成功代替恢复通过。

ACP-014 双插件活动隔离（两个方向分别执行，不能并行占用同一主壳资源）：

```bash
ACP_ENGINE=claude ACP_ISOLATION_ARCHIVE=/absolute/path/to/codex-0.1.1.zip ACP_LIVE_AUTH=1 node qa/acp-desktop-shell-smoke.cjs
ACP_ENGINE=codex ACP_ISOLATION_ARCHIVE=/absolute/path/to/claude-0.1.1.zip ACP_LIVE_AUTH=1 node qa/acp-desktop-shell-smoke.cjs
```

`ACP_ENGINE` 指保持活动审批的插件，`ACP_ISOLATION_ARCHIVE` 必须是另一插件的真实 0.1.1 候选包。使用已有 0.1.0 发布资产和上述升级候选；不修改正式依赖。主壳首先完成随机记忆和正常重启后的两轮聊天，第三轮等待真实文件审批；此时通过原导入 UI 安装/升级另一插件，再通过原 preload 服务禁用、插件卸载接口执行生命周期操作（不声称点击了禁用/卸载按钮）。卸载确认框以测试输入选择 Uninstall，并校验插件名称和按钮；真实安装/撤销/删除/同步代码仍执行，不把固定确认结果当作原生 UI 自动化。每步检查 Platform 和受保护 Adapter PID、目录条目、绑定/配置、凭据文件、快照与 awaitingId 不变，未提前产生终态或写文件。最后返回原聊天批准，验证文件写入及下一轮随机记忆，4 次显式 Query / 4 complete，无自动重发。

真实场景中被操作插件已启用但没有模型 Run；双插件同时执行的排空隔离由 Platform 原 session 测试文件中的 `TestPluginLifecyclePreservesOtherActiveSession` 覆盖，不能将其称为双真实模型并发验收。主壳输出 `build/qa/acp-product/shell-isolation.json`、events、png、frames；每个方向完整退出 0 后归档，避免下一次运行覆盖。Windows、认证/后台任务与容量竞争另列待测。

ACP-014 真实双插件活动禁用/卸载排空：

```bash
ACP_ENGINE=codex ACP_ACTIVE_DRAIN=complete ACP_LIVE_AUTH=1 node qa/acp-desktop-shell-smoke.cjs
ACP_ENGINE=codex ACP_ACTIVE_DRAIN=cancel ACP_LIVE_AUTH=1 node qa/acp-desktop-shell-smoke.cjs
# 交换方向时将 ACP_ENGINE 改为 claude；完整通过组合以验收记录为准。
```

`ACP_ENGINE` 指受保护的主壳聊天，另一插件是被禁用/卸载的目标。先让主壳聊天进入真实文件审批，再经原导入 UI 安装另一插件；通过原公共 HTTP 创建其独立项目/会话、配置并发起真实 Query。两端均等待审批后，调用原 preload 禁用/卸载接口；禁用后新 prepare 必须拒绝，首次卸载必须 engine_busy 且程序、租约快照、进程、待审批保留。complete 模式批准目标；cancel 模式通过原 interrupt 控制接口取消，断言唯一 run.cancel、文件不写、迟到批准拒绝（等待执行者已清理且无提交回执时为 400 unknown_awaiting，已有终态记录时为 409）。随后回收进程/快照，显式重试卸载成功，Chat/profile 保留；另一端始终不变，随后由原聊天 UI 批准并验证下一轮记忆。

原生文件选择和卸载确认是测试输入，真实 IPC/同步/协议/模型/文件操作均执行；目标聊天通过 HTTP 控制，不声称两个主壳 Primary 流并行。只复用已授权登录到隔离 profile；不修改个人配置。结果保存到 `build/qa/acp-product/shell-active-drain.json`、events、png 和 frames，完整退出 0 后按目标/完成方式归档到 `build/qa/acp014/`。不同场景顺序执行，不能并行占用同一主壳和服务端口；Windows、登录辅助/后台任务另列门禁。

ACP-014 后台工具任务与子进程排空：

```bash
ACP_ENGINE=codex ACP_ACTIVE_DRAIN=complete ACP_BACKGROUND_DRAIN=1 ACP_LIVE_AUTH=1 node qa/acp-desktop-shell-smoke.cjs
# cancel 验证显式取消；ACP_ENGINE=claude 交换目标/保护端。
```

复用上面的双活动排空链路。目标通过真实 Claude Bash `run_in_background`（用可用任务输出监视）/ Codex ACP terminal 长命令启动隔离 Shell worker 和子进程，继续等待工具结束；只有 QA 控制器释放完成门闩。禁用和 engine_busy 后验证两个进程仍存活、心跳继续，程序/快照不被回收；完成或取消后要求所有记录的进程退出、测试所属输出监视无残留、快照回收、卸载重试成功，保护端原审批和记忆不变。Codex 以公共 tool.snapshot 调用参数及同 toolId 结果配对验收，不依赖 CLI 私有 transcript；取消结果不要求成功结果的 terminal 内容。脚本有 240 秒自退出上限，不执行个人项目或修改个人配置。当前组合与边界按 [ACP 手工标准](acp-acceptance.md) 记录；不把受控协议/普通进程组测试当作真实 CLI 后台模式验收。跨 Run 后台任务和 Windows 单列待测；真实后台 Platform/Adapter 强杀入口见下节。


ACP-014 真实后台工具期间强杀：

```bash
ACP_ENGINE=claude ACP_BACKGROUND_KILL=platform ACP_LIVE_AUTH=1 node qa/acp-desktop-shell-smoke.cjs
# ACP_ENGINE=codex 交换引擎；ACP_BACKGROUND_KILL=adapter 强杀 Adapter。
```

沿用同一隔离主壳入口，先完成随机记忆和正常重启，再从真实 Composer 启动后台 Shell worker/子进程，通过公开 Chat 的 includeRawMessages 核对工具回执与持续心跳。禁用并尝试卸载须返回 engine_busy、保留快照；只对本次隔离 Platform 或其 Adapter PID 发送 SIGKILL，检查所有已记录后代（含 guardian、CLI、后台工作与输出监视）退出后才回收快照。Platform 分支通过原服务入口重启，Adapter 分支要求 Platform PID 不变；旧 Run 必须唯一失败/取消，无待审批。重新启用原插件后只显式发送一次续问，验证 session/profile/配置和首轮随机记忆恢复，4 次 Query 无重发。任务有 300 秒自退出上限，强杀须在心跳活动期间执行。

四组合顺序执行，分别归档 `shell-background-kill-start.json`、`shell-background-kill.json`、events、png、frames 和完整退出日志；输出默认仍在 `build/qa/acp-product/`，下一轮会清除上轮同模式结果。只声明完整退出 0 的组合通过，退出后另核对所属进程与隔离凭据清理。此模式与其他强杀/升级/排空/认证场景互斥，不覆盖独立 LLM 子 Agent、跨 Run 后台任务、认证辅助、宿主与 guardian 同时强杀或 Windows。实际结果以工作区生命周期验收记录为准。


ACP-014 双插件同时活动升级与跨版本隔离：

```bash
ACP_ENGINE=codex ACP_ACTIVE_UPGRADE_ARCHIVE=<Claude 新版候选 ZIP> ACP_LIVE_AUTH=1 node qa/acp-desktop-shell-smoke.cjs
# 反向用 ACP_ENGINE=claude，传入 Codex 新版候选 ZIP。
```

复用双活动排空的安装、独立 profile、公共 HTTP 与保护端主壳流程。`ACP_ENGINE` 是保持活动的保护端，ZIP 是另一插件的新版；与卸载排空、后台强杀、单插件升级等模式互斥。两端真实文件审批均待决时通过原导入 UI 升级目标；旧 Run 的绑定、PID、审批和快照须保留，Platform 不重启。批准目标旧 Run 后，旧进程退出和快照回收；新版 prepare 恢复同 session/profile/配置，显式下一轮回答前一轮的随机标记及刚写文件的名称/内容。整个期间保护端 Run/审批/绑定/配置/凭据/进程不变，最后由原主壳审批完成并验证其随机记忆。

完整退出 0 的结果为保护端 4 Query / 4 complete、升级端 2 Query / 2 complete，无自动重发；目标通过公共 HTTP 发送，不宣称两个主壳 Primary 并行。证据为 `shell-active-upgrade.json`、events、png、frames，按方向归档后再跑下一组；退出后另核对所属进程和隔离凭据清理。候选必须由当前 API 2 源码和精确依赖锁构建、确认真实 CLI 版本，不能用只改版本号的 ZIP 替代跨版本证据；正式锁、版本和发行状态不变。macOS 固定版本对的通过结果不替代 Windows、其他 Adapter 组合、认证、后台/跨 Run 子任务或容量验收。

ACP-014 共享 Node 更新前的双插件排空：

```bash
ACP_ENGINE=codex ACP_NODE_UPDATE=1 ACP_LIVE_AUTH=1 node qa/acp-desktop-shell-smoke.cjs
# ACP_ENGINE=claude 交换最后完成审批的引擎。
```

复用双活动文件审批流程，通过主进程公开的引擎同步入口执行正式升级排空门禁。两端活动、仅剩保护端活动时均须 updateBusy，Node marker、Platform PID、审批、profile 和原进程保持；全部完成后才允许退出准备，并要求新 prepare 被拒绝、重连不能重新启用、旧进程退出。随后验证门禁回滚、原服务重启和显式下一轮记忆，目标配置/session/profile 保持。每组 1+4 Query，无自动重发。此 QA 不执行签名 Desktop 安装器、不替换 Electron，也不宣称实际跨 Node 的完整产品升级通过。Node 22.22.0→24.19.0 的真实二进制发布由既有 embedded-node-runtime 测试单独验证。不同 Node 的签名安装包及原生 Windows 另列待测。

证据为 `shell-node-update.json`、events、png、frames 和完整退出日志；顺序执行并分别归档。与双活动升级相同，返回主壳后通过原审批按钮的一次原生鼠标点击提交，要求仅一条 submit。若失败须定位交互链路，不改用 HTTP 提交绕过 UI。正式更新入口的忙碌拒绝、清理失败恢复和成功时序由原 desktop-update-installers 测试覆盖，管理确认丢失/离线由原 plugin-agent-engines 测试覆盖。

当前 ACP 的长期验收条件和填写模板归本仓库 [ACP 手工标准](acp-acceptance.md)；上述命令及候选路径包含历史组合，执行前以实际 Manifest/构建输出为准，不按旧版本号重建发布结论。
