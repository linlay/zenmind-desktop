import React from "react";
import { useAppState } from "@/app/state/AppContext";
import { resolveCurrentWorkerSummary } from "@/features/workers/lib/currentWorker";
import {
	resolveHostCodeAssistantAccess,
	resolveHostCodeAssistantRepo,
	type HostCodeAssistantAccessMode,
} from "@/shared/utils/host";
import { MaterialIcon } from "@/shared/ui/MaterialIcon";
import { UiButton } from "@/shared/ui/UiButton";

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
		(String(worker.displayName || "").trim() === "代码助手" &&
			String(worker.role || "").trim() === "CLI 代码助手")
	);
}

export const CodeAssistantContextBar: React.FC = () => {
	const state = useAppState();
	const currentWorker = resolveCurrentWorkerSummary(state);
	const codeAssistantAccess = resolveHostCodeAssistantAccess();
	const codeAssistantRepo = resolveHostCodeAssistantRepo();
	const [branchMenuOpen, setBranchMenuOpen] = React.useState(false);
	const menuRef = React.useRef<HTMLDivElement | null>(null);

	const showBar =
		Boolean(codeAssistantAccess || codeAssistantRepo) &&
		isCodeAssistantWorker(
			currentWorker,
			codeAssistantAccess?.agentKey || codeAssistantRepo?.agentKey || "",
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

	React.useEffect(() => {
		if (codeAssistantAccess?.mode !== "folder" && branchMenuOpen) {
			setBranchMenuOpen(false);
		}
	}, [branchMenuOpen, codeAssistantAccess?.mode]);

	const handleSelectMode = React.useCallback(
		(targetMode: HostCodeAssistantAccessMode) => {
			if (!codeAssistantAccess) {
				return;
			}
			const currentMode = codeAssistantAccess.mode;
			if (codeAssistantAccess.pending || currentMode === targetMode) {
				return;
			}
			void Promise.resolve(codeAssistantAccess.onSelectMode(targetMode)).catch(
				() => undefined,
			);
		},
		[codeAssistantAccess],
	);

	if (!showBar || !codeAssistantAccess || !codeAssistantRepo) {
		return null;
	}

	const mode = codeAssistantAccess.mode;
	const folderSelected = codeAssistantRepo.userSelected;
	const showScopedRepoControls = mode === "folder";
	const modeLabel =
		mode === "global"
			? codeAssistantAccess.globalLabel || "全局访问"
			: codeAssistantAccess.folderLabel || "指定文件夹";
	const helperText =
		mode === "global"
			? "当前可访问本机全部目录"
			: folderSelected
				? `当前仅限 ${codeAssistantRepo.repoLabel || "所选目录"}`
				: "先选择一个目录，再限制代码助手只访问该目录";

	return (
		<div className="code-assistant-context-bar" ref={menuRef}>
			<div className="code-assistant-context-main">
				<div className="code-assistant-context-group">
					{showScopedRepoControls ? (
						<>
							<UiButton
								className={`code-assistant-scope-button ${folderSelected ? "is-selected" : "is-empty"}`}
								variant="secondary"
								size="sm"
								disabled={codeAssistantRepo.pending}
								title={
									folderSelected
										? codeAssistantRepo.repoPath
										: "选择代码助手的工作目录"
								}
								aria-label="选择代码助手工作目录"
								onClick={() => {
									setBranchMenuOpen(false);
									void Promise.resolve(codeAssistantRepo.onSelectRepo()).catch(
										() => undefined,
									);
								}}
							>
								<MaterialIcon name="folder_open" />
								<span className="code-assistant-scope-button-label">
									{codeAssistantRepo.repoLabel || "选择工作目录"}
								</span>
							</UiButton>

							{folderSelected && codeAssistantRepo.branches.length > 0 ? (
								<div className="code-assistant-branch-wrapper">
									<UiButton
										className="code-assistant-scope-button"
										variant="secondary"
										size="sm"
										disabled={codeAssistantRepo.pending}
										title={
											codeAssistantRepo.currentBranch
												? `当前分支：${codeAssistantRepo.currentBranch}`
												: "选择 Git 分支"
										}
										aria-label="选择 Git 分支"
										aria-expanded={branchMenuOpen}
										onClick={() => setBranchMenuOpen((prev) => !prev)}
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
													aria-checked={
														branch === codeAssistantRepo.currentBranch
													}
													className={`code-assistant-branch-menu-item ${branch === codeAssistantRepo.currentBranch ? "is-current" : ""}`}
													onClick={() => {
														setBranchMenuOpen(false);
														if (branch === codeAssistantRepo.currentBranch) {
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
						</>
					) : null}
				</div>

				<div
					className="code-assistant-mode-group"
					role="tablist"
					aria-label="代码助手访问模式"
				>
					<button
						type="button"
						role="tab"
						aria-selected={mode === "global"}
						className={`code-assistant-mode-chip ${mode === "global" ? "is-active" : ""}`}
						disabled={codeAssistantAccess.pending}
						onClick={() => handleSelectMode("global")}
					>
						<span
							className="code-assistant-mode-dot is-global"
							aria-hidden="true"
						/>
						<span>{codeAssistantAccess.globalLabel || "全局访问"}</span>
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={mode === "folder"}
						className={`code-assistant-mode-chip ${mode === "folder" ? "is-active" : ""}`}
						disabled={codeAssistantAccess.pending}
						onClick={() => handleSelectMode("folder")}
					>
						<span
							className="code-assistant-mode-dot is-folder"
							aria-hidden="true"
						/>
						<span>{codeAssistantAccess.folderLabel || "指定文件夹"}</span>
					</button>
				</div>
			</div>

			<div className="code-assistant-context-meta">
				<span className={`code-assistant-context-badge is-${mode}`}>
					{modeLabel}
				</span>
				<span className="code-assistant-context-helper">{helperText}</span>
			</div>
		</div>
	);
};
