# Desktop 签名更新发布与回归

Windows 使用 v2：Ed25519 签名原始清单，安装包校验大小和 SHA-256，不强制 Authenticode。macOS 保持既有 v1 清单、Apple App 签名、公证和 Squirrel.Mac 验证，不需要 Ed25519 公私钥、口令或 .sig。以下密钥和 v2 发布步骤仅面向 Windows。所有命令从 Desktop 仓库根执行。

### macOS 既有流程（不迁移）

2026-09-22 平台隔离回归：57 项更新测试通过，包含 Mac v1 清单、无 .sig 请求、无 Ed25519 配置、原生签名拒绝、旧清单生成命令，以及 Windows 继续强制验签。主进程/渲染进程类型检查、国际化键检查和架构检查通过；本机为 Windows，未执行 Mac 真机打包、公证或安装。

继续使用原品牌、Apple 开发者签名/公证环境和 `npm run dist:mac`。该入口不检查 Ed25519 配置、不签署 Windows v2 清单，bundle 构建也不加载 Windows 更新公钥配置。现有 Mac 更新源无需改成 v2；ZIP 的大小与 SHA-256、宿主 App 签名和原生更新器检查保留。

仅包含 `darwin-*` artifacts 的发布输入继续使用原命令 `node scripts/create-update-manifest.mjs <input.json> <latest.json>`，输出 v1 JSON，不需要任何 `DESKTOP_UPDATE_*` 变量。Windows 输入仍生成签名目录。Windows 与 macOS 使用各自独立的更新入口。

## 1. 准备密钥与构建信任

生产和测试分别生成密钥；私钥存放于仓库、`dist` 和构建管理器归档目录之外的受限发布目录。Windows 上应限制该目录 ACL，仅发布账户可访问。工具创建的私钥使用口令加密；POSIX 同时设置私有文件权限。不要将私钥提交 Git、传入命令行参数或打印到日志。

在安全终端设置 `DESKTOP_UPDATE_KEY_PASSPHRASE`（至少 12 字符）后，执行：

```powershell
node scripts/update-signing.mjs keygen C:/SigningKeys/CuteJProduction cutej production cutej-production-2026-01
```

目标必须为不存在的新目录。输出 `private-key.pem` 与 `public-trust.json`。私钥需加密离线备份；生产私钥不会由开发测试自动生成。

打包时指定公钥文件：

```powershell
$env:BRAND = 'cutej'
$env:DESKTOP_UPDATE_TRUST_FILE = 'C:/SigningKeys/CuteJProduction/public-trust.json'
npm run dist:win
```

Windows 也可把仅含公钥的配置放到 `brands/<brand>/update-trust.json`，作为版本管理的信任输入。文件格式由生成工具提供：单一 `channel`，最多八个具有唯一 `keyId` 的 Ed25519 公钥，全部归属当前品牌和该渠道。

正式 `dist:win` 缺少有效公钥会在打包入口失败；`dist:mac` 不要求该公钥。普通 Windows 开发构建可不配置公钥，但更新验签会失败。生产 Windows 公钥由构建常量内嵌，不能通过修改更新 URL 增加密钥。

## 2. 打包并生成签名清单

复制 `release-input.example.json`，填写实际品牌、版本、密钥标识、渠道、最终文件路径与 HTTPS URL。`publishedAt` 默认当前时间；清单不包含 `expiresAt` 或 `releaseSequence`。产物目录不能包含私钥。

当前 Windows 服务器要求下载 URL 的文件名为 `原安装包名去掉 .exe-安装包SHA256前16位.exe`；示例中的摘要只是占位，正式签名前必须按最终 EXE 字节计算。输入中的 `file` 仍指向原文件名，发布器会以带摘要的文件名公开存储。

集成打包（当前平台一份 artifact，文件必须位于本品牌 `dist` 内）：

```powershell
$env:DESKTOP_UPDATE_PRIVATE_KEY_FILE = 'C:/SigningKeys/CuteJProduction/private-key.pem'
$env:DESKTOP_UPDATE_TRUST_FILE = 'C:/SigningKeys/CuteJProduction/public-trust.json'
$env:DESKTOP_UPDATE_RELEASE_INPUT = 'C:/ReleaseInputs/cutej-production.json'
# 在安全环境中提供 DESKTOP_UPDATE_KEY_PASSPHRASE
npm run dist:win
```

`dist:win` 在安装器与 Windows 验证完成后签署。签名配置必须与本次 bundle 内嵌公钥一致，清单品牌/版本必须匹配当前构建。输出位于 `dist/<brand>/updates/<channel>/<version>/<unique-id>/`。Mac 不执行此签署步骤。

不设置 `DESKTOP_UPDATE_RELEASE_INPUT` 时，仅生成手动安装/首发基线包，不产生在线更新清单。在线发布流水线必须要求签名清单存在，不能把“手动安装包已构建”视为“在线发布成功”。

本地 Desktop Build Manager 调用同一 `npm run dist:win`，子进程继承其启动环境，因此上述变量在启动 Build Manager 的受限账户环境中配置即可，无需通过 Web 页面输入私钥。它会归档 `dist/<brand>` 下的清单和签名；它目前不负责远程上传或切换服务器更新入口。

已有最终安装包、或需要组合多个平台产物时，可以独立签署：

```powershell
node scripts/update-signing.mjs sign C:/ReleaseInputs/cutej-production.json C:/ReleaseOutput/production/0.5.0
node scripts/update-signing.mjs verify C:/ReleaseOutput/production/0.5.0 C:/SigningKeys/CuteJProduction/public-trust.json C:/ReleaseInputs/cutej-production.json
```

原 `create-update-manifest.mjs` CLI 也会调用签名流程；第二参数现为新发布目录，不再生成无签名单文件。已有输出目录拒绝覆盖。独立签署时须人工确认每个平台基线包内嵌的公钥与签名公钥一致；集成打包路径额外自动检查本次构建公钥。

最终安装包若增加 Authenticode 或发生任何改动，必须重新计算哈希并重新签署清单；发布到新的内容指纹安装包 URL。生产渠道必须提高应用版本，开发渠道可同版本重新签发。签名后的 JSON 不得格式化、换行转换或再加工。

## 3. 发布服务器约定与公开验证

推荐目录与入口：

```text
/releases/<version>/<installer>             不可变安装包
/updates/production/<version>/<unique-id>/desktop-latest.json
/updates/production/<version>/<unique-id>/desktop-latest.json.sig
/api/updates/windows/desktop-latest.json    HTTPS 重定向到上述 Windows 清单
/api/updates/macos/desktop-latest.json      独立 macOS v1 清单入口
```

客户端从最终重定向 URL 的 pathname 末尾追加 `.sig`，保留查询参数。例如 `/42/latest.json?x=1` 对应 `/42/latest.json.sig?x=1`。清单和签名请求及其所有重定向均必须 HTTPS，无凭据及 fragment。清单上限 256 KiB；Base64 签名解码后必须恰好 64 字节，可有一个末尾 LF/CRLF，不能有其他空白。

按顺序上传最终安装包，再上传不可变清单和签名。使用当前源码编译后的客户端同款校验器验证公开入口：

```powershell
npm run updates:verify-feed -- https://updates.example.com/updates/production/0.5.0/<unique-id>/desktop-latest.json C:/SigningKeys/CuteJProduction/public-trust.json cutej
```

该命令实际下载所有平台安装包并核验，不只检查 HTTP 状态。公开验证成功后，服务端切换稳定入口；随后再次验证稳定入口。稳定入口短缓存，不可变资源可长缓存。不要改写已公开的内容指纹安装包；JSON 与签名两次 HTTP 请求不是事务，切换瞬间混读应验签失败并允许重试。服务器具体部署配置由发布环境管理，本仓库工具不自动修改远程服务器。

生产已启用渠道出现清单 404 会显示“暂无更新信息”；签名 404、安装包 404、清单 503、签名无效或协议错误都是错误，不视为已是最新版本。

## 4. 首次上线与平台配置

自动升级尚未正式上线，本次版本直接作为首个正式基线 B，不维护旧 Windows v1 入口或旧客户端过渡流程。验收使用更高版本 N，发布前分配未使用的版本号。

将 `desktop-init.example.json` 的 `updates` 段合并到实际 env 源配置并填写唯一 HTTPS 入口，再重新生成和同步 env 包；不要覆盖其他初始化段，也不要手改已生成归档。只接受单一 `updates.feedUrl`，不使用 `feedUrls` 平台映射，启用时缺少地址会失败。

首次安装、版本升级或手动 env 导入将统一入口写入 `.desktop/config/desktop/updates.json`：

```json
{
  "enabled": true,
  "feedUrl": "https://updates.example.com/api/updates/desktop-latest.json"
}
```

上例是两平台共用的运行时 canonical 配置。普通启动只读 canonical 文件，不重新应用初始化输入。检查更新时自动设置 `platform=win32` 或 `platform=darwin`，服务端重定向到对应平台清单；不把参数写回配置。Windows 从最终清单地址获取相邻 `.sig`，macOS 保留 Apple 原生验签。检查接口返回清单本体，不包裹 `data`。

验证 B → N 在线更新、用户数据保留、配置落盘与服务健康后再开放。Windows 基线内嵌生产公钥并使用 v2 源，macOS 使用 v1 源及 Apple 签名。已有测试安装通过新版本覆盖或显式 env 导入应用配置。

## 5. 版本规则与密钥轮换

- 客户端只向高于当前安装版本的 SemVer 更新；手动重装旧版后可以重复验证同一目标版本，在线更新不支持降级。
- 生产服务器只激活严格更高的版本；开发服务器允许重签同一版本，但安装包 URL 使用内容摘要区分并保留旧文件。
- 发布时间最多允许领先本机时间 5 分钟；清单无到期时间。检查、下载就绪、安装前与清理后继续验证签名及安装包字节。
- 使用旧密钥签署内置新公钥的过渡版本，再切换新密钥。停留旧客户端仍需可信旧密钥过渡或手动安装。丢失/泄露密钥时不能仅在服务器删除公钥就撤销所有旧客户端信任。
- 线上坏版本以更高应用版本修复；普通更新不执行降级或用户数据自动回滚。

## 6. Debug 与回归

Debug 页粘贴原始清单及签名，保留所有换行；不支持裸 URL、大小和哈希进入安装。主进程执行与正式源相同的公钥、渠道、签名和版本校验。正式客户端不接受测试密钥；测试包使用独立渠道和公钥。

加载仅切换本次选择，不下载、不改 canonical 配置和自动下载偏好。退出测试恢复官网检查，重启不恢复选择。开发实例禁止真实安装。下载/安装期间禁止切换源；只有主窗口顶层 frame 可以调用。

自动化入口：

```powershell
npm run build:main:types
node --test --test-concurrency=1 test/desktop-updates.test.mjs test/desktop-update-security.test.mjs test/desktop-update-installers.test.mjs test/desktop-update-release.test.mjs
```

上线前真机检查：

- Windows：未做 Authenticode 签名的有效签名更新可完成 B → N；每用户/每机器安装、UAC 取消、文件锁、中文与空格路径、自定义数据根及升级重启正常。
- macOS：原生签名无效仍被拒绝，挂载 DMG 中运行或原生安装失败不能视为升级成功；普通退出不能提前安装缓存包。
- 篡改 JSON/签名/安装包、换密钥、错误品牌/渠道、旧格式有效期或发布序号字段均拒绝。
- 下载中断、重复操作、缓存复验、已就绪状态继续发现新版与重新下载正常。
- 正在运行任务、草稿确认、退出清理失败继续保护用户；服务未健康不视为升级完整成功。
- 正式包内嵌正确生产公钥，不含私钥、测试信任配置或绕过开关。

单测不替代两平台实际安装回归。本次代码验证与尚未执行的生产验收应分开记录。

### 本次实现验证记录（2026-09-21）

- 按 TDD 分批执行失败用例 → 实现 → 回归；更新协议、运行时、安装平台分支与发布工具专项测试 51/51 通过，使用临时真实 Ed25519 密钥。
- `npm run build`、主进程与渲染进程类型检查、`npm run i18n:keys`、`npm run architecture:check` 通过。
- 扩展回归当次 136 项中 128 通过、8 失败；8 项均在未修改的 HEAD 快照中复现，涉及品牌图标/路径断言与 Windows desktop-init 测试，不作为本次更新签名通过项。
- `npm run i18n:check` 的全量硬编码扫描未通过，同样在 HEAD 快照中复现；不宣称完整 `npm test` 通过。
- 尚未生成或配置生产密钥、上传或切换远程更新入口、执行实际 Windows/macOS 安装。上述生产验收仍为发布阻断项。

### 上游升级交互与恢复回归

测试与生产使用不同域名的 feedUrl。验证预发布版本和正式版本均可读取，预发布版本按 SemVer 判断是否更新，切换 URL 后旧源的待安装状态失效。生产发布流程自行保证清单指向预期正式版本。

- 模拟清理前 updateBusy，设置旁及 About 均保留重试升级入口，不重新检查或下载；清理/原生安装失败保留安装包并提示重启恢复。重启后检查同一清单直接校验缓存恢复就绪。篡改缓存后必须转为下载重试，不能启动安装器。

- 使用旧版签名安装包 + 更高版本签名更新包，验证未登录时可检查，后台下载完成后齿轮显示提示，菜单和关于页同步；重启后重新校验缓存再显示就绪。
- 自动下载关闭时仅显示可下载；检查/下载重复点击只运行一个操作；断网、超时、坏 JSON、错误产品、低版本、缺失当前架构、长度/hash 错误均不能安装。
- 有任务运行时，设置旁与 About 的升级入口均提示退出及对话可能中断，确认后直接清理并升级；取消保留已下载。已识别的原生图片/HTML/WebClient 文档草稿在同一次弹窗中提醒。其他远端网页的未提交表单不在 Desktop 草稿检测范围内。
- macOS: Squirrel.Mac 在用户点击且服务清理成功后才接收本地 ZIP，并在原生阶段验证签名、替换并重启。普通退出不会预先把已下载包交给原生更新器；原生阶段失败后应重启应用恢复服务。验证不合法签名、不同产品签名、只读安装位置、在 DMG 中运行，以及原生安装失败。
- 退出清理失败不能启动平台安装器。更新失败解除退出遮罩，保留错误和诊断入口。
- 新应用按现有启动升级事务部署服务；服务未就绪不能作为升级成功。验证升级后用户配置、账号与业务数据保留。

### 合并与平台配置验证（2026-09-24）

- 初始化与 canonical 统一使用单一 `feedUrl`；请求时携带实际平台查询参数，服务器按平台独立发布清单。
- macOS 开发机执行 `npm run build`、主进程/渲染进程类型检查、架构和国际化键检查通过。更新、签名、发布、安装器、退出、构建及初始化专项回归合计 137 项通过，2 项需要 Windows 原生环境的 NSIS 测试跳过。
- 尚未生成正式安装包、配置生产密钥或执行两平台真实在线安装；发布 env 源配置需按示例更新并重新生成。
