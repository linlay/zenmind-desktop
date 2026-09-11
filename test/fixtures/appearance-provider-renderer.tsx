import React, { Component, memo, useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AppearanceProvider, useAppearance, useAppearanceSnapshot } from "../../src/renderer/appearance/AppearanceProvider";
import { ServicesProvider } from "../../src/renderer/services/ServicesContext";
import { ServiceWebviewSurface } from "../../src/renderer/service-webview/ServiceWebviewSurface";
import { AppErrorBoundary } from "../../src/renderer/AppErrorBoundary";
import { createSurfaceIdentity } from "../../src/shared/surface-identity";
import "../../src/renderer/styles/theme.css";

const fixture = window.fixture = {
  errors: [],
  readMounts: 0,
  snapshots: [],
  exits: 0,
  api: null,
  render: null,
  unmount: null,
};
window.addEventListener("error", (event) => fixture.errors.push(event.message));
window.addEventListener("unhandledrejection", (event) => fixture.errors.push(String(event.reason)));

// Memoization prevents the provider's own rerenders from hiding a broken hook
// subscription: this consumer only updates when its external store notifies it.
const ReadProbe = memo(function ReadProbe() {
  const snapshot = useAppearanceSnapshot();
  const [instance] = useState(() => crypto.randomUUID());
  useEffect(() => { fixture.readMounts++; }, []);
  useLayoutEffect(() => { fixture.snapshots.push(snapshot); }, [snapshot]);
  return <output id="read-snapshot" data-instance={instance}
    data-theme={snapshot?.resolvedTheme ?? "none"}
    data-skin={snapshot?.skin.id ?? "none"} />;
});

function SettingsProbe() {
  const appearance = useAppearance();
  useLayoutEffect(() => { fixture.api = appearance; });
  return <output id="settings-snapshot" data-theme={appearance.resolvedTheme} />;
}

class GuardBoundary extends Component {
  state = { message: "" };
  static getDerivedStateFromError(error) { return { message: error.message }; }
  render() {
    return this.state.message
      ? <output id="guard-error">{this.state.message}</output>
      : this.props.children;
  }
}

function AuxiliarySurface({ theme }) {
  return <MemoryRouter initialEntries={["/selection-explain-window"]}>
    <ServicesProvider>
      <ReadProbe />
      <ServiceWebviewSurface hostTheme={theme} active serviceId="agent-webclient"
        ownerChatId="fixture-chat" embedPath="/selection-explain/fixture-chat?runId=fixture-run"
        surfaceIdentity={createSurfaceIdentity("selection-explain", "", { ownerChatId: "fixture-chat" })}
        skipContextRegistration loadInitialEmbeddedUrlDirectly suppressInitialLoadingCopy />
    </ServicesProvider>
  </MemoryRouter>;
}

function FailedAuxiliaryView() {
  throw new Error("fixture auxiliary view failure");
}

const root = createRoot(document.getElementById("root"));
fixture.render = (kind, theme = "light") => {
  if (kind === "main") {
    root.render(<AppearanceProvider><ReadProbe /><SettingsProbe /></AppearanceProvider>);
  } else if (kind === "settings-without-provider") {
    root.render(<GuardBoundary><SettingsProbe /></GuardBoundary>);
  } else if (kind === "auxiliary-error") {
    root.render(<AppErrorBoundary resetKey="/selection-explain-window" onExit={() => { fixture.exits++; }}>
      <FailedAuxiliaryView />
    </AppErrorBoundary>);
  } else {
    document.documentElement.dataset.theme = theme;
    root.render(<AuxiliarySurface key={theme} theme={theme} />);
  }
};
fixture.unmount = () => root.unmount();
