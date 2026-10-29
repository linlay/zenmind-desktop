import { FileExcelOutlined, FileImageOutlined, FileMarkdownOutlined, FileOutlined, FilePdfOutlined, FilePptOutlined, FileTextOutlined, FileWordOutlined, FileZipOutlined, Html5Outlined, PlayCircleOutlined } from "@ant-design/icons";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { DesktopArtifactRecord } from "../../../shared/artifacts";
import { artifactIdentity, artifactKey } from "./library-model";

export function createLibraryThumbnailLoader() {
  const cache = new Map<string, Promise<string | null>>();
  const queue: { run(): void; cancel(): void }[] = [];
  let running = 0, disposed = false;
  function pump() { while (!disposed && running < 2 && queue.length) { running++; queue.shift()!.run(); } }
  return {
    activate() { disposed = false; },
    load(item: DesktopArtifactRecord) {
      const key = `${artifactKey(item)}:${item.sha256}:${item.pushedAt}`;
      if (disposed) return Promise.resolve(null);
      const cached = cache.get(key); if (cached) return cached;
      const promise = new Promise<string | null>(resolve => {
        queue.push({ run: () => {
          void Promise.resolve().then(() => window.electronAPI.artifacts.thumbnail(artifactIdentity(item))).then(value => resolve(disposed ? null : value)).catch(() => resolve(null)).finally(() => { running--; pump(); });
        }, cancel: () => resolve(null) });
      });
      cache.set(key, promise);
      if (cache.size > 24) cache.delete(cache.keys().next().value!);
      pump(); return promise;
    },
    dispose() { disposed = true; cache.clear(); queue.splice(0).forEach(task => task.cancel()); },
  };
}
export const LibraryThumbnailContext = createContext<ReturnType<typeof createLibraryThumbnailLoader> | null>(null);
export function LibraryFileIcon({ item }: { item: DesktopArtifactRecord }) {
  const mime = item.mimeType.toLowerCase();
  const ext = item.name.toLowerCase().split(".").pop();
  if (item.category === "image") return <FileImageOutlined />;
  if (item.category === "web") return <Html5Outlined />;
  if (item.category === "archive") return <FileZipOutlined />;
  if (item.category === "media") return <PlayCircleOutlined />;
  if (mime.includes("pdf") || ext === "pdf") return <FilePdfOutlined />;
  if (mime.includes("spreadsheet") || ["xlsx", "xls", "csv"].includes(ext!)) return <FileExcelOutlined />;
  if (mime.includes("presentation") || ["ppt", "pptx"].includes(ext!)) return <FilePptOutlined />;
  if (mime.includes("word") || ["doc", "docx"].includes(ext!)) return <FileWordOutlined />;
  if (mime.includes("markdown") || ["md", "mdx"].includes(ext!)) return <FileMarkdownOutlined />;
  return item.category === "document" ? <FileTextOutlined /> : <FileOutlined />;
}
export function LibraryFileVisual({ item, detail = false }: { item: DesktopArtifactRecord; detail?: boolean }) {
  const loader = useContext(LibraryThumbnailContext);
  const [image, setImage] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const enabled = item.category === "image" && item.sourceState === "active" && item.contentState === "ready" && item.sizeBytes <= 3 * 1024 * 1024;
  useEffect(() => {
    setImage(null);
    if (!enabled || !loader) return;
    let alive = true, started = false;
    const load = () => { if (started) return; started = true; void loader.load(item).then(value => { if (alive) setImage(value); }); };
    if (detail || typeof IntersectionObserver === "undefined") load();
    const observer = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) load(); }) : null;
    if (ref.current) observer?.observe(ref.current);
    return () => { alive = false; observer?.disconnect(); };
  }, [loader, enabled, item.chatId, item.runId, item.artifactId, item.sha256, item.pushedAt, detail]);
  return <div ref={ref} className={`library-file-visual category-${item.category}`} aria-hidden="true">{enabled && image ? <img src={image} alt="" draggable={false} onError={() => setImage(null)} /> : <LibraryFileIcon item={item} />}</div>;
}
