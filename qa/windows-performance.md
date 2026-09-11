# Windows / macOS 性能对照采集

## 开启与日志位置

默认关闭。完全退出 Desktop（包括托盘中的进程），带 `ZENMIND_PERF=1` 启动新进程；已有单实例不会继承新环境变量。开发运行：

Windows PowerShell：

```powershell
$env:ZENMIND_PERF = "1"
npm run dev
```

macOS Terminal：

```sh
ZENMIND_PERF=1 npm run dev
```

安装版在同一终端直接启动实际可执行文件。Windows 使用 `& '实际安装路径\应用.exe'`；macOS 使用 `ZENMIND_PERF=1 '/实际安装路径/应用.app/Contents/MacOS/实际可执行文件名'`，不要经 Finder 启动。

日志位于当前品牌数据根的 `logs/desktop/performance.jsonl`，与 `main.log` 同目录。采用 1 秒批量异步写入；单文件最多 10 MiB，保留一个 `.1` 轮转文件，待写队列最多 256 KiB，拥塞丢弃量写入 `dropped`。退出刷新为尽力而为，强制结束进程可能丢失最后一批。

关闭采集：完全退出；Windows 执行 `Remove-Item Env:ZENMIND_PERF` 后正常启动；macOS 不带变量启动（若曾 export，先 `unset ZENMIND_PERF`）。默认关闭时不建立采集文件、计时器或事件监听。

## 固定复现流程

侧栏优化复测（Windows / macOS）：分别在展开侧栏、窄栏与置顶/项目列表中悬浮长标题，检查卡片内容、键盘焦点打开、Escape 关闭及拖动后的悬浮抑制；卡片打开期间更新标题/状态或语言应显示新值。切换 Chat 时未打开的卡片不应出现内容生成热点。保持导航顺序不变时，排序文件不应反复替换；实际拖拽、Alt + 方向键排序和置顶变更仍应保存，完整重启后顺序一致。模拟文件替换失败时原文件保持完整。

进程查询优化复测：重启开发进程后用原有两个 Chat 重复切换，比较 `main-chat-router-applied-accepted` 的耗时和 watchdog 回退数。首个冷身份查询允许异步等待；连续访问应复用近期成功观察。在 Windows 和 macOS 分别验证 Platform 停止、重启、新 Chat 与流式响应；停止后的请求不得复用失效身份。再次录制宿主 Performance 时，Frame Port 调用链中不应出现同步 `spawnSync`；身份相关的 live webview 读取仍保留。

1. 两平台使用相同 Desktop/WebClient/Platform 版本、账号和聊天数据，记录电源模式、屏幕缩放及是否打开 DevTools。性能测试期间保持窗口前台、DevTools 关闭。
2. 启动静置 30 秒；首次打开一个较长的历史 Chat，等待内容显示，再静置 10 秒。
3. 两个固定 Chat 往返切换 20 次，每次等内容显示；再快速连续切换 10 次，检查旧回调是否被拒绝。
4. 分别打开、隐藏、关闭 Copilot 和 WorkPanel，静置 60 秒。注意隐藏允许保留 guest，不等于关闭。
5. 收集 `performance.jsonl` 和存在的 `.1`，附上慢操作的本地时间、版本与复现步骤；另做一次关闭采集的对照，确认采集本身没有明显改变体验。

## 如何读数据

- `host-navigation-requested`：AppShell 的侧栏/历史等统一导航入口接受已有 Chat 的导航；并非物理鼠标按下时间。其 `switchId` 在路由精确匹配且 30 秒内被协调器消费时沿用。
- `main-chat-router-waiting-ready` → `chat-route-bridge-queued` → `main-chat-router-applied-accepted`：按 `switchId` 看 `elapsedMs` 差值。计时使用宿主的单调时钟；没有匹配入口的导航从协调器建立 transition 时开始。`hostMonoMs` 只可在同一个宿主 renderer 内相减。
- `main-chat-route-transition-replaced` 表示被替换，不能当作成功；`main-chat-router-applied-rejected` 表示确认未通过当前 revision/generation 校验，也不能当成功样本。
- `main-chat-router-timeout` / `main-chat-route-load-url-fallback`：确认是否触发整页重载。按 `instanceId + transitionId`、revision、documentGeneration 辅助关联；切换前后查看 guest ID 是否变化。
- `contents-observed/loading/dom-ready/loaded/destroyed`（实际 stage 均带 `contents-` 前缀）：所有 Electron WebContents 的生命周期，通过 `webContentsId` 关联资源快照中的 surface 和 PID。`contents-observed` 包含采集启动时已存在的实例，不代表一定刚创建。
- `resources`：每 5 秒采样，进程内存按 PID 去重；`deltaBytes` 只针对相同 PID + creationTime，首次为 null。关注 guest 数、孤立 guest 数以及关闭后连续多个采样的趋势。短暂未注册可形成孤立计数，不能凭单次采样判断泄漏。
- `host-responsiveness`：宿主长任务次数、总耗时、最大耗时和采样定时器延迟。`resources` 同时包含 main 事件循环最大值及 P99。最小化/后台节流也会增加定时器延迟，不能直接视为 CPU 阻塞。

`APPLIED` 明确是 `router-only`，**不代表历史数据加载完成或聊天内容上屏**。当前没有 WebClient 内部数据请求、React 提交、guest 长任务或 JS heap 埋点；这部分需在 WebClient 仓库补齐。生命周期加载事件同样不能代表聊天业务已就绪。

内存是 Electron 进程工作集，包含主进程、renderer、GPU 等；不是 JS heap，也不包括独立内置服务或 Docker 的总内存。Windows 另记可用的 private bytes；macOS 不伪造该字段。跨平台主要比较相同操作后的增长趋势，不将两种系统的绝对数值直接等同。工作集增长本身也不证明泄漏。

性能通道仅允许主窗口顶层 frame 提交数值、布尔值及技术标识；不记录 URL、Chat ID、标题、正文或业务帧。此约束不改变既有普通诊断日志的策略。
