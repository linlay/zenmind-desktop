import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import prefixSelector from "postcss-prefix-selector";

const projectRoot = process.cwd();
const inputPath = path.join(projectRoot, "src", "renderer", "assistant-webclient", "shared", "styles", "globals.css");
const outputPath = path.join(projectRoot, "src", "renderer", "assistant-webclient", "shared", "styles", "globals.native.css");
const prefix = ".assistant-native-root";

function transformSelector(selector, prefixedSelector) {
  const trimmed = selector.trim();

  if (trimmed.startsWith(":root")) {
    return trimmed.replace(/^:root\b/u, prefix);
  }

  if (trimmed.startsWith("html")) {
    return trimmed
      .replace(/^html((?:\[[^\]]+\])*)\s+body\b/u, `${prefix}$1`)
      .replace(/^html((?:\[[^\]]+\])*)\b/u, `${prefix}$1`);
  }

  if (trimmed.startsWith("body")) {
    return trimmed.replace(/^body\b/u, prefix);
  }

  return prefixedSelector;
}

const expandAmpersandNesting = {
  postcssPlugin: "expand-ampersand-nesting",
  Once(root) {
    const nestedRules = [];

    root.walkRules((rule) => {
      if (rule.parent?.type !== "rule" || !rule.selector.includes("&")) {
        return;
      }
      nestedRules.push(rule);
    });

    for (const rule of nestedRules) {
      const parentRule = rule.parent;
      if (parentRule?.type !== "rule") {
        continue;
      }

      const parentSelectors = parentRule.selectors ?? [parentRule.selector];
      const childSelectors = rule.selectors ?? [rule.selector];
      const resolvedSelectors = [];

      for (const parentSelector of parentSelectors) {
        for (const childSelector of childSelectors) {
          resolvedSelectors.push(childSelector.replaceAll("&", parentSelector));
        }
      }

      parentRule.after(
        rule.clone({
          selectors: resolvedSelectors
        })
      );
      rule.remove();
    }
  }
};

const source = fs.readFileSync(inputPath, "utf8");
const result = await postcss([
  expandAmpersandNesting,
  prefixSelector({
    prefix,
    transform(prefixValue, selector, prefixedSelector) {
      void prefixValue;
      return transformSelector(selector, prefixedSelector);
    }
  })
]).process(source, { from: inputPath, to: outputPath });

fs.writeFileSync(outputPath, `${result.css}\n`, "utf8");
console.log(`generated ${path.relative(projectRoot, outputPath)}`);
