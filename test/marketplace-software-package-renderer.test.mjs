import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSource(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), "utf8");
}

test("software package market is wired through the renderer tab, status and actions", () => {
  const model = readSource("src", "renderer", "pages", "functional-market", "marketPageModel.ts");
  const registry = readSource("src", "renderer", "pages", "functional-market", "marketViewRegistry.tsx");
  const frame = readSource("src", "renderer", "pages", "functional-market", "MarketPageFrame.tsx");
  const storefront = readSource("src", "renderer", "pages", "functional-market", "StorefrontMarket.tsx");

  assert.match(model, /softwarePackages:\s*"software-package"/u);
  assert.match(model, /mcps:\s*"mcp"/u);
  assert.match(model, /market\.tab\.softwarePackages\.subtitle/u);
  assert.match(model, /softwarePackageMessage:\s*""/u);
  assert.match(model, /softwarePackageOffline:\s*false/u);
  assert.match(registry, /softwarePackages:\s*StorefrontMarket/u);
  assert.match(frame, /case\s+"softwarePackages"[\s\S]*?<HddOutlined\s*\/>/u);
  assert.match(frame, /case\s+"mcps"[\s\S]*?<LinkOutlined\s*\/>/u);
  assert.match(storefront, /case\s+"software-package"[\s\S]*?market\.type\.softwarePackage/u);
  assert.match(storefront, /item\.type\s*===\s*"software-package"/u);
  assert.match(storefront, /result\.softwarePackageMessage/u);
  assert.match(storefront, /result\.softwarePackageOffline/u);
});

test("market actions show progress and preserve success or error feedback after catalog refresh", () => {
  const storefront = readSource("src", "renderer", "pages", "functional-market", "StorefrontMarket.tsx");

  assert.match(storefront, /Boolean\(feedback\)\s*\|\|\s*Boolean\(marketOffline\s*&&\s*marketStatusMessage\)/u);
  assert.match(storefront, /setFeedback\(t\("market\.action\.installing"\)\)[\s\S]*?const result = await action\(item\.id\)/u);
  assert.match(storefront, /setFeedbackType\("success"\)[\s\S]*?await refreshEverything\(true, true\)/u);
  assert.match(storefront, /setFeedback\(normalizeError\(reason\)\)[\s\S]*?setFeedbackType\("error"\)/u);
  assert.match(storefront, /type=\{feedback \? feedbackType : "warning"\}/u);
});

test("catalog items keep the cloud source label and target version when a local copy exists", () => {
  const display = readSource("src", "renderer", "pages", "functional-market", "marketDisplay.tsx");

  assert.match(display, /item\.marketplaceAvailable\s*\|\|\s*item\.source\s*===\s*"cloud"/u);
  assert.match(display, /item\.state\s*===\s*"update-available"\s*\?\s*item\.version/u);
});

test("market storefront uses one WorkBuddy-inspired list with per-card source labels", () => {
  const storefront = readSource("src", "renderer", "pages", "functional-market", "StorefrontMarket.tsx");
  const styles = readSource("src", "renderer", "pages", "functional-market", "StorefrontMarket.css");

  assert.match(storefront, /market\.storefront\.allTitle/u);
  assert.doesNotMatch(storefront, /market\.storefront\.featuredTitle/u);
  assert.doesNotMatch(storefront, /market\.storefront\.cloudTitle/u);
  assert.doesNotMatch(storefront, /market\.storefront\.localTitle/u);
  assert.match(storefront, /market-store-card-quick-action/u);
  assert.match(storefront, /market-store-origin-pill\s+\$\{isCloudSource\s*\?\s*"is-cloud"\s*:\s*"is-local"\}/u);
  assert.match(styles, /\.market-store-origin-pill\.is-cloud/u);
  assert.match(styles, /\.market-store-origin-pill\.is-local/u);
  assert.match(styles, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/u);
  assert.match(styles, /\.market-store-action\.is-compact-icon\.ant-btn/u);
  assert.match(storefront, /activeTab\s*===\s*"skills"[\s\S]*?market\.toolbar\.myInstalled/u);
  assert.match(styles, /\.market-store-header-tools/u);
});

test("skill market separates uninstalled cloud skills from installed local and cloud skills", () => {
  const storefront = readSource("src", "renderer", "pages", "functional-market", "StorefrontMarket.tsx");

  assert.match(storefront, /function isCloudMarketItem\(item: MarketItem\)[\s\S]*?item\.marketplaceAvailable\s*\|\|\s*item\.source\s*===\s*"cloud"/u);
  assert.match(storefront, /function isCloudSkillStorefrontItem\(item: MarketItem\)[\s\S]*?item\.state\s*===\s*"update-available"/u);
  assert.match(storefront, /activeTab\s*===\s*"skills"[\s\S]*?rangeMode\s*===\s*"installed"[\s\S]*?isInstalledMarketItem\(item\)[\s\S]*?isCloudSkillStorefrontItem\(item\)/u);
  assert.match(storefront, /market\.storefront\.cloudSkillsTitle/u);
  assert.match(storefront, /market\.storefront\.installedSkillsTitle/u);
  assert.match(storefront, /activeTab\s*!==\s*"skills"[\s\S]*?market-store-search-filter-button/u);
});

test("skill toolbar provides WorkBuddy-style find, import, and create actions", () => {
  const storefront = readSource("src", "renderer", "pages", "functional-market", "StorefrontMarket.tsx");

  assert.match(storefront, /<Dropdown[\s\S]*?market\.toolbar\.addSkill/u);
  assert.match(storefront, /key:\s*"find"[\s\S]*?market\.skill\.menu\.find/u);
  assert.match(storefront, /key:\s*"import"[\s\S]*?market\.skill\.localImport/u);
  assert.match(storefront, /key:\s*"create"[\s\S]*?market\.skill\.menu\.create/u);
  assert.match(storefront, /composerIntent:\s*SKILL_COMPOSER_INTENT\[mode\]/u);
  assert.match(storefront, /navigate\(createAgentWebclientAgentPath\(agentKey, search\)\)/u);
  assert.doesNotMatch(storefront, /window\.electronAPI\.assistant\.startRun/u);
  assert.doesNotMatch(storefront, /renderSkillAssistantDialog/u);
});

test("market header uses WorkBuddy-style compact tabs without a full-width segmented container", () => {
  const frame = readSource("src", "renderer", "pages", "functional-market", "MarketPageFrame.tsx");
  const styles = readSource("src", "renderer", "pages", "functional-market", "MarketPageFrame.css");

  assert.doesNotMatch(frame, /<Segmented/u);
  assert.match(frame, /role="tablist"/u);
  assert.match(frame, /className=\{`market-tab-option[\s\S]*?is-selected/u);
  assert.match(styles, /\.market-tab-option\.is-selected\s*\{[\s\S]*?background:\s*#303236;[\s\S]*?color:\s*#ffffff/u);
  assert.match(styles, /\.market-tabs\s*\{[\s\S]*?width:\s*max-content;[\s\S]*?overflow-x:\s*auto/u);
  assert.doesNotMatch(styles, /\.market-status\s*\{[^}]*box-shadow:\s*inset/u);
  assert.doesNotMatch(styles, /\.market-status\.is-warning\s*\{[^}]*box-shadow:\s*inset/u);
});
