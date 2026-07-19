import {
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { SearchOutlined } from "@ant-design/icons";
import { useSearchParams } from "react-router-dom";
import type {
	DesktopLogTarget,
	LogViewerSource,
	ServiceId,
	ServiceLogReadResult,
	ServiceLogStreamEvent,
	ServiceLogTarget,
} from "@shared/contracts";
import { useServices } from "../services/ServicesContext";
import { useI18n } from "../i18n/useI18n";

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
	source: LogViewerSource;
	serviceId: ServiceId | null;
	target: ServiceLogTarget | DesktopLogTarget;
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

type LogScrollJumpTarget = "top" | "bottom" | null;

const LOG_TAIL_THRESHOLD_PX = 48;

function createEmptyLogViewerState(): LogViewerState {
	return {
		loadingInitial: false,
		loadingPrevious: false,
		source: "service",
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
		streaming: false,
	};
}

function buildLogPages(result: {
	exists: boolean;
	content: string;
	startOffset: number;
	endOffset: number;
}): LogPage[] {
	if (!result.exists || result.content.length === 0) {
		return [];
	}

	return [
		{
			startOffset: result.startOffset,
			endOffset: result.endOffset,
			content: result.content,
		},
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

function renderLogContent(
	content: string,
	matches: LogMatch[],
	activeMatchIndex: number,
): ReactNode {
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
				</span>,
			);
		}

		nodes.push(
			<mark
				key={`match-${match.start}`}
				className={`log-match${index === activeMatchIndex ? " is-active" : ""}`}
				data-match-index={index}
			>
				{content.slice(match.start, match.end)}
			</mark>,
		);
		cursor = match.end;
	});

	if (cursor < content.length) {
		nodes.push(
			<span key={`chunk-${cursor}`}>{content.slice(cursor)}</span>,
		);
	}

	return nodes;
}

function normalizeLogTarget(value: string | null): ServiceLogTarget | DesktopLogTarget {
	if (value === "error" || value === "kanban-ws") {
		return value;
	}
	return "main";
}

function normalizeLogViewerSource(value: string | null): LogViewerSource {
	return value === "desktop" ? "desktop" : "service";
}

function isMacFindShortcut(event: KeyboardEvent) {
	return (
		event.key.toLowerCase() === "f" &&
		event.metaKey &&
		!event.ctrlKey &&
		!event.altKey
	);
}

function isWindowsFindShortcut(event: KeyboardEvent) {
	return (
		event.key.toLowerCase() === "f" &&
		event.ctrlKey &&
		!event.metaKey &&
		!event.altKey
	);
}

const isMac = /Mac|iPhone|iPod|iPad/i.test(navigator.userAgent);


function ArrowUpwardIcon() {
	return (
		<svg
			width="22"
			height="22"
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			aria-hidden="true"
			focusable="false"
		>
			<path
				d="M12 19V5M5.5 11.5 12 5l6.5 6.5"
				stroke="currentColor"
				strokeWidth="2.6"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function ArrowDownwardIcon() {
	return (
		<svg
			width="22"
			height="22"
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			aria-hidden="true"
			focusable="false"
		>
			<path
				d="M12 5v14m6.5-6.5L12 19l-6.5-6.5"
				stroke="currentColor"
				strokeWidth="2.6"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function RotateAutoIcon() {
	return (
		<svg
			width="20"
			height="20"
			viewBox="0 -960 960 960"
			fill="currentColor"
			xmlns="http://www.w3.org/2000/svg"
			aria-hidden="true"
			focusable="false"
		>
			<path
				transform="translate(57.6 -57.6) scale(0.88)"
				d="M312-320h64l32-92h146l32 92h62L512-680h-64L312-320Zm114-144 52-150h4l52 150H426Zm54 384q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480h80q0 66 25 124.5t68.5 102q43.5 43.5 102 69T480-159q134 0 227-93t93-227q0-134-93-227t-227-93q-89 0-161.5 43.5T204-640h116v80H80v-240h80v80q55-73 138-116.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Z"
			/>
		</svg>
	);
}

export function LogViewerPage() {
	const [searchParams] = useSearchParams();
	const { readLog, watchLog } = useServices();
	const { t } = useI18n();
	const source = normalizeLogViewerSource(searchParams.get("source"));
	const serviceId = source === "desktop" ? "desktop" : searchParams.get("serviceId")?.trim() || "";
	const target = normalizeLogTarget(searchParams.get("target"));
	const title = searchParams.get("title")?.trim() || t("logViewer.titleFallback");
	const rotatedNotice = t("logViewer.notice.rotated");
	const requestKey = `${source}:${serviceId}:${target}:${title}`;
	const requestIdRef = useRef(0);
	const watchCleanupRef = useRef<(() => void) | null>(null);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLPreElement | null>(null);
	const searchInputRef = useRef<HTMLInputElement | null>(null);
	const pendingMatchStartRef = useRef<number | null | undefined>(undefined);
	const tailFollowEnabledRef = useRef(true);
	const scrollJumpTargetRef = useRef<LogScrollJumpTarget>(null);
	const previousScrollTopRef = useRef(0);
	const [state, setState] = useState<LogViewerState>(() =>
		createEmptyLogViewerState(),
	);
	const [searchVisible, setSearchVisible] = useState(false);
	const [tailFollowEnabled, setTailFollowEnabled] = useState(true);
	const [scrollJumpTarget, setScrollJumpTarget] =
		useState<LogScrollJumpTarget>(null);
	const deferredQuery = useDeferredValue(state.query);
	const joinedContent = useMemo(
		() => state.pages.map((page) => page.content).join(""),
		[state.pages],
	);
	const matches = useMemo(
		() => findLogMatches(joinedContent, deferredQuery),
		[joinedContent, deferredQuery],
	);
	const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
	const [isMaximized, setIsMaximized] = useState(false);

	useEffect(() => {
		if (typeof window.electronAPI?.services?.onLogViewerMaximized === "function") {
			const cleanup = window.electronAPI.services.onLogViewerMaximized((maximized) => {
				setIsMaximized(maximized);
			});
			return cleanup;
		}
	}, []);


	useEffect(() => {
		tailFollowEnabledRef.current = tailFollowEnabled;
	}, [tailFollowEnabled]);

	useEffect(() => {
		if (source === "service" && !serviceId) {
			requestIdRef.current += 1;
			watchCleanupRef.current?.();
			watchCleanupRef.current = null;
			tailFollowEnabledRef.current = true;
			previousScrollTopRef.current = 0;
			setTailFollowEnabled(true);
			setVisibleScrollJumpTarget(null);
			setState({
				...createEmptyLogViewerState(),
				source,
				title,
				target,
				error: t("logViewer.error.missingServiceId"),
			});
			return;
		}

		const requestId = requestIdRef.current + 1;
		requestIdRef.current = requestId;
		watchCleanupRef.current?.();
		watchCleanupRef.current = null;
		tailFollowEnabledRef.current = true;
		previousScrollTopRef.current = 0;
		setTailFollowEnabled(true);
		setVisibleScrollJumpTarget(null);
		setSearchVisible(false);
		setState({
			...createEmptyLogViewerState(),
			loadingInitial: true,
			source,
			serviceId,
			target,
			title,
		});

		const readInitialLog = source === "desktop"
			? window.electronAPI.diagnostics.readDesktopLog(target as DesktopLogTarget)
			: readLog(serviceId, target as ServiceLogTarget);

		readInitialLog
			.then((result) => {
				if (requestIdRef.current !== requestId) {
					return;
				}

				setState({
					...createEmptyLogViewerState(),
					loadingInitial: false,
					source,
					serviceId,
					target,
					title,
					exists: result.exists,
					pages: buildLogPages(result),
					hasPrevious: result.hasPrevious,
					totalBytes: result.totalBytes,
				});

				const handleLogStreamEvent = (event: ServiceLogStreamEvent) => {
					if (requestIdRef.current !== requestId) {
						return;
					}
					applyLogStreamEvent(event);
				};
				watchCleanupRef.current = source === "desktop"
					? window.electronAPI.diagnostics.watchDesktopLog(
						target as DesktopLogTarget,
						{ fromOffset: result.endOffset },
						handleLogStreamEvent,
					)
					: watchLog(
						serviceId,
						target as ServiceLogTarget,
						{ fromOffset: result.endOffset },
						handleLogStreamEvent,
					);
				setState((current) => ({
					...current,
					streaming: true,
				}));
			})
			.catch((reason) => {
				if (requestIdRef.current !== requestId) {
					return;
				}

				setState({
					...createEmptyLogViewerState(),
					loadingInitial: false,
					source,
					serviceId,
					target,
					title,
					error:
						reason instanceof Error
							? reason.message
							: String(reason),
				});
			});

		return () => {
			if (requestIdRef.current === requestId) {
				watchCleanupRef.current?.();
				watchCleanupRef.current = null;
			}
		};
	}, [readLog, requestKey, serviceId, source, target, title, watchLog, t]);

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

		const restoredIndex = matches.findIndex(
			(match) => match.start === pendingMatchStart,
		);
		if (restoredIndex >= 0) {
			setActiveMatchIndex(restoredIndex);
			return;
		}

		const nearestIndex = matches.findIndex(
			(match) => match.start > pendingMatchStart,
		);
		setActiveMatchIndex(
			nearestIndex >= 0
				? nearestIndex
				: matches.length > 0
					? matches.length - 1
					: -1,
		);
	}, [matches]);

	useEffect(() => {
		if (activeMatchIndex < 0) {
			return;
		}

		const activeMatch = contentRef.current?.querySelector(
			`[data-match-index="${activeMatchIndex}"]`,
		);
		if (activeMatch instanceof HTMLElement) {
			activeMatch.scrollIntoView({
				block: "center",
				inline: "nearest",
			});
		}
	}, [activeMatchIndex]);

	useEffect(() => {
		if (!tailFollowEnabledRef.current) {
			window.requestAnimationFrame(() => {
				if (scrollJumpTargetRef.current !== "top") {
					updateScrollToBottomButton();
				}
			});
			return;
		}

		scrollToLogBottom({ restoreFollow: false });
	}, [joinedContent.length]);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (!isMacFindShortcut(event) && !isWindowsFindShortcut(event)) {
				return;
			}
			event.preventDefault();
			handleOpenSearch();
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, []);

	function applyLogStreamEvent(event: ServiceLogStreamEvent) {
		setState((current) => {
			const eventSource = event.source || "service";
			if (
				current.source !== eventSource ||
				current.serviceId !== event.serviceId ||
				current.target !== event.target
			) {
				return current;
			}

			if (event.type === "error") {
				return {
					...current,
					streaming: false,
					error: event.message || t("logViewer.error.streamInterrupted"),
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
					notice: event.message || t("logViewer.notice.refreshed"),
				};
			}

			if (!event.exists || event.content.length === 0) {
				return {
					...current,
					streaming: true,
					error: "",
				};
			}

			const nextPage: LogPage = {
				startOffset: event.startOffset,
				endOffset: event.endOffset,
				content: event.content,
			};
			const pages = [...current.pages];
			const lastPage = pages[pages.length - 1];
			if (lastPage && lastPage.endOffset === event.startOffset) {
				pages[pages.length - 1] = {
					...lastPage,
					endOffset: event.endOffset,
					content: `${lastPage.content}${event.content}`,
				};
			} else {
				pages.push(nextPage);
			}

			return {
				...current,
				exists: true,
				pages,
				hasPrevious: pages[0]?.startOffset
					? pages[0].startOffset > 0
					: event.hasPrevious,
				totalBytes: event.totalBytes,
				streaming: true,
				error: "",
				notice:
					current.notice === rotatedNotice
						? ""
						: current.notice,
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
		const beforeOffset = currentViewer.pages[0]?.startOffset;
		if (!beforeOffset) {
			return null;
		}
		const serviceId = currentViewer.serviceId;
		if (currentViewer.source !== "desktop" && !serviceId) {
			return null;
		}

		setState((current) => ({
			...current,
			loadingPrevious: true,
			error: "",
			notice: "",
		}));

		try {
			let result: ServiceLogReadResult;
			if (currentViewer.source === "desktop") {
				result = await window.electronAPI.diagnostics.readDesktopLog(currentViewer.target as DesktopLogTarget, {
					beforeOffset,
				});
			} else {
				if (!serviceId) {
					return null;
				}
				result = await readLog(
					serviceId,
					currentViewer.target as ServiceLogTarget,
					{
						beforeOffset,
					},
				);
			}
			if (requestIdRef.current !== requestId) {
				return null;
			}

			const replacementPages = buildLogPages(result);
			if (result.resetRequired) {
				setState({
					...createEmptyLogViewerState(),
					loadingInitial: false,
					loadingPrevious: false,
					source: currentViewer.source,
					serviceId: currentViewer.serviceId,
					target: currentViewer.target,
					title: currentViewer.title,
					exists: result.exists,
					pages: replacementPages,
					hasPrevious: result.hasPrevious,
					totalBytes: result.totalBytes,
					query: currentViewer.query,
					notice: rotatedNotice,
				});
				return {
					prependedLength: result.content.length,
					resetRequired: true,
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
				notice: "",
			});
			return {
				prependedLength: replacementPages[0]?.content.length ?? 0,
				resetRequired: false,
			};
		} catch (reason) {
			if (requestIdRef.current !== requestId) {
				return null;
			}

			setState((current) => ({
				...current,
				loadingPrevious: false,
				error:
					reason instanceof Error ? reason.message : String(reason),
			}));
			return null;
		}
	}

	async function handleLoadPrevious() {
		if (
			state.loadingInitial ||
			state.loadingPrevious ||
			!state.hasPrevious
		) {
			return;
		}

		const currentActiveMatch =
			activeMatchIndex >= 0 ? matches[activeMatchIndex] : null;
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
				nextScrollContainer.scrollTop =
					previousScrollTop +
					(nextScrollHeight - previousScrollHeight);
			});
		}
	}

	function selectRelativeMatch(direction: 1 | -1) {
		if (matches.length === 0) {
			return;
		}
		setActiveMatchIndex((current) => {
			const nextIndex =
				current < 0
					? 0
					: (current + direction + matches.length) % matches.length;
			return nextIndex;
		});
	}

	function getDistanceFromBottom(scrollContainer: HTMLElement) {
		return Math.max(
			0,
			scrollContainer.scrollHeight -
				scrollContainer.scrollTop -
				scrollContainer.clientHeight,
		);
	}

	function getDistanceFromTop(scrollContainer: HTMLElement) {
		return Math.max(0, scrollContainer.scrollTop);
	}

	function setVisibleScrollJumpTarget(target: LogScrollJumpTarget) {
		scrollJumpTargetRef.current = target;
		setScrollJumpTarget(target);
	}

	function updateScrollToBottomButton(scrollContainer = bodyRef.current) {
		const shouldShowBottom = Boolean(
			scrollContainer &&
			getDistanceFromBottom(scrollContainer) > LOG_TAIL_THRESHOLD_PX,
		);
		setVisibleScrollJumpTarget(shouldShowBottom ? "bottom" : null);
	}

	function scrollToLogBottom(options: { restoreFollow?: boolean } = {}) {
		if (options.restoreFollow !== false) {
			tailFollowEnabledRef.current = true;
			setTailFollowEnabled(true);
		}

		window.requestAnimationFrame(() => {
			const scrollContainer = bodyRef.current;
			if (!scrollContainer) {
				return;
			}
			scrollContainer.scrollTop = scrollContainer.scrollHeight;
			previousScrollTopRef.current = scrollContainer.scrollTop;
			setVisibleScrollJumpTarget(null);
		});
	}

	function scrollToLogTop() {
		tailFollowEnabledRef.current = false;
		setTailFollowEnabled(false);

		window.requestAnimationFrame(() => {
			const scrollContainer = bodyRef.current;
			if (!scrollContainer) {
				return;
			}
			scrollContainer.scrollTop = 0;
			previousScrollTopRef.current = 0;
			setVisibleScrollJumpTarget(null);
		});
	}

	function handleScrollToTop() {
		scrollToLogTop();
	}

	function handleScrollToBottom() {
		scrollToLogBottom();
	}

	function toggleTailFollow() {
		if (tailFollowEnabled) {
			tailFollowEnabledRef.current = false;
			setTailFollowEnabled(false);
			updateScrollToBottomButton();
			return;
		}

		scrollToLogBottom();
	}

	function handleOpenSearch() {
		setSearchVisible(true);
	}

	function handleCloseSearch() {
		setSearchVisible(false);
		setActiveMatchIndex(-1);
		setState((current) => ({ ...current, query: "" }));
	}

	function handleBodyScroll() {
		const scrollContainer = bodyRef.current;
		if (!scrollContainer) {
			return;
		}

		const previousScrollTop = previousScrollTopRef.current;
		const currentScrollTop = scrollContainer.scrollTop;
		const isScrollingUp = currentScrollTop < previousScrollTop;
		const isScrollingDown = currentScrollTop > previousScrollTop;
		const isAwayFromBottom =
			getDistanceFromBottom(scrollContainer) > LOG_TAIL_THRESHOLD_PX;
		const isAwayFromTop =
			getDistanceFromTop(scrollContainer) > LOG_TAIL_THRESHOLD_PX;

		previousScrollTopRef.current = currentScrollTop;
		if (isScrollingUp) {
			setVisibleScrollJumpTarget(isAwayFromTop ? "top" : null);
		} else if (isScrollingDown) {
			setVisibleScrollJumpTarget(isAwayFromBottom ? "bottom" : null);
		} else if (
			(scrollJumpTargetRef.current === "top" && !isAwayFromTop) ||
			(scrollJumpTargetRef.current === "bottom" && !isAwayFromBottom)
		) {
			setVisibleScrollJumpTarget(null);
		}

		if (isAwayFromBottom && tailFollowEnabledRef.current) {
			tailFollowEnabledRef.current = false;
			setTailFollowEnabled(false);
		}
	}

	function closeWindow() {
		void window.electronAPI.services.closeLogViewer();
	}

	function minimizeWindow() {
		void window.electronAPI.services.minimizeLogViewer?.();
	}

	function maximizeWindow() {
		void window.electronAPI.services.maximizeLogViewer?.();
	}

	const hasMatches = matches.length > 0;
	const hasLoadedContent = joinedContent.length > 0;
	const isPartialLoad =
		state.pages.length > 0
			? state.pages[0].startOffset > 0
			: state.hasPrevious;
	const resultSummary =
		deferredQuery.trim().length > 0
			? `${hasMatches ? activeMatchIndex + 1 : 0} / ${matches.length}`
			: t("logViewer.find.summaryPlaceholder");
	const minimizeLabel = t("logViewer.window.minimize");
	const maximizeLabel = t("logViewer.window.maximize");
	const restoreLabel = t("logViewer.window.restore");
	const closeLabel = t("logViewer.window.close");
	const followToggleLabel = tailFollowEnabled
		? t("logViewer.follow.disable")
		: t("logViewer.follow.enable");
	const searchLabel = t("logViewer.find.aria");

	return (
		<main className="log-viewer-page">
			<div
				className={`log-viewer-window-drag-zone ${isMac ? "is-mac" : "is-windows"}`}
				aria-hidden="true"
			/>
			<section
				className="log-viewer-panel"
				aria-labelledby="log-viewer-title"
			>
				<header className="log-viewer-head">
					<div className="log-viewer-copy">
						<h1 id="log-viewer-title">{state.title || title}</h1>
					</div>
					<div className="log-viewer-head-actions">
						{state.streaming ? (
							<div className="log-viewer-tip is-live">
								<span className="log-viewer-live-dot" aria-hidden="true" />
								<span>{t("logViewer.live")}</span>
							</div>
						) : null}

						<button
							type="button"
							className={`log-viewer-find-trigger${searchVisible ? " is-active" : ""}`}
							onClick={handleOpenSearch}
							disabled={state.loadingInitial || state.loadingPrevious}
							aria-label={searchLabel}
							aria-pressed={searchVisible}
							title={searchLabel}
						>
							<SearchOutlined aria-hidden="true" />
						</button>

						<button
							type="button"
							className={`log-viewer-follow-toggle${tailFollowEnabled ? " is-active" : ""}`}
							onClick={toggleTailFollow}
							disabled={state.loadingInitial}
							aria-label={followToggleLabel}
							title={followToggleLabel}
						>
							<RotateAutoIcon />
						</button>
					</div>
					{!isMac ? (
						<div className="log-viewer-window-controls">
							<button
								type="button"
								className="log-viewer-control-button minimize"
								onClick={minimizeWindow}
								aria-label={minimizeLabel}
								title={minimizeLabel}
							>
								<svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
									<path d="M1 5h8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
								</svg>
							</button>
							<button
								type="button"
								className="log-viewer-control-button maximize"
								onClick={maximizeWindow}
								aria-label={isMaximized ? restoreLabel : maximizeLabel}
								title={isMaximized ? restoreLabel : maximizeLabel}
							>
								{isMaximized ? (
									<svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
										<path d="M3 1.5h5.5v5.5M1.5 3h5.5v5.5h-5.5z" stroke="currentColor" strokeWidth="1" fill="none"/>
									</svg>
								) : (
									<svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
										<rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" strokeWidth="1" fill="none"/>
									</svg>
								)}
							</button>
							<button
								type="button"
								className="log-viewer-control-button close"
								onClick={closeWindow}
								aria-label={closeLabel}
								title={closeLabel}
							>
								<svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
									<path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
								</svg>
							</button>
						</div>
					) : null}
				</header>

				{state.notice ? (
					<div className="feedback-banner">{state.notice}</div>
				) : null}
				{state.error ? (
					<div className="feedback-banner warning-banner">
						{state.error}
					</div>
				) : null}

				<div className="log-viewer-body-shell">
					{searchVisible ? (
						<div
							className="log-viewer-find-panel"
							role="search"
							aria-label={t("logViewer.find.aria")}
						>
							<label className="log-viewer-find-input">
								<svg
									width="18"
									height="18"
									viewBox="0 0 18 18"
									fill="none"
									xmlns="http://www.w3.org/2000/svg"
									aria-hidden="true"
									focusable="false"
									style={{ marginRight: 4, verticalAlign: "middle" }}
								>
									<circle cx="8" cy="8" r="7" stroke="#888" strokeWidth="2" fill="none" />
									<line x1="13.2" y1="13.2" x2="17" y2="17" stroke="#888" strokeWidth="2" strokeLinecap="round" />
								</svg>
			
								<input
									ref={searchInputRef}
									type="search"
									value={state.query}
									onChange={(event) =>
										setState((current) => ({
											...current,
											query: event.target.value,
										}))
									}
									onKeyDown={(event) => {
										if (event.key !== "Enter") {
											return;
										}
										event.preventDefault();
										selectRelativeMatch(
											event.shiftKey ? -1 : 1,
										);
									}}
									placeholder={t("logViewer.find.placeholder")}
									disabled={
										state.loadingInitial ||
										state.loadingPrevious
									}
								/>
							</label>
							<span className="log-viewer-find-count">
								{resultSummary}
							</span>
							<button
								type="button"
								className="log-viewer-find-nav"
								onClick={() => selectRelativeMatch(-1)}
								disabled={!hasMatches}
								aria-label={t("logViewer.find.previous")}
							>
								↑
							</button>
							<button
								type="button"
								className="log-viewer-find-nav"
								onClick={() => selectRelativeMatch(1)}
								disabled={!hasMatches}
								aria-label={t("logViewer.find.next")}
							>
								↓
							</button>
							<button
								type="button"
								className="log-viewer-find-close"
								onClick={handleCloseSearch}
								aria-label={t("logViewer.find.close")}
							>
								×
							</button>
						</div>
					) : null}

					<div
						ref={bodyRef}
						className="log-viewer-body"
						onScroll={handleBodyScroll}
					>
						{state.loadingInitial ? (
							<div className="loading-box">{t("logViewer.loading")}</div>
						) : null}
						{!state.loadingInitial &&
						state.exists &&
						(state.hasPrevious || state.loadingPrevious) ? (
							<div className="log-viewer-pagination">
								<button
									type="button"
									className="action-button"
									onClick={() => void handleLoadPrevious()}
									disabled={state.loadingPrevious}
								>
									{state.loadingPrevious
										? t("logViewer.loadingMore")
										: t("logViewer.loadEarlier")}
								</button>
							</div>
						) : null}
						{!state.loadingInitial &&
						state.exists &&
						!state.hasPrevious &&
						state.pages.length > 0 ? (
							<div className="log-viewer-pagination-hint">
								{t("logViewer.startReached")}
							</div>
						) : null}
						{!state.loadingInitial && !state.exists ? (
							<div className="log-viewer-empty">
								{t("logViewer.missingFile")}
							</div>
						) : null}
						{!state.loadingInitial &&
						state.exists &&
						!hasLoadedContent ? (
							<div className="log-viewer-empty">
								{t("logViewer.emptyFile")}
							</div>
						) : null}
						{!state.loadingInitial &&
						state.exists &&
						hasLoadedContent ? (
							<pre
								ref={contentRef}
								className="log-viewer-content"
							>
								{renderLogContent(
									joinedContent,
									matches,
									activeMatchIndex,
								)}
							</pre>
						) : null}
					</div>
				</div>
				{scrollJumpTarget === "top" ? (
					<button
						type="button"
						className="log-viewer-scroll-jump log-viewer-scroll-top"
						onClick={handleScrollToTop}
						aria-label={t("logViewer.scrollTop")}
						title={t("logViewer.scrollTop")}
					>
						<ArrowUpwardIcon />
					</button>
				) : null}
				{scrollJumpTarget === "bottom" ? (
					<button
						type="button"
						className="log-viewer-scroll-jump log-viewer-scroll-bottom"
						onClick={handleScrollToBottom}
						aria-label={t("logViewer.scrollBottom")}
						title={t("logViewer.scrollBottom")}
					>
						<ArrowDownwardIcon />
					</button>
				) : null}
			</section>
		</main>
	);
}
