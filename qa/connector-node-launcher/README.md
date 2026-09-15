# 企微 CLI 启动示例

`wecom.js` 是本机已安装的官方 `@wecom/cli@1.2.1` 原始入口，来源 https://github.com/WecomTeam/wecom-cli ，按 MIT 许可证分发；许可见 WECOM-LICENSE。它需要原 npm 安装目录中的平台依赖，不能把这份单文件副本当作完整安装。

`wecom-desktop.sh` 演示 macOS/Linux 如何使用 Desktop 内置 Node 启动原安装入口：

```sh
./wecom-desktop.sh "/path/CuteJ.app/Contents/MacOS/CuteJ" "/path/to/@wecom/cli/bin/wecom.js" --version
```

脚本不包含凭据，也不改变登录状态。生产代码由 Desktop 通用运行时入口提供这项能力，不依赖此示例脚本。Windows 使用原生 node.exe 转发入口。
