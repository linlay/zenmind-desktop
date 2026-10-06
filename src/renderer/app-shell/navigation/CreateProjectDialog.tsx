import { RobotOutlined, CodeOutlined, DatabaseOutlined, ApiOutlined } from "@ant-design/icons";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type {
  AssistantCreateProjectResult,
  AssistantProjectCreationGroup,
  AssistantProjectCreationOptions,
} from "../../../shared/contracts";
import {
  buildProjectCreationRequest,
  changeProjectCreationType,
  findProjectCreationType,
  initialProjectCreationSelection,
  projectCreationProblem,
  resolveProjectCreationModel,
  type ProjectCreationProblem,
  type ProjectCreationSelection,
  toggleProjectCreationGroup,
} from "../../../shared/project-creation";
import type { TranslateFunction, TranslationKey } from "../../../shared/i18n";

type Translate = TranslateFunction;

// Desktop owns the type catalog; Platform supplies runtime presets and availability.
const PROJECT_TYPES = [
  { key: "general", label: "sidebar.project.type.general", Icon: RobotOutlined },
  { key: "coder", label: "sidebar.project.type.coder", Icon: CodeOutlined },
  { key: "kbase", label: "sidebar.project.type.kbase", Icon: DatabaseOutlined },
  { key: "acp", label: "sidebar.project.type.acp", Icon: ApiOutlined },
] as const;

type CreateProjectDialogProps = {
  workspaceDir: string;
  t: Translate;
  onClose: () => void;
  onCreated: (result: AssistantCreateProjectResult) => void | Promise<void>;
};

const PROBLEM_MESSAGES: Record<ProjectCreationProblem, TranslationKey> = {
  typeUnavailable: "sidebar.project.typeUnavailable",
  directoryRequired: "sidebar.project.directoryRequired",
  modelRequired: "sidebar.project.modelRequired",
  acpBridgeRequired: "sidebar.project.acpRequired",
};

function groupMembers(group: AssistantProjectCreationGroup, t: Translate) {
  const parts: string[] = [];
  if (group.skills.length > 0) {
    parts.push(`${t("sidebar.project.members.skills")}: ${group.skills.map((item) => item.name || item.key).join(", ")}`);
  }
  if (group.connectors.length > 0) {
    parts.push(`${t("sidebar.project.members.connectors")}: ${group.connectors.map((item) => item.name || item.key).join(", ")}`);
  }
  if (group.tools.length > 0) {
    parts.push(`${t("sidebar.project.members.tools")}: ${group.tools.join(", ")}`);
  }
  return parts.join("\n");
}

/**
 * New Project dialog: type cards, the capability groups of the chosen type,
 * model and project directory on one screen. Platform owns runtime capabilities.
 */
export function CreateProjectDialog({ workspaceDir: initialWorkspaceDir, t, onClose, onCreated }: CreateProjectDialogProps) {
  const [workspaceDir, setWorkspaceDir] = useState(initialWorkspaceDir);
  const [options, setOptions] = useState<AssistantProjectCreationOptions | null>(null);
  const [selection, setSelection] = useState<ProjectCreationSelection | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [bridgeStatus, setBridgeStatus] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    // Desktop runs each ACP bridge as a local service named "<id>-acp-bridge";
    // its status is shown next to the engines that Agent Platform offers.
    void window.electronAPI.services.list().then(
      (services) => {
        if (cancelled) {
          return;
        }
        const next: Record<string, string> = {};
        for (const service of services) {
          if (service.id.endsWith("-acp-bridge")) {
            next[service.id.slice(0, -"-acp-bridge".length)] = service.statusLabel || service.status;
          }
        }
        setBridgeStatus(next);
      },
      (reason) => console.warn("[assistant] failed to list ACP bridge services", reason),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadError("");
    void window.electronAPI.assistant.getProjectCreationOptions().then(
      (result) => {
        if (cancelled) {
          return;
        }
        if (!result.ok || !result.options) {
          setLoadError(result.message || t("sidebar.project.optionsFailed"));
          return;
        }
        const runtimeOptions = result.options;
        const next = {
          ...runtimeOptions,
          types: PROJECT_TYPES.flatMap(({ key }) => {
            const type = runtimeOptions.types.find((item) => item.key === key);
            return type ? [type] : [];
          }),
        };
        setOptions(next);
        setSelection(initialProjectCreationSelection(next));
      },
      (reason) => {
        if (!cancelled) {
          setLoadError(reason instanceof Error ? reason.message : String(reason));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, t]);

  const type = options && selection ? findProjectCreationType(options, selection.typeKey) : undefined;
  const effectiveModelKey = options && selection ? resolveProjectCreationModel(options, selection) : "";
  const problem = options && selection ? projectCreationProblem(options, selection, workspaceDir) : null;
  const defaultModelMissing = Boolean(type?.modelRequired && !type.defaultModelAvailable);
  const modelChoices = useMemo(() => options?.models ?? [], [options]);
  // Keep manual checkbox edits stationary; reorder only for the type preset.
  const capabilityGroups = useMemo(() => {
    const defaults = new Set(type?.defaultGroups ?? []);
    return [...(options?.groups ?? [])].sort((left, right) =>
      Number(right.available && defaults.has(right.key)) - Number(left.available && defaults.has(left.key)),
    );
  }, [options, type]);

  function update(next: ProjectCreationSelection) {
    setSelection(next);
    setError("");
  }

  async function handleChangeDirectory() {
    const picked = await window.electronAPI.desktopDialog.selectDirectory();
    if (picked.ok && picked.path) {
      setWorkspaceDir(picked.path);
      setError("");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!options || !selection || pending) {
      return;
    }
    if (problem) {
      setError(t(PROBLEM_MESSAGES[problem]));
      return;
    }
    setPending(true);
    setError("");
    try {
      const result = await window.electronAPI.assistant.createProject(
        buildProjectCreationRequest(options, selection, workspaceDir),
      );
      if (!result.ok) {
        setError(result.message || t("sidebar.project.createFailed"));
        setPending(false);
        return;
      }
      await onCreated(result);
    } catch (reason) {
      console.warn("[assistant] failed to create project", reason);
      setError(reason instanceof Error ? reason.message : String(reason));
      setPending(false);
    }
  }

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="sidebar-website-dialog-layer"
      role="presentation"
      onMouseDown={() => {
        if (!pending) {
          onClose();
        }
      }}
    >
      <form
        className="sidebar-website-dialog sidebar-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sidebar-create-project-dialog-title"
        onSubmit={(event) => void handleSubmit(event)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sidebar-website-dialog-head">
          <strong id="sidebar-create-project-dialog-title">{t("sidebar.project.createTitle")}</strong>
          <button
            type="button"
            className="sidebar-website-dialog-close"
            aria-label={t("common.close")}
            disabled={pending}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {!options || !selection ? (
          <div className="sidebar-project-dialog-status" role={loadError ? "alert" : "status"}>
            <span>{loadError || t("sidebar.project.optionsLoading")}</span>
            {loadError ? (
              <button
                type="button"
                className="sidebar-website-secondary-button"
                onClick={() => setLoadAttempt((value) => value + 1)}
              >
                {t("sidebar.project.optionsRetry")}
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <div className="sidebar-website-dialog-field">
              <span>{t("sidebar.project.type")}</span>
              <div className="sidebar-project-type-grid" role="radiogroup" aria-label={t("sidebar.project.type")}>
                {PROJECT_TYPES.map(({ key, label, Icon }) => {
                  const item = options.types.find((type) => type.key === key);
                  return (
                    <label key={key} title={item?.available ? undefined : t("sidebar.project.typeUnavailable")}>
                      <input
                        type="radio"
                        name="create-project-type"
                        value={key}
                        checked={selection.typeKey === key}
                        disabled={pending || !item?.available}
                        onChange={() =>
                          update(changeProjectCreationType(options, selection, key))
                        }
                      />
                      <Icon aria-hidden="true" className="sidebar-project-type-icon" />
                      <span>{t(label)}</span>
                      {!item?.available ? (
                        <small>{t(key === "acp" ? "sidebar.project.noRunningAcp" : "sidebar.project.typeUnavailable")}</small>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="sidebar-website-dialog-field">
              <span>{t("sidebar.project.directory")}</span>
              <div className="sidebar-project-directory-row">
                <input
                  className="sidebar-website-dialog-readonly-input"
                  aria-label={t("sidebar.project.directory")}
                  placeholder={t("sidebar.project.directoryRequired")}
                  value={workspaceDir}
                  readOnly
                  aria-readonly="true"
                />
                <button
                  type="button"
                  className="sidebar-website-secondary-button"
                  disabled={pending}
                  onClick={() => void handleChangeDirectory()}
                >
                  {t(workspaceDir ? "sidebar.project.changeDirectory" : "sidebar.project.selectDirectory")}
                </button>
              </div>
            </div>

            {type?.supportsGroups ? (
              <div className="sidebar-website-dialog-field">
                <span>{t("sidebar.project.capabilities")}</span>
                {options.groups.length === 0 ? (
                  <p className="sidebar-project-dialog-hint">{t("sidebar.project.capabilitiesEmpty")}</p>
                ) : (
                  <div className="sidebar-project-group-list" key={selection.typeKey}>
                    {capabilityGroups.map((group) => (
                      <label
                        key={group.key}
                        className="sidebar-project-group"
                        title={group.available
                          ? [group.name, group.description, groupMembers(group, t)].filter(Boolean).join("\n")
                          : group.unavailableReason}
                      >
                        <input
                          type="checkbox"
                          checked={selection.groups.includes(group.key)}
                          disabled={pending || !group.available}
                          onChange={() => update(toggleProjectCreationGroup(options, selection, group.key))}
                        />
                        <span className="sidebar-project-group-text">
                          <strong>{group.name}</strong>
                          <small>
                            {group.available
                              ? group.description || groupMembers(group, t)
                              : t("sidebar.project.groupUnavailable", { reason: group.unavailableReason ?? "" })}
                          </small>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ) : type?.groupsUnsupportedReason ? (
              <p className="sidebar-project-dialog-hint">{type.groupsUnsupportedReason}</p>
            ) : null}

            {type?.key === "acp" ? (
              <label className="sidebar-website-dialog-field">
                <span>{t("sidebar.project.acpEngine")}</span>
                <select
                  value={selection.acpBridgeId}
                  disabled={pending || (type.acpBridges ?? []).length === 0}
                  onChange={(event) => update({ ...selection, acpBridgeId: event.target.value })}
                >
                  {(type.acpBridges ?? []).length === 0 ? (
                    <option value="">{t("sidebar.project.noRunningAcp")}</option>
                  ) : null}
                  {(type.acpBridges ?? []).map((bridge) => (
                    <option value={bridge.id} key={bridge.id}>
                      {bridgeStatus[bridge.id]
                        ? t("sidebar.project.acpEngineRunning", { name: bridge.id, status: bridgeStatus[bridge.id] })
                        : bridge.id}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {type?.modelRequired ? (
              <label className="sidebar-website-dialog-field">
                <span>{t("sidebar.project.model")}</span>
                <select
                  value={effectiveModelKey}
                  disabled={pending}
                  aria-invalid={!effectiveModelKey}
                  onChange={(event) => update({ ...selection, modelKey: event.target.value })}
                >
                  {!effectiveModelKey ? (
                    <option value="">{t("sidebar.project.modelPlaceholder")}</option>
                  ) : null}
                  {modelChoices.map((model) => (
                    <option value={model.key} key={model.key}>
                      {model.name || model.key}
                    </option>
                  ))}
                </select>
                {defaultModelMissing && !selection.modelKey ? (
                  <small className="sidebar-project-dialog-hint">{t("sidebar.project.modelDefaultMissing")}</small>
                ) : null}
              </label>
            ) : null}
          </>
        )}

        {error ? (
          <div className="sidebar-website-dialog-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="sidebar-website-dialog-actions">
          <button type="button" className="sidebar-website-secondary-button" disabled={pending} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            className="sidebar-website-primary-button"
            disabled={pending || !options || !selection || Boolean(problem)}
            title={problem ? t(PROBLEM_MESSAGES[problem]) : undefined}
          >
            {pending ? t("sidebar.project.creating") : t("sidebar.project.create")}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
