// Build main types first. Use Desktop Electron with ELECTRON_RUN_AS_NODE=1.
// ACP_LIVE_AUTH=1 opts into isolated local Codex auth and real model calls.
// ACP_BROWSER_AUTH=1 uses a fresh browser login for repeatable authentication checks.
// ACP_PLATFORM_KILL=1 kills the real host during a question and checks orphan cleanup/recovery.
// ACP_UPGRADE_ARCHIVE=<zip> upgrades during a real question, then checks version/context continuity.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID, generateKeyPairSync, sign } = require('node:crypto');
const { createPluginTestRuntime } = require('../test/helpers/plugin-lifecycle.cjs');
const { createPluginLifecycle } = require('../dist-electron/main/modules/plugins/lifecycle');
const { createAgentEngineSync } = require('../dist-electron/main/modules/plugins/engine-resources');
const { prepareEmbeddedNodeRuntime } = require('../dist-electron/main/modules/services/manager/embedded-node-runtime');
const { getDesktopRoot } = require('../dist-electron/main/infrastructure/filesystem/user-paths');
const { buildProjectAgentCreateRequest } = require('../dist-electron/main/modules/assistant/coder-project');
const registry = require('../dist-electron/main/modules/services/service-registry');
const pause = () => new Promise(resolve => setTimeout(resolve, 100));

(async () => {
  assert.equal(process.platform, 'darwin', 'macOS acceptance; Windows requires a native run');
  const archive = path.resolve(process.argv[2] || '../zenmind-agent-plugins/build/zenmind-agent-codex/0.1.0/darwin-arm64/zenmind-agent-codex-darwin-arm64.zip');
  fs.accessSync(archive);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-product-'));
  fs.chmodSync(root, 0o700);
  const { app, services, webs } = createPluginTestRuntime(root);
  const pluginId = 'zenmind-agent-codex', engineId = `${pluginId}/codex`, chatId = randomUUID();
  const workspace = path.join(root, 'workspace');
  const upgradeArchive = process.env.ACP_UPGRADE_ARCHIVE;
  const lifecycle = process.env.ACP_PLATFORM_KILL === '1' || !!upgradeArchive;
  assert.ok(!(upgradeArchive && process.env.ACP_PLATFORM_KILL === '1'), 'choose one lifecycle scenario');
  const binding = () => JSON.parse(fs.readFileSync(path.join(root,'platform/chats',chatId,'.agent-engine-session.json'),'utf8'));
  let upgrade;
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(root, 'configs'));
  fs.writeFileSync(path.join(root, 'configs/runtime.yml'), 'auth:\n  enabled: true\ncontainer-hub:\n  enabled: false\nautomation:\n  enabled: false\nhttp-proxy:\n  mode: fixed\n  url: http://127.0.0.1:7890\n');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(path.join(root, 'configs/local-public-key.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ sub: 'product-acceptance', deviceId: 'product-acceptance', exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const token = `${claims}.${sign('RSA-SHA256', Buffer.from(claims), privateKey).toString('base64url')}`;
  let base, child, finished, outside, project;
  async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(process.env.ACP_PLATFORM_KILL === '1' ? 300000 : 180000) });
    const result = await response.json();
    assert.equal(response.ok && [0, 200].includes(result.code), true, `${route}: ${JSON.stringify(result)}`);
    return result.data;
  }
  const sync = createAgentEngineSync(app, { getHostId: () => 'product-acceptance', getBaseUrl: async () => base,
    getDirectory: () => request('/api/agent-engines') });
  const host = { getHostId: () => 'product-acceptance', revoke: (_app, id) => sync.revoke(id),
    prepareNodeRuntime: async () => ({ ...await prepareEmbeddedNodeRuntime({
      stateRoot: path.join(root, 'node-state'), binDir: path.join(getDesktopRoot(app), 'bin'),
      resourcesRoot: path.resolve('build/resources/node-runtime'), executable: process.execPath,
      nodeVersion: process.versions.node, platform: process.platform, arch: process.arch
    }), arch: process.arch }) };
  const plugins = createPluginLifecycle(services, webs.webappManager, host);
  async function checkUI(phase, agentKey) {
    if (phase !== 'chat' && process.env.ACP_UI !== '1') return;
    if (phase !== 'chat') {
      const ui = path.join(root, 'ui');
      fs.mkdirSync(ui, { recursive: true });
      const webRoot = path.resolve('../agent-webclient');
      await require('esbuild').build({
        stdin: { resolveDir: webRoot, loader: 'tsx', contents: `
          import React from 'react'; import {createRoot} from 'react-dom/client';
          import {I18nProvider} from './src/shared/i18n';
          import {EngineSessionControls} from './src/features/composer/components/EngineSessionControls';
          import {useEngineSession} from './src/features/composer/hooks/useEngineSession';
          function Scene(){const params=new URLSearchParams(location.search);const state=useEngineSession({enabled:true,engineId:'zenmind-agent-codex/codex',agentKey:params.get('agent'),chatId:params.get('chat'),running:false});window.engineSession=state;return <EngineSessionControls session={state} engineId="zenmind-agent-codex/codex" running={false} themeMode="light"/>}
          createRoot(document.getElementById('root')).render(<I18nProvider locale="zh-CN"><Scene/></I18nProvider>);`
        }, bundle: true, outfile: path.join(ui, 'scene.js'), alias: { '@': path.join(webRoot, 'src') },
        define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'dataurl', '.ttf': 'dataurl' }
      });
      fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="scene.js"></script>');
    }
    const output = path.resolve('build/qa/acp-product');
    fs.mkdirSync(output, { recursive: true });
    await new Promise((resolve, reject) => {
      const runner = spawn(process.execPath, [path.resolve(phase === 'chat' ? 'qa/acp-chat-ui-smoke.cjs' : 'qa/acp-session-ui-smoke.cjs')], { stdio: 'inherit', env: {
        ...process.env, ELECTRON_RUN_AS_NODE: '', ACP_UI_PROFILE: path.join(root, 'ui-profile'), ACP_UI_BASE: base,
        ACP_UI_WORKSPACE: workspace, ACP_UI_OUTSIDE: outside, ACP_UI_TOKEN: token, ACP_UI_AGENT: agentKey, ACP_UI_CHAT: chatId, ACP_UI_PHASE: phase, ACP_UI_OUTPUT: output
      } });
      runner.once('error', reject);
      runner.once('exit', code => code === 0 ? resolve() : reject(new Error(`UI acceptance exited ${code}`)));
    });
  }
  async function start() {
    fs.rmSync(path.join(root, 'endpoint'), { force: true });
    fs.rmSync(path.join(root, 'stop'), { force: true });
    const launch = await sync.prepareLaunch();
    const log = fs.openSync(path.join(root, 'platform.log'), 'a', 0o600);
    child = spawn('go', ['test', './internal/app', '-run', '^TestDesktopACPProductServer$', '-count=1', '-v', '-timeout=13m'], {
      cwd: path.resolve('../agent-platform'), stdio: ['ignore', log, log],
      env: { ...process.env, ACP_PRODUCT_ROOT: root, ACP_PRODUCT_WEB_ROOT: process.env.ACP_CHAT_UI === '1' ? path.resolve('build/qa/acp-product/webclient') : '', ACP_PRODUCT_BOOTSTRAP: launch.args[1] }
    });
    fs.closeSync(log);
    finished = new Promise(resolve => { child.once('error', () => resolve(-1)); child.once('exit', resolve); });
    let ready = false;
    for (let i = 0; i < 1800; i++) {
      if (fs.existsSync(path.join(root, 'endpoint'))) { ready = true; break; }
      if (child.exitCode !== null) break;
      await pause();
    }
    launch.complete(ready);
    assert.ok(ready, `Platform startup failed; inspect ${root}/platform.log`);
    base = fs.readFileSync(path.join(root, 'endpoint'), 'utf8');
    await sync.reconcile();
  }
  async function stop() {
    if (!child) return;
    fs.writeFileSync(path.join(root, 'stop'), '');
    const code = await finished;
    child = undefined;
    sync.stopped();
    assert.equal(code, 0, `Platform shutdown failed; inspect ${root}/platform.log`);
  }
  async function changeDuringQuestion(agentKey, prepare) {
    const prepared = await prepare();
    await request('/api/agent-engines/sessions/config', {chatId, preparationId:prepared.preparationId,
      configRevision:prepared.configRevision, selections:[{configId:'collaboration_mode',value:'plan'}]}, 'PUT');
    const runId = randomUUID();
    const response = await fetch(base + '/api/query?detail=full', {method:'POST',
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(180000),
      body:JSON.stringify({chatId,agentKey,runId,message:'Use request_user_input now to ask one question Choose lifecycle test result with options OK and SKIP. Do not use other tools or change files. Wait for the answer.'})});
    assert.ok(response.ok);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '', awaitingId, questions;
    while (!awaitingId) {
      const {value,done} = await reader.read(); assert.equal(done,false,'run ended without question'); buffer += value;
      let end;
      while ((end=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,end).trim(); buffer=buffer.slice(end+1);
        if (!line.startsWith('data: ') || line==='data: [DONE]') continue;
        const event=JSON.parse(line.slice(6)); assert.notEqual(event.type,'run.error');
        if (event.type==='awaiting.ask') {awaitingId=event.awaitingId;questions=event.questions;}
      }
    }
    if (upgradeArchive) {
      const previous = binding();
      const oldSnapshot = path.join(root,'platform/ru-agent-engines',engineId,previous.lastUsed.artifactDigest.replace('sha256:',''));
      const installed = await plugins.installFromArchive(app,path.resolve(upgradeArchive));
      assert.equal(installed.ok,true,installed.message);
      const current = (await request('/api/agent-engines')).engines.find(engine=>engine.engineId===engineId);
      assert.notEqual(current.pluginVersion,previous.lastUsed.pluginVersion,'must install a distinct version');
      assert.ok(fs.existsSync(oldSnapshot),'active old program must remain leased');
      assert.deepEqual(binding(),previous,'upgrade cannot replace active binding');
      const answers=questions.filter(question=>question.options?.length).map(question=>({id:question.id,answer:question.options[0].id}));
      assert.ok(answers.length,'real question must provide a selectable answer');
      await request('/api/submit',{chatId,agentKey,runId,awaitingId,submitId:randomUUID(),params:answers});
      let terminal = '';
      for (;;) {
        let end;
        while ((end=buffer.indexOf('\n'))>=0) {
          const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);
          if (!line.startsWith('data: ') || line==='data: [DONE]') continue;
          const event=JSON.parse(line.slice(6));assert.notEqual(event.type,'run.error');
          if (['run.complete','run.cancel'].includes(event.type)) terminal=event.type;
        }
        const {value,done}=await reader.read();if(done)break;buffer+=value;
      }
      assert.equal(terminal,'run.complete','old version must complete the active question');
      const deadline=Date.now()+10000;
      while ((await request('/api/agent-engines')).engines.some(engine=>engine.engineId===engineId && engine.runtimeState!=='stopped') && Date.now()<deadline) await pause();
      assert.equal(fs.existsSync(oldSnapshot),false,'drained old snapshot must be collected');
      upgrade={previous,version:current.pluginVersion};
      console.log('PASS real upgrade during HITL → old snapshot leased → old Run completes → old snapshot collected');
      return;
    }
    const pid=Number(fs.readFileSync(path.join(root,'platform.pid'),'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid>1);
    const processes=execFileSync('/bin/ps',['-axo','pid=,ppid=,pgid='],{encoding:'utf8'}).trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
    const owned=new Set([pid]);
    for (let changed=true;changed;) { changed=false; for (const [id,parent] of processes) if (owned.has(parent) && !owned.has(id)) {owned.add(id);changed=true;} }
    owned.delete(pid); assert.ok(owned.size>=3,'guardian, adapter and app server must be real subprocesses');
    process.kill(pid,'SIGKILL');
    await reader.cancel().catch(()=>{});
    const exit=await finished; assert.notEqual(exit,0,'host must exit abnormally'); child=undefined; sync.stopped();
    const alive=id=>{try{process.kill(id,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
    const deadline=Date.now()+10000;
    while ([...owned].some(alive) && Date.now()<deadline) await pause();
    const survivors=[...owned].filter(alive);
    if (survivors.length) {
      // Cleanup only process groups created under the isolated test host.
      for (const group of new Set(processes.filter(([id])=>survivors.includes(id)).map(([, ,group])=>group))) {
        if (owned.has(group)) {try{process.kill(-group,'SIGKILL');}catch{}}
      }
    }
    assert.deepEqual(survivors,[],'Platform SIGKILL must not leave orphan processes');
    await start();
    const replay=await request('/api/chat?chatId='+chatId+'&detail=full');
    assert.equal(replay.awaiting == null,true);
    assert.equal(replay.events.filter(event=>event.runId===runId && ['run.cancel','run.error','run.complete'].includes(event.type)).length,1);
    const late=await fetch(base+'/api/submit',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
      body:JSON.stringify({chatId,agentKey,runId,awaitingId,submitId:randomUUID(),params:[]})});
    assert.equal(late.status,409,'late answer must not revive interrupted run');
    const output=path.resolve('build/qa/acp014'); fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output,'platform-kill.json'),JSON.stringify({runId,processes:owned.size,survivors:[],terminalCount:1,lateSubmit:late.status},null,2));
    console.log('PASS Platform SIGKILL during real question → all owned processes exit → restart closes Run once → late answer rejected');
  }
  let passed = false;
  try {
    await start();
    const result = await plugins.installFromArchive(app, archive);
    assert.equal(result.ok, true, result.message);
    assert.equal(sync.status(pluginId).syncState, 'applied', 'installation must synchronize automatically');
    await sync.setEnabled(pluginId, true);
    assert.equal(sync.status(pluginId).lastError, '');
    const directory = await request('/api/agent-engines');
    assert.ok(directory.engines.some(engine => engine.engineId === engineId && engine.enabled && engine.dependencyState === 'ready'));
    console.log('PASS real ZIP → Desktop installation → authenticated HTTP synchronization → enabled directory');
    project = await request('/api/admin/agents/create', buildProjectAgentCreateRequest('acp', workspace, { engineId }));
    assert.ok(project.key);
    const prepare = () => request('/api/agent-engines/sessions/prepare', { chatId, agentKey: project.key });
    if (process.env.ACP_LIVE_AUTH === '1') {
      await prepare().catch(error => assert.match(error.message, /auth_required/));
      await checkUI('unauthenticated', project.key);
      await stop();
      const profiles = path.join(root, 'platform/agent-engine-profiles');
      const entries = fs.readdirSync(profiles);
      assert.equal(entries.length, 1);
      const authFile = path.join(profiles, entries[0], 'codex/auth.json');
      if (process.env.ACP_BROWSER_AUTH !== '1') {
        fs.copyFileSync(path.join(os.homedir(), '.codex/auth.json'), authFile);
        fs.chmodSync(authFile, 0o600);
      }
      await start();
      let prepared;
      if (process.env.ACP_BROWSER_AUTH === '1') {
        await assert.rejects(prepare, /auth_required/);
      } else {
        prepared = await prepare();
      }
      if (process.env.ACP_CHAT_UI !== '1' && !lifecycle) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          console.log('AUTH starting', attempt, process.env.ACP_BROWSER_AUTH === '1' ? 'isolated browser profile' : 'copied local profile');
          const authStartedAt = Date.now();
          const login = await request('/api/agent-engines/auth/start', { engineId, methodId: 'chat-gpt' });
          assert.ok(login.authOperationId);
          let auth;
          // Production owns the five-minute deadline; allow time for process cleanup.
          while (Date.now() - authStartedAt < 330000) {
            auth = await request('/api/agent-engines/auth/status?engineId=' + encodeURIComponent(engineId));
            if (auth.state !== 'authenticating') break;
            await pause();
          }
          console.log('AUTH outcome', JSON.stringify({attempt, state:auth.state, elapsedMs:Date.now()-authStartedAt, operationActive:!!auth.authOperationId}));
          assert.equal(auth.authOperationId, undefined, 'finished authentication must release its operation');
          assert.equal(auth.state, 'authenticated', 'authenticate must verify a fresh adapter process');
          console.log('PASS product authenticate operation verifies persisted login in a fresh process', attempt);
        }
      } else {
        console.log('PASS isolated existing login is confirmed by session preparation');
      }
      await checkUI('configured', project.key);
      prepared = await prepare();
      for (const category of ['model', 'thought_level']) {
        const option = prepared.configOptions.find(option => option.category === category);
        if (!option) continue;
        const preferredModel = 'gpt-6.1-terra';
        const value = category === 'model' && option.choices.some(choice => choice.value === preferredModel) ? preferredModel : option.currentValue;
        prepared = await request('/api/agent-engines/sessions/config', { chatId, preparationId: prepared.preparationId,
          configRevision: prepared.configRevision, selections: [{ configId: option.id, value }] }, 'PUT');
      }
      console.log('PASS HTTP project creation, existing login, model/effort configuration before first prompt', prepared.configOptions.filter(option => ['model', 'thought_level'].includes(option.category)).map(option => `${option.id}=${option.currentValue}`).join(', '));
      if (process.env.ACP_CHAT_UI === '1') {
        outside = fs.mkdtempSync(path.join(os.homedir(), '.zenmind-acp-sandbox-'));
        fs.chmodSync(outside, 0o700);
        await checkUI('chat', project.key);
      } else {
        const marker = `ACP012-${randomUUID()}`;
        const query = message => request('/api/query?detail=full', { chatId, agentKey: project.key, message, stream: false });
        const first = await query(`Remember ${marker}. Reply only with this marker. Do not use tools.`);
        assert.ok(first.content?.includes(marker), 'first response must include marker');
        if (lifecycle) await changeDuringQuestion(project.key, prepare);
        else { await stop(); await start(); }
        console.log(upgrade ? 'RESTORE preparing previous context with upgraded plugin' : 'RESTORE preparing previous context after host restart');
        const restored = await prepare();
        console.log('PASS resumed previous external session; submitting explicit next turn');
        if (lifecycle) {
          const mode = restored.configOptions.find(option => option.id === 'collaboration_mode');
          if (mode?.choices.some(choice=>choice.value==='default')) await request('/api/agent-engines/sessions/config', {chatId,preparationId:restored.preparationId,configRevision:restored.configRevision,selections:[{configId:mode.id,value:'default'}]}, 'PUT');
        }
        const second = await query('What exact marker did I ask you to remember? Reply only with the marker. Do not use tools.');
        assert.ok(second.content?.includes(marker), 'explicit restore must retain conversation context');
        const replay = await request('/api/chat?chatId=' + chatId + '&detail=full');
        assert.equal(replay.runs.length, lifecycle ? 3 : 2, 'restore must not create duplicate runs');
        assert.equal(replay.events.filter(event => event.type === 'content.snapshot' && event.text?.includes(marker)).length, 2, 'restore must not duplicate answers');
        console.log('PASS explicit Query restores conversation context without duplicate history');
        if (upgrade) {
          const restoredBinding=binding();
          assert.equal(restoredBinding.acpSessionId,upgrade.previous.acpSessionId);
          assert.equal(restoredBinding.profileId,upgrade.previous.profileId);
          assert.equal(restoredBinding.lastUsed.pluginVersion,upgrade.version);
          assert.notEqual(restoredBinding.lastUsed.artifactDigest,upgrade.previous.lastUsed.artifactDigest);
          const output=path.resolve('build/qa/acp014');fs.mkdirSync(output,{recursive:true});
          fs.writeFileSync(path.join(output,'cross-version.json'),JSON.stringify({from:upgrade.previous.lastUsed,to:restoredBinding.lastUsed,sameSession:true,sameProfile:true,memoryRestored:true,runCount:replay.runs.length},null,2));
          console.log('PASS real cross-version restore retains session/profile/memory without duplicate history');
        }
        if (process.env.ACP_LIVE_INTERACTIONS === '1') {
          for (const phase of ['question', 'cancel']) {
            prepared = await prepare();
            await request('/api/agent-engines/sessions/config', { chatId, preparationId: prepared.preparationId,
              configRevision: prepared.configRevision, selections: [{ configId: 'collaboration_mode', value: 'plan' }] }, 'PUT');
            const runId = randomUUID();
            const response = await fetch(base + '/api/query?detail=full', { method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(150000),
              body: JSON.stringify({ chatId, agentKey: project.key, runId,
                message: 'Protocol test: use request_user_input to ask exactly one single-choice question Choose probe result, with options OK and SKIP. Do not use other tools or access files. After the answer reply only DONE.' }) });
            assert.ok(response.ok);
            let buffer = '', asked = false, terminal = '';
            for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
              buffer += chunk;
              let end;
              while ((end = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
                if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                const event = JSON.parse(line.slice(6));
                assert.notEqual(event.type, 'run.error', 'interactive run failed');
                if (event.type === 'run.complete' || event.type === 'run.cancel') terminal = event.type;
                if (event.type !== 'awaiting.ask') continue;
                assert.equal(event.mode, 'question');
                assert.equal(asked, false, 'unexpected repeated question'); asked = true;
                if (phase === 'cancel') await request('/api/interrupt', { chatId, runId, agentKey: project.key });
                else await request('/api/submit', { chatId, runId, agentKey: project.key, awaitingId: event.awaitingId,
                  submitId: randomUUID(), params: event.questions.filter(question => question.options?.length).map(question => ({ id: question.id, answer: question.options[0].id })) });
              }
            }
            assert.ok(asked, 'real Codex must issue a reverse request');
            assert.equal(terminal, phase === 'cancel' ? 'run.cancel' : 'run.complete');
            console.log(`PASS real HTTP/SSE ${phase} → product control endpoint → ${terminal}`);
          }
        }
      }
    }
    await sync.setEnabled(pluginId, false);
    await assert.rejects(prepare, /engine_unavailable/);
    await sync.setEnabled(pluginId, true);
    assert.equal((await plugins.uninstall(app, pluginId)).ok, true);
    assert.throws(() => registry.getService(pluginId), /unknown service id/);
    assert.equal((await request('/api/agent-engines')).engines.length, 0);
    console.log('PASS disable rejects preparation; re-enable and acknowledged uninstall remove directory without restart');
    passed = true;
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    let shutdownError;
    if (!passed && child && project) await request('/api/interrupt',{chatId,agentKey:project.key}).catch(()=>{});
    await stop().catch(error => { shutdownError = error; });
    registry.clearServices();
    if (outside) fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(path.join(root, 'platform/agent-engine-profiles'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'ui-profile'), { recursive: true, force: true });
    if (passed && !shutdownError) {
      // Platform freezes derived Agent snapshots. Restore only our temporary
      // directories after the process exits; never follow workspace symlinks.
      for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (entry.isDirectory()) fs.chmodSync(path.join(entry.parentPath, entry.name), 0o700);
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
    else console.error(`Private acceptance evidence retained: ${root}`);
    if (shutdownError) throw shutdownError;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
