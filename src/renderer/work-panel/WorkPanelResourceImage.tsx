import {
  ArrowLeftOutlined,
  BgColorsOutlined,
  BorderOutlined,
  CheckOutlined,
  CompressOutlined,
  ControlOutlined,
  DragOutlined,
  EditOutlined,
  ExportOutlined,
  ExpandOutlined,
  FullscreenOutlined,
  HighlightOutlined,
  InfoCircleOutlined,
  LinkOutlined,
  PictureOutlined,
  RedoOutlined,
  RotateRightOutlined,
  SaveOutlined,
  ScissorOutlined,
  ThunderboltOutlined,
  UndoOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from "@ant-design/icons";
import { Popover, Tooltip } from "antd";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { ImageRegionAnnotation } from "../../shared/work-panel-review";
import type {
  WorkPanelResourceImageAiOperation,
  WorkPanelResourceImageSelection,
} from "../../shared/work-panel-resource-image";
import { useI18n } from "../i18n/useI18n";

const ZOOM_STEPS = [10, 25, 50, 75, 100, 125, 150, 200, 400, 800];
const HISTORY_LIMIT = 50;

type Snapshot = {
  url: string;
  width: number;
  height: number;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
};

type SelectionTool = "rectangle" | "ellipse" | "lasso" | "brush";
type SelectionMode = "add" | "subtract";
type SelectionPurpose = "general" | "removeObject";
type AiPromptOperation = "replaceBackground" | "outpaint";
type Point = { x: number; y: number };
type SelectionTransformState = {
  baseUrl: string;
  contentUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
};
type SelectionTransformDrag = {
  mode: "move" | "nw" | "ne" | "sw" | "se";
  clientX: number;
  clientY: number;
  initial: Pick<SelectionTransformState, "x" | "y" | "width" | "height">;
};
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

type ImageButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title" | "type"> & {
  children: ReactNode;
  label: string;
};

function ImageToolButton({ children, label, ...buttonProps }: ImageButtonProps) {
  return (
    <Tooltip title={label} placement="right" mouseEnterDelay={0.15}>
      <span className="work-panel-image-tool-tooltip-anchor">
        <button {...buttonProps} type="button" aria-label={label}>{children}</button>
      </span>
    </Tooltip>
  );
}

function ImageToolbarButton({ children, label, ...buttonProps }: ImageButtonProps) {
  return (
    <Tooltip title={label} mouseEnterDelay={0.15}>
      <span className="work-panel-image-toolbar-button-anchor">
        <button {...buttonProps} type="button" aria-label={label}>
          {children}
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
    return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (
    value && typeof value === "object" &&
    (value as { type?: unknown }).type === "Buffer" &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    return Uint8Array.from((value as { data: number[] }).data);
  }
  return null;
}

function canvasBlob(canvas: HTMLCanvasElement, mimeType: Snapshot["mimeType"] = "image/png") {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("image_encode_failed")), mimeType, 0.94);
  });
}

function blobBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",", 2)[1] || "");
    reader.onerror = () => reject(reader.error || new Error("image_read_failed"));
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

function imageFormat(mimeType: string) {
  if (mimeType === "image/jpeg") return "JPEG";
  if (mimeType === "image/webp") return "WebP";
  return "PNG";
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
  const floatingControlsRef = useRef<HTMLDivElement | null>(null);
  const annotationsPanelRef = useRef<HTMLElement | null>(null);
  const selectionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const snapshotUrlsRef = useRef(new Set<string>());
  const drawStartRef = useRef<Point | null>(null);
  const drawPointsRef = useRef<Point[]>([]);
  const panRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const selectionTransformDragRef = useRef<SelectionTransformDrag | null>(null);
  const floatingPanelDragRef = useRef<FloatingPanelDrag | null>(null);
  const previousEditingRef = useRef(editing);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tool, setTool] = useState<"pan" | "crop" | "annotate" | "select">("pan");
  const [selectionTool, setSelectionTool] = useState<SelectionTool>("rectangle");
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("add");
  const [selectionPurpose, setSelectionPurpose] = useState<SelectionPurpose>("general");
  const [brushSize, setBrushSize] = useState(40);
  const [hasSelection, setHasSelection] = useState(false);
  const [gesturePreview, setGesturePreview] = useState<GesturePreview | null>(null);
  const [cropRect, setCropRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [annotations, setAnnotations] = useState<ImageRegionAnnotation[]>([]);
  const [activeAnnotationId, setActiveAnnotationId] = useState("");
  const [floatingControlsPosition, setFloatingControlsPosition] = useState<FloatingPanelPosition>(null);
  const [annotationsPanelPosition, setAnnotationsPanelPosition] = useState<FloatingPanelPosition>(null);
  const [zoom, setZoom] = useState(100);
  const [fitMode, setFitMode] = useState(true);
  const [fitZoom, setFitZoom] = useState(100);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjust, setAdjust] = useState({ exposure: 0, contrast: 0, saturation: 0 });
  const [resizeAspectLocked, setResizeAspectLocked] = useState(true);
  const [canvasSizeOpen, setCanvasSizeOpen] = useState(false);
  const [canvasTargetSize, setCanvasTargetSize] = useState({ width: 0, height: 0 });
  const [selectionTransform, setSelectionTransform] = useState<SelectionTransformState | null>(null);
  const [aiPromptOperation, setAiPromptOperation] = useState<AiPromptOperation | null>(null);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiTargetSize, setAiTargetSize] = useState({ width: 0, height: 0 });
  const [aiBusy, setAiBusy] = useState<{ requestId: string; operation: WorkPanelResourceImageAiOperation } | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [sourceConflict, setSourceConflict] = useState(false);
  const [sourceRevision, setSourceRevision] = useState(resource.revision);
  const [handoffBusy, setHandoffBusy] = useState(false);

  const discardSelectionTransform = useCallback(() => {
    setSelectionTransform((value) => {
      if (!value) return null;
      snapshotUrlsRef.current.delete(value.baseUrl);
      snapshotUrlsRef.current.delete(value.contentUrl);
      URL.revokeObjectURL(value.baseUrl);
      URL.revokeObjectURL(value.contentUrl);
      return null;
    });
    selectionTransformDragRef.current = null;
  }, []);

  const current = history[historyIndex] || null;
  const activeAnnotation = annotations.find((annotation) => annotation.id === activeAnnotationId) || annotations[0] || null;
  const effectiveZoom = fitMode ? fitZoom : zoom;
  const pixelDirty = historyIndex > 0;
  const dirty = pixelDirty || annotations.length > 0;
  const editDisabled = Boolean(current && (
    current.width > 8_192 || current.height > 8_192 || current.width * current.height > 40_000_000
  ));

  const handleRequest = useMemo(() => ({
    ownerChatId,
    rendererGeneration,
    handleId: resource.handleId,
  }), [ownerChatId, rendererGeneration, resource.handleId]);

  const replaceHistory = useCallback((next: Snapshot) => {
    snapshotUrlsRef.current.add(next.url);
    setHistory((previous) => {
      const retained = previous.slice(0, historyIndex + 1);
      const removed = [...retained.slice(0, Math.max(0, retained.length - HISTORY_LIMIT + 1)), ...previous.slice(historyIndex + 1)];
      for (const snapshot of removed) {
        if (snapshot.url.startsWith("blob:")) {
          URL.revokeObjectURL(snapshot.url);
          snapshotUrlsRef.current.delete(snapshot.url);
        }
      }
      const limited = [...retained.slice(Math.max(0, retained.length - HISTORY_LIMIT + 1)), next];
      setHistoryIndex(limited.length - 1);
      return limited;
    });
    setCropRect(null);
    const selection = selectionCanvasRef.current;
    selection?.getContext("2d")?.clearRect(0, 0, selection.width, selection.height);
    setHasSelection(false);
  }, [historyIndex]);

  const readResource = useCallback(async () => {
    setLoading(true);
    setError("");
    const result = await window.electronAPI.chatWorkPanel.resourceImages.read(handleRequest);
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
      for (const previousUrl of snapshotUrlsRef.current) URL.revokeObjectURL(previousUrl);
      snapshotUrlsRef.current = new Set([url]);
      setHistory([{ url, width: image.naturalWidth, height: image.naturalHeight, mimeType: resource.mimeType }]);
      setHistoryIndex(0);
      setAnnotations([]);
      setActiveAnnotationId("");
      setHasSelection(false);
      setSelectionPurpose("general");
      setSelectionTransform(null);
      setAiPromptOperation(null);
      setAiInstruction("");
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
    discardSelectionTransform();
    for (const url of snapshotUrlsRef.current) URL.revokeObjectURL(url);
    snapshotUrlsRef.current.clear();
    const selection = selectionCanvasRef.current;
    selection?.getContext("2d")?.clearRect(0, 0, selection.width, selection.height);
    drawStartRef.current = null;
    drawPointsRef.current = [];
    panRef.current = null;
    floatingPanelDragRef.current = null;
    setHistory([]);
    setHistoryIndex(0);
    setError("");
    setTool("pan");
    setSelectionTool("rectangle");
    setSelectionMode("add");
    setSelectionPurpose("general");
    setBrushSize(40);
    setHasSelection(false);
    setGesturePreview(null);
    setCropRect(null);
    setAnnotations([]);
    setActiveAnnotationId("");
    setAdjustOpen(false);
    setAdjust({ exposure: 0, contrast: 0, saturation: 0 });
    setResizeAspectLocked(true);
    setCanvasSizeOpen(false);
    setCanvasTargetSize({ width: 0, height: 0 });
    setAiPromptOperation(null);
    setAiInstruction("");
    setAiTargetSize({ width: 0, height: 0 });
    setSaveOpen(false);
    setSourceConflict(false);
    setFloatingControlsPosition(null);
    setAnnotationsPanelPosition(null);
    void readResource();
  }, [discardSelectionTransform, readResource]);

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
          x: clamp(position.x, 0, Math.max(0, content.clientWidth - panel.offsetWidth)),
          y: clamp(position.y, 0, Math.max(0, content.clientHeight - panel.offsetHeight)),
        };
      };
      setFloatingControlsPosition((position) => clampPosition(position, floatingControlsRef.current));
      setAnnotationsPanelPosition((position) => clampPosition(position, annotationsPanelRef.current));
    };
    const observer = new ResizeObserver(keepPanelsVisible);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    discardSelectionTransform();
  }, [discardSelectionTransform, historyIndex]);

  useEffect(() => {
    void readResource();
  }, [readResource]);

  useEffect(() => () => {
    for (const url of snapshotUrlsRef.current) URL.revokeObjectURL(url);
  }, []);

  useEffect(() => window.electronAPI.chatWorkPanel.resourceImages.onChanged((event) => {
    if (event.handleId !== resource.handleId || event.revision === sourceRevision) return;
    if (dirty) setSourceConflict(true);
    else void readResource();
  }), [dirty, readResource, resource.handleId, sourceRevision]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !current) return;
    const update = () => {
      const availableWidth = Math.max(1, viewport.clientWidth - 48);
      const availableHeight = Math.max(1, viewport.clientHeight - 48);
      setFitZoom(clamp(Math.min(availableWidth / current.width, availableHeight / current.height) * 100, 10, 800));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [current]);

  useEffect(() => {
    const canvas = selectionCanvasRef.current;
    if (!canvas || !current) return;
    if (canvas.width === current.width && canvas.height === current.height) return;
    canvas.width = current.width;
    canvas.height = current.height;
    setHasSelection(false);
  }, [current]);

  const requireAnnotationClear = useCallback(() => {
    if (annotations.length === 0) return true;
    if (!window.confirm(t("chatWorkPanel.image.confirmClearAnnotations"))) return false;
    setAnnotations([]);
    return true;
  }, [annotations.length, t]);

  const snapshotFromCanvas = useCallback(async (
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
  }, [replaceHistory]);

  const transform = useCallback(async (
    operation: "rotate" | "flip-x" | "flip-y",
  ) => {
    if (!current || !requireAnnotationClear()) return;
    const image = await loadImage(current.url);
    const canvas = document.createElement("canvas");
    const rotated = operation === "rotate";
    canvas.width = rotated ? current.height : current.width;
    canvas.height = rotated ? current.width : current.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    if (operation === "rotate") {
      context.translate(canvas.width, 0);
      context.rotate(Math.PI / 2);
    } else if (operation === "flip-x") {
      context.translate(canvas.width, 0);
      context.scale(-1, 1);
    } else {
      context.translate(0, canvas.height);
      context.scale(1, -1);
    }
    context.drawImage(image, 0, 0);
    await snapshotFromCanvas(canvas, current.mimeType);
  }, [current, requireAnnotationClear, snapshotFromCanvas]);

  const resizeImage = useCallback(async () => {
    if (!current || !requireAnnotationClear()) return;
    const widthText = window.prompt(t("chatWorkPanel.image.promptWidth"), String(current.width));
    if (widthText === null) return;
    const width = Math.round(Number(widthText));
    if (!Number.isFinite(width) || width < 1 || width > 8_192) return;
    const suggestedHeight = Math.round(current.height * width / current.width);
    const heightText = resizeAspectLocked
      ? String(suggestedHeight)
      : window.prompt(t("chatWorkPanel.image.promptHeight"), String(suggestedHeight));
    if (heightText === null) return;
    const height = Math.round(Number(heightText));
    if (!Number.isFinite(height) || height < 1 || height > 8_192 || width * height > 40_000_000) return;
    const image = await loadImage(current.url);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(image, 0, 0, width, height);
    await snapshotFromCanvas(canvas, current.mimeType);
  }, [current, requireAnnotationClear, resizeAspectLocked, snapshotFromCanvas, t]);

  const applyCanvasSize = useCallback(async () => {
    if (!current || !requireAnnotationClear()) return;
    const width = Math.round(canvasTargetSize.width);
    const height = Math.round(canvasTargetSize.height);
    if (
      !Number.isFinite(width) || !Number.isFinite(height) ||
      width < 1 || height < 1 || width > 8_192 || height > 8_192 || width * height > 40_000_000
    ) return;
    const image = await loadImage(current.url);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return;
    if (current.mimeType === "image/jpeg") {
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(image, Math.round((width - current.width) / 2), Math.round((height - current.height) / 2));
    await snapshotFromCanvas(canvas, current.mimeType);
    setCanvasSizeOpen(false);
  }, [canvasTargetSize.height, canvasTargetSize.width, current, requireAnnotationClear, snapshotFromCanvas]);

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
    canvas.getContext("2d")?.drawImage(image, x, y, width, height, 0, 0, width, height);
    await snapshotFromCanvas(canvas, current.mimeType);
    setTool("pan");
  }, [cropRect, current, requireAnnotationClear, snapshotFromCanvas]);

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

  const pointFromEvent = (event: ReactPointerEvent<HTMLElement>): Point | null => {
    if (!current) return null;
    const imageHost = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp((event.clientX - imageHost.left) / (effectiveZoom / 100), 0, current.width),
      y: clamp((event.clientY - imageHost.top) / (effectiveZoom / 100), 0, current.height),
    };
  };

  const paintSelectionPath = useCallback((points: Point[], shape: SelectionTool) => {
    const canvas = selectionCanvasRef.current;
    if (!canvas || points.length === 0) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.save();
    context.globalCompositeOperation = selectionMode === "subtract" ? "destination-out" : "source-over";
    context.fillStyle = "rgba(101, 78, 255, 0.42)";
    context.strokeStyle = "rgba(101, 78, 255, 0.72)";
    context.lineCap = "round";
    context.lineJoin = "round";
    if ((shape === "rectangle" || shape === "ellipse") && points[1]) {
      const start = points[0];
      const end = points[1];
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const width = Math.abs(end.x - start.x);
      const height = Math.abs(end.y - start.y);
      if (shape === "rectangle") context.fillRect(x, y, width, height);
      else {
        context.beginPath();
        context.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
        context.fill();
      }
    } else if (shape === "brush") {
      context.lineWidth = brushSize;
      context.beginPath();
      context.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) context.lineTo(point.x, point.y);
      context.stroke();
    } else if (shape === "lasso" && points.length > 2) {
      context.beginPath();
      context.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) context.lineTo(point.x, point.y);
      context.closePath();
      context.fill();
    }
    context.restore();
    if (selectionMode === "add") setHasSelection(true);
  }, [brushSize, selectionMode]);

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!current || event.button !== 0) return;
    if (aiBusy && tool !== "pan") return;
    if (tool === "pan") {
      const viewport = viewportRef.current;
      if (!viewport) return;
      panRef.current = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const point = pointFromEvent(event);
    if (!point) return;
    drawStartRef.current = point;
    drawPointsRef.current = [point];
    if (tool === "annotate") {
      setGesturePreview({ kind: "annotate", points: [point, point] });
    } else if (tool === "select") {
      setGesturePreview({ kind: "select", shape: selectionTool, points: [point] });
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panRef.current && tool === "pan") {
      const viewport = viewportRef.current;
      if (!viewport) return;
      viewport.scrollLeft = panRef.current.left - (event.clientX - panRef.current.x);
      viewport.scrollTop = panRef.current.top - (event.clientY - panRef.current.y);
      return;
    }
    if (!drawStartRef.current) return;
    const point = pointFromEvent(event);
    if (!point) return;
    if (tool === "crop") {
      setCropRect(rectFromPoints(drawStartRef.current, point));
    } else if (tool === "annotate") {
      setGesturePreview({ kind: "annotate", points: [drawStartRef.current, point] });
    } else if (tool === "select") {
      drawPointsRef.current.push(point);
      const points = selectionTool === "rectangle" || selectionTool === "ellipse"
        ? [drawStartRef.current, point]
        : [...drawPointsRef.current];
      setGesturePreview({ kind: "select", shape: selectionTool, points });
    }
  };

  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    panRef.current = null;
    const start = drawStartRef.current;
    if (!start) return;
    const end = pointFromEvent(event) || start;
    if (tool === "annotate" && current) {
      let rect = rectFromPoints(start, end);
      if (rect.width < 3 || rect.height < 3) {
        const size = Math.min(72 / (effectiveZoom / 100), current.width, current.height);
        rect = {
          x: clamp(start.x - size / 2, 0, Math.max(0, current.width - size)),
          y: clamp(start.y - size / 2, 0, Math.max(0, current.height - size)),
          width: size,
          height: size,
        };
      }
      if (rect.width > 0 && rect.height > 0 && annotations.length < 50) {
        const id = globalThis.crypto.randomUUID();
        setAnnotations((previous) => [...previous, {
          id,
          number: previous.length + 1,
          kind: "image-region",
          rect,
          normalizedRect: {
            x: rect.x / current.width,
            y: rect.y / current.height,
            width: rect.width / current.width,
            height: rect.height / current.height,
          },
          requirement: "",
        }]);
        setActiveAnnotationId(id);
      }
    } else if (tool === "select") {
      const points = selectionTool === "rectangle" || selectionTool === "ellipse"
        ? [start, end]
        : [...drawPointsRef.current, end];
      paintSelectionPath(points, selectionTool);
    }
    drawStartRef.current = null;
    drawPointsRef.current = [];
    setGesturePreview(null);
  };

  const clearSelection = () => {
    const canvas = selectionCanvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setHasSelection(false);
  };

  const invertSelection = () => {
    const canvas = selectionCanvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const previous = document.createElement("canvas");
    previous.width = canvas.width;
    previous.height = canvas.height;
    previous.getContext("2d")?.drawImage(canvas, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(101, 78, 255, 0.42)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = "destination-out";
    context.drawImage(previous, 0, 0);
    context.globalCompositeOperation = "source-over";
    setHasSelection(true);
  };

  const beginSelectionTransform = async () => {
    const selection = selectionCanvasRef.current;
    const selectionContext = selection?.getContext("2d");
    if (!current || !selection || !selectionContext) return;
    const pixels = selectionContext.getImageData(0, 0, selection.width, selection.height);
    let minX = selection.width;
    let minY = selection.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < selection.height; y += 1) {
      for (let x = 0; x < selection.width; x += 1) {
        if (pixels.data[(y * selection.width + x) * 4 + 3] === 0) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    if (maxX < minX || maxY < minY) {
      setError(t("chatWorkPanel.image.freeTransformSelectionRequired"));
      return;
    }
    const mask = document.createElement("canvas");
    mask.width = selection.width;
    mask.height = selection.height;
    const maskContext = mask.getContext("2d");
    if (!maskContext) return;
    const binaryMask = maskContext.createImageData(mask.width, mask.height);
    for (let index = 0; index < pixels.data.length; index += 4) {
      if (pixels.data[index + 3] === 0) continue;
      binaryMask.data[index] = 255;
      binaryMask.data[index + 1] = 255;
      binaryMask.data[index + 2] = 255;
      binaryMask.data[index + 3] = 255;
    }
    maskContext.putImageData(binaryMask, 0, 0);

    const image = await loadImage(current.url);
    const base = document.createElement("canvas");
    base.width = current.width;
    base.height = current.height;
    const baseContext = base.getContext("2d");
    const selected = document.createElement("canvas");
    selected.width = current.width;
    selected.height = current.height;
    const selectedContext = selected.getContext("2d");
    if (!baseContext || !selectedContext) return;
    baseContext.drawImage(image, 0, 0);
    baseContext.globalCompositeOperation = "destination-out";
    baseContext.drawImage(mask, 0, 0);
    selectedContext.drawImage(image, 0, 0);
    selectedContext.globalCompositeOperation = "destination-in";
    selectedContext.drawImage(mask, 0, 0);

    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const content = document.createElement("canvas");
    content.width = width;
    content.height = height;
    content.getContext("2d")?.drawImage(selected, minX, minY, width, height, 0, 0, width, height);
    const [baseBlob, contentBlob] = await Promise.all([
      canvasBlob(base, "image/png"),
      canvasBlob(content, "image/png"),
    ]);
    discardSelectionTransform();
    const baseUrl = URL.createObjectURL(baseBlob);
    const contentUrl = URL.createObjectURL(contentBlob);
    snapshotUrlsRef.current.add(baseUrl);
    snapshotUrlsRef.current.add(contentUrl);
    setAdjustOpen(false);
    setCanvasSizeOpen(false);
    setAiPromptOperation(null);
    setError("");
    setTool("pan");
    setSelectionTransform({ baseUrl, contentUrl, x: minX, y: minY, width, height, rotation: 0 });
  };

  const applySelectionTransform = async () => {
    if (!current || !selectionTransform || !requireAnnotationClear()) return;
    const [base, content] = await Promise.all([
      loadImage(selectionTransform.baseUrl),
      loadImage(selectionTransform.contentUrl),
    ]);
    const canvas = document.createElement("canvas");
    canvas.width = current.width;
    canvas.height = current.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    if (current.mimeType === "image/jpeg") {
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(base, 0, 0);
    context.save();
    context.translate(
      selectionTransform.x + selectionTransform.width / 2,
      selectionTransform.y + selectionTransform.height / 2,
    );
    context.rotate(selectionTransform.rotation * Math.PI / 180);
    context.drawImage(
      content,
      -selectionTransform.width / 2,
      -selectionTransform.height / 2,
      selectionTransform.width,
      selectionTransform.height,
    );
    context.restore();
    await snapshotFromCanvas(canvas, current.mimeType);
    discardSelectionTransform();
    clearSelection();
  };

  const beginSelectionTransformDrag = (mode: SelectionTransformDrag["mode"], event: ReactPointerEvent<HTMLElement>) => {
    if (!selectionTransform) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectionTransformDragRef.current = {
      mode,
      clientX: event.clientX,
      clientY: event.clientY,
      initial: {
        x: selectionTransform.x,
        y: selectionTransform.y,
        width: selectionTransform.width,
        height: selectionTransform.height,
      },
    };
  };

  const moveSelectionTransform = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = selectionTransformDragRef.current;
    if (!drag || !current) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = (event.clientX - drag.clientX) / (effectiveZoom / 100);
    const dy = (event.clientY - drag.clientY) / (effectiveZoom / 100);
    setSelectionTransform((value) => {
      if (!value) return null;
      if (drag.mode === "move") {
        return {
          ...value,
          x: clamp(drag.initial.x + dx, 0, Math.max(0, current.width - drag.initial.width)),
          y: clamp(drag.initial.y + dy, 0, Math.max(0, current.height - drag.initial.height)),
        };
      }
      const movesLeft = drag.mode === "nw" || drag.mode === "sw";
      const movesTop = drag.mode === "nw" || drag.mode === "ne";
      const nextX = movesLeft
        ? clamp(drag.initial.x + dx, 0, drag.initial.x + drag.initial.width - 1)
        : drag.initial.x;
      const nextY = movesTop
        ? clamp(drag.initial.y + dy, 0, drag.initial.y + drag.initial.height - 1)
        : drag.initial.y;
      const nextWidth = movesLeft
        ? drag.initial.width + drag.initial.x - nextX
        : clamp(drag.initial.width + dx, 1, current.width - drag.initial.x);
      const nextHeight = movesTop
        ? drag.initial.height + drag.initial.y - nextY
        : clamp(drag.initial.height + dy, 1, current.height - drag.initial.y);
      return { ...value, x: nextX, y: nextY, width: nextWidth, height: nextHeight };
    });
  };

  const selectionMaskBase64 = async (
    annotationRegions: ImageRegionAnnotation[] = [],
    includeSelection = true,
  ) => {
    const selection = selectionCanvasRef.current;
    if (!selection) return "";
    const source = selection.getContext("2d")?.getImageData(0, 0, selection.width, selection.height);
    if (!source) return "";
    const selectionPresent = includeSelection && source.data.some((value, index) => index % 4 === 3 && value > 0);
    if (!selectionPresent && annotationRegions.length === 0) return "";
    const mask = document.createElement("canvas");
    mask.width = selection.width;
    mask.height = selection.height;
    const context = mask.getContext("2d");
    if (!context) return "";
    context.fillStyle = "black";
    context.fillRect(0, 0, mask.width, mask.height);
    context.fillStyle = "white";
    context.globalCompositeOperation = "source-over";
    context.drawImage(selection, 0, 0);
    const pixels = context.getImageData(0, 0, mask.width, mask.height);
    for (let index = 0; index < pixels.data.length; index += 4) {
      const selected = includeSelection && source.data[index + 3] > 0;
      pixels.data[index] = selected ? 255 : 0;
      pixels.data[index + 1] = selected ? 255 : 0;
      pixels.data[index + 2] = selected ? 255 : 0;
      pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    context.fillStyle = "white";
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
    const panel = kind === "tools" ? floatingControlsRef.current : annotationsPanelRef.current;
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
    const panel = drag.kind === "tools" ? floatingControlsRef.current : annotationsPanelRef.current;
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
    if (!consumesAnnotations && annotations.length > 0 && !window.confirm(t("chatWorkPanel.image.confirmClearAnnotations"))) {
      return;
    }
    if (operation === "inpaint" && (
      annotations.length === 0 || annotations.some((annotation) => !annotation.requirement.trim())
    )) {
      setTool("annotate");
      setError(t("chatWorkPanel.image.annotationRequired"));
      return;
    }
    const annotationRegions = operation === "inpaint" ? annotations : [];
    const maskDataBase64 = await selectionMaskBase64(annotationRegions, operation === "removeObject");
    if (requiresMask && !maskDataBase64) {
      setError(t(operation === "removeObject"
        ? "chatWorkPanel.image.selectionRequired"
        : "chatWorkPanel.image.annotationRequired"));
      return;
    }
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
        !Number.isFinite(targetWidth) || !Number.isFinite(targetHeight) ||
        targetWidth < current.width || targetHeight < current.height ||
        targetWidth > 8_192 || targetHeight > 8_192 || targetWidth * targetHeight > 40_000_000
      ) return;
    }
    const sourceBlob = await fetch(current.url).then((response) => response.blob());
    const sourceDataBase64 = await blobBase64(sourceBlob);
    const requestId = globalThis.crypto.randomUUID();
    setTool("pan");
    setAiPromptOperation(null);
    setAiBusy({ requestId, operation });
    setError("");
    try {
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
        setError(result.message || t("chatWorkPanel.image.aiFailed"));
        if (operation === "removeObject") {
          setSelectionPurpose("removeObject");
          setTool("select");
        }
        return;
      }
      const bytes = Uint8Array.from(atob(result.image.dataBase64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: result.image.mimeType }));
      const image = await loadImage(url);
      if (
        operation === "removeBackground" ||
        image.naturalWidth !== targetWidth || image.naturalHeight !== targetHeight
      ) {
        const canvas = document.createElement("canvas");
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const copyWidth = Math.min(targetWidth, image.naturalWidth);
        const copyHeight = Math.min(targetHeight, image.naturalHeight);
        canvas.getContext("2d")?.drawImage(
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
        await snapshotFromCanvas(canvas, operation === "removeBackground" ? "image/png" : result.image.mimeType);
      } else {
        replaceHistory({
          url,
          width: targetWidth,
          height: targetHeight,
          mimeType: result.image.mimeType,
        });
      }
      clearSelection();
      setAnnotations([]);
      setActiveAnnotationId("");
      setAiInstruction("");
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

  const renderedBlob = useCallback(async (includeAnnotations = false) => {
    if (!current) return null;
    const image = await loadImage(current.url);
    const canvas = document.createElement("canvas");
    canvas.width = current.width;
    canvas.height = current.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0);
    if (includeAnnotations) {
      const lineWidth = Math.max(2, Math.round(Math.min(current.width, current.height) / 320));
      context.strokeStyle = "#ff3b30";
      context.fillStyle = "#ff3b30";
      context.lineWidth = lineWidth;
      context.font = `600 ${Math.max(14, lineWidth * 6)}px sans-serif`;
      for (const annotation of annotations) {
        context.strokeRect(annotation.rect.x, annotation.rect.y, annotation.rect.width, annotation.rect.height);
        const label = String(annotation.number);
        const labelWidth = context.measureText(label).width + lineWidth * 4;
        const labelHeight = Math.max(18, lineWidth * 8);
        context.fillRect(annotation.rect.x, Math.max(0, annotation.rect.y - labelHeight), labelWidth, labelHeight);
        context.fillStyle = "white";
        context.fillText(label, annotation.rect.x + lineWidth * 2, Math.max(labelHeight - lineWidth * 2, annotation.rect.y - lineWidth * 2));
        context.fillStyle = "#ff3b30";
      }
    }
    return canvasBlob(canvas, includeAnnotations ? "image/png" : current.mimeType);
  }, [annotations, current]);

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
      const alpha = context?.getImageData(0, 0, canvas.width, canvas.height).data;
      let hasTransparency = false;
      if (alpha) {
        for (let index = 3; index < alpha.length; index += 4) {
          if (alpha[index] < 255) { hasTransparency = true; break; }
        }
      }
      if (mode === "overwrite" && resource.mimeType === "image/jpeg" && hasTransparency) {
        setError(t("chatWorkPanel.image.transparentJpeg"));
        return;
      }
      const mimeType = mode === "overwrite"
        ? resource.mimeType
        : hasTransparency && current.mimeType === "image/jpeg"
          ? "image/png"
          : current.mimeType;
      const output = mimeType === current.mimeType ? blob : await canvasBlob(canvas, mimeType);
      const result = await window.electronAPI.chatWorkPanel.resourceImages.commit({
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
        setHistory((previous) => [previous[historyIndex]]);
        setHistoryIndex(0);
        setAnnotations([]);
        setSourceConflict(false);
      }
    } finally {
      setSaveBusy(false);
    }
  };

  const openExternal = async (mode: "default" | "choose") => {
    if (dirty && !window.confirm(t("chatWorkPanel.image.externalDraftWarning"))) return;
    const result = await window.electronAPI.chatWorkPanel.resourceImages.openExternal({ ...handleRequest, mode });
    if (!result.ok && result.message) setError(result.message);
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

  const changeZoom = (next: number) => {
    setFitMode(false);
    setZoom(clamp(Math.round(next), 10, 800));
  };

  const stepZoom = (direction: -1 | 1) => {
    const currentZoom = effectiveZoom;
    const ordered = direction > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
    const next = ordered.find((step) => direction > 0 ? step > currentZoom + 0.5 : step < currentZoom - 0.5);
    changeZoom(next ?? (direction > 0 ? 800 : 10));
  };

  const onWheel = (event: ReactWheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    changeZoom(effectiveZoom * (event.deltaY < 0 ? 1.1 : 0.9));
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!root.contains(document.activeElement)) return;
      const command = event.metaKey || event.ctrlKey;
      if (!command) return;
      if (event.key === "0") { event.preventDefault(); setFitMode(true); }
      else if (event.key === "1") { event.preventDefault(); changeZoom(100); }
      else if (event.key === "+" || event.key === "=") { event.preventDefault(); stepZoom(1); }
      else if (event.key === "-") { event.preventDefault(); stepZoom(-1); }
      else if (editing && event.key.toLowerCase() === "z" && !event.shiftKey) {
        event.preventDefault(); setHistoryIndex((index) => Math.max(0, index - 1));
      } else if (editing && (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey))) {
        event.preventDefault(); setHistoryIndex((index) => Math.min(history.length - 1, index + 1));
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [active, editing, history.length]);

  const imageFilter = adjustOpen
    ? `brightness(${100 + adjust.exposure}%) contrast(${100 + adjust.contrast}%) saturate(${100 + adjust.saturation}%)`
    : undefined;
  const aiPromptLabel = aiPromptOperation === "replaceBackground"
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
      <div className={`work-panel-image-toolbar${editing ? " is-editing" : " is-preview"}`} role="toolbar" aria-label={t("chatWorkPanel.image.toolbar")}>
        {!editing ? (
          <>
            <Popover
              trigger={["hover", "focus"]}
              title={t("chatWorkPanel.image.info")}
              content={(
                <div className="work-panel-image-info-content">
                  <strong>{resource.fileName}</strong>
                  <span>{imageFormat(resource.mimeType)} · {formatBytes(resource.sizeBytes)}</span>
                  <span>{current ? `${current.width} × ${current.height}` : "—"}</span>
                </div>
              )}
            >
              <button type="button" className="work-panel-image-info-button" aria-label={t("chatWorkPanel.image.info")}>
                <InfoCircleOutlined />
              </button>
            </Popover>
            <div className="work-panel-image-spacer" />
            <div className="work-panel-image-toolbar-actions">
              <button type="button" onClick={() => stepZoom(-1)} aria-label={t("chatWorkPanel.image.zoomOut")}><ZoomOutOutlined /></button>
              <span className="work-panel-image-zoom-control">
                <input
                  type="number"
                  min={10}
                  max={800}
                  value={Math.round(effectiveZoom)}
                  aria-label={t("chatWorkPanel.image.zoom")}
                  onChange={(event) => changeZoom(Number(event.target.value))}
                />
                <span>%</span>
                <select aria-label={t("chatWorkPanel.image.zoom")} value="" onChange={(event) => {
                  const value = event.target.value;
                  if (value === "fit") setFitMode(true);
                  else if (value) changeZoom(Number(value));
                }}>
                  <option value="" disabled>▾</option>
                  <option value="fit">{t("chatWorkPanel.image.fit")}</option>
                  {ZOOM_STEPS.map((step) => <option key={step} value={step}>{step}%</option>)}
                </select>
              </span>
              <button type="button" onClick={() => stepZoom(1)} aria-label={t("chatWorkPanel.image.zoomIn")}><ZoomInOutlined /></button>
              <span className="work-panel-image-open-with">
                <ExportOutlined aria-hidden="true" />
                <select aria-label={t("chatWorkPanel.image.openWith")} disabled={saveBusy} value="" onChange={(event) => {
                  const mode = event.target.value as "default" | "choose";
                  if (mode) void openExternal(mode);
                }}>
                  <option value="" disabled>{t(resource.localOriginal ? "chatWorkPanel.image.openWith" : "chatWorkPanel.image.downloadOpen")}</option>
                  <option value="default">{t("chatWorkPanel.image.openDefault")}</option>
                  <option value="choose">{t("chatWorkPanel.image.openOther")}</option>
                </select>
              </span>
              <button type="button" className="work-panel-image-edit-button" disabled={editDisabled || !current} onClick={() => onEditingChange(true)}>
                <EditOutlined /> {t("chatWorkPanel.image.edit")}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="work-panel-image-toolbar-actions">
              <ImageToolbarButton label={t("chatWorkPanel.image.done")} className="is-return-to-preview" disabled={Boolean(aiBusy) || saveBusy} onClick={() => {
                setError("");
                onEditingChange(false);
              }}><ArrowLeftOutlined /></ImageToolbarButton>
              <ImageToolbarButton label={t("chatWorkPanel.image.undo")} disabled={historyIndex <= 0 || Boolean(aiBusy)} onClick={() => setHistoryIndex((index) => Math.max(0, index - 1))}><UndoOutlined /></ImageToolbarButton>
              <ImageToolbarButton label={t("chatWorkPanel.image.redo")} disabled={historyIndex >= history.length - 1 || Boolean(aiBusy)} onClick={() => setHistoryIndex((index) => Math.min(history.length - 1, index + 1))}><RedoOutlined /></ImageToolbarButton>
            </div>
            <div className="work-panel-image-spacer" />
            <div className="work-panel-image-toolbar-actions">
              <button type="button" onClick={() => stepZoom(-1)} aria-label={t("chatWorkPanel.image.zoomOut")}><ZoomOutOutlined /></button>
              <span className="work-panel-image-zoom-control is-compact">
                <input type="number" min={10} max={800} value={Math.round(effectiveZoom)} aria-label={t("chatWorkPanel.image.zoom")} onChange={(event) => changeZoom(Number(event.target.value))} />
                <span>%</span>
              </span>
              <button type="button" onClick={() => stepZoom(1)} aria-label={t("chatWorkPanel.image.zoomIn")}><ZoomInOutlined /></button>
              <ImageToolbarButton label={t("chatWorkPanel.image.save")} className={pixelDirty && !saveBusy && !aiBusy && !sourceConflict ? "is-primary" : ""} disabled={!pixelDirty || saveBusy || Boolean(aiBusy) || sourceConflict} onClick={() => setSaveOpen(true)}><SaveOutlined /></ImageToolbarButton>
            </div>
          </>
        )}
      </div>

      <div className="work-panel-image-body">
        {editing ? (
          <aside className="work-panel-image-editor-sidebar" role="toolbar" aria-orientation="vertical" aria-label={t("chatWorkPanel.image.photoTools")}>
            <div className="work-panel-image-editor-tool-group">
              <ImageToolButton label={t("chatWorkPanel.image.pan")} className={tool === "pan" ? "is-active" : ""} onClick={() => {
                setAdjustOpen(false);
                setTool("pan");
              }}><DragOutlined /></ImageToolButton>
              <ImageToolButton label={t("chatWorkPanel.image.selection")} className={tool === "select" && selectionPurpose === "general" ? "is-active" : ""} disabled={Boolean(aiBusy)} onClick={() => {
                setAdjustOpen(false);
                setError("");
                setSelectionPurpose("general");
                setTool("select");
              }}><BorderOutlined /></ImageToolButton>
              <ImageToolButton label={t("chatWorkPanel.image.crop")} className={tool === "crop" ? "is-active" : ""} disabled={Boolean(aiBusy)} onClick={() => {
                setAdjustOpen(false);
                setTool("crop");
              }}><ScissorOutlined /></ImageToolButton>
              {tool === "crop" && cropRect ? <ImageToolButton label={t("chatWorkPanel.image.apply")} className="is-confirm" onClick={() => void applyCrop()}><CheckOutlined /></ImageToolButton> : null}
            </div>
            <div className="work-panel-image-editor-tool-group is-secondary">
              <Popover
                trigger={["hover", "focus"]}
                placement="rightTop"
                mouseEnterDelay={0.15}
                classNames={{ root: "work-panel-image-transform-popover" }}
                content={(
                  <div className="work-panel-image-transform-flyout" role="menu" aria-label={t("chatWorkPanel.image.transform")}>
                    <strong>{t("chatWorkPanel.image.transform")}</strong>
                    <button type="button" role="menuitem" disabled={Boolean(aiBusy)} onClick={() => void transform("rotate")}><RotateRightOutlined /> {t("chatWorkPanel.image.rotate")}</button>
                    <button type="button" role="menuitem" disabled={Boolean(aiBusy)} onClick={() => void transform("flip-x")}><span aria-hidden="true">↔</span> {t("chatWorkPanel.image.flipHorizontal")}</button>
                    <button type="button" role="menuitem" disabled={Boolean(aiBusy)} onClick={() => void transform("flip-y")}><span aria-hidden="true">↕</span> {t("chatWorkPanel.image.flipVertical")}</button>
                    <button type="button" role="menuitem" disabled={Boolean(aiBusy)} onClick={() => void beginSelectionTransform()}><ExpandOutlined /> {t("chatWorkPanel.image.freeTransform")}</button>
                  </div>
                )}
              >
                <span className="work-panel-image-tool-tooltip-anchor">
                  <button type="button" aria-label={t("chatWorkPanel.image.transform")} aria-haspopup="menu" disabled={Boolean(aiBusy)}><RotateRightOutlined /></button>
                </span>
              </Popover>
              <ImageToolButton label={t("chatWorkPanel.image.lockAspect")} className={resizeAspectLocked ? "is-active" : ""} disabled={Boolean(aiBusy)} aria-pressed={resizeAspectLocked} onClick={() => setResizeAspectLocked((value) => !value)}><LinkOutlined /></ImageToolButton>
              <ImageToolButton label={t("chatWorkPanel.image.resize")} disabled={Boolean(aiBusy)} onClick={() => void resizeImage()}><CompressOutlined /></ImageToolButton>
              <ImageToolButton label={t("chatWorkPanel.image.canvasSize")} className={canvasSizeOpen ? "is-active" : ""} disabled={Boolean(aiBusy)} onClick={() => {
                setAdjustOpen(false);
                setAiPromptOperation(null);
                discardSelectionTransform();
                setTool("pan");
                if (current) setCanvasTargetSize({ width: current.width, height: current.height });
                setCanvasSizeOpen((value) => !value);
              }}><FullscreenOutlined /></ImageToolButton>
              <ImageToolButton label={t("chatWorkPanel.image.adjust")} className={adjustOpen ? "is-active" : ""} disabled={Boolean(aiBusy)} onClick={() => {
                setAiPromptOperation(null);
                setCanvasSizeOpen(false);
                discardSelectionTransform();
                setTool("pan");
                setAdjustOpen((value) => !value);
              }}><ControlOutlined /></ImageToolButton>

              <ImageToolButton label={t("chatWorkPanel.image.annotate")} className={tool === "annotate" ? "is-ai-tool is-active" : "is-ai-tool"} disabled={Boolean(aiBusy)} onClick={() => {
                setAdjustOpen(false);
                setCanvasSizeOpen(false);
                discardSelectionTransform();
                setAiPromptOperation(null);
                setError("");
                setTool("annotate");
              }}><HighlightOutlined /></ImageToolButton>
              <ImageToolButton label={t("chatWorkPanel.image.removeObject")} className={tool === "select" && selectionPurpose === "removeObject" ? "is-ai-tool is-active" : "is-ai-tool"} disabled={Boolean(aiBusy)} onClick={() => {
                setAdjustOpen(false);
                setCanvasSizeOpen(false);
                discardSelectionTransform();
                setAiPromptOperation(null);
                setError("");
                setSelectionPurpose("removeObject");
                if (hasSelection) {
                  void runAi("removeObject");
                  return;
                }
                setSelectionMode("add");
                setTool("select");
              }}><EditOutlined /></ImageToolButton>
              <ImageToolButton label={t("chatWorkPanel.image.removeBackground")} className="is-ai-tool" disabled={Boolean(aiBusy)} onClick={() => {
                setCanvasSizeOpen(false);
                discardSelectionTransform();
                void runAi("removeBackground");
              }}><BgColorsOutlined /></ImageToolButton>
              <ImageToolButton label={t("chatWorkPanel.image.replaceBackground")} className={aiPromptOperation === "replaceBackground" ? "is-ai-tool is-active" : "is-ai-tool"} aria-pressed={aiPromptOperation === "replaceBackground"} disabled={Boolean(aiBusy)} onClick={() => {
                setAdjustOpen(false);
                setCanvasSizeOpen(false);
                discardSelectionTransform();
                setTool("pan");
                setError("");
                setAiPromptOperation((value) => value === "replaceBackground" ? null : "replaceBackground");
              }}><PictureOutlined /></ImageToolButton>
              <ImageToolButton label={t("chatWorkPanel.image.outpaint")} className={aiPromptOperation === "outpaint" ? "is-ai-tool is-active" : "is-ai-tool"} aria-pressed={aiPromptOperation === "outpaint"} disabled={Boolean(aiBusy)} onClick={() => {
                setAdjustOpen(false);
                setCanvasSizeOpen(false);
                discardSelectionTransform();
                setTool("pan");
                setError("");
                if (current) setAiTargetSize({ width: current.width, height: current.height });
                setAiPromptOperation((value) => value === "outpaint" ? null : "outpaint");
              }}><ExpandOutlined /></ImageToolButton>
              <ImageToolButton label={t("chatWorkPanel.image.enhance")} className="is-ai-tool" disabled={Boolean(aiBusy)} onClick={() => {
                setCanvasSizeOpen(false);
                discardSelectionTransform();
                void runAi("enhance");
              }}><ControlOutlined /></ImageToolButton>
            </div>
          </aside>
        ) : null}
        <div ref={contentRef} className="work-panel-image-content">

      {editing && (tool === "select" || adjustOpen || canvasSizeOpen || selectionTransform || aiPromptOperation) ? (
        <div
          ref={floatingControlsRef}
          className="work-panel-image-floating-controls"
          style={floatingControlsPosition ? { left: floatingControlsPosition.x, top: floatingControlsPosition.y } : undefined}
        >
          <div
            className="work-panel-image-floating-drag-handle"
            onPointerDown={(event) => beginFloatingPanelDrag("tools", event)}
            onPointerMove={moveFloatingPanel}
            onPointerUp={endFloatingPanelDrag}
            onPointerCancel={endFloatingPanelDrag}
          >
            <DragOutlined />
            <span>{t("chatWorkPanel.image.toolSettings")}</span>
          </div>
          {tool === "select" ? (
            <div className={`work-panel-image-subtoolbar${selectionPurpose === "removeObject" ? " is-ai-selection" : ""}`}>
              <span className="work-panel-image-subtoolbar-hint"><BorderOutlined /> {t(selectionPurpose === "removeObject"
                ? "chatWorkPanel.image.removeObjectSelectionHint"
                : "chatWorkPanel.image.selectionHint")}</span>
              <select value={selectionTool} onChange={(event) => setSelectionTool(event.target.value as SelectionTool)}>
                <option value="rectangle">{t("chatWorkPanel.image.selectionRectangle")}</option>
                <option value="ellipse">{t("chatWorkPanel.image.selectionEllipse")}</option>
                <option value="lasso">{t("chatWorkPanel.image.selectionLasso")}</option>
                <option value="brush">{t("chatWorkPanel.image.selectionBrush")}</option>
              </select>
              <button type="button" className={selectionMode === "add" ? "is-active" : ""} onClick={() => setSelectionMode("add")}>{t("chatWorkPanel.image.selectionAdd")}</button>
              <button type="button" className={selectionMode === "subtract" ? "is-active" : ""} onClick={() => setSelectionMode("subtract")}>{t("chatWorkPanel.image.selectionSubtract")}</button>
              {selectionTool === "brush" ? <input type="range" min={5} max={200} value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} /> : null}
              <button type="button" onClick={invertSelection}>{t("chatWorkPanel.image.selectionInvert")}</button>
              <button type="button" onClick={clearSelection}>{t("chatWorkPanel.image.selectionClear")}</button>
              {selectionPurpose === "removeObject" ? (
                <button type="button" className="is-ai-action" disabled={!hasSelection || Boolean(aiBusy)} onClick={() => void runAi("removeObject")}>
                  <EditOutlined /> {t("chatWorkPanel.image.removeSelectedObject")}
                </button>
              ) : null}
            </div>
          ) : null}

          {adjustOpen ? (
            <div className="work-panel-image-adjustments">
              {(["exposure", "contrast", "saturation"] as const).map((key) => (
                <label key={key}>
                  <span>{t(`chatWorkPanel.image.${key}`)}</span>
                  <input type="range" min={-100} max={100} value={adjust[key]} onChange={(event) => setAdjust((value) => ({ ...value, [key]: Number(event.target.value) }))} />
                  <output>{adjust[key]}</output>
                  <button type="button" onClick={() => setAdjust((value) => ({ ...value, [key]: 0 }))}>{t("chatWorkPanel.image.reset")}</button>
                </label>
              ))}
              <button type="button" onClick={() => setAdjust({ exposure: 0, contrast: 0, saturation: 0 })}>{t("chatWorkPanel.image.resetAll")}</button>
              <button type="button" className="is-primary" onClick={() => void applyAdjustments()}>{t("chatWorkPanel.image.apply")}</button>
            </div>
          ) : null}

          {canvasSizeOpen ? (
            <section className="work-panel-image-parameter-panel" aria-label={t("chatWorkPanel.image.canvasSize")}>
              <header>
                <strong>{t("chatWorkPanel.image.canvasSize")}</strong>
                <button type="button" aria-label={t("common.close")} onClick={() => setCanvasSizeOpen(false)}>×</button>
              </header>
              <div className="work-panel-image-parameter-fields">
                <label><span>{t("chatWorkPanel.image.width")}</span><input type="number" min={1} max={8192} value={canvasTargetSize.width} onChange={(event) => setCanvasTargetSize((value) => ({ ...value, width: Number(event.target.value) }))} /></label>
                <label><span>{t("chatWorkPanel.image.height")}</span><input type="number" min={1} max={8192} value={canvasTargetSize.height} onChange={(event) => setCanvasTargetSize((value) => ({ ...value, height: Number(event.target.value) }))} /></label>
              </div>
              <div className="work-panel-image-parameter-actions">
                <button type="button" onClick={() => setCanvasSizeOpen(false)}>{t("common.cancel")}</button>
                <button type="button" className="is-primary" onClick={() => void applyCanvasSize()}>{t("chatWorkPanel.image.apply")}</button>
              </div>
            </section>
          ) : null}

          {selectionTransform ? (
            <section className="work-panel-image-parameter-panel" aria-label={t("chatWorkPanel.image.freeTransform")}>
              <header>
                <strong>{t("chatWorkPanel.image.freeTransform")}</strong>
                <button type="button" aria-label={t("common.close")} onClick={discardSelectionTransform}>×</button>
              </header>
              <div className="work-panel-image-parameter-fields is-transform">
                <label><span>{t("chatWorkPanel.image.width")}</span><input type="number" min={1} max={current?.width || 8192} value={Math.round(selectionTransform.width)} onChange={(event) => setSelectionTransform((value) => value ? { ...value, width: Math.max(1, Number(event.target.value)) } : null)} /></label>
                <label><span>{t("chatWorkPanel.image.height")}</span><input type="number" min={1} max={current?.height || 8192} value={Math.round(selectionTransform.height)} onChange={(event) => setSelectionTransform((value) => value ? { ...value, height: Math.max(1, Number(event.target.value)) } : null)} /></label>
                <label><span>{t("chatWorkPanel.image.rotation")}</span><input type="number" min={-180} max={180} value={selectionTransform.rotation} onChange={(event) => setSelectionTransform((value) => value ? { ...value, rotation: clamp(Number(event.target.value), -180, 180) } : null)} /></label>
              </div>
              <div className="work-panel-image-parameter-actions">
                <button type="button" onClick={discardSelectionTransform}>{t("common.cancel")}</button>
                <button type="button" className="is-primary" onClick={() => void applySelectionTransform()}>{t("chatWorkPanel.image.apply")}</button>
              </div>
            </section>
          ) : null}

          {aiPromptOperation ? (
            <section className="work-panel-image-ai-prompt" aria-label={aiPromptLabel}>
              <header>
                <span><ThunderboltOutlined /> <strong>{aiPromptLabel}</strong></span>
                <button type="button" aria-label={t("common.close")} onClick={() => setAiPromptOperation(null)}>×</button>
              </header>
              <label className="work-panel-image-ai-instruction">
                <span>{t("chatWorkPanel.image.aiInstruction")}</span>
                <textarea
                  value={aiInstruction}
                  maxLength={4_000}
                  placeholder={t("chatWorkPanel.image.aiInstructionPlaceholder")}
                  onChange={(event) => setAiInstruction(event.target.value)}
                />
              </label>
              {aiPromptOperation === "outpaint" ? (
                <div className="work-panel-image-parameter-fields">
                  <label><span>{t("chatWorkPanel.image.width")}</span><input type="number" min={current?.width || 1} max={8192} value={aiTargetSize.width} onChange={(event) => setAiTargetSize((value) => ({ ...value, width: Number(event.target.value) }))} /></label>
                  <label><span>{t("chatWorkPanel.image.height")}</span><input type="number" min={current?.height || 1} max={8192} value={aiTargetSize.height} onChange={(event) => setAiTargetSize((value) => ({ ...value, height: Number(event.target.value) }))} /></label>
                </div>
              ) : null}
              <div className="work-panel-image-parameter-actions">
                <button type="button" onClick={() => setAiPromptOperation(null)}>{t("common.cancel")}</button>
                <button type="button" className="is-primary" onClick={() => void runAi(aiPromptOperation)}>{aiPromptLabel}</button>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {sourceConflict ? (
        <div className="work-panel-image-conflict" role="alert">
          <span>{t("chatWorkPanel.image.sourceConflict")}</span>
          <button type="button" onClick={() => void readResource()}>{t("chatWorkPanel.image.discardReload")}</button>
          {pixelDirty ? <button type="button" onClick={() => setSaveOpen(true)}>{t("chatWorkPanel.image.keepSaveNew")}</button> : null}
        </div>
      ) : null}
      {error ? <div className="work-panel-image-error" role="alert">{error}</div> : null}
      {aiBusy ? (
        <div className="work-panel-image-ai-status">
          <span>{t("chatWorkPanel.image.aiRunning")}</span>
          <button type="button" onClick={() => void cancelAi()}>{t("chatWorkPanel.image.cancel")}</button>
        </div>
      ) : null}

      <div ref={viewportRef} className="work-panel-image-viewport" onWheel={onWheel}>
        {loading ? <div className="work-panel-image-empty">{t("common.loading")}</div> : null}
        {current ? (
          <div className="work-panel-image-stage" style={{ minWidth: current.width * effectiveZoom / 100 + 48, minHeight: current.height * effectiveZoom / 100 + 48 }}>
            <div
              className={`work-panel-image-canvas${tool === "pan" ? " is-pannable" : " is-drawing"}`}
              style={{ width: current.width * effectiveZoom / 100, height: current.height * effectiveZoom / 100 }}
              onPointerDown={pointerDown}
              onPointerMove={pointerMove}
              onPointerUp={pointerUp}
              onPointerCancel={() => {
                panRef.current = null;
                drawStartRef.current = null;
                drawPointsRef.current = [];
                setGesturePreview(null);
              }}
            >
              <img src={selectionTransform?.baseUrl || current.url} alt={resource.fileName} draggable={false} style={{ filter: imageFilter }} />
              {selectionTransform ? (
                <div
                  className="work-panel-image-selection-transform"
                  style={{
                    left: selectionTransform.x * effectiveZoom / 100,
                    top: selectionTransform.y * effectiveZoom / 100,
                    width: selectionTransform.width * effectiveZoom / 100,
                    height: selectionTransform.height * effectiveZoom / 100,
                    transform: `rotate(${selectionTransform.rotation}deg)`,
                  }}
                  onPointerDown={(event) => beginSelectionTransformDrag("move", event)}
                  onPointerMove={moveSelectionTransform}
                  onPointerUp={() => { selectionTransformDragRef.current = null; }}
                  onPointerCancel={() => { selectionTransformDragRef.current = null; }}
                >
                  <img src={selectionTransform.contentUrl} alt="" draggable={false} />
                  {(["nw", "ne", "sw", "se"] as const).map((handle) => (
                    <button
                      key={handle}
                      type="button"
                      className={`is-${handle}`}
                      aria-label={t("chatWorkPanel.image.resizeSelection")}
                      onPointerDown={(event) => beginSelectionTransformDrag(handle, event)}
                    />
                  ))}
                </div>
              ) : null}
              <canvas ref={selectionCanvasRef} className={`work-panel-image-selection-layer${selectionTransform ? " is-hidden" : ""}`} />
              {gesturePreview?.kind === "select" && gesturePreview.points.length > 0 ? (
                <svg className={`work-panel-image-selection-preview is-${selectionMode}`} viewBox={`0 0 ${current.width} ${current.height}`} preserveAspectRatio="none" aria-hidden="true">
                  {gesturePreview.shape === "rectangle" && gesturePreview.points[1] ? (() => {
                    const rect = rectFromPoints(gesturePreview.points[0], gesturePreview.points[1]);
                    return <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} />;
                  })() : null}
                  {gesturePreview.shape === "ellipse" && gesturePreview.points[1] ? (() => {
                    const rect = rectFromPoints(gesturePreview.points[0], gesturePreview.points[1]);
                    return <ellipse cx={rect.x + rect.width / 2} cy={rect.y + rect.height / 2} rx={rect.width / 2} ry={rect.height / 2} />;
                  })() : null}
                  {gesturePreview.shape === "lasso" ? <polygon points={gesturePreview.points.map((point) => `${point.x},${point.y}`).join(" ")} /> : null}
                  {gesturePreview.shape === "brush" ? <polyline points={gesturePreview.points.map((point) => `${point.x},${point.y}`).join(" ")} style={{ strokeWidth: brushSize }} /> : null}
                </svg>
              ) : null}
              {cropRect ? <div className="work-panel-image-crop-rect" style={{
                left: cropRect.x * effectiveZoom / 100,
                top: cropRect.y * effectiveZoom / 100,
                width: cropRect.width * effectiveZoom / 100,
                height: cropRect.height * effectiveZoom / 100,
              }} /> : null}
              {gesturePreview?.kind === "annotate" && gesturePreview.points[1] ? (() => {
                const rect = rectFromPoints(gesturePreview.points[0], gesturePreview.points[1]);
                return <div className="work-panel-image-annotation is-preview" style={{
                  left: rect.x * effectiveZoom / 100,
                  top: rect.y * effectiveZoom / 100,
                  width: rect.width * effectiveZoom / 100,
                  height: rect.height * effectiveZoom / 100,
                }}><span>+</span></div>;
              })() : null}
              {annotations.map((annotation) => (
                <div key={annotation.id} className="work-panel-image-annotation" style={{
                  left: annotation.rect.x * effectiveZoom / 100,
                  top: annotation.rect.y * effectiveZoom / 100,
                  width: annotation.rect.width * effectiveZoom / 100,
                  height: annotation.rect.height * effectiveZoom / 100,
                }} title={annotation.requirement}>
                  <span>{annotation.number}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {editing && (tool === "annotate" || annotations.length > 0) ? (
        <aside
          ref={annotationsPanelRef}
          className="work-panel-image-annotations"
          style={annotationsPanelPosition ? { left: annotationsPanelPosition.x, top: annotationsPanelPosition.y, right: "auto" } : undefined}
        >
          <header
            onPointerDown={(event) => beginFloatingPanelDrag("annotations", event)}
            onPointerMove={moveFloatingPanel}
            onPointerUp={endFloatingPanelDrag}
            onPointerCancel={endFloatingPanelDrag}
          >
            <strong><DragOutlined /> {t("chatWorkPanel.image.annotations")}</strong>
            <span>{t("chatWorkPanel.image.annotationCount", { count: annotations.length })}</span>
          </header>
          <p className="work-panel-image-annotation-guidance">
            <HighlightOutlined />
            <span>{annotations.length === 0
              ? t("chatWorkPanel.image.annotationEmpty")
              : t("chatWorkPanel.image.annotationHint")}</span>
          </p>
          {annotations.length > 0 ? (
            <div className="work-panel-image-annotation-list" role="list">
              {annotations.map((annotation) => (
                <button
                  key={annotation.id}
                  type="button"
                  role="listitem"
                  className={`${annotation.id === activeAnnotation?.id ? "is-active" : ""}${annotation.requirement.trim() ? "" : " is-incomplete"}`}
                  onClick={() => setActiveAnnotationId(annotation.id)}
                >
                  <span>{annotation.number}</span>
                  <span>{annotation.requirement.trim() || t("chatWorkPanel.image.annotationPlaceholder")}</span>
                </button>
              ))}
            </div>
          ) : null}
          {activeAnnotation ? (
            <label key={activeAnnotation.id} className="work-panel-image-annotation-editor">
              <span>{t("chatWorkPanel.image.annotationRequirement", { number: activeAnnotation.number })}</span>
              <textarea
                value={activeAnnotation.requirement}
                maxLength={1_000}
                autoFocus={activeAnnotation.id === activeAnnotationId}
                placeholder={t("chatWorkPanel.image.annotationPlaceholder")}
                onChange={(event) => setAnnotations((items) => items.map((item) => item.id === activeAnnotation.id ? { ...item, requirement: event.target.value } : item))}
              />
              <button type="button" onClick={() => {
                const remaining = annotations
                  .filter((annotation) => annotation.id !== activeAnnotation.id)
                  .map((annotation, index) => ({ ...annotation, number: index + 1 }));
                setAnnotations(remaining);
                setActiveAnnotationId(remaining[0]?.id || "");
              }}>{t("chatWorkPanel.image.remove")}</button>
            </label>
          ) : null}
          {annotations.length > 0 ? (
            <div className="work-panel-image-annotation-actions">
              <button type="button" className="is-primary" disabled={Boolean(aiBusy) || annotations.some((annotation) => !annotation.requirement.trim())} onClick={() => void runAi("inpaint")}>{t("chatWorkPanel.image.smartEdit")}</button>
              <button type="button" disabled={handoffBusy || annotations.some((annotation) => !annotation.requirement.trim())} onClick={() => void handoff()}>{t("chatWorkPanel.image.handoff")}</button>
            </div>
          ) : null}
        </aside>
      ) : null}
        </div>
      </div>

      {saveOpen ? (
        <div className="work-panel-image-modal-backdrop" role="presentation" onMouseDown={() => !saveBusy && setSaveOpen(false)}>
          <div className="work-panel-image-save-dialog" role="dialog" aria-modal="true" aria-label={t("chatWorkPanel.image.saveChoice")} onMouseDown={(event) => event.stopPropagation()}>
            <strong>{t("chatWorkPanel.image.saveChoice")}</strong>
            <p>{t("chatWorkPanel.image.saveChoiceDescription")}</p>
            <div className="work-panel-image-save-actions">
              <button type="button" disabled={saveBusy} onClick={() => setSaveOpen(false)}>{t("chatWorkPanel.image.cancel")}</button>
              {resource.profile === "artifact" && !sourceConflict ? (
                <button type="button" disabled={saveBusy} onClick={() => void save("overwrite")}>{t("chatWorkPanel.image.overwrite")}</button>
              ) : null}
              <button type="button" className="is-primary" disabled={saveBusy} onClick={() => void save("new-artifact")}>{t("chatWorkPanel.image.saveNew")}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
