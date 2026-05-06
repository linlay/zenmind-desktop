export const BUILTIN_BROWSER_SURFACE_ID = "chrome";
export const BUILTIN_BROWSER_SURFACE_LABEL = "Chrome";
export const BUILTIN_BROWSER_DEFAULT_URL = "https://www.google.com/";
export const BUILTIN_BROWSER_ROUTE = "/chrome";

export const BUILTIN_BROWSER_SEARCH_ENGINES = [
  {
    label: "谷歌",
    url: "https://www.google.com/",
    aliases: ["谷歌", "google", "google.com", "www.google.com"]
  },
  {
    label: "百度",
    url: "https://www.baidu.com/",
    aliases: ["百度", "baidu", "baidu.com", "www.baidu.com"]
  },
  {
    label: "必应",
    url: "https://www.bing.com/",
    aliases: ["必应", "bing", "bing.com", "www.bing.com"]
  }
] as const;

export function isBuiltinBrowserSurfaceTarget(target: string) {
  const normalized = target.trim().toLowerCase().replace(/^https?:\/\//u, "").replace(/^www\./u, "").replace(/\/+$/u, "");
  if (!normalized) {
    return false;
  }
  return (
    normalized === BUILTIN_BROWSER_SURFACE_ID ||
    normalized === BUILTIN_BROWSER_SURFACE_LABEL ||
    normalized === "browser" ||
    BUILTIN_BROWSER_SEARCH_ENGINES.some((engine) =>
      engine.aliases.some((alias) => {
        const compactAlias = alias.toLowerCase().replace(/^www\./u, "");
        return compactAlias === normalized || normalized.includes(compactAlias) || compactAlias.includes(normalized);
      })
    )
  );
}

export function resolveBuiltinBrowserUrl(target: string) {
  const normalized = target.trim().toLowerCase().replace(/^https?:\/\//u, "").replace(/^www\./u, "").replace(/\/+$/u, "");
  const engine = BUILTIN_BROWSER_SEARCH_ENGINES.find((candidate) =>
    candidate.aliases.some((alias) => {
      const compactAlias = alias.toLowerCase().replace(/^www\./u, "");
      return compactAlias === normalized || normalized.includes(compactAlias) || compactAlias.includes(normalized);
    })
  );
  return engine ? { label: engine.label, url: engine.url } : { label: BUILTIN_BROWSER_SURFACE_LABEL, url: BUILTIN_BROWSER_DEFAULT_URL };
}
