# 内置资源与 Manifest

## 文档定位

本文描述 Desktop 如何消费内置服务发布物，以及 manifest 在资源发现和生命周期编排中的作用。字段全集、默认值和校验规则以共享类型、源码及测试为准。

## 资源边界

内置服务由各自仓库构建发布，Desktop 只消费明确的 release 目录或已同步到 `build/resources/services` 的产物。Desktop 不扫描周边源码仓库，也不读取或修改服务私有发布配置。

```text
上游服务 release
  -> Desktop 资源同步与平台校验
  -> build/resources/services
  -> Electron 打包资源
  -> 运行时发现、安装与注册
```

开发和发布入口可以校验现有资源，但不能在不知情的情况下从本机任意目录刷新 bundle。需要更新内置资源时必须显式执行同步流程。

四个内置服务的显式构建与同步入口是 macOS/Linux 的 `scripts/build-builtin-services.sh` 和 Windows 的 `scripts/build-builtin-services.ps1`。Windows host 与 Docker 发布只校验、消费已经同步的 `build/resources/services`；资源缺失时先运行对应 PowerShell 入口，发布命令本身不扫描相邻服务仓库。

该显式构建入口拥有上游服务生成产物的清理权限：传入 `--clean` 或 `-Clean` 时，在调用每个服务的 `make release` 前删除其 `dist/release`，避免旧版本、旧平台或同版本产物影响本次完整构建。清理范围只限固定的四个服务仓库中可重建的 `dist/release`，不读取或修改服务源码、配置和私有发布输入。未显式传入清理选项时保留现有发布物。

## Manifest 职责

每个 bundle 的 manifest 是 Desktop 识别该资源的唯一入口，描述：

- 稳定身份、版本、服务种类和目标平台。
- 程序包顶层结构与必须存在的运行文件。
- 前端形态、端口与健康检查能力。
- deploy、start、stop 的生命周期入口。
- Desktop 可以传递的布局、能力和动作声明。

Manifest 不承载真实密钥，也不替代服务自己的配置 schema。Desktop 可以为宿主级策略做显式归一化，但不能维护与服务 bundle 相冲突的第二份服务定义。

## 平台资源

Windows 与 macOS 使用各自平台可验证的归档和脚本格式。资源同步必须校验 OS、CPU 架构、包结构、路径安全、必要文件和签名要求；运行时只选择与当前平台匹配的版本。

平台差异在同步、解压、签名和命令执行处显式分支。一个平台验证通过不能证明另一个平台产物完整。

## 安装与注册

Desktop 同时读取 bundled 资源和已安装程序版本，按稳定 service id 建立运行时 registry。新资源通过服务生命周期完成安装与 deploy；registry 只表达当前可用定义，不成为持久配置或业务状态源。

核心服务可以有额外的硬门禁，例如必须携带的 sidecar 或 runtime resource contract。门禁属于 Desktop 与 bundle 的兼容边界，应由同步和安装测试共同锁定，而不是依赖文档字段清单。

## 安全与维护约束

WebClient 更新必须显式同步完整的服务资源集合，其他内置服务沿用已验证字节。发布链使用只读的 `scripts/verify-webclient-assets.mjs` 比较 bundle、同步资源、打包应用与部署后 dist 的实际 HTML/JS/CSS 指纹，包含懒加载 chunk；相同版本标签不能作为代码一致的证据。核验运行目录只读，不以手工替换安装目录静态文件作为交付步骤。

- 只接受 manifest 明确声明且通过平台校验的资源。
- 拒绝路径穿越、符号链接逃逸、缺失顶层目录和不完整 required paths。
- 不直接手改生成的资源目录；修改上游并重新发布、同步。
- 生成的资源索引和签名可以重建，源 manifest 与上游 release 才是长期事实。
- Desktop 只验证生命周期 contract，不代替服务脚本修复配置。

## Darwin 签名与 builtin 完整性

macOS App 的服务资源复制必须保留完整目录结构和权限，包含连接器的空目录。通用打包器按文件筛选的复制不能作为最终服务资源来源；afterPack 从已验证同步资源完整复制，再验证副本，不能通过重算清单掩盖复制时的丢失。

Platform 原始 release 的 builtin 清单与最终签名文件属于两个发布阶段。Desktop 对 Mach-O 预签名或正式签名之前，必须调用 bundle 自带的 Platform 打包命令验证现有清单；签名后再携带该次验证返回的清单摘要，请 Platform 重算单文件与目录树的哈希并复验。算法、组件元数据和清单写入归 Platform，Desktop 不自行实现或放宽启动校验。

正式 App 使用显式签名入口：先完成 Resources 中服务文件的签名与清单更新，再更新服务资源指纹，最后签名外层 App。外层递归签名必须跳过已经完成的服务目录，避免重新改变文件字节。App 签名后的验证只读执行，证书校验的开发开关不能跳过 builtin 完整性校验。损坏输入、缺少打包命令的旧 Platform 包和最终清单不匹配必须使发布失败，不在安装目录修补。

Windows/Linux 继续消费各自原始清单；签名后刷新仅用于 Darwin 发布链路。开发启动也要验证已有 Darwin Platform 资源，不能等到服务启动失败才暴露哈希错误。

## 实现事实源

- `src/main/modules/services/builtin-loader.ts`
- `src/main/support/manifest/manifest-utils.ts`
- `scripts/sync-builtin-assets.mjs` 与 `scripts/lib/builtin-assets.mjs`
- `scripts/build-builtin-services.sh` 与 `scripts/build-builtin-services.ps1`
- `src/shared/contracts/manifest.ts`
- 内置资源、bundle 路径和平台打包测试
