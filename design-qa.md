# WorkPanel Add Tab Design QA

final result: passed

- Reference: `/var/folders/55/s3kqdyn95hvdh736dhw502200000gn/T/codex-clipboard-051d5cad-1178-40f4-a373-80198b13dfb6.png`
- Implementation capture: `qa/work-panel-design-qa.png`
- Side-by-side comparison: `qa/work-panel-design-comparison.png`
- Review date: 2026-08-25
- Status: Passed

## Sidebar-style refinement (2026-08-25)

- User feedback capture: `/var/folders/55/s3kqdyn95hvdh736dhw502200000gn/T/codex-clipboard-627831c3-aae3-41b7-95bb-3d86e31f96d3.png`
- Updated implementation capture: `qa/work-panel-sidebar-style-qa.png`
- Before/after comparison: `qa/work-panel-sidebar-style-comparison.png`
- Visual source of truth: `--sidebar-operation-menu-*` theme tokens and `.sidebar-account-menu` density in `src/renderer/styles/theme.css` and `src/renderer/styles/navigation.css`

| Priority | Check | Result |
| --- | --- | --- |
| P0 | Menu actions, order, disabled Terminal state, WebApp disclosure and keyboard behavior are preserved | Passed |
| P1 | Surface color, border, blur and shadow now use the left-sidebar operation-menu tokens | Passed |
| P1 | Menu width reduced from 286px to 248px; row height reduced from 42px to 32px | Passed |
| P1 | Item typography is now 14px/400 with 16px icons, 8px item radius and 6px panel padding, matching sidebar density | Passed |
| P2 | Secondary labels and disabled items use the sidebar muted token in both themes | Passed |

The revised menu is visibly lighter and denser while keeping the original `32×32px` add trigger and all WorkPanel-specific actions.

## Verification

| Priority | Check | Result |
| --- | --- | --- |
| P0 | `+` is the final item in the WorkPanel tab strip and opens the add menu | Passed |
| P0 | Menu order is Terminal, Web, Files, Side Chat, Project, WebApp | Passed |
| P0 | Terminal is visibly disabled and labeled as coming soon | Passed |
| P1 | `+` measures exactly 32×32 px with a compact rounded dark-theme treatment | Passed |
| P1 | Menu is anchored below the `+`, remains outside the scroll clipping region, and uses the requested dark popover hierarchy | Passed |
| P1 | Focus enters the first enabled menu item and Escape closes the menu and returns focus to the trigger | Passed |
| P2 | Icons, labels, secondary status text, hover/focus state, and WebApp disclosure affordance remain legible at desktop scale | Passed |

The reference uses a larger captured display scale and a wider native popover. The implementation intentionally follows the existing Desktop WorkPanel typography and tab density while preserving the reference interaction, placement, rounded geometry, and visual hierarchy.

---

# Windows System Bar Design QA

## Evidence

- Source visual truth: `C:\Users\Linlay\AppData\Local\Temp\codex-clipboard-673bd8fe-15f7-4883-b006-33aba3d71d2b.png`
- Rendered implementation: `C:\Project\zenmind\zenmind-desktop\qa\windows-systembar-devtools.png`
- Combined focused comparison: `C:\Project\zenmind\zenmind-desktop\qa\windows-systembar-comparison.png`
- Full implementation capture before DevTools: `C:\Project\zenmind\zenmind-desktop\qa\windows-systembar-implementation.png`
- Viewport and state: Windows light theme, Kanban route, isolated QA profile. The initial renderer viewport was `1490 × 968` CSS px. After the real `Ctrl+Shift+I` shortcut opened the main renderer DevTools at the bottom, the renderer viewport was `1490 × 668` CSS px and the system bar remained `1490 × 30` CSS px.
- Pixel dimensions and density normalization: source `1956 × 114` px; implementation before DevTools `1862 × 1210` px; implementation with DevTools `1862 × 835` px. The implementation was captured at device scale factor `1.25`, then normalized to `1490` px width for the focused comparison. The source and implementation top rows were placed in the same `1490 × 164` comparison image.
- Runtime evidence: a `devtools://devtools/bundled/devtools_app.html` target appeared after the shortcut; the main renderer stayed on `#/kanban`. No renderer console messages or runtime exceptions were observed during capture.
- The isolated QA window loaded the live Kanban shell and existing desktop data; no startup overlay covered the system bar during the final capture.

## Findings

- No actionable P0, P1, or P2 visual differences were found for the requested system-bar behavior.
- The implementation preserves the reference's important structure: one thin full-width top row, product identity at the left, Windows window controls at the far right, a quiet divider below, and all application content beginning beneath the row.
- P3, intentional product adaptation: the reference contains browser/navigation and menu commands. ZenMind shows its existing brand mark and product name instead because there are no equivalent top-level menu actions in this product. Adding non-functional reference commands would reduce clarity.

## Required Fidelity Surfaces

- Fonts and typography: the product label uses the existing Windows/system font stack at `11px`, medium weight, and muted color. It remains legible without competing with the business navigation below.
- Spacing and layout rhythm: the refined bar is exactly `30px` high; icon/name alignment, `10px` horizontal padding, `42px` window-control hit areas, and the one-pixel divider form a lighter Windows-like rhythm. Sidebar and content begin below the bar with no double inset.
- Colors and visual tokens: the bar uses `--bg-base`, `--ink`, `--ink-muted`, `--line`, and the existing hover token. Light capture is visually consistent with the reference's neutral title row; dark mode inherits the established ZenMind theme tokens.
- Image quality and asset fidelity: the visible logo is the existing `BrandMark` source asset. Window controls use Ant Design icons already present in the product; no inline SVG, CSS drawing, emoji, or placeholder asset was introduced.
- Copy and content: only the real product name, `ZenMind`, is shown. Accessible labels for the system bar and minimize/maximize/restore/close controls are localized in Chinese and English.

## Interaction Evidence

- A real `Ctrl+Shift+I` input was dispatched to the running main renderer. It opened main Electron DevTools at the bottom, reduced renderer height from `968` to `668` CSS px, and left the `1490 × 30` system bar unchanged at the top.
- Source and unit tests confirm that the same shortcut received while an attached webview is focused is routed to the main renderer.
- `Ctrl+Shift+D` remains implemented and tested only in `focused-webview-devtools.ts`; that code was not changed.
- Minimize, maximize/restore, close-to-tray, authorization, maximize-state updates, and modal masking are covered by main/preload/renderer source checks and focused unit tests.

## Comparison History

- Iteration 1: compared the source top bar and the running implementation in the same normalized focused image. No P0/P1/P2 issue was identified, so no visual fix/re-capture iteration was required.
- Iteration 2: refined the accepted system bar from `36px` to `30px`, with proportionally smaller brand, label, controls, padding, and gaps. Re-captured the running implementation and confirmed the slimmer rhythm without overlap or duplicated inset.

## Implementation Checklist

- [x] Independent thin Windows system bar.
- [x] Renderer-owned minimize, maximize/restore, and close controls with restricted IPC.
- [x] Main renderer DevTools routed from both main and guest focus and docked below the bar.
- [x] Current-focus webview DevTools shortcut unchanged.
- [x] Main content, Help, and app-surface offsets avoid duplicated titlebar spacing.
- [x] Light-theme runtime capture, focused comparison, interaction check, console check, typechecks, production builds, and focused tests completed.

final result: passed
