# Kanban Issue Card Design QA

- Source visual truth: `/private/tmp/kanban-card-source.png`
- Real Desktop capture: `/private/tmp/zenmind-kanban-implementation-reloaded.png`
- Full-view comparison: `/private/tmp/kanban-card-comparison.png`
- Focused card comparison: `/private/tmp/kanban-card-focused-comparison.png`
- Viewports: source preview 1280×720; real macOS Desktop capture 3024×1964
- State: light theme, connected cloud cache, populated Backlog / Todo / In Progress / In Review columns

## Findings

No actionable P0, P1, or P2 differences remain.

- Fonts and typography: the real card preserves the selected hierarchy—project and context are compact, Stage/Status use secondary optical weight, and the issue title uses 14px regular weight with a fixed two-line box. Truncation remains stable on long real-data titles.
- Spacing and layout rhythm: all cards use the same three sections, two subtle dividers, 12px radius, and a 206px minimum height. The real Desktop has less board width because the native sidebar and macOS window frame are present; columns retain their minimum width and overflow horizontally as specified.
- Colors and visual tokens: semantic signal colors and per-column tints follow the existing ZenMind theme tokens. Hover does not scale the card, and no whole-card running animation is present.
- Image and icon fidelity: this component has no raster assets. Stage, Status, state context, assignee, and worker use the established Ant Design icon library; priority and importance reuse the existing product icons.
- Copy and content: the real data correctly substitutes queue numbers and elapsed/updated context for the mock values. Large workflow state names are not repeated inside cards. Empty cloud assignee/worker data leaves no placeholder, while the two footer level values remain aligned without borders or backgrounds.
- Interaction and accessibility: existing detail, chat, delete, drag, read-only, focus-ring, reduced-motion, and cross-platform scrolling paths remain wired. Static regressions cover the personnel-to-actions hover/focus replacement and the 24px action controls.

## Open Questions

- None. The missing assignee/worker values in the real capture reflect the current cloud dataset, not a design mismatch.

## Comparison History

1. The first Desktop capture still showed the pre-change card because the running renderer had not reloaded.
2. The Desktop renderer was refreshed, producing `/private/tmp/zenmind-kanban-implementation-reloaded.png`.
3. The post-refresh full-view and focused comparisons show the selected three-section structure and no remaining P0/P1/P2 mismatch.

## Implementation Checklist

- [x] Five workflow columns keep independent context signals without repeating their large state name.
- [x] Stage and Status use separate icons and hide when empty.
- [x] The issue title uses regular weight and reserves two lines.
- [x] Priority and importance are borderless; assignee and worker share the same footer row.
- [x] Cloud empty people fields do not render placeholders.
- [x] Typecheck, renderer build, Kanban-focused regressions, i18n dictionary-key validation, and real Desktop capture are complete.
- [ ] The repository-wide language-separation check remains blocked by six pre-existing Latin-text warnings outside this change.

## Follow-up Polish

- P3: validate the dark-theme capture and a populated assignee/worker card when those data combinations are available in the running Desktop cache.

final result: passed
