import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { DesktopSsoStatus } from "@shared/contracts";

function identityKey(status: DesktopSsoStatus) {
  return status.authenticated
    ? JSON.stringify([
      status.user?.issuer,
      status.user?.sub,
      status.user?.audience,
      status.completedSteps.accessToken
    ])
    : "anonymous";
}

/** Keep catalog, favorites, dialogs and their pending requests within one identity. */
export function MarketIdentityBoundary({ children }: { children: ReactNode }) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    let identity: string | undefined;
    let receivedEvent = false;
    const unsubscribe = window.electronAPI.sso.onStatusChanged((status) => {
      receivedEvent = true;
      const next = identityKey(status);
      if (!active || next === identity) return;
      identity = next;
      // Remount the entire view, including nested detail and connector dialogs.
      // Late promises retain the old component's setters and cannot repopulate it.
      setRevision((current) => current + 1);
    });
    void window.electronAPI.sso.getStatus().then((status) => {
      // A status event is newer than this initial snapshot, even if it resolves first.
      if (active && !receivedEvent) identity = identityKey(status);
    }).catch(() => {
      // Catalog loading reports its own errors; later SSO events still invalidate it.
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return <Fragment key={revision}>{children}</Fragment>;
}
