import { DEFAULT_LOCALE, type SupportedLocale } from "../../shared/i18n";

export type HelpContentItem = {
  id: string;
  title: string;
  markdown: string;
};

export type HelpContentCategory = {
  id: string;
  label: string;
  items: HelpContentItem[];
};

export type HelpContentDocument = {
  locale: SupportedLocale;
  sidebarTitle: string;
  heroTitle: string;
  heroDescription: string;
  categories: HelpContentCategory[];
};

type HelpContentIndexItem = {
  id: string;
  title: string;
  file: string;
};

type HelpContentIndexCategory = {
  id: string;
  label: string;
  items: HelpContentIndexItem[];
};

type HelpContentIndex = {
  sidebarTitle: string;
  heroTitle: string;
  heroDescription: string;
  categories: HelpContentIndexCategory[];
};

type HelpTemplateVariables = {
  pluginArchiveLabel: string;
  pluginArchiveCommand: string;
};

const indexModules = import.meta.glob("../../../help-content/**/index.json", {
  eager: true,
  import: "default",
  query: "?raw"
}) as Record<string, string>;

const markdownModules = import.meta.glob("../../../help-content/**/*.md", {
  eager: true,
  import: "default",
  query: "?raw"
}) as Record<string, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string, context: string) {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid help content: ${context}.${key} must be a non-empty string.`);
  }
  return value;
}

function parseHelpContentIndex(raw: string, context: string): HelpContentIndex {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value)) {
    throw new Error(`Invalid help content: ${context} must be an object.`);
  }

  const rawCategories = value.categories;
  if (!Array.isArray(rawCategories)) {
    throw new Error(`Invalid help content: ${context}.categories must be an array.`);
  }

  return {
    sidebarTitle: readString(value, "sidebarTitle", context),
    heroTitle: readString(value, "heroTitle", context),
    heroDescription: readString(value, "heroDescription", context),
    categories: rawCategories.map((categoryValue, categoryIndex) => {
      const categoryContext = `${context}.categories[${categoryIndex}]`;
      if (!isRecord(categoryValue)) {
        throw new Error(`Invalid help content: ${categoryContext} must be an object.`);
      }

      const rawItems = categoryValue.items;
      if (!Array.isArray(rawItems)) {
        throw new Error(`Invalid help content: ${categoryContext}.items must be an array.`);
      }

      return {
        id: readString(categoryValue, "id", categoryContext),
        label: readString(categoryValue, "label", categoryContext),
        items: rawItems.map((itemValue, itemIndex) => {
          const itemContext = `${categoryContext}.items[${itemIndex}]`;
          if (!isRecord(itemValue)) {
            throw new Error(`Invalid help content: ${itemContext} must be an object.`);
          }
          return {
            id: readString(itemValue, "id", itemContext),
            title: readString(itemValue, "title", itemContext),
            file: readString(itemValue, "file", itemContext)
          };
        })
      };
    })
  };
}

function modulePathForLocale(locale: SupportedLocale, file: string) {
  return `../../../help-content/${locale}/${file}`;
}

function getHelpTemplateVariables(isWindows: boolean): HelpTemplateVariables {
  if (isWindows) {
    return {
      pluginArchiveLabel: ".zip",
      pluginArchiveCommand: "Compress-Archive -LiteralPath .\\my-plugin -DestinationPath .\\my-plugin.zip"
    };
  }

  return {
    pluginArchiveLabel: ".tar.gz",
    pluginArchiveCommand: "tar -czf my-plugin.tar.gz -C /path/to my-plugin/"
  };
}

export function applyHelpTemplateVariables(markdown: string, variables: HelpTemplateVariables) {
  return markdown.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/gu, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key)
      ? variables[key as keyof HelpTemplateVariables]
      : match;
  });
}

function buildHelpContent(locale: SupportedLocale, isWindows: boolean): HelpContentDocument | null {
  const indexPath = modulePathForLocale(locale, "index.json");
  const rawIndex = indexModules[indexPath];
  if (!rawIndex) {
    return null;
  }

  const parsedIndex = parseHelpContentIndex(rawIndex, indexPath);
  const variables = getHelpTemplateVariables(isWindows);

  return {
    locale,
    sidebarTitle: parsedIndex.sidebarTitle,
    heroTitle: parsedIndex.heroTitle,
    heroDescription: parsedIndex.heroDescription,
    categories: parsedIndex.categories.map((category) => ({
      id: category.id,
      label: category.label,
      items: category.items.map((item) => {
        const markdownPath = modulePathForLocale(locale, item.file);
        const rawMarkdown = markdownModules[markdownPath];
        if (typeof rawMarkdown !== "string") {
          throw new Error(`Invalid help content: missing markdown file ${markdownPath}.`);
        }
        return {
          id: item.id,
          title: item.title,
          markdown: applyHelpTemplateVariables(rawMarkdown, variables)
        };
      })
    }))
  };
}

export function getHelpContent(locale: SupportedLocale, isWindows: boolean): HelpContentDocument {
  return (
    buildHelpContent(locale, isWindows) ??
    buildHelpContent(DEFAULT_LOCALE, isWindows) ??
    {
      locale: DEFAULT_LOCALE,
      sidebarTitle: "Help",
      heroTitle: "Help",
      heroDescription: "",
      categories: []
    }
  );
}
