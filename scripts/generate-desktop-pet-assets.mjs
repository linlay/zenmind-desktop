import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import JSZip from "jszip";
import { loadBrandConfig, resolveBrandId } from "./lib/brand-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const brand = loadBrandConfig(projectRoot, resolveBrandId());
const outputDirectory = path.join(projectRoot, "public", "desktop-pet");
const configuredMarketPetsRoot = process.env.ZENMIND_PETS_ROOT
  ? path.resolve(process.env.ZENMIND_PETS_ROOT)
  : null;
const marketPetRootDirectory = configuredMarketPetsRoot ?? path.resolve(__dirname, "..", "build", "market-pets");
const marketPetPackageDirectory = configuredMarketPetsRoot
  ? path.join(marketPetRootDirectory, "dist")
  : marketPetRootDirectory;
const marketPetSourceDirectory = configuredMarketPetsRoot
  ? marketPetRootDirectory
  : path.join(marketPetRootDirectory, "expanded");
const sourceAssetDirectory = path.resolve(__dirname, "assets", "desktop-pet");
const defaultSourceAssetDirectory = path.join(projectRoot, brand.source.desktopPetRoot);

const size = {
  width: 320,
  height: 360
};

const standardActionRows = [
  { state: "idle", frameCount: 4 },
  { state: "jumping", frameCount: 4 },
  { state: "moving-left", frameCount: 8 },
  { state: "dragging", frameCount: 4 },
  { state: "done", frameCount: 6 },
  { state: "failed", frameCount: 4 },
  { state: "running", frameCount: 8 },
  { state: "awaiting", frameCount: 4 },
  { state: "review", frameCount: 4 }
];

const classicVisualVariants = standardActionRows.map((row) => row.state);

const communityAppearances = [
  {
    id: "dario",
    displayName: "Dario",
    sourceUrl: "https://github.com/az9713/Clade-Design/tree/main/assets/community-pets/dario",
    spritesheetSourceUrl: "https://gitpets.com/api/assets/pets/dario-a7bdc389/spritesheet.webp",
    publishSpritesheet: false
  },
  {
    id: "sama",
    displayName: "Mini Sama",
    sourceUrl: "https://github.com/xpert-ai/chatkit-js/tree/main/packages/chatkit-ui/public/pets/mini-sama",
    spritesheetSourceUrl: "https://gitpets.com/api/assets/pets/mini-sama-3ee267a2/spritesheet.webp",
    publishSpritesheet: false
  },
  {
    id: "pony",
    displayName: "小凌",
    sourceUrl: "local hatch-pet run",
    spritesheetSourceUrl: "scripts/assets/desktop-pet/pony/spritesheet.webp"
  }
];

const scriptedAppearances = [
  {
    id: "xiao",
    displayName: "小肖",
    notes: "A chibi built-in pet inspired by the provided references: swept black hair, dark suit, bouquet, and a gold award."
  }
];

const communityAtlas = {
  columns: 8,
  rows: 9,
  cellWidth: 192,
  cellHeight: 208
};

const standardActionFrameCounts = new Map(standardActionRows.map((row) => [row.state, row.frameCount]));

const movingLeftSprite = {
  columns: 8,
  frameWidth: 192,
  frameHeight: 208
};

const optionalCommunityAssetNames = [
  "moving-left.webp",
  "signature/dance.webp"
];

const marketPetDefinitions = [
  {
    id: "dario",
    displayName: "Dario",
    description: "皱眉卷发的宠物，适合高压专注时刻。",
    tags: ["desktop-pet", "focus"]
  },
  {
    id: "sama",
    displayName: "Mini Sama",
    description: "焦虑又机灵的宠物，适合董事会混乱能量。",
    tags: ["desktop-pet", "assistant"]
  },
  {
    id: "xiao",
    displayName: "小肖",
    description: "黑发西装形象，带着花束和金色奖杯。",
    tags: ["desktop-pet", "moving-left"],
    animatedMovingLeft: true
  },
  {
    id: "pony",
    displayName: "小凌",
    description: "侧马尾 Q 版形象，带着爱心和麦克风。",
    tags: ["desktop-pet", "moving-left", "signature"],
    animatedMovingLeft: true,
    signature: [
      {
        id: "dance",
        label: "跳舞",
        trigger: ["manual", "idle-random"],
        variants: [
          {
            path: "signature/dance.webp",
            frameCount: 30,
            durationMs: 5200,
            weight: 1
          }
        ]
      }
    ]
  }
];

const marketPetDefinitionById = new Map(marketPetDefinitions.map((definition) => [definition.id, definition]));

const marketPetStaticStates = {
  awaiting: {
    path: "awaiting.webp",
    frameCount: 4,
    durationMs: 1200,
    loop: true
  },
  done: {
    path: "done.webp",
    frameCount: 6,
    durationMs: 1200,
    loop: false,
    holdMs: 2500
  },
  dragging: {
    path: "dragging.webp",
    frameCount: 4,
    durationMs: 900,
    loop: true
  },
  failed: {
    path: "failed.webp",
    frameCount: 4,
    durationMs: 1000,
    loop: false,
    holdMs: 3000
  },
  idle: {
    path: "idle.webp",
    frameCount: 4,
    durationMs: 6000,
    loop: true
  },
  jumping: {
    path: "jumping.webp",
    frameCount: 4,
    durationMs: 1000,
    loop: false
  },
  "moving-left": {
    path: "moving-left.webp",
    frameCount: 8,
    durationMs: 900,
    loop: true,
    mirror: true
  },
  review: {
    path: "review.webp",
    frameCount: 4,
    durationMs: 1400,
    loop: true
  },
  running: {
    path: "running.webp",
    frameCount: 8,
    durationMs: 1600,
    loop: true
  }
};

const communityFrameSelections = {
  awaiting: { row: 8, column: 2 },
  dragging: { row: 4, column: 2 },
  done: { row: 4, column: 3 },
  failed: { row: 5, column: 5 },
  idle: { row: 0, column: 0 },
  jumping: { row: 4, column: 1 },
  "moving-left": { row: 2, column: 2 },
  review: { row: 8, column: 2 },
  running: { row: 7, column: 2 }
};

const xiaoFrameSelections = {
  awaiting: { row: 8, column: 2 },
  dragging: { row: 7, column: 2 },
  done: { row: 6, column: 4 },
  failed: { row: 5, column: 3 },
  idle: { row: 0, column: 0 },
  jumping: { row: 4, column: 1 },
  "moving-left": { row: 2, column: 2 },
  review: { row: 6, column: 1 },
  running: { row: 1, column: 2 }
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
  if (variant === "failed") {
    return "error";
  }
  if (variant === "moving-left") {
    return "dragging";
  }
  if (variant === "jumping") {
    return "awaiting";
  }
  if (variant === "review") {
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
  } else if (variant === "hover") {
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
  const resolvedVariant = resolveClassicExpressionVariant(variant);
  const canvas = createCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d");
  drawBackdrop(ctx);
  drawHead(ctx, resolvedVariant);
  drawBody(ctx, resolvedVariant);
  return canvas.toBuffer("image/png");
}

function getCommunityFrameSelection(variant) {
  const selection = communityFrameSelections[variant];
  if (!selection) {
    throw new Error(`No community pet frame selection configured for ${variant}`);
  }
  return selection;
}

function renderCommunityPetVariant(image, variant, frameSelection = getCommunityFrameSelection(variant)) {
  const { row, column, mirrorX = false } = frameSelection;
  const cellWidth = Math.floor(image.width / communityAtlas.columns);
  const cellHeight = Math.floor(image.height / communityAtlas.rows);
  const canvas = createCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d");
  const targetScale = Math.min((size.width * 0.88) / cellWidth, (size.height * 0.94) / cellHeight);
  const targetWidth = Math.round(cellWidth * targetScale);
  const targetHeight = Math.round(cellHeight * targetScale);
  const targetX = Math.round((size.width - targetWidth) / 2);
  const targetY = Math.round(size.height - targetHeight - 8);
  ctx.save();
  if (mirrorX) {
    ctx.translate(size.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(
    image,
    column * cellWidth,
    row * cellHeight,
    cellWidth,
    cellHeight,
    mirrorX ? size.width - targetX - targetWidth : targetX,
    targetY,
    targetWidth,
    targetHeight
  );
  ctx.restore();
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

function chromaKeyMagentaCell(image, sx, sy, sw, sh) {
  const sourceCanvas = createCanvas(sw, sh);
  const sourceContext = sourceCanvas.getContext("2d");
  sourceContext.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  const imageData = sourceContext.getImageData(0, 0, sw, sh);
  const pixels = imageData.data;
  const keepPixels = new Uint8Array(sw * sh);
  let minX = sw;
  let minY = sh;
  let maxX = 0;
  let maxY = 0;

  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const keyLike = red > 70 && blue > 70 && green < 120 && red > green * 1.35 && blue > green * 1.2 && Math.abs(red - blue) < 115;
    if (keyLike) {
      pixels[index + 3] = 0;
      continue;
    }
    const pixelIndex = index / 4;
    keepPixels[pixelIndex] = pixels[index + 3] > 10 ? 1 : 0;
  }

  const selectedPixels = selectPrimarySpriteComponent(keepPixels, sw, sh);
  for (let pixelIndex = 0; pixelIndex < selectedPixels.length; pixelIndex += 1) {
    const index = pixelIndex * 4;
    if (!selectedPixels[pixelIndex]) {
      pixels[index + 3] = 0;
      continue;
    }
    const x = pixelIndex % sw;
    const y = Math.floor(pixelIndex / sw);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  sourceContext.putImageData(imageData, 0, 0);
  if (maxX < minX || maxY < minY) {
    return createCanvas(1, 1);
  }

  const padding = 3;
  const cropX = Math.max(0, minX - padding);
  const cropY = Math.max(0, minY - padding);
  const cropWidth = Math.min(sw - cropX, maxX - minX + padding * 2);
  const cropHeight = Math.min(sh - cropY, maxY - minY + padding * 2);
  const subjectCanvas = createCanvas(cropWidth, cropHeight);
  const subjectContext = subjectCanvas.getContext("2d");
  subjectContext.drawImage(sourceCanvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  return subjectCanvas;
}

function selectPrimarySpriteComponent(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const selected = new Uint8Array(mask.length);
  const centerX = width / 2;
  const centerY = height / 2;
  let bestScore = -Infinity;
  let bestPixels = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) {
      continue;
    }
    const stack = [start];
    const component = [];
    visited[start] = 1;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    while (stack.length > 0) {
      const pixelIndex = stack.pop();
      component.push(pixelIndex);
      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);
      sumX += x;
      sumY += y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      const neighbors = [
        pixelIndex - 1,
        pixelIndex + 1,
        pixelIndex - width,
        pixelIndex + width
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || neighbor >= mask.length || visited[neighbor] || !mask[neighbor]) {
          continue;
        }
        if ((neighbor === pixelIndex - 1 && x === 0) || (neighbor === pixelIndex + 1 && x === width - 1)) {
          continue;
        }
        visited[neighbor] = 1;
        stack.push(neighbor);
      }
    }

    const componentCenterX = sumX / component.length;
    const componentCenterY = sumY / component.length;
    const distance = Math.hypot(componentCenterX - centerX, componentCenterY - centerY);
    const score = component.length - distance * 16;
    if (score > bestScore) {
      bestScore = score;
      bestPixels = component;
    }
  }

  for (const pixelIndex of bestPixels) {
    selected[pixelIndex] = 1;
  }
  return selected;
}

function drawSubjectInFrame(ctx, subjectCanvas, frameX, frameY, frameWidth, frameHeight, mirrorX = false) {
  const targetScale = Math.min((frameWidth * 0.9) / subjectCanvas.width, (frameHeight * 0.92) / subjectCanvas.height);
  const targetWidth = Math.round(subjectCanvas.width * targetScale);
  const targetHeight = Math.round(subjectCanvas.height * targetScale);
  const targetX = frameX + Math.round((frameWidth - targetWidth) / 2);
  const targetY = frameY + Math.round(frameHeight - targetHeight - 6);
  ctx.save();
  if (mirrorX) {
    ctx.translate(frameX + frameWidth, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(subjectCanvas, frameWidth - (targetX - frameX) - targetWidth, targetY, targetWidth, targetHeight);
  } else {
    ctx.drawImage(subjectCanvas, targetX, targetY, targetWidth, targetHeight);
  }
  ctx.restore();
}

function drawXiaoSourceVariant(subjectCanvas, options = {}) {
  const { mirrorX = false, offsetX = 0, rotate = 0 } = options;
  const canvas = createCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d");
  const targetScale = Math.min((size.width * 0.8) / subjectCanvas.width, (size.height * 0.9) / subjectCanvas.height);
  const targetWidth = Math.round(subjectCanvas.width * targetScale);
  const targetHeight = Math.round(subjectCanvas.height * targetScale);
  const targetX = Math.round(size.width / 2) + offsetX;
  const targetY = Math.round(size.height - targetHeight / 2 - 12);

  ctx.save();
  ctx.translate(targetX, targetY);
  ctx.rotate(rotate);
  if (mirrorX) {
    ctx.scale(-1, 1);
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(subjectCanvas, -targetWidth / 2, -targetHeight / 2, targetWidth, targetHeight);
  ctx.restore();
  return canvas.toBuffer("image/png");
}

function renderXiaoSpritesheet(image) {
  const canvas = createCanvas(communityAtlas.columns * communityAtlas.cellWidth, communityAtlas.rows * communityAtlas.cellHeight);
  const ctx = canvas.getContext("2d");
  const sourceCellWidth = image.width / communityAtlas.columns;
  const sourceCellHeight = image.height / communityAtlas.rows;
  for (let row = 0; row < communityAtlas.rows; row += 1) {
    for (let column = 0; column < communityAtlas.columns; column += 1) {
      const centerX = (column + 0.5) * sourceCellWidth;
      const centerY = (row + 0.5) * sourceCellHeight;
      const sampleWidth = sourceCellWidth * 0.92;
      const sampleHeight = sourceCellHeight * 1.62;
      const sx = Math.max(0, Math.round(centerX - sampleWidth / 2));
      const sy = Math.max(0, Math.round(centerY - sampleHeight / 2));
      const nextSx = Math.min(image.width, Math.round(centerX + sampleWidth / 2));
      const nextSy = Math.min(image.height, Math.round(centerY + sampleHeight / 2));
      const subjectCanvas = chromaKeyMagentaCell(image, sx, sy, nextSx - sx, nextSy - sy);
      drawSubjectInFrame(
        ctx,
        subjectCanvas,
        column * communityAtlas.cellWidth,
        row * communityAtlas.cellHeight,
        communityAtlas.cellWidth,
        communityAtlas.cellHeight
      );
    }
  }
  return canvas;
}

function renderXiaoPetVariant(spritesheet, variant) {
  const selection = xiaoFrameSelections[variant];
  if (!selection) {
    throw new Error(`No Xiao frame selection configured for ${variant}`);
  }
  return renderCommunityPetVariant(spritesheet, variant, selection);
}

function renderXiaoMovingLeftSprite(image) {
  const sourceColumns = 15;
  const canvas = createCanvas(movingLeftSprite.frameWidth * movingLeftSprite.columns, movingLeftSprite.frameHeight);
  const ctx = canvas.getContext("2d");

  for (let frame = 0; frame < movingLeftSprite.columns; frame += 1) {
    const sourceFrame = Math.min(
      sourceColumns - 1,
      Math.round((frame / Math.max(1, movingLeftSprite.columns - 1)) * (sourceColumns - 1))
    );
    const frameWidth = image.width / sourceColumns;
    const sourceWidth = frameWidth * 1.52;
    const centerX = (sourceFrame + 0.5) * frameWidth;
    const sx = Math.max(0, Math.round(centerX - sourceWidth / 2));
    const nextSx = Math.min(image.width, Math.round(centerX + sourceWidth / 2));
    const subjectCanvas = chromaKeyMagentaCell(image, sx, 0, nextSx - sx, image.height);
    drawSubjectInFrame(
      ctx,
      subjectCanvas,
      frame * movingLeftSprite.frameWidth,
      0,
      movingLeftSprite.frameWidth,
      movingLeftSprite.frameHeight
    );
  }

  return canvas.toBuffer("image/webp");
}

async function renderScriptedAppearance(appearance) {
  if (appearance.id !== "xiao") {
    throw new Error(`No scripted pet renderer configured for ${appearance.displayName}`);
  }
  const sourceImage = await loadImage(path.join(sourceAssetDirectory, appearance.id, "source-chroma.png"));
  const spritesheetImage = await loadImage(path.join(sourceAssetDirectory, appearance.id, "spritesheet-source.png"));
  const movingLeftImage = await loadImage(path.join(sourceAssetDirectory, appearance.id, "drag-moving-source.png"));
  const subjectCanvas = chromaKeySourceImage(sourceImage);
  const spritesheet = renderXiaoSpritesheet(spritesheetImage);
  const buffers = new Map();
  const crispSourceBuffer = drawXiaoSourceVariant(subjectCanvas);
  for (const variant of classicVisualVariants) {
    buffers.set(variant, crispSourceBuffer);
  }
  buffers.set("dragging", drawXiaoSourceVariant(subjectCanvas, { rotate: -0.04 }));
  buffers.set("moving-left", drawXiaoSourceVariant(subjectCanvas, { offsetX: -8, rotate: -0.05 }));
  return {
    buffers,
    spritesheetBuffer: spritesheet.toBuffer("image/webp"),
    movingLeftSpriteBuffer: renderXiaoMovingLeftSprite(movingLeftImage)
  };
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

async function renderAnimatedVariantStrip(buffer, variant) {
  const image = await loadImage(buffer);
  const frameCount = standardActionFrameCounts.get(variant) ?? 4;
  const canvas = createCanvas(communityAtlas.cellWidth * frameCount, communityAtlas.cellHeight);
  const ctx = canvas.getContext("2d");
  const motions = variant === "jumping"
    ? [0, -14, -5, 0, -10, -2, 0, -4]
    : variant === "failed"
      ? [0, -4, 4, -2, 2, -3, 3, 0]
      : variant === "dragging" || variant === "moving-left"
        ? [-3, -1, 2, 0, -2, 1, 3, 0]
        : [0, -2, -1, 0, -1, -2, 0, -1];
  const targetScale = Math.min(communityAtlas.cellWidth / image.width, communityAtlas.cellHeight / image.height);
  const targetWidth = Math.round(image.width * targetScale);
  const targetHeight = Math.round(image.height * targetScale);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = motions[frame] ?? 0;
    const frameX = frame * communityAtlas.cellWidth;
    const targetX = frameX + Math.round((communityAtlas.cellWidth - targetWidth) / 2) + (variant === "failed" ? offset : 0);
    const targetY = Math.round((communityAtlas.cellHeight - targetHeight) / 2) + (variant === "failed" ? 0 : offset);
    ctx.drawImage(image, targetX, targetY, targetWidth, targetHeight);
  }
  return canvas.toBuffer("image/webp");
}

async function renderZenmiSpritesheet(directory) {
  const canvas = createCanvas(
    communityAtlas.columns * communityAtlas.cellWidth,
    communityAtlas.rows * communityAtlas.cellHeight
  );
  const ctx = canvas.getContext("2d");

  for (const [rowIndex, row] of standardActionRows.entries()) {
    const stripPath = path.join(directory, `${row.state}.webp`);
    const strip = await loadImage(stripPath);
    const expectedWidth = row.frameCount * communityAtlas.cellWidth;
    if (strip.width !== expectedWidth || strip.height !== communityAtlas.cellHeight) {
      throw new Error(
        `${row.state}.webp must be ${expectedWidth}x${communityAtlas.cellHeight}; got ${strip.width}x${strip.height}`
      );
    }

    for (let frame = 0; frame < row.frameCount; frame += 1) {
      ctx.drawImage(
        strip,
        frame * communityAtlas.cellWidth,
        0,
        communityAtlas.cellWidth,
        communityAtlas.cellHeight,
        frame * communityAtlas.cellWidth,
        rowIndex * communityAtlas.cellHeight,
        communityAtlas.cellWidth,
        communityAtlas.cellHeight
      );
    }
  }

  return canvas.toBuffer("image/webp");
}

async function writeVariantFiles(directory, buffers) {
  await fs.mkdir(directory, { recursive: true });
  for (const [variant, buffer] of buffers.entries()) {
    await fs.writeFile(path.join(directory, `${variant}.png`), buffer);
    await fs.writeFile(path.join(directory, `${variant}.webp`), await renderAnimatedVariantStrip(buffer, variant));
  }
}

function addManifestAssetPath(assetNames, value) {
  if (typeof value !== "string" || !value.trim()) {
    return;
  }
  const normalized = value.trim().replace(/\\/gu, "/").replace(/^\/+/u, "");
  if (normalized && normalized !== "pet.json") {
    assetNames.add(normalized);
  }
}

function addSignatureAssetPaths(assetNames, actions) {
  if (!Array.isArray(actions)) {
    return;
  }
  for (const action of actions) {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      continue;
    }
    if (!Array.isArray(action.variants)) {
      continue;
    }
    for (const variant of action.variants) {
      if (variant && typeof variant === "object" && !Array.isArray(variant)) {
        addManifestAssetPath(assetNames, variant.path);
      }
    }
  }
}

function collectDefaultPetAssetNames(manifest) {
  const assetNames = new Set(["pet.json"]);
  addManifestAssetPath(assetNames, manifest.preview);
  if (manifest.states && typeof manifest.states === "object" && !Array.isArray(manifest.states)) {
    for (const state of Object.values(manifest.states)) {
      if (!state || typeof state !== "object" || Array.isArray(state)) {
        continue;
      }
      addManifestAssetPath(assetNames, state.path);
      addSignatureAssetPaths(assetNames, state.alts);
    }
  }
  addSignatureAssetPaths(assetNames, manifest.signature);
  return assetNames;
}

async function copyDefaultBrandPetAssets() {
  await fs.rm(outputDirectory, { recursive: true, force: true });
  await fs.mkdir(outputDirectory, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(defaultSourceAssetDirectory, "pet.json"), "utf8"));
  const assetNames = collectDefaultPetAssetNames(manifest);
  try {
    await fs.access(path.join(defaultSourceAssetDirectory, "spritesheet.webp"));
    assetNames.add("spritesheet.webp");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  for (const assetName of assetNames) {
    await fs.mkdir(path.dirname(path.join(outputDirectory, assetName)), { recursive: true });
    await fs.copyFile(
      path.join(defaultSourceAssetDirectory, assetName),
      path.join(outputDirectory, assetName)
    );
  }
  try {
    await fs.access(path.join(outputDirectory, "spritesheet.webp"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    await fs.writeFile(path.join(outputDirectory, "spritesheet.webp"), await renderZenmiSpritesheet(outputDirectory));
  }
}

async function writeMarketPetManifest(directory, petId) {
  const definition = marketPetDefinitionById.get(petId);
  if (!definition) {
    throw new Error(`Missing market pet definition for ${petId}`);
  }
  const states = {
    ...marketPetStaticStates,
    ...(definition.animatedMovingLeft
      ? {
          "moving-left": {
            path: "moving-left.webp",
            frameCount: 8,
            durationMs: 900,
            loop: true,
            mirror: true
          }
        }
      : {})
  };
  const manifest = {
    id: definition.id,
    displayName: definition.displayName,
    version: "1.0.0",
    description: definition.description,
    tags: definition.tags,
    preview: "idle.png",
    states,
    ...(definition.signature ? { signature: definition.signature } : {})
  };
  await fs.writeFile(path.join(directory, "pet.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function addDirectoryToZip(zip, directory, zipPrefix) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".DS_Store") {
      continue;
    }
    const sourcePath = path.join(directory, entry.name);
    const zipPath = `${zipPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      zip.folder(zipPath);
      await addDirectoryToZip(zip, sourcePath, zipPath);
      continue;
    }
    if (entry.isFile()) {
      zip.file(zipPath, await fs.readFile(sourcePath));
    }
  }
}

async function writeMarketPetZip(petId) {
  const sourceDirectory = path.join(marketPetSourceDirectory, petId);
  const zip = new JSZip();
  zip.folder(petId);
  await addDirectoryToZip(zip, sourceDirectory, petId);
  const content = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: {
      level: 9
    }
  });
  await fs.writeFile(path.join(marketPetPackageDirectory, `${petId}.zip`), content);
}

async function resetMarketPetOutput() {
  if (!configuredMarketPetsRoot) {
    await fs.rm(marketPetRootDirectory, { recursive: true, force: true });
    return;
  }

  await fs.mkdir(marketPetRootDirectory, { recursive: true });
  for (const definition of marketPetDefinitions) {
    await fs.rm(path.join(marketPetRootDirectory, definition.id), { recursive: true, force: true });
  }
  await fs.rm(marketPetPackageDirectory, { recursive: true, force: true });
}

await fs.rm(outputDirectory, { recursive: true, force: true });
await resetMarketPetOutput();
await fs.mkdir(outputDirectory, { recursive: true });
await fs.mkdir(marketPetSourceDirectory, { recursive: true });
await fs.mkdir(marketPetPackageDirectory, { recursive: true });
await copyDefaultBrandPetAssets();

for (const appearance of scriptedAppearances) {
  const renderedAppearance = await renderScriptedAppearance(appearance);
  const appearanceOutputDirectory = path.join(marketPetSourceDirectory, appearance.id);
  await writeVariantFiles(appearanceOutputDirectory, renderedAppearance.buffers);
  if (renderedAppearance.spritesheetBuffer) {
    await fs.writeFile(path.join(appearanceOutputDirectory, "spritesheet.webp"), renderedAppearance.spritesheetBuffer);
  }
  if (renderedAppearance.movingLeftSpriteBuffer) {
    await fs.writeFile(path.join(appearanceOutputDirectory, "moving-left.webp"), renderedAppearance.movingLeftSpriteBuffer);
  }
}

const communityBuffersById = new Map();
for (const appearance of communityAppearances) {
  const buffers = await renderCommunityAppearance(appearance);
  communityBuffersById.set(appearance.id, buffers);
  const appearanceOutputDirectory = path.join(marketPetSourceDirectory, appearance.id);
  await writeVariantFiles(appearanceOutputDirectory, buffers);
  if (appearance.publishSpritesheet !== false) {
    await fs.copyFile(
      path.join(sourceAssetDirectory, appearance.id, "spritesheet.webp"),
      path.join(appearanceOutputDirectory, "spritesheet.webp")
    );
  }
  for (const assetName of optionalCommunityAssetNames) {
    const sourcePath = path.join(sourceAssetDirectory, appearance.id, assetName);
    const targetPath = path.join(appearanceOutputDirectory, assetName);
    try {
      await fs.access(sourcePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(
        sourcePath,
        targetPath
      );
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

for (const definition of marketPetDefinitions) {
  await writeMarketPetManifest(path.join(marketPetSourceDirectory, definition.id), definition.id);
  await writeMarketPetZip(definition.id);
}
