import type { ComponentType } from "react";
import { DEFAULT_MARKET_TAB, type MarketTab, type MarketViewProps } from "./marketPageModel";
import { StorefrontMarket } from "./StorefrontMarket";

const MARKET_VIEWS = {
  plugins: StorefrontMarket,
  skills: StorefrontMarket,
  agents: StorefrontMarket,
  sandboxImages: StorefrontMarket,
  pets: StorefrontMarket,
  cli: StorefrontMarket,
  websiteApps: StorefrontMarket
} satisfies Record<MarketTab, ComponentType<MarketViewProps>>;

export function getMarketView(tab: MarketTab) {
  return MARKET_VIEWS[tab] ?? MARKET_VIEWS[DEFAULT_MARKET_TAB];
}
