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

test("installed Market WebApps open only after an explicit user action", () => {
  const storefront = readSource("src", "renderer", "pages", "functional-market", "StorefrontMarket.tsx");

  assert.match(storefront, /async function launchWebsiteApp\(itemId: string\)/u);
  assert.match(storefront, /window\.electronAPI\.webs\.webapps\.list\(\)/u);
  assert.match(storefront, /webapp\.openMode === "dialog"[\s\S]*?webs\.webapps\.openWindow\(itemId\)/u);
  assert.match(storefront, /launchWebsiteApp\(item\.webappId \|\| item\.id\)/u);
  assert.match(storefront, /webs\.webapps\.start\(itemId\)[\s\S]*?navigate\(`\/webs\/\$\{webapp\.entryKey\}`\)/u);
  assert.doesNotMatch(storefront, /item\.type === "website-app" && actionName !== "uninstall"[\s\S]*?launchWebsiteApp\(result\.itemId\)/u);
  assert.match(storefront, /item\.type === "website-app" && isInstalledMarketItem\(item\)[\s\S]*?market\.websiteApp\.open/u);
  assert.match(storefront, /installedWebsiteApp[\s\S]*?runMarketAction\(selectedDetailItem, "uninstall"\)/u);
  assert.doesNotMatch(
    storefront,
    /item\.type === "skill" \|\| item\.type === "pet" \|\| item\.type === "mcp" \|\| item\.type === "website-app"/u
  );
  assert.match(storefront, /window\.electronAPI\.webs\.onChanged/u);
  assert.match(storefront, /event\.phase === "disposing"/u);
  assert.match(storefront, /command\(\{ sections: \["websiteApps"\] \}\)/u);
  assert.match(storefront, /next\.items\.filter\(\(item\) => item\.type === "website-app"\)/u);
});

test("Market top navigation exposes only Skills and Website Apps", () => {
  const model = readSource("src", "renderer", "pages", "functional-market", "marketPageModel.ts");

  assert.match(model, /DEFAULT_MARKET_TAB:\s*MarketTab\s*=\s*"skills"/u);
  assert.match(model, /VISIBLE_MARKET_TABS:\s*readonly MarketTab\[\]\s*=\s*\["skills",\s*"websiteApps"\]/u);
  assert.match(model, /return VISIBLE_MARKET_TABS\.map/u);
});

test("Market polls pending MCP runtime status without refreshing unrelated sections", () => {
  const storefront = readSource("src", "renderer", "pages", "functional-market", "StorefrontMarket.tsx");

  assert.match(storefront, /pendingMcpRuntimeSignature/u);
  assert.match(storefront, /activeTab !== "mcps" \|\| !pendingMcpRuntimeSignature/u);
  assert.match(storefront, /command\(\{ sections: \["mcps"\] \}\)/u);
  assert.match(storefront, /MCP_STATUS_POLL_INTERVAL_MS = 2_000/u);
  assert.match(storefront, /window\.setInterval\(\(\) => void poll\(\), MCP_STATUS_POLL_INTERVAL_MS\)/u);
  assert.match(storefront, /window\.clearInterval\(timer\)/u);
  assert.match(storefront, /item\.mcpRuntimeStatus === "configuration-written" \|\| item\.mcpRuntimeStatus === "pending"/u);
  assert.match(storefront, /MCP_STATUS_POLL_MAX_ATTEMPTS = 30/u);
  assert.match(storefront, /attempts >= MCP_STATUS_POLL_MAX_ATTEMPTS[\s\S]*?stopPolling\(\)/u);
});

test("market actions show progress and preserve success or error feedback after catalog refresh", () => {
  const storefront = readSource("src", "renderer", "pages", "functional-market", "StorefrontMarket.tsx");

  assert.match(storefront, /Boolean\(feedback\)\s*\|\|\s*Boolean\(marketOffline\s*&&\s*marketStatusMessage\)/u);
  assert.match(storefront, /actionName === "uninstall"[\s\S]*?market\.action\.uninstalling[\s\S]*?market\.action\.installing/u);
  assert.match(storefront, /const result = actionName === "uninstall"/u);
  assert.match(storefront, /await refreshEverything\(true, true\)[\s\S]*?setFeedbackType\("success"\)/u);
  assert.match(storefront, /setFeedback\(normalizeError\(reason\)\)[\s\S]*?setFeedbackType\("error"\)/u);
  assert.match(storefront, /type=\{feedback \? feedbackType : "warning"\}/u);
});

test("market install and update prompt for Desktop login before downloading", () => {
  const storefront = readSource("src", "renderer", "pages", "functional-market", "StorefrontMarket.tsx");

  assert.match(storefront, /actionName !== "uninstall"[\s\S]*?window\.electronAPI\.sso\.getStatus\(\)[\s\S]*?!status\.authenticated[\s\S]*?market\.storefront\.loginRequired[\s\S]*?return false/u);
  assert.match(storefront, /setFeedbackType\("warning"\)/u);
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
  assert.match(storefront, /market\.toolbar\.myFavorites/u);
  assert.match(storefront, /rangeMode\s*===\s*"favorites"[\s\S]*?item\.favorited/u);
  assert.match(storefront, /command\(\{\s*includeFavorites\s*\}\)/u);
  assert.match(storefront, /disabled=\{!isMarketAuthenticated\s*\|\|\s*isFavoriting/u);
  assert.match(storefront, /disabled=\{!isMarketAuthenticated\s*\|\|\s*isFavoriting\s*\|\|\s*Boolean\(favoritingItemKey\)\}/u);
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
  assert.match(storefront, /item\.type === "skill" && isInstalledMarketItem\(item\)[\s\S]*?icon=\{<MinusOutlined \/>\}[\s\S]*?runMarketAction\(item, "uninstall"\)/u);
});

test("skill toolbar provides local import and the create-skill assistant action", () => {
  const storefront = readSource("src", "renderer", "pages", "functional-market", "StorefrontMarket.tsx");
  const assistantStart = storefront.indexOf("async function openSkillAssistant");
  const assistantEnd = storefront.indexOf("function openPlugin", assistantStart);
  const assistantFlow = storefront.slice(assistantStart, assistantEnd);

  assert.match(storefront, /<Dropdown[\s\S]*?market\.toolbar\.addSkill/u);
  assert.doesNotMatch(storefront, /key:\s*"find"[\s\S]*?market\.skill\.menu\.find/u);
  assert.match(storefront, /key:\s*"import"[\s\S]*?market\.skill\.localImport/u);
  assert.match(storefront, /key:\s*"create"[\s\S]*?market\.skill\.menu\.create/u);
  assert.match(storefront, /composerDraft:\s*t\("market\.skill\.assistant\.draft"\)/u);
  assert.match(storefront, /composerSkill:\s*"skill-creator"/u);
  assert.doesNotMatch(storefront, /composerIntent/u);
  assert.doesNotMatch(storefront, /composerSkillKey/u);
  assert.doesNotMatch(storefront, /composerSkillLabel/u);
  assert.doesNotMatch(storefront, /find-skill/u);
  assert.match(storefront, /navigate\(createAgentWebclientAgentPath\(agentKey, search\)\)/u);
  assert.match(assistantFlow, /settings\.chatDefaultAgentKey\.trim\(\)/u);
  assert.doesNotMatch(assistantFlow, /desktopHelperAgentKey/u);
  assert.match(assistantFlow, /newChat:\s*String\(Date\.now\(\)\)/u);
  assert.doesNotMatch(storefront, /window\.electronAPI\.assistant\.startRun/u);
  assert.doesNotMatch(storefront, /renderSkillAssistantDialog/u);
});

test("skill detail category returns to the current skill list without resetting its filter", () => {
  const storefront = readSource("src", "renderer", "pages", "functional-market", "StorefrontMarket.tsx");

  assert.match(storefront, /selectedDetailItem\.type === "skill"[\s\S]*?market-store-detail-category-return[\s\S]*?setSelectedDetailItem\(null\)/u);
  assert.match(storefront, /className="market-store-detail-category-return"[\s\S]*?onClick=\{\(\) => setSelectedDetailItem\(null\)\}/u);
});

test("clicking the active Skills tab returns from installed items to the skill market", () => {
  const storefront = readSource("src", "renderer", "pages", "functional-market", "StorefrontMarket.tsx");

  assert.match(storefront, /function handleMarketTabChange\(tab: MarketTab\)[\s\S]*?tab === "skills" && activeTab === "skills"[\s\S]*?setRangeMode\("all"\)[\s\S]*?setSelectedDetailItem\(null\)[\s\S]*?onTabChange\(tab\)/u);
  assert.match(storefront, /<MarketPageFrame[\s\S]*?onTabChange=\{handleMarketTabChange\}/u);
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
