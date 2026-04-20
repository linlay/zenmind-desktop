import React from "react";
import { useAppState } from "../../context/AppContext";
import { resolveCurrentWorkerSummary } from "../../lib/currentWorker";
import { resolveHostCodeAssistantRepo } from "../../lib/host";
import { MaterialIcon } from "../common/MaterialIcon";
import { UiButton } from "../ui/UiButton";

function isCodeAssistantWorker(
	worker: ReturnType<typeof resolveCurrentWorkerSummary>,
	agentKey: string,
): boolean {
	if (!worker || worker.type !== "agent") {
		return false;
	}

	const normalizedAgentKey = String(agentKey || "").trim();
	if (!normalizedAgentKey) {
		return false;
	}

	return (
		worker.sourceId === normalizedAgentKey ||
		worker.key === `agent:${normalizedAgentKey}` ||
		(
			String(worker.displayName || "").trim() === "代码助手" &&
			String(worker.role || "").trim() === "CLI 代码助手"
		)
	);
}

export const CodeAssistantContextBar: React.FC = () => {
	const state = useAppState();
	const currentWorker = resolveCurrentWorkerSummary(state);
	const codeAssistantRepo = resolveHostCodeAssistantRepo();
	const [branchMenuOpen, setBranchMenuOpen] = React.useState(false);
	const menuRef = React.useRef<HTMLDivElement | null>(null);

	const showBar =
		Boolean(codeAssistantRepo) &&
		isCodeAssistantWorker(
			currentWorker,
			codeAssistantRepo?.agentKey || "",
		);

	React.useEffect(() => {
		if (!branchMenuOpen) return;
		const handler = (event: MouseEvent) => {
			if (
				menuRef.current &&
				event.target instanceof Node &&
				!menuRef.current.contains(event.target)
			) {
				setBranchMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [branchMenuOpen]);

	if (!showBar || !codeAssistantRepo) {
		return null;
	}

	const folderSelected = codeAssistantRepo.userSelected;
	const controlsBlocked = Boolean(state.activeAwaiting) || state.streaming;
	const controlsDisabled = codeAssistantRepo.pending || controlsBlocked;
	const controlsBlockedTitle = controlsBlocked
		? "请先完成当前回复或确认，再切换工作空间设置"
		: "";
	const workspaceLabel = folderSelected
		? codeAssistantRepo.repoLabel || "所选目录"
		: "未选择";
	const helperText = folderSelected
		? "优先在该工作空间内处理；访问外部位置时会请求确认"
		: "选择工作空间后，代码助手会优先在该目录内处理";

	return (
		<div className="code-assistant-context-bar" ref={menuRef}>
			<div className="code-assistant-context-main">
				<div className="code-assistant-context-group">
					<UiButton
						className={`code-assistant-scope-button ${folderSelected ? "is-selected" : "is-empty"}`}
						variant="secondary"
						size="sm"
						disabled={controlsDisabled}
						title={
							controlsBlockedTitle ||
							(folderSelected
								? codeAssistantRepo.repoPath
								: "选择代码助手的工作空间")
						}
						aria-label="选择代码助手工作空间"
						onClick={() => {
							if (controlsDisabled) {
								return;
							}
							setBranchMenuOpen(false);
							void Promise.resolve(codeAssistantRepo.onSelectRepo()).catch(
								() => undefined,
							);
						}}
					>
						<MaterialIcon name="folder_open" />
						<span className="code-assistant-scope-button-label">
							{folderSelected
								? codeAssistantRepo.repoLabel || "工作空间"
								: "选择工作空间"}
						</span>
					</UiButton>

					{folderSelected && codeAssistantRepo.branches.length > 0 ? (
						<div className="code-assistant-branch-wrapper">
							<UiButton
								className="code-assistant-scope-button"
								variant="secondary"
								size="sm"
								disabled={controlsDisabled}
								title={
									controlsBlockedTitle ||
									(codeAssistantRepo.currentBranch
										? `当前分支：${codeAssistantRepo.currentBranch}`
										: "选择 Git 分支")
								}
								aria-label="选择 Git 分支"
								aria-expanded={branchMenuOpen}
								onClick={() => {
									if (controlsDisabled) {
										return;
									}
									setBranchMenuOpen((prev) => !prev);
								}}
							>
								<MaterialIcon name="call_split" />
								<span className="code-assistant-scope-button-label">
									{codeAssistantRepo.currentBranch || "选择分支"}
								</span>
								<MaterialIcon name="expand_more" />
							</UiButton>
							{branchMenuOpen ? (
								<div className="code-assistant-branch-menu" role="menu">
									{codeAssistantRepo.branches.map((branch) => (
										<button
											key={branch}
											type="button"
											role="menuitemradio"
											aria-checked={branch === codeAssistantRepo.currentBranch}
											className={`code-assistant-branch-menu-item ${branch === codeAssistantRepo.currentBranch ? "is-current" : ""}`}
											disabled={controlsDisabled}
											onClick={() => {
												setBranchMenuOpen(false);
												if (
													controlsDisabled ||
													branch === codeAssistantRepo.currentBranch
												) {
													return;
												}
												void Promise.resolve(
													codeAssistantRepo.onSelectBranch(branch),
												).catch(() => undefined);
											}}
										>
											<span
												className="code-assistant-branch-menu-dot"
												aria-hidden="true"
											/>
											<span className="code-assistant-branch-menu-name">
												{branch}
											</span>
										</button>
									))}
								</div>
							) : null}
						</div>
					) : null}
				</div>
			</div>

			<div className="code-assistant-context-meta">
				<span className="code-assistant-context-badge is-workspace">
					工作空间：{workspaceLabel}
				</span>
				<span className="code-assistant-context-helper">{helperText}</span>
			</div>
		</div>
	);
};
