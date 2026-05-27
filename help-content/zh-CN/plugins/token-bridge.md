需要认证的服务或插件可通过 postMessage 令牌桥接与桌面端通信，获取 JWT 令牌：

1. 服务 webview 发送消息：

```json
{
  "type": "REQUEST_TYPE",
  "requestId": "唯一ID",
  "action": "getAccessToken",
  "reason": "missing"
}
```

2. 桌面端签发 JWT 后回传：

```json
{
  "type": "RESPONSE_TYPE",
  "requestId": "唯一ID",
  "token": "jwt-token-string"
}
```

认证协议定义在 `src/shared/auth-bridge.ts` 中。
