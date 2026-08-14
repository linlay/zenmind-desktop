# Kanban 同步协议开发期草案说明

本文件仅记录：Kanban 首次发布前曾有未发布的内部协议草案。这些草案不是兼容合同，也不能用于连接或数据协商。

当前唯一权威协议为 [Kanban 云端与 Desktop 同步协议 V1](Kanban云端与Desktop同步协议-v1.md)：WebSocket `v=1`、Contract `1.0`、Desktop sync cache schema `1`。

实现、测试、部署与排障均不得恢复旧草案的双读、字段别名或版本降级逻辑。
