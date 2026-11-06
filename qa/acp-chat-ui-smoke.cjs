// Full, unmodified WebClient bundle against the real installed Codex/App server.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow, session } = require('electron');
app.setPath('userData', process.env.ACP_UI_PROFILE);
app.whenReady().then(async () => {
  const base = process.env.ACP_UI_BASE;
  const chatId = process.env.ACP_UI_CHAT;
  const output = process.env.ACP_UI_OUTPUT;
  const window = new BrowserWindow({ width: 1380, height: 960, show: true, webPreferences: { sandbox: true, backgroundThrottling: false } });
  const js = source => window.webContents.executeJavaScript(source);
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  async function chat() {
    const response = await fetch(base + '/api/chat?chatId=' + chatId + '&detail=full', { headers: { Authorization: `Bearer ${process.env.ACP_UI_TOKEN}` } });
    assert.ok(response.ok);
    return (await response.json()).data;
  }
  function toolResults(detail) {
    // Replay associates results by toolId; runId belongs to tool.snapshot.
    const ids = new Set(detail.events.filter(event => event.runId === currentRun && event.type === 'tool.snapshot').map(event => event.toolId));
    return detail.events.filter(event => event.type === 'tool.result' && ids.has(event.toolId));
  }
  async function configure(label, choice) {
    const selector = `[aria-label="${label}"]`;
    await wait(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`);
    const point = await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await wait(`Array.from(document.querySelectorAll('.ant-select-item-option')).some(o=>o.textContent===${JSON.stringify(choice)})`);
    await js(`Array.from(document.querySelectorAll('.ant-select-item-option')).find(o=>o.textContent===${JSON.stringify(choice)}).click()`);
    await wait(`document.querySelector(${JSON.stringify(selector)}).closest('.ant-select').textContent.includes(${JSON.stringify(choice)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`);
  }
  async function wait(condition, timeout = 120000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js(condition)) return;
      await pause();
    }
    fs.writeFileSync(path.join(output, 'chat-failure.png'), (await window.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(output, 'chat-failure.html'), await js('document.documentElement.outerHTML'));
    throw new Error(`Chat UI timed out: ${condition}; ${(await js('document.body.innerText')).slice(-2500)}`);
  }
  let currentRun;
  async function finish(expected = 'run.complete') {
    const end = Date.now() + 120000;
    while (Date.now() < end) {
      const detail = await chat();
      const terminal = detail.events.find(event => event.runId === currentRun && ['run.complete', 'run.cancel', 'run.error'].includes(event.type));
      if (terminal) {
        assert.equal(terminal.type, expected, JSON.stringify(terminal));
        return detail;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`Run ${currentRun} did not finish`);
  }
  async function send(message) {
    await wait('document.querySelector("textarea") && !document.querySelector("textarea").disabled');
    await js(`(()=>{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(message)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await wait('document.querySelector("button[aria-label=Send]") && !document.querySelector("button[aria-label=Send]").disabled');
    await js('document.querySelector("button[aria-label=Send]").click()');
    await wait('document.querySelector("#interrupt-btn")');
    currentRun = (await chat()).events.filter(event => event.type === 'run.start').at(-1).runId;
  }
  await session.defaultSession.cookies.set({ url: base, name: 'access_token', value: process.env.ACP_UI_TOKEN, httpOnly: true });
  await window.loadURL(base + '/runtime-config.js');
  await js(`localStorage.setItem('agent-webclient.accessToken',${JSON.stringify(process.env.ACP_UI_TOKEN)});localStorage.setItem('agent-webclient.locale','en-US')`);
  await window.loadURL(`${base}/agent/${encodeURIComponent(process.env.ACP_UI_AGENT)}?chatId=${chatId}`);
  await wait('document.querySelector("textarea")');
  await send('Reply exactly CHAT_UI_READY. Do not use tools.');
  await finish();
  await wait('document.body.innerText.includes("CHAT_UI_READY") && document.querySelector("button[aria-label=Send]")');
  fs.writeFileSync(path.join(output, 'chat-ready.png'), (await window.webContents.capturePage()).toPNG());
  console.log('PASS full WebClient route → Composer send → real Codex response');
  await configure('Mode', 'Read-only');
  const target = path.join(process.env.ACP_UI_WORKSPACE, 'approval-allowed.txt');
  await send(`Invoke the apply_patch tool now to create only ${target} containing exactly APPROVED on its own line. This tests the automatic tool approval dialog; do not ask for permission in chat text. Do not run shell commands, retry, or change other files. After approval reply FILE_APPROVED.`);
  const permission = '.hitl-dialog-surface:has(input[type="radio"][value="approve"])';
  await wait(`document.querySelector(${JSON.stringify(permission)})`);
  const pending = await chat();
  fs.writeFileSync(path.join(output, 'approval-events.json'), JSON.stringify({ awaiting: pending.awaiting, events: pending.events }, null, 2));
  assert.equal(fs.existsSync(target), false, 'read-only mode must not write before approval');
  assert.ok(await js(`document.querySelector(${JSON.stringify(permission)}).innerText.includes('approval-allowed.txt')`), 'approval must identify the target');
  await window.loadURL(window.webContents.getURL());
  await wait(`document.querySelector(${JSON.stringify(permission)})`);
  assert.equal((await chat()).awaiting.awaitingId, pending.awaiting.awaitingId, 'refresh must retain the same pending decision');
  assert.equal(fs.existsSync(target), false);
  fs.writeFileSync(path.join(output, 'file-approval.png'), (await window.webContents.capturePage()).toPNG());
  await js(`document.querySelector(${JSON.stringify(permission)}).querySelector('input[value="approve"]').closest('label').click()`);
  await finish();
  await wait("!document.querySelector('#interrupt-btn') && document.querySelector('button[aria-label=Send]')");
  assert.equal(fs.readFileSync(target, 'utf8'), 'APPROVED\n');
  const approved = await chat();
  assert.ok(toolResults(approved).some(event => event.toolName === 'acp/edit'));
  const approvedText = approved.events.filter(event => event.runId === currentRun && event.type === 'content.snapshot').at(-1).text;
  await wait(`document.body.innerText.includes(${JSON.stringify(approvedText)})`);
  console.log('PASS read-only → file approval UI → exact allow option → verified file write');
  const rejected = path.join(process.env.ACP_UI_WORKSPACE, 'approval-rejected.txt');
  await send(`Invoke the apply_patch tool now to create only ${rejected} containing REJECTED. This is a new independent approval test. Do not ask for permission in chat text; invoking the tool must trigger its approval dialog. If denied, stop immediately, do not retry or use another tool, and reply FILE_DENIED.`);
  await wait(`Array.from(document.querySelectorAll(${JSON.stringify(permission)})).some(card=>card.innerText.includes('approval-rejected.txt') && Array.from(card.querySelectorAll('input[type="radio"]')).some(b=>!b.disabled))`);
  assert.equal(fs.existsSync(rejected), false, 'a previous approval must not authorize a later turn');
  await js(`Array.from(document.querySelectorAll(${JSON.stringify(permission)})).find(card=>card.innerText.includes('approval-rejected.txt')).querySelector('input[value="reject"]').closest('label').click()`);
  await finish('run.cancel');
  await wait("!document.querySelector('#interrupt-btn') && document.querySelector('button[aria-label=Send]')");
  assert.equal(fs.existsSync(rejected), false, 'rejected file must remain absent');
  await send(`Invoke the apply_patch tool now to change only ${target} from APPROVED to CHANGED. Do not ask in prose; this tests the automatic tool approval dialog. If denied, stop immediately without retrying or using another tool.`);
  await wait(`Array.from(document.querySelectorAll(${JSON.stringify(permission)})).some(card=>card.innerText.includes('approval-allowed.txt') && Array.from(card.querySelectorAll('input[type="radio"]')).some(b=>!b.disabled)) || (!document.querySelector('#interrupt-btn') && document.querySelector('button[aria-label=Send]'))`);
  assert.equal(fs.readFileSync(target, 'utf8'), 'APPROVED\n', 'same-file follow-up must not write before a fresh decision');
  await js(`Array.from(document.querySelectorAll(${JSON.stringify(permission)})).find(card=>card.innerText.includes('approval-allowed.txt') && Array.from(card.querySelectorAll('input[type="radio"]')).some(b=>!b.disabled)).querySelector('input[value="reject"]').closest('label').click()`);
  await finish('run.cancel');
  assert.equal(fs.readFileSync(target, 'utf8'), 'APPROVED\n');
  const history = await chat();
  await window.loadURL(window.webContents.getURL());
  await wait(`document.body.innerText.includes(${JSON.stringify(approvedText)}) && document.querySelector('textarea')`);
  assert.ok(await js(`Array.from(document.querySelectorAll(${JSON.stringify(permission)})).every(card=>Array.from(card.querySelectorAll('input[type="radio"]')).every(b=>b.disabled))`), 'historical decisions must not be resubmitted');
  assert.equal((await chat()).events.filter(e=>e.type==='run.start').length, 4, 'reload must not restart a completed run');
  assert.deepEqual(history.events.filter(event => event.type === 'awaiting.answer' && event.mode === 'approval').map(event => event.approvals?.[0]?.decision), ['approve', 'reject', 'reject']);
  assert.equal(await js("document.body.innerText.includes('Submitted 0 answers')"), false, 'permission history must retain the decision');
  fs.writeFileSync(path.join(output, 'chat-history.png'), (await window.webContents.capturePage()).toPNG());
  console.log('PASS pending refresh → approve; different/same-file next-turn reject → no write; history replay → read-only/no duplicate run');
  await configure('Mode', 'Workspace access');
  const workspace = process.env.ACP_UI_WORKSPACE;
  const outside = process.env.ACP_UI_OUTSIDE;
  const link = path.join(workspace, 'outside-link');
  fs.symlinkSync(outside, link, 'dir');
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const command = `printf 'INSIDE\\n' > ${quote(path.join(workspace, 'sandbox-inside.txt'))}; if printf 'OUTSIDE\\n' > ${quote(path.join(outside, 'direct.txt'))}; then printf 'DIRECT_UNEXPECTED\\n'; else printf 'DIRECT_DENIED\\n'; fi; if printf 'SYMLINK\\n' > ${quote(path.join(link, 'indirect.txt'))}; then printf 'SYMLINK_UNEXPECTED\\n'; else printf 'SYMLINK_DENIED\\n'; fi`;
  await send(`Sandbox regression using only disposable test files. Execute this exact shell command once with sandbox_permissions=use_default. The outside writes are expected to be denied by the OS; do not request escalation, retry, or use any other tool. Report the actual output. Command: ${command}`);
  const sandbox = await finish();
  const results = toolResults(sandbox);
  fs.writeFileSync(path.join(output, 'sandbox-events.json'), JSON.stringify(results, null, 2));
  assert.equal(fs.readFileSync(path.join(workspace, 'sandbox-inside.txt'), 'utf8'), 'INSIDE\n');
  assert.equal(fs.existsSync(path.join(outside, 'direct.txt')), false);
  assert.equal(fs.existsSync(path.join(outside, 'indirect.txt')), false);
  const outputs = results.map(event => {
    const result = typeof event.result === 'string' ? JSON.parse(event.result) : event.result;
    return JSON.stringify({ content: result.content, output: result.output });
  }).join('\n');
  assert.match(outputs, /operation not permitted|permission denied/i);
  assert.match(outputs, /DIRECT_DENIED/);
  assert.match(outputs, /SYMLINK_DENIED/);
  assert.equal(sandbox.events.filter(event => event.runId === currentRun && event.type === 'awaiting.ask').length, 0, 'no permission grant may weaken this sandbox probe');
  fs.writeFileSync(path.join(output, 'sandbox.png'), (await window.webContents.capturePage()).toPNG());
  console.log('PASS workspace write → real OS denies direct outside and symlink writes without escalation');
  await configure('Collaboration mode', 'Plan');
  await send('Use request_user_input to ask exactly one single-choice question Choose probe result, with options OK and SKIP. Do not use other tools or access files. After the answer reply DONE.');
  await wait(`document.querySelector('.composer-awaiting-shell [data-index="0"]')`);
  const question = await chat();
  assert.equal(question.awaiting.mode, 'question');
  fs.writeFileSync(path.join(output, 'question.png'), (await window.webContents.capturePage()).toPNG());
  await js(`document.querySelector('.composer-awaiting-shell [data-index="0"]').click()`);
  await wait(`Array.from(document.querySelectorAll('.composer-awaiting-shell button')).some(b=>b.textContent.includes('Submit') && !b.disabled)`);
  await js(`Array.from(document.querySelectorAll('.composer-awaiting-shell button')).find(b=>b.textContent.includes('Submit')).click()`);
  await finish();
  console.log('PASS real Codex question → full chat form selection and Submit → run.complete');
  await send('Explain how a hash table works in detail. Do not use tools.');
  await js("document.querySelector('#interrupt-btn').click()");
  await finish('run.cancel');
  await wait("document.querySelector('button[aria-label=Send]') && !document.querySelector('button[aria-label=Send]').disabled && !document.querySelector('#interrupt-btn')");
  fs.writeFileSync(path.join(output, 'chat-events.json'), JSON.stringify((await chat()).events, null, 2));
  fs.writeFileSync(path.join(output, 'chat-complete.png'), (await window.webContents.capturePage()).toPNG());
  console.log('PASS full chat Stop → interrupt → run.cancel → usable Composer');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
