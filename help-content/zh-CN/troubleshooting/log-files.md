每个服务的日志路径可在 [控制中心](/control-center) 详情卡片中查看。新布局下通常位于桌面端数据目录的 `logs/services` 分层中：

- **主日志**：来自服务清单中的 `runtime.logRelativePath`，控制中心详情页会显示实际路径
- **独立错误日志**：仅当服务清单声明 `runtime.errorLogRelativePath` 时才会单独显示
- 当前 macOS / Linux 内置服务默认将 `stderr` 合并写入主日志，不会额外生成单独错误日志文件

你也可以通过 [控制中心](/control-center) 的相关服务详情直接查看日志路径和运行信息。
