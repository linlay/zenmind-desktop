import React, { useEffect, useMemo, useState } from "react";
import { resolveHostCodeAssistantRuntime } from "../../lib/host";

function isCodeAssistantCliRecoveryError(text: string): boolean {
	const normalized = String(text || "");
	return (
		normalized.includes("CLI not connected") ||
		normalized.includes("Failed to switch chat session") ||
		normalized.includes("请先启动 CLI 并连接到 relay") ||
		normalized.includes("CLI 重启失败")
	);
}

export const SystemAlert: React.FC<{ text: string }> = ({ text }) => {
	const codeAssistantRuntime = resolveHostCodeAssistantRuntime();
	const [restarting, setRestarting] = useState(false);
	const [restartFeedback, setRestartFeedback] = useState("");

	useEffect(() => {
		setRestartFeedback("");
		setRestarting(false);
	}, [text]);

	const canRestartCodeAssistant = useMemo(
		() =>
			Boolean(
				codeAssistantRuntime?.onRestartRuntime &&
				isCodeAssistantCliRecoveryError(text),
			),
		[codeAssistantRuntime, text],
	);

	const handleRestartCodeAssistant = async () => {
		if (!codeAssistantRuntime?.onRestartRuntime || restarting) {
			return;
		}
		setRestarting(true);
		setRestartFeedback("");
		try {
			const result = await codeAssistantRuntime.onRestartRuntime();
			const message =
				result && typeof result === "object" && "message" in result
					? String(result.message || "").trim()
					: "";
			setRestartFeedback(message || "已触发代码助手 CLI 重启，请稍候。");
		} catch (error) {
			setRestartFeedback(
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			setRestarting(false);
		}
	};

	return (
		<div className="system-alert">
			<div className="system-alert-text">{text}</div>
			{canRestartCodeAssistant ? (
				<div className="system-alert-actions">
					<button
						type="button"
						className="system-alert-action"
						disabled={restarting}
						onClick={handleRestartCodeAssistant}
					>
						{restarting ? "启动中..." : "启动 CLI"}
					</button>
					{restartFeedback ? (
						<div className="system-alert-feedback">{restartFeedback}</div>
					) : null}
				</div>
			) : null}
		</div>
	);
};
