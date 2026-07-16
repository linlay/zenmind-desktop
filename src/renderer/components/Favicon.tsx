import { useEffect, useState } from "react";
import { DESKTOP_WEBSITE_FAVICON_PROTOCOL } from "../../shared/website-favicon";

const SAFE_DATA_IMAGE_PATTERN =
  /^data:image\/(?:png|jpe?g|gif|webp|bmp|x-icon|vnd\.microsoft\.icon);/iu;

export function normalizeFaviconUrl(
  inputUrl: unknown,
  baseUrl?: string | null,
): string | null {
  if (typeof inputUrl !== "string") {
    return null;
  }

  const trimmedUrl = inputUrl.trim();
  if (!trimmedUrl) {
    return null;
  }

  if (SAFE_DATA_IMAGE_PATTERN.test(trimmedUrl)) {
    return trimmedUrl;
  }

  try {
    const parsedUrl = baseUrl
      ? new URL(trimmedUrl, baseUrl)
      : new URL(trimmedUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return parsedUrl.protocol === `${DESKTOP_WEBSITE_FAVICON_PROTOCOL}:`
        ? parsedUrl.toString()
        : null;
    }
    return parsedUrl.toString();
  } catch {
    return null;
  }
}

function getUrlHostname(url: string): string {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname.replace(/^www\./u, "");
  } catch {
    return "";
  }
}

export function getTabMonogram(title: string, url: string): string {
  const source = title.trim() || getUrlHostname(url);
  const match = source.match(/[A-Za-z0-9\u4e00-\u9fa5]/u);
  return match ? match[0].toUpperCase() : "\u00B7";
}

export function buildFallbackFaviconUrl(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return null;
    }
    return `${parsedUrl.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

export type FaviconProps = {
  title: string;
  url: string;
  faviconUrl?: string;
  className: string;
  allowOriginFallback?: boolean;
};

export type WebsiteFaviconCacheEntry = {
  websiteUrl: string;
  faviconUrl: string;
};

export type WebsiteFaviconCache = Readonly<Record<string, WebsiteFaviconCacheEntry>>;

export function Favicon({
  title,
  url,
  faviconUrl,
  className,
  allowOriginFallback = true,
}: FaviconProps) {
  const fallbackFaviconUrl = allowOriginFallback ? buildFallbackFaviconUrl(url) : null;
  const faviconCandidates = [
    normalizeFaviconUrl(faviconUrl, url),
    fallbackFaviconUrl,
  ].filter((candidate): candidate is string => Boolean(candidate));
  const faviconCandidateKey = faviconCandidates.join("\u0000");
  const [failedFaviconUrls, setFailedFaviconUrls] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const activeFaviconUrl = faviconCandidates.find(
    (candidate) => !failedFaviconUrls.has(candidate),
  );

  useEffect(() => {
    setFailedFaviconUrls(new Set());
  }, [faviconCandidateKey]);

  if (activeFaviconUrl) {
    return (
      <span className={`${className} has-image`} aria-hidden="true">
        <img
          src={activeFaviconUrl}
          alt=""
          draggable={false}
          onError={() => {
            setFailedFaviconUrls((current) => {
              if (current.has(activeFaviconUrl)) {
                return current;
              }
              const next = new Set(current);
              next.add(activeFaviconUrl);
              return next;
            });
          }}
        />
      </span>
    );
  }

  return (
    <span className={className} aria-hidden="true">
      {getTabMonogram(title, url)}
    </span>
  );
}
