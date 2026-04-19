import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { NativeApp } from "../assistant-webclient/NativeApp";
import { useServices } from "../services/ServicesContext";
import type { CodeAssistantRepoContext, CodeAssistantStatus, ServiceState } from "@shared/contracts";
import type { HostCodeAssistantAccessMode } from "../assistant-webclient/lib/host";
import "../assistant-page.css";

type AssistantPageProps = {
  hostTheme: "light" | "dark";
  visible?: boolean;
};

const PERMISSION_BANNER_ACK_STORAGE_KEY = "zenmind-desktop.code-assistant.permission-banner.ack";
const PERMISSION_BANNER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const MANAGED_CODE_ASSISTANT_AGENT_KEY = "codeAssistant";
const CODE_ASSISTANT_CLI_WAIT_TIMEOUT_MS = 20_000;
const CODE_ASSISTANT_CLI_WAIT_INTERVAL_MS = 800;

type ActionState =
  | "idle"
  | "starting"
  | "restarting"
  | "preparing-code-assistant"
  | "restarting-code-assistant"
  | "updating-code-access";

type ActionResult = {
  ok: boolean;
  message: string;
  prompted?: boolean;
  status?: CodeAssistantStatus;
};

function readPermissionBannerAckAt() {
  if (typeof window === "undefined") {
    return 0;
  }
  const raw = window.localStorage.getItem(PERMISSION_BANNER_ACK_STORAGE_KEY);
  if (!raw) {
    return 0;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function writePermissionBannerAckAt(timestamp: number) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(PERMISSION_BANNER_ACK_STORAGE_KEY, String(timestamp));
}

function shouldShowPermissionBanner(lastAckAt: number) {
  return lastAckAt <= 0 || Date.now() - lastAckAt >= PERMISSION_BANNER_INTERVAL_MS;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function AssistantPage({ hostTheme, visible = true }: AssistantPageProps) {
  const {
    services,
    loading,
    error,
    start,
    restart
  } = useServices();
  const [actionState, setActionState] = useState<ActionState>("idle");
  const [feedback, setFeedback] = useState("");
  const [codeAssistantStatus, setCodeAssistantStatus] = useState<CodeAssistantStatus | null>(null);
  const [codeAssistantLoading, setCodeAssistantLoading] = useState(true);
  const [repoContext, setRepoContext] = useState<CodeAssistantRepoContext | null>(null);
  const [repoPending, setRepoPending] = useState(false);
  const [permissionBannerAckAt, setPermissionBannerAckAt] = useState(() => readPermissionBannerAckAt());
  const autoPrepareKeyRef = useRef("");
  const hasLoadedCodeAssistantRef = useRef(false);

  const service = useMemo(
    () => services.find((item) => item.id === "agent-webclient") ?? null,
    [services]
  );
  const platformService = useMemo(
    () => services.find((item) => item.id === "agent-platform") ?? null,
    [services]
  );
  const codeRelayService = useMemo(
    () => services.find((item) => item.id === "claude-code-relay") ?? null,
    [services]
  );
  const coreAssistantReady =
    service?.status === "running" &&
    Boolean(service.healthMeta.webUrl) &&
    platformService?.status === "running";
  const codeAssistantReady =
    codeAssistantStatus?.enabled === true &&
    codeAssistantStatus.ready === true;
  const codeAssistantRecovering = codeAssistantStatus?.recovering === true;
  const assistantReady = coreAssistantReady && codeAssistantReady;

  useEffect(() => {
    const main = document.querySelector(".app-main");
    if (!(main instanceof HTMLElement)) {
      return;
    }
    main.classList.toggle("assistant-immersive", visible);
    return () => {
      main.classList.remove("assistant-immersive");
    };
  }, [visible]);

  const refreshRepoContext = useMemo(
    () => async () => {
      try {
        const next = await window.electronAPI.codeAssistant.getRepoContext();
        setRepoContext(next);
      } catch {
        setRepoContext(null);
      }
    },
    []
  );

  useEffect(() => {
    void refreshRepoContext();
  }, [refreshRepoContext, codeAssistantStatus?.running, codeAssistantStatus?.repoPath]);

  useEffect(() => {
    let cancelled = false;
    if (!hasLoadedCodeAssistantRef.current) {
      setCodeAssistantLoading(true);
    }
    void window.electronAPI.codeAssistant.getStatus()
      .then((result) => {
        if (cancelled) {
          return;
        }
        setCodeAssistantStatus(result);
      })
      .catch((reason) => {
        if (cancelled) {
          return;
        }
        setCodeAssistantStatus({
          enabled: false,
          fullAccessGranted: false,
          running: false,
          configured: false,
          repoSelected: false,
          repoPath: "",
          cliConnected: false,
          recovering: false,
          ready: false,
          error: reason instanceof Error ? reason.message : String(reason)
        });
      })
      .finally(() => {
        if (!cancelled) {
          hasLoadedCodeAssistantRef.current = true;
          setCodeAssistantLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [services]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await window.electronAPI.codeAssistant.getStatus();
        if (!cancelled) {
          setCodeAssistantStatus(next);
        }
      } catch (reason) {
        if (!cancelled) {
          setCodeAssistantStatus((current) =>
            current
              ? {
                  ...current,
                  cliConnected: false,
                  recovering: false,
                  ready: false,
                  error: reason instanceof Error ? reason.message : String(reason)
                }
              : current,
          );
        }
      }
    };

    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [visible]);

  async function runAction(
    nextState: ActionState,
    action: () => Promise<ActionResult>,
    pendingMessage = "",
    options?: {
      onSettled?: (result: ActionResult) => void;
    }
  ) {
    setActionState(nextState);
    setFeedback(pendingMessage);
    try {
      const result = await action();
      if ("status" in result && result.status) {
        setCodeAssistantStatus(result.status);
      }
      setFeedback(result.message);
      options?.onSettled?.(result);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setActionState("idle");
    }
  }

  async function waitForCodeAssistantCliConnected(
    initialResult: ActionResult,
    successMessage: string
  ): Promise<ActionResult> {
    if (initialResult.status) {
      setCodeAssistantStatus(initialResult.status);
    }
    if (!initialResult.ok) {
      return initialResult;
    }
    if (initialResult.status?.ready) {
      return {
        ...initialResult,
        message: successMessage,
      };
    }

    setFeedback("代码助手已启动，正在等待 CLI 连接到 relay...");
    setCodeAssistantStatus((current) =>
      current
        ? {
            ...current,
            cliConnected: false,
            recovering: true,
            ready: false,
          }
        : current,
    );

    const deadline = Date.now() + CODE_ASSISTANT_CLI_WAIT_TIMEOUT_MS;
    let latestStatus = initialResult.status;
    let latestError = "";
    while (Date.now() < deadline) {
      await wait(CODE_ASSISTANT_CLI_WAIT_INTERVAL_MS);
      try {
        latestStatus = await window.electronAPI.codeAssistant.getStatus();
        setCodeAssistantStatus(latestStatus);
        if (latestStatus.ready) {
          return {
            ...initialResult,
            ok: true,
            message: successMessage,
            status: latestStatus,
          };
        }
      } catch (reason) {
        latestError = reason instanceof Error ? reason.message : String(reason);
      }
    }

    return {
      ...initialResult,
      ok: false,
      message: latestError
        ? `代码助手已启动，但等待 CLI 连接超时：${latestError}`
        : "代码助手已启动，但 CLI 仍在连接中，请稍候再试。",
      status: latestStatus,
    };
  }

  async function restartCodeAssistantRuntimeAndWait(
    successMessage = "代码助手 CLI 已连接，可以继续提问。"
  ) {
    const result = await window.electronAPI.codeAssistant.restartRuntime();
    return waitForCodeAssistantCliConnected(result, successMessage);
  }

  useEffect(() => {
    if (!visible) {
      return;
    }
    if (assistantReady) {
      autoPrepareKeyRef.current = "";
      return;
    }
    if (
      !service ||
      !platformService ||
      !codeRelayService ||
      loading ||
      codeAssistantLoading ||
      actionState !== "idle" ||
      !codeAssistantStatus
    ) {
      return;
    }

    const attemptKey = [
      service.status,
      service.healthMeta.webUrl ? "web-ready" : "web-missing",
      platformService.status,
      codeRelayService.status,
      codeAssistantStatus.enabled ? "enabled" : "disabled",
      codeAssistantStatus.running ? "relay-running" : "relay-stopped",
      codeAssistantStatus.fullAccessGranted ? "full-access" : "restricted",
      codeAssistantStatus.error ?? ""
    ].join("|");
    if (autoPrepareKeyRef.current === attemptKey) {
      return;
    }
    autoPrepareKeyRef.current = attemptKey;

    if (!codeAssistantStatus.enabled || !codeAssistantStatus.running) {
      void runAction(
        "preparing-code-assistant",
        () => window.electronAPI.codeAssistant.ensureReady(),
        codeAssistantStatus.enabled
          ? "正在启动代码助手..."
          : "正在启用代码助手并准备运行环境..."
      );
      return;
    }

    // Chat switches can briefly disconnect the CLI; keep the shell mounted instead of restarting services.
    if (codeAssistantStatus.running && !codeAssistantStatus.ready && coreAssistantReady) {
      return;
    }

    if (coreAssistantReady) {
      return;
    }

    const shouldRestartWebclient = service.status === "running";
    void runAction(
      shouldRestartWebclient ? "restarting" : "starting",
      () => (shouldRestartWebclient ? restart(service.id) : start(service.id)),
      shouldRestartWebclient
        ? "正在重整小宅助理服务链路..."
        : "正在准备小宅助理与对话服务..."
    );
  }, [
    actionState,
    assistantReady,
    coreAssistantReady,
    codeAssistantLoading,
    codeAssistantReady,
    codeAssistantStatus,
    codeRelayService,
    loading,
    platformService,
    restart,
    service,
    start,
    visible
  ]);

  if (!service || !platformService || !codeRelayService) {
    return (
      <section className="assistant-route-shell">
        <div className="assistant-empty-shell">
          <section className="empty-state">
            <p className="eyebrow">Assistant</p>
            <h1>小宅助理未注册</h1>
            <p>当前 Desktop 服务列表里缺少小宅助理、智能体平台或代码助手插件，请先确认 Desktop 内置资源已同步完成。</p>
            <div className="assistant-empty-actions">
              <Link className="primary-link" to="/control-center">
                前往控制中心
              </Link>
            </div>
          </section>
        </div>
      </section>
    );
  }

  const pending = actionState !== "idle";
  const updatingAccess = actionState === "updating-code-access";
  const shouldKeepLiveShell =
    visible &&
    coreAssistantReady &&
    codeAssistantStatus?.enabled === true &&
    (assistantReady || updatingAccess || codeAssistantRecovering || codeAssistantStatus?.running === true);
  const codeAssistantStatusLabel = resolveCodeAssistantStatusLabel(codeAssistantStatus, codeRelayService);
  const repoSelected = codeAssistantStatus?.repoSelected === true;
  const accessMode = codeAssistantStatus?.fullAccessGranted ? "global" : "folder";
  const accessModeLabel = resolveAccessModeLabel(codeAssistantStatus, repoSelected);
  const serviceStatuses = [
    { label: "小宅助理", value: service.statusLabel },
    { label: "智能体平台", value: platformService.statusLabel },
    { label: "代码助手", value: codeAssistantStatusLabel },
    { label: "访问模式", value: accessModeLabel }
  ];
  const detailMessage = resolveDetailMessage(
    service,
    platformService,
    codeRelayService,
    codeAssistantStatus,
    pending || codeAssistantLoading
  );
  const retryActionState = service.status === "running" ? "restarting" : "starting";
  const retryPendingMessage =
    service.status === "running"
      ? "正在重整小宅助理服务链路..."
      : "正在准备小宅助理与对话服务...";
  const shouldPrepareCodeAssistant =
    !codeAssistantStatus ||
    !codeAssistantStatus.enabled ||
    !codeAssistantStatus.running;
  const primaryAction = shouldPrepareCodeAssistant
    ? () =>
        void runAction(
          "preparing-code-assistant",
          () => window.electronAPI.codeAssistant.ensureReady(),
          codeAssistantStatus?.enabled
            ? "正在启动代码助手..."
            : "正在启用代码助手并准备运行环境..."
        )
    : () =>
        void runAction(
          retryActionState,
          () => (service.status === "running" ? restart(service.id) : start(service.id)),
          retryPendingMessage
        );
  const primaryActionLabel = shouldPrepareCodeAssistant
    ? pending && !updatingAccess
      ? "准备中..."
      : codeAssistantStatus?.enabled
        ? "启动代码助手"
        : "启用代码助手"
    : pending && !updatingAccess
      ? "准备中..."
      : "重新准备小宅助理";
  const alternateAccessMode: HostCodeAssistantAccessMode = accessMode === "global" ? "folder" : "global";
  const alternateAccessModeLabel = alternateAccessMode === "global" ? "切到全局访问" : "切到指定文件夹";
  const showManualCodeAssistantRestart =
    Boolean(codeAssistantStatus?.enabled) &&
    Boolean(codeAssistantStatus?.running) &&
    codeAssistantStatus?.cliConnected === false;
  const acknowledgePermissionBanner = () => {
    const nextAckAt = Date.now();
    setPermissionBannerAckAt(nextAckAt);
    writePermissionBannerAckAt(nextAckAt);
  };
  const showPermissionBanner = visible && assistantReady && shouldShowPermissionBanner(permissionBannerAckAt);
  const handleSelectAccessMode = (targetMode: HostCodeAssistantAccessMode) => {
    if (!codeAssistantStatus) {
      return;
    }
    if (targetMode === "global") {
      if (codeAssistantStatus.fullAccessGranted) {
        return;
      }
      void runAction(
        "updating-code-access",
        () => window.electronAPI.codeAssistant.setFullAccessGranted(true),
        "正在切换为全局访问...",
        {
          onSettled: (result) => {
            if (result.ok || result.prompted) {
              acknowledgePermissionBanner();
            }
          }
        }
      );
      return;
    }

    void runAction(
      "updating-code-access",
      async () => {
        let latestStatus = codeAssistantStatus;
        let latestContext = repoContext;

        if (!latestStatus.repoSelected) {
          setRepoPending(true);
          try {
            const repoResult = await window.electronAPI.codeAssistant.selectRepoPath();
            setRepoContext(repoResult.context);
            latestContext = repoResult.context;
            const refreshedStatus = await window.electronAPI.codeAssistant.getStatus();
            setCodeAssistantStatus(refreshedStatus);
            latestStatus = refreshedStatus;
            if (!repoResult.ok || !repoResult.context.userSelected) {
              return {
                ok: false,
                message: repoResult.message || "请先选择一个工作目录。",
                status: refreshedStatus
              };
            }
          } finally {
            setRepoPending(false);
          }
        }

        if (!latestStatus.fullAccessGranted) {
          const latestRepoPath = latestContext?.repoPath ?? "";
          const latestRepoName = latestRepoPath
            ? latestRepoPath.split(/[\\/]/u).filter(Boolean).pop() ?? latestRepoPath
            : "";
          return {
            ok: true,
            message: `代码助手已切换为指定文件夹模式${latestRepoName ? `：${latestRepoName}` : ""}`,
            status: latestStatus
          };
        }

        return window.electronAPI.codeAssistant.setFullAccessGranted(false);
      },
      repoSelected ? "正在切换为指定文件夹模式..." : "正在选择代码助手工作目录..."
    );
  };

  const handleSelectRepo = async () => {
    setRepoPending(true);
    try {
      const result = await window.electronAPI.codeAssistant.selectRepoPath();
      setRepoContext(result.context);
      if (result.message) {
        setFeedback(result.message);
      }
      const nextStatus = await window.electronAPI.codeAssistant.getStatus();
      setCodeAssistantStatus(nextStatus);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRepoPending(false);
    }
  };

  const handleRestartCodeAssistant = () => {
    void runAction(
      "restarting-code-assistant",
      () => window.electronAPI.codeAssistant.restartRuntime(),
      "正在手动重启代码助手..."
    );
  };

  const handleSelectBranch = async (branch: string) => {
    if (!branch) return;
    setRepoPending(true);
    try {
      const result = await window.electronAPI.codeAssistant.setBranch(branch);
      setRepoContext(result.context);
      if (result.message) {
        setFeedback(result.message);
      }
      const nextStatus = await window.electronAPI.codeAssistant.getStatus();
      setCodeAssistantStatus(nextStatus);
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRepoPending(false);
    }
  };

  const repoBasename = ((): string => {
    const raw = repoContext?.repoPath ?? codeAssistantStatus?.repoPath ?? "";
    if (!raw) return "";
    const segments = raw.split(/[\\/]/u).filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : raw;
  })();
  const repoLabel = !repoContext
    ? "加载中..."
    : repoContext.userSelected && repoBasename
      ? repoBasename
      : "选择工作目录";

  if (shouldKeepLiveShell) {
    return (
      <section className="assistant-route-shell assistant-route-shell-live">
        {feedback && (
          <div
            className={`assistant-live-feedback ${
              /失败|异常|不存在|不是 Git|未提交修改/u.test(feedback) ? "is-warning" : ""
            }`.trim()}
          >
            {feedback}
          </div>
        )}
        {showPermissionBanner && (
          <div className="assistant-live-toolbar">
            <div className="assistant-live-toolbar-copy">
              <span className={`assistant-access-indicator ${codeAssistantStatus?.fullAccessGranted ? "is-full-access" : "is-limited"}`}>
                代码助手 {accessModeLabel}
              </span>
              <p>WS 模式下会保持常驻挂载，并在后台自动维持连接。关闭或完成设置后，7 天内不再提醒。</p>
            </div>
            <div className="assistant-live-toolbar-actions">
              {showManualCodeAssistantRestart && (
                <button
                  type="button"
                  className="primary-link secondary-link assistant-action-button"
                  disabled={pending}
                  onClick={handleRestartCodeAssistant}
                >
                  {actionState === "restarting-code-assistant" ? "重启中..." : "重启代码助手"}
                </button>
              )}
              <button
                type="button"
                className="assistant-live-toolbar-close"
                onClick={acknowledgePermissionBanner}
              >
                关闭
              </button>
              <button
                type="button"
                className="primary-link secondary-link assistant-action-button"
                disabled={pending || !codeAssistantStatus}
                onClick={() => handleSelectAccessMode(alternateAccessMode)}
              >
                {updatingAccess ? "切换中..." : alternateAccessModeLabel}
              </button>
            </div>
          </div>
        )}
        <NativeApp
          serviceBaseUrl={service.healthMeta.webUrl}
          themeMode={hostTheme}
          requestAccessToken={async (reason) => {
            const result = await window.electronAPI.agentAuth.issueAccessToken(reason);
            return result.ok ? result.token : null;
          }}
          codeAssistantRuntime={
            codeAssistantStatus
              ? {
                  agentKey: MANAGED_CODE_ASSISTANT_AGENT_KEY,
                  ready: codeAssistantStatus.ready,
                  recovering: codeAssistantStatus.recovering,
                  onRestartRuntime: async () => {
                    const result = await window.electronAPI.codeAssistant.restartRuntime();
                    setCodeAssistantStatus(result.status);
                    if (result.message) {
                      setFeedback(result.message);
                    }
                    return {
                      ok: result.ok,
                      message: result.message
                    };
                  },
                  message: codeAssistantStatus.recovering
                    ? "代码助手正在后台重连 CLI，请稍候..."
                    : undefined
                }
              : null
          }
          codeAssistantAccess={
            codeAssistantStatus
              ? {
                  agentKey: MANAGED_CODE_ASSISTANT_AGENT_KEY,
                  mode: codeAssistantStatus.fullAccessGranted ? "global" : "folder",
                  pending: updatingAccess,
                  title: codeAssistantStatus.fullAccessGranted
                    ? "当前为全局访问"
                    : repoSelected
                      ? "当前仅允许访问所选目录"
                      : "先选择一个目录，再切到指定文件夹模式",
                  globalLabel: "全局访问",
                  folderLabel: "指定文件夹",
                  onSelectMode: handleSelectAccessMode
                }
              : null
          }
          codeAssistantRepo={
            repoContext
              ? {
                  agentKey: MANAGED_CODE_ASSISTANT_AGENT_KEY,
                  repoPath: repoContext.repoPath,
                  repoLabel,
                  repoExists: repoContext.repoExists,
                  userSelected: repoContext.userSelected,
                  currentBranch: repoContext.currentBranch,
                  branches: repoContext.branches,
                  pending: repoPending,
                  onSelectRepo: handleSelectRepo,
                  onSelectBranch: handleSelectBranch
                }
              : null
          }
        />
      </section>
    );
  }

  return (
    <section className="assistant-route-shell">
      <div className="assistant-empty-shell">
        {loading && <div className="loading-box">正在检查小宅助理服务状态...</div>}
        {pending && <div className="loading-box">正在为小宅助理准备运行环境...</div>}
        {codeAssistantLoading && <div className="loading-box">正在检查代码助手集成状态...</div>}
        {error && <div className="feedback-banner warning-banner">服务状态刷新失败：{error}</div>}
        {codeAssistantStatus?.error && (
          <div className="feedback-banner warning-banner">代码助手状态异常：{codeAssistantStatus.error}</div>
        )}
        {feedback && <div className="feedback-banner">{feedback}</div>}

        <section className="empty-state">
          <p className="eyebrow">Assistant</p>
          <h1>{service.name}</h1>
          <p>{detailMessage}</p>
          <div className="assistant-status-list" aria-label="assistant dependency status">
            {serviceStatuses.map((item) => (
              <div key={item.label} className="assistant-status-pill">
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>

          <div className="assistant-empty-actions">
            {showManualCodeAssistantRestart && (
              <button
                type="button"
                className="primary-link secondary-link assistant-action-button"
                disabled={pending}
                onClick={handleRestartCodeAssistant}
              >
                {actionState === "restarting-code-assistant" ? "重启中..." : "重启代码助手"}
              </button>
            )}
            <button
              type="button"
              className="primary-link assistant-action-button"
              disabled={pending}
              onClick={primaryAction}
            >
              {primaryActionLabel}
            </button>

            <button
              type="button"
              className="primary-link secondary-link assistant-action-button"
              disabled={pending || !codeAssistantStatus}
              onClick={() => handleSelectAccessMode(alternateAccessMode)}
            >
              {updatingAccess ? "切换中..." : alternateAccessModeLabel}
            </button>

            <Link className="primary-link secondary-link" to="/control-center">
              前往控制中心
            </Link>

            {service.installed && (
              <Link className="primary-link secondary-link" to={`/plugin/${service.id}`}>
                打开 iframe 回退页
              </Link>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

function resolveDetailMessage(
  webclientService: ServiceState,
  platformService: ServiceState,
  codeRelayService: ServiceState,
  codeAssistantStatus: CodeAssistantStatus | null,
  pending: boolean
) {
  if (pending) {
    return "Desktop 正在自动安装、刷新并启动小宅助理与代码助手所需服务，请稍候。";
  }
  if (!codeAssistantStatus?.enabled) {
    return "代码助手尚未启用。启用后，ZenMind Desktop 会托管本地代码助手运行时，并让小宅界面里的代码助手直接可用。";
  }
  if (codeAssistantStatus.error) {
    return codeAssistantStatus.error;
  }
  if (codeRelayService.status !== "running") {
    return codeRelayService.message || "代码助手后台服务尚未就绪，Desktop 正在尝试自动拉起它。";
  }
  if (!codeAssistantStatus.cliConnected) {
    return "代码助手当前和 relay 断开了连接。Desktop 不会再自动反复重启，你可以点“重启代码助手”手动恢复。";
  }
  if (platformService.status !== "running") {
    return platformService.message || "智能体平台尚未就绪，Desktop 正在尝试自动拉起它。";
  }
  if (!codeAssistantStatus.fullAccessGranted) {
    if (!codeAssistantStatus.repoSelected) {
      return "代码助手当前准备切到指定文件夹模式，但还没有选定工作目录。选择一个文件夹后，它就只会在该目录里工作。";
    }
    return "代码助手当前只会访问你选定的工作目录。需要时可以随时切回全局访问，无需退出当前会话。";
  }
  return webclientService.message || "小宅助理当前还没有进入可用状态。";
}

function resolveCodeAssistantStatusLabel(
  status: CodeAssistantStatus | null,
  relayService: ServiceState | null
) {
  if (!status) {
    return "检查中";
  }
  if (!status.enabled) {
    return "已停用";
  }
  if (status.ready) {
    if (status.fullAccessGranted) {
      return "运行中（全局）";
    }
    return status.repoSelected ? "运行中（指定文件夹）" : "运行中（待选目录）";
  }
  if (status.running && !status.cliConnected) {
    return "已断连";
  }
  if (status.running || relayService?.status === "running") {
    return "连接中";
  }
  if (relayService?.status === "error") {
    return "异常";
  }
  return relayService?.statusLabel ?? "待启动";
}

function resolveAccessModeLabel(status: CodeAssistantStatus | null, repoSelected: boolean) {
  if (!status) {
    return "检查中";
  }
  if (status.fullAccessGranted) {
    return "全局访问";
  }
  return repoSelected ? "指定文件夹" : "指定文件夹（待选择）";
}
