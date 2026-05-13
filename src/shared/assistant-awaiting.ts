import type {
  AssistantAwaitingApproval,
  AssistantAwaitingForm,
  AssistantAwaitingPayload,
  AssistantAwaitingQuestion
} from "./contracts";

export type AssistantAwaitingDecision = "submit" | "reject" | "dismiss";

export type AssistantAwaitingAnswerValue = string | number | string[] | undefined;

export interface AssistantAwaitingFrameMessage {
  type: "awaiting_init" | "awaiting_update" | "awaiting_collect";
  data: Record<string, unknown>;
}

export interface AssistantAwaitingFrameSubmitParam {
  id: string;
  decision?: "submit" | "reject" | "cancel";
  reason?: string;
  form?: Record<string, unknown> | null;
  answer?: string | number;
  answers?: string[];
}

export const DEFAULT_APPROVAL_OPTIONS = [
  {
    label: "同意",
    description: "允许继续执行",
    decision: "approve"
  },
  {
    label: "拒绝",
    description: "停止本次操作",
    decision: "reject"
  }
];

export function normalizeAwaitingTimeoutMs(timeout: number | null | undefined): number | null {
  if (!Number.isFinite(timeout)) {
    return null;
  }
  const normalized = Number(timeout);
  if (normalized <= 0) {
    return null;
  }
  return normalized < 1000 ? Math.round(normalized * 1000) : Math.round(normalized);
}

export function formatAwaitingTimeoutLabel(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function getAwaitingTimeoutMs(awaiting: AssistantAwaitingPayload): number | null {
  return normalizeAwaitingTimeoutMs(awaiting.timeout ?? awaiting.timeoutMs ?? null);
}

export function getAwaitingCreatedAtMs(awaiting: AssistantAwaitingPayload): number | null {
  if (typeof awaiting.createdAt === "number" && Number.isFinite(awaiting.createdAt)) {
    return awaiting.createdAt;
  }
  if (typeof awaiting.createdAt === "string" && awaiting.createdAt.trim()) {
    const parsed = Date.parse(awaiting.createdAt);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function getAwaitingQuestionHeading(question: AssistantAwaitingQuestion): string {
  return String(question.header || question.label || question.question || question.id).trim();
}

export function getAwaitingQuestionPrompt(question: AssistantAwaitingQuestion): string {
  const heading = getAwaitingQuestionHeading(question);
  const prompt = String(question.question || question.label || "").trim();
  return prompt && prompt !== heading ? prompt : "";
}

export function getAwaitingQuestionPlaceholder(question: AssistantAwaitingQuestion): string {
  return String(question.placeholder || question.freeTextPlaceholder || "请输入").trim();
}

export function getAwaitingOptionValue(option: { label: string; value?: string }): string {
  return String(option.value || option.label).trim();
}

export function getAwaitingApprovals(awaiting: AssistantAwaitingPayload): AssistantAwaitingApproval[] {
  if (Array.isArray(awaiting.approvals) && awaiting.approvals.length > 0) {
    return awaiting.approvals.map((approval, index) => ({
      ...approval,
      id: String(approval.id || `approval_${index + 1}`)
    }));
  }
  if (!awaiting.approval) {
    return [];
  }
  return [
    {
      id: "approval",
      command: awaiting.approval.command,
      description: awaiting.approval.summary,
      summary: awaiting.approval.summary,
      risk: awaiting.approval.risk,
      cwd: awaiting.approval.cwd,
      paths: awaiting.approval.paths,
      options: awaiting.approval.options,
      allowFreeText: awaiting.approval.allowFreeText,
      freeTextPlaceholder: awaiting.approval.freeTextPlaceholder
    }
  ];
}

export function getAwaitingForms(awaiting: AssistantAwaitingPayload): AssistantAwaitingForm[] {
  if (Array.isArray(awaiting.forms) && awaiting.forms.length > 0) {
    return awaiting.forms.map((form, index) => ({
      ...form,
      id: String(form.id || `form_${index + 1}`),
      form: form.form ?? null
    }));
  }
  return [];
}

export function buildQuestionSubmitParams(
  awaiting: AssistantAwaitingPayload,
  values: Record<string, AssistantAwaitingAnswerValue>
) {
  return (awaiting.questions ?? []).map((question) => {
    const value = values[question.id];
    if (Array.isArray(value)) {
      return {
        id: question.id,
        answers: value.filter((item) => item.trim())
      };
    }
    if (typeof value === "number") {
      return {
        id: question.id,
        answer: value
      };
    }
    return {
      id: question.id,
      answer: typeof value === "string" ? value : ""
    };
  });
}

export function buildApprovalSubmitParams(
  approvals: AssistantAwaitingApproval[],
  decisions: Record<string, string | undefined>,
  reasons: Record<string, string | undefined>
) {
  return approvals.map((approval) => ({
    id: approval.id,
    decision: decisions[approval.id] || "approve",
    ...(reasons[approval.id]?.trim() ? { reason: reasons[approval.id]?.trim() } : {})
  }));
}

export function hasRejectApprovalDecision(decisions: Record<string, string | undefined>): boolean {
  return Object.values(decisions).some((decision) => String(decision || "").startsWith("reject"));
}

export function cloneAwaitingFormData(form: Record<string, unknown> | null | undefined) {
  return form ? { ...form } : null;
}

export function buildFormSubmitParams(forms: AssistantAwaitingForm[]) {
  return forms.map((form) => ({
    id: form.id,
    decision: "submit" as const,
    form: cloneAwaitingFormData(form.form)
  }));
}

export function buildFormRejectParams(forms: AssistantAwaitingForm[], reason?: string) {
  const trimmedReason = String(reason || "").trim();
  return forms.map((form) => ({
    id: form.id,
    decision: "reject" as const,
    ...(trimmedReason ? { reason: trimmedReason } : {}),
    form: cloneAwaitingFormData(form.form)
  }));
}

export function buildFormCancelParams(forms: AssistantAwaitingForm[]) {
  return forms.map((form) => ({
    id: form.id,
    decision: "cancel" as const
  }));
}

export function mergeSubmittedParamsIntoForms(
  forms: AssistantAwaitingForm[],
  params: AssistantAwaitingFrameSubmitParam[]
): AssistantAwaitingForm[] {
  const submittedById = new Map<string, Record<string, unknown> | null>();
  for (const param of params) {
    if ((param.decision === "submit" || param.decision === "reject") && Object.hasOwn(param, "form")) {
      submittedById.set(param.id, cloneAwaitingFormData(param.form));
    }
  }
  if (submittedById.size === 0) {
    return forms;
  }
  return forms.map((form) => submittedById.has(form.id) ? {
    ...form,
    form: submittedById.get(form.id) ?? null
  } : form);
}

export function buildAwaitingViewportData(
  awaiting: AssistantAwaitingPayload,
  forms: AssistantAwaitingForm[],
  activeFormIndex: number
) {
  const activeForm = forms[Math.max(0, Math.min(forms.length - 1, activeFormIndex))];
  return {
    runId: awaiting.runId,
    awaitingId: awaiting.awaitingId,
    viewportKey: awaiting.viewportKey || "",
    mode: "form",
    timeout: awaiting.timeout ?? awaiting.timeoutMs ?? null,
    activeFormIndex,
    activeFormId: activeForm?.id || "",
    forms: forms.map((form) => ({
      id: form.id,
      action: form.action,
      title: form.title,
      form: cloneAwaitingFormData(form.form)
    })),
    form: cloneAwaitingFormData(activeForm?.form)
  };
}

export function buildAwaitingFrameMessage(
  type: "awaiting_init" | "awaiting_update",
  awaiting: AssistantAwaitingPayload,
  forms: AssistantAwaitingForm[],
  activeFormIndex: number
): AssistantAwaitingFrameMessage {
  return {
    type,
    data: buildAwaitingViewportData(awaiting, forms, activeFormIndex)
  };
}

export function buildAwaitingCollectMessage(
  awaiting: AssistantAwaitingPayload,
  decision: "submit" | "reject"
): AssistantAwaitingFrameMessage {
  return {
    type: "awaiting_collect",
    data: {
      runId: awaiting.runId,
      awaitingId: awaiting.awaitingId,
      decision
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readAwaitingFrameSubmitParams(value: unknown, awaiting: AssistantAwaitingPayload) {
  if (!isRecord(value) || value.type !== "frontend_awaiting_submit") {
    return null;
  }
  const data = isRecord(value.data) ? value.data : value;
  if (String(data.awaitingId || awaiting.awaitingId) !== awaiting.awaitingId) {
    return null;
  }
  const rawParams = Array.isArray(data.params) ? data.params : [];
  const params: AssistantAwaitingFrameSubmitParam[] = [];
  for (const item of rawParams) {
    if (!isRecord(item)) {
      return null;
    }
    const id = String(item.id || "").trim();
    if (!id) {
      return null;
    }
    const decision = item.decision === "reject" || item.decision === "cancel" ? item.decision : "submit";
    params.push({
      id,
      decision,
      ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
      ...(isRecord(item.form) || item.form === null ? { form: item.form as Record<string, unknown> | null } : {})
    });
  }
  return params;
}
