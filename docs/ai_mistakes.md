# AI Mistakes

## 问题描述

Builtin 服务通过“导入插件”安装时被 `installPluginFromArchive()` 直接拒绝，并提示用户去控制中心安装。但在内置资源包没有被打入应用，或者用户需要从外部归档安装/更新 builtin 服务时，控制中心并不存在对应服务卡片，导致“导入插件不能装，控制中心也没法装”的死循环。

## 错误示例

```ts
if (manifest.kind === "builtin") {
  return {
    ok: false,
    message: `安装包 ${manifest.name} 是内置服务，请在控制中心对应服务卡片中安装。`,
    serviceId: manifest.id
  };
}
```

这段逻辑隐含了一个错误前提：只要 `kind === "builtin"`，就一定已经通过应用内置资源包完成注册，用户只需要在控制中心点击安装即可。

## 正确示例

```ts
if (manifest.kind === "builtin") {
  registerService(manifest, {
    defaultKind: "builtin",
    desktop: {
      assetFileName: path.basename(archivePath)
    }
  });
  const { installBuiltinService } = await import("./service-manager");
  await installBuiltinService(app, manifest.id, { force: true, archivePath });
  return { ok: true, message: `内置服务 ${manifest.name} 已安装。`, serviceId: manifest.id };
}
```

正确做法不是按 `kind` 拒绝安装，而是按 `kind` 路由到正确的安装流程。对于 builtin 包，需要先把 manifest 注册到 service registry，再调用 `installBuiltinService()`，让文件落到 `services/{id}/{version}`，与控制中心从内置资源安装的路径保持一致。

## 根因分析

- 设计时默认假设“内置服务一定随桌面应用一起分发”，没有覆盖资源包缺失、裁剪发行包、外部手动安装或升级 builtin 服务的场景。
- “导入插件”入口的职责被错误理解成“只处理 plugin 类型”，实际上它应该是“处理任意服务归档导入”，然后再根据 `kind` 分发到 plugin 或 builtin 的安装路径。
- 安装入口和注册入口被拆开后，没有补上“导入 builtin 归档时先注册再安装”的桥接逻辑，最终让 UI 和安装器形成互相依赖的闭环。
