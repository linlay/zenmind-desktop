After startup, services write PID files to track process state.

- PID file paths are visible in the detail card's health information.
- If a service exits unexpectedly, a PID file may be left behind. Restarting the service cleans it automatically.
- When the app exits (`before-quit`), it records running services and tries to restore them on the next launch.
