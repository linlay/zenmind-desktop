import { createElement } from "react";

type ExternalWebviewPageProps = {
  title: string;
  url: string;
};

export function ExternalWebviewPage({ title, url }: ExternalWebviewPageProps) {
  return (
    <section className="pan-page">
      <div className="pan-drag-region" aria-hidden="true" />
      <div className="pan-frame-shell">
        {createElement("webview", {
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
