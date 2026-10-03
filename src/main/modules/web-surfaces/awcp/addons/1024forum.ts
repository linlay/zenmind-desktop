import type { AwcpAddonRule, AddonField, AddonAction } from "./types";

const text = (description: string, maxLength = 256): AddonField => ({ type: "string", minLength: 1, maxLength, description });
const id: AddonField = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const choice = (...values: string[]): AddonField => ({ type: "string", enum: values });
const flag: AddonField = { type: "boolean" };
function action(name: string, title: string, description: string, path: string,
  properties: Record<string, AddonField> = {}, required: string[] = [], method: "GET" | "POST" = "GET",
  bodyDefaults?: Record<string, unknown>): AddonAction {
  return { action: `forum.${name}`, title, description, path, method, bodyDefaults,
    inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

/** Only endpoints and parameters observed in the published forum client are exposed. */
export const forum1024Rule: AwcpAddonRule = {
  id: "1024forum", version: "1", origin: "https://1024.qiuer.net", pathPrefix: "/forum",
  apiBasePath: "/forum/api/v1",
  site: {
    name: "1024 论坛 · Desktop AWCP",
    description: "Desktop 为现有论坛注入的 AWCP 适配器。使用当前网页登录会话调用同源论坛 API，无需改造网站。可查询板块、帖子、评论和通知，也可按用户意图执行写入。普通帖子查询或关键词搜索可直接使用 forum.posts.list，无需先查板块。只有需要按板块筛选且尚不知道 slug 时，才查询 forum.sections.list；发帖时进入 /forum/new，重新读取该页 AWCP 目录后使用批量填写与发送动作。读取帖子详情无需查询板块。写入不自动刷新页面或重放；需要时由用户刷新查看。401 表示需在 Desktop 网站中登录。服务端负责权限与业务校验。",
  },
  actions: [
    action("sections.list", "查询板块", "读取可见板块及 slug、发帖权限，发帖前选择允许发帖的板块。", "/sections"),
    action("tags.list", "查询标签", "读取论坛热门标签及数量。", "/tags"),
    action("posts.list", "搜索和筛选帖子", "读取帖子列表。参数均可省略，查询列表可传 args: {}，无需先查询板块；keyword 搜索关键词。仅按板块筛选时填写 section（板块 slug），不知道 slug 时才查询 forum.sections.list。cursor 使用上次结果的 nextCursor，null 表示结束。返回 items 与 nextCursor，不修改已读状态。", "/posts", {
      keyword: text("搜索词"), section: text("板块 slug"), tag: text("标签"), author: text("作者员工号"),
      post_type: choice("QUESTION", "DISCUSSION", "ARTICLE"), status: choice("PUBLISHED", "DRAFT"),
      question_status: choice("SOLVED", "UNSOLVED"), featured: flag, bookmarked: flag,
      created_from: text("创建时间起点"), created_to: text("创建时间终点"), cursor: text("上一页返回的 nextCursor", 2048),
    }),
    action("posts.get", "读取帖子详情", "按 postId 读取帖子，返回 post（含正文与版本）。不会调用增加阅读数的接口。", "/posts/{postId}", { postId: id }, ["postId"]),
    action("comments.list", "读取评论", "按 postId 读取评论列表，返回 items。", "/posts/{postId}/comments", { postId: id }, ["postId"]),
    action("notifications.list", "读取通知", "读取当前账号通知，不标记已读。", "/notifications"),
    action("notifications.unread-count", "读取未读通知数", "返回当前账号的未读通知 count。", "/notifications/unread-count"),
    action("posts.create", "发布帖子或保存草稿", "写操作：以当前账号创建帖子。status 必须显式选择 DRAFT（草稿）或 PUBLISHED（公开发布）。先查询 sections.list 取得可发帖的 section slug；发布内容须遵循用户授权。返回服务端 post；不自动重试，未知结果先查询确认。当前支持纯 Markdown 与标签，不上传附件。", "/posts", {
      section: text("板块 slug"), type: choice("QUESTION", "DISCUSSION", "ARTICLE"),
      title: text("帖子标题", 200), bodyMarkdown: text("Markdown 正文", 100000), status: choice("DRAFT", "PUBLISHED"),
      tags: { type: "array", maxItems: 5, uniqueItems: true, items: text("标签", 64) },
    }, ["section", "type", "title", "bodyMarkdown", "status"], "POST", { tags: [], imageIds: [], attachmentIds: [], coverImageId: null }),
    action("comments.create", "发表评论或回复", "写操作：以当前账号发送评论，可能通知帖子作者。postId 为帖子 ID，parentId 可选，填写要回复的评论 ID。发送前确认内容符合用户意图；未知结果先读取评论，禁止自动重发。", "/posts/{postId}/comments", {
      postId: id, bodyMarkdown: text("评论正文", 20000), parentId: id,
    }, ["postId", "bodyMarkdown"], "POST", { parentId: null }),
    action("posts.bookmark", "切换收藏", "写操作：切换帖子收藏状态，非幂等。先读 posts.get 的 bookmarked，只在需要改变时调用一次。返回 bookmarked 与 bookmarkCount；未知结果先读取核实，不能重放。", "/posts/{postId}/bookmark", { postId: id }, ["postId"], "POST"),
    action("reactions.toggle", "切换点赞", "写操作：切换帖子或评论的点赞，非幂等。targetType 选择 POST 或 COMMENT，targetId 为对应 ID。先读取 liked 状态，仅在需要改变时调用；返回 active 和 reactionCount。未知结果先读取，不能重放。", "/reactions", {
      targetType: choice("POST", "COMMENT"), targetId: id,
    }, ["targetType", "targetId"], "POST"),
    action("notifications.mark-read", "标记指定通知已读", "写操作：将 ids 指定的通知标记已读。必须给出非空 ID 列表，不提供隐式全部已读操作。返回服务端 updated。", "/notifications/read", {
      ids: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: id },
    }, ["ids"], "POST"),
  ],
};
