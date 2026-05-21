import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.resolve(__dirname, "..", "public", "desktop-pet");
const sourceAssetDirectory = path.resolve(__dirname, "assets", "desktop-pet");

const size = {
  width: 320,
  height: 360
};

const classicVisualVariants = ["idle", "hover", "dragging", "thinking", "message", "done", "error"];

const compatibilityVariantAliases = {
  awaiting: "thinking",
  running: "thinking"
};

const communityAppearances = [
  {
    id: "dario",
    displayName: "Dario",
    sourceUrl: "https://github.com/az9713/Clade-Design/tree/main/assets/community-pets/dario",
    spritesheetSourceUrl: "https://gitpets.com/api/assets/pets/dario-a7bdc389/spritesheet.webp"
  },
  {
    id: "mini-sama",
    displayName: "Mini Sama",
    sourceUrl: "https://github.com/xpert-ai/chatkit-js/tree/main/packages/chatkit-ui/public/pets/mini-sama",
    spritesheetSourceUrl: "https://gitpets.com/api/assets/pets/mini-sama-3ee267a2/spritesheet.webp"
  }
];

const scriptedAppearances = [
  {
    id: "xiao",
    displayName: "小肖",
    notes: "A chibi built-in pet inspired by the provided references: swept black hair, dark suit, bouquet, and a gold award."
  }
];

const legacyCommunityAppearanceAliases = {
  sprout: "dario",
  starlight: "mini-sama"
};

const communityAtlas = {
  columns: 8,
  rows: 9
};

const communityFrameSelections = {
  dragging: { row: 4, column: 2 },
  done: { row: 4, column: 3 },
  error: { row: 5, column: 5 },
  hover: { row: 3, column: 1 },
  idle: { row: 0, column: 0 },
  message: { row: 3, column: 2 },
  thinking: { row: 8, column: 2 }
};

function roundRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function fillCircle(ctx, x, y, radius, fillStyle) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = fillStyle;
  ctx.fill();
  ctx.restore();
}

function strokeCircle(ctx, x, y, radius, strokeStyle, lineWidth) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
  ctx.restore();
}

function drawBackdrop(ctx) {
  ctx.save();
  const glow = ctx.createRadialGradient(160, 128, 24, 160, 144, 136);
  glow.addColorStop(0, "rgba(119, 174, 255, 0.42)");
  glow.addColorStop(0.52, "rgba(119, 174, 255, 0.12)");
  glow.addColorStop(1, "rgba(119, 174, 255, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(160, 146, 136, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "rgba(28, 52, 102, 0.12)";
  ctx.beginPath();
  ctx.ellipse(160, 324, 78, 18, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function resolveClassicExpressionVariant(variant) {
  if (variant === "thinking") {
    return "awaiting";
  }
  if (variant === "message") {
    return "hover";
  }
  return variant;
}

function drawHead(ctx, variant) {
  ctx.save();
  const expressionVariant = resolveClassicExpressionVariant(variant);
  const headGradient = ctx.createLinearGradient(70, 36, 240, 236);
  headGradient.addColorStop(0, "#7bc0ff");
  headGradient.addColorStop(0.54, "#458cff");
  headGradient.addColorStop(1, "#1e57c9");

  fillCircle(ctx, 98, 124, 42, "#1f2430");
  fillCircle(ctx, 222, 124, 42, "#1f2430");
  fillCircle(ctx, 76, 160, 30, "#1f2430");
  fillCircle(ctx, 244, 160, 30, "#1f2430");
  fillCircle(ctx, 98, 124, 36, "#5d9dff");
  fillCircle(ctx, 222, 124, 36, "#5d9dff");
  fillCircle(ctx, 76, 160, 24, "#4f8af6");
  fillCircle(ctx, 244, 160, 24, "#4f8af6");
  fillCircle(ctx, 88, 108, 8, "rgba(213, 235, 255, 0.62)");
  fillCircle(ctx, 212, 108, 8, "rgba(213, 235, 255, 0.62)");
  fillCircle(ctx, 160, 144, 100, "#1f2430");
  fillCircle(ctx, 160, 134, 92, headGradient);
  fillCircle(ctx, 160, 156, 92, "#3571e5");
  fillCircle(ctx, 122, 78, 17, "#162033");
  fillCircle(ctx, 150, 66, 19, "#101827");
  fillCircle(ctx, 179, 70, 16, "#172033");

  ctx.fillStyle = "#101827";
  ctx.beginPath();
  ctx.moveTo(116, 88);
  ctx.quadraticCurveTo(156, 48, 204, 84);
  ctx.lineTo(210, 110);
  ctx.quadraticCurveTo(160, 86, 110, 112);
  ctx.closePath();
  ctx.fill();

  roundRectPath(ctx, 90, 92, 140, 122, 31);
  ctx.fillStyle = "#1f2430";
  ctx.fill();
  roundRectPath(ctx, 94, 96, 132, 114, 28);
  const faceGradient = ctx.createLinearGradient(94, 96, 226, 210);
  faceGradient.addColorStop(0, "#f7d3c1");
  faceGradient.addColorStop(0.55, "#f0c2ab");
  faceGradient.addColorStop(1, "#dca48c");
  ctx.fillStyle = faceGradient;
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.beginPath();
  ctx.moveTo(116, 104);
  ctx.quadraticCurveTo(104, 132, 110, 190);
  ctx.lineTo(98, 194);
  ctx.quadraticCurveTo(88, 132, 104, 100);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "#1f2430";
  ctx.lineWidth = 6;
  roundRectPath(ctx, 98, 126, 54, 34, 14);
  ctx.stroke();
  roundRectPath(ctx, 168, 126, 54, 34, 14);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(152, 144);
  ctx.lineTo(168, 144);
  ctx.stroke();

  ctx.fillStyle = "#eff6ff";
  roundRectPath(ctx, 104, 132, 42, 22, 11);
  ctx.fill();
  roundRectPath(ctx, 174, 132, 42, 22, 11);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.48)";
  roundRectPath(ctx, 111, 136, 16, 5, 3);
  ctx.fill();
  roundRectPath(ctx, 181, 136, 16, 5, 3);
  ctx.fill();

  const eyeY = expressionVariant === "hover"
    ? 139
    : expressionVariant === "running"
      ? 141
      : expressionVariant === "awaiting"
        ? 142
        : 143;
  drawEyes(ctx, eyeY, expressionVariant);
  drawBrows(ctx, expressionVariant);
  drawNose(ctx);
  drawMouth(ctx, expressionVariant);
  fillCircle(ctx, 116, 184, 7, "rgba(244, 143, 143, 0.2)");
  fillCircle(ctx, 204, 184, 7, "rgba(244, 143, 143, 0.2)");
  drawEars(ctx);
  strokeCircle(ctx, 98, 124, 35, "rgba(255,255,255,0.18)", 3);
  strokeCircle(ctx, 222, 124, 35, "rgba(255,255,255,0.18)", 3);
  ctx.restore();
}

function drawEyes(ctx, y, variant) {
  ctx.save();
  ctx.strokeStyle = "#4a5568";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  const leftX = 126;
  const rightX = 194;
  if (variant === "dragging") {
    for (const x of [leftX, rightX]) {
      ctx.beginPath();
      ctx.ellipse(x, y + 1, 13, 9, 0, 0, Math.PI * 2);
      ctx.stroke();
      fillCircle(ctx, x + (x < 160 ? -3 : 3), y + 2, 4.5, "#1f2937");
      fillCircle(ctx, x + (x < 160 ? -1 : 5), y, 1.5, "#ffffff");
    }
  } else if (variant === "hover") {
    ctx.beginPath();
    ctx.moveTo(leftX - 15, y + 1);
    ctx.quadraticCurveTo(leftX, y + 9, leftX + 15, y + 1);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(rightX, y, 14, 8, 0, 0, Math.PI * 2);
    ctx.stroke();
    fillCircle(ctx, rightX + 1, y, 4.5, "#1f2937");
    fillCircle(ctx, rightX + 4, y - 2, 1.5, "#ffffff");
  } else if (variant === "done") {
    ctx.beginPath();
    ctx.moveTo(leftX - 16, y - 4);
    ctx.quadraticCurveTo(leftX, y + 8, leftX + 16, y - 4);
    ctx.moveTo(rightX - 16, y - 4);
    ctx.quadraticCurveTo(rightX, y + 8, rightX + 16, y - 4);
    ctx.stroke();
  } else if (variant === "error") {
    ctx.beginPath();
    ctx.moveTo(leftX - 16, y);
    ctx.lineTo(leftX + 12, y - 5);
    ctx.moveTo(rightX - 12, y - 5);
    ctx.lineTo(rightX + 16, y);
    ctx.stroke();
  } else {
    for (const x of [leftX, rightX]) {
      ctx.beginPath();
      ctx.ellipse(x, y, 13, variant === "running" ? 7 : 8, 0, 0, Math.PI * 2);
      ctx.stroke();
      fillCircle(ctx, x + (variant === "awaiting" ? 2 : 0), y, 4, "#1f2937");
      fillCircle(ctx, x + 3, y - 2, 1.5, "#ffffff");
    }
  }
  ctx.restore();
}

function drawBrows(ctx, variant) {
  ctx.save();
  ctx.strokeStyle = "#1f2430";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  if (variant === "dragging") {
    ctx.beginPath();
    ctx.moveTo(104, 113);
    ctx.quadraticCurveTo(122, 106, 142, 111);
    ctx.moveTo(176, 111);
    ctx.quadraticCurveTo(196, 106, 216, 113);
    ctx.stroke();
  } else if (variant === "hover") {
    ctx.beginPath();
    ctx.moveTo(104, 113);
    ctx.quadraticCurveTo(122, 106, 142, 112);
    ctx.moveTo(176, 112);
    ctx.quadraticCurveTo(196, 106, 216, 113);
    ctx.stroke();
  } else if (variant === "awaiting") {
    ctx.beginPath();
    ctx.moveTo(104, 116);
    ctx.lineTo(142, 114);
    ctx.moveTo(178, 114);
    ctx.lineTo(216, 116);
    ctx.stroke();
  } else if (variant === "error") {
    ctx.beginPath();
    ctx.moveTo(104, 119);
    ctx.lineTo(144, 111);
    ctx.moveTo(176, 111);
    ctx.lineTo(216, 119);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(104, 117);
    ctx.quadraticCurveTo(122, 111, 142, 117);
    ctx.moveTo(176, 117);
    ctx.quadraticCurveTo(196, 111, 216, 117);
    ctx.stroke();
  }
  ctx.restore();
}

function drawNose(ctx) {
  ctx.save();
  ctx.strokeStyle = "rgba(102, 70, 58, 0.72)";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(160, 146);
  ctx.quadraticCurveTo(154, 166, 160, 180);
  ctx.quadraticCurveTo(168, 186, 176, 180);
  ctx.stroke();
  ctx.restore();
}

function drawMouth(ctx, variant) {
  ctx.save();
  ctx.strokeStyle = variant === "done" ? "#8e4a4a" : "#86605b";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  if (variant === "dragging") {
    ctx.fillStyle = "#86605b";
    ctx.ellipse(160, 202, 9, 6, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (variant === "hover") {
    ctx.moveTo(130, 197);
    ctx.quadraticCurveTo(160, 218, 190, 197);
  } else if (variant === "done") {
    ctx.moveTo(130, 198);
    ctx.quadraticCurveTo(160, 214, 190, 198);
  } else if (variant === "error") {
    ctx.moveTo(132, 204);
    ctx.quadraticCurveTo(160, 194, 188, 204);
  } else if (variant === "running") {
    ctx.moveTo(132, 202);
    ctx.quadraticCurveTo(160, 210, 188, 202);
  } else {
    ctx.moveTo(132, 204);
    ctx.quadraticCurveTo(160, 208, 188, 204);
  }
  ctx.stroke();
  ctx.restore();
}

function drawEars(ctx) {
  ctx.save();
  const earGradient = ctx.createLinearGradient(76, 140, 92, 170);
  earGradient.addColorStop(0, "#efc0a9");
  earGradient.addColorStop(1, "#d49a84");
  ctx.fillStyle = earGradient;
  ctx.beginPath();
  ctx.ellipse(86, 153, 11, 21, 0, 0, Math.PI * 2);
  ctx.ellipse(234, 153, 11, 21, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBody(ctx, variant) {
  ctx.save();
  const bodyGradient = ctx.createLinearGradient(102, 210, 220, 330);
  bodyGradient.addColorStop(0, "#ffffff");
  bodyGradient.addColorStop(1, "#ddeaf7");
  roundRectPath(ctx, 94, 218, 132, 108, 39);
  ctx.fillStyle = "#1f2430";
  ctx.fill();
  roundRectPath(ctx, 100, 224, 120, 96, 36);
  ctx.fillStyle = bodyGradient;
  ctx.fill();

  ctx.strokeStyle = "rgba(187, 205, 224, 0.8)";
  ctx.lineWidth = 5;
  for (const x of [126, 150, 174, 198]) {
    ctx.beginPath();
    ctx.moveTo(x, 238);
    ctx.lineTo(x, 306);
    ctx.stroke();
  }

  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "rgba(31, 36, 48, 0.62)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(128, 224);
  ctx.lineTo(154, 252);
  ctx.lineTo(146, 262);
  ctx.lineTo(112, 234);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(192, 224);
  ctx.lineTo(168, 252);
  ctx.lineTo(176, 262);
  ctx.lineTo(208, 234);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = variant === "error" ? "#1f2430" : "#111827";
  ctx.beginPath();
  ctx.moveTo(152, 250);
  ctx.lineTo(168, 250);
  ctx.lineTo(178, 320);
  ctx.lineTo(142, 320);
  ctx.closePath();
  ctx.fill();
  fillCircle(ctx, 160, 244, 3.5, "#4f8af6");
  fillCircle(ctx, 160, 272, 3, "#4f8af6");

  if (variant === "dragging") {
    drawDraggingArms(ctx);
  } else if (variant === "hover" || variant === "message") {
    drawHoverArm(ctx);
    drawRestingArm(ctx, "left");
  } else {
    drawRestingArm(ctx, "left");
    drawRestingArm(ctx, "right");
  }

  drawFeet(ctx, variant);
  ctx.restore();
}

function drawRestingArm(ctx, side) {
  ctx.save();
  const isLeft = side === "left";
  const shoulderX = isLeft ? 106 : 214;
  const handX = isLeft ? 90 : 230;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#1f2430";
  ctx.lineWidth = 15;
  ctx.beginPath();
  ctx.moveTo(shoulderX, 248);
  ctx.quadraticCurveTo(isLeft ? 95 : 225, 266, handX, 286);
  ctx.stroke();

  ctx.strokeStyle = "#4f8af6";
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.moveTo(shoulderX, 248);
  ctx.quadraticCurveTo(isLeft ? 95 : 225, 266, handX, 286);
  ctx.stroke();

  ctx.fillStyle = "#5d9dff";
  ctx.strokeStyle = "#1f2430";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(handX, 289, 9, 11, isLeft ? -0.24 : 0.24, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawDraggingArms(ctx) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const arms = [
    { start: [108, 246], mid: [74, 218], end: [68, 182], tilt: -0.38 },
    { start: [212, 246], mid: [246, 218], end: [252, 182], tilt: 0.38 }
  ];
  for (const arm of arms) {
    ctx.strokeStyle = "#1f2430";
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.moveTo(...arm.start);
    ctx.quadraticCurveTo(...arm.mid, ...arm.end);
    ctx.stroke();

    ctx.strokeStyle = "#4f8af6";
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(...arm.start);
    ctx.quadraticCurveTo(...arm.mid, ...arm.end);
    ctx.stroke();

    ctx.fillStyle = "#5d9dff";
    ctx.strokeStyle = "#1f2430";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(arm.end[0], arm.end[1] - 4, 12, 16, arm.tilt, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawFeet(ctx, variant) {
  ctx.save();
  const y = variant === "dragging" ? 306 : 314;
  const leftX = variant === "dragging" ? 126 : 120;
  const rightX = variant === "dragging" ? 170 : 176;
  ctx.fillStyle = "#1f2430";
  roundRectPath(ctx, leftX - 4, y - 4, 32, 23, 10);
  ctx.fill();
  roundRectPath(ctx, rightX - 4, y - 4, 32, 23, 10);
  ctx.fill();
  ctx.fillStyle = "#4f8af6";
  roundRectPath(ctx, leftX, y, 24, 16, 8);
  ctx.fill();
  roundRectPath(ctx, rightX, y, 24, 16, 8);
  ctx.fill();
  ctx.restore();
}

function drawHoverArm(ctx) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#1f2430";
  ctx.lineWidth = 18;
  ctx.beginPath();
  ctx.moveTo(210, 246);
  ctx.quadraticCurveTo(232, 226, 244, 204);
  ctx.stroke();

  ctx.strokeStyle = "#4f8af6";
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(210, 246);
  ctx.quadraticCurveTo(232, 226, 244, 204);
  ctx.stroke();

  ctx.fillStyle = "#5d9dff";
  ctx.strokeStyle = "#1f2430";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.ellipse(246, 199, 13, 17, -0.46, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawAwaitingBadge(ctx) {
  ctx.save();
  const bubble = ctx.createRadialGradient(256, 62, 8, 256, 62, 34);
  bubble.addColorStop(0, "#ffffff");
  bubble.addColorStop(0.58, "#e6f2ff");
  bubble.addColorStop(1, "#c8e0ff");
  fillCircle(ctx, 256, 62, 32, bubble);
  ctx.fillStyle = "#173a83";
  ctx.font = "600 24px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("1", 256, 62);
  ctx.restore();
}

function drawSpark(ctx) {
  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.88)";
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(250, 92);
  ctx.lineTo(250, 114);
  ctx.moveTo(239, 103);
  ctx.lineTo(261, 103);
  ctx.stroke();
  ctx.restore();
}

function renderPetVariant(variant) {
  const canvas = createCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d");
  drawBackdrop(ctx);
  drawHead(ctx, variant);
  drawBody(ctx, variant);
  return canvas.toBuffer("image/png");
}

function getCommunityFrameSelection(variant) {
  const selection = communityFrameSelections[variant];
  if (!selection) {
    throw new Error(`No community pet frame selection configured for ${variant}`);
  }
  return selection;
}

function renderCommunityPetVariant(image, variant) {
  const { row, column } = getCommunityFrameSelection(variant);
  const cellWidth = Math.floor(image.width / communityAtlas.columns);
  const cellHeight = Math.floor(image.height / communityAtlas.rows);
  const canvas = createCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d");
  const targetScale = Math.min((size.width * 0.88) / cellWidth, (size.height * 0.94) / cellHeight);
  const targetWidth = Math.round(cellWidth * targetScale);
  const targetHeight = Math.round(cellHeight * targetScale);
  const targetX = Math.round((size.width - targetWidth) / 2);
  const targetY = Math.round(size.height - targetHeight - 8);
  ctx.drawImage(
    image,
    column * cellWidth,
    row * cellHeight,
    cellWidth,
    cellHeight,
    targetX,
    targetY,
    targetWidth,
    targetHeight
  );
  return canvas.toBuffer("image/png");
}

function chromaKeySourceImage(image) {
  const sourceCanvas = createCanvas(image.width, image.height);
  const sourceContext = sourceCanvas.getContext("2d");
  sourceContext.drawImage(image, 0, 0);
  const imageData = sourceContext.getImageData(0, 0, image.width, image.height);
  const pixels = imageData.data;
  let minX = image.width;
  let minY = image.height;
  let maxX = 0;
  let maxY = 0;

  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const keyLike = green > 150 && green > red * 1.45 && green > blue * 1.45;
    if (keyLike) {
      pixels[index + 3] = 0;
      continue;
    }
    if (green > red && green > blue) {
      pixels[index + 1] = Math.min(green, Math.round(Math.max(red, blue) * 1.16));
    }
    const pixelIndex = index / 4;
    const x = pixelIndex % image.width;
    const y = Math.floor(pixelIndex / image.width);
    if (pixels[index + 3] > 10) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  sourceContext.putImageData(imageData, 0, 0);
  const padding = 18;
  const cropX = Math.max(0, minX - padding);
  const cropY = Math.max(0, minY - padding);
  const cropWidth = Math.min(image.width - cropX, maxX - minX + padding * 2);
  const cropHeight = Math.min(image.height - cropY, maxY - minY + padding * 2);
  const subjectCanvas = createCanvas(cropWidth, cropHeight);
  const subjectContext = subjectCanvas.getContext("2d");
  subjectContext.drawImage(sourceCanvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  return subjectCanvas;
}

function drawXiaoSourceVariant(subjectCanvas) {
  const canvas = createCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d");
  const targetScale = Math.min((size.width * 0.8) / subjectCanvas.width, (size.height * 0.9) / subjectCanvas.height);
  const targetWidth = Math.round(subjectCanvas.width * targetScale);
  const targetHeight = Math.round(subjectCanvas.height * targetScale);
  const targetX = Math.round(size.width / 2);
  const targetY = Math.round(size.height - targetHeight / 2 - 12);

  ctx.save();
  ctx.translate(targetX, targetY);
  ctx.drawImage(subjectCanvas, -targetWidth / 2, -targetHeight / 2, targetWidth, targetHeight);
  ctx.restore();
  return canvas.toBuffer("image/png");
}

async function renderScriptedAppearance(appearance) {
  if (appearance.id !== "xiao") {
    throw new Error(`No scripted pet renderer configured for ${appearance.displayName}`);
  }
  const sourcePath = path.join(sourceAssetDirectory, appearance.id, "source-chroma.png");
  const sourceImage = await loadImage(sourcePath);
  const subjectCanvas = chromaKeySourceImage(sourceImage);
  const buffers = new Map();
  const imageBuffer = drawXiaoSourceVariant(subjectCanvas);
  // 小肖必须始终使用用户确认的同一张 Q 版肖战源图，状态变化只交给渲染层 CSS 动效处理。
  for (const variant of classicVisualVariants) {
    buffers.set(variant, imageBuffer);
  }
  return buffers;
}

async function renderCommunityAppearance(appearance) {
  const spritesheetPath = path.join(sourceAssetDirectory, appearance.id, "spritesheet.webp");
  const image = await loadImage(spritesheetPath);
  if (image.width % communityAtlas.columns !== 0 || image.height % communityAtlas.rows !== 0) {
    throw new Error(`${appearance.displayName} spritesheet is not a ${communityAtlas.columns}x${communityAtlas.rows} atlas`);
  }

  const buffers = new Map();
  for (const variant of classicVisualVariants) {
    buffers.set(variant, renderCommunityPetVariant(image, variant));
  }
  return buffers;
}

async function writeVariantFiles(directory, buffers) {
  await fs.mkdir(directory, { recursive: true });
  for (const [variant, buffer] of buffers.entries()) {
    await fs.writeFile(path.join(directory, `pet-${variant}.png`), buffer);
  }
  for (const [alias, sourceVariant] of Object.entries(compatibilityVariantAliases)) {
    const buffer = buffers.get(sourceVariant);
    if (!buffer) {
      throw new Error(`Missing ${sourceVariant} buffer for ${alias} compatibility asset`);
    }
    await fs.writeFile(path.join(directory, `pet-${alias}.png`), buffer);
  }
}

await fs.mkdir(outputDirectory, { recursive: true });
const defaultBuffers = new Map();
for (const variant of classicVisualVariants) {
  const buffer = renderPetVariant(variant);
  defaultBuffers.set(variant, buffer);
}
await writeVariantFiles(outputDirectory, defaultBuffers);

for (const appearance of scriptedAppearances) {
  const buffers = await renderScriptedAppearance(appearance);
  await writeVariantFiles(path.join(outputDirectory, appearance.id), buffers);
}

const communityBuffersById = new Map();
for (const appearance of communityAppearances) {
  const buffers = await renderCommunityAppearance(appearance);
  communityBuffersById.set(appearance.id, buffers);
  await writeVariantFiles(
    path.join(outputDirectory, appearance.id),
    buffers
  );
}

for (const [legacyId, targetId] of Object.entries(legacyCommunityAppearanceAliases)) {
  const buffers = communityBuffersById.get(targetId);
  if (!buffers) {
    throw new Error(`Missing ${targetId} buffers for legacy ${legacyId} appearance assets`);
  }
  await writeVariantFiles(path.join(outputDirectory, legacyId), buffers);
}
