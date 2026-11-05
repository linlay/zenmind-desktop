import bge from "./model-icons/bge.svg";
import chatgpt from "./model-icons/chatgpt.svg";
import claude from "./model-icons/claude.svg";
import deepseek from "./model-icons/deepseek.svg";
import defaultIcon from "./model-icons/default.svg";
import gemini from "./model-icons/gemini.svg";
import glm from "./model-icons/glm.svg";
import grok from "./model-icons/grok.svg";
import kimi from "./model-icons/kimi.svg";
import minimax from "./model-icons/minimax.svg";
import mimo from "./model-icons/mimo.svg";
import qwen from "./model-icons/qwen.svg";
import step from "./model-icons/step.svg";

// 与 WebClient 一致，只解析显式 icon 标识，不从模型名称或渠道猜测品牌。
// SVG 来源：@lobehub/icons-static-svg v1.93.0（MIT）。
const icons = { bge, chatgpt, claude, deepseek, default: defaultIcon, gemini, glm, grok, kimi, minimax, mimo, qwen, step };
const monochrome = new Set(["bge", "chatgpt", "claude", "default", "kimi", "grok", "mimo", "step"]);

export function ModelIcon({ icon }: { icon?: string }) {
  const key = icon?.trim().toLowerCase() ?? "";
  const family = Object.prototype.hasOwnProperty.call(icons, key) ? key as keyof typeof icons : "default";
  return (
    <img
      className={`sidebar-project-model-icon${monochrome.has(family) ? " monochrome" : ""}`}
      src={icons[family]}
      width={16}
      height={16}
      alt=""
      aria-hidden="true"
    />
  );
}
