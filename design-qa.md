# Kanban Design QA

## Source truth

- Reference: user-provided current `/kanban` screenshot at `/var/folders/55/s3kqdyn95hvdh736dhw502200000gn/T/codex-clipboard-f2474011-9e83-4db5-9bc3-e0d6c255f0bf.png`.
- Target behavior: the approved five-column, three-section issue-card plan in this task.
- Visual contract implementation: `/Users/linlay/.codex/visualizations/2026/07/19/019f7a93-be02-7f01-816d-0f7904c70f9d/kanban-board-preview`.
- Production implementation: `src/renderer/pages/kanban/KanbanPage.tsx` and `src/renderer/styles/kanban.css`.

## Capture states

| Evidence | Viewport / state | Path |
|---|---|---|
| Wide board | 2048×844, light, all mock issues | `/Users/linlay/.codex/visualizations/2026/07/19/019f7a93-be02-7f01-816d-0f7904c70f9d/kanban-board-preview/preview-final-2048x844.png` |
| Standard desktop | 1440×900, light, five columns visible | `/Users/linlay/.codex/visualizations/2026/07/19/019f7a93-be02-7f01-816d-0f7904c70f9d/kanban-board-preview/preview-1440x900.png` |
| Narrow desktop | 1024×768, light, two-row toolbar and horizontal scroll | `/Users/linlay/.codex/visualizations/2026/07/19/019f7a93-be02-7f01-816d-0f7904c70f9d/kanban-board-preview/preview-1024x768.png` |
| Dark theme | 1024×768, dark | `/Users/linlay/.codex/visualizations/2026/07/19/019f7a93-be02-7f01-816d-0f7904c70f9d/kanban-board-preview/preview-dark-1024x768.png` |

## Comparison evidence

- Full-board comparison input: `/Users/linlay/.codex/visualizations/2026/07/19/019f7a93-be02-7f01-816d-0f7904c70f9d/kanban-board-preview/comparison-full.png`.
- Focused card comparison input: `/Users/linlay/.codex/visualizations/2026/07/19/019f7a93-be02-7f01-816d-0f7904c70f9d/kanban-board-preview/comparison-card.png`.
- The reference was normalized to the 1440px comparison width; both halves use the same light/default board state and comparable visible rows.

## Findings and fix history

1. Initial narrow capture confirmed five 252px columns correctly overflowed, but the first theme-toggle interaction used a brittle accessible-name selector. The interaction was repeated with the stable `aria-label` selector and the dark-state capture passed.
2. The first full comparison capture retained the test search term. The search was cleared with keyboard input, the 15/15 state was verified, and final evidence was recaptured.
3. P0 findings: none.
4. P1 findings: none.
5. P2 findings: none after fixes.
6. P3 note: the running Electron surface was not exposed as an in-app Browser tab, so live cloud-data visual verification remains covered by the updated manual checklist; renderer typecheck, Vite production build, source assertions, and the matching standalone visual contract all passed.

## Interaction and diagnostics

- Search filtered the mock board from 15/15 to 1/15 and produced four column empty states, then returned to 15/15.
- Project filter menu, view settings menu, card detail dialog, theme toggle, and responsive toolbar were exercised.
- 1440px column widths measured 275px with no board overflow. At 1024px, all columns measured 252px and board scroll width exceeded client width as intended.
- Browser logs contained only Vite connection and React DevTools informational messages; no warning or error entries were present.
- `npm run typecheck:renderer` passed.
- Direct Vite production build passed.
- The focused Kanban card regression test passed; two broader Kanban-pattern tests remain failing on unrelated pre-existing sidebar/runtime assertions.

Result: passed

## Issue Detail v2 production integration

### Source truth

- Approved prototype: `/Users/linlay/Project/zenmind/zenmind-desktop/prototypes/kanban-issue-detail-v2/qa/implementation-full-detail-v2-light.png`.
- Production component: `src/renderer/pages/kanban/KanbanIssueDetailDialog.tsx` with scoped styles in `src/renderer/styles/kanban.css`.
- The QA harness mounts the production component and production stylesheet with representative server-shaped Issue detail data; it does not maintain a duplicate UI implementation.

### Capture states

| Evidence | Viewport / state | Path |
|---|---|---|
| Standard comparison | 1280×720, light, local Issue, all details | `/Users/linlay/Project/zenmind/zenmind-desktop/qa/kanban-issue-detail-runtime/comparison-1280x720.png` |
| Focused property rail | Prototype and production, matched crop | `/Users/linlay/Project/zenmind/zenmind-desktop/qa/kanban-issue-detail-runtime/comparison-focused-rail.png` |
| Wide desktop | 2048×844, light, local Issue | `/Users/linlay/Project/zenmind/zenmind-desktop/qa/kanban-issue-detail-runtime/implementation-2048x844.png` |
| Standard desktop | 1440×900, light, local Issue | `/Users/linlay/Project/zenmind/zenmind-desktop/qa/kanban-issue-detail-runtime/implementation-1440x900.png` |
| Narrow desktop | 1024×768, dark, local Issue | `/Users/linlay/Project/zenmind/zenmind-desktop/qa/kanban-issue-detail-runtime/implementation-dark-1024x768.png` |
| Small screen | 720×900, light, local Issue, single-column sheet | `/Users/linlay/Project/zenmind/zenmind-desktop/qa/kanban-issue-detail-runtime/implementation-720x900.png` |
| Cloud boundary | 1440×900, cloud Issue, read-only banner | `/Users/linlay/Project/zenmind/zenmind-desktop/qa/kanban-issue-detail-runtime/implementation-cloud-readonly-1440x900.png` |

### Findings and fix history

1. P0 findings: none.
2. P1 findings: none.
3. First comparison found two P2 visual differences: header actions aligned too low and the first property-rail values looked compressed compared with the prototype. The actions were vertically centered and project/type/workflow/stage values were changed to consistent select-like containers before the final captures.
4. P2 findings after fixes: none.
5. P3 intentional differences: production removes unsupported workflow mutation calls and uses safe actions only; it renders available server/cache sections instead of prototype-only simulated acceptance content. The production modal starts slightly higher because the prototype-only state switcher is not part of `/kanban`.

### Interaction and responsive checks

- The default `全部详情` state exposes all ten real-data-backed sections. `字段` retains only field-related sections; `活动` retains reviews, comments, and the event timeline.
- Local Issue edit mode exposes title, priority, assignee, automation, save, and cancel controls. Cloud Issue state shows `云端只读缓存` and exposes neither edit nor delete.
- At 2048×844 and 1440×900 the dialog is 1180px wide with an 800px/320px content split. At 1024×768 it uses a 596px/320px split with no page overflow. At 720px it becomes a full-width single-column bottom sheet; at 360px the tabs scroll horizontally without page-level overflow.
- Dark theme contrast, long description truncation, independent content/rail scrolling, and mobile card stacking were visually inspected.
- Browser console warnings/errors: none.

final result: passed
