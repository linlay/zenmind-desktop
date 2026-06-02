import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DeleteOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
  SearchOutlined
} from "@ant-design/icons";
import { Button, Checkbox, Empty, Input, Select, Spin, Switch, Tag, Tooltip } from "antd";
import type { TranslateFunction } from "../../../shared/i18n";
import { useI18n } from "../../i18n/useI18n";
import {
  createAutomation,
  deleteAutomation,
  getAgents,
  getAutomation,
  getAutomationExecutions,
  getAutomations,
  getTeams,
  toggleAutomation,
  updateAutomation
} from "./api";
import type {
  Agent,
  AutomationDetailResponse,
  AutomationExecutionResponse,
  AutomationQueryRequest,
  AutomationSummaryResponse,
  CreateAutomationRequest,
  Team,
  UpdateAutomationRequest
} from "./types";
import { asRecord, compactPayload, toText } from "./utils";

type AutomationStatusFilter = "all" | "enabled" | "disabled";
type AutomationFormMode = "create" | "edit";

interface AutomationFormState {
  id: string;
  name: string;
  description: string;
  cron: string;
  agentKey: string;
  teamId: string;
  zoneId: string;
  remainingRuns: string;
  enabled: boolean;
  message: string;
  chatId: string;
  role: string;
  hidden: "" | "true" | "false";
  paramsText: string;
}

const EMPTY_FORM: AutomationFormState = {
  id: "",
  name: "",
  description: "",
  cron: "0 9 * * *",
  agentKey: "",
  teamId: "",
  zoneId: "",
  remainingRuns: "",
  enabled: true,
  message: "",
  chatId: "",
  role: "user",
  hidden: "",
  paramsText: ""
};

const CRON_PRESETS = [
  { labelKey: "automationConsole.cronPreset.dailyNine", value: "0 9 * * *" },
  { labelKey: "automationConsole.cronPreset.weekdaySix", value: "0 18 * * 1-5" },
  { labelKey: "automationConsole.cronPreset.everyFiveMinutes", value: "*/5 * * * *" },
  { labelKey: "automationConsole.cronPreset.hourly", value: "0 * * * *" }
] as const;

const COMMON_ZONE_OPTIONS = [
  "Asia/Shanghai",
  "UTC",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Bangkok",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Australia/Sydney"
];

function firstString(values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    const record = asRecord(value);
    const nested = Object.keys(record).length > 0 ? firstString([record.key, record.agentKey]) : "";
    if (nested) {
      return nested;
    }
  }
  return "";
}

function createInitialForm(agents: Agent[]): AutomationFormState {
  return {
    ...EMPTY_FORM,
    agentKey: firstString(agents.map((agent) => agent.key))
  };
}

function formFromAutomation(automation: AutomationDetailResponse): AutomationFormState {
  const params = automation.query?.params;
  return {
    id: automation.id,
    name: automation.name || "",
    description: automation.description || "",
    cron: automation.cron || "",
    agentKey: automation.agentKey || "",
    teamId: automation.teamId || "",
    zoneId: automation.zoneId || "",
    remainingRuns:
      automation.remainingRuns === undefined || automation.remainingRuns === null
        ? ""
        : String(automation.remainingRuns),
    enabled: Boolean(automation.enabled),
    message: automation.query?.message || "",
    chatId: automation.query?.chatId || "",
    role: automation.query?.role || "user",
    hidden:
      automation.query?.hidden === true
        ? "true"
        : automation.query?.hidden === false
          ? "false"
          : "",
    paramsText:
      params && Object.keys(params).length > 0
        ? JSON.stringify(params, null, 2)
        : ""
  };
}

function isFiveFieldCron(value: string): boolean {
  return value.trim().split(/\s+/).length === 5;
}

function toTimeLabel(value?: string | number | null, locale?: string): string {
  if (value === undefined || value === null || value === "") {
    return "--";
  }
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString(locale);
}

function toDurationLabel(value?: number | null): string {
  if (value === undefined || value === null) {
    return "--";
  }
  if (value < 1000) {
    return `${value}ms`;
  }
  return `${(value / 1000).toFixed(1)}s`;
}

export function automationSourcePath(automation: AutomationSummaryResponse): string {
  const source = String(automation.sourceFile || "").trim();
  if (!source) {
    return automation.id;
  }
  const normalized = source.replace(/\\/g, "/");
  const filename = normalized.split("/").filter(Boolean).pop();
  return filename || automation.id;
}

function automationListMeta(automation: AutomationSummaryResponse, t: TranslateFunction, locale: string): string {
  const lastStatus = automation.lastExecution?.status || "--";
  return [
    automation.cron || "--",
    t("automationConsole.list.nextFire", { time: toTimeLabel(automation.nextFireTime, locale) }),
    t("automationConsole.list.lastStatus", { status: lastStatus })
  ].join(" · ");
}

function buildQuery(form: AutomationFormState): AutomationQueryRequest {
  const query: AutomationQueryRequest = {
    message: form.message.trim(),
    role: form.role.trim() || "user"
  };
  const chatId = form.chatId.trim();
  if (chatId) {
    query.chatId = chatId;
  }
  if (form.hidden === "true") {
    query.hidden = true;
  }
  if (form.hidden === "false") {
    query.hidden = false;
  }
  const paramsText = form.paramsText.trim();
  if (paramsText) {
    query.params = JSON.parse(paramsText) as Record<string, unknown>;
  }
  return query;
}

function buildCreatePayload(form: AutomationFormState): CreateAutomationRequest {
  return compactPayload({
    name: form.name.trim(),
    description: form.description.trim(),
    cron: form.cron.trim(),
    agentKey: form.agentKey.trim(),
    teamId: form.teamId.trim(),
    zoneId: form.zoneId.trim(),
    enabled: form.enabled,
    remainingRuns: form.remainingRuns.trim() ? Number(form.remainingRuns.trim()) : undefined,
    query: buildQuery(form)
  }) as CreateAutomationRequest;
}

function buildUpdatePayload(form: AutomationFormState): UpdateAutomationRequest {
  return compactPayload({
    id: form.id,
    name: form.name.trim(),
    description: form.description.trim(),
    cron: form.cron.trim(),
    agentKey: form.agentKey.trim(),
    teamId: form.teamId.trim(),
    zoneId: form.zoneId.trim(),
    enabled: form.enabled,
    remainingRuns: form.remainingRuns.trim() ? Number(form.remainingRuns.trim()) : undefined,
    query: buildQuery(form)
  }) as UpdateAutomationRequest;
}

function validateForm(form: AutomationFormState, t: TranslateFunction): string {
  if (!form.name.trim()) return t("automationConsole.error.nameRequired");
  if (!form.description.trim()) return t("automationConsole.error.descriptionRequired");
  if (!form.cron.trim()) return t("automationConsole.error.cronRequired");
  if (!isFiveFieldCron(form.cron)) return t("automationConsole.error.cronFormat");
  if (!form.agentKey.trim()) return t("automationConsole.error.agentRequired");
  if (!form.message.trim()) return t("automationConsole.error.messageRequired");
  if (form.remainingRuns.trim()) {
    const runs = Number(form.remainingRuns.trim());
    if (!Number.isInteger(runs) || runs <= 0) {
      return t("automationConsole.error.remainingRunsPositive");
    }
  }
  if (form.paramsText.trim()) {
    try {
      const parsed = JSON.parse(form.paramsText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return t("automationConsole.error.paramsObject");
      }
    } catch (error) {
      return t("automationConsole.error.paramsJsonInvalid", {
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return "";
}

export function AutomationsPage() {
  const { locale, t } = useI18n();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [automations, setAutomations] = useState<AutomationSummaryResponse[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [executions, setExecutions] = useState<AutomationExecutionResponse[]>([]);
  const [searchText, setSearchText] = useState("");
  const [statusFilter, setStatusFilter] = useState<AutomationStatusFilter>("all");
  const [workerFilter, setWorkerFilter] = useState("");
  const [formMode, setFormMode] = useState<AutomationFormMode>("create");
  const [form, setForm] = useState<AutomationFormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [executionsLoading, setExecutionsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState("");
  const didBootstrapRef = useRef(false);
  const didAutoSelectInitialAutomationRef = useRef(false);

  const workerOptions = useMemo(() => {
    const values = new Map<string, string>();
    for (const item of automations) {
      if (item.agentKey) {
        values.set(`agent:${item.agentKey}`, t("automationConsole.worker.agent", { id: item.agentKey }));
      }
      if (item.teamId) {
        values.set(`team:${item.teamId}`, t("automationConsole.worker.team", { id: item.teamId }));
      }
    }
    return Array.from(values.entries()).map(([value, label]) => ({ value, label }));
  }, [automations, t]);

  const cronPresetOptions = useMemo(
    () => CRON_PRESETS.map((preset) => ({ value: preset.value, label: t(preset.labelKey) })),
    [t]
  );

  const agentOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const agent of agents) {
      const key = toText(agent.key);
      if (!key) {
        continue;
      }
      const name = toText(agent.name) || key;
      const role = toText(agent.role);
      options.set(key, role ? `${name} · ${role}` : name);
    }
    const currentAgentKey = form.agentKey.trim();
    if (currentAgentKey && !options.has(currentAgentKey)) {
      options.set(currentAgentKey, currentAgentKey);
    }
    return Array.from(options.entries()).map(([value, label]) => ({ value, label }));
  }, [agents, form.agentKey]);

  const zoneOptions = useMemo(() => {
    const values = new Set(COMMON_ZONE_OPTIONS);
    const currentZone = form.zoneId.trim();
    if (currentZone) {
      values.add(currentZone);
    }
    return Array.from(values).sort((left, right) => {
      if (left === "Asia/Shanghai") return -1;
      if (right === "Asia/Shanghai") return 1;
      if (left === "UTC") return -1;
      if (right === "UTC") return 1;
      return left.localeCompare(right, locale);
    });
  }, [form.zoneId, locale]);

  const workerNameByKey = useMemo(() => {
    const values = new Map<string, string>();
    for (const agent of agents) {
      const key = toText(agent.key);
      if (!key) continue;
      values.set(`agent:${key}`, toText(agent.name) || key);
    }
    for (const team of teams) {
      const teamId = toText(team.teamId) || toText(team.id);
      if (!teamId) continue;
      values.set(`team:${teamId}`, toText(team.name) || teamId);
    }
    return values;
  }, [agents, teams]);

  const getAutomationWorkerName = useCallback(
    (automation: AutomationSummaryResponse): string => {
      const teamId = toText(automation.teamId);
      if (teamId) return workerNameByKey.get(`team:${teamId}`) || teamId;
      const agentKey = toText(automation.agentKey);
      if (agentKey) return workerNameByKey.get(`agent:${agentKey}`) || agentKey;
      return "--";
    },
    [workerNameByKey]
  );

  const filteredAutomations = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return automations.filter((item) => {
      if (statusFilter === "enabled" && !item.enabled) return false;
      if (statusFilter === "disabled" && item.enabled) return false;
      if (workerFilter.startsWith("agent:") && item.agentKey !== workerFilter.slice(6)) return false;
      if (workerFilter.startsWith("team:") && item.teamId !== workerFilter.slice(5)) return false;
      if (!query) return true;
      return [
        item.name,
        item.description,
        item.cron,
        item.agentKey,
        item.teamId,
        item.lastExecution?.status
      ].filter(Boolean).join(" ").toLowerCase().includes(query);
    });
  }, [automations, searchText, statusFilter, workerFilter]);

  const selectedSummary = useMemo(
    () => automations.find((item) => item.id === selectedId) || null,
    [automations, selectedId]
  );

  const loadExecutions = useCallback(async (id: string) => {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      setExecutions([]);
      return;
    }
    setExecutionsLoading(true);
    try {
      const response = await getAutomationExecutions({ id: normalizedId, limit: 20 });
      setExecutions(response.items || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
      setExecutions([]);
    } finally {
      setExecutionsLoading(false);
    }
  }, []);

  const startCreate = useCallback(() => {
    setSelectedId("");
    setFormMode("create");
    setForm(createInitialForm(agents));
    setExecutions([]);
    setFormError("");
    setPendingDeleteId("");
  }, [agents]);

  const selectAutomation = useCallback(
    async (id: string) => {
      const normalizedId = String(id || "").trim();
      if (!normalizedId) {
        startCreate();
        return;
      }
      setSelectedId(normalizedId);
      setFormMode("edit");
      setFormError("");
      setPendingDeleteId("");
      try {
        const detail = await getAutomation(normalizedId);
        setForm(formFromAutomation(detail));
        await loadExecutions(normalizedId);
      } catch (selectError) {
        setError(selectError instanceof Error ? selectError.message : String(selectError));
      }
    },
    [loadExecutions, startCreate]
  );

  const loadAutomations = useCallback(
    async (preferredId = "") => {
      setLoading(true);
      setError("");
      try {
        const response = await getAutomations();
        const items = response.items || [];
        setAutomations(items);
        const nextId = preferredId && items.some((item) => item.id === preferredId)
          ? preferredId
          : items[0]?.id || "";
        if (nextId) {
          await selectAutomation(nextId);
        } else {
          startCreate();
        }
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        setLoading(false);
      }
    },
    [selectAutomation, startCreate]
  );

  useEffect(() => {
    if (didBootstrapRef.current) {
      return;
    }
    didBootstrapRef.current = true;
    setLoading(true);
    Promise.all([
      getAgents({ scope: "all" }).catch(() => []),
      getTeams().catch(() => []),
      getAutomations().catch((loadError) => {
        throw loadError;
      })
    ])
      .then(([agentItems, teamItems, automationResponse]) => {
        const nextAgents = Array.isArray(agentItems) ? agentItems : [];
        setAgents(nextAgents);
        setTeams(Array.isArray(teamItems) ? teamItems : []);
        setAutomations(automationResponse.items || []);
        setForm(createInitialForm(nextAgents));
      })
      .catch((bootstrapError) => {
        setError(bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (
      didAutoSelectInitialAutomationRef.current ||
      selectedId ||
      formMode !== "create" ||
      automations.length === 0
    ) {
      return;
    }
    didAutoSelectInitialAutomationRef.current = true;
    void selectAutomation(automations[0].id);
  }, [automations, formMode, selectAutomation, selectedId]);

  const updateForm = (patch: Partial<AutomationFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    setFormError("");
  };

  const saveForm = async () => {
    const validation = validateForm(form, t);
    if (validation) {
      setFormError(validation);
      return;
    }
    setSaving(true);
    setError("");
    setFormError("");
    try {
      const detail = formMode === "create"
        ? await createAutomation(buildCreatePayload(form))
        : await updateAutomation(buildUpdatePayload(form));
      await loadAutomations(detail.id);
    } catch (saveError) {
      setFormError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const toggleSelected = async (item: AutomationSummaryResponse, enabled: boolean) => {
    setSaving(true);
    setError("");
    try {
      const detail = await toggleAutomation({ id: item.id, enabled });
      setAutomations((current) => current.map((row) => row.id === detail.id ? { ...row, ...detail } : row));
      if (selectedId === detail.id) {
        setForm(formFromAutomation(detail));
      }
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async (item: AutomationSummaryResponse) => {
    if (pendingDeleteId !== item.id) {
      setPendingDeleteId(item.id);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await deleteAutomation({ id: item.id });
      const remaining = automations.filter((row) => row.id !== item.id);
      setAutomations(remaining);
      setPendingDeleteId("");
      if (selectedId === item.id) {
        const nextId = remaining[0]?.id || "";
        if (nextId) {
          await selectAutomation(nextId);
        } else {
          startCreate();
        }
      }
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="automations-page agent-webclient-native-page">
      <div className="command-modal-section automation-console">
        <div className="automation-console-toolbar">
          <Input
            prefix={<SearchOutlined />}
            variant="filled"
            placeholder={t("automationConsole.searchPlaceholder")}
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
          />
          <Select
            value={statusFilter}
            onChange={(value) => setStatusFilter(value)}
            options={[
              { value: "all", label: t("automationConsole.filter.status.all") },
              { value: "enabled", label: t("automationConsole.filter.status.enabled") },
              { value: "disabled", label: t("automationConsole.filter.status.disabled") }
            ]}
          />
          <Select
            value={workerFilter}
            onChange={(value) => setWorkerFilter(value)}
            options={[{ value: "", label: t("automationConsole.filter.worker.all") }, ...workerOptions]}
          />
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => void loadAutomations(selectedId)}
            disabled={loading || saving}
            aria-label={t("automationConsole.action.refresh")}
          />
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={startCreate}>
            {t("automationConsole.action.new")}
          </Button>
        </div>

        {error && (
          <div className="automation-console-error">
            <span>{error}</span>
            <Button size="small" onClick={() => void loadAutomations(selectedId)}>{t("automationConsole.action.retry")}</Button>
          </div>
        )}

        <div className="automation-console-body">
          <div className="automation-console-list">
            <div className="automation-console-count">
              {t("automationConsole.list.count", { count: automations.length })}
            </div>
            <Spin spinning={loading}>
              {filteredAutomations.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("automationConsole.empty")}>
                  <Button size="small" type="primary" onClick={startCreate}>{t("automationConsole.action.create")}</Button>
                </Empty>
              ) : (
                <div className="automation-list-items">
                  {filteredAutomations.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className={`automation-list-item ${item.id === selectedId ? "is-active" : ""}`}
                      onClick={() => void selectAutomation(item.id)}
                    >
                      <span className="automation-list-item-head">
                        <span className="automation-list-item-title" title={`${getAutomationWorkerName(item)} ${item.name || item.id}`}>
                          <span className="automation-list-item-owner">[{getAutomationWorkerName(item)}]</span>
                          <strong>{item.name || item.id}</strong>
                        </span>
                        <Tag color={item.enabled ? "blue" : "default"} bordered={false}>
                          {item.enabled ? t("automationConsole.status.enabled") : t("automationConsole.status.disabled")}
                        </Tag>
                      </span>
                      <span className="automation-list-item-meta" title={automationListMeta(item, t, locale)}>
                        {automationListMeta(item, t, locale)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </Spin>
          </div>

          <div className="automation-console-detail">
            <div className="automation-detail-head">
              <div>
                <strong>
                  {formMode === "create"
                    ? t("automationConsole.detail.titleCreate")
                    : selectedSummary?.name || t("automationConsole.detail.titleEdit")}
                </strong>
                <span>
                  {formMode === "create"
                    ? t("automationConsole.detail.createSubtitle")
                    : selectedSummary
                      ? automationSourcePath(selectedSummary)
                      : selectedId}
                </span>
              </div>
              {selectedSummary && (
                <div className="automation-detail-actions">
                  <Switch
                    size="small"
                    checked={selectedSummary.enabled}
                    checkedChildren={t("automationConsole.status.enabled")}
                    unCheckedChildren={t("automationConsole.status.disabled")}
                    disabled={saving}
                    onChange={(enabled) => void toggleSelected(selectedSummary, enabled)}
                  />
                  <Button size="small" danger icon={<DeleteOutlined />} onClick={() => void confirmDelete(selectedSummary)} disabled={saving}>
                    {pendingDeleteId === selectedSummary.id
                      ? t("automationConsole.action.confirmDelete")
                      : t("automationConsole.action.delete")}
                  </Button>
                </div>
              )}
            </div>

            <div className="automation-form-grid">
              <div className="field-group">
                <label htmlFor="automation-name-input">{t("automationConsole.field.name")}</label>
                <Input id="automation-name-input" value={form.name} onChange={(event) => updateForm({ name: event.target.value })} />
              </div>
              <div className="field-group">
                <label htmlFor="automation-cron-input">Cron</label>
                <div className="automation-cron-control">
                  <Input id="automation-cron-input" value={form.cron} onChange={(event) => updateForm({ cron: event.target.value })} />
                  <Select
                    aria-label={t("automationConsole.cronPreset.ariaLabel")}
                    value={CRON_PRESETS.some((preset) => preset.value === form.cron) ? form.cron : ""}
                    onChange={(value) => {
                      if (value) updateForm({ cron: value });
                    }}
                    options={[{ value: "", label: t("automationConsole.cronPreset.placeholder") }, ...cronPresetOptions]}
                  />
                </div>
              </div>
              <div className="field-group">
                <label htmlFor="automation-agent-input">{t("automationConsole.field.agent")}</label>
                <Select
                  id="automation-agent-input"
                  value={form.agentKey}
                  showSearch
                  optionFilterProp="label"
                  onChange={(value) => updateForm({ agentKey: value })}
                  options={[{ value: "", label: t("automationConsole.field.agentPlaceholder") }, ...agentOptions]}
                />
              </div>
              <div className="field-group">
                <label htmlFor="automation-team-input">TeamID</label>
                <Input id="automation-team-input" value={form.teamId} onChange={(event) => updateForm({ teamId: event.target.value })} />
              </div>
              <div className="field-group">
                <label htmlFor="automation-zone-input">{t("automationConsole.field.timezone")}</label>
                <Select
                  id="automation-zone-input"
                  value={form.zoneId}
                  showSearch
                  optionFilterProp="label"
                  onChange={(value) => updateForm({ zoneId: value })}
                  options={[
                    { value: "", label: t("automationConsole.field.defaultTimezone") },
                    ...zoneOptions.map((zoneId) => ({ value: zoneId, label: zoneId }))
                  ]}
                />
              </div>
              <div className="field-group">
                <label htmlFor="automation-runs-input">{t("automationConsole.field.remainingRuns")}</label>
                <Input
                  id="automation-runs-input"
                  type="number"
                  min="1"
                  placeholder={t("automationConsole.field.remainingRunsPlaceholder")}
                  value={form.remainingRuns}
                  onChange={(event) => updateForm({ remainingRuns: event.target.value })}
                />
              </div>
            </div>

            <div className="field-group">
              <label htmlFor="automation-description-input">{t("automationConsole.field.description")}</label>
              <Input.TextArea id="automation-description-input" className="settings-textarea" rows={2} value={form.description} onChange={(event) => updateForm({ description: event.target.value })} />
            </div>

            <fieldset className="automation-request-box">
              <legend>{t("automationConsole.section.request")}</legend>
              <div className="field-group">
                <label htmlFor="automation-message-input">{t("automationConsole.field.message")}</label>
                <Input.TextArea id="automation-message-input" className="settings-textarea" rows={4} value={form.message} onChange={(event) => updateForm({ message: event.target.value })} />
              </div>

              <div className="automation-form-grid">
                <div className="field-group">
                  <label htmlFor="automation-chat-input">{t("automationConsole.field.chatId")}</label>
                  <Input id="automation-chat-input" value={form.chatId} onChange={(event) => updateForm({ chatId: event.target.value })} />
                </div>
                <div className="field-group">
                  <label htmlFor="automation-role-input">{t("automationConsole.field.role")}</label>
                  <Input id="automation-role-input" value={form.role} onChange={(event) => updateForm({ role: event.target.value })} />
                </div>
                <div className="field-group">
                  <label htmlFor="automation-hidden-select">{t("automationConsole.field.hidden")}</label>
                  <Select
                    id="automation-hidden-select"
                    value={form.hidden}
                    onChange={(value) => updateForm({ hidden: value })}
                    options={[
                      { value: "", label: t("automationConsole.hidden.unset") },
                      { value: "true", label: t("automationConsole.hidden.true") },
                      { value: "false", label: t("automationConsole.hidden.false") }
                    ]}
                  />
                </div>
                <div className="field-group automation-enabled-field">
                  <Checkbox checked={form.enabled} onChange={(event) => updateForm({ enabled: event.target.checked })}>
                    {t("automationConsole.field.enabled")}
                  </Checkbox>
                </div>
              </div>

              <div className="field-group is-spaced">
                <label htmlFor="automation-params-input">
                  <span>{t("automationConsole.field.params")}</span>
                  <Tooltip title={t("automationConsole.field.paramsTooltip")}>
                    <QuestionCircleOutlined />
                  </Tooltip>
                </label>
                <Input.TextArea
                  id="automation-params-input"
                  className="settings-textarea automation-mono-textarea"
                  rows={3}
                  placeholder='{"kind":"daily"}'
                  value={form.paramsText}
                  onChange={(event) => updateForm({ paramsText: event.target.value })}
                />
              </div>
            </fieldset>

            {formError && <div className="settings-error">{formError}</div>}

            <div className="automation-save-actions">
              <Button size="small" type="primary" icon={<SaveOutlined />} onClick={() => void saveForm()} disabled={saving}>
                {formMode === "create" ? t("automationConsole.action.create") : t("automationConsole.action.saveChanges")}
              </Button>
              {formMode === "edit" && (
                <Button size="small" onClick={startCreate} disabled={saving}>
                  {t("automationConsole.action.cancelEdit")}
                </Button>
              )}
            </div>

            <div className="automation-executions">
              <div className="automation-executions-head">
                <strong>{t("automationConsole.executions.title")}</strong>
                <Button size="small" icon={<ReloadOutlined />} onClick={() => void loadExecutions(selectedId)} disabled={!selectedId || executionsLoading}>
                  {t("automationConsole.action.refresh")}
                </Button>
              </div>
              <Spin spinning={executionsLoading}>
                {!selectedId ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("automationConsole.executions.emptyNoSelection")} />
                ) : executions.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("automationConsole.executions.empty")} />
                ) : (
                  <div className="automation-execution-list">
                    {executions.map((item) => (
                      <div className="automation-execution-row" key={item.id}>
                        <span>{item.status}</span>
                        <span>{toTimeLabel(item.startedAt, locale)}</span>
                        <span>{toDurationLabel(item.durationMs)}</span>
                        <span>{item.error || "--"}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Spin>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
