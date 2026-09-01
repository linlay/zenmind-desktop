# 手工回归

## 异常上报一期

- 首次使用可看到异常上报默认启用及数据范围说明；设置页关闭后 JS 报告立即停止且队列清空。
- 已登录与未登录分别触发 renderer、unhandled rejection、React Error Boundary、Service WebView、Main 和 Preload 异常，确认原错误传播/退出行为不变且服务端分别收到带身份与匿名 occurrence。
- 生产配置拒绝 HTTP Ops 地址；开发配置仅允许 loopback HTTP，且不依赖 Tunnel。
- macOS 与 Windows 隔离包分别执行 `process.crash()`，确认 gzip multipart minidump 上传；关闭后不上传，重启后不启动 Crashpad并清理待传 dump。
