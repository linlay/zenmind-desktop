import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssistantAwaitingApproval,
  AssistantAwaitingForm,
  AssistantAwaitingPayload,
  AssistantAwaitingQuestion,
  AssistantSubmitAwaitingResult
} from "../../shared/contracts";
import {
  DEFAULT_APPROVAL_OPTIONS,
  buildApprovalSubmitParams,
  buildAwaitingCollectMessage,
  buildAwaitingFrameMessage,
  buildFormCancelParams,
  buildFormRejectParams,
  buildFormSubmitParams,
  buildQuestionSubmitParams,
  formatAwaitingTimeoutLabel,
  getAwaitingApprovals,
  getAwaitingCreatedAtMs,
  getAwaitingForms,
  getAwaitingOptionValue,
  getAwaitingQuestionHeading,
  getAwaitingQuestionPlaceholder,
  getAwaitingQuestionPrompt,
  getAwaitingTimeoutMs,
  hasRejectApprovalDecision,
  mergeSubmittedParamsIntoForms,
  readAwaitingFrameSubmitParams,
  type AssistantAwaitingAnswerValue,
  type AssistantAwaitingDecision
} from "../../shared/assistant-awaiting";

type AwaitingSubmitInput = {
  action: AssistantAwaitingDecision;
  params?: unknown[];
  reason?: string;
};

type AssistantAwaitingDialogProps = {
  awaiting: AssistantAwaitingPayload;
  onSubmit: (input: AwaitingSubmitInput) => Promise<AssistantSubmitAwaitingResult>;
};

const COUNTDOWN_TICK_MS = 250;
const COLLECT_TIMEOUT_MS = 5000;

function clampIndex(index: number, length: number) {
  if (length <= 1) {
    return 0;
  }
  return Math.min(length - 1, Math.max(0, index));
}

function isRejectDecision(decision: string | undefined) {
  return String(decision || "").startsWith("reject");
}

function useAwaitingCountdown(awaiting: AssistantAwaitingPayload) {
  const timeoutMs = useMemo(() => getAwaitingTimeoutMs(awaiting), [awaiting]);
  const createdAt = useMemo(() => getAwaitingCreatedAtMs(awaiting), [awaiting]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    if (!timeoutMs) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => window.clearInterval(timer);
  }, [awaiting.awaitingId, createdAt, timeoutMs]);

  if (!timeoutMs) {
    return null;
  }

  const deadlineAt = (createdAt && createdAt > 0 ? createdAt : now) + timeoutMs;
  const remainingMs = Math.max(0, deadlineAt - now);
  return formatAwaitingTimeoutLabel(remainingMs);
}

function LoadingBlock({ text }: { text: string }) {
  return (
    <div className="assistant-hitl-dialog is-loading">
      <span className="assistant-hitl-spinner" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

export function AssistantAwaitingDialog({ awaiting, onSubmit }: AssistantAwaitingDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const timeoutLabel = useAwaitingCountdown(awaiting);

  useEffect(() => {
    setSubmitting(false);
  }, [awaiting.awaitingId]);

  const submitAwaiting = useCallback(async (input: AwaitingSubmitInput) => {
    if (submitting) {
      return false;
    }
    setSubmitting(true);
    try {
      const result = await onSubmit(input);
      if (!result.ok) {
        setSubmitting(false);
      }
      return result.ok;
    } catch {
      setSubmitting(false);
      return false;
    }
  }, [onSubmit, submitting]);

  const commonProps = {
    awaiting,
    submitting,
    timeoutLabel,
    onSubmit: submitAwaiting
  };

  let body: JSX.Element;
  if (awaiting.mode === "approval") {
    body = <ApprovalAwaitingDialog {...commonProps} />;
  } else if (awaiting.mode === "form") {
    body = <FormAwaitingDialog {...commonProps} />;
  } else {
    body = <QuestionAwaitingDialog {...commonProps} />;
  }

  return (
    <div className="assistant-awaiting-backdrop" role="presentation">
      {body}
    </div>
  );
}

type AwaitingDialogBodyProps = {
  awaiting: AssistantAwaitingPayload;
  submitting: boolean;
  timeoutLabel: string | null;
  onSubmit: (input: AwaitingSubmitInput) => Promise<boolean>;
};

function DialogHeader({
  eyebrow,
  title,
  description,
  timeoutLabel,
  side
}: {
  eyebrow: string;
  title: string;
  description?: string;
  timeoutLabel: string | null;
  side?: JSX.Element | null;
}) {
  return (
    <div className="assistant-hitl-header">
      <div className="assistant-hitl-header-main">
        <span className="assistant-hitl-eyebrow">{eyebrow}</span>
        <strong>{title}</strong>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="assistant-hitl-header-side">
        {timeoutLabel ? <span className="assistant-hitl-timeout">提交倒计时 {timeoutLabel}</span> : null}
        {side}
      </div>
    </div>
  );
}

function Pager({
  index,
  length,
  onChange,
  disabled
}: {
  index: number;
  length: number;
  onChange: (nextIndex: number) => void;
  disabled?: boolean;
}) {
  if (length <= 1) {
    return null;
  }
  return (
    <div className="assistant-hitl-pagination" aria-label="等待项分页">
      <button type="button" onClick={() => onChange(index - 1)} disabled={disabled || index <= 0} aria-label="上一项">
        ‹
      </button>
      <span>{index + 1} / {length}</span>
      <button type="button" onClick={() => onChange(index + 1)} disabled={disabled || index >= length - 1} aria-label="下一项">
        ›
      </button>
    </div>
  );
}

function FooterActions({
  submitting,
  canSubmit = true,
  submitLabel,
  continueLabel = "继续",
  showContinue,
  onIgnore,
  onContinue,
  onSubmit
}: {
  submitting: boolean;
  canSubmit?: boolean;
  submitLabel: string;
  continueLabel?: string;
  showContinue?: boolean;
  onIgnore: () => void;
  onContinue?: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="assistant-hitl-footer">
      <button type="button" className="assistant-hitl-link-button" onClick={onIgnore} disabled={submitting}>
        <span>忽略</span>
        <kbd>ESC</kbd>
      </button>
      {showContinue ? (
        <button type="button" className="assistant-hitl-primary-button" onClick={onContinue} disabled={submitting || !canSubmit}>
          {continueLabel}
        </button>
      ) : (
        <button type="button" className="assistant-hitl-primary-button" onClick={onSubmit} disabled={submitting || !canSubmit}>
          {submitting ? "提交中..." : submitLabel}
        </button>
      )}
    </div>
  );
}

function QuestionAwaitingDialog({ awaiting, submitting, timeoutLabel, onSubmit }: AwaitingDialogBodyProps) {
  const questions = awaiting.questions ?? [];
  const [activeIndex, setActiveIndex] = useState(0);
  const [values, setValues] = useState<Record<string, AssistantAwaitingAnswerValue>>({});
  const [freeTextValues, setFreeTextValues] = useState<Record<string, string>>({});
  const currentQuestion = questions[activeIndex];

  useEffect(() => {
    setActiveIndex(0);
    setValues({});
    setFreeTextValues({});
  }, [awaiting.awaitingId]);

  useEffect(() => {
    setActiveIndex((current) => clampIndex(current, questions.length));
  }, [questions.length]);

  const collectValues = useCallback(() => {
    const nextValues = { ...values };
    for (const question of questions) {
      const freeText = freeTextValues[question.id]?.trim();
      if (!freeText) {
        continue;
      }
      if (question.type === "multi-select") {
        const selected = Array.isArray(nextValues[question.id]) ? nextValues[question.id] as string[] : [];
        nextValues[question.id] = [...selected.filter((item) => item !== freeText), freeText];
      } else {
        nextValues[question.id] = freeText;
      }
    }
    return nextValues;
  }, [freeTextValues, questions, values]);

  const canMoveForward = useMemo(() => {
    if (!currentQuestion?.required) {
      return true;
    }
    const value = values[currentQuestion.id];
    const freeText = freeTextValues[currentQuestion.id]?.trim();
    if (Array.isArray(value)) {
      return value.length > 0 || Boolean(freeText);
    }
    return value !== undefined && String(value).trim().length > 0 || Boolean(freeText);
  }, [currentQuestion, freeTextValues, values]);

  const moveForward = useCallback(() => {
    if (!canMoveForward) {
      return;
    }
    if (activeIndex >= questions.length - 1) {
      void onSubmit({
        action: "submit",
        params: buildQuestionSubmitParams(awaiting, collectValues())
      });
      return;
    }
    setActiveIndex((current) => clampIndex(current + 1, questions.length));
  }, [activeIndex, awaiting, canMoveForward, collectValues, onSubmit, questions.length]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void onSubmit({ action: "dismiss", params: [] });
      }
      if (event.key === "ArrowLeft") {
        setActiveIndex((current) => clampIndex(current - 1, questions.length));
      }
      if (event.key === "ArrowRight") {
        setActiveIndex((current) => clampIndex(current + 1, questions.length));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSubmit, questions.length]);

  if (questions.length === 0) {
    return <LoadingBlock text="问题生成中..." />;
  }

  return (
    <section className="assistant-hitl-dialog" role="dialog" aria-modal="true" aria-label={awaiting.title}>
      <DialogHeader
        eyebrow="需要补充"
        title={awaiting.title}
        description={awaiting.description}
        timeoutLabel={timeoutLabel}
        side={<Pager index={activeIndex} length={questions.length} onChange={(next) => setActiveIndex(clampIndex(next, questions.length))} disabled={submitting} />}
      />
      {currentQuestion ? (
        <QuestionPanel
          question={currentQuestion}
          value={values[currentQuestion.id]}
          freeTextValue={freeTextValues[currentQuestion.id] || ""}
          disabled={submitting}
          onChange={(nextValue) => {
            setValues((current) => ({ ...current, [currentQuestion.id]: nextValue }));
          }}
          onFreeTextChange={(nextValue) => {
            setFreeTextValues((current) => ({ ...current, [currentQuestion.id]: nextValue }));
          }}
          onSubmit={moveForward}
        />
      ) : null}
      <FooterActions
        submitting={submitting}
        canSubmit={canMoveForward}
        submitLabel="提交"
        showContinue={activeIndex < questions.length - 1}
        onIgnore={() => void onSubmit({ action: "dismiss", params: [] })}
        onContinue={moveForward}
        onSubmit={moveForward}
      />
    </section>
  );
}

function QuestionPanel({
  question,
  value,
  freeTextValue,
  disabled,
  onChange,
  onFreeTextChange,
  onSubmit
}: {
  question: AssistantAwaitingQuestion;
  value: AssistantAwaitingAnswerValue;
  freeTextValue: string;
  disabled: boolean;
  onChange: (value: AssistantAwaitingAnswerValue) => void;
  onFreeTextChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const heading = getAwaitingQuestionHeading(question);
  const prompt = getAwaitingQuestionPrompt(question);
  const placeholder = getAwaitingQuestionPlaceholder(question);

  if (question.type === "select" || question.type === "multi-select") {
    const selectedValues = Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [];
    const multi = question.type === "multi-select";
    return (
      <div className="assistant-hitl-question">
        <QuestionTitle heading={heading} prompt={prompt} />
        <div className="assistant-hitl-option-list">
          {(question.options ?? []).map((option, index) => {
            const optionValue = getAwaitingOptionValue(option);
            const selected = selectedValues.includes(optionValue);
            return (
              <button
                type="button"
                className={`assistant-hitl-option ${selected ? "is-selected" : ""}`}
                key={`${question.id}:${optionValue}`}
                disabled={disabled}
                onClick={() => {
                  if (multi) {
                    onChange(selected ? selectedValues.filter((item) => item !== optionValue) : [...selectedValues, optionValue]);
                    return;
                  }
                  onChange(optionValue);
                }}
              >
                <span className="assistant-hitl-option-index">{index + 1}.</span>
                <span className="assistant-hitl-option-text">
                  <strong>{option.label}</strong>
                  {option.description ? <small>{option.description}</small> : null}
                </span>
                <span className="assistant-hitl-selected-badge">已选</span>
              </button>
            );
          })}
        </div>
        {question.allowFreeText ? (
          <label className="assistant-hitl-free-text">
            <span>{(question.options?.length ?? 0) + 1}.</span>
            <input
              type="text"
              value={freeTextValue}
              placeholder={question.freeTextPlaceholder || placeholder}
              disabled={disabled}
              onChange={(event) => onFreeTextChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && event.currentTarget.value.trim()) {
                  onSubmit();
                }
              }}
            />
          </label>
        ) : null}
      </div>
    );
  }

  return (
    <div className="assistant-hitl-question">
      <QuestionTitle heading={heading} prompt={prompt} />
      <input
        className="assistant-hitl-input"
        type={question.type === "password" ? "password" : question.type === "number" ? "number" : "text"}
        value={typeof value === "string" || typeof value === "number" ? value : ""}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => {
          if (question.type === "number") {
            const nextValue = event.target.value;
            onChange(nextValue.trim() ? Number(nextValue) : undefined);
            return;
          }
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && String(event.currentTarget.value).trim()) {
            onSubmit();
          }
        }}
      />
    </div>
  );
}

function QuestionTitle({ heading, prompt }: { heading: string; prompt: string }) {
  return (
    <div className="assistant-hitl-question-title">
      <strong>{heading}</strong>
      {prompt ? <p>{prompt}</p> : null}
    </div>
  );
}

function ApprovalAwaitingDialog({ awaiting, submitting, timeoutLabel, onSubmit }: AwaitingDialogBodyProps) {
  const approvals = useMemo(() => getAwaitingApprovals(awaiting), [awaiting]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, string | undefined>>({});
  const [reasons, setReasons] = useState<Record<string, string | undefined>>({});
  const currentApproval = approvals[activeIndex];
  const currentDecision = currentApproval ? decisions[currentApproval.id] : undefined;
  const ready = approvals.length > 0;
  const canSubmit = ready && approvals.every((approval) => Boolean(decisions[approval.id]));

  useEffect(() => {
    setActiveIndex(0);
    setDecisions({});
    setReasons({});
  }, [awaiting.awaitingId]);

  useEffect(() => {
    setActiveIndex((current) => clampIndex(current, approvals.length));
  }, [approvals.length]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void onSubmit({ action: "dismiss", params: [] });
      }
      if (event.key === "ArrowLeft") {
        setActiveIndex((current) => clampIndex(current - 1, approvals.length));
      }
      if (event.key === "ArrowRight") {
        setActiveIndex((current) => clampIndex(current + 1, approvals.length));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [approvals.length, onSubmit]);

  const submitApproval = useCallback(() => {
    const params = buildApprovalSubmitParams(approvals, decisions, reasons);
    void onSubmit({
      action: hasRejectApprovalDecision(decisions) ? "reject" : "submit",
      params,
      reason: Object.values(reasons).find((reason) => reason?.trim())?.trim()
    });
  }, [approvals, decisions, onSubmit, reasons]);

  const moveForward = useCallback(() => {
    if (!currentDecision) {
      return;
    }
    if (activeIndex >= approvals.length - 1) {
      submitApproval();
      return;
    }
    setActiveIndex((current) => clampIndex(current + 1, approvals.length));
  }, [activeIndex, approvals.length, currentDecision, submitApproval]);

  if (!ready) {
    return <LoadingBlock text="确认项生成中..." />;
  }

  return (
    <section className="assistant-hitl-dialog" role="dialog" aria-modal="true" aria-label={awaiting.title}>
      <DialogHeader
        eyebrow="操作确认"
        title={awaiting.title}
        description={awaiting.description}
        timeoutLabel={timeoutLabel}
        side={<Pager index={activeIndex} length={approvals.length} onChange={(next) => setActiveIndex(clampIndex(next, approvals.length))} disabled={submitting} />}
      />
      {currentApproval ? (
        <ApprovalPanel
          approval={currentApproval}
          decision={decisions[currentApproval.id]}
          reason={reasons[currentApproval.id] || ""}
          disabled={submitting}
          onDecisionChange={(nextDecision) => {
            setDecisions((current) => ({ ...current, [currentApproval.id]: nextDecision }));
          }}
          onReasonChange={(nextReason) => {
            setReasons((current) => ({ ...current, [currentApproval.id]: nextReason }));
          }}
          onSubmit={moveForward}
        />
      ) : null}
      <FooterActions
        submitting={submitting}
        canSubmit={activeIndex < approvals.length - 1 ? Boolean(currentDecision) : canSubmit}
        submitLabel={hasRejectApprovalDecision(decisions) ? "拒绝" : "同意"}
        showContinue={activeIndex < approvals.length - 1}
        onIgnore={() => void onSubmit({ action: "dismiss", params: [] })}
        onContinue={moveForward}
        onSubmit={submitApproval}
      />
    </section>
  );
}

function ApprovalPanel({
  approval,
  decision,
  reason,
  disabled,
  onDecisionChange,
  onReasonChange,
  onSubmit
}: {
  approval: AssistantAwaitingApproval;
  decision?: string;
  reason: string;
  disabled: boolean;
  onDecisionChange: (decision: string | undefined) => void;
  onReasonChange: (reason: string) => void;
  onSubmit: () => void;
}) {
  const options = approval.options?.length ? approval.options : DEFAULT_APPROVAL_OPTIONS;
  return (
    <div className="assistant-hitl-approval">
      <div className="assistant-hitl-approval-copy">
        <span>摘要</span>
        <p>{approval.summary || approval.description || approval.command || "等待确认"}</p>
      </div>
      {approval.command ? (
        <div className="assistant-hitl-approval-command">
          <span>命令</span>
          <pre>{approval.command}</pre>
        </div>
      ) : null}
      {approval.cwd ? (
        <div className="assistant-hitl-approval-copy">
          <span>工作目录</span>
          <p>{approval.cwd}</p>
        </div>
      ) : null}
      {approval.paths && approval.paths.length > 0 ? (
        <div className="assistant-hitl-approval-copy">
          <span>路径</span>
          <ul>
            {approval.paths.slice(0, 12).map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      ) : null}
      {approval.risk ? (
        <div className="assistant-hitl-approval-risk">
          <span>影响</span>
          <p>{approval.risk}</p>
        </div>
      ) : null}
      <div className="assistant-hitl-option-list">
        {options.map((option, index) => {
          const selected = decision === option.decision;
          return (
            <button
              type="button"
              className={`assistant-hitl-option ${selected ? "is-selected" : ""} ${isRejectDecision(option.decision) ? "is-danger" : ""}`}
              key={`${approval.id}:${option.decision}`}
              disabled={disabled}
              onClick={() => onDecisionChange(option.decision)}
              onDoubleClick={onSubmit}
            >
              <span className="assistant-hitl-option-index">{index + 1}.</span>
              <span className="assistant-hitl-option-text">
                <strong>{option.label}</strong>
                {option.description ? <small>{option.description}</small> : null}
              </span>
              <span className="assistant-hitl-selected-badge">已选</span>
            </button>
          );
        })}
      </div>
      {approval.allowFreeText || isRejectDecision(decision) ? (
        <label className="assistant-hitl-free-text">
          <span>理由</span>
          <input
            type="text"
            value={reason}
            placeholder={approval.freeTextPlaceholder || "拒绝时可填写原因"}
            disabled={disabled}
            onChange={(event) => onReasonChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                onSubmit();
              }
            }}
          />
        </label>
      ) : null}
    </div>
  );
}

type CollectFlow =
  | { type: "submit" }
  | { type: "reject"; reason: string }
  | { type: "switch"; nextIndex: number };

function FormAwaitingDialog({ awaiting, submitting, timeoutLabel, onSubmit }: AwaitingDialogBodyProps) {
  const initialForms = useMemo(() => {
    const forms = getAwaitingForms(awaiting);
    return forms.length > 0 ? forms : [{ id: "form", title: awaiting.title, form: null }];
  }, [awaiting]);
  const [forms, setForms] = useState<AssistantAwaitingForm[]>(initialForms);
  const [activeIndex, setActiveIndex] = useState(0);
  const [rejectReason, setRejectReason] = useState("");
  const [submitStatus, setSubmitStatus] = useState("");
  const [submitError, setSubmitError] = useState("");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const collectFlowRef = useRef<CollectFlow | null>(null);
  const collectTimeoutRef = useRef<number | null>(null);
  const currentForm = forms[activeIndex];

  useEffect(() => {
    setForms(initialForms);
    setActiveIndex(0);
    setRejectReason("");
    setSubmitStatus("");
    setSubmitError("");
    collectFlowRef.current = null;
    if (collectTimeoutRef.current) {
      window.clearTimeout(collectTimeoutRef.current);
      collectTimeoutRef.current = null;
    }
  }, [awaiting.awaitingId, initialForms]);

  useEffect(() => {
    setActiveIndex((current) => clampIndex(current, forms.length));
  }, [forms.length]);

  const postFrameMessage = useCallback((type: "awaiting_init" | "awaiting_update") => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow) {
      return;
    }
    frameWindow.postMessage(buildAwaitingFrameMessage(type, awaiting, forms, activeIndex), "*");
  }, [activeIndex, awaiting, forms]);

  const resizeFrame = useCallback(() => {
    const frame = iframeRef.current;
    if (!frame) {
      return;
    }
    try {
      const doc = frame.contentDocument || frame.contentWindow?.document;
      if (doc?.body) {
        frame.style.height = `${Math.max(doc.body.scrollHeight, 180)}px`;
      }
    } catch {
      frame.style.height = "320px";
    }
  }, []);

  useEffect(() => {
    if (awaiting.viewportHtml) {
      postFrameMessage("awaiting_update");
    }
  }, [awaiting.viewportHtml, postFrameMessage]);

  const clearCollectTimeout = useCallback(() => {
    if (collectTimeoutRef.current) {
      window.clearTimeout(collectTimeoutRef.current);
      collectTimeoutRef.current = null;
    }
  }, []);

  const submitForms = useCallback(async (action: AssistantAwaitingDecision, params: unknown[], reason = "") => {
    setSubmitStatus(action === "dismiss" ? "取消中..." : "提交中...");
    setSubmitError("");
    const ok = await onSubmit({ action, params, reason });
    if (!ok) {
      setSubmitStatus("");
    }
  }, [onSubmit]);

  const requestCollect = useCallback((decision: "submit" | "reject", flow: CollectFlow) => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow || !awaiting.viewportHtml) {
      if (flow.type === "switch") {
        setActiveIndex(clampIndex(flow.nextIndex, forms.length));
        return;
      }
      if (flow.type === "reject") {
        void submitForms("reject", buildFormRejectParams(forms, flow.reason), flow.reason);
        return;
      }
      void submitForms("submit", buildFormSubmitParams(forms));
      return;
    }
    collectFlowRef.current = flow;
    clearCollectTimeout();
    setSubmitStatus("采集中...");
    setSubmitError("");
    frameWindow.postMessage(buildAwaitingCollectMessage(awaiting, decision), "*");
    collectTimeoutRef.current = window.setTimeout(() => {
      collectFlowRef.current = null;
      setSubmitStatus("");
      setSubmitError("表单没有响应采集请求");
    }, COLLECT_TIMEOUT_MS);
  }, [awaiting, clearCollectTimeout, forms, submitForms]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      if (event.data && typeof event.data === "object" && (event.data.type === "close" || event.data.type === "done")) {
        clearCollectTimeout();
        collectFlowRef.current = null;
        void submitForms("dismiss", buildFormCancelParams(forms));
        return;
      }
      const params = readAwaitingFrameSubmitParams(event.data, awaiting);
      if (!params) {
        setSubmitError("表单提交数据无效");
        return;
      }
      clearCollectTimeout();
      const flow = collectFlowRef.current;
      collectFlowRef.current = null;
      const nextForms = mergeSubmittedParamsIntoForms(forms, params);
      setForms(nextForms);
      if (flow?.type === "switch") {
        setActiveIndex(clampIndex(flow.nextIndex, nextForms.length));
        setSubmitStatus("");
        setSubmitError("");
        return;
      }
      if (flow?.type === "reject") {
        void submitForms("reject", buildFormRejectParams(nextForms, flow.reason), flow.reason);
        return;
      }
      void submitForms("submit", buildFormSubmitParams(nextForms));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [awaiting, clearCollectTimeout, forms, submitForms]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void submitForms("dismiss", buildFormCancelParams(forms));
      }
      if (event.key === "ArrowLeft") {
        requestCollect("submit", { type: "switch", nextIndex: activeIndex - 1 });
      }
      if (event.key === "ArrowRight") {
        requestCollect("submit", { type: "switch", nextIndex: activeIndex + 1 });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, forms, requestCollect, submitForms]);

  const switchDisabled = submitting || Boolean(submitStatus);

  return (
    <section className="assistant-hitl-dialog assistant-hitl-form-dialog" role="dialog" aria-modal="true" aria-label={awaiting.title}>
      <DialogHeader
        eyebrow="业务确认"
        title={currentForm?.title || currentForm?.action || awaiting.title}
        description={awaiting.description}
        timeoutLabel={timeoutLabel}
        side={<Pager index={activeIndex} length={forms.length} onChange={(next) => requestCollect("submit", { type: "switch", nextIndex: next })} disabled={switchDisabled} />}
      />
      {awaiting.loading ? <div className="assistant-hitl-status">加载表单中...</div> : null}
      {awaiting.loadError ? <div className="assistant-hitl-error">{awaiting.loadError}</div> : null}
      {!awaiting.loading && !awaiting.loadError && !awaiting.viewportHtml ? (
        <div className="assistant-hitl-empty">等待业务确认表单加载...</div>
      ) : null}
      {awaiting.viewportHtml ? (
        <iframe
          ref={iframeRef}
          className="assistant-hitl-frame"
          srcDoc={awaiting.viewportHtml}
          sandbox="allow-scripts allow-popups allow-same-origin"
          title={`awaiting-${awaiting.viewportKey || awaiting.awaitingId}`}
          onLoad={() => {
            resizeFrame();
            postFrameMessage("awaiting_init");
          }}
        />
      ) : null}
      <div className="assistant-hitl-form-actions">
        <button
          type="button"
          className="assistant-hitl-submit-line"
          disabled={switchDisabled || (!awaiting.viewportHtml && awaiting.loading)}
          onClick={() => requestCollect("submit", { type: "submit" })}
        >
          <span className="assistant-hitl-submit-icon">→</span>
          <span>同意</span>
          <small>可以修改表单内容并提交</small>
        </button>
        <label className="assistant-hitl-reject-line">
          <button
            type="button"
            disabled={switchDisabled}
            onClick={() => requestCollect("reject", { type: "reject", reason: rejectReason.trim() })}
          >
            × 驳回
          </button>
          <input
            type="text"
            disabled={switchDisabled}
            value={rejectReason}
            placeholder="请输入驳回理由，可以修改表单内容"
            onChange={(event) => setRejectReason(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                requestCollect("reject", { type: "reject", reason: rejectReason.trim() });
              }
            }}
          />
        </label>
      </div>
      {submitStatus ? <div className="assistant-hitl-status">{submitStatus}</div> : null}
      {submitError ? <div className="assistant-hitl-error">{submitError}</div> : null}
      <div className="assistant-hitl-footer">
        <button
          type="button"
          className="assistant-hitl-link-button"
          onClick={() => void submitForms("dismiss", buildFormCancelParams(forms))}
          disabled={submitting || Boolean(submitStatus)}
        >
          <span>忽略</span>
          <kbd>ESC</kbd>
        </button>
      </div>
    </section>
  );
}
