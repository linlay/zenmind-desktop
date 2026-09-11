import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const projectRoot = process.cwd();
const mainRoot = path.join(projectRoot, "src", "main");
const modulesRoot = path.join(mainRoot, "modules");
const MAX_IMPLEMENTATION_LINES = 1000;

function listSourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory()
      ? listSourceFiles(target)
      : /\.(?:ts|tsx)$/u.test(entry.name) && !entry.name.endsWith(".d.ts")
        ? [path.normalize(target)]
        : [];
  });
}

function relative(file) {
  return path.relative(projectRoot, file).split(path.sep).join("/");
}

function resolveRelativeModule(sourceFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(sourceFile), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx")
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.normalize(candidate);
  }
  return null;
}

function areaOf(file) {
  const parts = path.relative(mainRoot, file).split(path.sep);
  if (parts[0] === "modules" && parts[1]) return `modules/${parts[1]}`;
  if ((parts[0] === "infrastructure" || parts[0] === "support") && parts[1]) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function moduleNameOf(file) {
  const area = areaOf(file);
  return area.startsWith("modules/") ? area.slice("modules/".length) : null;
}

function stronglyConnectedComponents(nodes, edges) {
  let nextIndex = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  const visit = (node) => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of edges.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)));
      }
    }
    if (lowLinks.get(node) !== indices.get(node)) return;
    const component = [];
    while (stack.length > 0) {
      const current = stack.pop();
      onStack.delete(current);
      component.push(current);
      if (current === node) break;
    }
    components.push(component);
  };
  for (const node of nodes) if (!indices.has(node)) visit(node);
  return components.filter((component) =>
    component.length > 1 || (edges.get(component[0]) ?? new Set()).has(component[0])
  );
}

const errors = [];
const files = listSourceFiles(mainRoot);
const rootFiles = fs.readdirSync(mainRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name))
  .map((entry) => entry.name);
if (rootFiles.length !== 1 || rootFiles[0] !== "index.ts") {
  errors.push(`src/main root must contain only index.ts; found: ${rootFiles.sort().join(", ") || "none"}`);
}

const moduleDirectories = fs.readdirSync(modulesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
for (const moduleName of moduleDirectories) {
  if (!fs.existsSync(path.join(modulesRoot, moduleName, "index.ts"))) {
    errors.push(`modules/${moduleName} is missing its public index.ts`);
  }
}

const fileEdges = new Map(files.map((file) => [file, new Set()]));
const areaEdges = new Map();
for (const file of files) {
  const lineCount = fs.readFileSync(file, "utf8").split(/\r?\n/u).length;
  if (lineCount > MAX_IMPLEMENTATION_LINES) {
    errors.push(`${relative(file)} has ${lineCount} lines (limit ${MAX_IMPLEMENTATION_LINES})`);
  }
  const sourceText = fs.readFileSync(file, "utf8");
  if (/\bMainProcessContext\b/u.test(sourceText)) {
    errors.push(`${relative(file)} reintroduces the removed MainProcessContext service locator`);
  }
  if (/\blet\s+configured[A-Za-z0-9_]*Ports\b/u.test(sourceText)) {
    errors.push(`${relative(file)} stores integration ports in mutable module-global state`);
  }
  if (/\b(?:configure|get)[A-Za-z0-9_]*IntegrationPorts\b/u.test(sourceText)) {
    errors.push(`${relative(file)} exposes a global integration-port locator; inject ports explicitly`);
  }
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const sourceArea = areaOf(file);
  const sourceModule = moduleNameOf(file);
  const visit = (node) => {
    let specifier = null;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifier = node.moduleSpecifier.text;
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      specifier = node.arguments[0].text;
    }
    if (specifier) {
      const target = resolveRelativeModule(file, specifier);
      if (target && fileEdges.has(target)) {
        fileEdges.get(file).add(target);
        const targetArea = areaOf(target);
        if (sourceArea !== targetArea) {
          const targets = areaEdges.get(sourceArea) ?? new Set();
          targets.add(targetArea);
          areaEdges.set(sourceArea, targets);
        }
        const targetModule = moduleNameOf(target);
        if (sourceModule && targetArea === "app") {
          errors.push(`${relative(file)} must not depend on app/ (${specifier})`);
        }
        if ((sourceArea.startsWith("infrastructure/") || sourceArea.startsWith("support/")) && targetModule) {
          errors.push(`${relative(file)} must not depend on business module ${targetModule} (${specifier})`);
        }
        if (targetModule && sourceModule !== targetModule) {
          const publicEntry = path.join(modulesRoot, targetModule, "index.ts");
          if (path.normalize(target) !== path.normalize(publicEntry)) {
            errors.push(`${relative(file)} deep-imports module ${targetModule} via ${specifier}`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

for (const component of stronglyConnectedComponents(files, fileEdges)) {
  errors.push(`file dependency cycle: ${component.map(relative).sort().join(" -> ")}`);
}
const areas = new Set(files.map(areaOf));
for (const component of stronglyConnectedComponents(areas, areaEdges)) {
  const members = new Set(component);
  const cycleEdges = component.sort().flatMap((source) =>
    [...(areaEdges.get(source) ?? [])]
      .filter((target) => members.has(target))
      .sort()
      .map((target) => `${source} -> ${target}`)
  );
  errors.push(`module dependency cycle: ${cycleEdges.join(", ")}`);
}

if (errors.length > 0) {
  console.error(`Main architecture check failed with ${errors.length} violation(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Main architecture check passed: ${files.length} source files, ${moduleDirectories.length} modules.`);
}
