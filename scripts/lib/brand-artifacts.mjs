import fs from "node:fs";
import path from "node:path";
import {
  BRAND_RUNTIME_ASSET_DIR_NAME,
  BRAND_RUNTIME_ASSET_FILENAMES,
  loadBrandConfig,
  resolveBrandId,
  runtimeBrandPayload
} from "./brand-model.mjs";
import {
  brandBuildRelativePath,
  brandGeneratedDir,
  brandRendererDir,
  brandRuntimeAssetDir
} from "./brand-paths.mjs";

export function removeStaleRendererBuild({
  rootDir = process.cwd(),
  brandId = resolveBrandId(),
  brand = loadBrandConfig(rootDir, brandId)
} = {}) {
  const rendererRoot = brandRendererDir(rootDir, brand);
  if (!fs.existsSync(rendererRoot)) {
    return false;
  }

  const rendererIndexPath = path.join(rendererRoot, "index.html");
  const shouldRemove = !fs.existsSync(rendererIndexPath) || distRendererProblems(rootDir, brand).length > 0;
  if (!shouldRemove) {
    return false;
  }

  fs.rmSync(rendererRoot, { recursive: true, force: true });
  return true;
}

export function assertBrandArtifactsConsistent({
  rootDir = process.cwd(),
  brandId = resolveBrandId(),
  brand = loadBrandConfig(rootDir, brandId),
  checkDistRenderer = true
} = {}) {
  const problems = [
    ...generatedBrandProblems(rootDir, brand),
    ...rendererIndexProblems(rootDir, brand),
    ...brandRuntimeIconProblems(rootDir, brand),
    ...stalePublicBrandIconProblems(rootDir)
  ];

  if (checkDistRenderer) {
    problems.push(...distRendererProblems(rootDir, brand));
  }

  if (problems.length > 0) {
    throw new Error(`Brand artifact drift for ${brand.id}:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read JSON ${filePath}: ${message}`);
  }
}

function writeJson(filePath, value) {
  writeFileIfChanged(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFileIfChanged(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === content) {
    return false;
  }
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}

function escapeRegExp(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function assertFileExists(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return [`${label} is missing`];
  }
  return [];
}

function assertNonEmptyFile(filePath, label) {
  const existsProblems = assertFileExists(filePath, label);
  if (existsProblems.length > 0) {
    return existsProblems;
  }
  if (fs.statSync(filePath).size === 0) {
    return [`${label} is empty`];
  }
  return [];
}

function listForeignBrandMarkers(rootDir, activeBrandId) {
  const brandsRoot = path.join(rootDir, "brands");
  if (!fs.existsSync(brandsRoot)) {
    return [];
  }

  return fs.readdirSync(brandsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== activeBrandId)
    .flatMap((entry) => {
      const manifestPath = path.join(brandsRoot, entry.name, "brand.json");
      if (!fs.existsSync(manifestPath)) {
        return [];
      }
      const manifest = readJson(manifestPath);
      const productName = typeof manifest.productName === "string" ? manifest.productName.trim() : "";
      return [
        `${entry.name}-pet:`,
        `${entry.name}-website-favicon:`,
        ...(productName ? [`<title>${escapeHtmlText(productName)}</title>`] : [])
      ];
    });
}

function htmlBrandProblems(content, label, brand, rootDir) {
  const problems = [];
  const expectedTitle = `<title>${escapeHtmlText(brand.productName)}</title>`;
  if (!content.includes(expectedTitle)) {
    problems.push(`${label} does not contain ${expectedTitle}`);
  }

  const expectedPetProtocol = `${brand.id}-pet:`;
  const petProtocolPattern = new RegExp(`img-src[^"]*${escapeRegExp(expectedPetProtocol)}`, "u");
  if (!petProtocolPattern.test(content)) {
    problems.push(`${label} does not contain ${expectedPetProtocol} in img-src`);
  }

  const expectedWebsiteFaviconProtocol = `${brand.id}-website-favicon:`;
  const websiteFaviconProtocolPattern = new RegExp(`img-src[^"]*${escapeRegExp(expectedWebsiteFaviconProtocol)}`, "u");
  if (!websiteFaviconProtocolPattern.test(content)) {
    problems.push(`${label} does not contain ${expectedWebsiteFaviconProtocol} in img-src`);
  }

  for (const marker of listForeignBrandMarkers(rootDir, brand.id)) {
    if (content.includes(marker)) {
      problems.push(`${label} still contains foreign brand marker ${marker}`);
    }
  }

  return problems;
}

function generatedBrandProblems(rootDir, brand) {
  const problems = [];
  const generatedDir = brandGeneratedDir(rootDir, brand);
  const generatedJsonPath = path.join(generatedDir, "brand.json");
  const generatedTsPath = path.join(generatedDir, "brand.ts");
  const generatedJsonLabel = path.relative(rootDir, generatedJsonPath).replace(/\\/gu, "/");
  const generatedTsLabel = path.relative(rootDir, generatedTsPath).replace(/\\/gu, "/");

  const jsonExistsProblems = assertFileExists(generatedJsonPath, generatedJsonLabel);
  problems.push(...jsonExistsProblems);
  if (jsonExistsProblems.length === 0) {
    const generatedJson = readJson(generatedJsonPath);
    if (generatedJson.id !== brand.id) {
      problems.push(`${generatedJsonLabel} id is ${generatedJson.id}, expected ${brand.id}`);
    }
    if (generatedJson.productName !== brand.productName) {
      problems.push(
        `${generatedJsonLabel} productName is ${generatedJson.productName}, expected ${brand.productName}`
      );
    }
  }

  const tsExistsProblems = assertFileExists(generatedTsPath, generatedTsLabel);
  problems.push(...tsExistsProblems);
  if (tsExistsProblems.length === 0) {
    const generatedTs = fs.readFileSync(generatedTsPath, "utf8");
    if (!generatedTs.includes(`"id": "${brand.id}"`)) {
      problems.push(`${generatedTsLabel} does not contain id ${brand.id}`);
    }
    if (!generatedTs.includes(`"productName": "${brand.productName}"`)) {
      problems.push(`${generatedTsLabel} does not contain productName ${brand.productName}`);
    }
  }

  return problems;
}

function rendererIndexProblems(rootDir, brand) {
  const indexPath = path.join(rootDir, "index.html");
  const existsProblems = assertFileExists(indexPath, "index.html");
  if (existsProblems.length > 0) {
    return existsProblems;
  }
  return htmlBrandProblems(
    renderRendererIndexHtml(fs.readFileSync(indexPath, "utf8"), brand),
    "rendered index.html",
    brand,
    rootDir
  );
}

function filesHaveSameBytes(leftPath, rightPath) {
  return Buffer.compare(fs.readFileSync(leftPath), fs.readFileSync(rightPath)) === 0;
}

function listRelativeFiles(rootDir) {
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    return [];
  }

  const result = [];
  const visit = (currentDir, relativeDir) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const filePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath, relativePath);
        continue;
      }
      if (entry.isFile()) {
        result.push(relativePath);
      }
    }
  };

  visit(rootDir, "");
  return result;
}

function desktopPetDistProblems(rootDir, brand) {
  const sourceRoot = path.join(rootDir, brand.source.desktopPetRoot);
  const rendererRelativePath = brandBuildRelativePath(brand, "renderer");
  const distRoot = path.join(rootDir, rendererRelativePath, "desktop-pet");
  if (!fs.existsSync(distRoot) || !fs.statSync(distRoot).isDirectory()) {
    return [`${rendererRelativePath}/desktop-pet is missing for ${brand.id}`];
  }

  const problems = [];
  const sourceFiles = listRelativeFiles(sourceRoot);
  const distFiles = listRelativeFiles(distRoot);
  const sourceFileSet = new Set(sourceFiles);
  const distFileSet = new Set(distFiles);
  const missingFiles = sourceFiles.filter((fileName) => !distFileSet.has(fileName));
  const unexpectedFiles = distFiles.filter((fileName) => !sourceFileSet.has(fileName));

  if (missingFiles.length > 0) {
    problems.push(`${rendererRelativePath}/desktop-pet is missing ${missingFiles.join(", ")} from ${brand.source.desktopPetRoot}`);
  }
  if (unexpectedFiles.length > 0) {
    problems.push(`${rendererRelativePath}/desktop-pet has stale files for ${brand.id}: ${unexpectedFiles.join(", ")}`);
  }

  for (const fileName of sourceFiles) {
    if (!distFileSet.has(fileName)) {
      continue;
    }
    const sourcePath = path.join(sourceRoot, fileName);
    const distPath = path.join(distRoot, fileName);
    if (!filesHaveSameBytes(sourcePath, distPath)) {
      problems.push(`${rendererRelativePath}/desktop-pet/${fileName} does not match ${brand.source.desktopPetRoot}/${fileName}`);
    }
  }

  return problems;
}

function distRendererProblems(rootDir, brand) {
  const rendererRoot = brandRendererDir(rootDir, brand);
  const rendererRelativePath = brandBuildRelativePath(brand, "renderer");
  if (!fs.existsSync(rendererRoot)) {
    return [];
  }

  const problems = [];
  const distRendererIndexPath = path.join(rendererRoot, "index.html");
  const indexExistsProblems = assertFileExists(distRendererIndexPath, `${rendererRelativePath}/index.html`);
  problems.push(...indexExistsProblems);
  if (indexExistsProblems.length === 0) {
    problems.push(
      ...htmlBrandProblems(
        fs.readFileSync(distRendererIndexPath, "utf8"),
        `${rendererRelativePath}/index.html`,
        brand,
        rootDir
      )
    );
  }

  const distTrayIconSvgPath = path.join(rendererRoot, "tray-icon.svg");
  const generatedTrayIconSvgPath = path.join(brandRuntimeAssetDir(rootDir, brand), "tray-icon.svg");
  if (
    fs.existsSync(distTrayIconSvgPath) &&
    fs.existsSync(generatedTrayIconSvgPath) &&
    !filesHaveSameBytes(distTrayIconSvgPath, generatedTrayIconSvgPath)
  ) {
    problems.push(`${rendererRelativePath}/tray-icon.svg does not match ${brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "tray-icon.svg")}`);
  }

  for (const fileName of BRAND_RUNTIME_ASSET_FILENAMES) {
    const generatedPath = path.join(brandRuntimeAssetDir(rootDir, brand), fileName);
    const distPath = path.join(rendererRoot, fileName);
    if (fs.existsSync(generatedPath) && fs.existsSync(distPath) && !filesHaveSameBytes(generatedPath, distPath)) {
      problems.push(`${rendererRelativePath}/${fileName} does not match ${brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, fileName)}`);
    }
  }

  problems.push(...desktopPetDistProblems(rootDir, brand));

  return problems;
}

function brandRuntimeIconProblems(rootDir, brand) {
  const problems = [];
  const generatedAssetRoot = brandRuntimeAssetDir(rootDir, brand);
  const generatedTrayIconSvgPath = path.join(generatedAssetRoot, "tray-icon.svg");
  const brandTrayIconSvgPath = path.join(rootDir, brand.icons.trayIconSvg);

  problems.push(
    ...assertNonEmptyFile(
      path.join(generatedAssetRoot, "brand-icon.png"),
      brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "brand-icon.png")
    ),
    ...assertNonEmptyFile(
      path.join(generatedAssetRoot, "brand-mark.png"),
      brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "brand-mark.png")
    ),
    ...assertNonEmptyFile(
      path.join(generatedAssetRoot, "tray-icon.png"),
      brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "tray-icon.png")
    ),
    ...assertFileExists(generatedTrayIconSvgPath, brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "tray-icon.svg"))
  );

  if (fs.existsSync(generatedTrayIconSvgPath)) {
    const generatedTrayIconSvg = fs.readFileSync(generatedTrayIconSvgPath, "utf8");
    const brandTrayIconSvg = fs.readFileSync(brandTrayIconSvgPath, "utf8");
    if (generatedTrayIconSvg !== brandTrayIconSvg) {
      problems.push(`${brandBuildRelativePath(brand, BRAND_RUNTIME_ASSET_DIR_NAME, "tray-icon.svg")} does not match ${brand.icons.trayIconSvg}`);
    }
  }

  return problems;
}

function stalePublicBrandIconProblems(rootDir) {
  return BRAND_RUNTIME_ASSET_FILENAMES
    .map((fileName) => path.join(rootDir, "public", fileName))
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => `${path.relative(rootDir, filePath)} is stale; active brand icons live under ${BRAND_BUILD_ROOT_DIR}/<brand>/${BRAND_RUNTIME_ASSET_DIR_NAME}`);
}

function containsPath(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function copyBrandDesktopPetAssets({
  rootDir = process.cwd(),
  brandId = resolveBrandId(),
  brand = loadBrandConfig(rootDir, brandId),
  outputDir
} = {}) {
  if (typeof outputDir !== "string" || !outputDir.trim()) {
    throw new Error("copyBrandDesktopPetAssets requires outputDir");
  }

  const sourceRoot = path.resolve(rootDir, brand.source.desktopPetRoot);
  const targetRoot = path.resolve(outputDir);
  if (containsPath(sourceRoot, targetRoot) || containsPath(targetRoot, sourceRoot)) {
    throw new Error(
      `Refusing to copy desktop pet assets between overlapping paths: ${sourceRoot} -> ${targetRoot}`
    );
  }

  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
  fs.cpSync(sourceRoot, targetRoot, {
    recursive: true,
    force: true
  });
  return targetRoot;
}

export function cleanupPublicBrandIconArtifacts(rootDir = process.cwd()) {
  for (const fileName of BRAND_RUNTIME_ASSET_FILENAMES) {
    fs.rmSync(path.join(rootDir, "public", fileName), { force: true });
  }
}

export function copyBrandRuntimeIconAssets({
  rootDir = process.cwd(),
  brandId = resolveBrandId(),
  brand = loadBrandConfig(rootDir, brandId),
  outputDir
} = {}) {
  if (typeof outputDir !== "string" || !outputDir.trim()) {
    throw new Error("copyBrandRuntimeIconAssets requires outputDir");
  }

  const sourceRoot = path.resolve(brandRuntimeAssetDir(rootDir, brand));
  const targetRoot = path.resolve(outputDir);
  if (containsPath(sourceRoot, targetRoot) || containsPath(targetRoot, sourceRoot)) {
    throw new Error(
      `Refusing to copy brand runtime icon assets between overlapping paths: ${sourceRoot} -> ${targetRoot}`
    );
  }

  for (const fileName of BRAND_RUNTIME_ASSET_FILENAMES) {
    const sourcePath = path.join(sourceRoot, fileName);
    const targetPath = path.join(targetRoot, fileName);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      throw new Error(`Missing generated brand runtime asset: ${path.relative(rootDir, sourcePath)}`);
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
  return targetRoot;
}

export function writeGeneratedBrandFiles(rootDir, brand) {
  const payload = runtimeBrandPayload(brand);
  const generatedRoot = brandGeneratedDir(rootDir, brand);
  writeJson(path.join(generatedRoot, "brand.json"), payload);
  writeFileIfChanged(
    path.join(generatedRoot, "brand.ts"),
    [
      `export const APP_BRAND = ${JSON.stringify(payload, null, 2)} as const;`,
      "",
      "export const BRAND_ID = APP_BRAND.id;",
      "export const PACKAGE_NAME = APP_BRAND.packageName;",
      "export const STORAGE_NAMESPACE = APP_BRAND.storageNamespace;",
      "export const PRODUCT_NAME = APP_BRAND.productName;",
      "export const APP_ID = APP_BRAND.appId;",
      "export const APP_DESCRIPTION = APP_BRAND.description;",
      "export const DESKTOP_OPEN_PROTOCOL_SCHEME = APP_BRAND.protocols.open.scheme;",
      "export const INSTALLER_SHUTDOWN_ARG = APP_BRAND.installer.shutdownArg;",
      ""
    ].join("\n")
  );
}

function rendererPetProtocol(brand) {
  return `${brand.id}-pet`;
}

function rendererWebsiteFaviconProtocol(brand) {
  return `${brand.id}-website-favicon`;
}

function rendererSsoAvatarProtocol(brand) {
  return `${brand.id}-sso-avatar`;
}

function escapeHtmlText(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function defaultRendererIndexHtml(brand) {
  return [
    "<!doctype html>",
    "<html lang=\"zh-CN\">",
    "  <head>",
    "    <meta charset=\"UTF-8\" />",
    "    <meta",
    "      http-equiv=\"Content-Security-Policy\"",
    `      content="default-src 'self'; img-src 'self' data: https: blob: ${rendererPetProtocol(brand)}: ${rendererWebsiteFaviconProtocol(brand)}: ${rendererSsoAvatarProtocol(brand)}:; style-src 'self' 'unsafe-inline'; script-src 'self' 'sha256-1A+skuNTj8C8No+iHcACVlvkZXoCJnwYQVZPZzmECDk='; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*; frame-src 'self' http://127.0.0.1:*;"`,
    "    />",
    "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />",
    `    <title>${escapeHtmlText(brand.productName)}</title>`,
    "  </head>",
    "  <body>",
    "    <div id=\"root\"></div>",
    "    <script type=\"module\" src=\"/src/renderer/main.tsx\"></script>",
    "  </body>",
    "</html>",
    ""
  ].join("\n");
}

export function renderRendererIndexHtml(content, brand) {
  const petProtocol = `${rendererPetProtocol(brand)}:`;
  const websiteFaviconProtocol = `${rendererWebsiteFaviconProtocol(brand)}:`;
  const ssoAvatarProtocol = `${rendererSsoAvatarProtocol(brand)}:`;
  let next = content.replace(/<title>[\s\S]*?<\/title>/u, () =>
    `<title>${escapeHtmlText(brand.productName)}</title>`
  );

  next = next.replace(/(img-src\s+)([^";]*)(;)/u, (_match, prefix, sources, suffix) => {
    const sourceList = String(sources)
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .filter((source) => !/^[a-z0-9][a-z0-9_-]*-(?:pet|website-favicon|sso-avatar):$/iu.test(source));
    sourceList.push(petProtocol);
    sourceList.push(websiteFaviconProtocol);
    sourceList.push(ssoAvatarProtocol);
    return `${prefix}${sourceList.join(" ")}${suffix}`;
  });

  return next;
}
