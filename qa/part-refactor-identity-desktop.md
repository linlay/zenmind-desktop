# C 组：身份、看板与桌面交互 part 重构报告

## 结果

- 范围内 **23 个原 part 文件全部移除**，重新归并为 **86 个职责模块**；8 个原公共入口继续兼容。
- 保留原地工作目录及当前分支；未提交、未暂存、未写公共生成物或共享 dist-electron。
- 原始 718 个顶层声明与新模块逐项文本比对：718 项一致，0 项缺失；新增导出仅为拆分后内部类型引用所需。
- 同一职责跨旧切片重新归并：SSO 会话/claims/授权/回调、Kanban 云快照和运行回执、桌宠设置/布局/状态、市场安装记录与 HTTP 等均不是逐文件机械改名。
- 单一状态所有者保留：SSO runtime state、SSO controller、Kanban socket、拖拽和窗口控制器不拆散闭包状态；内部依赖直接指向职责模块，外部仍通过领域公共入口。
- 最大新模块为 ws-connection.ts（820 行）；1000 行仅软建议，没有恢复硬限制。

## 原文件到实际模块的映射

路径均相对仓库根。一个旧文件跨多个职责模块时完整列出。

| 原文件 | 原行数 | 实际目标文件 |
| --- | ---: | --- |
| `src/main/modules/identity/oidc-sso.part-1.ts` | 714 | `src/main/modules/identity/sso-model.ts`<br>`src/main/modules/identity/sso-state.ts`<br>`src/main/modules/identity/sso-defaults.ts`<br>`src/main/modules/identity/sso-paths.ts`<br>`src/main/modules/identity/sso-config-values.ts` |
| `src/main/modules/identity/oidc-sso.part-2.ts` | 704 | `src/main/modules/identity/sso-config.ts` |
| `src/main/modules/identity/oidc-sso.part-3.ts` | 764 | `src/main/modules/identity/sso-config.ts`<br>`src/main/modules/identity/sso-session.ts`<br>`src/main/modules/identity/sso-http.ts`<br>`src/main/modules/identity/sso-claims.ts`<br>`src/main/modules/identity/sso-callback-page.ts`<br>`src/main/modules/identity/sso-authorization.ts`<br>`src/main/modules/identity/sso-proxy-urls.ts` |
| `src/main/modules/identity/oidc-sso.part-4.ts` | 699 | `src/main/modules/identity/sso-http.ts`<br>`src/main/modules/identity/sso-claims.ts`<br>`src/main/modules/identity/sso-authorization.ts`<br>`src/main/modules/identity/sso-proxy.ts`<br>`src/main/modules/identity/sso-cookie-token.ts`<br>`src/main/modules/identity/sso-callback-params.ts` |
| `src/main/modules/identity/oidc-sso.part-5.ts` | 691 | `src/main/modules/identity/sso-http.ts`<br>`src/main/modules/identity/sso-authorization.ts`<br>`src/main/modules/identity/sso-token-validation.ts`<br>`src/main/modules/identity/sso-callback-server.ts`<br>`src/main/modules/identity/sso-restore.ts`<br>`src/main/modules/identity/sso-login.ts` |
| `src/main/modules/identity/oidc-sso.part-6.ts` | 578 | `src/main/modules/identity/sso-login.ts`<br>`src/main/modules/identity/sso-browser-session.ts`<br>`src/main/modules/identity/sso-test-internals.ts` |
| `src/main/modules/identity/sso-controller.part-1.ts` | 400 | `src/main/modules/identity/sso-controller-model.ts`<br>`src/main/modules/identity/sso-browser-cookies.ts`<br>`src/main/modules/identity/sso-browser-response.ts`<br>`src/main/modules/identity/sso-browser-navigation.ts` |
| `src/main/modules/identity/sso-controller.part-2.ts` | 752 | `src/main/modules/identity/sso-controller-runtime.ts` |
| `src/main/modules/kanban/local-store.part-1.ts` | 514 | `src/main/modules/kanban/store-model.ts`<br>`src/main/modules/kanban/store-values.ts`<br>`src/main/modules/kanban/store-cloud-details.ts`<br>`src/main/modules/kanban/store-database.ts` |
| `src/main/modules/kanban/local-store.part-2.ts` | 369 | `src/main/modules/kanban/store-database.ts` |
| `src/main/modules/kanban/local-store.part-3.ts` | 685 | `src/main/modules/kanban/store-row-codec.ts`<br>`src/main/modules/kanban/store-sync-cursor.ts`<br>`src/main/modules/kanban/store-queries.ts`<br>`src/main/modules/kanban/store-issue-writes.ts`<br>`src/main/modules/kanban/store-project-writes.ts`<br>`src/main/modules/kanban/store-local-issue-model.ts` |
| `src/main/modules/kanban/local-store.part-4.ts` | 738 | `src/main/modules/kanban/store-local-issue-model.ts`<br>`src/main/modules/kanban/store-issues.ts`<br>`src/main/modules/kanban/store-cloud-snapshot.ts`<br>`src/main/modules/kanban/store-outbox.ts`<br>`src/main/modules/kanban/store-run-receipts.ts` |
| `src/main/modules/kanban/local-store.part-5.ts` | 267 | `src/main/modules/kanban/store-project-writes.ts`<br>`src/main/modules/kanban/store-issues.ts`<br>`src/main/modules/kanban/store-cloud-snapshot.ts`<br>`src/main/modules/kanban/store-command-receipts.ts`<br>`src/main/modules/kanban/store-test-internals.ts` |
| `src/main/modules/kanban/ws-client.part-1.ts` | 495 | `src/main/modules/kanban/ws-model.ts`<br>`src/main/modules/kanban/ws-protocol.ts`<br>`src/main/modules/kanban/ws-transport.ts`<br>`src/main/modules/kanban/ws-values.ts`<br>`src/main/modules/kanban/ws-payloads.ts` |
| `src/main/modules/kanban/ws-client.part-2.ts` | 773 | `src/main/modules/kanban/ws-connection.ts` |
| `src/main/modules/marketplace/common.part-1.ts` | 706 | `src/main/modules/marketplace/market-model.ts`<br>`src/main/modules/marketplace/market-http.ts`<br>`src/main/modules/marketplace/market-paths.ts`<br>`src/main/modules/marketplace/catalog-values.ts`<br>`src/main/modules/marketplace/catalog-normalization.ts`<br>`src/main/modules/marketplace/market-settings.ts`<br>`src/main/modules/marketplace/installed-records.ts` |
| `src/main/modules/marketplace/common.part-2.ts` | 717 | `src/main/modules/marketplace/market-http.ts`<br>`src/main/modules/marketplace/installed-records.ts`<br>`src/main/modules/marketplace/asset-download.ts`<br>`src/main/modules/marketplace/asset-selection.ts`<br>`src/main/modules/marketplace/catalog-client.ts`<br>`src/main/modules/marketplace/catalog-projection.ts` |
| `src/main/modules/pet/controller.part-1.ts` | 622 | `src/main/modules/pet/controller-model.ts`<br>`src/main/modules/pet/activity-trackers.ts`<br>`src/main/modules/pet/navigation-projection.ts`<br>`src/main/modules/pet/state-projection.ts`<br>`src/main/modules/pet/position-persistence.ts` |
| `src/main/modules/pet/controller.part-2.ts` | 705 | `src/main/modules/pet/drag-controller.ts`<br>`src/main/modules/pet/window-controller.ts`<br>`src/main/modules/pet/preview-controller.ts` |
| `src/main/modules/pet/desktop-pet.part-1.ts` | 737 | `src/main/modules/pet/pet-model.ts`<br>`src/main/modules/pet/pet-window-metrics.ts`<br>`src/main/modules/pet/pet-paths.ts`<br>`src/main/modules/pet/pet-state.ts`<br>`src/main/modules/pet/pet-status-values.ts`<br>`src/main/modules/pet/pet-settings.ts`<br>`src/main/modules/pet/pet-assets.ts` |
| `src/main/modules/pet/desktop-pet.part-2.ts` | 713 | `src/main/modules/pet/pet-state.ts`<br>`src/main/modules/pet/pet-window-layout.ts`<br>`src/main/modules/pet/pet-test-internals.ts` |
| `src/main/modules/shell/window-manager.part-1.ts` | 585 | `src/main/modules/shell/window-model.ts`<br>`src/main/modules/shell/webview-shortcuts.ts`<br>`src/main/modules/shell/main-window-options.ts`<br>`src/main/modules/shell/main-window-events.ts`<br>`src/main/modules/shell/media-permissions.ts`<br>`src/main/modules/shell/webview-attach-policy.ts` |
| `src/main/modules/shell/window-manager.part-2.ts` | 794 | `src/main/modules/shell/webview-events.ts`<br>`src/main/modules/shell/main-window-lifecycle.ts`<br>`src/main/modules/shell/main-window-activation.ts`<br>`src/main/modules/shell/main-window-web-contents.ts` |

## 新模块职责与最终行数

| 新文件 | 行数 | 职责 |
| --- | ---: | --- |
| `src/main/modules/identity/sso-model.ts` | 251 | 身份配置、凭据、回调与浏览器 Cookie 类型契约 |
| `src/main/modules/identity/sso-state.ts` | 145 | 唯一进程内 SSO 状态、一次性代码集合与状态 DTO 构造 |
| `src/main/modules/identity/sso-defaults.ts` | 112 | OIDC/Google 默认配置、回调与凭据文件常量 |
| `src/main/modules/identity/sso-paths.ts` | 31 | 品牌隔离身份配置和凭据路径及旧重复 token 文件清理 |
| `src/main/modules/identity/sso-config-values.ts` | 174 | 配置基础值读取、provider 与 PKCE 策略判定 |
| `src/main/modules/identity/sso-config.ts` | 750 | 完整配置解析、嵌套配置校验和磁盘配置加载 |
| `src/main/modules/identity/sso-session.ts` | 452 | 凭据与用户文件持久化、会话步骤完成、撤销与失败处理 |
| `src/main/modules/identity/sso-http.ts` | 92 | Electron fetch 选择、JSON 请求与错误诊断 |
| `src/main/modules/identity/sso-claims.ts` | 101 | JWT/用户 claims 解析与规范化 |
| `src/main/modules/identity/sso-callback-page.ts` | 59 | 回调 HTML、转义与响应输出 |
| `src/main/modules/identity/sso-authorization.ts` | 174 | 授权/登出 URL、PKCE 和 token 请求参数 |
| `src/main/modules/identity/sso-proxy-urls.ts` | 90 | 代理 URL、来源和 Set-Cookie 重写规则 |
| `src/main/modules/identity/sso-proxy.ts` | 260 | 登录 HTTP 代理与代理 Cookie 状态维护 |
| `src/main/modules/identity/sso-cookie-token.ts` | 267 | Cookie 换票、JWT 候选选择与 issuer/audience 匹配 |
| `src/main/modules/identity/sso-callback-params.ts` | 45 | OIDC/code/ticket 回调参数与防重放校验 |
| `src/main/modules/identity/sso-token-validation.ts` | 252 | 签名验证、用户信息补充与有效 OIDC 登录完成 |
| `src/main/modules/identity/sso-callback-server.ts` | 287 | 动态回环监听器、登录回调处理和响应后清理 |
| `src/main/modules/identity/sso-restore.ts` | 139 | 状态呈现与启动恢复候选分类、临时不可用和本地退出 |
| `src/main/modules/identity/sso-login.ts` | 239 | 交互登录、取消和登出的生命周期编排 |
| `src/main/modules/identity/sso-browser-session.ts` | 336 | Cookie SSO 会话与用户步骤、派生 Cookie 和 canonical token 发布 |
| `src/main/modules/identity/sso-test-internals.ts` | 94 | 保留既有 OIDC 测试观察入口 |
| `src/main/modules/identity/sso-controller-model.ts` | 88 | Electron 登录控制器依赖端口、返回类型及恢复错误 |
| `src/main/modules/identity/sso-browser-cookies.ts` | 141 | 浏览器 Set-Cookie 解析与 Session 写入 |
| `src/main/modules/identity/sso-browser-response.ts` | 80 | 浏览器换票错误与稳定用户身份解析 |
| `src/main/modules/identity/sso-browser-navigation.ts` | 91 | 浏览器 Cookie 请求、导航重写及登录后焦点恢复 |
| `src/main/modules/identity/sso-controller-runtime.ts` | 770 | 单一控制器拥有恢复/刷新单飞、账号代次和交互登录流程 |
| `src/main/modules/kanban/store-model.ts` | 204 | SQLite 行、云快照、同步游标和运行回执类型 |
| `src/main/modules/kanban/store-values.ts` | 179 | 存储常量、字段归一化与 issue detail 编码 |
| `src/main/modules/kanban/store-cloud-details.ts` | 121 | 云详情只读缓存的合并和数据库读写 |
| `src/main/modules/kanban/store-database.ts` | 374 | 数据库路径、连接生命周期、schema 初始化与种子记录 |
| `src/main/modules/kanban/store-row-codec.ts` | 202 | SQLite 行及云 project/binding 到领域 DTO 的转换 |
| `src/main/modules/kanban/store-sync-cursor.ts` | 85 | revision 与云同步游标的持久化 |
| `src/main/modules/kanban/store-queries.ts` | 124 | 问题、项目和绑定集合查询 |
| `src/main/modules/kanban/store-issue-writes.ts` | 140 | 底层 issue 行写入与位置计算 |
| `src/main/modules/kanban/store-project-writes.ts` | 126 | 项目/绑定写入、存在性及默认绑定维护 |
| `src/main/modules/kanban/store-local-issue-model.ts` | 161 | 本地 issue 创建模型与字段更新计算 |
| `src/main/modules/kanban/store-issues.ts` | 287 | 本地 issue 用例、运行态更新、位置调整、云 tombstone 和单项读取 |
| `src/main/modules/kanban/store-cloud-snapshot.ts` | 316 | Server 权威快照投影与派发 issue 幂等落地 |
| `src/main/modules/kanban/store-outbox.ts` | 95 | 现有云 mutation 与 run event outbox 持久化及尝试记录 |
| `src/main/modules/kanban/store-run-receipts.ts` | 61 | Desktop 手动运行回执 |
| `src/main/modules/kanban/store-command-receipts.ts` | 162 | 派发命令回执、精确运行身份和已上报状态 |
| `src/main/modules/kanban/store-test-internals.ts` | 9 | 保持存储测试观察入口 |
| `src/main/modules/kanban/ws-model.ts` | 147 | Kanban 连接依赖、消息与交付结果类型 |
| `src/main/modules/kanban/ws-protocol.ts` | 99 | 协议版本、消息分类和云 payload 隐私限制 |
| `src/main/modules/kanban/ws-transport.ts` | 81 | WebSocket 构造器、地址、请求 ID、原始消息解码与诊断 |
| `src/main/modules/kanban/ws-values.ts` | 11 | 协议基础标量和对象校验 |
| `src/main/modules/kanban/ws-payloads.ts` | 166 | snapshot、delivery、issue event、run 参数规范化 |
| `src/main/modules/kanban/ws-connection.ts` | 820 | 唯一 Kanban socket、pending 请求、重连和交付处理状态机 |
| `src/main/modules/pet/controller-model.ts` | 102 | 桌宠控制器输入、窗口/拖拽依赖端口 |
| `src/main/modules/pet/activity-trackers.ts` | 116 | 活动 Run 计数与完成预览去重状态 |
| `src/main/modules/pet/navigation-projection.ts` | 207 | 共享导航快照到任务和消息列表的只读投影 |
| `src/main/modules/pet/state-projection.ts` | 134 | 运行表现刷新与窗口模式选择 |
| `src/main/modules/pet/position-persistence.ts` | 72 | 位置变化判断及偏移持久化计算 |
| `src/main/modules/pet/drag-controller.ts` | 279 | 拖动会话、光标增量和跨平台边界更新 |
| `src/main/modules/pet/window-controller.ts` | 190 | 显示/关闭/异常恢复与启用状态回滚 |
| `src/main/modules/pet/preview-controller.ts` | 232 | 预览状态、完成摘要与预览清理控制器 |
| `src/main/modules/pet/pet-model.ts` | 96 | 桌宠设置/状态/资产类型与配置常量 |
| `src/main/modules/pet/pet-window-metrics.ts` | 89 | 窗口尺寸、可见足迹及边缘参数 |
| `src/main/modules/pet/pet-paths.ts` | 26 | 桌宠配置/状态/资产目录路径 |
| `src/main/modules/pet/pet-state.ts` | 281 | 本地与绑定状态合成、最终桌宠 DTO 和上下文菜单 |
| `src/main/modules/pet/pet-status-values.ts` | 29 | 摘要过滤与默认本地状态构造 |
| `src/main/modules/pet/pet-settings.ts` | 194 | 配置与未读运行态分离读写、设置归一化 |
| `src/main/modules/pet/pet-assets.ts` | 290 | 用户宠物清单、资产路径安全与 manifest 校验 |
| `src/main/modules/pet/pet-window-layout.ts` | 431 | 显示器约束、边缘停靠、预览面板布局和逻辑位置换算 |
| `src/main/modules/pet/pet-test-internals.ts` | 69 | 保留桌宠测试观察入口 |
| `src/main/modules/marketplace/market-model.ts` | 98 | 市场端口、记录与目录类型以及协议常量 |
| `src/main/modules/marketplace/market-http.ts` | 227 | 认证 provider 状态、设备头、公开/认证请求与 token 刷新 |
| `src/main/modules/marketplace/market-paths.ts` | 41 | 市场目录和通用 JSON 文件持久化 |
| `src/main/modules/marketplace/catalog-values.ts` | 42 | 外部 catalog 基础类型归一化 |
| `src/main/modules/marketplace/catalog-normalization.ts` | 378 | catalog、资源、依赖及平台规格校验 |
| `src/main/modules/marketplace/market-settings.ts` | 126 | 市场地址安全策略与配置读写 |
| `src/main/modules/marketplace/installed-records.ts` | 85 | 安装记录增删改与资源键去重 |
| `src/main/modules/marketplace/asset-download.ts` | 94 | 受限响应读取、下载、摘要和扩展名 |
| `src/main/modules/marketplace/asset-selection.ts` | 145 | 语义版本、平台候选及 Desktop 兼容性判断 |
| `src/main/modules/marketplace/catalog-client.ts` | 125 | 远端目录加载及安装资源解析 |
| `src/main/modules/marketplace/catalog-projection.ts` | 104 | catalog 与本地安装状态合并、列表呈现和条目定位 |
| `src/main/modules/shell/window-model.ts` | 153 | Shell 窗口/guest 窄端口类型与平台常量 |
| `src/main/modules/shell/webview-shortcuts.ts` | 64 | guest 编辑和 WorkPanel 快捷键判定与执行 |
| `src/main/modules/shell/main-window-options.ts` | 115 | 主窗口平台选项、Windows AppDetails 与 renderer 加载/DevTools |
| `src/main/modules/shell/main-window-events.ts` | 114 | 主窗口事件、渲染异常诊断与平台外观同步 |
| `src/main/modules/shell/media-permissions.ts` | 63 | 按受信窗口和 session 限制媒体授权 |
| `src/main/modules/shell/webview-attach-policy.ts` | 87 | guest attach 参数、partition、preload 与安全偏好校验 |
| `src/main/modules/shell/webview-events.ts` | 310 | 已挂载 guest 导航、弹窗、编辑与 WorkPanel 消息 |
| `src/main/modules/shell/main-window-lifecycle.ts` | 245 | 关闭/隐藏/全屏退出状态、定时器与生命周期 |
| `src/main/modules/shell/main-window-activation.ts` | 78 | 主窗口唤醒、聚焦与平台激活行为 |
| `src/main/modules/shell/main-window-web-contents.ts` | 165 | 主窗口 WebContents、隔离登录 guest 与事件装配 |

## 公共入口与定点引用调整

- 公共入口：identity/oidc-sso.ts、identity/sso-controller.ts、kanban/local-store.ts、kanban/ws-client.ts、pet/controller.ts、pet/desktop-pet.ts、marketplace/common.ts、shell/window-manager.ts（均在 src/main/modules 下）。
- callback-lifecycle 与 local-workflow-settings 仅更新本域内部依赖。
- scripts/i18n/scan-hardcoded-text.mjs 的宠物 matcher 白名单改为 navigation-projection.ts 和 preview-controller.ts。
- 测试定点更新：current-storage-contracts、windows-titlebar-layout、kanban-issue-detail、agent-platform-realtime-ownership 的 Kanban 地址构造文件，以及 fixtures/site-cdp-electron.cjs。

## 验证

| 命令/检查 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.main.json --noEmit` | 通过（最终无诊断） |
| `node scripts/check-main-architecture.mjs` | 通过，最新快照 585 source files / 20 modules（并行任务仍可改变总数）；C 组无环、无跨域深层导入 |
| 718 个旧顶层声明与实际新模块逐项文本比较 | 718 一致，0 缺失 |
| `node --test test/windows-titlebar-layout.test.mjs test/kanban-issue-detail.test.mjs` | 8/8 通过 |
| 隔离编译 + 下述 15 套件 | 305/305 通过；Windows/macOS 分支测试均包含 |
| C 组文件及定点测试 `git diff --check` | 通过 |
| 旧文件名/引用扫描 | C 组旧 part 文件 0，src/scripts/test 中指向 C 组旧 part 的引用 0 |
| `node scripts/i18n/scan-hardcoded-text.mjs --strict` | 全仓不通过；列出的违规位于其他源码域或已有 generated/renderer 文件，C 组 matcher 路径已更新且本组无新增命中 |

隔离编译命令：`npx tsc -p tsconfig.main.json --outDir /tmp/zenmind-c-validation/dist-electron`。测试在 `/tmp/zenmind-c-validation` 使用复制的 test 和隔离编译输出，已有品牌 build 只读链接；未运行应用、未连接真实账号，未覆盖共享 dist-electron。

运行套件：

```text
node --test --test-concurrency=1
  test/oidc-sso.test.mjs test/sso-callback-lifecycle.test.mjs
  test/sso-handlers.test.mjs test/sso-avatar-protocol.test.mjs
  test/kanban-v1-local-store.test.mjs test/kanban-desktop-ws-client.test.mjs
  test/kanban-local-workflows.test.mjs test/desktop-pet-behavior.test.mjs
  test/desktop-pet-hit-test.test.mjs test/desktop-pet-asset-protocol.test.mjs
  test/marketplace.test.mjs test/market-visibility.test.mjs test/market-featured.test.mjs
  test/window-manager.test.mjs test/current-storage-contracts.test.mjs
```

## 边界与尚存问题

- C 组无未解决的编译、架构或运行测试问题。
- 先前并行重构造成的 runtime-environment/performance-diagnostics 旧引用由 B 组修复；未越权改动。
- 默认沙箱限制本机监听端口，首次网络测试出现 EPERM；经工具授权在隔离目录重跑后 305 项全部通过。
- 全仓硬编码文本检查的既有/其他域命中需源任务在最终汇总中列明；本任务未扩大到无关代码修改。
- 未执行真实 Electron UI 手工回归；自动测试覆盖两平台分支，但不等同 Windows/macOS 真机验证。发布时仍按 qa/manual-regression.md 检查交互登录/退出、窗口/guest 和桌宠拖拽。
- 本次仅重新组织实现，不改变公共跨模块架构、信任边界、服务配置所有权或 Kanban Contract 1.0 操作边界；没有需要并发改写公共设计文档的新决策。
