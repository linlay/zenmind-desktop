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

- 只接受 manifest 明确声明且通过平台校验的资源。
- 拒绝路径穿越、符号链接逃逸、缺失顶层目录和不完整 required paths。
- 不直接手改生成的资源目录；修改上游并重新发布、同步。
- 生成的资源索引和签名可以重建，源 manifest 与上游 release 才是长期事实。
- Desktop 只验证生命周期 contract，不代替服务脚本修复配置。

## 实现事实源

- `src/main/builtin-loader.ts`
- `src/main/manifest-utils.ts`
- `scripts/sync-builtin-assets.mjs` 与 `scripts/lib/builtin-assets.mjs`
- `src/shared/contracts/manifest.ts`
- 内置资源、bundle 路径和平台打包测试
