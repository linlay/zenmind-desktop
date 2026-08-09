# Kanban Column Header 与卡片密度 Design QA

## Evidence

- source visual truth path: `/var/folders/55/s3kqdyn95hvdh736dhw502200000gn/T/codex-clipboard-83a741c8-2ccc-4adc-89dd-4d0db01165df.png`
- implementation screenshot path: `/private/tmp/kanban-column-header-implementation-final.jpg`
- combined comparison path: `/private/tmp/kanban-column-header-comparison-final.jpg`
- viewport: `1280 × 720` CSS px，暗色主题，五个 Kanban 大状态列
- source pixels: `2232 × 640`
- implementation pixels: `1280 × 720`
- comparison pixels: `2568 × 720`
- density normalization: source 按比例缩放到 `1280 × 367` 并在 `1280 × 720` 深色面板内居中；implementation 保持 `1280 × 720`，两块面板横向并排且不拉伸
- state: Backlog、Todo、In Progress、In Review、Completed 各两张卡片；同时覆盖负责人、真人/智能体执行者、完成时间、优先级与重要程度
- rendering note: QA 页面加载生产 `styles.css`、Ant Design 图标和与生产卡片一致的 DOM class；结构测试覆盖真实 `KanbanColumn` 组件中的图标与字段逻辑

## Full-view comparison evidence

参考图中 Column Header 使用偏厚的独立底块、圆角外框、数量胶囊和常驻方形加号按钮，视觉重量接近 Issue Card。最终实施将 Header 改成透明、直角、40px 高的连续横向结构，标题与卡片内容左边缘对齐，数量变成紧邻标题的弱化数字，加号默认只有图标。Card 仍保持自己的 10px 圆角，因此列结构和内容结构的层级更加清楚。

Column Body 的 padding 与卡片间 gap 都由 8px 收紧到 4px；五列仍保持共享分隔线，没有增加新边框。Stage 顶边进度轨从 3px 收细到 2px。暗色模式下卡片实测背景为 `rgb(24, 24, 24)`，即用户指定的 `#181818`。

Required fidelity surfaces:

- Fonts and typography: Header 标题为 12px / 700，数量为 10px / 600；保留现有系统字体，不与 12px 常规字重的卡片标题争夺层级。长列名仍可省略，数量使用 tabular numerals。
- Spacing and layout rhythm: Header 高 40px；Column Body `padding: 4px`、`gap: 4px`。1280px 视口下首列宽 `251.1953125px`，首卡宽 `243.1953125px`，卡片随列撑满。
- Colors and visual tokens: Header、数量和加号默认背景均为透明；暗色 Issue Card 与拖拽镜像统一使用 `#181818`。Stage 颜色继续只承担工作流语义。
- Image quality and asset fidelity: 加号改用现有 Ant Design `PlusOutlined`，没有使用文本字符、自绘 SVG、CSS 图形或占位资源。
- Copy and content: Backlog、Todo、In Progress、In Review、Completed 及数量语义保持不变，没有引入新的解释性文案。

## Focused region comparison evidence

- Header geometry: computed `headerHeight=40`、`columnRadius=0px`、`headerBackground=transparent`、`countBackground=transparent`、`addBackground=transparent`、`addBorder=transparent`。
- Card density: computed `bodyPadding=4px`、`bodyGap=4px`、`railHeight=2px`、`cardBackground=rgb(24, 24, 24)`。
- Responsive width: 在固定 `1040px` 内容区中实测 `cardWidth=200`、`columnWidth=208`、`columnsClientWidth=1040`、`columnsScrollWidth=1056`，证明卡片保持 200px 最小宽度，低于 1056px 后出现 Kanban 整体横向滚动。
- Runtime: 最终全新浏览器页面的 warning/error console logs 为 `[]`，页面无 Vite error overlay。

## Findings

没有剩余可执行的 P0、P1 或 P2 视觉问题。

P3 后续观察项：Header 的 22px 加号点击热区低于常见的 24px 紧凑控件尺寸，但该操作同时支持双击空白列创建，且键盘焦点轮廓清晰；若后续触屏场景增加，可扩大透明 hit area 而不恢复常驻底框。

## Comparison history

1. [P2] 初始 Header 的父级 12px 圆角、数量胶囊和暗色常驻按钮底框形成过多小容器；Column Body 两侧 8px padding 与 8px 卡片间距也削弱了紧凑度。
2. Fix: Column 改为直角；Header 改为透明的 40px 结构；数量移除胶囊；加号使用 `PlusOutlined` 并仅在 hover/focus 时提供反馈；Column Body padding 与 gap 均改为 4px。
3. [P2] 第一轮浏览器截图发现暗色主题的高优先级全局规则仍给加号绘制常驻底框。
4. Fix: 增加暗色主题下的透明背景/边框覆盖并保留 hover 与 focus 反馈；重新打开全新页面截图，最终加号背景和边框计算值均为透明。
5. Post-fix evidence: 最终组合图、几何计算值、1040px 窄态测量与空控制台共同确认没有新增 P0/P1/P2 问题。

## Open Questions

- None. Header 直角、4px 间距、2px 进度轨和 `#181818` 暗色卡片背景均由用户明确指定。

## Implementation Checklist

- [x] Column Header 与 Column 外框使用直角。
- [x] Header 为透明背景、40px 高，标题 12px，数量无胶囊。
- [x] 加号使用现有图标库，默认无底框，hover/focus 仍可感知。
- [x] Column Body padding 与 gap 均为 4px。
- [x] 单列最小宽度 208px，Issue Card 最小宽度 200px。
- [x] Kanban 内容区低于 1056px 后出现整体横向滚动。
- [x] Stage 顶边进度轨为 2px。
- [x] 暗色 Issue Card 与拖拽镜像背景为 `#181818`。

## Follow-up Polish

- P3: 在真实应用窗口中再观察 Windows 稳定滚动槽对最右 Completed 列的 4px 视觉间距影响。

final result: passed
