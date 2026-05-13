import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildAwaitingCollectMessage,
  buildAwaitingFrameMessage,
  buildQuestionSubmitParams,
  getAwaitingApprovals,
  mergeSubmittedParamsIntoForms,
  readAwaitingFrameSubmitParams
} = require("../dist-electron/shared/assistant-awaiting.js");

test("assistant awaiting normalizes legacy single approval to approval list", () => {
  const approvals = getAwaitingApprovals({
    awaitingId: "await_1",
    mode: "approval",
    title: "确认执行",
    runId: "run_1",
    chatId: "chat_1",
    approval: {
      summary: "执行命令",
      command: "npm test",
      risk: "会运行本地命令"
    }
  });

  assert.deepEqual(approvals, [
    {
      id: "approval",
      command: "npm test",
      description: "执行命令",
      summary: "执行命令",
      risk: "会运行本地命令",
      cwd: undefined,
      paths: undefined,
      options: undefined,
      allowFreeText: undefined,
      freeTextPlaceholder: undefined
    }
  ]);
});

test("assistant awaiting builds question params with multi select and free text answers", () => {
  const params = buildQuestionSubmitParams(
    {
      awaitingId: "await_1",
      mode: "question",
      title: "补充信息",
      runId: "run_1",
      chatId: "chat_1",
      questions: [
        { id: "env", label: "环境", type: "multi-select" },
        { id: "reason", label: "原因", type: "text" }
      ]
    },
    {
      env: ["dev", "custom"],
      reason: "排查问题"
    }
  );

  assert.deepEqual(params, [
    { id: "env", answers: ["dev", "custom"] },
    { id: "reason", answer: "排查问题" }
  ]);
});

test("assistant awaiting builds and reads iframe collect protocol", () => {
  const awaiting = {
    awaitingId: "await_1",
    mode: "form",
    title: "请假申请",
    runId: "run_1",
    chatId: "chat_1",
    viewportKey: "leave_form"
  };
  const forms = [
    { id: "leave", title: "请假申请", form: { days: 1 } }
  ];

  assert.deepEqual(buildAwaitingCollectMessage(awaiting, "submit"), {
    type: "awaiting_collect",
    data: {
      runId: "run_1",
      awaitingId: "await_1",
      decision: "submit"
    }
  });
  assert.equal(buildAwaitingFrameMessage("awaiting_init", awaiting, forms, 0).data.activeFormId, "leave");

  const params = readAwaitingFrameSubmitParams({
    type: "frontend_awaiting_submit",
    awaitingId: "await_1",
    params: [
      { id: "leave", decision: "submit", form: { days: 2 } }
    ]
  }, awaiting);

  assert.deepEqual(params, [
    { id: "leave", decision: "submit", form: { days: 2 } }
  ]);
  assert.deepEqual(mergeSubmittedParamsIntoForms(forms, params), [
    { id: "leave", title: "请假申请", form: { days: 2 } }
  ]);
});
