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

## WorkPanel Web Browser Toolbar — Option 2 (2026-08-26)

- Source visual truth: `/var/folders/55/s3kqdyn95hvdh736dhw502200000gn/T/codex-clipboard-9fccdbf6-285b-4fa0-a5e7-5078f243d7ea.png`
- Preserved source copy: `qa/work-panel-browser-toolbar-reference.png`
- Implementation URL: `http://127.0.0.1:4173/qa/work-panel-browser-toolbar-visual.html?theme=light`
- Light implementation screenshot: `qa/work-panel-browser-toolbar-light.jpg`
- Dark implementation screenshot: `qa/work-panel-browser-toolbar-dark.jpg`
- Narrow dark implementation screenshot: `qa/work-panel-browser-toolbar-dark-narrow.jpg`
- Focused side-by-side evidence: `qa/work-panel-browser-toolbar-comparison.jpg`
- Source pixels: `1536 × 1024`; source contains light and dark conceptual states in one image.
- Implementation pixels / CSS viewport / density: `960 × 520` at `960 × 520` CSS px, device density `1`; narrow evidence is `380 × 500` at `380 × 500` CSS px.
- Density normalization: the source is a high-density concept capture, so toolbar crops were compared at a shared column width and judged by normalized control geometry and relative rhythm rather than raw source pixels.
- State: active normal Web WorkPanel item; back enabled, forward disabled, address locked until Edit; light, dark, and narrow dark states checked.

### Findings

- No remaining actionable P0, P1, or P2 differences.
- Fonts and typography: the existing product system font is retained; URL and `编辑` use compact UI weights, stay vertically centered, and truncate without wrapping at narrow width.
- Spacing and layout rhythm: the browser row is `48px` high; naked navigation controls, the thin separator, `30px` pill address field, globe icon, and inline Edit action reproduce the selected option's hierarchy without adding another segmented container.
- Colors and visual tokens: light and dark backgrounds, borders, disabled states, hover fills, and focus accent remain theme-aware and preserve readable contrast.
- Image and icon fidelity: existing Ant Design and product navigation icons are used; no raster substitutes, handcrafted SVGs, emoji, or CSS-drawn visible assets were introduced.
- Copy and content: the address is realistic and `Edit` / `编辑` is localized through the existing dictionaries.
- Accessibility and behavior: controls retain semantic button/textbox roles, labels and focus-visible states; Edit unlocks and selects the address, Escape restores it, Enter normalizes and navigates, and disabled Forward remains exposed correctly.

### Comparison History

1. Initial implementation was blocked by a P1 target-selection mismatch: it implemented option 3 with a segmented navigation container and a separate blue outlined Edit button.
2. Fix: navigation became unboxed with a dedicated vertical separator; Edit moved inside the address pill and adopted neutral theme-aware styling. The row and navigation rhythm were then aligned to the high-density option-2 reference.
3. Post-fix evidence: `qa/work-panel-browser-toolbar-comparison.jpg` shows the reference light/dark toolbar crops and the implementation light/dark toolbar crops together. No P0/P1/P2 visual differences remain after density normalization.

### Focused and Full-view Evidence

- Full-view captures: `qa/work-panel-browser-toolbar-light.jpg`, `qa/work-panel-browser-toolbar-dark.jpg`, and the `380px` narrow dark capture verify the browser row in the mounted WorkPanel shell and its responsive truncation.
- Focused comparison: `qa/work-panel-browser-toolbar-comparison.jpg` isolates the two toolbar states because the embedded web page content is not part of this change and is unavailable inside a regular-browser QA harness.

### Interaction and Runtime Verification

- Edit changes the address input from read-only to editable.
- Escape restores `https://www.baidu.com/` and locks the field again.
- Enter normalizes `example.com` to `https://example.com/` and locks the field again.
- Back and Reload are clickable; Forward is disabled in the captured state.
- Fresh browser QA session: `0` console errors. Two pre-existing React Router v7 future-flag warnings remain and are unrelated to this component.

### Open Questions

- None. The outer WorkPanel tab strip continues to use the product's existing theme tokens; this change intentionally scopes the new light/dark treatment to the requested browser row.

### Implementation Checklist

- [x] Show the row only for normal Web WorkPanel items.
- [x] Match option 2's navigation, separator, address pill, and inline Edit composition.
- [x] Support light, dark, hover, focus, disabled, edit, Escape, Enter, and narrow-width states.
- [x] Preserve existing WebClient, WebApp, local-file, and review surfaces.

final result: passed
