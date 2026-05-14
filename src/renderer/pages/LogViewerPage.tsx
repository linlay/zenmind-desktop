import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import type {
  ServiceId,
  ServiceLogStreamEvent,
  ServiceLogTarget
} from "@shared/contracts";
import { useServices } from "../services/ServicesContext";

type LogPage = {
  startOffset: number;
  endOffset: number;
  content: string;
};

type LogMatch = {
  start: number;
  end: number;
};

type LogViewerState = {
  loadingInitial: boolean;
  loadingPrevious: boolean;
  serviceId: ServiceId | null;
  target: ServiceLogTarget;
  title: string;
  exists: boolean;
  pages: LogPage[];
  hasPrevious: boolean;
  totalBytes: number;
  query: string;
  error: string;
  notice: string;
  streaming: boolean;
};

function createEmptyLogViewerState(): LogViewerState {
  return {
    loadingInitial: false,
    loadingPrevious: false,
    serviceId: null,
    target: "main",
    title: "",
    exists: false,
    pages: [],
    hasPrevious: false,
    totalBytes: 0,
    query: "",
    error: "",
    notice: "",
    streaming: false
  };
}

function buildLogPages(result: { exists: boolean; content: string; startOffset: number; endOffset: number }): LogPage[] {
  if (!result.exists || result.content.length === 0) {
    return [];
  }

  return [
    {
      startOffset: result.startOffset,
      endOffset: result.endOffset,
      content: result.content
    }
  ];
}

function findLogMatches(content: string, query: string): LogMatch[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const normalizedContent = content.toLowerCase();
  const matches: LogMatch[] = [];
  let searchFrom = 0;

  while (searchFrom < normalizedContent.length) {
    const index = normalizedContent.indexOf(normalizedQuery, searchFrom);
    if (index === -1) {
      break;
    }

    matches.push({ start: index, end: index + normalizedQuery.length });
    searchFrom = index + normalizedQuery.length;
  }

  return matches;
}

function renderLogContent(content: string, matches: LogMatch[], activeMatchIndex: number): ReactNode {
  if (content.length === 0 || matches.length === 0) {
    return content;
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;

  matches.forEach((match, index) => {
    if (match.start > cursor) {
      nodes.push(
        <span key={`chunk-${cursor}`}>
          {content.slice(cursor, match.start)}
        </span>
      );
    }

    nodes.push(
      <mark
        key={`match-${match.start}`}
        className={`log-match${index === activeMatchIndex ? " is-active" : ""}`}
        data-match-index={index}
      >
        {content.slice(match.start, match.end)}
      </mark>
    );
    cursor = match.end;
  });

  if (cursor < content.length) {
    nodes.push(
      <span key={`chunk-${cursor}`}>
        {content.slice(cursor)}
      </span>
    );
  }

  return nodes;
}

function normalizeLogTarget(value: string | null): ServiceLogTarget {
  return value === "error" ? "error" : "main";
}

function isMacFindShortcut(event: KeyboardEvent) {
  return event.key.toLowerCase() === "f" && event.metaKey && !event.ctrlKey && !event.altKey;
}

function isWindowsFindShortcut(event: KeyboardEvent) {
  return event.key.toLowerCase() === "f" && event.ctrlKey && !event.metaKey && !event.altKey;
}

export function LogViewerPage() {
  const [searchParams] = useSearchParams();
  const { readLog, watchLog } = useServices();
  const serviceId = searchParams.get("serviceId")?.trim() || "";
  const target = normalizeLogTarget(searchParams.get("target"));
  const title = searchParams.get("title")?.trim() || "日志文件";
  const requestKey = `${serviceId}:${target}:${title}`;
  const requestIdRef = useRef(0);
  const watchCleanupRef = useRef<(() => void) | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLPreElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const pendingMatchStartRef = useRef<number | null | undefined>(undefined);
  const shouldFollowTailRef = useRef(true);
  const [state, setState] = useState<LogViewerState>(() => createEmptyLogViewerState());
  const [searchVisible, setSearchVisible] = useState(false);
  const deferredQuery = useDeferredValue(state.query);
  const joinedContent = useMemo(() => state.pages.map((page) => page.content).join(""), [state.pages]);
  const matches = useMemo(() => findLogMatches(joinedContent, deferredQuery), [joinedContent, deferredQuery]);
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);

  useEffect(() => {
    if (!serviceId) {
      requestIdRef.current += 1;
      watchCleanupRef.current?.();
      watchCleanupRef.current = null;
      setState({
        ...createEmptyLogViewerState(),
        title,
        target,
        error: "缺少日志服务标识。"
      });
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    watchCleanupRef.current?.();
    watchCleanupRef.current = null;
    shouldFollowTailRef.current = true;
    setSearchVisible(false);
    setState({
      ...createEmptyLogViewerState(),
      loadingInitial: true,
      serviceId,
      target,
      title
    });

    readLog(serviceId, target)
      .then((result) => {
        if (requestIdRef.current !== requestId) {
          return;
        }

        setState({
          ...createEmptyLogViewerState(),
          loadingInitial: false,
          serviceId,
          target,
          title,
          exists: result.exists,
          pages: buildLogPages(result),
          hasPrevious: result.hasPrevious,
          totalBytes: result.totalBytes
        });

        watchCleanupRef.current = watchLog(serviceId, target, { fromOffset: result.endOffset }, (event) => {
          if (requestIdRef.current !== requestId) {
            return;
          }
          applyLogStreamEvent(event);
        });
        setState((current) => ({
          ...current,
          streaming: true
        }));
      })
      .catch((reason) => {
        if (requestIdRef.current !== requestId) {
          return;
        }

        setState({
          ...createEmptyLogViewerState(),
          loadingInitial: false,
          serviceId,
          target,
          title,
          error: reason instanceof Error ? reason.message : String(reason)
        });
      });

    return () => {
      if (requestIdRef.current === requestId) {
        watchCleanupRef.current?.();
        watchCleanupRef.current = null;
      }
    };
  }, [readLog, requestKey, serviceId, target, title, watchLog]);

  useEffect(() => {
    return () => {
      requestIdRef.current += 1;
      watchCleanupRef.current?.();
      watchCleanupRef.current = null;
    };
  }, []);

  useEffect(() => {
    setActiveMatchIndex(searchVisible && matches.length > 0 ? 0 : -1);
  }, [deferredQuery, requestKey, searchVisible]);

  useEffect(() => {
    if (!searchVisible) {
      return;
    }
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [searchVisible]);

  useEffect(() => {
    const pendingMatchStart = pendingMatchStartRef.current;
    if (pendingMatchStart === undefined) {
      return;
    }

    pendingMatchStartRef.current = undefined;
    if (pendingMatchStart === null) {
      setActiveMatchIndex(matches.length > 0 ? 0 : -1);
      return;
    }

    const restoredIndex = matches.findIndex((match) => match.start === pendingMatchStart);
    if (restoredIndex >= 0) {
      setActiveMatchIndex(restoredIndex);
      return;
    }

    const nearestIndex = matches.findIndex((match) => match.start > pendingMatchStart);
    setActiveMatchIndex(nearestIndex >= 0 ? nearestIndex : matches.length > 0 ? matches.length - 1 : -1);
  }, [matches]);

  useEffect(() => {
    if (activeMatchIndex < 0) {
      return;
    }

    const activeMatch = contentRef.current?.querySelector(`[data-match-index="${activeMatchIndex}"]`);
    if (activeMatch instanceof HTMLElement) {
      activeMatch.scrollIntoView({
        block: "center",
        inline: "nearest"
      });
    }
  }, [activeMatchIndex]);

  useEffect(() => {
    if (!shouldFollowTailRef.current) {
      return;
    }

    window.requestAnimationFrame(() => {
      const scrollContainer = bodyRef.current;
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
    });
  }, [joinedContent.length]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isMacFindShortcut(event) && !isWindowsFindShortcut(event)) {
        return;
      }
      event.preventDefault();
      setSearchVisible(true);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  function applyLogStreamEvent(event: ServiceLogStreamEvent) {
    setState((current) => {
      if (current.serviceId !== event.serviceId || current.target !== event.target) {
        return current;
      }

      if (event.type === "error") {
        return {
          ...current,
          streaming: false,
          error: event.message || "日志实时输出中断。"
        };
      }

      if (event.type === "reset") {
        return {
          ...current,
          loadingInitial: false,
          loadingPrevious: false,
          exists: event.exists,
          pages: buildLogPages(event),
          hasPrevious: event.hasPrevious,
          totalBytes: event.totalBytes,
          streaming: true,
          error: "",
          notice: event.message || "日志已刷新到最新内容。"
        };
      }

      if (!event.exists || event.content.length === 0) {
        return {
          ...current,
          streaming: true,
          error: ""
        };
      }

      const nextPage: LogPage = {
        startOffset: event.startOffset,
        endOffset: event.endOffset,
        content: event.content
      };
      const pages = [...current.pages];
      const lastPage = pages[pages.length - 1];
      if (lastPage && lastPage.endOffset === event.startOffset) {
        pages[pages.length - 1] = {
          ...lastPage,
          endOffset: event.endOffset,
          content: `${lastPage.content}${event.content}`
        };
      } else {
        pages.push(nextPage);
      }

      return {
        ...current,
        exists: true,
        pages,
        hasPrevious: pages[0]?.startOffset ? pages[0].startOffset > 0 : event.hasPrevious,
        totalBytes: event.totalBytes,
        streaming: true,
        error: "",
        notice: current.notice === "日志已轮转，已刷新到最新内容。" ? "" : current.notice
      };
    });
  }

  async function loadPreviousLogPage() {
    if (
      !state.serviceId ||
      state.loadingInitial ||
      state.loadingPrevious ||
      !state.hasPrevious
    ) {
      return null;
    }

    const requestId = requestIdRef.current;
    const currentViewer = state;
    const beforeOffset = currentViewer.pages[0]?.startOffset ?? 0;

    setState((current) => ({
      ...current,
      loadingPrevious: true,
      error: "",
      notice: ""
    }));

    try {
      const result = await readLog(currentViewer.serviceId, currentViewer.target, {
        beforeOffset
      });
      if (requestIdRef.current !== requestId) {
        return null;
      }

      const replacementPages = buildLogPages(result);
      if (result.resetRequired) {
        setState({
          ...createEmptyLogViewerState(),
          loadingInitial: false,
          loadingPrevious: false,
          serviceId: currentViewer.serviceId,
          target: currentViewer.target,
          title: currentViewer.title,
          exists: result.exists,
          pages: replacementPages,
          hasPrevious: result.hasPrevious,
          totalBytes: result.totalBytes,
          query: currentViewer.query,
          notice: "日志已轮转，已刷新到最新内容。"
        });
        return {
          prependedLength: result.content.length,
          resetRequired: true
        };
      }

      const nextPages = !result.exists
        ? []
        : replacementPages.length > 0
          ? [...replacementPages, ...currentViewer.pages]
          : currentViewer.pages;
      setState({
        ...currentViewer,
        exists: result.exists,
        pages: nextPages,
        hasPrevious: result.hasPrevious,
        totalBytes: result.totalBytes,
        loadingInitial: false,
        loadingPrevious: false,
        error: "",
        notice: ""
      });
      return {
        prependedLength: replacementPages[0]?.content.length ?? 0,
        resetRequired: false
      };
    } catch (reason) {
      if (requestIdRef.current !== requestId) {
        return null;
      }

      setState((current) => ({
        ...current,
        loadingPrevious: false,
        error: reason instanceof Error ? reason.message : String(reason)
      }));
      return null;
    }
  }

  async function handleLoadPrevious() {
    if (state.loadingInitial || state.loadingPrevious || !state.hasPrevious) {
      return;
    }

    const currentActiveMatch = activeMatchIndex >= 0 ? matches[activeMatchIndex] : null;
    const scrollContainer = bodyRef.current;
    const previousScrollHeight = scrollContainer?.scrollHeight ?? 0;
    const previousScrollTop = scrollContainer?.scrollTop ?? 0;
    const result = await loadPreviousLogPage();
    if (!result) {
      return;
    }

    if (deferredQuery.trim()) {
      pendingMatchStartRef.current = result.resetRequired
        ? null
        : currentActiveMatch
          ? currentActiveMatch.start + result.prependedLength
          : null;
    }

    if (!result.resetRequired && scrollContainer) {
      window.requestAnimationFrame(() => {
        const nextScrollContainer = bodyRef.current;
        if (!nextScrollContainer) {
          return;
        }
        const nextScrollHeight = nextScrollContainer.scrollHeight;
        nextScrollContainer.scrollTop = previousScrollTop + (nextScrollHeight - previousScrollHeight);
      });
    }
  }

  function selectRelativeMatch(direction: 1 | -1) {
    if (matches.length === 0) {
      return;
    }
    setActiveMatchIndex((current) => {
      const nextIndex = current < 0 ? 0 : (current + direction + matches.length) % matches.length;
      return nextIndex;
    });
  }

  function handleBodyScroll() {
    const scrollContainer = bodyRef.current;
    if (!scrollContainer) {
      return;
    }

    const distanceFromBottom =
      scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
    shouldFollowTailRef.current = distanceFromBottom < 48;
  }

  function closeWindow() {
    void window.electronAPI.services.closeLogViewer();
  }

  const hasMatches = matches.length > 0;
  const hasLoadedContent = joinedContent.length > 0;
  const isPartialLoad = state.pages.length > 0 ? state.pages[0].startOffset > 0 : state.hasPrevious;
  const resultSummary =
    deferredQuery.trim().length > 0
      ? `${hasMatches ? activeMatchIndex + 1 : 0} / ${matches.length}`
      : "输入关键词检索";

  return (
    <main className="log-viewer-page">
      <section className="log-viewer-panel" aria-labelledby="log-viewer-title">
        <header className="log-viewer-head">
          <div className="log-viewer-copy">
            <h1 id="log-viewer-title">{state.title || title}</h1>
          </div>
          <button type="button" className="action-button log-viewer-close" onClick={closeWindow}>
            关闭
          </button>
        </header>

        {searchVisible ? (
          <div className="log-viewer-toolbar">
            <label className="log-viewer-search">
              <span>检索</span>
              <input
                ref={searchInputRef}
                type="search"
                value={state.query}
                onChange={(event) => setState((current) => ({ ...current, query: event.target.value }))}
                placeholder="输入关键词"
                disabled={state.loadingInitial || state.loadingPrevious}
              />
            </label>
            <div className="log-viewer-match-nav">
              <span>{resultSummary}</span>
              <button type="button" className="action-button" onClick={() => selectRelativeMatch(-1)} disabled={!hasMatches}>
                上一个
              </button>
              <button type="button" className="action-button" onClick={() => selectRelativeMatch(1)} disabled={!hasMatches}>
                下一个
              </button>
            </div>
          </div>
        ) : null}

        <div className="log-viewer-tip-row">
          <div className="log-viewer-tip">检索范围：已加载内容</div>
          {state.streaming ? <div className="log-viewer-tip is-live">实时输出中</div> : null}
          {isPartialLoad ? <div className="log-viewer-tip">当前仍有更早日志未加载。</div> : null}
        </div>
        {state.notice ? <div className="feedback-banner">{state.notice}</div> : null}
        {state.error ? <div className="feedback-banner warning-banner">{state.error}</div> : null}

        <div ref={bodyRef} className="log-viewer-body" onScroll={handleBodyScroll}>
          {state.loadingInitial ? <div className="loading-box">正在读取日志...</div> : null}
          {!state.loadingInitial && state.exists && (state.hasPrevious || state.loadingPrevious) ? (
            <div className="log-viewer-pagination">
              <button
                type="button"
                className="action-button"
                onClick={() => void handleLoadPrevious()}
                disabled={state.loadingPrevious}
              >
                {state.loadingPrevious ? "加载中..." : "加载更早日志"}
              </button>
            </div>
          ) : null}
          {!state.loadingInitial && state.exists && !state.hasPrevious && state.pages.length > 0 ? (
            <div className="log-viewer-pagination-hint">已到日志开头</div>
          ) : null}
          {!state.loadingInitial && !state.exists ? (
            <div className="log-viewer-empty">日志文件不存在或尚未生成。</div>
          ) : null}
          {!state.loadingInitial && state.exists && !hasLoadedContent ? (
            <div className="log-viewer-empty">日志文件为空。</div>
          ) : null}
          {!state.loadingInitial && state.exists && hasLoadedContent ? (
            <pre ref={contentRef} className="log-viewer-content">
              {renderLogContent(joinedContent, matches, activeMatchIndex)}
            </pre>
          ) : null}
        </div>

        <footer className="log-viewer-footer">
          <button type="button" className="action-button log-viewer-close" onClick={closeWindow}>
            关闭
          </button>
        </footer>
      </section>
    </main>
  );
}
