import type { KanbanWorkflowStage } from "../../../shared/contracts";

export const STAGE_SEMANTIC_COLORS = {
  research: "#ad835d",
  development: "#6684a3",
  testing: "#708f78",
  release: "#8c725f",
  planning: "#628b8e",
  completed: "#78838d"
} as const;

const DEFAULT_STAGE_COLORS = [
  STAGE_SEMANTIC_COLORS.planning,
  STAGE_SEMANTIC_COLORS.development,
  STAGE_SEMANTIC_COLORS.testing,
  STAGE_SEMANTIC_COLORS.research,
  STAGE_SEMANTIC_COLORS.release
] as const;

const FALLBACK_STAGE_COLOR = "#78838d";

// The Server catalog is authoritative. Standard stages created before color metadata
// existed can still have an empty color, so keep this fallback aligned with Website.
export function resolveWorkflowStageColor(
  stage: Pick<KanbanWorkflowStage, "color" | "key" | "name"> | undefined,
  index = -1
) {
  const configured = stage?.color?.trim();
  if (configured && /^#[0-9a-f]{6}$/iu.test(configured)) return configured;

  const semantic = `${stage?.key ?? ""} ${stage?.name ?? ""}`.toLocaleLowerCase();
  if (/(testing|test|regression|verification|acceptance|review|proofread|测试|回归|验证|验收|审查|审校)/u.test(semantic)) {
    return STAGE_SEMANTIC_COLORS.testing;
  }
  if (/(development|implementation|fix|copywriting|production|processing|开发|实现|修复|撰写|制作|处理)/u.test(semantic)) {
    return STAGE_SEMANTIC_COLORS.development;
  }
  if (/(research|explor|assessment|diagnos|reproduce|triage|调研|探索|评估|定位|复现|分诊)/u.test(semantic)) {
    return STAGE_SEMANTIC_COLORS.research;
  }
  if (/(deployment|deploy|release|publish|delivery|canary|部署|发布|投放|上线|交付|灰度)/u.test(semantic)) {
    return STAGE_SEMANTIC_COLORS.release;
  }
  if (/(planning|plan|design|clarification|decomposition|requirement|topic|策划|方案|设计|澄清|拆分|需求|选题)/u.test(semantic)) {
    return STAGE_SEMANTIC_COLORS.planning;
  }
  if (/(completed|complete|closed|done|结束|完成|已完成)/u.test(semantic)) {
    return STAGE_SEMANTIC_COLORS.completed;
  }
  return index >= 0 ? DEFAULT_STAGE_COLORS[index % DEFAULT_STAGE_COLORS.length] : FALLBACK_STAGE_COLOR;
}
