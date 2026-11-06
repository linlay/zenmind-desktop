# 小君 Chrome 执行层补丁

上游：Microsoft Playwright 正式版 `playwright-core` `1.64.1`，对应 commit `cfe490d941f992655948eee8fd4fd94e1c4234bf`。不再通过原先的 `@playwright/mcp 0.0.83` 引入其固定的 alpha 构建，也不在 `postinstall` 修改依赖。本项目不跟踪根 `package-lock.json`，因此在依赖声明和本目录 `upstream-lock.json` 同时固定受审版本；锁文件记录官方 npm tarball、SRI 和原始 Core bundle SHA-256。升级必须更新受审基线，不能仅凭版本号为正式版就接受未来版本。

`scripts/playwright/browser-use-patch.mjs` 从调用项目的依赖上下文解析 `playwright-core`，支持工作区提升安装和包管理器的嵌套布局。构建、打包与测试只为这个已解析且通过版本/原始摘要校验的实例追加 Desktop 适配器，不再按字符串替换上游源码。随后验证所需的私有绑定（MCP backend、扩展 relay、配置解析、CRPage 等）；缺失或加载失败会恢复原始 bundle 并中止构建。追加产物整体参与一致性比较，修改过的后缀不能因保留旧 marker 而被信任。安装依赖不运行此步骤，正式构建仍严格校验。下载捕获依赖的私有传输缺失时拒绝捕获，保留浏览器原始下载。

当前 Core 没有外部运行依赖，所需的 Schema 实现在其 bundle 内；Chrome 执行层不要求根应用的 `zod` 精确锁定。因此根 `zod` 沿用主线的兼容版本范围，浏览器执行层仅使用经过校验的独立 Core bundle。

上游升级由浏览器执行层维护者在同一变更中完成：核验官方 tarball 的 SRI，更新版本、commit 和原始 Core 摘要；检查私有绑定、页面身份、取消与下载监听恢复；运行受控浏览器与官方扩展验收，再分别验证 macOS 和 Windows 的实际打包链路。存在同名私有绑定不等于行为兼容，不能跳过这些回归。具体责任人由仓库维护者在升级 PR 中指定。

适配器只增加私有 Desktop Worker API，并在 Desktop 自己的 Context/Tab 实例上安装行为：为上游 Tab 分配不复用的 pageId；按 pageId pin 住同一个 Tab，跨动作、返回快照与序列化都不接受 currentTab/相邻页面回退；扩展连接沿用官方 relay 与握手，等待期间可取消，已连接时显式关闭 CDP relay。模型只能经 Desktop 受限工具访问 Worker，不能选择任意上游工具、CDP endpoint 或执行 Node/页面脚本。

主进程用 Electron utilityProcess 的 parentPort 通道。Worker 归属于 Chrome 工作区；用户开启记住连接后，多个 Chat 可沿用同一存活工作区和 Worker，实际网页操作由当前 Run 独占。未记住授权的手动连接保持 Chat 私有。程序随包携带追加了适配器的完整 core runtime 及原始 Apache-2.0 LICENSE、NOTICE 和第三方声明；运行不调用 npx，也不依赖用户安装的 Node 或 Playwright 浏览器。

用户需在自己的 Chrome profile 手动安装官方 Playwright Extension。已核实的扩展源码版本为 `0.4.0`、relay 协议 2。保留官方手动选 tab 和每 client tab group，忽略进程继承的授权环境变量。用户在设置中明确保存的扩展授权由操作系统加密保护，只在建立连接时通过私有 Worker 通道交付，用于记住连接；模型和网页不能提供或读取该凭据。Desktop 不自动安装扩展、不复制用户 profile，也不打开 Chrome 全局调试端口。主进程停止时先请求 disconnect，超时终止 Worker；Chrome 与网页保留，已派发的网页操作不会回滚。

默认 profile 的磁盘发现只提供打开官方连接页时的 profile 提示，不承担授权判定。未匹配也继续正常 Chrome handshake，不把未匹配硬判为未安装，不改写用户 profile 或数据根，也不轮换 profile 重试。手动连接的页面访问由官方 Allow & select 和用户选择的 tab 决定；已配置记住连接时使用显式保存的授权建立工作区，仅交付该工作区内登记的 HTTP(S) 业务页。连接失败与等待超时提示涵盖扩展未安装、未启用或未完成授权，不能根据发现失败断言其中一种情况；错误不交付上游连接 URL 或扩展凭证。

扩展上下文可能同时包含官方连接页或欢迎页；Worker 与 Main 只将 HTTP(S) 业务页交付为 Surface，内部页面的标题和连接地址不进入 UI/模型列表。执行前、等待后与返回结果前复验同一 Page 的协议；业务页进入内部协议后，旧 ID 拒绝操作而不回退其他 tab。

验证入口：`node --test test/browser-use-chrome-worker.test.mjs test/browser-use-chrome-utility.test.mjs`。浏览器用全新临时 profile/独立 context；测试 CDP 端口只属于专门启动的 headless fixture，不接管用户 Chrome。utilityProcess 测试覆盖应用相对的打包 Worker、真实 parentPort、实际页面操作和释放。真实官方扩展的安装、选 tab、协议匹配及人工接管仍需产品验收。

官方扩展的隔离验收：先运行 `node scripts/playwright/browser-use-prepare-extension.mjs`（有环境代理时加 Node 的 `--use-env-proxy`），仅下载并核验官方商店固定 CRX，不安装到用户 Chrome。然后以 `BROWSER_USE_TEST_CHROME_FOR_TESTING` 指向本机 Chrome-for-Testing，执行 `node --test test/browser-use-chrome-extension.test.mjs`。该 fixture 用临时 profile、有头浏览器和 localhost 页面，实际经过官方 Allow & select UI、协议 2 relay 和生产 engine 的 connect/操作/取消路径；自定义 launcher 只存在于测试工厂，不属于生产 Worker 请求参数。个人 Chrome profile 安装和 Windows 真机验收仍需独立完成。

其中默认发现假阴性用例使用生产默认工厂与无 profile/浏览器覆盖的连接参数；测试只在 OS 边界提供空的临时发现目录、把打开连接页的进程重定向至测试自有 Chrome。断言 finder 实际查过默认根、未加 profile/data-root 参数且无 token，随后必须经过真实官方 Allow & select。`test/browser-use-chrome-discovery.test.mjs` 另验证发现命中/未命中、错误分类、包上下文解析，以及未审版本和被修改原始 bundle 的拒绝路径。
