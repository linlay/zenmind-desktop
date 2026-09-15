# Kanban 未发布历史兼容清理

## 已删除

| 范围 | 删除内容 |
| --- | --- |
| `runtime.shared.ts` | 顶层云配置、`kanban` 包裹结构的兼容读取；由 URL 推断 enabled；读取时补 enabled、剥离 token/selectedProjectId 并重写配置的自动修复。缺失文件仍初始化为当前格式，已有文件读取不写回。 |
| `local-store.part-2.ts` | 全部历史补列 ALTER TABLE；project 与 desktop_issue_sync 的 private→local 表重建；priority 旧枚举与 nullable 约束迁移；逐行 DETAIL_JSON 扫描、字段转换和 UPDATE。CREATE TABLE 已完整包含原补列所需字段。 |
| shared contract、local store、automation payload | `urgent/high/medium/low` 优先级别名与 KanbanWirePriority；`version` 输入别名；`dueTime/dueAt` 转换为日期的读取与迁移。当前字段是 projectVersion、dueDate、P0–P3。 |
| WS 快照 | 缺少项目集合时从旧单个 projectId 推断同步范围的回退；测试模拟快照同步使用 project_set 与 projectIds。 |
| Kanban 页面 | 旧 localStorage assignee-filters 读取与合入当前 filter-preferences.v1 的逻辑。 |
| desktop-init | Kanban 顶层云配置、token、deviceAlias 导入；由别名回填全局 profile 名称及对应升级调用标志。 |
| 设备名称 | Kanban 配置类型与默认值中的 deviceAlias，以及运行时使用旧别名的回退；统一由当前全局 Desktop 设备名称提供。 |
| 测试 | 旧数据库必须自动迁移、旧优先级/日期必须转换、旧配置必须自动改写、旧别名必须迁入 profile 的断言；改为当前格式及旧输入不会回填/改写的断言。相关源码拆分后失效的读取位置同时校正。 |

## 保留及原因

- 当前数据库初始化、默认 board/project 与用户投影、约束校验：新安装和正常业务必需，不是升级迁移。schema 标记仍表达当前版本，不引入新迁移版本。
- 当前日期合法性、优先级校验、可选值及 JSON/数组校验、UI 默认值：验证当前输入；旧优先级不会被映射成新的优先级。
- 本地 runId/activeRunId、typeId 与共享投影字段：仍被当前本地创建、运行和存储路径使用，不能因与云字段不同而整体删除。云端 Server-prepared Issue Run 身份与精确运行事件同步保持不变。
- 当前握手设备信息中的 deviceAlias：来自统一设备名称的协议输出，不再是第二套持久设备名称来源。
- 当前 snapshot 完整性与范围校验、账号隔离、游标、outbox、receipt、断线重连、终态恢复、孤立本地 Issue 的保留：处理真实运行期状态和 Server 删除事件，不是未发布版本迁移。
- 旧 endpoint 的拒绝校验、Cloud Issue 只读边界、Kanban Copilot Dock 注册/恢复门禁：用于阻止非法行为，不是兼容入口。未增加云端 Issue CRUD 或 Website issue.run.request 调用。
- 当前原子操作、普通 Desktop 远程能力与自动化、macOS/Windows 路径和设备识别分支：保留现行功能及真实平台差异。全局非 Kanban 配置升级框架不在本次删除范围。

## 验证

- `node --test --test-timeout=15000 --test-concurrency=1 test/kanban*.test.mjs test/device-identity.test.mjs test/desktop-init-bootstrap.test.mjs`：105/105 通过。
- 新增验证：完整新库字段与 CHECK/FK 约束、旧 DETAIL_JSON 不被读取转换或自动写回、旧 version 更新不被采纳、darwin/win32 旧配置不重写、启动导入不回填设备名称。
- main 类型检查与打包、renderer 类型检查与 Vite 生产构建、architecture:check、webapp-contract:check、agent-webclient-contract:check、i18n:keys、git diff --check 通过。
- renderer 的 Kanban 静态测试：13/17 通过。4 个失败在干净 HEAD 副本中同样复现，分别是侧栏默认分组的旧源码匹配、项目选择器的旧源码匹配、菜单旧宽度匹配、未定义的 zhCN。未扩大修改范围修复这些基线问题。
- i18n:check 的严格硬编码扫描失败；与干净 HEAD 的输出去除行号后完全相同，字典与语言分离检查通过。
- 未执行真实 Windows/macOS GUI、在线 Server 端到端或打包安装回归；已更新 manual-regression.md，平台路径由临时应用夹具验证。

所有测试使用临时目录；未删除或改写用户实际配置、数据库及旧数据文件。未合并主分支。
