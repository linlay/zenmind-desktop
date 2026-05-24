内置服务的推荐启动顺序：

1. **容器仓库（agent-container-hub）**（最先启动，确保 Docker/Podman 可用）
2. **agent-platform**（依赖容器仓库）
3. **zenmind-app-server**（可独立启动）

如果不使用智能体功能，可以只启动 zenmind-app-server。
