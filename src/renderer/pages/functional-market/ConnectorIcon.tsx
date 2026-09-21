import { useState } from "react";
import { LinkOutlined } from "@ant-design/icons";
import type { MarketItem } from "@shared/contracts";

export function ConnectorIcon({ item }: { item: MarketItem }) {
  const raw = item.metadata?.icon?.trim() || "";
  const [failed, setFailed] = useState("");
  let url = "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password) url = parsed.href;
  } catch { /* Missing or invalid metadata uses the neutral connector symbol. */ }
  return url && failed !== url ? <img src={url} alt="" referrerPolicy="no-referrer" className="connector-market-icon-image" onError={() => setFailed(url)} /> : <LinkOutlined />;
}
