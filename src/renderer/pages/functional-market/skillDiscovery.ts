import type { MarketItem } from "@shared/contracts";

export const skillCategories = ["all", "life", "development", "finance", "content", "data", "productivity", "office", "business", "learning"] as const;
export type SkillCategory = typeof skillCategories[number];
const categoryAliases: Record<Exclude<SkillCategory, "all">, string[]> = {
  life: ["life", "lifestyle", "travel", "生活服务"],
  development: ["development", "developer", "coding", "system", "开发工具"],
  finance: ["finance", "investment", "投资理财"],
  content: ["content", "design", "writing", "media", "内容创作"],
  data: ["data", "analytics", "数据分析"],
  productivity: ["productivity", "automation", "efficiency", "效率工具"],
  office: ["office", "document", "collaboration", "办公协同"],
  business: ["business", "marketing", "sales", "商业运营"],
  learning: ["learning", "education", "knowledge", "知识与学习"]
};

export function isInstalledSkill(item: MarketItem) {
  return item.type === "skill" && ["installed", "local-imported", "update-available"].includes(item.state);
}

export function cloudSkills(items: MarketItem[]) {
  return items.filter((item) => item.type === "skill" && (item.marketplaceAvailable || item.source === "cloud"));
}

export function featuredSkills(items: MarketItem[], offset = 0) {
  const pool = cloudSkills(items).filter((item) => item.skillFeatured === true);
  if (!pool.length) return [];
  const start = ((offset % pool.length) + pool.length) % pool.length;
  return Array.from({ length: Math.min(3, pool.length) }, (_, index) => pool[(start + index) % pool.length]);
}

export function matchesSkillCategory(item: MarketItem, category: SkillCategory) {
  if (category === "all") return true;
  const values = [item.skill?.category, item.skill?.scenario, item.metadata?.category, ...item.tags]
    .filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase());
  return categoryAliases[category].some((alias) => values.includes(alias));
}
