import type { WebsiteBridgeManifest } from "../../../../shared/website-bridge";
import { installAwcpAddon } from "../awcp/addons/page-runtime";
import { qiuerForumRule } from "../awcp/addons/qiuer-forum";

export type WebsiteBridgePackage = { manifest: WebsiteBridgeManifest; scripts: Map<string, string> };
export function builtinForumBridge(): WebsiteBridgePackage {
  const definitions = [
    { path: "/forum", script: "pages/forum.js", actions: ["posts.list", "sections.list", "tags.list", "notifications.unread-count"] },
    { path: "/forum/new", script: "pages/new-post.js", actions: ["sections.list", "tags.list", "posts.create"] },
    { path: "/forum/posts/:postId", script: "pages/post.js", actions: ["posts.get", "comments.list", "comments.create", "posts.bookmark", "reactions.toggle"] },
    { path: "/forum/notifications", script: "pages/notifications.js", actions: ["notifications.list", "notifications.unread-count", "notifications.mark-read"] },
  ];
  const manifest: WebsiteBridgeManifest = { schemaVersion: 1, id: "qiuer-forum", name: "1024 Forum", version: "1.1.0", origin: qiuerForumRule.origin,
    description: "Page-scoped AWCP for the 1024 forum.", pages: definitions.map(({ path, script }) => ({ path, script })) };
  const scripts = new Map(definitions.map(page => {
    const rule = { ...qiuerForumRule, actions: qiuerForumRule.actions.filter(action => page.actions.includes(action.action.replace("forum.", ""))) };
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
(${installAwcpAddon.toString()})(rule, location.href);
return () => globalThis.__zenmindAwcpAddon?.dispose();\n`;
    return [page.script, source];
  }));
  return { manifest, scripts };
}
