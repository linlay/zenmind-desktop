# Kanban Issue Card 自适应宽度 Design QA

## Evidence

- source visual truth path: `/Users/linlay/.codex/attachments/ffa33cd3-7078-43f6-97f6-b7b47bf82786/image-2.png`
- implementation screenshot path: `/private/tmp/kanban-card-adaptive-implementation.png`
- combined comparison path: `/private/tmp/kanban-card-adaptive-comparison.png`
- viewport: `1440 × 900` CSS px，暗色主题，五个 Kanban 大状态列
- source pixels: `1006 × 718`
- implementation pixels: `1440 × 900`
- comparison pixels: `2728 × 900`
- density normalization: 两张证据分别按比例放入 `1360 × 900` 面板，使用深色留白而不拉伸；中间保留 8px 间隔
- state: Backlog、Todo、In Progress、In Review、Completed 各两张卡片；Todo 同时覆盖负责人→真人/智能体执行者。浏览器额外检查了 `1080 × 900` 最窄横向滚动状态和 Todo hover 状态
- rendering note: QA 页面直接加载生产 `styles.css`、Ant Design 图标和与 `IssueCardContent` 一致的 DOM class；组件逻辑、生产/开发数据守卫和权限由定向源码测试覆盖

## Full-view comparison evidence

组合图中，实施结果延续参考图的暗色五列结构、Stage 单色顶边进度轨、项目/细分 Status 头部、内容区与 Footer 分隔线以及按大状态变化的 Footer 字段。根据用户最新纠正，卡片没有锁成 200px 最大宽度：在 1440px 视口中首张 Todo 卡实测 `266.203125px`，随列宽撑满；在 1080px 视口中卡片为 `200px`、列为 `216px`，横向容器 `clientWidth=1080`、`scrollWidth=1096`，说明 200px 只作为最小宽度生效。

页面没有 Stage 图例，`legendCount=0`。卡片继续自然高度：不同标题、Backlog 描述和 Footer 内容形成不同高度，没有等高拉伸。

Required fidelity surfaces:

- Fonts and typography: 项目与细分 Status 为 10px，标题为 12px 常规字重，描述为弱化 10px；样式扫描不含小数字号。中文重要程度保持“关键/重要/普通/低”，英文卡片改用 `Crit./Imp./Norm./Low`，完整词保留给 tooltip 与非紧凑界面。
- Spacing and layout rhythm: 卡片在正常列宽下 100% 撑满，窄屏时守住 200px；Footer 最多两行。Todo 的序号与标题同行，人员与操作按钮同行，未出现查看按钮独占一行。
- Colors and visual tokens: 大状态列继续使用中性色；Stage 颜色只出现在单色顶边进度和小 Status 标记，不再重复绘制管理端 Stage 图例。
- Image quality and asset fidelity: QA 使用现有 Ant Design `UserOutlined`、`RobotOutlined`、`EyeOutlined` 以及产品现有头像/首字母表现，没有用自绘图标替代。开发模式的云端演示人员补位覆盖真人与智能体；生产构建不伪造人员。
- Copy and content: `P1 ｜ 关键`、`已进行`、`截止`、`完成`、审核中细分 Status 与已完成右上角最终 Status 均符合已确认的信息架构；没有百分比、设置按钮、重复“已验收通过”或活跃度趋势文案。

## Focused region comparison evidence

- Responsive width: `1080 × 900` 下 `cardWidth=200`、`columnWidth=216`、`columnsScrollWidth=1096`；`1440 × 900` 下 Todo 卡宽 `266.203125`，证明卡片是“最小 200px + 平时撑满列”，不是最大 200px。
- Hover layout: Todo 首卡 hover 前后均为 `266.203125 × 119`，Footer 均为 2 行；人员区域前后都为 `x=317.1953125, y=159, width=209.203125, height=20`。操作区 opacity 从 `0` 变为 `1`，没有尺寸或位置跳动。
- Footer density: 全图中负责人、执行者/审核人、进行时长、截止信息均落在分隔线下最多两行；详情按钮在默认态隐藏，出现时与现有 Footer 内容同行。
- Console: 本地浏览器渲染没有 error 或 warning。

## Findings

没有剩余可执行的 P0、P1 或 P2 视觉问题。

P3 后续观察项：真实云端头像的裁剪质量仍取决于上游 `avatarUrl`；开发演示数据使用现有首字母/真人/智能体图标回退，不影响生产数据语义。

## Comparison history

1. 初始实现尝试把卡片设置为 `max-width: 200px` 并在列内居中。用户指出这是错误约束：卡片应自适应撑满列，200px 只是最小宽度。该问题按 P2 响应式布局偏差处理。
2. Fix: 删除 `max-width` 与列内居中，保留 `width: 100%`，将 `.issue-card` 改为 `min-width: 200px`；列最小宽度保持 216px，以容纳两侧各 8px padding。
3. Post-fix evidence: 1440px 视口卡片扩展到 266.203125px；1080px 视口卡片恰为 200px并触发横向滚动。重新截图并生成组合比较图后，无新增 P0/P1/P2 问题。

## Open Questions

- None. 最新的自适应宽度规则已经由用户明确确认。

## Implementation Checklist

- [x] 卡片默认撑满列，最小宽度 200px。
- [x] 列最小宽度 216px，窄屏使用横向滚动。
- [x] 删除页面 Stage 图例，仅保留卡片顶边单色进度。
- [x] 卡片重要程度读取 i18n 短文案。
- [x] Todo/Completed 无人员时不生成仅含详情按钮的独立 Footer 行。
- [x] 开发演示云端卡片可显示负责人、执行者或审核人，生产不伪造数据。
- [x] hover 前后人员、卡片尺寸和 Footer 行数不变。

## Follow-up Polish

- P3: 使用一份包含真人头像 URL、真人执行者和智能体执行者的真实云端快照，再观察 200px 最窄态下的头像裁剪与姓名截断。

final result: passed
