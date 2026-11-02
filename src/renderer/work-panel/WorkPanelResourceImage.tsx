import {
  ArrowLeftOutlined,
  BorderOutlined,
  CheckOutlined,
  CloseOutlined,
  ControlOutlined,
  DownloadOutlined,
  DeleteOutlined,
  DragOutlined,
  EditOutlined,
  HighlightOutlined,
  InfoCircleOutlined,
  RedoOutlined,
  RotateLeftOutlined,
  RotateRightOutlined,
  SaveOutlined,
  ScissorOutlined,
  ThunderboltOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import { Popover, Tooltip } from "antd";
import { Canvas as FabricCanvas, FabricImage } from "fabric";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { ImageRegionAnnotation } from "../../shared/work-panel-review";
import type {
  WorkPanelResourceImageAiOperation,
  WorkPanelResourceImageSelection,
} from "../../shared/work-panel-resource-image";
import { useI18n } from "../i18n/useI18n";
import { ImageZoomControl, IMAGE_ZOOM_STEPS } from "./ImageZoomControl";
import { WorkPanelImageToolIcon } from "./WorkPanelImageToolIcon";

const HISTORY_LIMIT = 50;

const SELECTION_PALETTE = [
  "#000000",
  "#555555",
  "#8b0000",
  "#e60000",
  "#ff6a00",
  "#ffb800",
  "#7ed321",
  "#00b8a9",
  "#0066ff",
  "#8e44ad",
  "#ffffff",
  "#cfcfcf",
  "#d98b7a",
  "#ff9aa2",
  "#ffb347",
  "#ffe07a",
  "#b6e38a",
  "#7fe0d6",
  "#7fb3ff",
  "#c9a0dc",
];

type Snapshot = {
  url: string;
  width: number;
  height: number;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
};

type HistoryEntry = Snapshot & {
  selections: SelectionRegion[];
  eraseRegions: EraseRegion[];
  activeSelectionId: string;
};

const EMPTY_SELECTIONS: SelectionRegion[] = [];
const EMPTY_ERASE_REGIONS: EraseRegion[] = [];

type SelectionTool = "rectangle" | "ellipse";
type EraseTool = "brush" | "rectangle";
type EraseRegion =
  | { tool: "brush"; points: Point[]; width: number }
  | { tool: "rectangle"; bounds: CropRect };
type AiPromptOperation = "replaceBackground" | "outpaint";
type Point = { x: number; y: number };
type FloatingPanelKind = "tools" | "annotations";
type FloatingPanelPosition = { x: number; y: number } | null;
type FloatingPanelDrag = {
  kind: FloatingPanelKind;
  pointerId: number;
  clientX: number;
  clientY: number;
  left: number;
  top: number;
};
type GesturePreview = {
  kind: "annotate" | "select";
  shape?: SelectionTool;
  points: Point[];
};
type PanDrag = {
  clientX: number;
  clientY: number;
  viewX: number;
  viewY: number;
};
type CropRect = { x: number; y: number; width: number; height: number };
type CropDragMode = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type SelectionRegion = {
  id: string;
  tool: SelectionTool;
  bounds: CropRect;
  style: "line" | "fill";
  color: string;
  lineWidth: number;
};

type ImageButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "title" | "type"
> & {
  label: string;
};

function ImageToolButton({
  children,
  label,
  ...buttonProps
}: ImageButtonProps) {
  return (
    <Tooltip title={label} placement="right" mouseEnterDelay={0.15}>
      <span className="work-panel-image-tool-tooltip-anchor">
        <button {...buttonProps} type="button" aria-label={label}>
          {children}
        </button>
      </span>
    </Tooltip>
  );
}

function ImageToolbarButton({ label, ...buttonProps }: ImageButtonProps) {
  return (
    <Tooltip title={label} mouseEnterDelay={0.15}>
      <span className="work-panel-image-toolbar-button-anchor">
        <button {...buttonProps} type="button" aria-label={label}>
          <span className="work-panel-image-toolbar-button-label">{label}</span>
        </button>
      </span>
    </Tooltip>
  );
}

type WorkPanelResourceImageProps = {
  active: boolean;
  editing: boolean;
  ownerChatId: string;
  itemId: string;
  rendererGeneration: string;
  resource: WorkPanelResourceImageSelection;
  onEditingChange(editing: boolean): void;
  onCommitted(resource: WorkPanelResourceImageSelection): void;
  onHandoff(input: {
    annotations: ImageRegionAnnotation[];
    dataBase64: string;
    sizeBytes: number;
    width: number;
    height: number;
  }): Promise<boolean>;
};

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image_decode_failed"));
    image.src = url;
  });
}

function imageBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  if (
    value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "Buffer" &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    return Uint8Array.from((value as { data: number[] }).data);
  }
  return null;
}

function canvasBlob(
  canvas: HTMLCanvasElement,
  mimeType: Snapshot["mimeType"] = "image/png",
) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("image_encode_failed")),
      mimeType,
      0.94,
    );
  });
}

function blobBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(String(reader.result || "").split(",", 2)[1] || "");
    reader.onerror = () =>
      reject(reader.error || new Error("image_read_failed"));
    reader.readAsDataURL(blob);
  });
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function rectFromPoints(start: Point, end: Point) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(start.x - end.x),
    height: Math.abs(start.y - end.y),
  };
}

function fitZoomFor(
  viewport: { clientWidth: number; clientHeight: number },
  image: Snapshot,
) {
  const availableWidth = Math.max(1, viewport.clientWidth - 48);
  const availableHeight = Math.max(1, viewport.clientHeight - 48);
  return clamp(
    Math.min(availableWidth / image.width, availableHeight / image.height) *
      100,
    10,
    800,
  );
}

function centeredView(
  viewport: { clientWidth: number; clientHeight: number },
  image: Snapshot,
  zoomPercent: number,
): Point {
  const scale = zoomPercent / 100;
  return {
    x: (viewport.clientWidth - image.width * scale) / 2,
    y: (viewport.clientHeight - image.height * scale) / 2,
  };
}

// Keep at least a quarter of the image (48px floor) inside the viewport while panning.
function clampView(
  view: Point,
  viewport: { clientWidth: number; clientHeight: number },
  image: Snapshot,
  zoomPercent: number,
): Point {
  const scale = zoomPercent / 100;
  const width = image.width * scale;
  const height = image.height * scale;
  const clampAxis = (
    value: number,
    viewportSize: number,
    contentSize: number,
  ) => {
    const keepVisible = Math.max(48, Math.min(contentSize, contentSize * 0.25));
    const lower = keepVisible - contentSize;
    const upper = Math.max(lower, viewportSize - keepVisible);
    return clamp(value, lower, upper);
  };
  return {
    x: clampAxis(view.x, viewport.clientWidth, width),
    y: clampAxis(view.y, viewport.clientHeight, height),
  };
}

function colorWithAlpha(hex: string, alpha: number) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return `rgb(101 78 255 / ${alpha})`;
  const value = Number.parseInt(match[1], 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return `rgb(${red} ${green} ${blue} / ${alpha})`;
}

function buildSelectionBounds(
  points: Point[],
  image: { width: number; height: number },
): CropRect | null {
  if (points.length < 2) return null;
  const rect = rectFromPoints(points[0], points[1]);
  const minX = clamp(rect.x, 0, image.width);
  const minY = clamp(rect.y, 0, image.height);
  const maxX = clamp(rect.x + rect.width, 0, image.width);
  const maxY = clamp(rect.y + rect.height, 0, image.height);
  const width = maxX - minX;
  const height = maxY - minY;
  if (width < 2 || height < 2) return null;
  return { x: minX, y: minY, width, height };
}

function fillSelectionShape(
  context: CanvasRenderingContext2D,
  tool: SelectionTool,
  bounds: CropRect,
) {
  if (tool === "ellipse") {
    context.beginPath();
    context.ellipse(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
      bounds.width / 2,
      bounds.height / 2,
      0,
      0,
      Math.PI * 2,
    );
    context.fill();
    return;
  }
  context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
}

function drawEraseRegion(
  context: CanvasRenderingContext2D,
  region: EraseRegion,
) {
  if (region.tool === "rectangle") {
    fillSelectionShape(context, "rectangle", region.bounds);
    return;
  }
  const [start, ...points] = region.points;
  if (!start) return;
  context.lineWidth = region.width;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(start.x, start.y);
  for (const point of points) context.lineTo(point.x, point.y);
  context.stroke();
  context.beginPath();
  context.arc(start.x, start.y, region.width / 2, 0, Math.PI * 2);
  context.fill();
}

function drawSelectionVisual(
  context: CanvasRenderingContext2D,
  selection: SelectionRegion,
  bounds: CropRect,
  zoomScale: number,
) {
  context.save();
  if (selection.style === "fill") {
    context.fillStyle = colorWithAlpha(selection.color, 0.34);
    fillSelectionShape(context, selection.tool, bounds);
  } else {
    context.strokeStyle = selection.color;
    context.lineWidth = Math.max(
      1,
      selection.lineWidth / Math.max(0.01, zoomScale),
    );
    context.beginPath();
    if (selection.tool === "ellipse") {
      context.ellipse(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
        bounds.width / 2,
        bounds.height / 2,
        0,
        0,
        Math.PI * 2,
      );
    } else {
      context.rect(bounds.x, bounds.y, bounds.width, bounds.height);
    }
    context.stroke();
  }
  context.restore();
}

function resizeFrame(
  initial: CropRect,
  mode: CropDragMode,
  dx: number,
  dy: number,
  minWidth: number,
  minHeight: number,
  imageWidth: number,
  imageHeight: number,
): CropRect {
  let { x, y, width, height } = initial;
  if (mode === "move") {
    x = clamp(initial.x + dx, 0, Math.max(0, imageWidth - initial.width));
    y = clamp(initial.y + dy, 0, Math.max(0, imageHeight - initial.height));
    return { x, y, width, height };
  }
  const movesLeft = mode === "nw" || mode === "w" || mode === "sw";
  const movesRight = mode === "ne" || mode === "e" || mode === "se";
  const movesTop = mode === "nw" || mode === "n" || mode === "ne";
  const movesBottom = mode === "sw" || mode === "s" || mode === "se";
  if (movesLeft) {
    x = clamp(initial.x + dx, 0, initial.x + initial.width - minWidth);
    width = initial.x + initial.width - x;
  } else if (movesRight) {
    width = clamp(initial.width + dx, minWidth, imageWidth - initial.x);
  }
  if (movesTop) {
    y = clamp(initial.y + dy, 0, initial.y + initial.height - minHeight);
    height = initial.y + initial.height - y;
  } else if (movesBottom) {
    height = clamp(initial.height + dy, minHeight, imageHeight - initial.y);
  }
  return { x, y, width, height };
}

function imageFormat(mimeType: string) {
  if (mimeType === "image/jpeg") return "JPEG";
  if (mimeType === "image/webp") return "WebP";
  return "PNG";
}

function editableImageMime(mimeType: string): Snapshot["mimeType"] {
  return mimeType === "image/jpeg" || mimeType === "image/webp"
    ? mimeType
    : "image/png";
}

export function WorkPanelResourceImage({
  active,
  editing,
  ownerChatId,
  itemId,
  rendererGeneration,
  resource,
  onEditingChange,
  onCommitted,
  onHandoff,
}: WorkPanelResourceImageProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imageCanvasRef = useRef<HTMLDivElement | null>(null);
  const floatingControlsRef = useRef<HTMLDivElement | null>(null);
  const annotationsPanelRef = useRef<HTMLElement | null>(null);
  const selectionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const eraseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const eraseGestureRef = useRef<EraseRegion | null>(null);
  const snapshotUrlsRef = useRef(new Set<string>());
  const originalSnapshotRef = useRef<Snapshot | null>(null);
  const drawStartRef = useRef<Point | null>(null);
  const panRef = useRef<PanDrag | null>(null);
  const lineWidthWheelRef = useRef(0);
  const eraseWidthWheelRef = useRef(0);
  const fabricHostRef = useRef<HTMLDivElement | null>(null);
  const fabricCanvasRef = useRef<FabricCanvas | null>(null);
  const fabricImageRef = useRef<FabricImage | null>(null);
  const floatingPanelDragRef = useRef<FloatingPanelDrag | null>(null);
  const previousEditingRef = useRef(editing);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tool, setTool] = useState<
    "pan" | "crop" | "annotate" | "select" | "erase"
  >("pan");
  const [selectionTool, setSelectionTool] =
    useState<SelectionTool>("rectangle");
  const [selectionLineWidth, setSelectionLineWidth] = useState(2);
  const [eraseTool, setEraseTool] = useState<EraseTool>("brush");
  const [eraseBrushWidth, setEraseBrushWidth] = useState(32);
  const [erasePreview, setErasePreview] = useState<EraseRegion | null>(null);
  const [activeEraseRegion, setActiveEraseRegion] =
    useState<EraseRegion | null>(null);
  const [eraseFramePreview, setEraseFramePreview] = useState<{
    index: number;
    region: Extract<EraseRegion, { tool: "rectangle" }>;
  } | null>(null);
  const [selectionStyle, setSelectionStyle] = useState<"line" | "fill">("line");
  const [selectionColor, setSelectionColor] = useState("#e60000");
  const [gesturePreview, setGesturePreview] = useState<GesturePreview | null>(
    null,
  );
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [annotations, setAnnotations] = useState<ImageRegionAnnotation[]>([]);
  const [activeAnnotationId, setActiveAnnotationId] = useState("");
  const [annotationsOpen, setAnnotationsOpen] = useState(false);
  const [annotationDraft, setAnnotationDraft] =
    useState<ImageRegionAnnotation | null>(null);
  const [floatingControlsPosition, setFloatingControlsPosition] =
    useState<FloatingPanelPosition>(null);
  const [annotationsPanelPosition, setAnnotationsPanelPosition] =
    useState<FloatingPanelPosition>(null);
  const [zoom, setZoom] = useState(100);
  const [fitMode, setFitMode] = useState(true);
  const [fitZoom, setFitZoom] = useState(100);
  const [view, setView] = useState<Point>({ x: 0, y: 0 });
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjust, setAdjust] = useState({
    exposure: 0,
    contrast: 0,
    saturation: 0,
  });
  const [aiPromptOperation, setAiPromptOperation] =
    useState<AiPromptOperation | null>(null);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiTargetSize, setAiTargetSize] = useState({ width: 0, height: 0 });
  const [aiBusy, setAiBusy] = useState<{
    requestId: string;
    operation: WorkPanelResourceImageAiOperation;
  } | null>(null);
  const [aiSuccess, setAiSuccess] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [sourceConflict, setSourceConflict] = useState(false);
  const [sourceRevision, setSourceRevision] = useState(resource.revision);
  const [handoffBusy, setHandoffBusy] = useState(false);

  const annotationMode = tool === "annotate";
  const imageToolsDisabled = annotationMode || Boolean(aiBusy);
  const current = history[historyIndex] || null;
  const selections = current?.selections ?? EMPTY_SELECTIONS;
  const activeSelectionId = current?.activeSelectionId ?? "";
  const hasSelection = selections.length > 0;
  const eraseRegions = current?.eraseRegions ?? EMPTY_ERASE_REGIONS;
  const hasEraseRegions = eraseRegions.length > 0;
  const activeAnnotation =
    annotations.find((annotation) => annotation.id === activeAnnotationId) ||
    annotations[0] ||
    null;
  const effectiveZoom = fitMode ? fitZoom : zoom;
  const original = originalSnapshotRef.current;
  const pixelDirty = Boolean(
    current &&
    original &&
    (current.url !== original.url ||
      current.width !== original.width ||
      current.height !== original.height ||
      current.mimeType !== original.mimeType),
  );
  const dirty =
    pixelDirty || annotations.length > 0 || Boolean(annotationDraft);
  const editDisabled = Boolean(
    current &&
    (current.width > 8_192 ||
      current.height > 8_192 ||
      current.width * current.height > 40_000_000),
  );
  const aiOperationLabel = (operation: WorkPanelResourceImageAiOperation) =>
    t(
      operation === "inpaint"
        ? "chatWorkPanel.image.smartEdit"
        : operation === "removeObject"
          ? "chatWorkPanel.image.removeObject"
          : operation === "removeBackground"
            ? "chatWorkPanel.image.removeBackground"
            : operation === "replaceBackground"
              ? "chatWorkPanel.image.replaceBackground"
              : operation === "outpaint"
                ? "chatWorkPanel.image.outpaint"
                : "chatWorkPanel.image.enhance",
    );

  const handleRequest = useMemo(
    () => ({
      ownerChatId,
      rendererGeneration,
      handleId: resource.handleId,
    }),
    [ownerChatId, rendererGeneration, resource.handleId],
  );

  // A pixel change is a new step; selection history resets because coordinates refer to the old bitmap.
  const replaceHistory = useCallback(
    (next: Snapshot) => {
      snapshotUrlsRef.current.add(next.url);
      setHistory((previous) => {
        const retained = previous.slice(0, historyIndex + 1);
        const appended: HistoryEntry = {
          ...next,
          selections: EMPTY_SELECTIONS,
          eraseRegions: EMPTY_ERASE_REGIONS,
          activeSelectionId: "",
        };
        const limited = [...retained, appended].slice(-HISTORY_LIMIT);
        const usedUrls = new Set(limited.map((entry) => entry.url));
        for (const entry of previous) {
          if (usedUrls.has(entry.url)) continue;
          if (!entry.url.startsWith("blob:")) continue;
          if (!snapshotUrlsRef.current.has(entry.url)) continue;
          URL.revokeObjectURL(entry.url);
          snapshotUrlsRef.current.delete(entry.url);
        }
        setHistoryIndex(limited.length - 1);
        return limited;
      });
      setCropRect(null);
      const display = selectionCanvasRef.current;
      display?.getContext("2d")?.clearRect(0, 0, display.width, display.height);
    },
    [historyIndex],
  );

  const readResource = useCallback(async () => {
    setLoading(true);
    setError("");
    const result =
      await window.electronAPI.chatWorkPanel.resourceImages.read(handleRequest);
    if (!result.ok || !result.data) {
      setLoading(false);
      return;
    }
    const bytes = imageBytes(result.data);
    if (!bytes?.byteLength) {
      setLoading(false);
      return;
    }
    const blob = new Blob([bytes], { type: resource.mimeType });
    const url = URL.createObjectURL(blob);
    try {
      const image = await loadImage(url);
      for (const previousUrl of snapshotUrlsRef.current)
        URL.revokeObjectURL(previousUrl);
      snapshotUrlsRef.current = new Set([url]);
      const loaded: Snapshot = {
        url,
        width: image.naturalWidth,
        height: image.naturalHeight,
        mimeType: editableImageMime(resource.mimeType),
      };
      originalSnapshotRef.current = loaded;
      setHistory([
        {
          ...loaded,
          selections: EMPTY_SELECTIONS,
          eraseRegions: EMPTY_ERASE_REGIONS,
          activeSelectionId: "",
        },
      ]);
      setHistoryIndex(0);
      setAnnotations([]);
      setAnnotationsOpen(false);
      setAnnotationDraft(null);
      setActiveAnnotationId("");
      eraseGestureRef.current = null;
      setErasePreview(null);
      setAiPromptOperation(null);
      setAiInstruction("");
      setAiSuccess("");
      setSourceRevision(result.revision || resource.revision);
      setSourceConflict(false);
      setTool("pan");
    } catch {
      URL.revokeObjectURL(url);
    } finally {
      setLoading(false);
    }
  }, [handleRequest, resource.mimeType, resource.revision]);

  const discardEditingDraft = useCallback(() => {
    for (const url of snapshotUrlsRef.current) URL.revokeObjectURL(url);
    snapshotUrlsRef.current.clear();
    const selection = selectionCanvasRef.current;
    selection
      ?.getContext("2d")
      ?.clearRect(0, 0, selection.width, selection.height);
    drawStartRef.current = null;
    panRef.current = null;
    floatingPanelDragRef.current = null;
    setHistory([]);
    setHistoryIndex(0);
    setError("");
    setTool("pan");
    setSelectionTool("rectangle");
    setSelectionStyle("line");
    setSelectionColor("#e60000");
    setSelectionLineWidth(2);
    setEraseTool("brush");
    setEraseBrushWidth(32);
    eraseGestureRef.current = null;
    setErasePreview(null);
    setGesturePreview(null);
    setCropRect(null);
    setAnnotations([]);
    setAnnotationsOpen(false);
    setAnnotationDraft(null);
    setActiveAnnotationId("");
    setAdjustOpen(false);
    setAdjust({ exposure: 0, contrast: 0, saturation: 0 });
    setAiPromptOperation(null);
    setAiInstruction("");
    setAiTargetSize({ width: 0, height: 0 });
    setAiSuccess("");
    setSaveOpen(false);
    setSourceConflict(false);
    setFloatingControlsPosition(null);
    setAnnotationsPanelPosition(null);
    void readResource();
  }, [readResource]);

  useLayoutEffect(() => {
    const wasEditing = previousEditingRef.current;
    previousEditingRef.current = editing;
    if (wasEditing && !editing) discardEditingDraft();
  }, [discardEditingDraft, editing]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const keepPanelsVisible = () => {
      const clampPosition = (
        position: FloatingPanelPosition,
        panel: HTMLElement | null,
      ): FloatingPanelPosition => {
        if (!position || !panel) return position;
        return {
          x: clamp(
            position.x,
            0,
            Math.max(0, content.clientWidth - panel.offsetWidth),
          ),
          y: clamp(
            position.y,
            0,
            Math.max(0, content.clientHeight - panel.offsetHeight),
          ),
        };
      };
      setFloatingControlsPosition((position) =>
        clampPosition(position, floatingControlsRef.current),
      );
      setAnnotationsPanelPosition((position) =>
        clampPosition(position, annotationsPanelRef.current),
      );
    };
    const observer = new ResizeObserver(keepPanelsVisible);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  // Fabric owns the bitmap rendering; the viewport is a zoom + pan transform (no scrollbars).
  useEffect(() => {
    const host = fabricHostRef.current;
    if (!host) return;
    const element = document.createElement("canvas");
    host.appendChild(element);
    const canvas = new FabricCanvas(element, {
      selection: false,
      skipTargetFind: true,
      renderOnAddRemove: false,
      enableRetinaScaling: true,
    });
    fabricCanvasRef.current = canvas;
    const viewport = viewportRef.current;
    if (viewport)
      canvas.setDimensions({
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      });
    canvas.requestRenderAll();
    return () => {
      fabricCanvasRef.current = null;
      fabricImageRef.current = null;
      void canvas.dispose();
      host.replaceChildren();
    };
  }, []);

  useEffect(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    if (fabricImageRef.current) {
      canvas.remove(fabricImageRef.current);
      fabricImageRef.current = null;
    }
    if (!current) {
      canvas.requestRenderAll();
      return;
    }
    const source = current.url;
    let disposed = false;
    void FabricImage.fromURL(source)
      .then((image) => {
        if (disposed) return;
        image.set({
          left: 0,
          top: 0,
          originX: "left",
          originY: "top",
          selectable: false,
          evented: false,
        });
        canvas.add(image);
        canvas.sendObjectToBack(image);
        fabricImageRef.current = image;
        canvas.requestRenderAll();
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [current?.url]);

  useEffect(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    const scale = effectiveZoom / 100;
    canvas.setViewportTransform([scale, 0, 0, scale, view.x, view.y]);
    canvas.requestRenderAll();
  }, [effectiveZoom, view]);

  const imageSizeRef = useRef<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !current) return;
    const update = () => {
      const canvas = fabricCanvasRef.current;
      if (canvas)
        canvas.setDimensions({
          width: viewport.clientWidth,
          height: viewport.clientHeight,
        });
      const nextFitZoom = fitZoomFor(viewport, current);
      setFitZoom(nextFitZoom);
      if (fitMode) setView(centeredView(viewport, current, nextFitZoom));
    };
    const previous = imageSizeRef.current;
    imageSizeRef.current = { width: current.width, height: current.height };
    if (
      !fitMode &&
      previous &&
      (previous.width !== current.width || previous.height !== current.height)
    ) {
      // Cropping or resizing the bitmap keeps the picture centred instead of pinning its origin.
      setView(centeredView(viewport, current, effectiveZoom));
    }
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [current?.url, current?.width, current?.height, effectiveZoom, fitMode]);

  const renderSelectionDisplay = useCallback(() => {
    const display = selectionCanvasRef.current;
    if (!display || !display.width || !display.height) return;
    const context = display.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, display.width, display.height);
    const scale = effectiveZoom / 100;
    for (const region of selections) {
      drawSelectionVisual(context, region, region.bounds, scale);
    }
  }, [effectiveZoom, selections]);

  useEffect(() => {
    const display = selectionCanvasRef.current;
    if (!display || !current) return;
    if (display.width !== current.width || display.height !== current.height) {
      display.width = current.width;
      display.height = current.height;
    }
    display.getContext("2d")?.clearRect(0, 0, display.width, display.height);
  }, [current?.url, current?.width, current?.height]);

  useEffect(() => {
    renderSelectionDisplay();
  }, [renderSelectionDisplay]);

  useEffect(() => {
    const canvas = eraseCanvasRef.current;
    if (!canvas || !current) return;
    canvas.width = current.width;
    canvas.height = current.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = "#8764ef";
    context.strokeStyle = "#8764ef";
    eraseRegions.forEach((region, index) => {
      drawEraseRegion(
        context,
        eraseFramePreview?.index === index ? eraseFramePreview.region : region,
      );
    });
    if (erasePreview) drawEraseRegion(context, erasePreview);
  }, [
    current?.url,
    current?.width,
    current?.height,
    eraseRegions,
    erasePreview,
    eraseFramePreview,
  ]);

  const clampViewToViewport = useCallback(
    (value: Point, zoomPercent: number): Point => {
      const viewport = viewportRef.current;
      if (!viewport || !current) return value;
      return clampView(value, viewport, current, zoomPercent);
    },
    [current],
  );

  const zoomTo = useCallback(
    (next: number, anchor?: Point) => {
      if (!Number.isFinite(next)) return;
      const rounded = Math.round(clamp(next, 10, 800) * 100) / 100;
      if (rounded === effectiveZoom) return;
      const viewport = viewportRef.current;
      setFitMode(false);
      setZoom(rounded);
      if (!viewport) return;
      const anchorX = anchor ? anchor.x : viewport.clientWidth / 2;
      const anchorY = anchor ? anchor.y : viewport.clientHeight / 2;
      const before = effectiveZoom / 100;
      const after = rounded / 100;
      setView((value) =>
        clampViewToViewport(
          {
            x: anchorX - ((anchorX - value.x) / before) * after,
            y: anchorY - ((anchorY - value.y) / before) * after,
          },
          rounded,
        ),
      );
    },
    [clampViewToViewport, effectiveZoom],
  );

  useEffect(() => {
    void readResource();
  }, [readResource]);

  useEffect(
    () => () => {
      for (const url of snapshotUrlsRef.current) URL.revokeObjectURL(url);
    },
    [],
  );

  useEffect(
    () =>
      window.electronAPI.chatWorkPanel.resourceImages.onChanged((event) => {
        if (
          event.handleId !== resource.handleId ||
          event.revision === sourceRevision
        )
          return;
        if (dirty) setSourceConflict(true);
        else void readResource();
      }),
    [dirty, readResource, resource.handleId, sourceRevision],
  );

  const requireAnnotationClear = useCallback(() => {
    if (annotations.length === 0) return true;
    if (!window.confirm(t("chatWorkPanel.image.confirmClearAnnotations")))
      return false;
    setAnnotations([]);
    return true;
  }, [annotations.length, t]);

  const snapshotFromCanvas = useCallback(
    async (
      canvas: HTMLCanvasElement,
      mimeType: Snapshot["mimeType"] = "image/png",
    ) => {
      const blob = await canvasBlob(canvas, mimeType);
      replaceHistory({
        url: URL.createObjectURL(blob),
        width: canvas.width,
        height: canvas.height,
        mimeType,
      });
    },
    [replaceHistory],
  );

  const transform = useCallback(
    async (operation: "rotate-left" | "rotate-right" | "flip-x" | "flip-y") => {
      if (!current || !requireAnnotationClear()) return;
      const image = await loadImage(current.url);
      const canvas = document.createElement("canvas");
      const rotated =
        operation === "rotate-left" || operation === "rotate-right";
      canvas.width = rotated ? current.height : current.width;
      canvas.height = rotated ? current.width : current.height;
      const context = canvas.getContext("2d");
      if (!context) return;
      if (operation === "rotate-right") {
        context.translate(canvas.width, 0);
        context.rotate(Math.PI / 2);
      } else if (operation === "rotate-left") {
        context.translate(0, canvas.height);
        context.rotate(-Math.PI / 2);
      } else if (operation === "flip-x") {
        context.translate(canvas.width, 0);
        context.scale(-1, 1);
      } else {
        context.translate(0, canvas.height);
        context.scale(1, -1);
      }
      context.drawImage(image, 0, 0);
      await snapshotFromCanvas(canvas, current.mimeType);
    },
    [current, requireAnnotationClear, snapshotFromCanvas],
  );

  const applyCrop = useCallback(async () => {
    if (!current || !cropRect || !requireAnnotationClear()) return;
    const image = await loadImage(current.url);
    const x = clamp(Math.round(cropRect.x), 0, current.width - 1);
    const y = clamp(Math.round(cropRect.y), 0, current.height - 1);
    const width = clamp(Math.round(cropRect.width), 1, current.width - x);
    const height = clamp(Math.round(cropRect.height), 1, current.height - y);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas
      .getContext("2d")
      ?.drawImage(image, x, y, width, height, 0, 0, width, height);
    await snapshotFromCanvas(canvas, current.mimeType);
    setTool("pan");
  }, [cropRect, current, requireAnnotationClear, snapshotFromCanvas]);

  const cancelCrop = () => {
    setCropRect(null);
    setTool("pan");
  };

  const beginCropDrag = (
    mode: CropDragMode,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (!cropRect || !current || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const initial = { ...cropRect };
    const scale = effectiveZoom / 100;
    // Keep the frame usable on screen without forcing a tiny box to grow.
    const minWidth = Math.min(
      Math.max(1, 24 / scale),
      Math.max(1, initial.width),
    );
    const minHeight = Math.min(
      Math.max(1, 24 / scale),
      Math.max(1, initial.height),
    );
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      setCropRect(
        resizeFrame(
          initial,
          mode,
          (moveEvent.clientX - startX) / scale,
          (moveEvent.clientY - startY) / scale,
          minWidth,
          minHeight,
          current.width,
          current.height,
        ),
      );
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const applyAdjustments = useCallback(async () => {
    if (!current || !requireAnnotationClear()) return;
    const image = await loadImage(current.url);
    const canvas = document.createElement("canvas");
    canvas.width = current.width;
    canvas.height = current.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.filter = `brightness(${100 + adjust.exposure}%) contrast(${100 + adjust.contrast}%) saturate(${100 + adjust.saturation}%)`;
    context.drawImage(image, 0, 0);
    await snapshotFromCanvas(canvas, current.mimeType);
    setAdjust({ exposure: 0, contrast: 0, saturation: 0 });
    setAdjustOpen(false);
  }, [adjust, current, requireAnnotationClear, snapshotFromCanvas]);

  const pointFromEvent = (
    event: ReactPointerEvent<HTMLElement>,
  ): Point | null => {
    if (!current) return null;
    const imageHost = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp(
        (event.clientX - imageHost.left) / (effectiveZoom / 100),
        0,
        current.width,
      ),
      y: clamp(
        (event.clientY - imageHost.top) / (effectiveZoom / 100),
        0,
        current.height,
      ),
    };
  };

  const selectionCommitRef = useRef<{ key: string; time: number } | null>(null);
  const selectionDragRef = useRef<{ appended: boolean } | null>(null);

  const appendSelectionEntry = useCallback(
    (
      update: (regions: SelectionRegion[]) => SelectionRegion[],
      activeId: string,
    ) => {
      setHistory((previous) => {
        const entry = previous[historyIndex] ?? previous[previous.length - 1];
        if (!entry) return previous;
        const trimmed = previous.slice(0, historyIndex + 1);
        const appended: HistoryEntry = {
          ...entry,
          selections: update(entry.selections),
          activeSelectionId: activeId,
        };
        const limited = [...trimmed, appended].slice(-HISTORY_LIMIT);
        setHistoryIndex(limited.length - 1);
        return limited;
      });
    },
    [historyIndex],
  );

  const updateLastSelectionEntry = useCallback(
    (
      update: (regions: SelectionRegion[]) => SelectionRegion[],
      activeId: string,
    ) => {
      setHistory((previous) => {
        if (!previous.length) return previous;
        const index = previous.length - 1;
        const entry = previous[index];
        return [
          ...previous.slice(0, index),
          {
            ...entry,
            selections: update(entry.selections),
            activeSelectionId: activeId,
          },
        ];
      });
    },
    [],
  );

  const commitSelection = useCallback(
    (
      update: (regions: SelectionRegion[]) => SelectionRegion[],
      activeId: string,
      coalesceKey?: string,
    ) => {
      const now = Date.now();
      const last = selectionCommitRef.current;
      const canCoalesce =
        Boolean(coalesceKey) &&
        historyIndex === history.length - 1 &&
        last !== null &&
        last.key === coalesceKey &&
        now - last.time < 600;
      selectionCommitRef.current = { key: coalesceKey ?? "", time: now };
      if (canCoalesce) {
        updateLastSelectionEntry(update, activeId);
        return;
      }
      appendSelectionEntry(update, activeId);
    },
    [
      appendSelectionEntry,
      history.length,
      historyIndex,
      updateLastSelectionEntry,
    ],
  );

  const setActiveSelection = useCallback(
    (id: string) => {
      setHistory((previous) =>
        previous.map((entry, index) =>
          index === historyIndex ? { ...entry, activeSelectionId: id } : entry,
        ),
      );
    },
    [historyIndex],
  );

  const updateActiveRegion = useCallback(
    (
      patch: Partial<
        Pick<SelectionRegion, "tool" | "style" | "color" | "lineWidth">
      >,
      coalesceKey?: string,
    ) => {
      if (!activeSelectionId) return;
      commitSelection(
        (regions) =>
          regions.map((region) =>
            region.id === activeSelectionId ? { ...region, ...patch } : region,
          ),
        activeSelectionId,
        coalesceKey,
      );
    },
    [activeSelectionId, commitSelection],
  );

  const changeSelectionShape = useCallback(
    (shape: SelectionTool) => {
      setSelectionTool(shape);
      updateActiveRegion({ tool: shape });
    },
    [updateActiveRegion],
  );

  const changeSelectionStyle = useCallback(
    (style: "line" | "fill") => {
      setSelectionStyle(style);
      updateActiveRegion({ style });
    },
    [updateActiveRegion],
  );

  const changeSelectionColor = useCallback(
    (color: string, coalesceKey?: string) => {
      setSelectionColor(color);
      updateActiveRegion({ color }, coalesceKey);
    },
    [updateActiveRegion],
  );

  const changeSelectionLineWidth = useCallback(
    (width: number) => {
      const next = clamp(width, 1, 16);
      setSelectionLineWidth(next);
      updateActiveRegion({ lineWidth: next }, "line-width");
    },
    [updateActiveRegion],
  );

  // Switching the active box loads its own shape/style/colour/width into the toolbar.
  useEffect(() => {
    const active = selections.find((region) => region.id === activeSelectionId);
    if (!active) return;
    setSelectionTool(active.tool);
    setSelectionStyle(active.style);
    setSelectionColor(active.color);
    setSelectionLineWidth(active.lineWidth);
  }, [activeSelectionId, selections]);

  const updateSelectionBounds = useCallback(
    (id: string, bounds: CropRect) => {
      const update = (regions: SelectionRegion[]) =>
        regions.map((region) =>
          region.id === id ? { ...region, bounds } : region,
        );
      if (!selectionDragRef.current?.appended) {
        selectionDragRef.current = { appended: true };
        appendSelectionEntry(update, id);
        return;
      }
      updateLastSelectionEntry(update, id);
    },
    [appendSelectionEntry, updateLastSelectionEntry],
  );

  const removeActiveSelection = useCallback(() => {
    const remaining = selections.filter(
      (region) => region.id !== activeSelectionId,
    );
    const nextActive = remaining.length
      ? remaining[remaining.length - 1].id
      : "";
    commitSelection(() => remaining, nextActive);
  }, [activeSelectionId, commitSelection, selections]);

  const paintSelectionPath = useCallback(
    (points: Point[], shape: SelectionTool) => {
      if (!current) return;
      const bounds = buildSelectionBounds(points, current);
      if (!bounds) return;
      const region: SelectionRegion = {
        id: globalThis.crypto.randomUUID(),
        tool: shape,
        bounds,
        style: selectionStyle,
        color: selectionColor,
        lineWidth: selectionLineWidth,
      };
      commitSelection((regions) => [...regions, region], region.id);
    },
    [
      commitSelection,
      current,
      selectionColor,
      selectionLineWidth,
      selectionStyle,
    ],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !active) return;
    const onWheel = (event: WheelEvent) => {
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 400 : 1);
      if (!delta || !current) return;
      event.preventDefault();
      if (
        tool === "erase" &&
        eraseTool === "brush" &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        eraseWidthWheelRef.current -= delta;
        const steps = Math.trunc(eraseWidthWheelRef.current / 40);
        if (steps !== 0) {
          eraseWidthWheelRef.current -= steps * 40;
          setEraseBrushWidth((width) => clamp(width + steps * 4, 4, 200));
        }
        return;
      }
      if (
        tool === "select" &&
        selectionStyle === "line" &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        // Line style turns the wheel into a thickness control; Cmd/Ctrl+wheel still zooms.
        lineWidthWheelRef.current -= delta;
        const steps = Math.trunc(lineWidthWheelRef.current / 40);
        if (steps !== 0) {
          lineWidthWheelRef.current -= steps * 40;
          changeSelectionLineWidth(selectionLineWidth + steps);
        }
        return;
      }
      const rect = viewport.getBoundingClientRect();
      const factor = clamp(
        Math.exp(-clamp(delta, -240, 240) * 0.001),
        0.75,
        1.35,
      );
      zoomTo(effectiveZoom * factor, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [
    active,
    changeSelectionLineWidth,
    current,
    effectiveZoom,
    eraseTool,
    selectionLineWidth,
    selectionStyle,
    tool,
    zoomTo,
  ]);

  const commitEraseRegions = (regions: EraseRegion[]) => {
    if (!current) return;
    const next = [
      ...history.slice(0, historyIndex + 1),
      { ...current, eraseRegions: regions },
    ].slice(-HISTORY_LIMIT);
    setHistory(next);
    setHistoryIndex(next.length - 1);
  };

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!current || event.button !== 0 || annotationDraft) return;
    rootRef.current?.focus({ preventScroll: true });
    if (aiBusy && tool !== "pan") return;
    if (tool === "pan") {
      panRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        viewX: view.x,
        viewY: view.y,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const point = pointFromEvent(event);
    if (!point) return;
    drawStartRef.current = point;
    if (tool === "erase") {
      setActiveEraseRegion(null);
      const region: EraseRegion =
        eraseTool === "brush"
          ? { tool: "brush", points: [point], width: eraseBrushWidth }
          : { tool: "rectangle", bounds: rectFromPoints(point, point) };
      eraseGestureRef.current = region;
      setErasePreview(region);
    } else if (tool === "annotate") {
      setGesturePreview({ kind: "annotate", points: [point, point] });
    } else if (tool === "select") {
      setGesturePreview({
        kind: "select",
        shape: selectionTool,
        points: [point],
      });
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panRef.current && tool === "pan") {
      const drag = panRef.current;
      setView(
        clampViewToViewport(
          {
            x: drag.viewX + event.clientX - drag.clientX,
            y: drag.viewY + event.clientY - drag.clientY,
          },
          effectiveZoom,
        ),
      );
      return;
    }
    if (!drawStartRef.current) return;
    const point = pointFromEvent(event);
    if (!point) return;
    if (tool === "erase" && eraseGestureRef.current) {
      const previous = eraseGestureRef.current;
      const region: EraseRegion =
        previous.tool === "brush"
          ? { ...previous, points: [...previous.points, point] }
          : {
              tool: "rectangle",
              bounds: rectFromPoints(drawStartRef.current, point),
            };
      eraseGestureRef.current = region;
      setErasePreview(region);
    } else if (tool === "crop") {
      setCropRect(rectFromPoints(drawStartRef.current, point));
    } else if (tool === "annotate") {
      setGesturePreview({
        kind: "annotate",
        points: [drawStartRef.current, point],
      });
    } else if (tool === "select") {
      setGesturePreview({
        kind: "select",
        shape: selectionTool,
        points: [drawStartRef.current, point],
      });
    }
  };

  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    panRef.current = null;
    const start = drawStartRef.current;
    if (!start) return;
    const end = pointFromEvent(event) || start;
    if (tool === "erase" && eraseGestureRef.current && current) {
      const draft = eraseGestureRef.current;
      const bounds =
        draft.tool === "rectangle"
          ? buildSelectionBounds([start, end], current)
          : null;
      const region: EraseRegion | null =
        draft.tool === "brush"
          ? { ...draft, points: [...draft.points, end] }
          : bounds
            ? { tool: "rectangle", bounds }
            : null;
      if (region) {
        commitEraseRegions([...eraseRegions, region]);
        setActiveEraseRegion(region);
      }
      eraseGestureRef.current = null;
      setErasePreview(null);
    } else if (tool === "annotate" && current) {
      let rect = rectFromPoints(start, end);
      if (rect.width < 3 || rect.height < 3) {
        const size = Math.min(
          72 / (effectiveZoom / 100),
          current.width,
          current.height,
        );
        rect = {
          x: clamp(start.x - size / 2, 0, Math.max(0, current.width - size)),
          y: clamp(start.y - size / 2, 0, Math.max(0, current.height - size)),
          width: size,
          height: size,
        };
      }
      if (rect.width > 0 && rect.height > 0 && annotations.length < 50) {
        const id = globalThis.crypto.randomUUID();
        setAnnotationDraft({
          id,
          number: annotations.length + 1,
          kind: "image-region",
          rect,
          normalizedRect: {
            x: rect.x / current.width,
            y: rect.y / current.height,
            width: rect.width / current.width,
            height: rect.height / current.height,
          },
          requirement: "",
        });
        setAnnotationsOpen(false);
      }
    } else if (tool === "select") {
      paintSelectionPath([start, end], selectionTool);
    }
    drawStartRef.current = null;
    setGesturePreview(null);
  };

  const beginEraseFrameDrag = (
    index: number,
    mode: CropDragMode,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    const region = eraseRegions[index];
    if (
      region?.tool !== "rectangle" ||
      !current ||
      aiBusy ||
      event.button !== 0
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    rootRef.current?.focus({ preventScroll: true });
    setActiveEraseRegion(region);
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const initial = region.bounds;
    const scale = effectiveZoom / 100;
    let draft = region;
    const update = (moveEvent: PointerEvent) => {
      draft = {
        tool: "rectangle",
        bounds: resizeFrame(
          initial,
          mode,
          (moveEvent.clientX - startX) / scale,
          (moveEvent.clientY - startY) / scale,
          Math.min(Math.max(1, 24 / scale), initial.width),
          Math.min(Math.max(1, 24 / scale), initial.height),
          current.width,
          current.height,
        ),
      };
      setEraseFramePreview({ index, region: draft });
    };
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId === pointerId) update(moveEvent);
    };
    const end = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      if (endEvent.type !== "pointercancel") {
        update(endEvent);
        if (
          Object.keys(initial).some(
            (key) =>
              initial[key as keyof CropRect] !==
              draft.bounds[key as keyof CropRect],
          )
        ) {
          commitEraseRegions(
            eraseRegions.map((item, itemIndex) =>
              itemIndex === index ? draft : item,
            ),
          );
          setActiveEraseRegion(draft);
        }
      }
      setEraseFramePreview(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const beginSelectionFrameDrag = (
    id: string,
    mode: CropDragMode,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    const region = selections.find((item) => item.id === id);
    if (!region || !current || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setActiveSelection(id);
    selectionDragRef.current = { appended: false };
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const initial = { ...region.bounds };
    const scale = effectiveZoom / 100;
    const minWidth = Math.min(
      Math.max(1, 24 / scale),
      Math.max(1, initial.width),
    );
    const minHeight = Math.min(
      Math.max(1, 24 / scale),
      Math.max(1, initial.height),
    );
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      updateSelectionBounds(
        id,
        resizeFrame(
          initial,
          mode,
          (moveEvent.clientX - startX) / scale,
          (moveEvent.clientY - startY) / scale,
          minWidth,
          minHeight,
          current.width,
          current.height,
        ),
      );
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const selectionMaskBase64 = async (
    annotationRegions: ImageRegionAnnotation[] = [],
    includeEraseRegions = false,
  ) => {
    if (!current || (!includeEraseRegions && annotationRegions.length === 0))
      return "";
    if (includeEraseRegions && !hasEraseRegions) return "";
    const mask = document.createElement("canvas");
    mask.width = current.width;
    mask.height = current.height;
    const context = mask.getContext("2d");
    if (!context) return "";
    context.fillStyle = "black";
    context.fillRect(0, 0, mask.width, mask.height);
    context.fillStyle = "white";
    context.strokeStyle = "white";
    if (includeEraseRegions) {
      for (const region of eraseRegions) drawEraseRegion(context, region);
    }
    for (const annotation of annotationRegions) {
      context.fillRect(
        Math.round(annotation.rect.x),
        Math.round(annotation.rect.y),
        Math.max(1, Math.round(annotation.rect.width)),
        Math.max(1, Math.round(annotation.rect.height)),
      );
    }
    return blobBase64(await canvasBlob(mask, "image/png"));
  };

  const beginFloatingPanelDrag = (
    kind: FloatingPanelKind,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (event.button !== 0) return;
    const panel =
      kind === "tools"
        ? floatingControlsRef.current
        : annotationsPanelRef.current;
    if (!panel) return;
    floatingPanelDragRef.current = {
      kind,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      left: panel.offsetLeft,
      top: panel.offsetTop,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const moveFloatingPanel = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = floatingPanelDragRef.current;
    const content = contentRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !content) return;
    const panel =
      drag.kind === "tools"
        ? floatingControlsRef.current
        : annotationsPanelRef.current;
    if (!panel) return;
    const position = {
      x: clamp(
        drag.left + event.clientX - drag.clientX,
        0,
        Math.max(0, content.clientWidth - panel.offsetWidth),
      ),
      y: clamp(
        drag.top + event.clientY - drag.clientY,
        0,
        Math.max(0, content.clientHeight - panel.offsetHeight),
      ),
    };
    if (drag.kind === "tools") setFloatingControlsPosition(position);
    else setAnnotationsPanelPosition(position);
    event.preventDefault();
    event.stopPropagation();
  };

  const endFloatingPanelDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = floatingPanelDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    floatingPanelDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.stopPropagation();
  };

  const runAi = async (operation: WorkPanelResourceImageAiOperation) => {
    if (!current || aiBusy) return;
    const consumesAnnotations = operation === "inpaint";
    const requiresMask = consumesAnnotations || operation === "removeObject";
    if (
      !consumesAnnotations &&
      annotations.length > 0 &&
      !window.confirm(t("chatWorkPanel.image.confirmClearAnnotations"))
    ) {
      return;
    }
    if (
      operation === "inpaint" &&
      (annotations.length === 0 ||
        annotations.some((annotation) => !annotation.requirement.trim()))
    ) {
      setTool("annotate");
      setError(t("chatWorkPanel.image.annotationRequired"));
      return;
    }
    const annotationRegions = operation === "inpaint" ? annotations : [];
    let prompt = "";
    let targetWidth = current.width;
    let targetHeight = current.height;
    if (operation === "inpaint") {
      const annotationInstructions = annotationRegions
        .filter((annotation) => annotation.requirement.trim())
        .map((annotation) => {
          const rect = annotation.normalizedRect;
          return t("chatWorkPanel.image.aiAnnotationInstruction", {
            number: annotation.number,
            requirement: annotation.requirement.trim(),
            x: Math.round(rect.x * 100),
            y: Math.round(rect.y * 100),
            width: Math.round(rect.width * 100),
            height: Math.round(rect.height * 100),
          });
        });
      prompt = annotationInstructions.join("\n");
    } else if (operation === "replaceBackground" || operation === "outpaint") {
      prompt = aiInstruction.trim();
      if (!prompt) {
        setError(t("chatWorkPanel.image.aiInstructionRequired"));
        return;
      }
    }
    if (operation === "outpaint") {
      targetWidth = Math.round(aiTargetSize.width);
      targetHeight = Math.round(aiTargetSize.height);
      if (
        !Number.isFinite(targetWidth) ||
        !Number.isFinite(targetHeight) ||
        targetWidth < current.width ||
        targetHeight < current.height ||
        targetWidth > 8_192 ||
        targetHeight > 8_192 ||
        targetWidth * targetHeight > 40_000_000
      )
        return;
    }
    const requestId = globalThis.crypto.randomUUID();
    setTool("pan");
    setAiPromptOperation(null);
    setAiBusy({ requestId, operation });
    setError("");
    setAiSuccess("");
    try {
      const maskDataBase64 = requiresMask
        ? await selectionMaskBase64(
            annotationRegions,
            operation === "removeObject",
          )
        : "";
      if (!maskDataBase64 && requiresMask) {
        setError(
          t(
            operation === "removeObject"
              ? "chatWorkPanel.image.selectionRequired"
              : "chatWorkPanel.image.annotationRequired",
          ),
        );
        if (operation === "removeObject") {
          setTool("erase");
        } else {
          setTool("annotate");
        }
        return;
      }
      const sourceImage = await loadImage(current.url);
      const sourceCanvas = document.createElement("canvas");
      sourceCanvas.width = current.width;
      sourceCanvas.height = current.height;
      const sourceContext = sourceCanvas.getContext("2d");
      if (!sourceContext) throw new Error("image_canvas_unavailable");
      sourceContext.drawImage(sourceImage, 0, 0, current.width, current.height);
      const sourceBlob = await canvasBlob(sourceCanvas, current.mimeType);
      const sourceDataBase64 = await blobBase64(sourceBlob);
      const result = await window.electronAPI.chatWorkPanel.resourceImages.ai({
        ...handleRequest,
        requestId,
        expectedRevision: sourceRevision,
        operation,
        sourceMimeType: current.mimeType,
        sourceDataBase64,
        ...(maskDataBase64 ? { maskDataBase64 } : {}),
        ...(prompt ? { prompt } : {}),
        width: targetWidth,
        height: targetHeight,
        preserveComposition: true,
        edgeMode: "soft",
      });
      if (!result.ok || !result.image) {
        setError(
          t("chatWorkPanel.image.aiFailedOperation", {
            operation: aiOperationLabel(operation),
            reason: result.message || t("chatWorkPanel.image.aiFailed"),
          }),
        );
        if (operation === "removeObject") {
          setTool("erase");
        } else if (
          operation === "replaceBackground" ||
          operation === "outpaint"
        ) {
          setAiPromptOperation(operation);
        }
        return;
      }
      const bytes = Uint8Array.from(atob(result.image.dataBase64), (char) =>
        char.charCodeAt(0),
      );
      const url = URL.createObjectURL(
        new Blob([bytes], { type: result.image.mimeType }),
      );
      const image = await loadImage(url);
      if (
        operation === "removeBackground" ||
        image.naturalWidth !== targetWidth ||
        image.naturalHeight !== targetHeight
      ) {
        const canvas = document.createElement("canvas");
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const copyWidth = Math.min(targetWidth, image.naturalWidth);
        const copyHeight = Math.min(targetHeight, image.naturalHeight);
        canvas
          .getContext("2d")
          ?.drawImage(
            image,
            0,
            0,
            copyWidth,
            copyHeight,
            0,
            0,
            copyWidth,
            copyHeight,
          );
        URL.revokeObjectURL(url);
        await snapshotFromCanvas(
          canvas,
          operation === "removeBackground"
            ? "image/png"
            : editableImageMime(result.image.mimeType),
        );
      } else {
        replaceHistory({
          url,
          width: targetWidth,
          height: targetHeight,
          mimeType: editableImageMime(result.image.mimeType),
        });
      }
      setAnnotations([]);
      setActiveAnnotationId("");
      setAiInstruction("");
      setAiSuccess(
        t("chatWorkPanel.image.aiSucceeded", {
          operation: aiOperationLabel(operation),
        }),
      );
    } catch (reason) {
      const detail =
        reason instanceof Error ? reason.message.trim() : String(reason).trim();
      setError(
        t("chatWorkPanel.image.aiFailedOperation", {
          operation: aiOperationLabel(operation),
          reason: detail || t("chatWorkPanel.image.aiFailed"),
        }),
      );
      if (operation === "removeObject") {
        setTool("erase");
      } else if (operation === "inpaint") {
        setTool("annotate");
      } else if (
        operation === "replaceBackground" ||
        operation === "outpaint"
      ) {
        setAiPromptOperation(operation);
      }
    } finally {
      setAiBusy(null);
    }
  };

  const cancelAi = async () => {
    if (!aiBusy) return;
    await window.electronAPI.chatWorkPanel.resourceImages.cancelAi({
      ...handleRequest,
      requestId: aiBusy.requestId,
    });
  };

  const renderedBlob = useCallback(
    async (includeAnnotations = false) => {
      if (!current) return null;
      const image = await loadImage(current.url);
      const canvas = document.createElement("canvas");
      canvas.width = current.width;
      canvas.height = current.height;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(image, 0, 0);
      if (includeAnnotations) {
        const lineWidth = Math.max(
          2,
          Math.round(Math.min(current.width, current.height) / 320),
        );
        context.strokeStyle = "#ff3b30";
        context.fillStyle = "#ff3b30";
        context.lineWidth = lineWidth;
        context.font = `600 ${Math.max(14, lineWidth * 6)}px sans-serif`;
        for (const annotation of annotations) {
          context.strokeRect(
            annotation.rect.x,
            annotation.rect.y,
            annotation.rect.width,
            annotation.rect.height,
          );
          const label = String(annotation.number);
          const labelWidth = context.measureText(label).width + lineWidth * 4;
          const labelHeight = Math.max(18, lineWidth * 8);
          context.fillRect(
            annotation.rect.x,
            Math.max(0, annotation.rect.y - labelHeight),
            labelWidth,
            labelHeight,
          );
          context.fillStyle = "white";
          context.fillText(
            label,
            annotation.rect.x + lineWidth * 2,
            Math.max(
              labelHeight - lineWidth * 2,
              annotation.rect.y - lineWidth * 2,
            ),
          );
          context.fillStyle = "#ff3b30";
        }
      }
      return canvasBlob(
        canvas,
        includeAnnotations ? "image/png" : current.mimeType,
      );
    },
    [annotations, current],
  );

  const save = async (mode: "overwrite" | "new-artifact") => {
    if (!current || saveBusy) return;
    setSaveBusy(true);
    setError("");
    try {
      const blob = await renderedBlob(false);
      if (!blob) return;
      const canvas = document.createElement("canvas");
      canvas.width = current.width;
      canvas.height = current.height;
      const image = await loadImage(current.url);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context?.drawImage(image, 0, 0);
      const alpha = context?.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      let hasTransparency = false;
      if (alpha) {
        for (let index = 3; index < alpha.length; index += 4) {
          if (alpha[index] < 255) {
            hasTransparency = true;
            break;
          }
        }
      }
      if (
        mode === "overwrite" &&
        resource.mimeType === "image/jpeg" &&
        hasTransparency
      ) {
        setError(t("chatWorkPanel.image.transparentJpeg"));
        return;
      }
      const mimeType =
        mode === "overwrite"
          ? editableImageMime(resource.mimeType)
          : hasTransparency && current.mimeType === "image/jpeg"
            ? "image/png"
            : current.mimeType;
      const output =
        mimeType === current.mimeType
          ? blob
          : await canvasBlob(canvas, mimeType);
      const result =
        await window.electronAPI.chatWorkPanel.resourceImages.commit({
          ...handleRequest,
          mode,
          expectedRevision: sourceRevision,
          mimeType,
          dataBase64: await blobBase64(output),
          hasTransparency,
        });
      if (!result.ok || !result.resource) {
        if (result.conflict) setSourceConflict(true);
        setError(result.message || t("chatWorkPanel.image.saveFailed"));
        return;
      }
      onCommitted(result.resource);
      setSaveOpen(false);
      if (!result.created) {
        if (current) {
          originalSnapshotRef.current = {
            url: current.url,
            width: current.width,
            height: current.height,
            mimeType: current.mimeType,
          };
        }
        setHistory((previous) => [previous[historyIndex]]);
        setHistoryIndex(0);
        setAnnotations([]);
        setSourceConflict(false);
      }
    } finally {
      setSaveBusy(false);
    }
  };

  const downloadImage = async () => {
    if (!current) return;
    try {
      const result =
        await window.electronAPI.chatWorkPanel.resourceImages.saveCopy(
          handleRequest,
        );
      if (!result.ok && result.message) setError(result.message);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : t("chatWorkPanel.resourceActions.failed"),
      );
    }
  };

  const handoff = async () => {
    if (!current || annotations.length === 0 || handoffBusy) return;
    setHandoffBusy(true);
    try {
      const blob = await renderedBlob(true);
      if (!blob) return;
      const ok = await onHandoff({
        annotations,
        dataBase64: await blobBase64(blob),
        sizeBytes: blob.size,
        width: current.width,
        height: current.height,
      });
      if (ok) setAnnotations([]);
      else setError(t("chatWorkPanel.review.handoffFailed"));
    } finally {
      setHandoffBusy(false);
    }
  };

  const changeZoom = useCallback(
    (next: number) => {
      zoomTo(next);
    },
    [zoomTo],
  );

  const fitToViewport = useCallback(() => {
    const viewport = viewportRef.current;
    setFitMode(true);
    if (!viewport || !current) return;
    const nextFitZoom = fitZoomFor(viewport, current);
    setFitZoom(nextFitZoom);
    setView(centeredView(viewport, current, nextFitZoom));
  }, [current]);

  const stepZoom = (direction: -1 | 1) => {
    const currentZoom = effectiveZoom;
    const ordered =
      direction > 0 ? IMAGE_ZOOM_STEPS : [...IMAGE_ZOOM_STEPS].reverse();
    const next = ordered.find((step) =>
      direction > 0 ? step > currentZoom + 0.5 : step < currentZoom - 0.5,
    );
    changeZoom(next ?? (direction > 0 ? 800 : 10));
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!root.contains(document.activeElement)) return;
      if (
        document.activeElement?.matches(
          "input, textarea, select, [contenteditable=true]",
        )
      )
        return;
      if (
        editing &&
        !aiBusy &&
        tool === "select" &&
        hasSelection &&
        (event.key === "Delete" || event.key === "Backspace")
      ) {
        event.preventDefault();
        removeActiveSelection();
        return;
      }
      if (annotationMode) return;
      const command = event.metaKey || event.ctrlKey;
      if (!command) return;
      if (event.key === "0") {
        event.preventDefault();
        fitToViewport();
      } else if (event.key === "1") {
        event.preventDefault();
        changeZoom(100);
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        stepZoom(1);
      } else if (event.key === "-") {
        event.preventDefault();
        stepZoom(-1);
      } else if (
        editing &&
        event.key.toLowerCase() === "z" &&
        !event.shiftKey
      ) {
        event.preventDefault();
        setHistoryIndex((index) => Math.max(0, index - 1));
      } else if (
        editing &&
        (event.key.toLowerCase() === "y" ||
          (event.key.toLowerCase() === "z" && event.shiftKey))
      ) {
        event.preventDefault();
        setHistoryIndex((index) => Math.min(history.length - 1, index + 1));
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [
    active,
    annotationMode,
    aiBusy,
    tool,
    changeZoom,
    editing,
    effectiveZoom,
    fitToViewport,
    hasSelection,
    history.length,
    removeActiveSelection,
  ]);

  const imageFilter = adjustOpen
    ? `brightness(${100 + adjust.exposure}%) contrast(${100 + adjust.contrast}%) saturate(${100 + adjust.saturation}%)`
    : undefined;

  // The Fabric canvas renders the bitmap, so the adjustment preview is a CSS filter on it.
  useEffect(() => {
    const canvas = fabricCanvasRef.current;
    if (!canvas) return;
    canvas.lowerCanvasEl.style.filter = imageFilter || "";
  }, [imageFilter]);
  const aiPromptLabel =
    aiPromptOperation === "replaceBackground"
      ? t("chatWorkPanel.image.replaceBackground")
      : aiPromptOperation === "outpaint"
        ? t("chatWorkPanel.image.outpaint")
        : "";

  return (
    <div
      ref={rootRef}
      className={`work-panel-resource-image${editing ? " is-editing" : ""}`}
      data-native-image-dirty={dirty ? "true" : "false"}
      data-native-image-saving={saveBusy ? "true" : "false"}
      data-native-image-ai-busy={aiBusy ? "true" : "false"}
      tabIndex={0}
    >
      {editing ? (
        <div
          className="work-panel-image-toolbar is-editing"
          role="toolbar"
          aria-label={t("chatWorkPanel.image.toolbar")}
        >
          <div className="work-panel-image-toolbar-actions">
            <ImageToolbarButton
              label={t("chatWorkPanel.image.done")}
              className="is-return-to-preview"
              disabled={imageToolsDisabled || saveBusy}
              onClick={() => {
                setError("");
                onEditingChange(false);
              }}
            >
              <ArrowLeftOutlined />
            </ImageToolbarButton>
            <ImageToolbarButton
              label={t("chatWorkPanel.image.undo")}
              disabled={historyIndex <= 0 || imageToolsDisabled}
              onClick={() => setHistoryIndex((index) => Math.max(0, index - 1))}
            >
              <UndoOutlined />
            </ImageToolbarButton>
            <ImageToolbarButton
              label={t("chatWorkPanel.image.redo")}
              disabled={
                historyIndex >= history.length - 1 || imageToolsDisabled
              }
              onClick={() =>
                setHistoryIndex((index) =>
                  Math.min(history.length - 1, index + 1),
                )
              }
            >
              <RedoOutlined />
            </ImageToolbarButton>
          </div>
          <div className="work-panel-image-spacer" />
          <div className="work-panel-image-toolbar-actions">
            {annotationMode ? (
              <ImageToolbarButton
                label={t("chatWorkPanel.image.annotationCount", {
                  count: annotations.length,
                })}
                className={annotationsOpen ? "is-active" : ""}
                aria-expanded={annotationsOpen}
                disabled={Boolean(annotationDraft)}
                onClick={() => setAnnotationsOpen((value) => !value)}
              />
            ) : null}
            <ImageToolbarButton
              label={t("chatWorkPanel.image.save")}
              className={
                pixelDirty && !saveBusy && !aiBusy && !sourceConflict
                  ? "is-primary"
                  : ""
              }
              disabled={
                !pixelDirty || saveBusy || imageToolsDisabled || sourceConflict
              }
              onClick={() => setSaveOpen(true)}
            >
              <SaveOutlined />
            </ImageToolbarButton>
          </div>
        </div>
      ) : null}

      <div className="work-panel-image-body">
        {editing ? (
          <aside
            className="work-panel-image-editor-sidebar"
            role="toolbar"
            aria-orientation="vertical"
            aria-label={t("chatWorkPanel.image.photoTools")}
          >
            <div className="work-panel-image-editor-tool-group">
              <ImageToolButton
                label={t("chatWorkPanel.image.pan")}
                className={tool === "pan" ? "is-active" : ""}
                disabled={imageToolsDisabled}
                onClick={() => {
                  setAdjustOpen(false);
                  setTool("pan");
                }}
              >
                <DragOutlined />
              </ImageToolButton>
              <ImageToolButton
                label={t("chatWorkPanel.image.selection")}
                className={tool === "select" ? "is-active" : ""}
                disabled={imageToolsDisabled}
                onClick={() => {
                  setAdjustOpen(false);
                  setError("");
                  eraseGestureRef.current = null;
                  setErasePreview(null);
                  setTool("select");
                }}
              >
                <BorderOutlined />
              </ImageToolButton>
              <ImageToolButton
                label={t("chatWorkPanel.image.crop")}
                className={tool === "crop" ? "is-active" : ""}
                disabled={imageToolsDisabled}
                onClick={() => {
                  setAdjustOpen(false);
                  setTool("crop");
                }}
              >
                <ScissorOutlined />
              </ImageToolButton>
              <ImageToolButton
                label={t("chatWorkPanel.image.adjust")}
                className={adjustOpen ? "is-active" : ""}
                disabled={imageToolsDisabled}
                onClick={() => {
                  setAiPromptOperation(null);
                  setTool("pan");
                  setAdjustOpen((value) => !value);
                }}
              >
                <ControlOutlined />
              </ImageToolButton>
            </div>
            <div className="work-panel-image-editor-tool-group is-secondary">
              <ImageToolButton
                label={t("chatWorkPanel.image.annotate")}
                className={annotationMode ? "is-active" : ""}
                aria-pressed={annotationMode}
                disabled={Boolean(aiBusy)}
                onClick={() => {
                  setAdjustOpen(false);
                  setAiPromptOperation(null);
                  if (
                    annotationMode &&
                    (annotations.length > 0 || annotationDraft) &&
                    !window.confirm(
                      t("chatWorkPanel.image.confirmExitAnnotations"),
                    )
                  )
                    return;
                  setError("");
                  setAnnotationDraft(null);
                  if (annotationMode) {
                    setAnnotations([]);
                    setActiveAnnotationId("");
                    setAnnotationsOpen(false);
                  }
                  setTool(annotationMode ? "pan" : "annotate");
                }}
              >
                <WorkPanelImageToolIcon name="annotate" />
              </ImageToolButton>
              <ImageToolButton
                label={t("chatWorkPanel.image.removeObject")}
                className={tool === "erase" ? "is-active" : ""}
                disabled={imageToolsDisabled}
                onClick={() => {
                  setAdjustOpen(false);
                  setAiPromptOperation(null);
                  setError("");
                  setTool(tool === "erase" ? "pan" : "erase");
                }}
              >
                <WorkPanelImageToolIcon name="removeObject" />
              </ImageToolButton>
              <ImageToolButton
                label={t("chatWorkPanel.image.removeBackground")}
                disabled={imageToolsDisabled}
                onClick={() => {
                  void runAi("removeBackground");
                }}
              >
                <WorkPanelImageToolIcon name="removeBackground" />
              </ImageToolButton>
              <ImageToolButton
                label={t("chatWorkPanel.image.replaceBackground")}
                className={
                  aiPromptOperation === "replaceBackground" ? "is-active" : ""
                }
                aria-pressed={aiPromptOperation === "replaceBackground"}
                disabled={imageToolsDisabled}
                onClick={() => {
                  setAdjustOpen(false);
                  setTool("pan");
                  setError("");
                  setAiPromptOperation((value) =>
                    value === "replaceBackground" ? null : "replaceBackground",
                  );
                }}
              >
                <WorkPanelImageToolIcon name="replaceBackground" />
              </ImageToolButton>
              <ImageToolButton
                label={t("chatWorkPanel.image.outpaint")}
                className={aiPromptOperation === "outpaint" ? "is-active" : ""}
                aria-pressed={aiPromptOperation === "outpaint"}
                disabled={imageToolsDisabled}
                onClick={() => {
                  setAdjustOpen(false);
                  setTool("pan");
                  setError("");
                  if (current)
                    setAiTargetSize({
                      width: current.width,
                      height: current.height,
                    });
                  setAiPromptOperation((value) =>
                    value === "outpaint" ? null : "outpaint",
                  );
                }}
              >
                <WorkPanelImageToolIcon name="outpaint" />
              </ImageToolButton>
              <ImageToolButton
                label={t("chatWorkPanel.image.enhance")}
                disabled={imageToolsDisabled}
                onClick={() => {
                  void runAi("enhance");
                }}
              >
                <WorkPanelImageToolIcon name="enhance" />
              </ImageToolButton>
            </div>
          </aside>
        ) : null}
        <div ref={contentRef} className="work-panel-image-content">
          <div className="work-panel-image-zoom-float">
            {!editing ? (
              <Popover
                trigger={["hover", "focus"]}
                title={t("chatWorkPanel.image.info")}
                content={
                  <div className="work-panel-image-info-content">
                    <strong>{resource.fileName}</strong>
                    <span>
                      {imageFormat(resource.mimeType)} ·{" "}
                      {formatBytes(resource.sizeBytes)}
                    </span>
                    <span>
                      {current ? `${current.width} × ${current.height}` : "—"}
                    </span>
                  </div>
                }
              >
                <button
                  type="button"
                  className="work-panel-image-info-button"
                  aria-label={t("chatWorkPanel.image.info")}
                >
                  <InfoCircleOutlined />
                </button>
              </Popover>
            ) : null}
            <ImageZoomControl
              value={effectiveZoom}
              disabled={!current || annotationMode}
              onChange={changeZoom}
              onStep={stepZoom}
              onFit={fitToViewport}
            />
            {editing ? (
              <div
                className="work-panel-image-zoom-group"
                role="group"
                aria-label={t("chatWorkPanel.image.transform")}
              >
                <Tooltip title={t("chatWorkPanel.image.rotateLeft")}>
                  <button
                    type="button"
                    disabled={!current || imageToolsDisabled}
                    onClick={() => void transform("rotate-left")}
                    aria-label={t("chatWorkPanel.image.rotateLeft")}
                  >
                    <RotateLeftOutlined />
                  </button>
                </Tooltip>
                <Tooltip title={t("chatWorkPanel.image.rotateRight")}>
                  <button
                    type="button"
                    disabled={!current || imageToolsDisabled}
                    onClick={() => void transform("rotate-right")}
                    aria-label={t("chatWorkPanel.image.rotateRight")}
                  >
                    <RotateRightOutlined />
                  </button>
                </Tooltip>
                <Tooltip title={t("chatWorkPanel.image.flipHorizontal")}>
                  <button
                    type="button"
                    disabled={!current || imageToolsDisabled}
                    onClick={() => void transform("flip-x")}
                    aria-label={t("chatWorkPanel.image.flipHorizontal")}
                  >
                    <span aria-hidden="true">↔</span>
                  </button>
                </Tooltip>
                <Tooltip title={t("chatWorkPanel.image.flipVertical")}>
                  <button
                    type="button"
                    disabled={!current || imageToolsDisabled}
                    onClick={() => void transform("flip-y")}
                    aria-label={t("chatWorkPanel.image.flipVertical")}
                  >
                    <span aria-hidden="true">↕</span>
                  </button>
                </Tooltip>
              </div>
            ) : null}
            {!editing ? (
              <>
                <Tooltip title={t("chatWorkPanel.image.download")}>
                  <button
                    type="button"
                    className="work-panel-image-download-button"
                    disabled={!current || saveBusy}
                    onClick={() => void downloadImage()}
                    aria-label={t("chatWorkPanel.image.download")}
                  >
                    <DownloadOutlined />
                  </button>
                </Tooltip>
                <button
                  type="button"
                  className="work-panel-image-edit-button"
                  disabled={editDisabled || !current}
                  onClick={() => onEditingChange(true)}
                >
                  <EditOutlined /> {t("chatWorkPanel.image.edit")}
                </button>
              </>
            ) : null}
          </div>

          {editing && (adjustOpen || aiPromptOperation || tool === "erase") ? (
            <div
              ref={floatingControlsRef}
              className={`work-panel-image-floating-controls${tool === "erase" ? " is-erase" : ""}`}
              style={
                floatingControlsPosition
                  ? {
                      left: floatingControlsPosition.x,
                      top: floatingControlsPosition.y,
                    }
                  : undefined
              }
            >
              <div
                className="work-panel-image-floating-drag-handle"
                onPointerDown={(event) =>
                  beginFloatingPanelDrag("tools", event)
                }
                onPointerMove={moveFloatingPanel}
                onPointerUp={endFloatingPanelDrag}
                onPointerCancel={endFloatingPanelDrag}
              >
                <DragOutlined />
                <span>{t("chatWorkPanel.image.toolSettings")}</span>
              </div>
              {tool === "erase" ? (
                <div
                  className="work-panel-image-subtoolbar is-ai-selection work-panel-image-erase-toolbar"
                  role="toolbar"
                  aria-label={t("chatWorkPanel.image.removeObject")}
                >
                  <span className="work-panel-image-subtoolbar-hint">
                    {t("chatWorkPanel.image.eraseRegionHint")}
                  </span>
                  <div
                    role="group"
                    aria-label={t("chatWorkPanel.image.eraseRegionTools")}
                  >
                    <button
                      type="button"
                      className={eraseTool === "brush" ? "is-active" : ""}
                      aria-pressed={eraseTool === "brush"}
                      title={`${t("chatWorkPanel.image.eraseBrushWidth")}: ${eraseBrushWidth}px`}
                      onClick={() => setEraseTool("brush")}
                      style={{
                        display: "flex",
                        alignItems: "center",
                      }}
                    >
                      <svg
                        className="work-panel-image-erase-brush-icon"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <circle
                          cx={12}
                          cy={12}
                          r={Math.max(1, eraseBrushWidth / 20)}
                        />
                      </svg>
                      {t("chatWorkPanel.image.eraseBrush")}
                    </button>
                    <button
                      type="button"
                      className={eraseTool === "rectangle" ? "is-active" : ""}
                      aria-pressed={eraseTool === "rectangle"}
                      onClick={() => setEraseTool("rectangle")}
                    >
                      <BorderOutlined />{" "}
                      {t("chatWorkPanel.image.selectionRectangle")}
                    </button>
                  </div>
                  <div className="work-panel-image-erase-actions">
                    <button
                      type="button"
                      className="is-ai-action"
                      disabled={!hasEraseRegions || Boolean(aiBusy)}
                      onClick={() => void runAi("removeObject")}
                    >
                      <EditOutlined />{" "}
                      {t("chatWorkPanel.image.removeSelectedObject")}
                    </button>
                    <button
                      type="button"
                      disabled={!hasEraseRegions}
                      onClick={() => commitEraseRegions([])}
                    >
                      <DeleteOutlined /> {t("chatWorkPanel.image.eraseClear")}
                    </button>
                    <button type="button" onClick={() => setTool("pan")}>
                      {t("chatWorkPanel.image.cancel")}
                    </button>
                  </div>
                </div>
              ) : null}
              {adjustOpen ? (
                <div className="work-panel-image-adjustments">
                  {(["exposure", "contrast", "saturation"] as const).map(
                    (key) => (
                      <label key={key}>
                        <span>{t(`chatWorkPanel.image.${key}`)}</span>
                        <input
                          type="range"
                          min={-100}
                          max={100}
                          value={adjust[key]}
                          onChange={(event) =>
                            setAdjust((value) => ({
                              ...value,
                              [key]: Number(event.target.value),
                            }))
                          }
                        />
                        <output>{adjust[key]}</output>
                        <button
                          type="button"
                          onClick={() =>
                            setAdjust((value) => ({ ...value, [key]: 0 }))
                          }
                        >
                          {t("chatWorkPanel.image.reset")}
                        </button>
                      </label>
                    ),
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      setAdjust({ exposure: 0, contrast: 0, saturation: 0 })
                    }
                  >
                    {t("chatWorkPanel.image.resetAll")}
                  </button>
                  <button
                    type="button"
                    className="is-primary"
                    onClick={() => void applyAdjustments()}
                  >
                    {t("chatWorkPanel.image.apply")}
                  </button>
                </div>
              ) : null}

              {aiPromptOperation ? (
                <section
                  className="work-panel-image-ai-prompt"
                  aria-label={aiPromptLabel}
                >
                  <header>
                    <span>
                      <ThunderboltOutlined /> <strong>{aiPromptLabel}</strong>
                    </span>
                    <button
                      type="button"
                      aria-label={t("common.close")}
                      onClick={() => setAiPromptOperation(null)}
                    >
                      ×
                    </button>
                  </header>
                  <label className="work-panel-image-ai-instruction">
                    <span>{t("chatWorkPanel.image.aiInstruction")}</span>
                    <textarea
                      value={aiInstruction}
                      maxLength={4_000}
                      placeholder={t(
                        "chatWorkPanel.image.aiInstructionPlaceholder",
                      )}
                      onChange={(event) => setAiInstruction(event.target.value)}
                    />
                  </label>
                  {aiPromptOperation === "outpaint" ? (
                    <div className="work-panel-image-parameter-fields">
                      <label>
                        <span>{t("chatWorkPanel.image.width")}</span>
                        <input
                          type="number"
                          min={current?.width || 1}
                          max={8192}
                          value={aiTargetSize.width}
                          onChange={(event) =>
                            setAiTargetSize((value) => ({
                              ...value,
                              width: Number(event.target.value),
                            }))
                          }
                        />
                      </label>
                      <label>
                        <span>{t("chatWorkPanel.image.height")}</span>
                        <input
                          type="number"
                          min={current?.height || 1}
                          max={8192}
                          value={aiTargetSize.height}
                          onChange={(event) =>
                            setAiTargetSize((value) => ({
                              ...value,
                              height: Number(event.target.value),
                            }))
                          }
                        />
                      </label>
                    </div>
                  ) : null}
                  <div className="work-panel-image-parameter-actions">
                    <button
                      type="button"
                      onClick={() => setAiPromptOperation(null)}
                    >
                      {t("common.cancel")}
                    </button>
                    <button
                      type="button"
                      className="is-primary"
                      onClick={() => void runAi(aiPromptOperation)}
                    >
                      {aiPromptLabel}
                    </button>
                  </div>
                </section>
              ) : null}
            </div>
          ) : null}

          {sourceConflict ? (
            <div className="work-panel-image-conflict" role="alert">
              <span>{t("chatWorkPanel.image.sourceConflict")}</span>
              <button type="button" onClick={() => void readResource()}>
                {t("chatWorkPanel.image.discardReload")}
              </button>
              {pixelDirty ? (
                <button type="button" onClick={() => setSaveOpen(true)}>
                  {t("chatWorkPanel.image.keepSaveNew")}
                </button>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <div className="work-panel-image-error" role="alert">
              {error}
            </div>
          ) : null}
          {aiSuccess ? (
            <div className="work-panel-image-ai-success" role="status">
              {aiSuccess}
            </div>
          ) : null}
          {aiBusy ? (
            <div className="work-panel-image-ai-status">
              <span>
                {t("chatWorkPanel.image.aiRunningOperation", {
                  operation: aiOperationLabel(aiBusy.operation),
                })}
              </span>
              <button type="button" onClick={() => void cancelAi()}>
                {t("chatWorkPanel.image.cancel")}
              </button>
            </div>
          ) : null}

          <div ref={viewportRef} className="work-panel-image-viewport">
            {annotationDraft ? (
              <form
                className="work-panel-image-annotation-draft"
                style={{
                  left: clamp(
                    view.x + (annotationDraft.rect.x * effectiveZoom) / 100,
                    8,
                    Math.max(
                      8,
                      (viewportRef.current?.clientWidth || 320) - 308,
                    ),
                  ),
                  top:
                    view.y + (annotationDraft.rect.y * effectiveZoom) / 100 <
                    152
                      ? view.y +
                        (annotationDraft.rect.y * effectiveZoom) / 100 +
                        8
                      : view.y +
                        (annotationDraft.rect.y * effectiveZoom) / 100 -
                        32,
                  transform:
                    view.y + (annotationDraft.rect.y * effectiveZoom) / 100 <
                    152
                      ? "none"
                      : undefined,
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!annotationDraft.requirement.trim()) return;
                  const annotation = {
                    ...annotationDraft,
                    requirement: annotationDraft.requirement.trim(),
                    number: annotations.length + 1,
                  };
                  setAnnotations((items) => [...items, annotation]);
                  setActiveAnnotationId(annotation.id);
                  setAnnotationDraft(null);
                  setAnnotationsOpen(true);
                }}
              >
                <textarea
                  autoFocus
                  rows={1}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  maxLength={1_000}
                  aria-label={t("chatWorkPanel.image.annotationRequirement", {
                    number: annotationDraft.number,
                  })}
                  placeholder={t("chatWorkPanel.image.annotationPlaceholder")}
                  value={annotationDraft.requirement}
                  onChange={(event) =>
                    setAnnotationDraft({
                      ...annotationDraft,
                      requirement: event.target.value,
                    })
                  }
                />
                <div className="work-panel-image-annotation-draft-actions">
                  <Tooltip title={t("chatWorkPanel.image.apply")}>
                    <button
                      type="submit"
                      className="is-primary"
                      aria-label={t("chatWorkPanel.image.apply")}
                      disabled={!annotationDraft.requirement.trim()}
                    >
                      <CheckOutlined />
                    </button>
                  </Tooltip>
                  <Tooltip title={t("chatWorkPanel.image.remove")}>
                    <button
                      type="button"
                      aria-label={t("chatWorkPanel.image.remove")}
                      onClick={() => setAnnotationDraft(null)}
                    >
                      <DeleteOutlined />
                    </button>
                  </Tooltip>
                </div>
              </form>
            ) : null}
            <div
              ref={fabricHostRef}
              className="work-panel-image-fabric-host"
              role="img"
              aria-label={resource.fileName}
            />
            {loading ? (
              <div className="work-panel-image-empty">
                {t("common.loading")}
              </div>
            ) : null}
            {current ? (
              <div
                ref={imageCanvasRef}
                className={`work-panel-image-canvas${tool === "pan" ? " is-pannable" : " is-drawing"}`}
                style={{
                  left: view.x,
                  top: view.y,
                  width: (current.width * effectiveZoom) / 100,
                  height: (current.height * effectiveZoom) / 100,
                }}
                onPointerDown={pointerDown}
                onPointerMove={pointerMove}
                onPointerUp={pointerUp}
                onPointerCancel={() => {
                  panRef.current = null;
                  drawStartRef.current = null;
                  eraseGestureRef.current = null;
                  setErasePreview(null);
                  setGesturePreview(null);
                }}
              >
                <canvas
                  ref={selectionCanvasRef}
                  className="work-panel-image-selection-layer"
                  style={
                    tool === "erase" ? { visibility: "hidden" } : undefined
                  }
                />
                <canvas
                  ref={eraseCanvasRef}
                  className="work-panel-image-selection-layer work-panel-image-erase-layer"
                  style={{
                    visibility: tool === "erase" ? "visible" : "hidden",
                  }}
                />
                {gesturePreview?.kind === "select" &&
                gesturePreview.points.length > 0 ? (
                  <svg
                    className="work-panel-image-selection-preview"
                    viewBox={`0 0 ${current.width} ${current.height}`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                    style={
                      {
                        "--selection-fill":
                          selectionStyle === "fill"
                            ? colorWithAlpha(selectionColor, 0.34)
                            : "none",
                        "--selection-stroke": selectionColor,
                        "--selection-width": `${selectionLineWidth}px`,
                      } as CSSProperties
                    }
                  >
                    {gesturePreview.shape === "rectangle" &&
                    gesturePreview.points[1]
                      ? (() => {
                          const rect = rectFromPoints(
                            gesturePreview.points[0],
                            gesturePreview.points[1],
                          );
                          return (
                            <rect
                              x={rect.x}
                              y={rect.y}
                              width={rect.width}
                              height={rect.height}
                            />
                          );
                        })()
                      : null}
                    {gesturePreview.shape === "ellipse" &&
                    gesturePreview.points[1]
                      ? (() => {
                          const rect = rectFromPoints(
                            gesturePreview.points[0],
                            gesturePreview.points[1],
                          );
                          return (
                            <ellipse
                              cx={rect.x + rect.width / 2}
                              cy={rect.y + rect.height / 2}
                              rx={rect.width / 2}
                              ry={rect.height / 2}
                            />
                          );
                        })()
                      : null}
                  </svg>
                ) : null}
                {tool === "crop" && cropRect ? (
                  <div
                    className="work-panel-image-crop-rect"
                    style={{
                      left: (cropRect.x * effectiveZoom) / 100,
                      top: (cropRect.y * effectiveZoom) / 100,
                      width: (cropRect.width * effectiveZoom) / 100,
                      height: (cropRect.height * effectiveZoom) / 100,
                    }}
                    onPointerDown={(event) => beginCropDrag("move", event)}
                  >
                    {(
                      ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const
                    ).map((handle) => (
                      <button
                        key={handle}
                        type="button"
                        className={`is-${handle}`}
                        aria-label={t("chatWorkPanel.image.resizeCrop")}
                        onPointerDown={(event) => beginCropDrag(handle, event)}
                      />
                    ))}
                    <span className="work-panel-image-crop-size">
                      {Math.max(1, Math.round(cropRect.width))} ×{" "}
                      {Math.max(1, Math.round(cropRect.height))}
                    </span>
                    <div
                      className="work-panel-image-crop-actions"
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <Tooltip title={t("chatWorkPanel.image.exitCrop")}>
                        <button
                          type="button"
                          aria-label={t("chatWorkPanel.image.exitCrop")}
                          onClick={cancelCrop}
                        >
                          <CloseOutlined />
                        </button>
                      </Tooltip>
                      <Tooltip title={t("chatWorkPanel.image.apply")}>
                        <button
                          type="button"
                          className="is-apply"
                          aria-label={t("chatWorkPanel.image.apply")}
                          onClick={() => void applyCrop()}
                        >
                          <CheckOutlined />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                ) : null}
                {gesturePreview?.kind === "annotate" && gesturePreview.points[1]
                  ? (() => {
                      const rect = rectFromPoints(
                        gesturePreview.points[0],
                        gesturePreview.points[1],
                      );
                      return (
                        <div
                          className="work-panel-image-annotation is-preview"
                          style={{
                            left: (rect.x * effectiveZoom) / 100,
                            top: (rect.y * effectiveZoom) / 100,
                            width: (rect.width * effectiveZoom) / 100,
                            height: (rect.height * effectiveZoom) / 100,
                          }}
                        >
                          <span>+</span>
                        </div>
                      );
                    })()
                  : null}
                {[
                  ...annotations,
                  ...(annotationDraft ? [annotationDraft] : []),
                ].map((annotation) => (
                  <div
                    key={annotation.id}
                    className="work-panel-image-annotation"
                    style={{
                      left: (annotation.rect.x * effectiveZoom) / 100,
                      top: (annotation.rect.y * effectiveZoom) / 100,
                      width: (annotation.rect.width * effectiveZoom) / 100,
                      height: (annotation.rect.height * effectiveZoom) / 100,
                    }}
                    title={annotation.requirement}
                  >
                    <span>{annotation.number}</span>
                  </div>
                ))}
                {tool === "erase" && eraseTool === "rectangle"
                  ? eraseRegions.map((region, index) => {
                      if (region.tool !== "rectangle") return null;
                      const isActive = region === activeEraseRegion;
                      const bounds =
                        eraseFramePreview?.index === index
                          ? eraseFramePreview.region.bounds
                          : region.bounds;
                      return (
                        <div
                          key={index}
                          className={`work-panel-image-selection-frame is-region work-panel-image-erase-frame${isActive ? " is-active" : ""}`}
                          style={{
                            left: (bounds.x * effectiveZoom) / 100,
                            top: (bounds.y * effectiveZoom) / 100,
                            width: (bounds.width * effectiveZoom) / 100,
                            height: (bounds.height * effectiveZoom) / 100,
                          }}
                          onPointerDown={(event) =>
                            beginEraseFrameDrag(index, "move", event)
                          }
                        >
                          {isActive
                            ? (
                                [
                                  "nw",
                                  "n",
                                  "ne",
                                  "e",
                                  "se",
                                  "s",
                                  "sw",
                                  "w",
                                ] as const
                              ).map((handle) => (
                                <button
                                  key={handle}
                                  type="button"
                                  className={`is-${handle}`}
                                  aria-label={t(
                                    "chatWorkPanel.image.resizeSelectionBox",
                                  )}
                                  onPointerDown={(event) =>
                                    beginEraseFrameDrag(index, handle, event)
                                  }
                                />
                              ))
                            : null}
                        </div>
                      );
                    })
                  : null}
                {tool === "select"
                  ? selections.map((region) => {
                      const isActive = region.id === activeSelectionId;
                      const spaceBelow =
                        ((current.height -
                          (region.bounds.y + region.bounds.height)) *
                          effectiveZoom) /
                        100;
                      const placeAbove =
                        isActive &&
                        spaceBelow < 56 &&
                        (region.bounds.y * effectiveZoom) / 100 > 56;
                      return (
                        <div
                          key={region.id}
                          className={`work-panel-image-selection-frame is-region${isActive ? " is-active" : ""}`}
                          style={{
                            left: (region.bounds.x * effectiveZoom) / 100,
                            top: (region.bounds.y * effectiveZoom) / 100,
                            width: (region.bounds.width * effectiveZoom) / 100,
                            height:
                              (region.bounds.height * effectiveZoom) / 100,
                          }}
                          onPointerDown={(event) =>
                            beginSelectionFrameDrag(region.id, "move", event)
                          }
                        >
                          {isActive
                            ? (
                                [
                                  "nw",
                                  "n",
                                  "ne",
                                  "e",
                                  "se",
                                  "s",
                                  "sw",
                                  "w",
                                ] as const
                              ).map((handle) => (
                                <button
                                  key={handle}
                                  type="button"
                                  className={`is-${handle}`}
                                  aria-label={t(
                                    "chatWorkPanel.image.resizeSelectionBox",
                                  )}
                                  onPointerDown={(event) =>
                                    beginSelectionFrameDrag(
                                      region.id,
                                      handle,
                                      event,
                                    )
                                  }
                                />
                              ))
                            : null}
                          {isActive ? (
                            <div
                              className={`work-panel-image-selection-toolbar${placeAbove ? " is-above" : " is-below"}`}
                              onPointerDown={(event) => event.stopPropagation()}
                            >
                              <div
                                className="work-panel-image-selection-group"
                                role="group"
                                aria-label={t(
                                  "chatWorkPanel.image.selectionStyleLine",
                                )}
                              >
                                <button
                                  type="button"
                                  className={`work-panel-image-selection-swatch-button${selectionStyle === "line" ? " is-active" : ""}`}
                                  aria-label={t(
                                    "chatWorkPanel.image.selectionStyleLine",
                                  )}
                                  aria-pressed={selectionStyle === "line"}
                                  title={`${t("chatWorkPanel.image.selectionLineWidth")} ${selectionLineWidth}px`}
                                  onClick={() => changeSelectionStyle("line")}
                                >
                                  <span
                                    className="work-panel-image-selection-dot"
                                    style={{
                                      width: Math.min(
                                        20,
                                        Math.round(
                                          4 + selectionLineWidth * 1.2,
                                        ),
                                      ),
                                      height: Math.min(
                                        20,
                                        Math.round(
                                          4 + selectionLineWidth * 1.2,
                                        ),
                                      ),
                                    }}
                                  />
                                </button>
                                <button
                                  type="button"
                                  className={`work-panel-image-selection-swatch-button${selectionStyle === "fill" ? " is-active" : ""}`}
                                  aria-label={t(
                                    "chatWorkPanel.image.selectionStyleFill",
                                  )}
                                  aria-pressed={selectionStyle === "fill"}
                                  onClick={() => changeSelectionStyle("fill")}
                                >
                                  <span className="work-panel-image-selection-swatch is-fill" />
                                </button>
                              </div>
                              <span
                                className="work-panel-image-selection-divider"
                                aria-hidden="true"
                              />

                              <div
                                className="work-panel-image-selection-group"
                                role="group"
                                aria-label={t("chatWorkPanel.image.selection")}
                              >
                                <button
                                  type="button"
                                  className={
                                    selectionTool === "rectangle"
                                      ? "is-active"
                                      : ""
                                  }
                                  aria-label={t(
                                    "chatWorkPanel.image.selectionRectangle",
                                  )}
                                  aria-pressed={selectionTool === "rectangle"}
                                  onClick={() =>
                                    changeSelectionShape("rectangle")
                                  }
                                >
                                  <svg
                                    viewBox="0 0 22 22"
                                    aria-hidden="true"
                                    width="18"
                                  >
                                    <rect
                                      x="2"
                                      y="4"
                                      width="18"
                                      height="14"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                    />
                                  </svg>
                                </button>
                                <button
                                  type="button"
                                  className={
                                    selectionTool === "ellipse"
                                      ? "is-active"
                                      : ""
                                  }
                                  aria-label={t(
                                    "chatWorkPanel.image.selectionEllipse",
                                  )}
                                  aria-pressed={selectionTool === "ellipse"}
                                  onClick={() =>
                                    changeSelectionShape("ellipse")
                                  }
                                >
                                  <svg
                                    viewBox="0 0 22 22"
                                    aria-hidden="true"
                                    width="18"
                                  >
                                    <ellipse
                                      cx="11"
                                      cy="11"
                                      rx="9"
                                      ry="7"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                    />
                                  </svg>
                                </button>
                              </div>
                              <span
                                className="work-panel-image-selection-divider"
                                aria-hidden="true"
                              />
                              <input
                                type="color"
                                className="work-panel-image-selection-color"
                                aria-label={t(
                                  "chatWorkPanel.image.selectionColor",
                                )}
                                value={selectionColor}
                                onChange={(event) =>
                                  changeSelectionColor(event.target.value)
                                }
                              />
                              <div className="work-panel-image-selection-palette">
                                {SELECTION_PALETTE.map((color) => (
                                  <button
                                    key={color}
                                    type="button"
                                    className={`work-panel-image-selection-palette-color${color === selectionColor ? " is-active" : ""}`}
                                    style={{ background: color }}
                                    aria-label={color}
                                    onClick={() => changeSelectionColor(color)}
                                  />
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  : null}
              </div>
            ) : null}
          </div>

          {editing && annotationMode && annotationsOpen ? (
            <aside
              ref={annotationsPanelRef}
              className="work-panel-image-annotations"
              style={
                annotationsPanelPosition
                  ? {
                      left: annotationsPanelPosition.x,
                      top: annotationsPanelPosition.y,
                      right: "auto",
                    }
                  : undefined
              }
            >
              <header
                onPointerDown={(event) =>
                  beginFloatingPanelDrag("annotations", event)
                }
                onPointerMove={moveFloatingPanel}
                onPointerUp={endFloatingPanelDrag}
                onPointerCancel={endFloatingPanelDrag}
              >
                <strong>
                  <DragOutlined /> {t("chatWorkPanel.image.annotations")}
                </strong>
                <span>
                  {t("chatWorkPanel.image.annotationCount", {
                    count: annotations.length,
                  })}
                </span>
              </header>
              <p className="work-panel-image-annotation-guidance">
                <HighlightOutlined />
                <span>
                  {annotations.length === 0
                    ? t("chatWorkPanel.image.annotationEmpty")
                    : t("chatWorkPanel.image.annotationHint")}
                </span>
              </p>
              {annotations.length > 0 ? (
                <div className="work-panel-image-annotation-list" role="list">
                  {annotations.map((annotation) => (
                    <div
                      key={annotation.id}
                      role="listitem"
                      className={`work-panel-image-annotation-row${annotation.id === activeAnnotation?.id ? " is-active" : ""}`}
                    >
                      <span>{annotation.number}</span>
                      <input
                        value={annotation.requirement}
                        maxLength={1_000}
                        aria-label={t(
                          "chatWorkPanel.image.annotationRequirement",
                          {
                            number: annotation.number,
                          },
                        )}
                        placeholder={t(
                          "chatWorkPanel.image.annotationPlaceholder",
                        )}
                        onFocus={() => setActiveAnnotationId(annotation.id)}
                        onChange={(event) =>
                          setAnnotations((items) =>
                            items.map((item) =>
                              item.id === annotation.id
                                ? { ...item, requirement: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                      <Tooltip title={t("chatWorkPanel.image.remove")}>
                        <button
                          type="button"
                          aria-label={t("chatWorkPanel.image.remove")}
                          onClick={() => {
                            const remaining = annotations
                              .filter((item) => item.id !== annotation.id)
                              .map((item, index) => ({
                                ...item,
                                number: index + 1,
                              }));
                            setAnnotations(remaining);
                            if (annotation.id === activeAnnotation?.id) {
                              setActiveAnnotationId(remaining[0]?.id || "");
                            }
                          }}
                        >
                          <DeleteOutlined />
                        </button>
                      </Tooltip>
                    </div>
                  ))}
                </div>
              ) : null}
              {annotations.length > 0 ? (
                <div className="work-panel-image-annotation-actions">
                  <button
                    type="button"
                    className="is-primary"
                    disabled={
                      Boolean(aiBusy) ||
                      annotations.some(
                        (annotation) => !annotation.requirement.trim(),
                      )
                    }
                    onClick={() => void runAi("inpaint")}
                  >
                    {t("chatWorkPanel.image.smartEdit")}
                  </button>
                  <button
                    type="button"
                    disabled={
                      handoffBusy ||
                      annotations.some(
                        (annotation) => !annotation.requirement.trim(),
                      )
                    }
                    onClick={() => void handoff()}
                  >
                    {t("chatWorkPanel.image.handoff")}
                  </button>
                </div>
              ) : null}
            </aside>
          ) : null}
        </div>
      </div>

      {saveOpen ? (
        <div
          className="work-panel-image-modal-backdrop"
          role="presentation"
          onMouseDown={() => !saveBusy && setSaveOpen(false)}
        >
          <div
            className="work-panel-image-save-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t("chatWorkPanel.image.saveChoice")}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <strong>{t("chatWorkPanel.image.saveChoice")}</strong>
            <p>{t("chatWorkPanel.image.saveChoiceDescription")}</p>
            <div className="work-panel-image-save-actions">
              <button
                type="button"
                disabled={saveBusy}
                onClick={() => setSaveOpen(false)}
              >
                {t("chatWorkPanel.image.cancel")}
              </button>
              {resource.profile !== "reference" && !sourceConflict ? (
                <button
                  type="button"
                  disabled={saveBusy}
                  onClick={() => void save("overwrite")}
                >
                  {t("chatWorkPanel.image.overwrite")}
                </button>
              ) : null}
              {resource.profile !== "workspace-file" ? (
                <button
                  type="button"
                  className="is-primary"
                  disabled={saveBusy}
                  onClick={() => void save("new-artifact")}
                >
                  {t("chatWorkPanel.image.saveNew")}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
