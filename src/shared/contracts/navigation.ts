export interface CustomSidebarItem {
  id: string;
  label: string;
  url: string;
  agentKey?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CustomSidebarItemInput {
  label?: string;
  url: string;
  agentKey?: string;
}

export interface CustomSidebarUpdateInput {
  label?: string;
  url?: string;
  agentKey?: string;
}

export interface CustomSidebarItemsResult {
  ok: boolean;
  items: CustomSidebarItem[];
  message: string;
}

export interface CustomSidebarItemResult {
  ok: boolean;
  item: CustomSidebarItem | null;
  items: CustomSidebarItem[];
  message: string;
}

export interface CustomSidebarDeleteResult {
  ok: boolean;
  items: CustomSidebarItem[];
  message: string;
}

export interface CustomSidebarTransferResult {
  ok: boolean;
  items: CustomSidebarItem[];
  path: string;
  message: string;
}
