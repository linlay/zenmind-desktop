# Provider 登记部署样例

选择一个样例，替换真实 HTTPS 服务地址与受管 Provider 列表，然后将文件命名为 `provider-register.json`，放入运行环境根目录（与 registries 同层）。它是环境交付输入，不应直接修改已生成 env.zip 或安装目录。

- access-token 模式使用 `/api/bind-apikey`；文件中不放登录 Token、设备号或 API Key，成功后保留。
- grant-jwt 模式使用 `/api/apply-apikey`；真实 Grant 只进入私有运行环境交付材料，成功后清理。
- 无文件则不获取 Key；非法 mode 不回退；旧文件没有 mode 时继续按旧 enabled/grant 规则运行。
- 新格式不使用 enabled。选择 access-token 前，先部署并启用服务端公钥验证与 Key 加密配置。
