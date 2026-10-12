import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { signDarwinDevElectronApp } from "../scripts/platform/dev-darwin.mjs";
import { parseMacAppSignature } from "../scripts/lib/mac-app-signing.js";

if (process.argv.includes("--help")) {
  console.log("Usage: node qa/screenshot-native-macos.mjs [prepared-development.app] [output-directory]\nRequires macOS, at least two connected displays, and Screen Recording consent for the prepared development app.");
  process.exit(0);
}
if (process.platform !== "darwin") throw new Error("This native screenshot acceptance check requires macOS.");
const projectRoot = process.cwd();
const sourceApp = path.resolve(process.argv[2] || "build/brands/cutej/dev/CuteJ.app");
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-screenshot-native-"));
const probeApp = path.join(probeRoot, "CuteJ.app");
const output = path.resolve(process.argv[3] || "build/qa/screenshot-native-macos");
fs.mkdirSync(output, { recursive: true });
try {
  fs.cpSync(sourceApp, probeApp, { recursive: true, verbatimSymlinks: true });
  const originalSignature = spawnSync("/usr/bin/codesign", ["-d", "-r-", sourceApp], { encoding: "utf8" });
  assert.equal(originalSignature.status, 0, originalSignature.stderr);
  const originalRequirement = parseMacAppSignature(`${originalSignature.stdout}\n${originalSignature.stderr}`).designatedRequirement;
  assert.ok(originalRequirement);
  const resources = path.join(probeApp, "Contents", "Resources", "app");
  const configuration = { projectRoot, output, profile: path.join(probeRoot, "profile"), runId: randomUUID() };
  const script = String.raw`
const { app, BrowserWindow, nativeImage, screen, systemPreferences } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const config = JSON.parse(process.env.DESKTOP_SCREENSHOT_NATIVE_CONFIG);
fs.mkdirSync(config.profile,{recursive:true});
app.setPath("userData", config.profile);
app.setPath("sessionData", config.profile);
app.whenReady().then(async () => {
  assert.equal(systemPreferences.getMediaAccessStatus("screen"), "granted", "the signed application must have real Screen Recording consent");
  const { captureScreenshotForBridge } = require(path.join(config.projectRoot,"dist-electron/main/modules/assistant/copilot/screenshot.js"));
  const displays = screen.getAllDisplays();
  assert.ok(displays.length >= 2, "connect at least two displays for native acceptance");
  const anchor = new BrowserWindow({show:false,width:1,height:1,webPreferences:{sandbox:true}});
  const captures = [];
  for (const [index, display] of displays.entries()) {
    const color = index % 2 ? "#2369d8" : "#16a35d";
    const bits = Array.from({length:32},(_,bit)=>((index+1)>>>bit)&1);
    const barcode = bits.map(bit=>'<span style="width:10px;height:20px;background:'+(bit?'black':'white')+'"></span>').join('');
    const marker = new BrowserWindow({ frame:false, show:false, width:360, height:240, backgroundColor:color, webPreferences:{sandbox:true} });
    const bounds = { x:display.bounds.x+Math.round(display.bounds.width/2)-180, y:display.bounds.y+Math.round(display.bounds.height/2)-120, width:360, height:240 };
    marker.setBounds(bounds,false);
    marker.setAlwaysOnTop(true,"screen-saver");
    await marker.loadURL("data:text/html,"+encodeURIComponent('<body style="margin:0;background:'+color+';color:white;font:24px system-ui;display:grid;place-items:center;height:100vh"><div style="position:absolute;left:20px;top:20px;display:flex">'+barcode+'</div>Display '+(index+1)+' native screenshot</body>'));
    marker.showInactive();
    marker.moveTop();
    await new Promise(resolve=>setTimeout(resolve,200));
    const result = await captureScreenshotForBridge({platform:"darwin",getMainWindow:()=>marker,delay:ms=>new Promise(resolve=>setTimeout(resolve,ms))},"desktop");
    assert.equal(result.ok,true,result.message);
    const image = nativeImage.createFromBuffer(Buffer.from(result.dataBase64,"base64"));
    const size = image.getSize();
    const scaleX=size.width/display.bounds.width, scaleY=size.height/display.bounds.height;
    const clip = image.crop({x:Math.round((bounds.x-display.bounds.x+20)*scaleX), y:Math.round((bounds.y-display.bounds.y+20)*scaleY), width:Math.round(320*scaleX), height:Math.round(200*scaleY)});
    const pixel = clip.crop({x:2,y:2,width:1,height:1}).toBitmap();
    const rgb = [pixel[2],pixel[1],pixel[0]];
    // Black/white identity bits tolerate the monitor's color profile while
    // proving that the pixels came from this particular physical display.
    for (const [bit,black] of bits.entries()) {
      const sample=clip.crop({x:Math.round((bit*10+5)*scaleX),y:Math.round(10*scaleY),width:1,height:1}).toBitmap();
      assert.ok([...sample.subarray(0,3)].every(channel=>black?channel<80:channel>175),"native display identity mismatch at bit "+bit);
    }
    fs.writeFileSync(path.join(config.output,"display-"+(index+1)+".png"),clip.toPNG());
    captures.push({displayId:display.id,bounds:display.bounds,scaleFactor:display.scaleFactor,imageSize:size,markerPixel:rgb});
    marker.destroy();
  }
  const report={ok:true,runId:config.runId,permission:"granted",displayCount:displays.length,captures};
  fs.writeFileSync(path.join(config.output,"report.json"),JSON.stringify(report,null,2)+"\n");
  console.log("NATIVE_SCREENSHOT_ACCEPTANCE "+JSON.stringify(report));
  anchor.destroy();
  app.quit();
}).catch(error=>{console.error(error.message);app.exit(1)});
`;
  fs.writeFileSync(path.join(resources, "index.cjs"), `process.env.DESKTOP_SCREENSHOT_NATIVE_CONFIG=${JSON.stringify(JSON.stringify(configuration))};\n${script}`);
  fs.writeFileSync(path.join(probeApp, "Contents", "Resources", "upgrade-marker.txt"), "changed signed content for permission upgrade acceptance\n");
  signDarwinDevElectronApp(probeApp);
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", `=${originalRequirement}`, probeApp], { stdio: ["ignore", "pipe", "pipe"] });
  const binary = path.join(probeApp, "Contents", "MacOS", "CuteJ");
  const result = await new Promise((resolve,reject) => {
    const child = spawn(binary, [], { env:{...process.env, BRAND:"cutej", DESKTOP_BRAND_JSON:path.join(projectRoot,"build/brands/cutej/generated/brand.json")}, stdio:["ignore","pipe","pipe"] });
    let text="";
    const timer=setTimeout(()=>{child.kill("SIGTERM");reject(new Error("Native screenshot acceptance timed out"))},30000);
    child.stdout.on("data",chunk=>{text+=chunk});
    child.stderr.on("data",chunk=>{text+=chunk});
    child.once("error",error=>{clearTimeout(timer);reject(error)});
    child.once("exit",code=>{clearTimeout(timer);resolve({code,text})});
  });
  assert.equal(result.code,0,result.text);
  assert.ok(result.text.includes("NATIVE_SCREENSHOT_ACCEPTANCE "),"Native probe did not emit this run's completion marker: "+result.text);
  assert.ok(fs.existsSync(path.join(output,"report.json")),"Native probe exited before completing all displays: "+result.text);
  const report=JSON.parse(fs.readFileSync(path.join(output,"report.json"),"utf8"));
  assert.equal(report.runId,configuration.runId,"An earlier native screenshot report cannot satisfy this run");
  assert.equal(report.ok,true);
  console.log(`Passed native source and crop verification on ${report.displayCount} displays; the changed app still satisfies the original authorization identity. Report: ${output}`);
} finally {
  fs.rmSync(probeRoot,{recursive:true,force:true});
}
