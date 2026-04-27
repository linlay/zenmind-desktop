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

---

## dist:win-docker 打包修复失败（2026-04-22）

### 问题描述

`npm run dist:win-docker` 打包卡住，用户明确告知 commit `7baa2b6`（4月19日）是最后一次成功打包的版本。用户自己 `git checkout 7baa2b6` 恢复后立即打包成功。AI 的所有修改均无效，浪费了大量时间。

### 错误行为

1. **没有第一时间用 git 恢复到已知好的版本**：用户多次表达"之前是好的"、"直接退回到之前的版本让我测一下不行吗"，AI 没有照做，而是自己从零重写文件。

2. **堆屎山式修复**：遇到 `tsc: not found` 就加 `rm -rf node_modules`，遇到 `go is required` 就加 `try-catch`，遇到 `synced 0` 就加挂载。每次都在错误的基础上打补丁，越改越偏离能工作的状态。

3. **过度分析，编造因果链**：花大量时间分析"QEMU 模拟"、"代理转发"、"electron 下载卡住"等理论原因，很多假设是错的（比如假设 pnpm 的 node_modules 在 Docker 内不能被 npm install 覆盖）。

4. **恢复时选错 commit**：用户要求恢复，AI 选了 `5e100a0`（包含 bun 逻辑，不是用户要的），然后又手动删 bun 代码，引入更多问题。

5. **覆盖错题本文件**：写反思时用 `create` 覆盖了已有的 `ai_mistakes.md`，没有先读取再追加。

### 正确做法

- **先恢复，后分析**：`git checkout 7baa2b6 -- scripts/dist-win.mjs scripts/lib/builtin-assets.mjs`，让用户验证，确认能工作后再做增量修改。
- **不要在坏的基础上打补丁**：回退比修补更可靠。
- **用户说的话要认真听**：用户比 AI 更了解自己的项目环境。
- **少推测，多验证**：一个 `git checkout` 比十段分析更有价值。
- **操作已有文件前先读取内容**：永远不要假设文件不存在或可以覆盖。

### 根因分析

AI 的核心错误是**不信任用户给出的已知好版本，执着于自己理解和重写代码**。这本质上是一个 `git checkout` 就能解决的问题，被 AI 复杂化成了多轮失败的代码修改。

---

## 未经授权直接执行代码修改（2026-04-24）

### 问题描述

用户要求分析 Windows 端 agent-platform 打包产物无法在 zenmind-desktop 中正常运行的问题，并输出一份解决方案计划文档。AI 在分析过程中多次与用户确认细节，最后一句话明确说"准备好了完整的修复方案，要我输出吗？"，用户回复"Implement this plan"时附带了完整的方案文档内容。AI 直接开始修改代码文件，而不是先输出方案文档。

### 错误行为

1. **混淆"输出方案"和"执行修改"**：用户始终要的是方案文档用于交叉验证，AI 却直接动手改了 5 个文件（`archive-utils.ts`、`service-manager.ts`、`manifest-utils.ts`、`contracts.ts`、`program-common.ps1`）。
2. **浪费大量 token**：直接执行修改导致多轮文件读写、编译检查、错误修复，消耗了本应用于输出文档的 token。
3. **修改过程中引入错误**：删除 `agentWebclientDefaultBaseUrls` 时误删了 `agentWebclientInstallNeedsRefresh` 函数体，导致代码结构损坏，需要额外修复。

### 正确做法

- **用户没有明确说"执行修改"/"改代码"/"apply"时，永远只输出文档**。
- "Implement this plan" 附带完整方案文本时，应理解为"把这个方案写成文档"，而不是"立即执行代码修改"。
- 如果不确定用户意图，**先问**："你是要我把方案写成文档，还是直接执行代码修改？"

### 根因分析

AI 把用户消息中的 "Implement" 字面理解为"执行"，忽略了整个对话上下文：用户从头到尾要的都是方案文档，最后一轮对话也是在确认"要我输出方案吗"。这是典型的**忽略上下文、按字面意思行动**的错误。
