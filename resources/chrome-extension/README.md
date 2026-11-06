# Bundled Playwright Chrome extension

Official Chrome Web Store CRX, version 0.5.0, extension ID
`mmlmfjhmonkocbjadbfplnigmagldckm`. The original CRX is unchanged.
Source: https://github.com/microsoft/playwright/tree/main/packages/extension
Download URL and SHA-256: `scripts/playwright/upstream-lock.json`.
License: Apache-2.0; see LICENSE and NOTICE.

Both macOS and Windows packages include this directory as extra resources.
Settings verifies and extracts the CRX into a stable versioned user-data folder.
Users load that folder through Chrome's Developer mode / Load unpacked UI.
No network download or Chrome profile modification is performed at runtime.

To update, review the official artifact and relay compatibility, update the lock
and runtime integrity baseline, and run the official extension fixtures. Preserve
the original manifest key: the production relay depends on the official ID.
