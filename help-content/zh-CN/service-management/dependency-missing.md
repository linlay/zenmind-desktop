`dependency-missing` 表示该服务的前置依赖未满足。常见原因包括：

- 容器仓库（agent-container-hub）需要 Docker 或 Podman，但本机未安装或未启动
- 某些服务依赖其他内置服务先完成安装

请根据详情卡片中的"前置条件"列表逐项检查并满足依赖。
