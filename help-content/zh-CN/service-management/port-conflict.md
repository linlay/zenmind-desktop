如果服务启动时提示端口冲突，说明该端口已被其他程序占用。

你可以通过以下命令查找占用进程：

```text
# macOS / Linux
lsof -i :端口号

# Windows
netstat -ano | findstr :端口号
```

找到占用进程后，关闭对应程序或修改服务的配置文件中的端口号。
