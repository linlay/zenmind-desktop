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
- State: active normal Web WorkPanel item; back enabled, forward disabled, address directly editable, page review inactive; light, dark, and narrow dark states checked.

### Findings

- No remaining actionable P0, P1, or P2 differences.
- Fonts and typography: the existing product system font is retained; URL and `编辑` use compact UI weights, stay vertically centered, and truncate without wrapping at narrow width.
- Spacing and layout rhythm: the browser row is `48px` high; naked navigation controls, the thin separator, `30px` pill address field, globe icon, and inline Edit action reproduce the selected option's hierarchy without adding another segmented container.
- Colors and visual tokens: light and dark backgrounds, borders, disabled states, hover fills, and focus accent remain theme-aware and preserve readable contrast.
- Image and icon fidelity: existing Ant Design and product navigation icons are used; no raster substitutes, handcrafted SVGs, emoji, or CSS-drawn visible assets were introduced.
- Copy and content: the address is realistic and `Edit` / `编辑` is localized through the existing dictionaries.
- Accessibility and behavior: controls retain semantic button/textbox roles, labels and focus-visible states; the address selects on focus, Escape restores it, Enter normalizes and navigates, while Edit is a pressed-state toggle for HTML element review and disabled Forward remains exposed correctly.

### Comparison History

1. Initial implementation was blocked by a P1 target-selection mismatch: it implemented option 3 with a segmented navigation container and a separate blue outlined Edit button.
2. Fix: navigation became unboxed with a dedicated vertical separator; Edit moved inside the address pill and adopted neutral theme-aware styling. The row and navigation rhythm were then aligned to the high-density option-2 reference.
3. Post-fix evidence: `qa/work-panel-browser-toolbar-comparison.jpg` shows the reference light/dark toolbar crops and the implementation light/dark toolbar crops together. No P0/P1/P2 visual differences remain after density normalization.

### Focused and Full-view Evidence

- Full-view captures: `qa/work-panel-browser-toolbar-light.jpg`, `qa/work-panel-browser-toolbar-dark.jpg`, and the `380px` narrow dark capture verify the browser row in the mounted WorkPanel shell and its responsive truncation.
- Focused comparison: `qa/work-panel-browser-toolbar-comparison.jpg` isolates the two toolbar states because the embedded web page content is not part of this change and is unavailable inside a regular-browser QA harness.

### Interaction and Runtime Verification

- Clicking the address selects it for direct editing; Escape restores `https://www.baidu.com/`.
- Enter normalizes `example.com` to `https://example.com/` and leaves the field in its normal display state.
- Edit enters HTML element review, exposes `aria-pressed=true`, changes its label to Done/完成, and opens the WorkPanel review editor; Done exits selection mode without discarding annotations.
- Back and Reload are clickable; Forward is disabled in the captured state.
- Fresh browser QA session: `0` console errors. Two pre-existing React Router v7 future-flag warnings remain and are unrelated to this component.

### Open Questions

- None. The outer WorkPanel tab strip continues to use the product's existing theme tokens; this change intentionally scopes the new light/dark treatment to the requested browser row.

### Implementation Checklist

- [x] Show back/forward/address only for normal Web WorkPanel items; trusted document variants use refresh/name/edit without exposing a path as an address.
- [x] Match option 2's navigation, separator, address pill, and inline Edit composition.
- [x] Support light, dark, hover, focus, disabled, review-active, Escape, Enter, and narrow-width states.
- [x] Preserve WebApp and unrelated WebClient surfaces; keep review-active layout compatible with Web, local HTML, and Artifact/Reference document toolbars.

final result: passed

## WorkPanel Local HTML and Artifact Toolbar Follow-up (2026-08-27)

- Browser QA URLs: `?surface=local&theme=light`, `?surface=local&theme=dark`, and `?surface=artifact&theme=light` on the existing WorkPanel toolbar fixture.
- Local HTML light/dark states reuse the selected option-2 geometry: a naked refresh action, separator, 30px document pill, file icon, safe filename, and inline Edit/Done.
- The filename is static text rather than a fake editable address, so the UI never exposes or suggests editing the underlying absolute path.
- Entering review keeps the document toolbar below the 44px review controls and beside the 320px annotation panel; Done remains visible and pressed at the mounted WorkPanel width.
- Artifact/Reference uses the same 48px toolbar above its Service WebView. Edit is visibly disabled until the guest declares HTML/image capability, preventing a decorative no-op button; when capability arrives it uses the same active/Done state as local HTML.
- Light and dark colors, focus rings, disabled states, truncation, icons, borders, and row rhythm are inherited from the already accepted browser toolbar rather than introducing a second visual system.

final result: passed

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

---

# Windows System Bar Primary Actions Design QA

## Evidence

- Selected direction: `C:\Users\Linlay\.codex\generated_images\01a03c8b-e28c-7410-83f2-d98a37adff29\exec-62057ee1-1ba0-4c5f-898d-ad628f4061d7.png`
- Running implementation: `C:\Project\zenmind\zenmind-desktop\qa\windows-systembar-actions-implementation.png`
- Main renderer with DevTools open: `C:\Project\zenmind\zenmind-desktop\qa\windows-systembar-actions-devtools.png`
- Combined comparison: `C:\Project\zenmind\zenmind-desktop\qa\windows-systembar-actions-comparison.png`
- Viewport and state: Windows light theme, Kanban route, isolated QA profile, `1440 × 920` CSS px at device scale factor `1.25`.
- Measured layout: the system bar stayed `1440 × 30` CSS px; the five-action group began at `x=87.34`, measured `128 × 24` CSS px, and every action measured `24 × 24` CSS px.

## Findings

- No actionable P0, P1, or P2 visual difference was found for the selected structural direction.
- The implementation follows the selected direction's hierarchy: brand identity first, then Search, Sidebar, Back, Forward, and Assistant actions; the draggable title region fills the middle; native-looking window controls remain at the far right. ZenMind shows Logo and product name, while CuteJ uses its Logo alone at the user's request.
- The generated direction is intentionally enlarged for concept review. The running implementation adapts that hierarchy to the user-approved `30px` production system bar instead of copying the concept image's display scale.
- The former Windows sidebar toolbar is absent, so each action has one clear location and the Kanban content begins directly below the title row.

## Required Fidelity Surfaces

- Fonts and typography: when shown, the product name retains the existing system font, `11px` scale, medium weight, and muted color. CuteJ intentionally omits the title text, so no replacement typography was introduced.
- Spacing and layout rhythm: the action group uses five `24px` square hit areas with `2px` gaps and `4px` separation after the product name, fitting the `30px` bar without increasing its height.
- Colors and visual tokens: icons use the existing muted foreground and hover/focus tokens, so light and dark themes stay aligned with the current ZenMind shell.
- Image quality and asset fidelity: BrandMark and the existing application icon components are reused. No handwritten SVG, CSS drawing, emoji, or placeholder graphic was added.
- Copy and content: localized accessible labels are preserved for Search, Sidebar, Back, Forward, and Assistant; disabled navigation states remain visible and semantically disabled.

## Interaction Evidence

- Search opened the real global-search layer; the short delay between click and mounted layer explains why the immediate probe was false while the settled visibility probe was true.
- Follow-up regression: the first implementation allowed the parent drag capture to consume button pointer-down events. Interactive descendants are now excluded before drag starts; the user confirmed the five controls respond in the live CuteJ window.
- Sidebar collapse changed shell state and restored successfully.
- Navigating to Automations enabled Back; Back returned to `#/kanban`; Forward returned to `#/automations`.
- Assistant dock opened and closed successfully from the new top-row action.
- A real `Ctrl+Shift+I` key sequence opened a `devtools://` target for the main renderer. Renderer height changed from `920` to `620` CSS px, proving bottom docking, while the system bar remained `1440 × 30` CSS px and retained all five actions.
- `Ctrl+Shift+D` remains isolated in the focused-webview DevTools path and was not changed by this implementation.

## Comparison History

- Iteration 1: placed the selected direction and the live Windows capture in one comparison image, checking control order, left/right anchoring, duplicate-toolbar removal, spacing, visual weight, and title-bar height.
- No P0/P1/P2 mismatch required a second visual iteration. The production result deliberately preserves the compact scale requested in the immediately preceding system-bar refinement.

## Verification

- [x] Renderer typecheck.
- [x] Prepared renderer production build.
- [x] Four focused Windows title-bar layout tests.
- [x] Main renderer system-bar build assertion.
- [x] Live search, collapse, navigation, assistant, and DevTools interaction probes.
- [x] Combined visual comparison reviewed at original capture detail.

final result: passed

---

# Desktop Runtime Observer — Design QA

## Evidence

- Visual truth: `/Users/linlay/.codex/generated_images/01a04648-ecde-7041-a3fb-3886070d0185/exec-80a054eb-53c0-4644-a91e-c803a5a9c64d.png`
- Implementation screenshot: `qa/runtime-observer-implementation-final.png`
- Full-view comparison: `qa/runtime-observer-design-comparison-final.png`
- Focused detail comparison: `qa/runtime-observer-detail-comparison.png`
- Reference pixels: 1487 × 1058, normalized to 1440 × 1024 for comparison
- Implementation pixels / CSS viewport: 1440 × 1024 at device scale factor 1
- Compared state: dark theme, Targets view, `copilot-dock` selected, Overview detail tab, live sampling enabled

## Findings and fixes

| Severity | Finding | Resolution |
| --- | --- | --- |
| P1 | When the optional error row was absent, the body occupied the wrong grid row and left a large blank lower region. | Assigned explicit grid rows to the error banner and observer body. |
| P2 | The application-level dark-theme `code` rule added blue boxes behind WebContents and PID cells. | Scoped a higher-specificity target-row code style to the observer. |
| P2 | Overview was materially sparser than the selected design and hid the memory/event relationship. | Added compact five-minute memory and recent-event sections to Overview while retaining dedicated tabs. |
| P2 | Only registered surfaces and orphan WebViews were visible, leaving live window/utility WebContents out of the runtime view. | Included every live WebContents and every Chromium process; only an unregistered WebView is marked orphaned. |

## Functional verification

- Search filters targets and process-only groups.
- Pause/resume, refresh, clear trace, target selection, sorting, four main views, and four detail tabs respond correctly.
- Memory values are explicitly process-level RSS; rows sharing a renderer are labelled `shared` rather than presenting invented per-WebView memory.
- Target URLs are sanitized in the main process before reaching the renderer.
- DevTools can only be opened for a currently live WebView.
- Browser console contains no warnings or errors from the implementation.

## Accepted P3 differences

- Live target count and table density depend on the actual Electron runtime rather than being padded to match mock content.
- Per-target reload was intentionally omitted from this read-oriented observer; refresh reloads diagnostics without mutating a WebView.
- The memory curve uses real samples collected while the observer is open, so a fresh session begins with a short line rather than fabricated history.

## Final result

passed

---

# Desktop Pet Conversation Overview — Design QA

**Comparison Target**

- Source visual truth: `/Users/linlay/.codex/generated_images/01a05871-dd8e-75c2-bcf2-f134f48f18ad/exec-a6c939e1-13e9-4ecb-9033-71224e14c559.png`
- Browser-rendered implementation: `/private/tmp/pet-design-qa/implementation.png`
- Full-view comparison: `/private/tmp/pet-design-qa/full-comparison.png`
- Focused panel comparison: `/private/tmp/pet-design-qa/comparison.png`
- Viewport: 376 × 334 CSS px, matching the Desktop Pet panel BrowserWindow.
- Pixels and density: source 1355 × 1160 px; implementation 376 × 334 px at device scale factor 1. The source is a high-resolution contextual mock rather than a 1:1 product viewport, so the panel regions were cropped independently and normalized to 720 px width for the focused comparison. No finding is based only on the scale difference.
- State: “对话概览” expanded; first unread item has its inline reply composer open, second unread item is collapsed, third item is awaiting and has no reply action. A fourth unread item is present below the fold to verify wheel scrolling.

**Findings**

- No actionable P0/P1/P2 differences remain.
- Fonts and typography: chat names and previews render at 13px; names use 700 weight and previews use 400 weight. The hierarchy and single-line truncation match the requested compact treatment. The mock uses enlarged conceptual typography, while the implementation intentionally follows the user's explicit 13px requirement.
- Spacing and layout rhythm: the implementation preserves three complete visible rows in both collapsed and reply-open states. Adjacent items use quiet 1px separators, and the fourth item stays below the scroll viewport. The implementation is denser than the contextual mock by request.
- Colors and visual tokens: unread uses the navigation blue `#1677ff`; awaiting uses the existing amber semantic color. Resting secondary buttons are transparent and borderless; hover/focus introduces the subtle border/fill.
- Image quality and asset fidelity: the panel contains no raster imagery. Icons use the product's existing Ant Design icon set; no placeholder, emoji, handcrafted SVG, or CSS-drawn replacement was introduced. The source desktop/pet scene is contextual and is intentionally absent from the isolated transparent panel BrowserWindow capture.
- Copy and content: header copy is “对话概览”; the three visible item states and their content match the approved reference. Awaiting has no in-panel answer or reply entry.

**Open Questions**

- None. The source mock shows the close control because it depicts hover; the implementation screenshot captures the resting state, where the close control must be hidden by requirement.

**Implementation Checklist**

- [x] Show only seven-day unread/awaiting messages and cap the retained list at 50.
- [x] Keep exactly three complete items visible and preserve wheel scrolling.
- [x] Render inline unread/awaiting markers without a dedicated status column.
- [x] Keep close controls absolutely overlaid and hidden outside hover/focus.
- [x] Support inline reply only for ordinary unread items.
- [x] Mark unread as read on open, successful reply, or close.
- [x] Verify the production renderer build and focused desktop-pet tests.

**Follow-up Polish**

- No P3 polish is required for this handoff.

**Comparison History**

1. Initial browser render: `/private/tmp/pet-design-qa/iteration-1.png`.
   - Earlier finding: [P2] the collapsed 236px list viewport exposed most of a fourth row, so the panel did not read as a strict three-item window.
   - Fix: set the resting list viewport to 186px (three 62px rows) while keeping the reply-open viewport at 236px (108px composer row plus two 62px rows).
2. Post-fix evidence: `/private/tmp/pet-design-qa/implementation.png`, `/private/tmp/pet-design-qa/full-comparison.png`, and `/private/tmp/pet-design-qa/comparison.png`.
   - Browser measurements: collapsed client height 186px / scroll height 248px; reply-open client height 236px / scroll height 294px; visible row heights 108px, 62px, and 62px.
   - Interaction evidence: close control computed style changes from `opacity: 0; visibility: hidden; pointer-events: none` at rest to `opacity: 1; visibility: visible; pointer-events: auto` on row hover; awaiting reply-action count is zero.
   - Browser errors: captured console/window/unhandled-rejection errors `[]`; Vite error overlay count `0`.

final result: passed
