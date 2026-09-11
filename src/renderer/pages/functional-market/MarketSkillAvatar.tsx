import { useState } from "react";
import { AppstoreOutlined, FolderOpenOutlined } from "@ant-design/icons";
import type { MarketItem } from "@shared/contracts";
import { SidebarIllustration } from "../../components/BrandMark";

export function marketAvatarUrl(item: MarketItem): string {
  const value = item.metadata?.icon || item.metadata?.screenshot || "";
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

export function MarketSkillAvatar({ item }: { item: MarketItem }) {
  const url = marketAvatarUrl(item);
  const [failed, setFailed] = useState("");
  let hash = 5381;
  for (const character of item.id) hash = ((hash << 5) + hash) ^ character.charCodeAt(0);
  const isPackage = item.skill?.kind === "package";
  const local = item.source === "local" && !item.marketplaceAvailable;
  return <span className={`skill-discovery-icon tone-${(hash >>> 0) % 6}${isPackage ? " is-package" : ""}`} aria-hidden="true">
    {url && failed !== url ? <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(url)} />
      : isPackage ? <AppstoreOutlined /> : local ? <FolderOpenOutlined /> : <SidebarIllustration kind="skill" />}
  </span>;
}
