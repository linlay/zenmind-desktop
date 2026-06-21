export const QUICK_COPILOT_DISMISS_URL = "desktop://quick-assistant-dismiss";

export function getQuickCopilotDismissHtml() {
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<style>",
    "html,body,#hit{width:100%;height:100%;margin:0;background:transparent;}",
    "</style>",
    "</head>",
    "<body>",
    "<div id=\"hit\" aria-hidden=\"true\"></div>",
    "<script>",
    "const dismiss=()=>{",
    "  if(window.electronAPI?.quickAssistant?.hide){",
    "    void window.electronAPI.quickAssistant.hide();",
    "    return;",
    "  }",
    `  window.location.href=${JSON.stringify(QUICK_COPILOT_DISMISS_URL)};`,
    "};",
    "[\"pointerdown\",\"mousedown\",\"click\",\"touchstart\"].forEach((eventName)=>{",
    "  document.addEventListener(eventName,dismiss,{capture:true});",
    "});",
    "</script>",
    "</body>",
    "</html>"
  ].join("");
}
