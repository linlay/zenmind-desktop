import React, { lazy, Suspense, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { DesktopBackground } from "../../src/renderer/appearance/DesktopBackground";
import { isWebclientHostBackgroundSurface } from "../../src/renderer/appearance/webclientProjection";
import { createServiceSurfaceIdentity, createSurfaceIdentity } from "../../src/shared/surface-identity";
import "../../src/renderer/styles.css";

type Options = {
  image: boolean;
  theme: "light" | "dark";
  platform: "mac" | "windows";
  active: boolean;
  hidden: boolean;
  supported: boolean;
  service: string;
  role: "service" | "copilot-dock";
};

const wallpaper = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=";
const fixture = (window as any).backgroundRoutingFixture = {
  errors: [] as string[], lazyRequests: [] as string[], pending: new Map(),
  loads: 0, imageErrors: 0, mounts: 0, api: null as any, sample: null as any
};
window.addEventListener("error", event => fixture.errors.push(event.message));
window.addEventListener("unhandledrejection", event => fixture.errors.push(String(event.reason)));
document.addEventListener("load", event => {
  if ((event.target as Element)?.matches?.(".desktop-background-image")) fixture.loads++;
}, true);
document.addEventListener("error", event => {
  if ((event.target as Element)?.matches?.(".desktop-background-image")) fixture.imageErrors++;
}, true);
const identities = new WeakMap<Node, number>(); let sequence = 0;
const identity = (node: Node | null) => {
  if (!node) return null;
  if (!identities.has(node)) identities.set(node, ++sequence);
  return identities.get(node);
};

function deferredPage(name: string) {
  return lazy(() => new Promise<{ default: React.ComponentType<any> }>(resolve => {
    fixture.lazyRequests.push(name);
    fixture.pending.set(name, () => resolve({ default: GuestPage }));
  }));
}
const KbasesPage = deferredPage("kbases");
const AutomationsPage = deferredPage("automations");

function KanbanPage({ business }: { business: number }) {
  return <section className="kanban-page" data-page="kanban">
    <header className="kanban-toolbar"><strong>Kanban</strong><span>Business {business}</span></header>
    <div className="kanban-columns"><section className="kanban-column">Native board content.</section></div>
  </section>;
}

function GuestPage({ options, bridgeReady, name }: { options: Options; bridgeReady: boolean; name: string }) {
  const surface = options.role === "service"
    ? createServiceSurfaceIdentity(options.service) : createSurfaceIdentity("copilot-dock");
  const eligible = isWebclientHostBackgroundSurface(options.service, surface,
    options.supported ? `/${name}` : "/memory");
  return <section data-page={name} data-eligible={String(eligible)} hidden={options.hidden || !options.active}
    className={["embedded-surface-page", eligible && options.active ? "agent-webclient-background-surface" : "",
      eligible && options.active && bridgeReady ? "agent-webclient-host-background" : ""].filter(Boolean).join(" ")}>
    <div className="embedded-surface-frame-shell"><div className="embedded-surface-frame">{bridgeReady ? "Appearance ready" : "Appearance pending"}</div></div>
  </section>;
}

function Scene() {
  const location = useLocation(), navigate = useNavigate();
  const [options, setOptions] = useState<Options>({ image: true, theme: "light", platform: "mac", active: true,
    hidden: false, supported: true, service: "agent-webclient", role: "service" });
  const [bridgeReady, setBridgeReady] = useState(false), [business, setBusiness] = useState(0), [newBoundary, setNewBoundary] = useState(false);
  useLayoutEffect(() => { fixture.mounts++; }, []);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = options.theme;
    root.dataset.desktopBackground = options.image ? "image" : "none";
    root.dataset.desktopBackgroundSource = options.image ? "skin" : "none";
    root.style.setProperty("--bg-base", options.theme === "dark" ? "#172123" : "#e9f0eb");
    root.style.setProperty("--shell-content-bg", options.theme === "dark" ? "rgba(23,33,35,.7)" : "rgba(233,240,235,.7)");
  }, [options.image, options.theme]);
  // Publish probes only after commit. A suspended render must not report a new
  // route while the DOM still shows the previous committed tree.
  useLayoutEffect(() => {
    fixture.api = { navigate, setBridgeReady, setNewBoundary, setOptions: (next: Partial<Options>) => setOptions(value => ({ ...value, ...next })),
      bumpBusiness: () => setBusiness(value => value + 1), release: (name: string) => fixture.pending.get(name)?.() };
    fixture.sample = () => {
    const style = (selector: string) => {
      const node = document.querySelector(selector); if (!node) return null;
      const css = getComputedStyle(node);
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      context.fillStyle = css.backgroundColor; context.fillRect(0, 0, 1, 1);
      return { backdrop: css.backdropFilter, background: css.backgroundColor,
        backgroundAlpha: context.getImageData(0, 0, 1, 1).data[3] / 255,
        visible: Boolean(node.getClientRects().length) };
    };
    const img = document.querySelector<HTMLImageElement>(".desktop-background-image");
    const guest = document.querySelector<HTMLElement>(".embedded-surface-page");
    return { route: location.pathname, options, bridgeReady, newBoundary, business, mounts: fixture.mounts,
      image: { node: identity(img), src: img?.getAttribute("src") ?? null, count: document.querySelectorAll(".desktop-background-image").length,
        state: img?.dataset.backgroundState ?? null, visibility: img ? getComputedStyle(img).visibility : null, loads: fixture.loads, errors: fixture.imageErrors },
      content: style(".app-content"), main: style(".app-main"), toolbar: style(".kanban-toolbar"), guest: style(".embedded-surface-page"),
      frameShell: style(".embedded-surface-frame-shell"), frame: style(".embedded-surface-frame"),
      guestClass: guest?.className ?? "", guestHidden: guest?.hidden ?? null,
      visiblePages: [...document.querySelectorAll<HTMLElement>("[data-page]")].filter(node => node.getClientRects().length).map(node => node.dataset.page),
      rootClass: document.querySelector(".app-shell")?.className, errors: [...fixture.errors] };
    };
  });
  const native = location.pathname === "/kanban";
  const rootSurface = options.role === "service" ? createServiceSurfaceIdentity(options.service) : createSurfaceIdentity("copilot-dock");
  const hostBackgroundSurface = !native && options.active && !options.hidden && isWebclientHostBackgroundSurface(options.service,
    rootSurface, options.supported ? location.pathname : "/memory");
  const shell = ["app-shell", options.platform === "mac" ? "is-mac-platform is-mac-translucent-sidebar" : "is-windows-platform",
    native ? "has-kanban-controls has-standard-base-surface" : "has-embedded-surface has-service-webview-surface",
    hostBackgroundSurface ? "has-webclient-background-surface" : ""].filter(Boolean).join(" ");
  return <div className={shell} style={{ height: "100vh", width: "100vw" }}>
    <DesktopBackground background={options.image ? { imageUrl: wallpaper, position: "center" } : null} />
    <div className="app-content"><main className="app-main">
      <Suspense key={newBoundary ? location.pathname : "stable"} fallback={null}><Routes>
        <Route path="/kanban" element={<KanbanPage business={business} />} />
        <Route path="/kbases" element={<KbasesPage options={options} bridgeReady={bridgeReady} name="kbases" />} />
        <Route path="/automations" element={<AutomationsPage options={options} bridgeReady={bridgeReady} name="automations" />} />
      </Routes></Suspense>
    </main></div>
  </div>;
}

createRoot(document.getElementById("root")!).render(<HashRouter><Scene /></HashRouter>);
