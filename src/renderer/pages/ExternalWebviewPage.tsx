import { createElement, useEffect, useRef } from "react";

type ExternalWebviewPageProps = {
  title: string;
  url: string;
};

export function ExternalWebviewPage({ title, url }: ExternalWebviewPageProps) {
  const webviewRef = useRef<Electron.WebviewTag | null>(null);

  useEffect(() => {
    return window.electronAPI.onWebviewPopupNavigate(({ guestId, url: nextUrl }) => {
      const webview = webviewRef.current;
      if (!webview) {
        return;
      }

      let currentGuestId: number;
      try {
        currentGuestId = webview.getWebContentsId();
      } catch {
        return;
      }

      if (currentGuestId !== guestId) {
        return;
      }

      if (webview.getURL() === nextUrl) {
        return;
      }

      void webview.loadURL(nextUrl).catch((error) => {
        console.error("failed to navigate embedded webview popup", {
          guestId,
          url: nextUrl,
          error
        });
      });
    });
  }, []);

  return (
    <section className="pan-page">
      <div className="pan-drag-region" aria-hidden="true" />
      <div className="pan-frame-shell">
        {createElement("webview", {
          ref: (node: Electron.WebviewTag | null) => {
            webviewRef.current = node;
          },
          src: url,
          title,
          className: "pan-frame",
          allowpopups: "true",
          style: { width: "100%", height: "100%", border: "none" }
        })}
      </div>
    </section>
  );
}
