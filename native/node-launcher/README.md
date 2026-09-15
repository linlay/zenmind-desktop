# Desktop Windows Node launcher

This helper exposes Electron embedded Node as a real Windows `node.exe`, including callers that use `execFile` or `exec.Command`. Desktop writes the adjacent `.desktop-node-runtime.json` with the current absolute `electronPath`.

The launcher forwards arguments, working directory, standard streams and the child exit code. Only the Electron child receives `ELECTRON_RUN_AS_NODE=1`. The child is assigned to a kill-on-close Windows Job Object before it runs.

## Build and test

Windows build hosts need Go 1.23 or newer. Go is a build-time dependency only; end users do not need it. From the Desktop repository root:

```sh
node scripts/build-node-launcher.mjs --os=win32 --arch=amd64
node scripts/build-node-launcher.mjs --os=win32 --arch=arm64
cd native/node-launcher
go test ./...
```

The normal Desktop Windows stage/build workflow builds the correct target automatically. The Docker workflow prepares it on the host first, then reuses the verified resource in the container. Signed release packaging may change the executable digest; Desktop fingerprints the actual packaged bytes when preparing runtime commands.

Windows process tests run a test subprocess on a Windows machine. An additional real Electron smoke check is required before release; cross-compilation and PE checks alone do not establish Windows runtime compatibility.
