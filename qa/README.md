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
| Provider 环境交付 | [登记样例](provider-registration/README.md) |
| 网站桥制作与加载 | [桥包验收](website-bridge-package.md)、`website-bridges-smoke.mjs` |
| 网站密码与登录采集 | `website-credentials-smoke.mjs`、`website-credentials-capture-smoke.mjs` |
| 设置、能力导航与资料库 | `web-settings-smoke.mjs`、`capability-navigation-smoke.mjs`、`library-smoke.mjs`（旧 `artifact-management-smoke.mjs` 转到此入口） |
| WorkPanel 与本地文档 | `work-panel-browser-smoke.cjs`、`work-panel-browser-smoke.mjs`、`work-panel-local-document-smoke.mjs`、`local-document-open-native-smoke.cjs` |
| 窗口与原生平台交互 | `work-panel-fullscreen-smoke.mjs`、`windows-fullscreen-smoke.cjs`、`mac-application-menu-smoke.cjs`、`screenshot-native-macos.mjs` |
| 插件、连接器、企业聊天与 WebApp | 对应的 `*-smoke.cjs` / `*-smoke.mjs`，按脚本依赖准备构建产物 |

从仓库根目录运行命令。独立 `.mjs` 入口使用 `node qa/<文件名>.mjs`，直接使用 Electron 的 `.cjs` 入口使用 `npx electron qa/<文件名>.cjs`；`*-checks.cjs` 是配套 runner，由对应 `.mjs` 设置夹具和环境后启动。需要 `dist-electron` 或 renderer 发布资源的脚本先按对应说明构建；不要把浏览器预览或 Windows CSS 模拟当作原生 Windows 验收。

维护时按实际有效性判断：保留仍有源码、契约、测试或执行入口支撑的材料；删除已完成改造的阶段报告、失效方案与脱离当前契约的演示副本。截图、日志和测试通过率属于当次执行证据，输出到临时目录或忽略的构建目录；历史材料从 Git 查询，不在此目录另建归档。
