import { useEffect, useState } from "react";
import type { AssistantNavChatItem } from "../../../shared/contracts";
import type { TranslateFunction } from "../../../shared/i18n/types";
import { formatEpochMillis } from "../../../shared/time-contract";
import { useI18n } from "../../i18n/useI18n";

export function formatChatRelativeTime(time: number, now: number, t: TranslateFunction) {
  const minutes = Math.floor(Math.max(0, now - time) / 60_000);
  if (minutes < 1) return t("sidebar.chats.card.justNow");
  if (minutes < 60) return t(minutes === 1 ? "sidebar.chats.card.minuteAgo" : "sidebar.chats.card.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t(hours === 1 ? "sidebar.chats.card.hourAgo" : "sidebar.chats.card.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 365) return t(days === 1 ? "sidebar.chats.card.dayAgo" : "sidebar.chats.card.daysAgo", { count: days });
  const years = Math.floor(days / 365);
  return t(years === 1 ? "sidebar.chats.card.yearAgo" : "sidebar.chats.card.yearsAgo", { count: years });
}

// The Popover mounts this component only while visible, so hidden cards have no timer.
export function ChatHoverTiming({ chat }: { chat: AssistantNavChatItem }) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const askedAt = t("sidebar.chats.card.timeAgo", {
    time: formatEpochMillis(chat.createdAt),
    relative: formatChatRelativeTime(chat.createdAt, now, t),
  });
  return (
    <div className="sidebar-chat-hover-card-timing">
      <span>{t("sidebar.chats.card.askedAt", { time: askedAt })}</span>
    </div>
  );
}
