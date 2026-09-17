export type WebviewDebugDockCorner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export type WebviewDebugFloatPoint = {
  x: number;
  y: number;
};

export type WebviewDebugFloatSize = {
  width: number;
  height: number;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function clampWebviewDebugFloatPosition(
  position: WebviewDebugFloatPoint,
  itemSize: WebviewDebugFloatSize,
  containerSize: WebviewDebugFloatSize,
  safeInset: number,
): WebviewDebugFloatPoint {
  const maximumX = Math.max(0, containerSize.width - itemSize.width);
  const maximumY = Math.max(0, containerSize.height - itemSize.height);
  const insetX = Math.min(Math.max(0, safeInset), maximumX / 2);
  const insetY = Math.min(Math.max(0, safeInset), maximumY / 2);

  return {
    x: clamp(position.x, insetX, maximumX - insetX),
    y: clamp(position.y, insetY, maximumY - insetY),
  };
}

export function resolveWebviewDebugDockCorner(
  position: WebviewDebugFloatPoint,
  itemSize: WebviewDebugFloatSize,
  containerSize: WebviewDebugFloatSize,
): WebviewDebugDockCorner {
  const horizontal = position.x + itemSize.width / 2 <= containerSize.width / 2
    ? "left"
    : "right";
  const vertical = position.y + itemSize.height / 2 <= containerSize.height / 2
    ? "top"
    : "bottom";
  return `${vertical}-${horizontal}`;
}

export function moveWebviewDebugDockCorner(
  corner: WebviewDebugDockCorner,
  key: string,
): WebviewDebugDockCorner {
  const vertical = corner.startsWith("top") ? "top" : "bottom";
  const horizontal = corner.endsWith("left") ? "left" : "right";

  if (key === "ArrowLeft" || key === "ArrowRight") {
    return `${vertical}-${key === "ArrowLeft" ? "left" : "right"}`;
  }
  if (key === "ArrowUp" || key === "ArrowDown") {
    return `${key === "ArrowUp" ? "top" : "bottom"}-${horizontal}`;
  }
  return corner;
}
