# 运行环境恢复与数据 Schema 版本治理：实施盘点及后续审核计划

> 状态：待额外审核。本轮备份重装代码已提交；Schema 版本治理尚未实施完成。
> 编制日期：2026-10-30。
> 审核基线：Desktop `77f605e6`；Agent Platform `c0db391e`。
> 本文放在 Desktop 的 `plans/`，统一覆盖两个仓库，不复制第二份计划。
> 本次文档任务只整理事实、要求与后续工作，不据此自动修改运行时或扩大兼容范围。

## 1. 用户目标与必须保留的要求

1. 核心启动失败后，用户可以在启动页选择“备份并重新安装”，不必先进入设置页。
2. 完整保留旧的 `.<brand>` 运行根，重建新环境，并恢复明确支持的用户数据；失败时保留现场并能退回旧环境。
3. Chat、归档、Mailbox、Platform 资源及其他 Platform 数据的识别、校验和迁移归 Agent Platform。Desktop 只负责宿主生命周期和自己拥有的数据。
4. 应用发布版本用于发布、诊断和定位产物；真正决定数据兼容范围的是每类持久化结构自己的 Schema 版本。
5. 同一 Schema 不应因为应用发布版本不同就被拒绝恢复；不同 Schema 不能因为应用发布版本相同就被认定兼容。
6. 对需要长期读取和恢复的受管结构，必须明确结构身份、版本、校验方式和责任模块。不能用“当前格式”长期替代版本契约。
7. 兼容工作必须克制：先列明具体的源 Schema、目标 Schema、转换内容和支持期限，再确认是否实现；不自动补齐所有历史版本。
8. 避免迁移代码永久累积，不引入未经需要证明的通用迁移框架、自动猜测、隐式降级、目录扫描找旧版本或多套并行读写。
9. macOS、Windows 的路径、文件占用、权限、进程退出及发布／回退行为必须分别实现和验证。
10. 本轮两个实现提交的说明均已超过 100 个中文字符；后续提交仍应清楚描述具体变化与验证结果。

## 2. 本轮实际提交了什么

| 仓库 | 提交 | 变更规模 | 实际交付 |
| --- | --- | --- | --- |
| Desktop | `77f605e6` | 33 个文件，新增 639 行、删除 103 行，含实现、测试和文档 | 启动失败入口、备份重装编排、整根切换、恢复界面和回退 |
| Agent Platform | `c0db391e` | 18 个文件，新增 978 行，含实现、测试和文档 | 独立离线恢复命令、存储校验、资源保留和跨平台 deploy 接入 |

这些规模是本轮提交的事实，不表示已经完成所有数据结构的版本治理，也不表示全部恢复对象均已通过内部格式验证。

### 2.1 Desktop 已实现

| 范围 | 实际行为 | 主要文件 |
| --- | --- | --- |
| 启动页 | 核心启动明确失败时显示重装按钮；仅登录受阻或启动中不显示；已有未完成重装时显示回退入口 | `src/renderer/app-shell/startup/StartupGate.tsx` |
| 设置页 | 原有重置入口接入同一重装流程，更新确认、进度和结果文案 | `src/renderer/pages/settings/SettingsPage.tsx` |
| 全局交互 | 恢复阶段覆盖原退出阶段提示；失败后撤掉遮罩，允许查看错误 | `AppShell.tsx`、`DesktopShutdownOverlay.tsx` |
| IPC 与契约 | 支持重装／回退操作、阶段事件、恢复备份位置及 manifest 恢复能力声明 | preload、shared contracts、Settings IPC、manifest normalizer |
| 维护编排 | 进入服务变更队列；准备候选及程序包；关闭实时入口；停服并确认退出；调用离线恢复；授权一次重启 | `src/main/app/lifecycle/runtime-reset.ts`、`src/main/app/runtime.ts` |
| Platform 程序调用 | 从已校验的内置包冻结恢复程序，不使用相邻源码或任意已安装程序；调用 deploy 的检查和恢复动作，保存日志 | `src/main/modules/services/runtime-recovery.ts` |
| 超时处理 | 恢复阶段使用较长的有界期限；超时时调用已有受管进程树清理能力；失败保留诊断 | `runtime-recovery.ts`、`manager/command-runner.ts` |
| 整根事务 | 在新进程打开 profile 与领域数据库前恢复 Desktop 分区、备份旧根、发布候选；记录步骤并允许显式续跑 | `src/main/infrastructure/filesystem/runtime-env-reset-transaction.ts` |
| 完成门禁 | 目录切换后仅进入 `verifying`；核心服务健康后才完成活动事务，旧备份继续保留 | `runtime.ts`、事务模块及 startup pipeline |
| 程序重装 | 三个核心服务程序从内置包强制重新安装；可选程序不在该强制重装集合中；配置由服务自行部署 | `manager/startup-pipeline.ts` |
| 已有工作区 | 不重复进入首次 Chat 引导；不再次应用包内一次性 Desktop 初始化设置，避免覆盖恢复出的偏好 | startup assembly、事务模块 |
| 失败与回退 | 早期发布失败也能打开原生恢复界面；回退保留新失败环境；不宣称回退会解决旧环境原有启动故障 | `runtime-reset-recovery.ts`、事务模块 |
| 职责调整 | 移除了 Desktop 自行保留包外 Agent 的逻辑，改由 Platform 负责 | 事务模块、Platform 恢复模块 |

### 2.2 Platform 已实现

| 范围 | 实际行为 | 主要文件 |
| --- | --- | --- |
| 离线入口 | 增加 `runtime-recovery`，支持 `check`、`restore`，不启动业务服务或调度器 | `cmd/agent-platform/runtime_recovery.go`、`main.go` |
| 部署契约 | manifest 声明 `runtimeRecovery: v1`；Unix 和 Windows deploy 转发到同一份 Go 实现 | release manifest、两平台 deploy／program-common |
| 候选约束 | 源和目标必须是独立目录；目标是未发布候选；拒绝路径重叠、符号链接和特殊文件 | `internal/runtimerecovery/` |
| 存储检查 | 校验 Chat、Archive、Mailbox、Automation Execution 的现行结构，检查数据库完整性及受管历史 JSONL | 对应领域的 `recovery.go` |
| 数据恢复 | 按显式目录范围复制用户数据，不解析 Desktop 的数据和事务 | `internal/runtimerecovery/recovery.go` |
| 资源冲突 | 包内 Agent／Skill／Tool／Connector 优先；包外一级资源保留；Registry 按相对文件保留包外项 | 同上 |
| 自动化 | 恢复已加载的有效定义后设为暂停；保留执行历史；不重放任务 | 同上及现有 automation registry |
| 恢复记录 | 完成后写报告；完成重试复验后返回；中断候选保留 pending 标记，要求重新生成候选 | 同上 |
| 空间与平台 | 检查目标空间；Windows 使用专属空间查询、大小写处理和 ACL；macOS 处理系统路径别名 | `space_unix.go`、`space_windows.go`、两平台脚本 |

### 2.3 真实执行顺序与最初提议的差别

当前实现的顺序是：

```text
确认操作
  -> 校验包，生成未发布候选，冻结 Platform 程序
  -> 停服并验证退出
  -> Platform 从旧运行根恢复到候选；旧运行根仍在原位置
  -> 授权重启并退出旧 Desktop 进程
  -> 新进程在打开 profile／数据库前复制 Desktop 持久分区
  -> 将整个旧运行根 rename 为备份
  -> 将候选发布到原路径
  -> 重新安装核心程序，由服务部署配置并启动
  -> 核心健康通过后完成事务
```

因此，当前并非“先把整根移动为备份，再从该备份迁移”的字面顺序，而是先在候选内恢复、保留原根，随后在发布前整体备份和切换。此差别必须纳入本次审核；若要求严格备份在先，需要另审进程与界面生命周期调整，不能把现实现描述成已经满足该顺序。

## 3. 当前恢复范围与 Schema 校验事实

### 3.1 Platform 的受管结构

| 数据／结构 | 已有版本标识 | 本轮离线检查实际覆盖 | 当前支持与缺口 |
| --- | --- | --- | --- |
| `chats/chats.db` | Chat V1，SQLite `application_id` 与 `user_version` | 结构身份、完整当前结构、完整性检查 | 仅接受当前完整 V1；不是所有曾被称为 V1 的不同结构 |
| `chats/archive/archive.db` | Archive V1，同上 | 同上，并校验库内归档 JSONL | 仅接受当前完整 V1 |
| `chats/mail.db` | Mailbox V1，同上 | 当前 DDL、标识与完整性 | 同为 V1 但字段不一致会拒绝；未来不能继续在不升版时改变持久结构 |
| `automations/executions.db` | Execution V2，SQLite `user_version` | 当前 V2 结构和完整性 | 旧结构不转换、不重建为空库 |
| 根 Chat JSONL、`.btw`、`.explain` 记录 | 尚无独立、统一的存储 Schema 版本标识 | 现有记录校验器 | 只能表述为符合现行校验，不能擅自命名为 V1 或承诺历史兼容 |
| `chat-order.json` | V1 | recover 原样复制；运行时读取器检查 | 尚未加入离线恢复的独立校验 |
| `chat-pinned.json` | V1 | 同上 | 同上 |
| `chat-primary.json` | V1 | 同上 | 同上 |
| artifact manifest 等受管 Chat 元数据 | 需逐项盘点；不能以导出 Snapshot 的版本替代 | 本轮随目录复制，未逐项补齐格式校验 | 待确定各结构的身份、版本与完整性边界 |
| 自动化定义 | 当前 YAML 定义规则；本轮未新增 Schema 版本 | 有效定义由现有 registry 加载并暂停；无效项可能被现有 loader 跳过 | 不能把“复制成功”算作所有定义均已验证；需明确报告跳过项 |
| Agent／Skill／Tool／Connector／Registry 定义 | 各领域已有契约需分别盘点 | recover 按资源冲突规则复制，未统一执行资源 loader 校验 | 包版本、Skill 版本、Connector 版本不能直接当作配置结构版本 |
| Memory、知识库及索引、预览记录、凭据状态 | 各自内部版本尚未在本轮完整盘点 | 按范围复制，未新增完整内部格式检查 | 不能宣称这些数据的所有历史版本都受支持 |
| 普通附件与产物原文件 | 任意内容，不强行套统一业务 Schema | 文件类型、路径和复制范围检查 | 普通上传的 JSONL 也按附件保留，不当作聊天记录解析 |

额外事实：当前恢复前检查上述四类数据库；恢复后及完成重试主要复验 Chat／Archive 的检查入口，没有同等覆盖所有目标结构。完整的逐项目标复验仍需补齐。

### 3.2 Platform 的目录策略

| 类型 | 当前范围 | 策略 |
| --- | --- | --- |
| 领域资源 | `agents`、`skills-center`、`tools`、`connectors-center`、`registries` | 包内优先、包外保留；具体粒度见 2.2 |
| 持久数据 | `chats`、`memory`、`kbases`、`automations`、`owner`、`root`、`pan`、`ru-kbases`、`ru-previews`、`.state` | 源目录存在时按整个 scope 恢复 |
| 不在恢复 scope 的内容 | 旧独立 Team 定义、生成的 Agent／Skill／Connector runtime cache、旧资源升级 journal 等 | 不自动迁入；仍在整根备份中保留 |
| 外部存储根与外部工作区 | 自定义存储覆盖、指向其他目录的链接 | 当前不恢复；自定义 Platform 存储声明明确拒绝，不遍历外部内容 |

目录存在不表示每个内部结构均可读取；scope 清单不是 Schema 兼容清单。

### 3.3 Desktop 自有数据

| 类型 | 当前范围／行为 | 版本治理现状 |
| --- | --- | --- |
| 配置 | Desktop、Webs、Plugins、网站桥的指定 config 分区 | 原样复制；未逐项增加离线 Schema 检查 |
| 用户数据 | Desktop `data/` 下除内置服务数据及原始环境包分区外的内容 | 原样复制；包含资料库数据库、皮肤、网站桥等资源 |
| secrets | Desktop 自有密钥与凭据文件 | 原样保留并保护目录权限；复制成功不代表登录有效或凭据可在任意机器解密 |
| 已完成引导、桌宠选择 | 两项明确允许的 Desktop 持久 state | 保留用户选择；不因此恢复活动生命周期状态 |
| Desktop profile | 源码已有 `schemaVersion: 1` | recover 尚未用该版本进行逐项兼容检查 |
| 资料库 `artifacts.db` | 当前 store 含按字段判断并执行 DDL 的既有逻辑 | 本轮只复制，未引入显式存储版本；其既有隐式升级应另行审核，不能算作本轮已解决 |
| 其他 Desktop 受管元数据 | 需逐项盘点现有身份、版本和读取行为 | 未盘点前不统一标为 V1 |
| 内置服务配置与数据分区 | 不直接回灌 | 由服务自己确定重建／恢复责任；有业务数据时需逐项列清，不能因本轮排除就认定可丢弃 |
| 浏览器 profile、缓存、PID、活动升级现场 | 不恢复为新运行状态 | 完整旧根内仍有备份 |

### 3.4 四种“版本”必须区分

| 版本 | 用途 | 不能代替什么 |
| --- | --- | --- |
| 应用发布版本 | 发布物定位、构建诊断、审计 | 不能代替存储兼容判断 |
| 每类数据的 Schema 版本 | 识别结构、判断是否可读或需转换 | 不能由目录名、包版本或“最新版本”推断 |
| `runtimeRecovery` 契约 V1 | Desktop 与 Platform 离线恢复调用协议 | 不代表所有数据都是 V1 |
| Desktop 重置请求 schema 2 | 本机恢复事务记录的结构 | 不代表 Chat、Desktop profile 或资料库升级为 V2 |

本轮没有新增历史 Schema 转换器。当前代码仍存在两层不符合后续方向的限制：Desktop 比较源运行根发布标记与目标 bundle 版本；Platform 以固定 `SupportedVersion` 检查源和目标运行根。这些事实尚未修正，不应在审核时误认为已经按各类 Schema 判兼容。

## 4. 已确定的职责规范

| 所有者 | 负责 | 边界 |
| --- | --- | --- |
| Desktop | 主窗口交互、受限 IPC、品牌路径、包校验、独占维护、停服、整根备份／发布／回退、Desktop 自有数据 | 不读取或修改 Platform 表结构、JSONL 语义、资源定义或迁移规则 |
| Agent Platform | 自有结构身份与版本、只读检查、必要转换、资源冲突、关联完整性、恢复报告 | 不控制 Electron profile，不接管 Desktop 的 journal，不解析 Desktop 业务数据 |
| 其他内置服务 | 各自配置、密钥及服务持久数据的重建／恢复 | Desktop 不修补其 `.env`、YAML 或内部数据库 |
| WebClient | 展示恢复结果对应的数据、历史和附件入口 | 不实现另一套存储迁移器 |
| 打包链路 | 固化已验证的程序、manifest 与完整性信息 | 不在运行目录手改生成物来冒充上游交付 |

TEAM 仍是普通 Agent mode，不能借恢复工作重新增加独立 Team 身份、列表或旧字段转换。恢复也不能改变云端数据的权威归属，或从历史记录重新授予执行和 Run 控制权限。

## 5. 后续 Schema 版本规范

以下是用户已经明确的治理方向；具体结构清单、版本标识落点和旧数据处置必须在审核后逐项落实。

### 5.1 每种受管结构独立管理

1. 为每一种需要解释内容的持久结构记录：稳定身份、当前写版本、明确可读版本、校验器、责任模块和支持路径。
2. SQLite 复用该领域的结构身份与 `user_version`，不另造一份与它可能冲突的恢复版本号。
3. JSON／YAML／JSONL 等结构需要明确版本标识及归属。是否使用字段、文件头或受控元数据，由格式所有者审核；不提前给每条历史记录加字段。
4. 普通二进制、用户 Markdown、任意附件正文等按不透明内容保留；其受管索引或 manifest 需要版本，不能为任意用户文件强加业务 Schema。
5. 恢复报告可以汇总各模块声明，但版本常量、DDL 和格式规则继续由各结构所有者维护，不在 Desktop 建第二套业务 Schema 注册表。

### 5.2 结构变更必须显式升版

1. 改变持久化字段、表／索引／约束或读取语义时，必须说明影响并更新相应结构版本；不能长期出现“都叫 V1，但结构不同”。
2. 纯 UI、注释或不影响持久结构的实现调整不因此升级 Schema。
3. 升版时同时更新写入器、读取／恢复校验器、测试样本和支持范围说明，避免运行时与 recover 接受不同的结构。
4. 不把缺少版本标记的数据直接当成 V1，也不根据应用版本推断它属于哪个 Schema。
5. 如需认领“无标记但精确匹配某结构”的数据，这也是一条独立兼容路径，必须明确条件和写入边界；不能当成默认 fallback。

### 5.3 支持范围必须逐项列清

| 情况 | 目标规则 |
| --- | --- |
| 发布号不同，受管结构身份、Schema 和校验均匹配 | 允许恢复，不因发布号不同而拒绝 |
| 发布号相同，任一必要 Schema 不受支持 | 拒绝，报告具体结构与版本 |
| Schema 数字相同，但实际结构不符合该版本定义 | 明确结构冲突，不猜测补列或删除字段 |
| 缺少标记、未来版本或未知结构 | 明确未支持；保留源和诊断 |
| 用户文件无需结构解释 | 原样保留；不宣传为已验证业务兼容 |
| 实际需要转换 | 仅运行经审核的具体源 Schema → 目标 Schema 路径 |

仍保留与业务兼容无关的校验：bundle 平台和完整性、env 包与所选发布物自身的一致性、manifest 调用能力，以及未完成事务对冻结输入的绑定。跨应用版本恢复不意味着可以换包后盲目续跑旧事务。

### 5.4 控制迁移代码规模

1. 默认只承诺当前已定义的结构；需要支持旧结构时先列出具体路径，不自动支持全部历史版本。
2. 不预建 V1→V2→V3 的自动链路；示例中的版本关系不是获准实现的迁移任务。
3. 不增加未被需求证明的插件化迁移引擎、动态发现或多套兼容配置。
4. 每条转换需说明保留、删除或重建的内容、不可恢复项、失败行为、测试样本及退出条件。
5. 到达退出条件后，一并删除转换分支、专用测试与旧文档，不留下永久 fallback。
6. 新代码优先复用领域现有校验器与结构常量；不得为了 recover 再抄一份可能漂移的结构定义。
7. 不通过默认清空、重建空数据库、静默跳过用户数据来宣告恢复成功。

## 6. 当前缺口与额外审核重点

| 编号 | 当前事实／待核对项 | 后续目标 | 责任方 |
| --- | --- | --- | --- |
| G1 | 应用版本仍是恢复门禁 | 去掉对数据兼容的替代判断，保留发布物与事务输入绑定 | 两仓库 |
| G2 | JSONL 等受管结构没有明确独立版本 | 建立版本与无标记数据政策；不自动认领 | Platform |
| G3 | sidecar、资源定义及多类状态只复制或由启动读取器处理 | 列清离线校验覆盖与未支持项 | 对应所有者 |
| G4 | 恢复前后检查覆盖不对称 | 源、候选及完成重试使用一致的必要结构检查，明确不透明内容例外 | Platform、Desktop |
| G5 | 核心服务健康不等于所有业务数据均可读取 | 明确用户数据恢复验收，避免把服务启动成功当作全面兼容证明 | 两仓库、WebClient |
| G6 | Desktop 服务数据分区整体不回灌；其他服务的业务恢复清单未完整列出 | 逐服务区分可重建配置与不可丢业务数据，不能由 Desktop 猜测 | 各服务 |
| G7 | 自动化 loader 会跳过无效定义 | 报告有效、暂停、无效、未恢复项；审核成功标准 | Platform |
| G8 | 中断的 Platform 候选要求重建，Desktop 发布步骤可显式续跑 | 保持两种恢复语义清晰；不扩展成另一套自动迁移状态机 | 两仓库 |
| G9 | 当前先恢复候选，后整根备份切换 | 审核是否接受当前顺序，或要求严格备份在先 | Desktop |
| G10 | 资料库仍有既有按字段推断的 DDL 调整 | 另审其显式 Schema 版本及升级入口，不把既有隐式逻辑继续扩大 | Desktop 资料库模块 |
| G11 | 路径与复制检查不等于内容和关联完整性检查 | 逐项确认 Chat／Run／资源引用、附件和产物校验范围；明确已有损坏的处理 | Platform |
| G12 | 源只读目标需覆盖 SQLite 残留 WAL／SHM 等真实现场 | 验证一致性与辅助文件行为，不仅以主 DB 字节不变证明整棵源目录未变化 | 各存储所有者 |

上述项目有的是已经确认的缺口，有的是需要额外测试的审核点；本文没有把未验证的风险直接认定为已经发生的故障。

## 7. 后续实施 Plan

### P0：先修正兼容判断的依据

- [ ] 审核并确认本文的现状、边界、备份顺序和数据支持清单。
- [ ] 删除 Platform 用 `SupportedVersion` 决定数据恢复兼容的逻辑；报告中将发布诊断与 Schema 信息分开。
- [ ] 删除 Desktop 以源运行根发布号等于目标 bundle 发布号作为数据兼容依据的判断。
- [ ] 保留包完整性、平台、调用契约以及活动事务冻结输入的一致性约束，并区分相关错误原因。
- [ ] 用已有结构校验接管准入；没有被版本与规则覆盖的受管结构继续明确标为未支持，不能因去掉发布号门禁就自动放宽。
- [ ] 增加“发布号不同／Schema 相同”和“发布号相同／Schema 不同”的对照测试。
- [ ] 同步修正两个仓库目前按应用发布号描述恢复支持范围的设计文字。

### P1：完成结构清单和检查覆盖

- [ ] Platform 逐项盘点 JSONL、排序／置顶／主要聊天、artifact manifest、资源定义、Memory、知识库、自动化定义、预览和凭据状态。
- [ ] Desktop 逐项盘点 profile、资料库、皮肤／网站桥安装记录、Webs／Plugins 配置、桌宠状态、设备身份、凭据及引导记录。
- [ ] 各内置服务列出自身 config／data／state 中不可丢的内容及恢复责任。
- [ ] 每项分别填写“已有版本／缺少版本／不透明内容”，不要统一宣称 V1。
- [ ] 对已有版本的结构，优先复用所属模块的校验器，补齐候选与完成重试检查。
- [ ] 审核资源无效项、关联缺失和损坏内容的报告及成功判定。
- [ ] 将相关长期规范写回 `docs/`；精确字段和常量继续放源码、contract 与测试。

### P2：为缺少版本的受管结构建立契约

- [ ] 每类结构分别选择版本标识落点，避免为所有格式一次性设计统一存储框架。
- [ ] 明确新写入的数据从哪个 Schema 开始，版本由谁写入和读取。
- [ ] 明确现存无标记数据如何处理；未经确认不补标、不当作 V1、不批量重写历史。
- [ ] 审核资料库既有隐式 DDL 调整，以及其他模块可能已有的默认升级／重建行为。
- [ ] 新增版本标识时验证不会破坏已有严格解析器、归档／导出和第三方资源契约。

### P3：仅按真实需求增加迁移路径

- [ ] 提交具体数据结构的源 Schema → 目标 Schema 清单，说明实际必要性。
- [ ] 由用户确认支持路径和范围，未确认的历史版本继续拒绝。
- [ ] 由数据所有者实现转换，保持源备份不变、目标隔离、失败可追踪。
- [ ] 给每条路径记录可读／转换／拒绝策略、样本和移除条件。
- [ ] 不预先创建当前并不需要的迁移器。

### P4：联合验收和交付

- [ ] macOS 与 Windows 分别验证真实安装包、停服、占用、空间、权限、中断、续跑和整根回退。
- [ ] WebClient 验证活动／归档 Chat、附件、产物、排序、置顶、主要聊天及项目 Agent 关联。
- [ ] 验证恢复后不重复创建引导 Chat／Sites，不自动重放 Run 或启用已暂停的自动化。
- [ ] 验证凭据文件保留与实际认证可用性是两个步骤，不扩大读取或执行授权。
- [ ] 更新完整程序包、manifest、资源锁／指纹并通过正式同步链路交付；不手改生成目录。
- [ ] 再次报告完整检查结果与剩余限制，按经审核的支持矩阵发布。

## 8. 后续需要修改的入口

| 工作 | Desktop | Agent Platform／其他所有者 |
| --- | --- | --- |
| 去掉应用版本的数据准入门禁 | `src/main/modules/services/runtime-recovery.ts` | `internal/runtimerecovery/recovery.go` |
| Schema 检查和报告 | shared contracts 与展示只消费结果 | `runtimerecovery` 编排；chat／mailbox／automation 等模块提供权威校验 |
| JSONL 版本规范 | 不编写解析／转换逻辑 | `internal/chat/jsonl_schema.go`、写入与读取入口、归档相关代码；具体标识方案待审 |
| sidecar 与 artifact 元数据 | 不合并 Platform 状态 | Platform 对应 order／pinned／primary／artifact 模块 |
| Desktop 数据版本 | profile、artifacts、settings、webs、credentials、pet 等各所属模块 | Platform 不处理 |
| 服务配置与业务数据 | 只传约定的生命周期参数和受控路径 | 对应服务自己的 deploy／存储模块 |
| 用户交互和验证结果 | startup、settings、恢复遮罩、IPC、文案、QA | WebClient 仅补必要的显示与错误消费 |

本表是责任入口，不是授权一次性重写表中全部模块。

## 9. 需要逐项填写的兼容路径审核单

每个确实需要新增兼容的结构使用一份简短记录；未知项写“待确认”，不能用应用发布版本或“所有旧版”代填。

| 项目 | 必填内容 |
| --- | --- |
| 结构身份与所有者 | 具体数据结构、存储位置、权威模块 |
| 源 Schema | 精确版本；无标记时明确写无标记及识别条件 |
| 目标 Schema | 精确版本及当前写入格式 |
| 处理方式 | 直接验证复制／明确转换／拒绝／只在备份保留 |
| 数据影响 | 保留、变更、重建和不支持的内容；关联与授权影响 |
| 失败与重试 | 源是否不变、候选如何保留或重建、如何避免重复副作用 |
| 验证证据 | 有效样本、损坏样本、未来版本、缺标记、两平台结果 |
| 支持期限 | 兼容代码的保留理由、退出条件及删除范围 |
| 用户审核 | 是否已经确认实现该路径 |

当前本轮新增的跨 Schema 转换路径清单：**空**。

## 10. 已有验证证据与未完成验收

这些是本轮实施时的检查记录，不能视为后续 Schema 治理已通过验收，也不代表当前其他工作分支的全部改动都已验证。

| 检查 | 本轮结果 |
| --- | --- |
| Desktop 恢复、界面、启动门禁及退出相关测试 | 54 通过，1 项 Windows 专属检查在本机跳过 |
| 核心服务强制重装与普通启动保持原行为的定向测试 | 3 通过 |
| Main／renderer 构建、类型检查、架构、i18n | 通过；存在既有非阻断大小提示 |
| Platform 恢复、Chat、Automation、Mailbox、CLI 定向测试 | 通过 |
| Unix deploy 转发与错误传播 | 通过 |
| Windows 恢复模块交叉编译 | 通过；不等于 Windows 脚本、ACL 或安装包实机测试 |
| 真实 macOS 程序包离线恢复冒烟 | 活动 Chat、归档、Mailbox、附件、Desktop 数据、自动化暂停及整根回退通过 |
| 本机资源交付 | 已通过正式入口构建并同步 darwin/arm64 Platform 包；未完成 Windows 正式包验收 |
| 全量 renderer 文本断言 | 61 项失败，与 Git HEAD 源码基线对照相同；未把该结果报为全量通过 |
| 设置页相关扩大检查 | 遇到企业聊天默认地址断言失败，不在本轮修改范围 |
| Platform 全量 `go test ./...` | 遇到 `internal/hostenv` 的 npm 探测超时，未报为全量通过 |

本轮测试没有证明“所有被复制对象均已完成 Schema 兼容检查”。后续必须补充：相同 Schema 跨发布号、未知／缺标记／同号不同结构、全部必要目标结构检查，以及真实 Windows 回归。

## 11. 审核结论填写区

- [ ] 接受／要求调整当前候选恢复、整根备份与发布的先后顺序。
- [ ] 接受每类数据独立 Schema 版本作为兼容依据，去掉应用发布号的数据门禁。
- [ ] 确认当前严格校验、仅复制、运行时才校验和明确不支持的分类。
- [ ] 确认哪些无标记受管结构需要优先建立版本，及旧数据处理政策。
- [ ] 确认 Desktop／Platform／其他服务各自恢复责任，特别是被排除的服务业务数据。
- [ ] 确认资源包覆盖、自动化暂停、无效定义报告和关联损坏的处理。
- [ ] 确认新增兼容必须先提交具体路径审核单，不预建全历史迁移链。
- [ ] 确认 Windows 实机及正式包验收完成前的交付范围。

审核意见、获准的具体迁移路径及后续实施结果在此计划中追加；未经审核的提案不写成已交付能力。

## 附录 A：本轮完整变更文件清单

以下文件清单以两个已提交 commit 为准，便于逐项查看 diff。

### Desktop：`77f605e6`

- [docs/启动初始化与恢复.md](../docs/启动初始化与恢复.md)
- [docs/数据目录.md](../docs/数据目录.md)
- [docs/服务生命周期.md](../docs/服务生命周期.md)
- [qa/manual-regression.md](../qa/manual-regression.md)
- [src/main/app/ipc-registration-contracts.ts](../src/main/app/ipc-registration-contracts.ts)
- [src/main/app/lifecycle/runtime-reset-recovery.ts](../src/main/app/lifecycle/runtime-reset-recovery.ts)
- [src/main/app/lifecycle/runtime-reset.ts](../src/main/app/lifecycle/runtime-reset.ts)
- [src/main/app/lifecycle/startup-assembly.ts](../src/main/app/lifecycle/startup-assembly.ts)
- [src/main/app/lifecycle/startup-restore.ts](../src/main/app/lifecycle/startup-restore.ts)
- [src/main/app/lifecycle/startup.ts](../src/main/app/lifecycle/startup.ts)
- [src/main/app/runtime.ts](../src/main/app/runtime.ts)
- [src/main/infrastructure/filesystem/runtime-env-reset-transaction.ts](../src/main/infrastructure/filesystem/runtime-env-reset-transaction.ts)
- [src/main/modules/services/index.ts](../src/main/modules/services/index.ts)
- [src/main/modules/services/manager/command-runner.ts](../src/main/modules/services/manager/command-runner.ts)
- [src/main/modules/services/manager/manager-contracts.ts](../src/main/modules/services/manager/manager-contracts.ts)
- [src/main/modules/services/manager/startup-pipeline.ts](../src/main/modules/services/manager/startup-pipeline.ts)
- [src/main/modules/services/runtime-recovery.ts](../src/main/modules/services/runtime-recovery.ts)
- [src/main/modules/settings/ipc.ts](../src/main/modules/settings/ipc.ts)
- [src/main/support/manifest/manifest-desktop.ts](../src/main/support/manifest/manifest-desktop.ts)
- [src/preload/index.ts](../src/preload/index.ts)
- [src/renderer/app-shell/AppShell.tsx](../src/renderer/app-shell/AppShell.tsx)
- [src/renderer/app-shell/DesktopShutdownOverlay.tsx](../src/renderer/app-shell/DesktopShutdownOverlay.tsx)
- [src/renderer/app-shell/startup/StartupGate.tsx](../src/renderer/app-shell/startup/StartupGate.tsx)
- [src/renderer/pages/settings/SettingsPage.tsx](../src/renderer/pages/settings/SettingsPage.tsx)
- [src/shared/contracts/desktop-api.ts](../src/shared/contracts/desktop-api.ts)
- [src/shared/contracts/manifest.ts](../src/shared/contracts/manifest.ts)
- [src/shared/contracts/startup.ts](../src/shared/contracts/startup.ts)
- [src/shared/i18n/dictionaries/enUS.ts](../src/shared/i18n/dictionaries/enUS.ts)
- [src/shared/i18n/dictionaries/zhCN.ts](../src/shared/i18n/dictionaries/zhCN.ts)
- [test/renderer-build.test.mjs](../test/renderer-build.test.mjs)
- [test/runtime-recovery-ui.test.mjs](../test/runtime-recovery-ui.test.mjs)
- [test/runtime-reset.test.mjs](../test/runtime-reset.test.mjs)
- [test/service-manager.test.mjs](../test/service-manager.test.mjs)

### Agent Platform：`c0db391e`

- [cmd/agent-platform/main.go](../../agent-platform/cmd/agent-platform/main.go)
- [cmd/agent-platform/runtime_recovery.go](../../agent-platform/cmd/agent-platform/runtime_recovery.go)
- [docs/运行时资源迁移.md](../../agent-platform/docs/运行时资源迁移.md)
- [internal/automation/recovery.go](../../agent-platform/internal/automation/recovery.go)
- [internal/chat/recovery.go](../../agent-platform/internal/chat/recovery.go)
- [internal/mailbox/recovery.go](../../agent-platform/internal/mailbox/recovery.go)
- [internal/runtimerecovery/layout.go](../../agent-platform/internal/runtimerecovery/layout.go)
- [internal/runtimerecovery/recovery.go](../../agent-platform/internal/runtimerecovery/recovery.go)
- [internal/runtimerecovery/recovery_test.go](../../agent-platform/internal/runtimerecovery/recovery_test.go)
- [internal/runtimerecovery/space_unix.go](../../agent-platform/internal/runtimerecovery/space_unix.go)
- [internal/runtimerecovery/space_windows.go](../../agent-platform/internal/runtimerecovery/space_windows.go)
- [scripts/release-assets/manifest.template.json](../../agent-platform/scripts/release-assets/manifest.template.json)
- [scripts/release-assets/program/unix/deploy.sh](../../agent-platform/scripts/release-assets/program/unix/deploy.sh)
- [scripts/release-assets/program/unix/program-common.sh](../../agent-platform/scripts/release-assets/program/unix/program-common.sh)
- [scripts/release-assets/program/windows/deploy.ps1](../../agent-platform/scripts/release-assets/program/windows/deploy.ps1)
- [scripts/release-assets/program/windows/program-common.ps1](../../agent-platform/scripts/release-assets/program/windows/program-common.ps1)
- [scripts/release-assets/program/windows/program-common_test.ps1](../../agent-platform/scripts/release-assets/program/windows/program-common_test.ps1)
- [scripts/test-program-deploy.sh](../../agent-platform/scripts/test-program-deploy.sh)

## 附录 B：阅读入口

- Desktop：[启动初始化与恢复](../docs/启动初始化与恢复.md)、[服务生命周期](../docs/服务生命周期.md)、[数据目录](../docs/数据目录.md)、[手工回归](../qa/manual-regression.md)。
- Platform：[运行时资源迁移](../../agent-platform/docs/运行时资源迁移.md)、[会话存储与回放](../../agent-platform/docs/会话存储与回放.md)。
- 数据结构的精确版本、字段与运行行为继续以各自源码及测试为准，本文的现状表是一份有提交基线的审核快照。
