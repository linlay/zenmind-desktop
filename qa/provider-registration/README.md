# Provider 登记部署样例

`provider-register.json` 只承载 Grant 模式：将 `grant-jwt.example.json` 替换真实 HTTPS 服务地址与受管 Provider 列表后命名为 `provider-register.json`，放入运行环境根目录（与 registries 同层）。它是环境交付输入，不应直接修改已生成 env.zip 或安装目录。

- grant-jwt 模式使用 `/api/apply-apikey`；真实 Grant 只进入私有运行环境交付材料，成功后清理。
- 无文件则不获取 Key；非法 mode 不回退；旧文件没有 mode 时继续按旧 enabled/grant 规则运行。
- 员工登录身份直接调用模型时不使用登记文件：在 Provider YAML 写 `useAccessToken: true`，由 Agent Platform 每次请求读取 Desktop 的 SSO token 文件，以 `Authorization: Bearer` 发送。同一环境不要同时交付该 Provider 的登记文件，否则 Grant 会被消费但换来的 Key 不会使用。
- 已退役的 `"mode": "access-token"` 文件会被跳过并记录警告，不申请 Key、不修改 Provider YAML，也不阻止服务启动。
