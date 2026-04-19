import "@fontsource/ibm-plex-mono";
import "@fontsource/manrope";
import "@fontsource/material-symbols-rounded";
import "@fontsource/syne";
import "katex/dist/katex.min.css";
import "./shared/styles/globals.native.css";
import { useEffect, useMemo, useRef } from "react";
import App from "./app/App";
import {
  setAgentWebClientHost,
  type HostCodeAssistantAccessControl,
  type HostCodeAssistantRepoControl,
  type HostAccessTokenReason,
  type HostCodeAssistantRuntimeStatus,
  type HostThemeMode
} from "./lib/host";

type NativeAppProps = {
  serviceBaseUrl: string;
  themeMode: HostThemeMode;
  requestAccessToken: (reason: HostAccessTokenReason) => Promise<string | null>;
  codeAssistantRuntime?: HostCodeAssistantRuntimeStatus | null;
  codeAssistantAccess?: HostCodeAssistantAccessControl | null;
  codeAssistantRepo?: HostCodeAssistantRepoControl | null;
};

export function NativeApp({
  serviceBaseUrl,
  themeMode,
  requestAccessToken,
  codeAssistantRuntime,
  codeAssistantAccess,
  codeAssistantRepo
}: NativeAppProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostConfig = useMemo(
    () => ({
      mode: "desktop-native" as const,
      serviceBaseUrl,
      themeMode,
      requestAccessToken,
      codeAssistantRuntime,
      codeAssistantAccess,
      codeAssistantRepo,
      nativeRootElement: rootRef.current
    }),
    [codeAssistantAccess, codeAssistantRepo, codeAssistantRuntime, requestAccessToken, serviceBaseUrl, themeMode]
  );

  setAgentWebClientHost(hostConfig);

  useEffect(() => {
    setAgentWebClientHost({
      ...hostConfig,
      nativeRootElement: rootRef.current
    });

    return () => {
      setAgentWebClientHost(null);
    };
  }, [hostConfig]);

  return (
    <div className="assistant-native-root" data-theme={themeMode} ref={rootRef}>
      <App hostThemeMode={themeMode} />
    </div>
  );
}
