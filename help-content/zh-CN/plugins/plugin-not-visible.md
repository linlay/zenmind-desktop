请检查以下几点：

- 插件包 (`{{pluginArchiveLabel}}`) 内必须包含有效的 `manifest.json` 文件
- `manifest.json` 中的 `kind` 字段必须为 `"plugin"`
- 确认插件 ID 没有与已安装的插件冲突
- 查看主进程日志确认是否有加载错误
