# 分享短链使用与对接

本文按当前源码说明用户操作、各方职责和接入步骤，不定义另一套机器契约。应用版本号不能代替能力检测；本轮功能尚未正式发布，旧 Desktop 0.5.25 发布包不包含新的接收能力。部署与平台验证状态以 [T10 执行记录](../../plan/2026-10-27-share-shortlink-refactor/10-regression-rollout-and-docs.md) 为准。

## 1. 用户使用

创建与管理需要登录 Desktop，并在「设置 → 隧道」配置和开启可信 Hub。浏览器查看公开分享无需登录；Desktop 接收也从本机可信 Hub 配置解析 ID，不接受链接指定其他服务端。

| 对象 | 创建入口 | 对方得到的能力 |
| --- | --- | --- |
| 对话 | 对话顶部分享按钮，或对话菜单中的「分享链接」 | 查看冻结的对话与已包含附件 |
| 市场连接器 | 云端连接器商品详情中的「分享」 | 查看冻结资料；在 Desktop 市场定位明确商品和分享版本 |
| 已发布 WebApp | 应用发布详情中的「创建分享链接」 | 查看冻结介绍，并打开原公网服务的当前部署 |

具体操作：

1. 打开上述分享弹窗，选择复制链接、生成二维码或浏览器打开。只打开弹窗不会立即创建；首次具体操作才创建。
2. 将生成的 canonical URL 交给接收者。相同弹窗内已有创建结果时继续复用，新建一次分享则生成独立 ID。
3. 接收者在浏览器查看；有已支持的 Desktop 接收方时可点击产品入口交给 Desktop，有在线绑定时可点击「打开在线服务」。没有相应能力就不提供该动作。
4. 创建者进入侧栏「分享」管理页，查看、复制或撤销当前账号的记录。原 Chat 不在本机也可以管理。

内容和资源冻结于创建时，后续源内容变化或源 Desktop 离线不改变它们。链接持续有效直到撤销，没有分享有效期或阅后即焚；每次创建独立内容，撤销一条不影响另一条。同一 ID 的预览、资源和交接共用撤销状态。

在线服务仍依赖原发布链路在线。撤销短链不停止应用、不撤销原公网地址；要停止公开访问，使用原发布设置。

## 2. 对接方与最小职责

| 对接方 | 必须承担 | 不应接管 |
| --- | --- | --- |
| Hub / 部署网关 | 管理验签、通用包校验、独占存储、公开读取、撤销、迁移和代理配置 | 业务安装、市场版本迁移、任意 URL 转发 |
| Desktop 公共分享模块 | 唯一发布客户端、管理 IPC、匿名解析、精确 receiver 分派和有界交接 | 第二套身份、业务脚本、安装恢复、持久意图队列 |
| 来源业务 | 从已核实来源准备冻结内容、资源与可选接收上下文 | 重复实现网络、登录、复制、二维码或撤销 |
| 业务接收方 | 验证自己的 context、定位页面、复用原业务操作 | 把收到的上下文当作权限或自动安装指令 |
| 服务插件 | 安装声明、原认证 Bridge、当前实例接收和确认 | 自报其他 owner/receiverId 或让页面注册接收方 |
| 本机 WebApp | 安装声明、当前本机页面 SDK 处理函数 | 后端、局域网或 Tunnel 页面冒用本机接收入口 |
| 已发布 WebApp 服务 | 原发布状态、HTTP/WebSocket、访客身份与权限 | 获得发布者 SSO 或依赖短链替代服务访问控制 |
| 市场 Server | 原 catalog、精确制品版本、身份、平台和 Hash 契约 | 让短链基础层另建历史目录或制品仓库 |

Identity、Shell、服务管理器、Agent Platform 和 Agent WebClient 继续拥有原身份、导航、生命周期、业务数据和渲染职责，不需要另建分享专用系统。

## 3. Hub 与网关接入

### 3.1 部署和鉴权

1. 配置现有数据库、资源持久化目录、可信 SSO 验签、运行品牌、公开分享域名与 TLS。字段从 Hub [.env.example](../../tunnel-hub-server/.env.example) 读取，不将真实配置或密钥写入本文。
2. 将 `/api/desktop/*` 管理 API、`/share/*` 及 `/assets/conversation-export/*` 按 [Hub 部署模板](../../tunnel-hub-server/deploy/nginx/tunnel-hub.conf.template) 转给 Relay。保留已有 Tunnel 和 WebApp 公网路由。
3. 管理 API 使用现有 SSO Bearer，正常配置要求 `tunnel` scope；owner 取验签结果，不接收 body/query 自报身份。公开预览、下载和解析不携带管理凭据。
4. 升级前一致备份数据库、资源目录和历史渲染资产，在隔离副本验证迁移。旧永久 ID/字节保持，旧非永久记录先撤销再移除退役字段；不能直接用旧 Hub 读取升级后的库。

### 3.2 管理和公开接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/desktop/v2/shares/limits` | 读取 `maxManifestBytes`、`maxResourceBytes` |
| `POST /api/desktop/v2/shares` | 创建独立分享，返回 201 Record |
| `GET /api/desktop/v2/shares` | 当前所有者的元数据列表 |
| `DELETE /api/desktop/v2/shares/{id}` | 撤销，成功返回 204 |

POST 使用 multipart：第一部分为唯一的 `manifest` JSON，之后为 `resource:<id>` 文件部分。资源声明的 ID、文件名、MIME、大小、SHA-256 与实际文件逐项一致；多传、漏传、重复 ID/path 均拒绝。管理入口不接受 query。

公开行为：

| 路径 / 参数 | 含义 |
| --- | --- |
| `/share/{id}` 或 `?action=preview` | 可信外层预览 |
| `?action=resolve` | 最小 JSON 描述，不含 owner、完整 content 或文件正文 |
| `?action=desktop` | 提供品牌 Desktop 打开入口 |
| `?action=download&resourceId=...` | 读取本分享清单中的指定资源 |
| `?action=service` | 复验已有发布绑定，303 到原公网 Host |
| `/share/{id}/preview/{path}` | 显式预览包的隔离资源 |

receiver、context、版本、owner、token、在线绑定均不能通过 query 覆盖。只使用服务端返回的 canonical URL；Desktop 系统入口为 `<品牌scheme>://share/<id>?action=desktop`，不携带 origin、凭据、上下文或动作序列。

旧 `/api/desktop/shares` 仅兼容当前发布 Desktop 的永久对话请求，返回旧七键响应；新业务使用 v2，不伪造 conversationId。新 Desktop 访问不支持 v2 的旧 Hub 时明确提示升级，不自动降级。

精确字段与约束的事实源为 [Hub contract.go](../../tunnel-hub-server/internal/sharecontract/contract.go)、[Desktop shares DTO](../src/shared/contracts/shares.ts) 和 [HTTP 客户端](../src/main/modules/shares/http-client.ts)。

### 3.3 已确认的 Nginx 上传配置遗漏

截至 2026-10-28，本仓对应的 Hub Nginx 模板仍只有旧路径 `location = /api/desktop/shares` 单独设置 `client_max_body_size 0`、`proxy_request_buffering off`。v2 创建路径会命中通用 `location /api/desktop/`，可以转发到 Relay，但继承本模板 server 级 `100m` 上限，且没有关闭默认请求缓冲。因此遗漏的是上传策略，不能描述为 v2 没有路由或所有上传都失败。

Hub 默认 manifest 和资源各 50 MiB，总请求额度由 [RequestBodyBytes](../../tunnel-hub-server/internal/config/config.go) 计算为 101 MiB。两个部分合计 100 MiB，再加 301 字节的示例 multipart 边界/头部，得到 104857901 字节：未超过 Hub 总额度，却超过模板的 104857600 字节上限。此为配置与字节预算证明，尚未经过实际 Nginx 上传。

部署方的最小修复是给 `/api/desktop/v2/shares` 增加与旧上传入口相同的精确 location、上游和转发头，包含上述两项设置及现有 HTTP/1.1 配置；其余 API 继续保持原规则。由 Hub 现有 MaxBytesReader、manifest/资源额度及 Hash 检查承担应用限额，不另建上传服务。当前模板尚未改动，修复及实际代理验证仍为待办；不要把本文描述当作已经修复。

该判断依据 Nginx 官方的 [location 匹配规则](https://nginx.org/en/docs/http/ngx_http_core_module.html#location)、[client_max_body_size](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size) 和 [proxy_request_buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_request_buffering)。Caddy 模板已有通用管理路径转发，未发现同样的固定 100m 特例差异。本结论仅针对仓库模板，不判断线上实际生效配置。

## 4. 新增来源业务

1. 在可信 Main 模块或原 Worker 中重新核实来源、权限和准确业务版本；普通 renderer 只传业务选择，不上传任意信封或文件路径。
2. 按 shared DTO 准备 `ShareEnvelope`：`protocolVersion:1`、业务 `kind/title`、`content`、`resources`，以及实际需要的可选 `preview/desktop/service/source`。
3. 调用注入的 `ShareServicePort.publish(prepare)`。prepare 接收服务端额度，返回 `PreparedShare`：manifest UTF-8 字节及每项资源字节；先检查完整 manifest 和资源总预算。
4. 复用公共分享弹窗及已有复制、二维码、浏览器和管理入口。来源业务不缓存身份、不另写上传、重试或撤销客户端。

`content` 在 JSON 对象 data 与本次资源 resourceId 中二选一。`protocolVersion`、内容 `version`、接收 `contextVersion` 和商品 `resourceVersion` 分别归各自所有者，不能互相代替或自动升降级。

创建响应丢失时如实报告失败，不自动重发 POST；获得创建结果后，原弹窗的操作重试复用该记录。发布端口见 [share-ports.ts](../src/main/support/share-ports.ts)，可参照 [市场准备实现](../src/main/modules/marketplace/share-publish.ts) 和 [WebApp 发布准备](../src/main/modules/webs/webapps/share-publish.ts)。

本轮未提供第三方页面、插件或 WebApp 的通用发布 SDK；需要新增分享来源时，先实现上述 Main 业务适配，不扩展成任意页面上传入口。

## 5. 预览包提供方

- 对话继续使用内置 conversation 查看器和原 Worker；普通 HTML 附件仍清洗并禁用脚本。
- 其他业务可提供自包含 HTML/CSS/JS/JSON/图片/字体，全部声明进本次资源清单，并设置 `preview:{type:"package",entrypoint:"index.html"}`。
- 每项包资源声明规范相对 path、实际字节大小与 SHA-256；入口命中 text/html 资源，HTML 使用包内相对引用，不依赖 CDN、外部 API 或本机路径。
- 包脚本在 opaque sandbox 中运行，不获得父页面、SSO、Desktop/Node Bridge；不能弹窗、顶层导航、嵌套 frame 或启动 Worker。下载仍由可信外层资源动作提供。
- 省略 preview 时仅有元数据页，`content.data` 不会自动变成业务正文页面。

已验证浏览器范围和限制见 T10，不因某个平台能加载就宣称其他浏览器已通过。

## 6. 内置 Main 接收方

可信 Main 模块使用 `registerReceiver` 登记 receiverId、宿主确认的 owner、精确 contextVersions 和 activate。activate 复用原 Shell/生命周期，返回当前实例的 generation、isCurrent 和 receive 端点；注销时调用返回的清理函数。

收到的 `ShareReceiveRequest` 是 shareId、intentId、receiverId、contextVersion 和业务 context，不是完整内容包或管理 token。业务必须校验字段和语义，再定位详情；安装、下载、连接或其他写操作继续走原用户交互。

公共交接默认总时限 15 秒，等待、激活和确认共用同一期限；新打开取消旧请求，交付前再次复核撤销。未安装、停用、不兼容或不能激活则结束，不能等待安装恢复。已安装且可正常启动的模块可以复用原生命周期激活；交接期间停止、升级或实例替换会使旧端点失效。

当前市场 receiver 为 `builtin.market`；插件和 WebApp 的 ID 由各自安装领域派生，普通页面不能调用注册接口。

## 7. 服务插件接收

在现有服务插件 Manifest 中合并以下声明；此片段不是完整安装清单：

```json
{
  "shareReceiver": { "protocolVersion": 1, "contextVersions": [1] },
  "hooks": { "subscribe": ["share.receive"] },
  "bridge": { "requests": ["share.ready", "share.ack", "share.release"] }
}
```

宿主派生 `plugin.<插件ID>`。插件必须有真实服务生命周期；纯资源插件不能声明运行接收器，不能自报 owner 或 receiverId。

1. 插件运行程序读取宿主注入的 `DESKTOP_PLUGIN_BRIDGE_PATH/TOKEN`，通过原 NDJSON Bridge 完成 hello 认证。macOS 使用本地 socket，Windows 使用原命名管道；不要另建 HTTP 接收服务。
2. 业务处理函数准备好后，发送原 request 帧，method 为 `share.ready`、params 为 `{"protocolVersion":1}`，保存响应的 generation。
3. 同一认证连接收到 `share.receive` 事件，data 包含 `{generation,request}`。先检查自己的上下文，再定位业务。
4. 通过同一连接调用 `share.ack`，params 精确为 `{generation,intentId:request.intentId,status}`。status 为 `received`、`invalid_context` 或 `unavailable`。
5. 释放时调用 `share.release`，params 为 `{generation}`。断连、停止、升级后旧 generation 与确认失效，不能跨连接冒领。

share 消息不进入普通 hook 的离线队列。公共分派器先拒绝未注册的 contextVersion；同次传输保留 intentId，业务有副作用时自己按该身份避免重复。真实消息例见 [extension-share-receiver.test.mjs](../test/extension-share-receiver.test.mjs)，实现见 [Plugin Bridge](../src/main/modules/plugins/bridge.ts)。

## 8. 本机 WebApp 接收

使用配套 WebApp Manifest v2、原 Bridge v2 与分享接收协议 v1，在现有清单添加：

```json
"shareReceiver": { "protocolVersion": 1, "contextVersions": [1] }
```

宿主按安装身份派生 `webapp.<安装ID>`。页面使用同批生成的 SDK，先做能力检测：

```js
import { desktop } from "/__desktop/bridge.js";

let stop;
if (await desktop.capabilities.has("desktop.share.receive")) {
  stop = desktop.share.onReceive(async (request, { signal }) => {
    if (request.contextVersion !== 1 ||
        typeof request.context.documentId !== "string") {
      return "invalid_context";
    }
    if (signal.aborted) return "unavailable";
    openDocumentDetails(request.context.documentId); // 应用自己的业务函数
    return "received";
  });
}
// 组件卸载时调用 stop?.()；页面离开也会释放当前实例。
```

SDK 负责当前 page grant、instance、generation 和确认；不跨页面、账号或重启恢复。入口仅限真实本机页面，Node 后端、局域网、Tunnel 页面及普通 Desktop Action 均不能调用。无能力时保留公开预览，不继续轮询安装或恢复。

`desktop.share.open` 仍为预留；本 SDK 的接收能力不包含发布。旧包无声明保持原生命周期。完整 SDK 说明见 [WebApp README](webapp/README.md)，生成文件不得手改，验证使用原 `npm run webapp-contract:check`。

## 9. 市场与在线服务

### 市场

当前首个业务样本仅为连接器商品：发布时重新读取当前身份可见 catalog，冻结名称、说明、作者、标签和明确版本；不会分享私有制品地址、凭据或本机配置。

接收上下文由 [market-share.ts](../src/shared/market-share.ts) 定义，固定交给 `builtin.market`。目录仍能提供精确分享版本时复用原业务按钮，安装前再次校验预期版本；resolve 返回其他版本也必须拒绝。目录不能提供该版本时展示冻结资料和独立当前版本提示，禁用相关业务操作。

市场 Server 目前没有可核实的历史留存契约。要支持旧版制品操作，需要原市场提供按商品、类型、版本取得当前身份可见资料与精确制品的能力，并继续验证平台、权限与 Hash；不新增分享历史仓库，不自动替换最新版。

### 在线 WebApp

“接收分享上下文”和“分享已发布在线服务”互相独立，后者不要求 shareReceiver。

1. 先通过原 WebApp 发布流程得到 active 发布；分享不会自动开启 Tunnel、启动应用或创建 route。
2. Desktop 使用原鉴权路径 `GET /api/desktop/devices/{deviceId}/webapps/{name}` 只读取得当前 owner 的 webAppId，不能使用本机应用 ID、routeId 或任意 URL 代替。
3. 来源包保存冻结介绍，并引用 `service:{type:"webapp",webAppId}`。Hub 在创建和公开 action 时复验绑定归属与状态。
4. 访问在线动作时跳转原 HTTPS Host，沿原链路使用当前部署。服务自己处理访客登录与权限；不透传发布者 SSO。
5. 停止发布或删除绑定后，在线动作不可用，冻结介绍仍可查看。撤销一条短链不影响原发布或其他短链。

## 10. 接入验收

按实际接入范围验证：同源两次创建的 ID/内容独立、源变化后预览保持、撤销后所有行为受阻；接收方版本不兼容、未安装、同页多次打开、账号变化、停止/升级时旧交接失效；市场不能换最新版；在线服务升级访问当前部署，停止发布后冻结介绍保留。

部署方另验网关上传额度/缓冲、旧永久迁移和旧客户端兼容；插件/WebApp 分别验真实通道和实际目标平台。上述为验收要求，不代表每个平台已经通过。当前未关闭项、已有自动/浏览器证据及恢复限制只维护在 T10，不复制测试数量作为稳定契约。
