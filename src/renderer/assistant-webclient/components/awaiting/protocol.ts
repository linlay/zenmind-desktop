import type {
  ActiveAwaiting,
  AIAwaitSubmitParamData,
  AIAwaitSubmitPayloadData,
} from '../../context/types';
import {
  AIAwaitQuestionType,
  ViewportTypeEnum,
} from '../../context/types';

export type AwaitingRenderMode = 'none' | 'builtin' | 'html';

export interface AwaitingViewportData {
  runId: string;
  awaitingId: string;
  viewportKey: string;
  viewportType: ActiveAwaiting['viewportType'];
  timeout: number | null;
  questions: ActiveAwaiting['questions'];
}

export interface AwaitingViewportMessage {
  type: 'awaiting_init' | 'awaiting_update';
  data: AwaitingViewportData;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function getAwaitingRenderMode(
  awaiting: ActiveAwaiting | null,
): AwaitingRenderMode {
  if (!awaiting) {
    return 'none';
  }

  if (
    awaiting.viewportType === ViewportTypeEnum.Html
    && awaiting.viewportKey.trim()
  ) {
    return 'html';
  }

  if (awaiting.viewportType === ViewportTypeEnum.Builtin) {
    return 'builtin';
  }

  return 'none';
}

export function buildAwaitingViewportData(
  awaiting: ActiveAwaiting,
): AwaitingViewportData {
  return {
    runId: awaiting.runId,
    awaitingId: awaiting.awaitingId,
    viewportKey: awaiting.viewportKey,
    viewportType: awaiting.viewportType,
    timeout: awaiting.timeout,
    questions: awaiting.questions,
  };
}

export function buildAwaitingViewportSignature(
  awaiting: ActiveAwaiting,
): string {
  return JSON.stringify(buildAwaitingViewportData(awaiting));
}

export function buildAwaitingInitMessage(
  awaiting: ActiveAwaiting,
): AwaitingViewportMessage {
  return {
    type: 'awaiting_init',
    data: buildAwaitingViewportData(awaiting),
  };
}

export function buildAwaitingUpdateMessage(
  awaiting: ActiveAwaiting,
): AwaitingViewportMessage {
  return {
    type: 'awaiting_update',
    data: buildAwaitingViewportData(awaiting),
  };
}

export function normalizeAwaitingSubmitParams(
  value: unknown,
): AIAwaitSubmitParamData[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is Record<string, unknown> => isObjectRecord(item))
    .map((item) => {
      const question = String(item.question || '').trim();
      const header = String(item.header || '').trim();
      const answerValue = item.answer;
      const answersValue = item.answers;
      const valueField = item.value;
      const normalized: AIAwaitSubmitParamData = {
        question,
      };

      if (header) {
        normalized.header = header;
      }
      if (typeof answerValue === 'string' || typeof answerValue === 'number') {
        normalized.answer = answerValue;
      }
      if (Array.isArray(answersValue)) {
        normalized.answers = answersValue
          .map((entry) => String(entry || '').trim())
          .filter(Boolean);
      }
      if (typeof valueField === 'string' && valueField.trim()) {
        normalized.value = valueField.trim();
      }

      return normalized;
    })
    .filter((item) => Boolean(item.question));
}

function readNamedValue(
  source: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (!key) {
      continue;
    }
    if (key in source) {
      return source[key];
    }
    const lowerKey = key.toLowerCase();
    if (lowerKey in source) {
      return source[lowerKey];
    }
  }
  return undefined;
}

function buildAwaitingSubmitParam(
  awaiting: ActiveAwaiting,
  questionIndex: number,
  rawValue: unknown,
): AIAwaitSubmitParamData | null {
  const question = awaiting.questions[questionIndex];
  if (!question) {
    return null;
  }

  const normalized: AIAwaitSubmitParamData = {
    question: question.question,
  };

  if (question.header?.trim()) {
    normalized.header = question.header.trim();
  }

  if (typeof rawValue === 'string') {
    const text = rawValue.trim();
    if (!text) {
      return null;
    }
    normalized.answer = text;
    if (question.type === AIAwaitQuestionType.Select) {
      normalized.value = text;
    }
    return normalized;
  }

  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    normalized.answer = rawValue;
    return normalized;
  }

  if (Array.isArray(rawValue)) {
    const answers = rawValue
      .map((entry) => String(entry ?? '').trim())
      .filter(Boolean);
    if (answers.length === 0) {
      return null;
    }
    normalized.answers = answers;
    return normalized;
  }

  if (!isObjectRecord(rawValue)) {
    return null;
  }

  const inlineParams = normalizeAwaitingSubmitParams([
    {
      question: normalized.question,
      header: normalized.header,
      answer: rawValue.answer,
      answers: rawValue.answers,
      value: rawValue.value,
    },
  ]);

  return inlineParams[0] ?? null;
}

function normalizeAwaitingObjectSubmitParams(
  source: Record<string, unknown>,
  awaiting: ActiveAwaiting,
): AIAwaitSubmitParamData[] {
  const directMatches = awaiting.questions
    .map((question, index) => {
      const rawValue = readNamedValue(source, [
        question.question,
        question.header || '',
        `q${index + 1}`,
        `question${index + 1}`,
        `field${index + 1}`,
      ]);
      return rawValue === undefined
        ? null
        : buildAwaitingSubmitParam(awaiting, index, rawValue);
    })
    .filter((item): item is AIAwaitSubmitParamData => Boolean(item));

  if (directMatches.length > 0) {
    return directMatches;
  }

  const params: AIAwaitSubmitParamData[] = [];
  const firstQuestion = awaiting.questions[0];
  const secondQuestion = awaiting.questions[1];
  const fallbackTextQuestionIndex = awaiting.questions.findIndex(
    (question, index) =>
      index > 0 && question.type !== AIAwaitQuestionType.Select,
  );

  const decisionValue = readNamedValue(source, ['decision', 'answer', 'value']);
  if (decisionValue !== undefined && firstQuestion) {
    const firstParam = buildAwaitingSubmitParam(awaiting, 0, decisionValue);
    if (firstParam) {
      params.push(firstParam);
    }
  }

  const noteValue = readNamedValue(source, [
    'text',
    'comment',
    'message',
    'reason',
  ]);
  if (noteValue !== undefined) {
    const noteTargetIndex =
      fallbackTextQuestionIndex >= 0
        ? fallbackTextQuestionIndex
        : secondQuestion
          ? 1
          : params.length === 0 && firstQuestion
            ? 0
            : -1;
    if (noteTargetIndex >= 0) {
      const noteParam = buildAwaitingSubmitParam(
        awaiting,
        noteTargetIndex,
        noteValue,
      );
      if (
        noteParam
        && !params.some((item) => item.question === noteParam.question)
      ) {
        params.push(noteParam);
      }
    }
  }

  if (params.length > 0 || awaiting.questions.length !== 1) {
    return params;
  }

  const singleFallbackValue = readNamedValue(source, [
    'text',
    'comment',
    'message',
    'reason',
    'answer',
    'value',
    'decision',
  ]);

  const singleParam = buildAwaitingSubmitParam(
    awaiting,
    0,
    singleFallbackValue,
  );
  return singleParam ? [singleParam] : [];
}

export function readAwaitingSubmitPayload(
  value: unknown,
  awaiting: ActiveAwaiting,
): AIAwaitSubmitPayloadData | null {
  if (
    !isObjectRecord(value)
    || (
      value.type !== 'frontend_awaiting_submit'
      && value.type !== 'frontend_submit'
    )
  ) {
    return null;
  }

  const params = Array.isArray(value.params)
    ? normalizeAwaitingSubmitParams(value.params)
    : isObjectRecord(value.params)
      ? normalizeAwaitingObjectSubmitParams(value.params, awaiting)
      : isObjectRecord(value.answer)
        ? normalizeAwaitingObjectSubmitParams(value.answer, awaiting)
        : [];
  return {
    runId: awaiting.runId,
    awaitingId: awaiting.awaitingId,
    params,
  };
}

export function isAwaitingFrameCloseMessage(value: unknown): boolean {
  return isObjectRecord(value)
    && (value.type === 'close' || value.type === 'done');
}
