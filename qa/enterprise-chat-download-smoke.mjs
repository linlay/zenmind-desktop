// Prepare: BRAND=cutej npm run brand:sync && npm run build:main:types
// Run with Playwright and Chrome installed: node qa/enterprise-chat-download-smoke.mjs
// Set PLAYWRIGHT_MODULE when Playwright is installed outside this project.
// Actual renderer component and styles; Electron I/O uses deterministic deferred mocks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  if (!process.env.PLAYWRIGHT_MODULE) {
    throw new Error('Install Playwright or set PLAYWRIGHT_MODULE to an installed Playwright module path.');
  }
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE));
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-chat-smoke-'));
const output = path.join(repo, 'output/playwright');
fs.mkdirSync(output, { recursive: true });
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {EnterpriseChatFloatingPanel} from './src/renderer/enterprise-chat/EnterpriseChatFloatingPanel';
import {RendererI18nContext} from './src/renderer/i18n/i18n-context';
import {createTranslator} from './src/shared/i18n';
import './src/renderer/styles.css';
const user = {id:'self',displayName:'测试员工',email:'',avatarUrl:'',kind:'employee',online:true};
const peer = {...user,id:'bot',displayName:'小君问问',kind:'service_bot'};
const messages = [1,2].map(n=>({id:'m'+n,conversationId:'conversation',seq:n,senderId:'bot',kind:'file',body:'',createdAt:Date.UTC(2026,8,18+n,8,15),attachments:[{id:'a'+n,name:'image-'+n+'.png',contentType:'image/png',sizeBytes:115000,sha256:'',createdAt:Date.now()}]}));
const state = {enabled:true,connectionState:'connected',message:'',serverUrl:'https://fixture.invalid',currentUser:user,selfProfile:{motto:'',avatarDataUrl:'',hasCustomAvatar:false},users:[user,peer],conversations:[{id:'conversation',type:'direct',title:'',lastSeq:2,lastReadSeq:2,unreadCount:0,lastMessage:messages[1],members:[{user},{user:peer}],updatedAt:Date.now()}],activeConversationId:'conversation',activeMessages:messages,latestEventId:2};
const pending = {};
window.qa = {calls:[],reveals:[],resolve:(id,result)=>pending[id].resolve(result),reject:(id)=>pending[id].reject(new Error('模拟网络断开'))};
window.electronAPI = {enterpriseChat:{getState:async()=>state,refresh:async()=>state,onStateChanged:()=>()=>{},openConversation:async()=>state,markRead:async()=>state,loadAttachment:async()=>({contentType:'image/svg+xml',dataBase64:btoa('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="100"><rect width="320" height="100" fill="#dce9fc"/><text x="20" y="56" fill="#264574">Image preview</text></svg>')}),downloadAttachment:input=>{window.qa.calls.push(input);return new Promise((resolve,reject)=>{pending[input.fileId]={resolve,reject}})}},services:{revealPath:async(...args)=>{window.qa.reveals.push(args);return {ok:true}}}};
createRoot(document.getElementById('root')).render(<RendererI18nContext.Provider value={{locale:'zh-CN',t:createTranslator('zh-CN'),source:'user',setLocale:async()=>{}}}><EnterpriseChatFloatingPanel desktopSsoStatus={{authenticated:true,completedSteps:{session:true,userInfo:true,accessToken:true}}}/></RendererI18nContext.Provider>);
`;
let server, browser;
try {
  await build({stdin:{contents:source,loader:'tsx',resolveDir:repo},outfile:path.join(tmp,'app.js'),bundle:true,platform:'browser',jsx:'automatic',loader:{'.png':'dataurl','.svg':'dataurl','.woff2':'dataurl'},define:{'process.env.NODE_ENV':'"development"',__DESKTOP_APP_BRAND__:JSON.stringify(require(path.join(repo,'dist-electron/shared/brand.js')).APP_BRAND)}});
  fs.writeFileSync(path.join(tmp,'index.html'),'<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script></html>');
  server = http.createServer((req,res)=>{const name=req.url==='/'?'index.html':path.basename(req.url);res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');if (!fs.existsSync(path.join(tmp,name))) {res.statusCode=404;res.end();return;}res.end(fs.readFileSync(path.join(tmp,name)));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser = await chromium.launch({channel:'chrome',headless:true});
  const page = await browser.newPage({viewport:{width:800,height:800},timezoneId:'Asia/Shanghai'});
  page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('Browser error:',e.message)});
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.locator('.enterprise-chat-launcher').click();
  await page.locator('.enterprise-chat-conversation').first().click();
  const cards=page.locator('.enterprise-chat-attachment');
  await cards.nth(1).waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('.enterprise-chat-image')].every(img=>img.complete && img.naturalWidth>0));
  const times=await page.locator('.enterprise-chat-message time').allTextContents();
  assert.equal(times.length,2);assert.match(times[0],/2026.*09.*19/);assert.match(times[1],/2026.*09.*20/);
  const button=n=>cards.nth(n).locator('.enterprise-chat-attachment-download');
  const feedback=n=>cards.nth(n).locator('.enterprise-chat-download-feedback');
  await button(0).evaluate(el=>{el.click();el.click()});
  await page.waitForFunction(()=>window.qa.calls.length===1);
  assert.equal(await button(0).isDisabled(),true);assert.match(await feedback(0).innerText(),/下载中/);
  await button(1).click();
  const savedPath='/Users/qa/Downloads/企业微信图片归档/长路径验证/'+ '客服对话记录-'.repeat(15)+'image-1.png';
  await page.evaluate(path=>window.qa.resolve('a1',{ok:true,path}),savedPath);
  await cards.nth(0).locator('.enterprise-chat-download-reveal').waitFor();
  assert.equal(await button(1).isDisabled(),true);
  assert.equal(await cards.nth(0).locator('.enterprise-chat-download-path').innerText(),savedPath);
  await cards.nth(0).locator('.enterprise-chat-download-reveal').click();
  assert.deepEqual(await page.evaluate(()=>window.qa.reveals),[[savedPath,{targetType:'file'}]]);
  await page.evaluate(()=>window.qa.reject('a2'));
  await page.waitForFunction(()=>document.querySelectorAll('.enterprise-chat-download-error').length===1);
  assert.match(await button(1).getAttribute('aria-label'),/重试/);
  await button(1).click();
  await page.evaluate(()=>window.qa.resolve('a2',{ok:false,cancelled:true}));
  await page.waitForFunction(()=>document.body.textContent.includes('已取消'));
  assert.equal(await cards.nth(1).locator('.enterprise-chat-download-reveal').count(),0);
  await page.waitForTimeout(3200);
  assert.match(await feedback(0).innerText(),/已下载/);
  await cards.nth(0).scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(output,'enterprise-chat-download-light.png')});
  await page.setViewportSize({width:320,height:700});
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  await cards.nth(0).scrollIntoViewIfNeeded();
  const bounds=await cards.nth(0).evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth,right:el.getBoundingClientRect().right}));
  assert.ok(bounds.scroll<=bounds.client+1,JSON.stringify(bounds));assert.ok(bounds.right<=320);
  await page.screenshot({path:path.join(output,'enterprise-chat-download-dark-320.png')});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,times,downloadCalls:await page.evaluate(()=>window.qa.calls),screenshots:output},null,2));
} finally {await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());fs.rmSync(tmp,{recursive:true,force:true});}
