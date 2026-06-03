New installations store desktop runtime data in a layered Desktop data directory:

- **macOS**: `{{runtimeDataPathMac}}`
- **Windows**: `{{runtimeDataPathWindows}}`

This directory is organized into `config`, `data`, `state`, `logs`, `cache`, `secrets`, and `profiles`. Service and plugin program files live under `{{programDataPathMac}}` on macOS and `{{programDataPathWindows}}` on Windows.
