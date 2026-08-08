# Kanban Issue Card Design QA

## Evidence

- source visual truth path: `/Users/linlay/.codex/generated_images/019fe106-255b-7c93-b823-a05be5a77266/exec-700c0059-881b-4c57-8833-9970f654c1d2.png`
- implementation screenshot path: `/private/tmp/kanban-card-implementation.png`
- combined comparison path: `/private/tmp/kanban-card-comparison.png`
- viewport: 1440 × 900 CSS px, dark theme, five desktop Kanban columns
- source pixels: 1487 × 1058
- implementation pixels: 1440 × 900
- CSS size: 1440 × 900; captured at 1× density
- density normalization: the implementation remained 1:1; the source was aspect-fit at 0.851× into a 1440 × 900 comparison panel without stretching, leaving horizontal padding rather than changing proportions
- state: baseline cards for Backlog, Todo, In Progress, In Review, and Completed; additional browser checks covered hover action replacement and keyboard focus

## Full-view comparison evidence

The combined image verifies the same dark five-column information architecture, current-Stage legend, one-color top-border progress rails, project/status header, compact title area, one divider, and status-specific two-row operational footer. The implementation is intentionally denser than the visual reference because the user explicitly requested a more compact card; the hierarchy and field allocation remain the same. Large-status colors are absent from columns and cards, while Stage colors remain confined to the legend, top rail, and small status mark. Completed cards use the granular top-right status and do not repeat a green acceptance line.

Required fidelity surfaces:

- Fonts and typography: system UI fallback matches the existing Desktop design language; project and status are subordinate to the two-line 14px title, and small operational text remains readable at the 252px minimum column width. Title and Backlog description clamps were visible in the capture.
- Spacing and layout rhythm: cards use compact variable height, 8px vertical list spacing, a single footer divider, and at most two footer rows. No card, column, or persistent control overflowed the 1440 × 900 viewport.
- Colors and visual tokens: neutral column/card surfaces match the product theme. Each rail uses one Stage color only; danger red is limited to overdue/failure semantics. Completed cards do not gain a green card treatment.
- Image quality and asset fidelity: the production component consumes real cloud avatar URLs when present and falls back to existing icon/initial treatments. The QA fixture used initials because it does not have authenticated cloud user assets; no product image asset was replaced in source code.
- Copy and content: `审核中`, `已进行`, `P1 ｜ 关键`, inline queue rank, absolute completion time, and `已验证通过` match the approved information architecture. No percent label, gear, duplicate acceptance label, or activity trend was rendered.

## Focused region comparison evidence

- Keyboard focus: `.issue-card-main` reported `focusVisible: true` and computed `outline: none`; its parent card received the neutral two-pixel outer shadow. This confirms the previous yellow outline no longer selects only the upper clickable block.
- Hover layout: before and after hover, the first card's people region remained exactly `x=33, y=279.109, width=178.195, height=20`, and its due region remained `x=222.102, y=258.609, width=52.094, height=12`. The signal opacity changed from visible to `0` and actions to `1`, proving the swap does not move persistent fields.
- Progress rail: the full-view comparison was sufficient because every rail is clearly visible at the card top and each filled region is a single uninterrupted color; no additional crop was needed.

## Findings

No actionable P0, P1, or P2 visual differences remain.

Residual test gap: the standalone browser QA fixture cannot load authenticated cloud avatar images or Electron-only APIs. Avatar URL mapping, cloud read-only behavior, and action permissions are covered by component/contract tests and must still be observed once with live cloud data.

## Comparison history

1. Pre-QA user evidence identified a P2 focus-state defect: keyboard focus drew a thick yellow outline around only the upper detail button, visually suggesting that half the card was selected.
2. Fix: removed the local `.issue-card-main:focus-visible` outline and moved feedback to a neutral shadow around the full `.issue-card` through `:has(.issue-card-main:focus-visible)`.
3. Post-fix evidence: the browser-computed focus state and final screenshot show no local yellow frame; the entire card receives one subtle neutral focus treatment. No further P0/P1/P2 findings were introduced.

## Open Questions

- None for the approved card architecture. Live cloud avatar coverage remains a data-dependent regression check, not a design decision.

## Implementation Checklist

- [x] Keep one current-Stage color in the top-border workflow rail.
- [x] Keep granular Status as plain top-right text without a pill or gear.
- [x] Keep Backlog/Todo priority and importance as `P1/P2/P3 ｜ importance`.
- [x] Keep In Progress and In Review people, elapsed time, due state, and execution/review state within two footer rows.
- [x] Keep Completed limited to completion time and assignee below the divider.
- [x] Swap only the right signal slot on hover/focus without moving persistent fields.
- [x] Apply keyboard focus feedback to the whole card, not the upper clickable region.

## Follow-up Polish

- P3: validate the exact avatar crop and fallback initials with a production cloud snapshot containing both human and agent executors.

final result: passed
