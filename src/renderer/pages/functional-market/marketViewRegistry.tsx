import type { ComponentType } from "react";
import { DEFAULT_MARKET_TAB, type MarketTab, type MarketViewProps } from "./marketPageModel";
import { PluginMarket } from "./PluginMarket";
import { SandboxImageMarket } from "./SandboxImageMarket";
import { SkillMarket } from "./SkillMarket";

const MARKET_VIEWS = {
  plugins: PluginMarket,
  skills: SkillMarket,
  sandboxImages: SandboxImageMarket
} satisfies Record<MarketTab, ComponentType<MarketViewProps>>;

export function getMarketView(tab: MarketTab) {
  return MARKET_VIEWS[tab] ?? MARKET_VIEWS[DEFAULT_MARKET_TAB];
}
