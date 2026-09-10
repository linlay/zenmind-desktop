// Standalone preview of the real appearance layer and shell styles.
// Built by desktop-appearance-smoke.mjs; no business services are used.
import React, { useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Input, Segmented, Switch } from "antd";
import { AppearanceProvider, useAppearance } from "../src/renderer/appearance/AppearanceProvider";
import { SkinSettings } from "../src/renderer/appearance/SkinSettings";
import "../src/renderer/pages/settings/SettingsPage.css";
import { DesktopBackground } from "../src/renderer/appearance/DesktopBackground";
import { bootstrapAppearance } from "../src/renderer/appearance/browser";
import { Popover } from "../src/renderer/components/Popover";
import "../src/renderer/styles.css";
import "./desktop-skins-preview.css";
import alpineLake from "./assets/alpine-lake.png";

const inElectron = Boolean(window.electronAPI);
if (!inElectron) {
  // Browser-only preview bridge. Production renderer always uses real preload.
  let themeMode = "light";
  const photoDemo = new URLSearchParams(location.search).get("background") === "photo";
  let settings = photoDemo
    ? { skinId: "mist", background: { id: "0123456789abcdef0123456789abcdef", name: "山湖照片.png", width: 1586, height: 992 }, backgroundDataUrl: alpineLake }
    : { skinId: "default", background: null, backgroundDataUrl: null };
  const result = () => ({ ok: true, settings });
  Object.defineProperty(window, "electronAPI", { value: { settings: {
    getThemePreference: async () => themeMode,
    getDesktopSkin: async () => result(),
    setDesktopSkin: async (skinId) => { settings = { ...settings, skinId }; return result(); },
    resetDesktopBackground: async () => { settings = { ...settings, background: null, backgroundDataUrl: null }; return result(); },
    // A temporary browser demo: production import validation and durable storage
    // live in Main. No browser demo files are written to Desktop's profile.
    importDesktopBackground: () => new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file"; input.accept = "image/png,image/jpeg";
      input.oncancel = () => resolve({ ...result(), cancelled: true });
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) { resolve({ ...result(), cancelled: true }); return; }
        if (file.size > 16 * 1024 * 1024) { resolve({ ok: false, error: "imageTooLarge" }); return; }
        if (!["image/png", "image/jpeg"].includes(file.type)) { resolve({ ok: false, error: "invalidImage" }); return; }
        const reader = new FileReader();
        reader.onerror = () => resolve({ ok: false, error: "invalidImage" });
        reader.onload = () => {
          const image = new Image();
          image.onerror = () => resolve({ ok: false, error: "invalidImage" });
          image.onload = () => {
            if (image.naturalWidth * image.naturalHeight > 32_000_000) { resolve({ ok: false, error: "imageTooLarge" }); return; }
            settings = { ...settings, background: { id: crypto.randomUUID().replaceAll("-", ""), name: file.name, width: image.naturalWidth, height: image.naturalHeight }, backgroundDataUrl: String(reader.result) };
            resolve(result());
          };
          image.src = String(reader.result);
        };
        reader.readAsDataURL(file);
      };
      input.click();
    }),
    setNativeThemeSource: async (theme: string) => { themeMode = theme; return { ok: true, themeSource: theme }; }
  } } });
}
bootstrapAppearance();
window.skinPreview = { mounts: 0 };
const guestUrl = new URL("./guest.html", window.location.href).href;

function SkinPreview() {
  const appearance = useAppearance();
  const [platform, setPlatform] = useState("mac");
  const [embedded, setEmbedded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [brokenBackground, setBrokenBackground] = useState(false);
  const [selected, setSelected] = useState("工作台");
  const [draft, setDraft] = useState("");
  useLayoutEffect(() => { Object.assign(window.skinPreview, { api: appearance, setPlatform, setEmbedded, setCollapsed, setBrokenBackground, setSelected }); });
  useEffect(() => { window.skinPreview.mounts++; }, []);
  const background = appearance.background;
  return (
    <div className="skin-preview-page">
      <header className="skin-preview-toolbar">
        <div><strong>Desktop · 图片背景与皮肤</strong><span>预览选择不会保存到 Desktop</span></div>
        <div className="skin-preview-options">
          <Segmented aria-label="皮肤" value={appearance.skin.id} onChange={(id) => void appearance.setSkinId(id).catch(() => undefined)} options={[{value:"default",label:"默认"},{value:"mist",label:"雾林"}]} />
          <Segmented aria-label="明暗" value={appearance.themeMode} onChange={(mode) => void appearance.setThemeMode(mode)} options={[{value:"light",label:"浅色"},{value:"dark",label:"深色"},{value:"system",label:"系统"}]} />
          <Segmented aria-label="平台布局" value={platform} onChange={setPlatform} options={[{value:"mac",label:"macOS"},{value:"windows",label:"Windows"}]} />
          <label className="skin-preview-guest-switch"><Switch checked={embedded} onChange={setEmbedded} size="small" /> 嵌入页面</label>
          {!inElectron && <a href="?background=photo">山湖照片示例</a>}
        </div>
      </header>
      <div id="preview-shell" style={{ "--app-sidebar-width": collapsed ? "62px" : "200px" } as React.CSSProperties}
        className={`app-shell has-translucent-sidebar ${platform === "mac" ? "is-mac-platform is-mac-translucent-sidebar" : "is-windows-platform"} ${embedded ? "has-embedded-surface has-service-webview-surface" : "has-standard-base-surface"}`}>
        <DesktopBackground background={brokenBackground ? { imageUrl: "./missing-background.png", position: "center" } : background}
          fallback={brokenBackground ? null : appearance.skin.backgrounds?.[appearance.resolvedTheme]} />
        <header className="app-system-bar">
          <div className="app-system-bar-drag-region">Desktop</div>
          <div className="app-system-bar-window-controls">
            <button className="app-system-bar-control" title="最小化">−</button>
            <button className="app-system-bar-control" title="最大化">□</button>
            <button className="app-system-bar-control is-close" title="关闭">×</button>
          </div>
        </header>
        <div className="app-sidebar-shell">
          <aside className={`app-sidebar${collapsed ? " is-collapsed" : ""}`}>
            <div className="skin-preview-sidebar-head">
              <strong>{collapsed ? "D" : "Desktop"}</strong>
              <button id="preview-collapse" className="app-sidebar-collapse-button" onClick={() => setCollapsed(!collapsed)} title="展开 / 收起侧栏">☰</button>
            </div>
            <div className="skin-preview-sidebar-items">
              {[["工作台","⌂"],["对话","◉"],["项目","▱"],["设置","⚙"]].map(([label, icon]) => (
                <button key={label} className={`sidebar-link sidebar-primary-link${selected === label ? " sidebar-link-active" : ""}`} onClick={() => setSelected(label)} title={label}>
                  <span className="sidebar-link-icon">{icon}</span>{!collapsed && <span className="sidebar-link-label">{label}</span>}
                </button>
              ))}
            </div>
            {!collapsed && <div className="skin-preview-sidebar-footer">{appearance.skin.id === "mist" ? "雾林 / MIST" : "默认 / DEFAULT"}<span>主窗口外观</span></div>}
          </aside>
        </div>
        <div className="app-content">
          <main className="app-main">
            <section className="skin-preview-native" hidden={embedded || selected === "设置"}>
              <div className="skin-preview-heading"><div><span>你的工作空间</span><h1>把想法，慢慢变成现实。</h1><p>{appearance.skinSettings.background ? "整张照片铺在窗口底层，内容卡片浮在图片上。" : "背景、侧栏和控件使用同一套皮肤。"}</p></div><button id="preview-primary" className="sidebar-website-primary-button">新建项目</button></div>
              <div className="skin-preview-cards">
                <article><span className="skin-preview-card-index">01 / CREATE</span><h2>开始一段新对话</h2><p>记录想法，整理下一步。</p><Button type="primary" id="preview-ant-primary">开始对话</Button></article>
                <article><span className="skin-preview-card-index">02 / CONTINUE</span><h2>继续手头的工作</h2><p>皮肤切换时，保留输入和页面状态。</p><Input id="preview-draft" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="写下一点想法…" /></article>
              </div>
              <div className="skin-preview-bottom"><span>{appearance.skinSettings.background ? "设置 → 外观 → 背景图片，可换成自己的照片" : "一张背景 · 两种明暗"}</span><Popover placement="top-end" content={<div className="skin-preview-popover">菜单也会跟随当前皮肤。</div>}><Button>打开菜单</Button></Popover></div>
            </section>
            <section className="skin-preview-settings settings-page" hidden={embedded || selected !== "设置"}>
              <h1>外观设置</h1><p>正式设置组件 · 选择后自动保存</p>
              <div className="settings-appearance-panel"><SkinSettings /></div>
            </section>
            <div className="skin-preview-guest embedded-surface-frame-shell" hidden={!embedded}>
              {inElectron ? <webview id="preview-guest" src={guestUrl} webpreferences="contextIsolation=yes,sandbox=yes" /> : <iframe id="preview-guest" src={guestUrl} title="独立页面预览" />}
            </div>
          </main>
        </div>
      </div>
      <footer className="skin-preview-caption">使用实际的皮肤、背景组件和主窗口样式。内嵌页面保持独立背景。</footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><AppearanceProvider><SkinPreview /></AppearanceProvider></React.StrictMode>);
