# macOS 分享扩展

本目录是品牌 App 内的原生 `com.apple.share-services` 扩展。它让微信合并转发和系统分享菜单显示品牌名称与图标，接收文件、图片、链接和文字，生成附件批次，再唤起包含它的 Desktop App。

扩展在自己的 macOS Sandbox 中运行，拥有 App Sandbox、用户选中文件的只读权限及网络监听权限。它不使用 Electron 的 JIT、网络客户端或文件写入继承权限，也不申请 App Group。macOS 会保护其他 App 的数据容器，非沙盒 Electron 和本机自签名开发证书也不能据此直接读取扩展容器；文件交接使用下面的受限 loopback 传输。

原始文件通过有界流式复制写入沙盒 `Library/Application Support/ShareInbox/.staging-<uuid>`。所有附件成功后写入版本化 `manifest.json`，再原子发布为 `<uuid>` 目录。一次最多 16 个文件、合计 256 MiB。ZIP 保持原始字节，不在原生扩展内解压。失败或取消清理未发布批次；已发布内容在宿主启动或传输失败时保留，重试为同一原始批次重新建立传输并唤起宿主。

原子发布后，扩展在 `127.0.0.1` 上监听临时 TCP 端口，生成 32 字节随机一次性 ticket。它仅按快照提供当前批次的 manifest 和按序号读取的原始附件；所有请求都必须携带 `X-Native-Share-Ticket`，拒绝未知路径、请求体、chunked 请求及重复认证头，不接受任何调用方传入的文件路径。传输顺序处理连接，120 秒到期自动停止。Electron 主进程将文件流复制到自身受控 inbox，完整校验并原子发布后才发出完成确认；确认后扩展停止监听、失效 ticket 并关闭分享窗口。取消、失败或超时保留原始包，重试重新生成端口与 ticket。

`NSWorkspace.open(_:withApplicationAt:configuration:completionHandler:)` 显式选择包含当前扩展的 `.app`，发送统一的 `native-share://receive?batch=<uuid>&port=<port>&ticket=<capability>`。参数不包含文件路径或正文，ticket 只用于当前本机传输，不写入日志或持久化元数据。扩展身份与宿主标识来自自身已签名的构建元数据，不在沙盒内读取宿主 Info.plist。开发 App 与正式 App 的 bundle 标识分别派生其自己的 `.share` 标识；接收端固定只连接 `127.0.0.1`，不跟随重定向。协议命名由 `src/shared/native-share-protocol.json` 统一维护，所有品牌共用；品牌归属由指定 App、签名和自身数据目录决定。

传输和附件草稿必须保持来源无关，以便后续接入飞书、企业微信、QQ。专用入口与聊天格式解析按来源独立实现；本次扩展只取得、保存和交付原始内容，不声明这些应用已经完成接入。

构建脚本 `scripts/lib/mac-share-extension.mjs` 用已安装的 Swift 编译器产生实际 Mach-O `.appex`，编译启用 `-application-extension`。SDK 模块缓存在仓库 `build/macos-share-module-cache` 下跨临时项目复用；产物按品牌、架构、宿主身份、源码、图标、版本及编译器指纹分别缓存。macOS 开发准备与正式 `afterPack` 都会包含扩展，Windows 不执行原生构建。首次使用未缓存的 SDK 时，Swift 可能需要先构建系统框架模块。

开发签名使用宿主已有的持久开发证书；正式发布使用同一个 Developer ID Application 发布者独立签扩展，然后签外层 App。正式 Electron 递归签名跳过扩展与已签名服务，避免覆盖扩展的沙盒权限或破坏服务清单。签名后及生成更新 ZIP 前校验扩展身份、Apple 发布者和精确权限，包括仅监听而不申请网络客户端权限。正式发布仍需原有公证流程。

已有开发 App 可以增量安装扩展：

```sh
node scripts/install-mac-share-extension.mjs --brand=cutej
```

该命令不重建整个开发 App、不启动 App、不终止进程；为封存新增扩展，需要更新外层 App 的签名，应在 App 已退出时运行。可用 `--app=/absolute/path/CuteJ.app` 显式指定开发 App。若本机选中的 Xcode 尚不可用，构建会使用已独立安装的 Command Line Tools，不修改 `xcode-select` 或接受许可协议。

macOS 首次安装后可能需要在系统共享扩展设置中启用 CuteJ。开发验收也可以显式选择本机扩展：

```sh
pluginkit -e use -i cc.cutej.desktop.dev.share
pluginkit -m -A -D -v -i cc.cutej.desktop.dev.share
```

开启后关闭并重新打开微信的“其他应用”菜单。扩展只接收内容并打开可编辑草稿，后续分析由 Desktop 的显式发送交互触发。

验证入口为 `test/mac-share-extension.test.mjs` 与 `test/fixtures/mac-share-inbox.swift`，覆盖实际编译、沙盒签名、原子发布、文件保留、附件数量/大小、文件名碰撞、符号链接、取消和部分失败。与开发身份及服务签名的集成回归分别在既有 dev/builtin 签名测试中。系统分享菜单可见性和真实微信内容接收需要在 Mac 上进一步验收。

Apple API 与契约：

- [NSWorkspace 指定应用打开 URL](https://developer.apple.com/documentation/appkit/nsworkspace/open(_:withapplicationat:configuration:completionhandler:))
- [App Extension 创建与发布](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionCreation.html)
- [App Extension 激活规则](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/AppExtensionKeys.html)
