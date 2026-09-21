# Desktop / Platform 连接器真实接口验收

本测试把已编译的 Desktop 适配器和市场连接流程接到 Platform 真实 HTTP handler。
只有第三方 MCP 服务由本地 TLS fixture 模拟；连接器导入、状态、凭据验证和 Agent 挂载使用生产实现。
所有连接器、凭据和 Agent 数据都在 Go 测试临时目录内，不使用个人 Desktop 数据。

## 运行

准备本 PR 的 Desktop checkout，以及使用 `configured` / `canCheck` 契约的最新 Platform checkout。
将下面路径替换成自己的目录。需要 Node.js、Go 和项目依赖。

```sh
export DESKTOP_REPO=/path/to/zenmind-desktop
export PLATFORM_REPO=/path/to/agent-platform
export DESKTOP_CONNECTOR_BRIDGE_FILE="$(mktemp -u /tmp/desktop-connector-bridge.XXXXXX)"
```

把本 PR 提供的 fixture 放进 Platform 的测试包。若目标文件已有本地改动，先备份它，测试后还原。

```sh
cp "$DESKTOP_REPO/test/fixtures/platform-connector-bridge.go" "$PLATFORM_REPO/internal/server/desktop_bridge_local_test.go"
cd "$PLATFORM_REPO"
go test ./internal/server -run '^TestDesktopConnectorBridgeLocal$' -count=1 -v
```

等到输出 `Desktop bridge ready` 后，在另一个终端设置相同的 `DESKTOP_CONNECTOR_BRIDGE_FILE`，运行：

```sh
cd "$DESKTOP_REPO"
npm run build:main:types
node --test test/connector-platform-bridge.test.mjs
```

测试完成后停止临时服务：

```sh
touch "$DESKTOP_CONNECTOR_BRIDGE_FILE.stop"
```

fixture 最长运行 20 分钟，退出后 Go 会清理临时业务数据。此测试不需要提交 Platform 代码。

## 断言范围

- 无凭据连接器连接后 `configured=true`、退出后 `configured=false`，不存在独立启停契约。
- Token schema、有效凭据验证、错误凭据拒绝且保留旧凭据。
- 第三方暂时不可用时，新凭据待验证，提交结果保留该提示，旧凭据仍然可用。
- 状态与列表读取不探测第三方；显式检查成功后新凭据生效。
- OAuth 按 `embedded` 策略产生授权会话，并可取消。
- 自定义连接器 ZIP 经真实导入接口安装，市场连接流程完成 Agent 挂载，运行时列表同步。

这里验证接口与流程，不替代真实 Electron 弹窗交互或 Windows 原生执行验收。
