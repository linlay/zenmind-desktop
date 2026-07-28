import { useEffect, useState } from "react";
import { Button, Input, Select } from "antd";
import type {
  DesktopActionCallRequest,
  DesktopActionDefinition
} from "../../shared/desktop-actions";
import { useI18n } from "../i18n/useI18n";
import "./DesktopActionWorkbenchPage.css";

const DEFAULT_DESKTOP_ACTION_NAME = "desktop.theme.get";
const WORKBENCH_SELECT_CLASS_NAMES = {
  popup: {
    root: "desktop-action-workbench-select-popup"
  }
};

function formatJson(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function createRequestId() {
  return `desktop_action_workbench_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildRequestText(action = DEFAULT_DESKTOP_ACTION_NAME) {
  return formatJson({
    action,
    args: {},
    permissionMode: "full_access"
  });
}

function parseRequest(
  text: string,
  selectedAction: string,
  invalidJsonMessage: string,
  objectMessage: string,
  missingActionMessage: string
): DesktopActionCallRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(invalidJsonMessage);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(objectMessage);
  }

  const input = parsed as Record<string, unknown>;
  const action = typeof input.action === "string" && input.action.trim()
    ? input.action.trim()
    : selectedAction.trim();
  if (!action) {
    throw new Error(missingActionMessage);
  }

  const request: DesktopActionCallRequest = {
    requestId: createRequestId(),
    action,
    args: asRecord(input.args)
  };
  const source = asRecord(input.source);
  if (Object.keys(source).length > 0) {
    request.source = source as DesktopActionCallRequest["source"];
  }
  if (
    input.permissionMode === "default" ||
    input.permissionMode === "page_control" ||
    input.permissionMode === "full_access"
  ) {
    request.permissionMode = input.permissionMode;
  }
  if (typeof input.expectedPageKey === "string" && input.expectedPageKey.trim()) {
    request.expectedPageKey = input.expectedPageKey.trim();
  }
  return request;
}

export function DesktopActionWorkbenchPage() {
  const { t } = useI18n();
  const [actions, setActions] = useState<DesktopActionDefinition[]>([]);
  const [selectedAction, setSelectedAction] = useState(DEFAULT_DESKTOP_ACTION_NAME);
  const [requestText, setRequestText] = useState(buildRequestText());
  const [responseText, setResponseText] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"success" | "error">("success");

  async function handleLoadActions() {
    setMessage("");
    try {
      const result = await window.electronAPI.desktopActions.list();
      const nextActions = Array.isArray(result.actions) ? result.actions : [];
      setActions(nextActions);
      if (!nextActions.some((action) => action.name === selectedAction) && nextActions[0]?.name) {
        setSelectedAction(nextActions[0].name);
        setRequestText(buildRequestText(nextActions[0].name));
      }
    } catch (error) {
      setMessageTone("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleRunAction() {
    setPending(true);
    setMessage("");
    try {
      const request = parseRequest(
        requestText,
        selectedAction,
        t("settings.debug.console.invalidJson"),
        t("settings.debug.console.jsonObjectRequired"),
        t("settings.debug.desktopActions.missingAction")
      );
      const response = await window.electronAPI.desktopActions.call(request);
      setResponseText(formatJson(response));
      setMessageTone(response.ok ? "success" : "error");
      setMessage(
        response.ok
          ? t("settings.debug.desktopActions.completed")
          : response.error?.message || t("common.error")
      );
    } catch (error) {
      setMessageTone("error");
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }

  async function handleCopyResponse() {
    if (responseText) {
      await window.electronAPI.clipboard.writeText(responseText);
    }
  }

  useEffect(() => {
    document.title = t("settings.debug.desktopActions.workbenchTitle");
  }, [t]);

  useEffect(() => {
    void handleLoadActions();
  }, []);

  return (
    <main className="desktop-action-workbench-page">
      <section
        className="desktop-action-workbench-panel"
        aria-labelledby="desktop-action-workbench-title"
      >
        <header className="desktop-action-workbench-head">
          <div className="desktop-action-workbench-copy">
            <h1 id="desktop-action-workbench-title">
              {t("settings.debug.desktopActions.workbenchTitle")}
            </h1>
            <p>{t("settings.debug.desktopActions.description")}</p>
          </div>
          <div className="desktop-action-workbench-actions">
            <Select
              className="desktop-action-workbench-select"
              classNames={WORKBENCH_SELECT_CLASS_NAMES}
              showSearch
              value={selectedAction}
              optionFilterProp="label"
              options={actions.map((action) => ({
                value: action.name,
                label: `${action.name} · ${action.kind}`
              }))}
              onChange={(value) => {
                setSelectedAction(value);
                setRequestText(buildRequestText(value));
              }}
            />
            <Button onClick={() => void handleLoadActions()}>
              {t("common.refresh")}
            </Button>
            <Button
              type="primary"
              disabled={pending}
              loading={pending}
              onClick={() => void handleRunAction()}
            >
              {t("settings.debug.desktopActions.run")}
            </Button>
            <Button disabled={!responseText} onClick={() => void handleCopyResponse()}>
              {t("settings.debug.desktopActions.copyResponse")}
            </Button>
          </div>
        </header>

        {message ? (
          <div
            className={`feedback-banner desktop-action-workbench-message${
              messageTone === "error" ? " warning-banner" : ""
            }`}
            role="status"
          >
            {message}
          </div>
        ) : null}

        <div className="desktop-action-workbench-grid">
          <label className="desktop-action-workbench-field">
            <span>{t("settings.debug.desktopActions.request")}</span>
            <Input.TextArea
              value={requestText}
              spellCheck={false}
              onChange={(event) => setRequestText(event.target.value)}
            />
          </label>
          <label className="desktop-action-workbench-field">
            <span>{t("settings.debug.desktopActions.response")}</span>
            <Input.TextArea
              value={responseText}
              readOnly
              spellCheck={false}
            />
          </label>
        </div>
      </section>
    </main>
  );
}
