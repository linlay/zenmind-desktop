# 编号拆分整改整合验证

验证日期：2026-09-24。基线：`11fc15ecb3f3c0de4cbc35eeb83c931ba6117264`。三个 worktree 的改动已整合到本地 `main`，未推送。

## 整改范围

删除七组共 29 个编号源码文件，改为真实职责边界：

| 原分组 | 当前职责 |
| --- | --- |
| app/runtime.operations | assembly 按领域装配；lifecycle 负责 ready、启动、退出；通知与诊断独立 |
| agent-platform/bridge.methods | Agent 目录、上传、聊天、导出、补全、平台请求、Run 控制 |
| agent-platform/ipc.operations | Frame Port Session、授权、分发、流绑定、投递、WorkPanel 调用 |
| realtime-broker.methods | 连接、根观察者、查询、Run 通道、Run 附着、订阅、桌面请求、诊断 |
| enterprise-chat/runtime.methods | 连接、联系人、会话、消息及附件协作 |
| kanban/runtime.methods | 连接、同步、命令、手工/自动运行及本地结果 |
| browser-surface-registry.operations | 注册存储、策略、诊断、guest 解析及容器投影 |

删除本轮编号拼装符号、万能 app Context 和宿主 `self: any` 传递。组件使用类型化窄依赖；动态状态保持实时 getter，canonical 状态仍由单一控制器持有。新增文件名架构检查，禁止再次出现机械编号拆分。具体所有权规则已更新到架构专题文档。

整合提交：`22693410`、`207de677`、`c4af3ccb`、`52961fa9`；防回归约束 `7beaec6e`；源码契约测试适配 `07eaf906`。

## 最终验证

| 检查 | 结果 |
| --- | --- |
| src 全量编号文件扫描 | 0 个 |
| architecture:check | 628 个 Main 源文件、20 个模块通过 |
| build:main:prepared | 类型构建和主进程打包通过 |
| build:renderer:prepared | 类型检查和前端打包通过；保留既有 chunk 大小提示 |
| WebApp / Agent Webclient 契约检查 | 通过 |
| 受影响领域专项回归 | 391 项：390 通过、1 跳过、0 失败 |
| 六项跨领域源码契约测试 | 全部通过 |
| 容器探测独立复测 | 9 项全部通过 |
| 最终广泛静态回归（renderer-build、chat-history-dialog、chat-work-panel、realtime ownership） | 188 项：123 通过、65 失败；65 项失败标题均已在未改基线复现 |
| git diff --check | 通过 |

专项回归覆盖助理桥、Realtime Broker、Frame Port 与实时 surface 生命周期、企业聊天、Kanban、app 装配、启动/退出、Electron profile、更新安装器、实时诊断、artifact 和划词窗口。新增行为验证覆盖异步授权失效后的拒绝、动态依赖读取、macOS/Windows ready 顺序及通知顺序；没有将旧业务断言删除来获得通过结果。

## 全量基线对照与限制

在临时源码快照运行未改基线，并在三个领域合并后运行全量测试；均使用 `node --test --test-timeout=60000 --test-concurrency=1 ./test/*.test.mjs`：

- 未改基线：2441 项，2343 通过、79 失败、19 跳过。
- 三个领域合并后、app 整合前：2448 项，2344 通过、85 失败、19 跳过。
- 相对基线新增的失败标题为六项源码定位断言及三项容器探测时序测试。六项断言已根据新的实现职责和 Facade 转发更新并全部通过；容器探测独立复测全部通过。基线另有一项 Docker 探测失败，同样已复测通过。
- 最终 app 合并后运行了上述专项及广泛静态回归，没有重新运行包含慢速安装和原生截图的整个测试集合。当前证据不能表述为“全仓测试全绿”。
- 基线快照缺少工作目录的部分生成产物，因此另有三个 Windows 安装器静态测试只在快照失败；这三项不作为本轮回归。
- 严格 i18n 扫描仍失败：基线存在 58 处硬编码汉字，当前目录另有 8 处既有 generated/brand.ts 内容；迁移后的 completion.ts 三处字符串来自原 bridge.methods-1.ts，未新增文案。字典键与语言分离检查通过。
- macOS 原生区域截图测试在基线和整合版本均超时；只终止了各自超时遗留的 Electron 测试进程。没有完成真实 macOS/Windows 安装、退出、窗口交互人工验证，应按 `qa/manual-regression.md` 执行。
- 用户原有未跟踪 `zenmind/` 目录未修改、未提交。worktree 保留，未删除。

本机日志保存在 `/tmp/numbered-refactor-{clean-baseline-tests,integrated-tests,final-focused,final-static,final-targeted-static,container-tests,final-renderer-build,final-i18n}.log`，便于继续定位原有失败。
