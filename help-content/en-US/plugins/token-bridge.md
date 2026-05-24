Services or plugins that require authentication can use the postMessage Token Bridge to request a JWT token from Desktop:

1. The service webview sends:

```json
{
  "type": "REQUEST_TYPE",
  "requestId": "unique-id",
  "action": "getAccessToken",
  "reason": "missing"
}
```

2. Desktop signs and returns a JWT:

```json
{
  "type": "RESPONSE_TYPE",
  "requestId": "unique-id",
  "token": "jwt-token-string"
}
```

The authentication protocol is defined in `src/shared/auth-bridge.ts`.
