import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/useI18n";

export function LibraryDeleteNotice({ chatId }: { chatId: string }) {
  const { t } = useI18n();
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    setCount(null);
    if (typeof window.electronAPI.artifacts?.list !== "function") return;
    const load = () => {
      const request = ++generation;
      void window.electronAPI.artifacts.list({ chatId, limit: 1 }).then(result => {
        if (!cancelled && request === generation) setCount(result.total);
      }).catch(() => { if (!cancelled && request === generation) setCount(null); });
    };
    load();
    const unsubscribe = window.electronAPI.artifacts.onChanged(load);
    return () => { cancelled = true; unsubscribe(); };
  }, [chatId]);
  return <p>{t(count === null ? "artifactManagement.deleteNoticeUnknown" : "artifactManagement.deleteNotice", { count: count ?? 0 })}</p>;
}
