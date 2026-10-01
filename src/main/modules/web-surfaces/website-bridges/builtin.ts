import type { WebsiteBridgeManifest } from "../../../../shared/website-bridge";
import { installAwcpAddon } from "../awcp/addons/page-runtime";
import { createForumComposeHandlers } from "../awcp/addons/forum-compose";
import type { AddonAction } from "../awcp/addons/types";
import { qiuerForumRule } from "../awcp/addons/qiuer-forum";

export type WebsiteBridgePackage = { manifest: WebsiteBridgeManifest; scripts: Map<string, string> };
export function builtinForumBridge(): WebsiteBridgePackage {
  const definitions = [
    { path: "/forum", script: "pages/forum.js", actions: ["posts.list", "sections.list", "tags.list", "notifications.unread-count"] },
    { path: "/forum/new", script: "pages/new-post.js", actions: [] },
    { path: "/forum/posts/:postId", script: "pages/post.js", actions: ["posts.get", "comments.list", "comments.create", "posts.bookmark", "reactions.toggle"] },
    { path: "/forum/notifications", script: "pages/notifications.js", actions: ["notifications.list", "notifications.unread-count", "notifications.mark-read"] },
  ];
  const manifest: WebsiteBridgeManifest = { schemaVersion: 1, id: "qiuer-forum", name: "1024 Forum", version: "1.2.3", origin: qiuerForumRule.origin,
    description: "Page-scoped AWCP for the 1024 forum.", pages: definitions.map(({ path, script }) => ({ path, script })) };
  const scripts = new Map(definitions.map(page => {
    const rule = { ...qiuerForumRule, actions: qiuerForumRule.actions.filter(action => page.actions.includes(action.action.replace("forum.", ""))) };
    if (page.path === "/forum/new") {
      const create = qiuerForumRule.actions.find(action => action.action === "forum.posts.create")!;
      const { status: _status, ...fields } = create.inputSchema.properties;
      const compose = (name: string, title: string, description: string, properties: AddonAction["inputSchema"]["properties"], required: string[] = []): AddonAction => ({
        action: "forum.compose." + name, title, description, path: "", method: "POST",
        inputSchema: { type: "object", properties, required, additionalProperties: false }
      });
      fields.bodyMarkdown = { ...fields.bodyMarkdown, maxLength: 50000 };
      rule.actions.push(
        compose("fill", "批量填写帖子", "一次调用传入 title、bodyMarkdown、tags、type、section，填写当前发帖页并回读校验，不发布。title 和 bodyMarkdown 必填，其余省略时保留页面当前值。JS 内部完成元素定位、事件触发和校验，模型无需逐项操作 DOM。返回 draft 与 draftToken，核对后调用 compose.publish。当前只支持纯文字。", fields, ["title", "bodyMarkdown"]),
        compose("publish", "发送帖子", "发送批量填写后的帖子。仅在用户授权发布且已核对 fill 返回的 draft 后，传入该次 draftToken。表单变化会拒绝发布，需重新批量填写。由注入 JS 点击页面原生发布按钮，网站自己处理校验、鉴权、提交和跳转。返回 submitted 仅表示触发表单提交，不等于发布成功；需根据后续页面或错误提示确认结果，禁止重复点击。", { draftToken: { type: "string", minLength: 1, maxLength: 128 } }, ["draftToken"])
      );
      rule.site = { ...rule.site, description: "当前发帖页只有两个业务动作：forum.compose.fill 一次填写标题、完整正文、标签、类型和板块，返回实际草稿与 draftToken；forum.compose.publish 使用该 token 发送帖子。每个动作先读取对应手册章节。填写结果已包含回读内容，无需再通过 DOM 查找或填写元素。省略 section 时使用页面当前板块。" };
    }
    if (page.path === "/forum") rule.site = { ...rule.site, description: rule.site.description + " 当前是列表页，发帖动作位于 /forum/new。需要发帖时先导航到 /forum/new，再重新读取该页 AWCP 目录，使用批量填写与发送动作。不同页面的目录不通用。" };
    const source = `// context contains this page's pathname, params, revision and AbortSignal.\nconst rule = ${JSON.stringify(rule, null, 2)};
rule.version = context.revision;
if (context.params.postId) {
  const postId = Number(context.params.postId);
  if (!Number.isSafeInteger(postId) || postId < 1) throw new Error('Invalid post page ID.');
  for (const action of rule.actions) {
    const bindings = action.action === 'forum.reactions.toggle' ? { targetType: 'POST', targetId: postId } : { postId };
    action.boundArgs = bindings;
    for (const key of Object.keys(bindings)) {
      delete action.inputSchema.properties[key];
      action.inputSchema.required = action.inputSchema.required.filter(name => name !== key);
    }
    action.description += ' The current page supplies the post identity; do not provide another post ID.';
  }
}
(${installAwcpAddon.toString()})(rule, location.href${page.path === "/forum/new" ? `, (${createForumComposeHandlers.toString()})()` : ""});
return () => globalThis.__zenmindAwcpAddon?.dispose();\n`;
    return [page.script, source];
  }));
  return { manifest, scripts };
}
