import {
  AIAwaitQuestionType,
  ViewportTypeEnum,
} from '../../context/types';
import type { ActiveAwaiting } from '../../context/types';
import {
  buildAwaitingInitMessage,
  buildAwaitingUpdateMessage,
  getAwaitingRenderMode,
  isAwaitingFrameCloseMessage,
  normalizeAwaitingSubmitParams,
  readAwaitingSubmitPayload,
} from './protocol';

function createActiveAwaiting(
  patch: Partial<ActiveAwaiting> = {},
): ActiveAwaiting {
  return {
    key: 'run_1#await_1',
    awaitingId: 'await_1',
    runId: 'run_1',
    timeout: 60,
    viewportKey: 'confirm_dialog',
    viewportType: ViewportTypeEnum.Builtin,
    questions: [],
    loading: false,
    loadError: '',
    viewportHtml: '',
    ...patch,
  };
}

describe('awaiting protocol helpers', () => {
  it('selects builtin and html render modes from viewport type', () => {
    expect(getAwaitingRenderMode(null)).toBe('none');
    expect(getAwaitingRenderMode(createActiveAwaiting())).toBe('builtin');
    expect(
      getAwaitingRenderMode(createActiveAwaiting({
        viewportType: ViewportTypeEnum.Html,
        viewportKey: 'leave_form',
      })),
    ).toBe('html');
  });

  it('builds awaiting init and update messages from active awaiting state', () => {
    const awaiting = createActiveAwaiting({
      viewportType: ViewportTypeEnum.Html,
      viewportKey: 'leave_form',
      questions: [
        {
          type: AIAwaitQuestionType.Text,
          question: '请确认请假原因',
        },
      ],
    });

    expect(buildAwaitingInitMessage(awaiting)).toEqual({
      type: 'awaiting_init',
      data: {
        runId: 'run_1',
        awaitingId: 'await_1',
        viewportKey: 'leave_form',
        viewportType: ViewportTypeEnum.Html,
        timeout: 60,
        questions: [
          {
            type: AIAwaitQuestionType.Text,
            question: '请确认请假原因',
          },
        ],
      },
    });
    expect(buildAwaitingUpdateMessage(awaiting).type).toBe('awaiting_update');
  });

  it('normalizes iframe submit params and preserves string/number answers', () => {
    expect(normalizeAwaitingSubmitParams([
      {
        header: '审批意见',
        question: '是否批准？',
        answer: 'approve',
        answers: ['approve', '', 'keep'],
      },
      {
        question: '天数',
        answer: 3,
      },
      {
        answer: 'missing-question',
      },
    ])).toEqual([
      {
        header: '审批意见',
        question: '是否批准？',
        answer: 'approve',
        answers: ['approve', 'keep'],
      },
      {
        question: '天数',
        answer: 3,
      },
    ]);
  });

  it('reads frontend awaiting submit payloads using the active awaiting identifiers', () => {
    const awaiting = createActiveAwaiting({
      viewportType: ViewportTypeEnum.Html,
      viewportKey: 'leave_form',
    });

    expect(readAwaitingSubmitPayload({
      type: 'frontend_awaiting_submit',
      params: [
        {
          question: '是否批准？',
          answer: 'approve',
        },
      ],
    }, awaiting)).toEqual({
      runId: 'run_1',
      awaitingId: 'await_1',
      params: [
        {
          question: '是否批准？',
          answer: 'approve',
        },
      ],
    });
  });

  it('accepts code-assistant frontend_submit payloads with object params', () => {
    const awaiting = createActiveAwaiting({
      viewportType: ViewportTypeEnum.Html,
      viewportKey: 'permission_form',
      questions: [
        {
          type: AIAwaitQuestionType.Select,
          header: '代码助手 权限确认',
          question: '审批结果',
          options: [
            { label: '允许', value: 'allow' },
            { label: '总是允许', value: 'allow_always' },
            { label: '拒绝', value: 'deny' },
          ],
        },
        {
          type: AIAwaitQuestionType.Text,
          header: '补充说明',
          question: '补充说明',
        },
      ],
    });

    expect(readAwaitingSubmitPayload({
      type: 'frontend_submit',
      params: {
        decision: 'allow',
        comment: '继续执行',
      },
    }, awaiting)).toEqual({
      runId: 'run_1',
      awaitingId: 'await_1',
      params: [
        {
          header: '代码助手 权限确认',
          question: '审批结果',
          answer: 'allow',
          value: 'allow',
        },
        {
          header: '补充说明',
          question: '补充说明',
          answer: '继续执行',
        },
      ],
    });
  });

  it('maps answer objects for single-question html awaiting forms', () => {
    const awaiting = createActiveAwaiting({
      viewportType: ViewportTypeEnum.Html,
      viewportKey: 'question_form',
      questions: [
        {
          type: AIAwaitQuestionType.Text,
          question: '请补充说明',
        },
      ],
    });

    expect(readAwaitingSubmitPayload({
      type: 'frontend_submit',
      answer: {
        text: '这里是说明',
      },
    }, awaiting)).toEqual({
      runId: 'run_1',
      awaitingId: 'await_1',
      params: [
        {
          question: '请补充说明',
          answer: '这里是说明',
        },
      ],
    });
  });

  it('treats close and done as iframe close signals', () => {
    expect(isAwaitingFrameCloseMessage({ type: 'close' })).toBe(true);
    expect(isAwaitingFrameCloseMessage({ type: 'done' })).toBe(true);
    expect(isAwaitingFrameCloseMessage({ type: 'noop' })).toBe(false);
  });
});
