import { useEffect, useState } from "react";
import type { LocalDocumentWorkspaceState } from "../../shared/local-document";

const EMPTY_STATE: LocalDocumentWorkspaceState = { revision: 0, openRevision: 0, documents: [], activeDocumentId: null };

export function useLocalDocumentWorkspace() {
  const [state, setState] = useState<LocalDocumentWorkspaceState>(EMPTY_STATE);
  useEffect(() => {
    const api = window.electronAPI.localDocuments;
    if (!api) return;
    let disposed = false;
    const receive = (next: LocalDocumentWorkspaceState) => {
      if (!disposed) setState(current => next.revision >= current.revision ? next : current);
    };
    // Subscribe before requesting the snapshot so an OS open during mounting is retained.
    const unsubscribe = api.onChanged(receive);
    void api.getState().then(receive).catch(error => {
      if (!disposed) console.warn("[local-documents] state unavailable", error);
    });
    return () => { disposed = true; unsubscribe(); };
  }, []);
  return state;
}
