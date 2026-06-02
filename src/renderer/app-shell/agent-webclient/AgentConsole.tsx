import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  DeleteOutlined,
  DragOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  SearchOutlined
} from "@ant-design/icons";
import { Button, Empty, Input, Select, Spin, Tag } from "antd";
import type { TranslateFunction } from "../../../shared/i18n";
import { AgentIcon, AGENT_ICON_NAMES } from "../navigation/AgentIcon";
import { useI18n } from "../../i18n/useI18n";
import {
  createAgent,
  deleteAgent,
  getAgent,
  getAgentEditorOptions,
  getAgents,
  getSkills,
  getTools,
  putAgentOrder,
  updateAgent
} from "./api";
import type { Agent, AgentDetailResponse, AgentEditorOptionsResponse, GetAgentsOptions } from "./types";
import {
  agentOrderPayload,
  asRecord,
  filterAgentsPreservingOrder,
  moveAgentForDrop,
  stringifyJson,
  textListFromUnknown,
  toText
} from "./utils";

type AgentFormMode = "create" | "edit";
type IconKind = "none" | "builtin" | "image";

interface AgentFormState {
  key: string;
  name: string;
  iconKind: IconKind;
  iconName: string;
  iconImage: string;
  role: string;
  description: string;
  mode: string;
  modelKey: string;
  tools: string[];
  skills: string[];
  wonders: string[];
  contextTags: string[];
  visibilityScopes: string[];
  budgetText: string;
  controlsText: string;
  runtimeConfigText: string;
  memoryConfigText: string;
  proxyConfigText: string;
  soulPrompt: string;
  agentsPrompt: string;
}

interface AgentConsoleProps {
  selectedAgentKey?: string;
  agents: Agent[];
  onAgentsChange: (agents: Agent[]) => void;
  onSelectAgentKey?: (agentKey: string) => void;
  onClearSelection?: () => void;
}

export const AGENT_CONSOLE_LIST_OPTIONS: GetAgentsOptions = { scope: "all" };

const EMPTY_FORM: AgentFormState = {
  key: "",
  name: "",
  iconKind: "none",
  iconName: "",
  iconImage: "",
  role: "",
  description: "",
  mode: "REACT",
  modelKey: "",
  tools: [],
  skills: [],
  wonders: [],
  contextTags: [],
  visibilityScopes: ["nav"],
  budgetText: "",
  controlsText: "[]",
  runtimeConfigText: "",
  memoryConfigText: "",
  proxyConfigText: "",
  soulPrompt: "",
  agentsPrompt: ""
};

const BUDGET_PLACEHOLDER = `{
  "runTimeoutMs": 600000,
  "maxSteps": 240,
  "model": { "maxCalls": 240 },
  "tool": { "maxCalls": 200 }
}`;

export function agentConsoleListRequestOptions(): GetAgentsOptions {
  return { ...AGENT_CONSOLE_LIST_OPTIONS };
}

export async function saveAgentOrderRequest(agents: Agent[]): Promise<void> {
  await putAgentOrder({ order: agentOrderPayload(agents) });
}

function parseJsonField(
  label: string,
  value: string,
  t: TranslateFunction,
  options: { allowEmpty?: boolean; expectArray?: boolean } = {}
): unknown {
  const raw = value.trim();
  if (!raw && options.allowEmpty !== false) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (options.expectArray && !Array.isArray(parsed)) {
      throw new Error(t("agentConsole.error.jsonArray", { label }));
    }
    if (!options.expectArray && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) {
      throw new Error(t("agentConsole.error.jsonObject", { label }));
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      message.startsWith(label)
        ? message
        : t("agentConsole.error.jsonInvalid", { label, detail: message })
    );
  }
}

function normalizeModeForForm(value: unknown): string {
  switch (toText(value).toUpperCase()) {
    case "PROXY":
    case "ACP-PROXY":
    case "ACP_PROXY":
      return "PROXY";
    case "PLAN-EXECUTE":
    case "PLAN_EXECUTE":
      return "PLAN_EXECUTE";
    case "ONESHOT":
    case "":
      return "REACT";
    default:
      return toText(value).toUpperCase();
  }
}

function iconFieldsFromValue(value: unknown): Pick<AgentFormState, "iconKind" | "iconName" | "iconImage"> {
  if (typeof value === "string" && value.trim()) {
    return { iconKind: "image", iconName: "", iconImage: value.trim() };
  }
  const record = asRecord(value);
  const name = toText(record.name);
  if (name) {
    return { iconKind: "builtin", iconName: name, iconImage: "" };
  }
  return { iconKind: "none", iconName: "", iconImage: "" };
}

function buildIconValue(form: AgentFormState): unknown {
  if (form.iconKind === "image") {
    return form.iconImage.trim() || undefined;
  }
  if (form.iconKind === "builtin") {
    return form.iconName.trim() ? { name: form.iconName.trim() } : undefined;
  }
  return undefined;
}

function optionLabel(item: Record<string, unknown>): string {
  return toText(item.label) || toText(item.name) || toText(item.key);
}

function countListItems(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function readCount(value: unknown): number | undefined {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : undefined;
}

function resolveFirstCount(...values: unknown[]): number {
  for (const value of values) {
    const count = readCount(value);
    if (count !== undefined) {
      return count;
    }
    if (Array.isArray(value)) {
      return countListItems(value);
    }
  }
  return 0;
}

export function buildAgentListSummary(agent: Agent, formFallback?: AgentFormState) {
  const meta = asRecord(agent.meta);
  const modelConfig = asRecord(agent.modelConfig);
  const toolConfig = asRecord(agent.toolConfig);
  const skillConfig = asRecord(agent.skillConfig);
  return {
    mode: formFallback?.mode || toText(meta.mode) || toText(agent.mode) || "--",
    modelKey:
      toText(meta.modelKey) ||
      toText(meta.model) ||
      toText(agent.modelKey) ||
      toText(modelConfig.modelKey) ||
      toText(agent.model) ||
      formFallback?.modelKey ||
      "--",
    toolsCount: resolveFirstCount(meta.toolsCount, meta.tools, toolConfig.tools, agent.tools, formFallback?.tools),
    skillsCount: resolveFirstCount(meta.skillsCount, meta.skills, skillConfig.skills, agent.skills, formFallback?.skills)
  };
}

function resolveModelKey(detail: AgentDetailResponse, definition: Record<string, unknown>): string {
  const modelConfig = asRecord(definition.modelConfig);
  const meta = asRecord(detail.meta);
  return toText(modelConfig.modelKey) || toText(meta.modelKey) || toText(detail.model);
}

function fallbackDefinition(detail: AgentDetailResponse): Record<string, unknown> {
  const definition: Record<string, unknown> = {
    key: detail.key,
    name: detail.name,
    icon: detail.icon,
    role: detail.role || "",
    description: detail.description || "",
    mode: normalizeModeForForm(detail.mode)
  };
  const meta = asRecord(detail.meta);
  const visibility = asRecord(meta.visibility);
  const budget = asRecord(meta.budget);
  const modelKey = toText(meta.modelKey) || toText(detail.model);
  if (modelKey) {
    definition.modelConfig = { modelKey };
  }
  if (Array.isArray(detail.tools)) {
    definition.toolConfig = { tools: detail.tools };
  }
  if (Array.isArray(detail.skills)) {
    definition.skillConfig = { skills: detail.skills };
  }
  if (Array.isArray(detail.wonders)) {
    definition.wonders = detail.wonders;
  }
  if (Array.isArray(detail.controls)) {
    definition.controls = detail.controls;
  }
  if (Array.isArray(visibility.scopes)) {
    definition.visibility = { scopes: visibility.scopes };
  }
  if (Object.keys(budget).length > 0) {
    definition.budget = budget;
  }
  return definition;
}

export function formFromDetail(detail: AgentDetailResponse): AgentFormState {
  const definition = detail.definition || fallbackDefinition(detail);
  const modelConfig = asRecord(definition.modelConfig);
  const toolConfig = asRecord(definition.toolConfig);
  const skillConfig = asRecord(definition.skillConfig);
  const contextConfig = asRecord(definition.contextConfig);
  const meta = asRecord(detail.meta);
  const definitionVisibility = asRecord(definition.visibility);
  const metaVisibility = asRecord(meta.visibility);
  const definitionBudget = asRecord(definition.budget);
  const metaBudget = asRecord(meta.budget);
  const budget = Object.keys(definitionBudget).length > 0 ? definitionBudget : metaBudget;
  return {
    key: toText(definition.key) || detail.key,
    name: toText(definition.name) || detail.name || detail.key,
    ...iconFieldsFromValue(definition.icon ?? detail.icon),
    role: toText(definition.role) || detail.role || "",
    description: toText(definition.description) || detail.description || "",
    mode: normalizeModeForForm(toText(definition.mode) || detail.mode || "REACT"),
    modelKey: toText(modelConfig.modelKey) || resolveModelKey(detail, definition),
    tools: textListFromUnknown(toolConfig.tools || detail.tools),
    skills: textListFromUnknown(skillConfig.skills || detail.skills),
    wonders: textListFromUnknown(definition.wonders || detail.wonders),
    contextTags: textListFromUnknown(contextConfig.tags || definition.contextTags),
    visibilityScopes: (() => {
      const definitionScopes = textListFromUnknown(definitionVisibility.scopes);
      if (definitionScopes.length > 0) {
        return definitionScopes;
      }
      const metaScopes = textListFromUnknown(metaVisibility.scopes);
      return metaScopes.length > 0 ? metaScopes : ["nav"];
    })(),
    budgetText: stringifyJson(budget),
    controlsText: stringifyJson(definition.controls || detail.controls || [], "[]"),
    runtimeConfigText: stringifyJson(definition.runtimeConfig),
    memoryConfigText: stringifyJson(definition.memoryConfig),
    proxyConfigText: stringifyJson(definition.proxyConfig),
    soulPrompt: detail.soulPrompt || "",
    agentsPrompt: detail.agentsPrompt || ""
  };
}

export function buildDefinition(
  form: AgentFormState,
  baseDefinition: Record<string, unknown>,
  t: TranslateFunction
): Record<string, unknown> {
  const definition = { ...baseDefinition };
  definition.key = form.key.trim();
  definition.name = form.name.trim();
  const icon = buildIconValue(form);
  if (icon) {
    definition.icon = icon;
  } else {
    delete definition.icon;
  }
  definition.role = form.role.trim();
  definition.description = form.description.trim();
  definition.mode = normalizeModeForForm(form.mode);

  const modelKey = form.modelKey.trim();
  if (modelKey) {
    definition.modelConfig = { ...asRecord(definition.modelConfig), modelKey };
  } else {
    delete definition.modelConfig;
  }

  const tools = form.tools.map((item) => item.trim()).filter(Boolean);
  if (tools.length > 0) {
    definition.toolConfig = { ...asRecord(definition.toolConfig), tools };
  } else {
    delete definition.toolConfig;
  }

  const skills = form.skills.map((item) => item.trim()).filter(Boolean);
  if (skills.length > 0) {
    definition.skillConfig = { ...asRecord(definition.skillConfig), skills };
  } else {
    delete definition.skillConfig;
  }

  const wonders = form.wonders.map((item) => item.trim()).filter(Boolean);
  if (wonders.length > 0) {
    definition.wonders = wonders;
  } else {
    delete definition.wonders;
  }

  const contextTags = form.contextTags.map((item) => item.trim()).filter(Boolean);
  if (contextTags.length > 0) {
    definition.contextConfig = { ...asRecord(definition.contextConfig), tags: contextTags };
    delete definition.contextTags;
  } else {
    const existingContextConfig = asRecord(definition.contextConfig);
    delete existingContextConfig.tags;
    if (Object.keys(existingContextConfig).length > 0) {
      definition.contextConfig = existingContextConfig;
    } else {
      delete definition.contextConfig;
    }
    delete definition.contextTags;
  }

  const visibilityScopes = form.visibilityScopes.map((item) => item.trim()).filter(Boolean);
  if (visibilityScopes.length > 0) {
    definition.visibility = { ...asRecord(definition.visibility), scopes: visibilityScopes };
  } else {
    delete definition.visibility;
  }

  const budget = parseJsonField("Budget", form.budgetText, t);
  if (budget === undefined) {
    delete definition.budget;
  } else {
    definition.budget = budget;
  }

  definition.controls = parseJsonField("Controls", form.controlsText, t, { expectArray: true });
  for (const [key, label, value] of [
    ["runtimeConfig", "Runtime Config", form.runtimeConfigText],
    ["memoryConfig", "Memory Config", form.memoryConfigText]
  ] as const) {
    const parsed = parseJsonField(label, value, t);
    if (parsed === undefined) {
      delete definition[key];
    } else {
      definition[key] = parsed;
    }
  }
  if (definition.mode === "PROXY") {
    definition.proxyConfig = parseJsonField("Proxy Config", form.proxyConfigText, t, { allowEmpty: false });
  } else {
    delete definition.proxyConfig;
  }
  return definition;
}

type SortableAgentListItemProps = {
  agent: Agent;
  agentKey: string;
  disabled: boolean;
  isActive: boolean;
  isDragging: boolean;
  name: string;
  role: string;
  sortableId: string;
  summary: ReturnType<typeof buildAgentListSummary>;
  t: TranslateFunction;
  onSelect: (agentKey: string) => void;
};

function SortableAgentListItem({
  agent,
  agentKey,
  disabled,
  isActive,
  isDragging,
  name,
  role,
  sortableId,
  summary,
  t,
  onSelect
}: SortableAgentListItemProps) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition
  } = useSortable({
    id: sortableId,
    disabled: disabled || !agentKey
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      role="button"
      tabIndex={0}
      className={`agent-console-list-item ${isActive ? "is-active" : ""} ${isDragging ? "is-dragging" : ""}`}
      onClick={() => onSelect(agentKey)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(agentKey);
        }
      }}
    >
      <span
        ref={setActivatorNodeRef}
        className={`agent-console-list-item-icon ${disabled || !agentKey ? "" : "is-drag-handle"}`}
        aria-label={t("agentConsole.list.dragHandle", { name })}
        {...attributes}
        {...listeners}
      >
        <AgentIcon icon={agent.icon as never} className="agent-console-list-item-svg" size={28} type="agent" />
        <DragOutlined className="agent-console-drag-icon" />
      </span>
      <span className="agent-console-list-item-main">
        <span className="agent-console-list-item-row agent-console-list-item-head">
          <strong>{name}</strong>
          <span>{agentKey || "--"}</span>
        </span>
        <span className="agent-console-list-item-row agent-console-list-item-meta">
          <span>{role}</span>
          <span>{summary.mode}</span>
        </span>
        <span className="agent-console-list-item-row agent-console-list-item-meta">
          <span>{summary.modelKey}</span>
          <span>{t("agentConsole.list.toolsSkills", { tools: summary.toolsCount, skills: summary.skillsCount })}</span>
        </span>
      </span>
    </div>
  );
}

export function AgentConsole({
  selectedAgentKey = "",
  agents,
  onAgentsChange,
  onSelectAgentKey,
  onClearSelection
}: AgentConsoleProps) {
  const { t } = useI18n();
  const [internalSelectedKey, setInternalSelectedKey] = useState("");
  const effectiveSelectedKey = selectedAgentKey || internalSelectedKey;
  const [searchText, setSearchText] = useState("");
  const [formMode, setFormMode] = useState<AgentFormMode>("create");
  const [form, setForm] = useState<AgentFormState>(EMPTY_FORM);
  const [detail, setDetail] = useState<AgentDetailResponse | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [editorOptions, setEditorOptions] = useState<AgentEditorOptionsResponse | null>(null);
  const [toolOptions, setToolOptions] = useState<Array<{ key: string; label: string }>>([]);
  const [skillOptions, setSkillOptions] = useState<Array<{ key: string; label: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [pendingDeleteKey, setPendingDeleteKey] = useState("");
  const [draggingAgentKey, setDraggingAgentKey] = useState("");
  const didInitialSelectRef = useRef(false);
  const didBootstrapAgentsRef = useRef(false);
  const didBootstrapOptionsRef = useRef(false);
  const listLoadSeqRef = useRef(0);
  const optionsLoadSeqRef = useRef(0);
  const selectedAgentKeyRef = useRef(selectedAgentKey);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const filteredAgents = useMemo(() => filterAgentsPreservingOrder(agents, searchText), [agents, searchText]);
  const filteredAgentSortableIds = useMemo(
    () => filteredAgents.map((agent, index) => toText(agent.key) || `agent-console-empty-${index}`),
    [filteredAgents]
  );
  const selectedSummary = useMemo(
    () => agents.find((agent) => toText(agent.key) === effectiveSelectedKey) || null,
    [agents, effectiveSelectedKey]
  );
  const modeOptions = useMemo(
    () =>
      (editorOptions?.modes?.length
        ? editorOptions.modes
        : [
            { key: "REACT", label: "REACT" },
            { key: "PLAN_EXECUTE", label: "PLAN-EXECUTE" },
            { key: "PROXY", label: "ACP-PROXY" }
          ]).map((item) => ({ value: item.key, label: item.label })),
    [editorOptions]
  );
  const modelOptions = useMemo(
    () => (editorOptions?.models || []).map((item) => {
      const name = toText(item.name);
      const key = toText(item.key);
      return { value: item.key, label: name || (item.modelId ? `${key} · ${item.modelId}` : key) };
    }),
    [editorOptions]
  );
  const contextTagOptions = useMemo(
    () => (editorOptions?.contextTags || []).map((item) => ({ value: item.key, label: item.label || item.key })),
    [editorOptions]
  );
  const visibilityScopeOptions = useMemo(
    () =>
      (editorOptions?.visibilityScopes?.length
        ? editorOptions.visibilityScopes
        : [
            { key: "nav", label: "nav" },
            { key: "copilot", label: "copilot" },
            { key: "invoke", label: "invoke" },
            { key: "internal", label: "internal" }
          ]).map((item) => ({ value: item.key, label: item.label || item.key })),
    [editorOptions]
  );
  const selectedIconValue = useMemo(() => {
    if (form.iconKind === "image") {
      return form.iconImage;
    }
    if (form.iconKind === "builtin" && form.iconName) {
      return { name: form.iconName };
    }
    return undefined;
  }, [form.iconImage, form.iconKind, form.iconName]);

  useEffect(() => {
    selectedAgentKeyRef.current = selectedAgentKey;
  }, [selectedAgentKey]);

  const selectAgent = useCallback(
    (agentKey: string) => {
      const key = agentKey.trim();
      setInternalSelectedKey(key);
      if (key) {
        onSelectAgentKey?.(key);
      }
    },
    [onSelectAgentKey]
  );

  const startCreate = useCallback(() => {
    setFormMode("create");
    setForm(EMPTY_FORM);
    setDetail(null);
    setInternalSelectedKey("");
    setFormError("");
    setError("");
    setPendingDeleteKey("");
    onClearSelection?.();
  }, [onClearSelection]);

  const loadAgents = useCallback(
    async (preferredKey = "") => {
      const requestSeq = listLoadSeqRef.current + 1;
      listLoadSeqRef.current = requestSeq;
      setLoadingList(true);
      setError("");
      try {
        const response = await getAgents(agentConsoleListRequestOptions());
        const nextAgents = Array.isArray(response) ? response : [];
        if (listLoadSeqRef.current !== requestSeq) {
          return;
        }
        onAgentsChange(nextAgents);
        const normalizedPreferred = preferredKey.trim();
        const nextKey = normalizedPreferred && nextAgents.some((agent) => toText(agent.key) === normalizedPreferred)
          ? normalizedPreferred
          : nextAgents[0]?.key || "";
        if (!selectedAgentKeyRef.current && nextKey && !didInitialSelectRef.current) {
          didInitialSelectRef.current = true;
          setInternalSelectedKey(nextKey);
        }
      } catch (loadError) {
        if (listLoadSeqRef.current !== requestSeq) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (listLoadSeqRef.current === requestSeq) {
          setLoadingList(false);
        }
      }
    },
    [onAgentsChange]
  );

  const saveAgentOrder = useCallback(async (nextAgents: Agent[]) => {
    setSavingOrder(true);
    setError("");
    try {
      await saveAgentOrderRequest(nextAgents);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSavingOrder(false);
    }
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDraggingAgentKey(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const sourceKey = String(event.active.id);
      const targetKey = event.over ? String(event.over.id) : "";
      setDraggingAgentKey("");
      if (!sourceKey || !targetKey || sourceKey === targetKey || savingOrder) {
        return;
      }
      const nextAgents = moveAgentForDrop(agents, sourceKey, targetKey);
      if (nextAgents === agents) {
        return;
      }
      onAgentsChange(nextAgents);
      await saveAgentOrder(nextAgents);
    },
    [agents, onAgentsChange, saveAgentOrder, savingOrder]
  );

  const loadEditorOptions = useCallback(async () => {
    const requestSeq = optionsLoadSeqRef.current + 1;
    optionsLoadSeqRef.current = requestSeq;
    setLoadingOptions(true);
    try {
      const [optionsResponse, toolsResponse, skillsResponse] = await Promise.all([
        getAgentEditorOptions(),
        getTools(),
        getSkills()
      ]);
      if (optionsLoadSeqRef.current !== requestSeq) {
        return;
      }
      setEditorOptions(optionsResponse || null);
      setToolOptions(
        (Array.isArray(toolsResponse) ? toolsResponse : [])
          .map((item) => {
            const record = asRecord(item);
            const key = toText(record.key) || toText(record.name);
            return key ? { key, label: optionLabel(record) || key } : null;
          })
          .filter((item): item is { key: string; label: string } => Boolean(item))
      );
      setSkillOptions(
        (Array.isArray(skillsResponse) ? skillsResponse : [])
          .map((item) => {
            const record = asRecord(item);
            const key = toText(record.key);
            return key ? { key, label: optionLabel(record) || key } : null;
          })
          .filter((item): item is { key: string; label: string } => Boolean(item))
      );
    } catch (loadError) {
      if (optionsLoadSeqRef.current !== requestSeq) {
        return;
      }
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (optionsLoadSeqRef.current === requestSeq) {
        setLoadingOptions(false);
      }
    }
  }, []);

  const loadDetail = useCallback(async (agentKey: string) => {
    const key = agentKey.trim();
    if (!key) {
      return;
    }
    setLoadingDetail(true);
    setError("");
    setFormError("");
    setPendingDeleteKey("");
    try {
      const nextDetail = await getAgent(key);
      setDetail(nextDetail);
      setForm(formFromDetail(nextDetail));
      setFormMode("edit");
    } catch (loadError) {
      setDetail(null);
      setFormMode("edit");
      setForm({ ...EMPTY_FORM, key });
      setFormError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    if (didBootstrapAgentsRef.current) {
      return;
    }
    didBootstrapAgentsRef.current = true;
    void loadAgents(selectedAgentKey);
  }, [loadAgents, selectedAgentKey]);

  useEffect(() => {
    if (didBootstrapOptionsRef.current) {
      return;
    }
    didBootstrapOptionsRef.current = true;
    void loadEditorOptions();
  }, [loadEditorOptions]);

  useEffect(() => {
    if (selectedAgentKey) {
      setInternalSelectedKey(selectedAgentKey);
    }
  }, [selectedAgentKey]);

  useEffect(() => {
    if (effectiveSelectedKey) {
      void loadDetail(effectiveSelectedKey);
    } else if (agents.length === 0 && !loadingList) {
      startCreate();
    }
  }, [agents.length, effectiveSelectedKey, loadDetail, loadingList, startCreate]);

  const updateForm = (patch: Partial<AgentFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    setFormError("");
  };

  const saveForm = async () => {
    if (!form.key.trim()) {
      setFormError(t("agentConsole.error.keyRequired"));
      return;
    }
    if (!form.name.trim()) {
      setFormError(t("agentConsole.error.nameRequired"));
      return;
    }
    setSaving(true);
    setError("");
    setFormError("");
    try {
      const baseDefinition = formMode === "edit" && detail ? detail.definition || fallbackDefinition(detail) : {};
      const definition = buildDefinition(form, baseDefinition, t);
      const saved = formMode === "create"
        ? await createAgent({ key: form.key.trim(), definition, soulPrompt: form.soulPrompt, agentsPrompt: form.agentsPrompt })
        : await updateAgent({ key: form.key.trim(), definition, soulPrompt: form.soulPrompt, agentsPrompt: form.agentsPrompt });
      const savedKey = saved.key || form.key.trim();
      setDetail(saved);
      setForm(formFromDetail(saved));
      setFormMode("edit");
      await loadAgents(savedKey);
      selectAgent(savedKey);
    } catch (saveError) {
      setFormError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    const key = form.key.trim();
    if (!key || formMode !== "edit") {
      return;
    }
    if (pendingDeleteKey !== key) {
      setPendingDeleteKey(key);
      return;
    }
    setSaving(true);
    setError("");
    setFormError("");
    try {
      await deleteAgent({ key });
      const remaining = agents.filter((agent) => toText(agent.key) !== key);
      onAgentsChange(remaining);
      const nextKey = remaining[0]?.key || "";
      if (nextKey) {
        selectAgent(nextKey);
      } else {
        startCreate();
      }
    } catch (deleteError) {
      setFormError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setSaving(false);
    }
  };

  const setMode = (mode: string) => {
    if (mode === "PROXY" && !form.proxyConfigText.trim()) {
      updateForm({
        mode,
        proxyConfigText: JSON.stringify({ baseUrl: "", timeoutMs: editorOptions?.proxyConfigSchema?.defaultTimeoutMs || 300000 }, null, 2)
      });
      return;
    }
    updateForm({ mode });
  };

  return (
    <div className="command-modal-section agent-console">
      <div className="agent-console-toolbar">
        <Input
          prefix={<SearchOutlined />}
          variant="filled"
          placeholder={t("agentConsole.searchPlaceholder")}
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
        />
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={() => void loadAgents(effectiveSelectedKey)}
          disabled={loadingList || saving}
          aria-label={t("agentConsole.action.refresh")}
        />
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={startCreate}>
          {t("agentConsole.action.new")}
        </Button>
      </div>

      {error && (
        <div className="agent-console-error">
          <span>{error}</span>
          <Button size="small" onClick={() => void loadAgents()}>{t("agentConsole.action.retry")}</Button>
        </div>
      )}

      <div className="agent-console-body">
        <div className="agent-console-list">
          <div className="agent-console-count">
            <span>{t("agentConsole.list.count", { count: agents.length })}</span>
            {savingOrder && <span>{t("agentConsole.list.savingOrder")}</span>}
          </div>
          <Spin spinning={loadingList || savingOrder}>
            {filteredAgents.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("agentConsole.empty")}>
                <Button size="small" type="primary" onClick={startCreate}>{t("agentConsole.action.create")}</Button>
              </Empty>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragCancel={() => setDraggingAgentKey("")}
                onDragEnd={(event) => {
                  void handleDragEnd(event);
                }}
              >
                <SortableContext items={filteredAgentSortableIds} strategy={verticalListSortingStrategy}>
                  <div className="agent-console-list-items">
                    {filteredAgents.map((agent, index) => {
                      const agentKey = toText(agent.key);
                      const name = toText(agent.name) || agentKey;
                      const role = toText(agent.role) || "--";
                      const summary = buildAgentListSummary(agent, agentKey === form.key ? form : undefined);
                      const sortableId = agentKey || `agent-console-empty-${index}`;
                      return (
                        <SortableAgentListItem
                          key={sortableId}
                          agent={agent}
                          agentKey={agentKey}
                          disabled={savingOrder}
                          isActive={agentKey === effectiveSelectedKey}
                          isDragging={agentKey === draggingAgentKey}
                          name={name}
                          role={role}
                          sortableId={sortableId}
                          summary={summary}
                          t={t}
                          onSelect={selectAgent}
                        />
                      );
                    })}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </Spin>
        </div>

        <div className="agent-console-detail">
          <Spin spinning={loadingDetail}>
            <div className="agent-detail-head">
              <div>
                <strong>{formMode === "create" ? t("agentConsole.detail.titleCreate") : selectedSummary?.name || form.name || form.key || t("agentConsole.detail.titleEdit")}</strong>
                <span>{formMode === "create" ? t("agentConsole.detail.createSubtitle") : detail?.source?.path || form.key}</span>
              </div>
              {formMode === "edit" && (
                <div className="agent-detail-actions">
                  <Button size="small" danger icon={<DeleteOutlined />} onClick={() => void confirmDelete()} disabled={saving}>
                    {pendingDeleteKey === form.key ? t("agentConsole.action.confirmDelete") : t("agentConsole.action.delete")}
                  </Button>
                </div>
              )}
            </div>

            <div className="agent-form-grid">
              <div className="field-group">
                <label htmlFor="agent-key-input">Key</label>
                <Input id="agent-key-input" value={form.key} disabled={formMode === "edit"} onChange={(event) => updateForm({ key: event.target.value })} />
              </div>
              <div className="field-group">
                <label htmlFor="agent-name-input">{t("agentConsole.field.name")}</label>
                <Input id="agent-name-input" value={form.name} onChange={(event) => updateForm({ name: event.target.value })} />
              </div>
              <div className="field-group">
                <label htmlFor="agent-role-input">{t("agentConsole.field.role")}</label>
                <Input id="agent-role-input" value={form.role} onChange={(event) => updateForm({ role: event.target.value })} />
              </div>
              <div className="field-group">
                <label htmlFor="agent-mode-input">{t("agentConsole.field.mode")}</label>
                <Select id="agent-mode-input" value={form.mode} options={modeOptions} onChange={setMode} />
              </div>
              <div className="field-group">
                <label htmlFor="agent-model-input">Model Key</label>
                <Select id="agent-model-input" showSearch allowClear loading={loadingOptions} value={form.modelKey || undefined} options={modelOptions} optionFilterProp="label" onChange={(value) => updateForm({ modelKey: value || "" })} />
              </div>
              <div className="field-group">
                <label htmlFor="agent-tags-input">Context Tags</label>
                <Select id="agent-tags-input" mode="multiple" allowClear loading={loadingOptions} value={form.contextTags} options={contextTagOptions} onChange={(value) => updateForm({ contextTags: value })} />
              </div>
              <div className="field-group">
                <label htmlFor="agent-icon-kind-input">Icon</label>
                <div className="agent-icon-editor">
                  <span className="agent-icon-preview">
                    <AgentIcon icon={selectedIconValue as never} type="agent" />
                  </span>
                  <Select
                    id="agent-icon-kind-input"
                    value={form.iconKind}
                    options={[
                      { value: "none", label: "Default" },
                      { value: "builtin", label: "Built-in" },
                      { value: "image", label: "JPG / PNG / SVG" }
                    ]}
                    onChange={(value: IconKind) => updateForm({ iconKind: value })}
                  />
                </div>
              </div>
              {form.iconKind === "builtin" && (
                <div className="field-group">
                  <label htmlFor="agent-icon-name-input">Icon Name</label>
                  <Select id="agent-icon-name-input" showSearch allowClear value={form.iconName || undefined} options={AGENT_ICON_NAMES.map((name) => ({ value: name, label: name }))} onChange={(value) => updateForm({ iconName: value || "" })} />
                </div>
              )}
              {form.iconKind === "image" && (
                <div className="field-group">
                  <label htmlFor="agent-icon-image-input">Icon Image</label>
                  <Input id="agent-icon-image-input" placeholder={t("agentConsole.placeholder.iconImage")} value={form.iconImage} onChange={(event) => updateForm({ iconImage: event.target.value })} />
                </div>
              )}
            </div>

            <div className="field-group">
              <label htmlFor="agent-description-input">{t("agentConsole.field.description")}</label>
              <Input.TextArea id="agent-description-input" rows={3} value={form.description} onChange={(event) => updateForm({ description: event.target.value })} />
            </div>

            <fieldset className="agent-config-box">
              <legend>{t("agentConsole.section.capabilities")}</legend>
              <div className="agent-form-grid">
                <div className="field-group">
                  <label htmlFor="agent-tools-input">Tools</label>
                  <Select
                    id="agent-tools-input"
                    mode="multiple"
                    showSearch
                    allowClear
                    loading={loadingOptions}
                    value={form.tools}
                    options={toolOptions.map((item) => ({ value: item.key, label: `${item.label}${item.label === item.key ? "" : ` · ${item.key}`}` }))}
                    optionFilterProp="label"
                    onChange={(value) => updateForm({ tools: value })}
                  />
                </div>
                <div className="field-group">
                  <label htmlFor="agent-skills-input">Skills</label>
                  <Select
                    id="agent-skills-input"
                    mode="multiple"
                    showSearch
                    allowClear
                    loading={loadingOptions}
                    value={form.skills}
                    options={skillOptions.map((item) => ({ value: item.key, label: `${item.label}${item.label === item.key ? "" : ` · ${item.key}`}` }))}
                    optionFilterProp="label"
                    onChange={(value) => updateForm({ skills: value })}
                  />
                </div>
              </div>
              <div className="field-group">
                <label>Wonders</label>
                <div className="agent-wonders-editor">
                  {(form.wonders.length > 0 ? form.wonders : [""]).map((wonder, index) => (
                    <div className="agent-wonder-row" key={`${index}-${wonder}`}>
                      <Input
                        value={wonder}
                        onChange={(event) => {
                          const next = form.wonders.length > 0 ? [...form.wonders] : [""];
                          next[index] = event.target.value;
                          updateForm({ wonders: next });
                        }}
                      />
                      <Button size="small" icon={<DeleteOutlined />} aria-label={t("agentConsole.wonders.remove")} onClick={() => updateForm({ wonders: form.wonders.filter((_, itemIndex) => itemIndex !== index) })} />
                    </div>
                  ))}
                  <Button size="small" icon={<PlusOutlined />} onClick={() => updateForm({ wonders: [...form.wonders, ""] })}>
                    {t("agentConsole.action.add")}
                  </Button>
                </div>
              </div>
            </fieldset>

            <fieldset className="agent-config-box">
              <legend>{t("agentConsole.section.advancedConfig")}</legend>
              <div className="agent-form-grid">
                <div className="field-group">
                  <label htmlFor="agent-controls-input">Controls</label>
                  <Input.TextArea id="agent-controls-input" className="settings-textarea agent-mono-textarea" rows={5} value={form.controlsText} onChange={(event) => updateForm({ controlsText: event.target.value })} />
                </div>
                <div className="field-group">
                  <label htmlFor="agent-runtime-input">Runtime Config</label>
                  <Input.TextArea id="agent-runtime-input" className="settings-textarea agent-mono-textarea" rows={5} placeholder='{"environmentId":"shell","level":"RUN"}' value={form.runtimeConfigText} onChange={(event) => updateForm({ runtimeConfigText: event.target.value })} />
                </div>
                <div className="field-group">
                  <label htmlFor="agent-memory-input">Memory Config</label>
                  <Input.TextArea id="agent-memory-input" className="settings-textarea agent-mono-textarea" rows={5} value={form.memoryConfigText} onChange={(event) => updateForm({ memoryConfigText: event.target.value })} />
                </div>
                <div className="field-group">
                  <label htmlFor="agent-visibility-input">Visibility</label>
                  <Select id="agent-visibility-input" mode="multiple" allowClear loading={loadingOptions} value={form.visibilityScopes} options={visibilityScopeOptions} onChange={(value) => updateForm({ visibilityScopes: value })} />
                </div>
                <div className="field-group">
                  <label htmlFor="agent-budget-input">Budget</label>
                  <Input.TextArea id="agent-budget-input" className="settings-textarea agent-mono-textarea" rows={7} placeholder={BUDGET_PLACEHOLDER} value={form.budgetText} onChange={(event) => updateForm({ budgetText: event.target.value })} />
                </div>
                {form.mode === "PROXY" && (
                  <div className="field-group">
                    <label htmlFor="agent-proxy-input">ACP-PROXY Config</label>
                    <Input.TextArea id="agent-proxy-input" className="settings-textarea agent-mono-textarea" rows={5} placeholder='{"baseUrl":"http://127.0.0.1:3210","timeoutMs":300000}' value={form.proxyConfigText} onChange={(event) => updateForm({ proxyConfigText: event.target.value })} />
                  </div>
                )}
              </div>
            </fieldset>

            <fieldset className="agent-config-box">
              <legend>Prompt</legend>
              <div className="field-group">
                <label htmlFor="agent-soul-input">SOUL.md</label>
                <Input.TextArea id="agent-soul-input" className="settings-textarea agent-prompt-textarea" rows={5} value={form.soulPrompt} onChange={(event) => updateForm({ soulPrompt: event.target.value })} />
              </div>
              <div className="field-group">
                <label htmlFor="agent-agents-input">AGENTS.md</label>
                <Input.TextArea id="agent-agents-input" className="settings-textarea agent-prompt-textarea" rows={5} value={form.agentsPrompt} onChange={(event) => updateForm({ agentsPrompt: event.target.value })} />
              </div>
            </fieldset>

            {formError && <div className="settings-error">{formError}</div>}

            <div className="agent-save-actions">
              <Button size="small" type="primary" icon={<SaveOutlined />} onClick={() => void saveForm()} disabled={saving}>
                {formMode === "create" ? t("agentConsole.action.create") : t("agentConsole.action.saveChanges")}
              </Button>
              {formMode === "edit" && (
                <Button size="small" onClick={startCreate} disabled={saving}>
                  {t("agentConsole.action.cancelEdit")}
                </Button>
              )}
              {formMode === "edit" && selectedSummary && (
                <Tag bordered={false}>{selectedSummary.key}</Tag>
              )}
            </div>
          </Spin>
        </div>
      </div>
    </div>
  );
}
