Each service log path is visible in the [Control Center](/control-center) detail card. In the current layout, logs usually live under the Desktop data directory's `logs/services` layer:

- **Main log**: Comes from `runtime.logRelativePath` in the service manifest. Control Center displays the resolved path.
- **Separate error log**: Shown only when the service manifest declares `runtime.errorLogRelativePath`.
- Current macOS / Linux built-in services merge `stderr` into the main log by default and do not create a separate error log file.

You can also open the related service details in [Control Center](/control-center) to inspect log paths and runtime information.
