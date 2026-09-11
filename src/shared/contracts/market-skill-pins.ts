export interface MarketSkillPins {
  version: number;
  /** Official Platform skill order, newest pin first; never changes skill availability. */
  order: string[];
  updatedAt?: number;
}

export interface MarketSkillPinUpdate { key: string; pinned: boolean }
