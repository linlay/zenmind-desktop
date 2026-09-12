import { useEffect, useState } from "react";
import type { DesktopUpdateState } from "../../shared/desktop-updates";

export function useDesktopUpdates() {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  useEffect(() => {
    const api = window.electronAPI?.updates;
    if (!api) return;
    let live = true;
    let revision = 0;
    const off = api.onChanged((value) => { revision++; if (live) setState(value); });
    const initialRevision = revision;
    void api.getState().then((value) => { if (live && initialRevision === revision) setState(value); }).catch(() => {});
    return () => { live = false; off(); };
  }, []);
  return state;
}
