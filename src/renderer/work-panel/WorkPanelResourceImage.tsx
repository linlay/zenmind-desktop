import {
  CheckOutlined,
  CompressOutlined,
  DragOutlined,
  EditOutlined,
  ExportOutlined,
  InfoCircleOutlined,
  LinkOutlined,
  PictureOutlined,
  RedoOutlined,
  SaveOutlined,
  ScissorOutlined,
  UndoOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from "@ant-design/icons";
import { Popover } from "antd";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
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
type Point = { x: number; y: number };

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
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const selectionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const snapshotUrlsRef = useRef(new Set<string>());
  const drawStartRef = useRef<Point | null>(null);
  const drawPointsRef = useRef<Point[]>([]);
  const panRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tool, setTool] = useState<"pan" | "crop" | "annotate" | "select">("pan");
  const [selectionTool, setSelectionTool] = useState<SelectionTool>("rectangle");
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("add");
  const [brushSize, setBrushSize] = useState(40);
  const [cropRect, setCropRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [annotations, setAnnotations] = useState<ImageRegionAnnotation[]>([]);
  const [zoom, setZoom] = useState(100);
  const [fitMode, setFitMode] = useState(true);
  const [fitZoom, setFitZoom] = useState(100);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjust, setAdjust] = useState({ exposure: 0, contrast: 0, saturation: 0 });
  const [resizeAspectLocked, setResizeAspectLocked] = useState(true);
  const [aiBusy, setAiBusy] = useState<{ requestId: string; operation: WorkPanelResourceImageAiOperation } | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [sourceConflict, setSourceConflict] = useState(false);
  const [sourceRevision, setSourceRevision] = useState(resource.revision);
  const [handoffBusy, setHandoffBusy] = useState(false);

  const current = history[historyIndex] || null;
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
      setSourceRevision(result.revision || resource.revision);
      setSourceConflict(false);
      setTool("pan");
    } catch {
      URL.revokeObjectURL(url);
    } finally {
      setLoading(false);
    }
  }, [handleRequest, resource.mimeType, resource.revision]);

  useEffect(() => {
    if (!editing) {
      setTool("pan");
      setAdjustOpen(false);
    }
  }, [editing]);

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
  }, [brushSize, selectionMode]);

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!current) return;
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
      setCropRect({
        x: Math.min(drawStartRef.current.x, point.x),
        y: Math.min(drawStartRef.current.y, point.y),
        width: Math.abs(drawStartRef.current.x - point.x),
        height: Math.abs(drawStartRef.current.y - point.y),
      });
    } else if (tool === "select") {
      drawPointsRef.current.push(point);
    }
  };

  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    panRef.current = null;
    const start = drawStartRef.current;
    if (!start) return;
    const end = pointFromEvent(event) || start;
    if (tool === "annotate" && current) {
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const width = Math.abs(start.x - end.x);
      const height = Math.abs(start.y - end.y);
      if (width >= 3 && height >= 3 && annotations.length < 50) {
        const requirement = window.prompt(t("chatWorkPanel.image.promptAnnotation"), "") ?? "";
        if (requirement.trim()) {
          setAnnotations((previous) => [...previous, {
            id: globalThis.crypto.randomUUID(),
            number: previous.length + 1,
            kind: "image-region",
            rect: { x, y, width, height },
            normalizedRect: {
              x: x / current.width,
              y: y / current.height,
              width: width / current.width,
              height: height / current.height,
            },
            requirement: requirement.trim().slice(0, 1_000),
          }]);
        }
      }
    } else if (tool === "select") {
      const points = selectionTool === "rectangle" || selectionTool === "ellipse"
        ? [start, end]
        : [...drawPointsRef.current, end];
      paintSelectionPath(points, selectionTool);
    }
    drawStartRef.current = null;
    drawPointsRef.current = [];
  };

  const clearSelection = () => {
    const canvas = selectionCanvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
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
  };

  const selectionMaskBase64 = async () => {
    const selection = selectionCanvasRef.current;
    if (!selection) return "";
    const source = selection.getContext("2d")?.getImageData(0, 0, selection.width, selection.height);
    if (!source || !source.data.some((value, index) => index % 4 === 3 && value > 0)) return "";
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
      const selected = source.data[index + 3] > 0;
      pixels.data[index] = selected ? 255 : 0;
      pixels.data[index + 1] = selected ? 255 : 0;
      pixels.data[index + 2] = selected ? 255 : 0;
      pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    return blobBase64(await canvasBlob(mask, "image/png"));
  };

  const runAi = async (operation: WorkPanelResourceImageAiOperation) => {
    if (!current || aiBusy || !requireAnnotationClear()) return;
    const maskDataBase64 = await selectionMaskBase64();
    if (operation === "removeObject" && !maskDataBase64) {
      setError(t("chatWorkPanel.image.selectionRequired"));
      return;
    }
    let prompt = "";
    let targetWidth = current.width;
    let targetHeight = current.height;
    if (operation === "replaceBackground" || operation === "outpaint") {
      prompt = window.prompt(t(operation === "replaceBackground"
        ? "chatWorkPanel.image.promptBackground"
        : "chatWorkPanel.image.promptOutpaint"), "")?.trim() || "";
      if (!prompt) return;
    }
    if (operation === "outpaint") {
      const widthText = window.prompt(t("chatWorkPanel.image.promptWidth"), String(current.width));
      if (widthText === null) return;
      const heightText = window.prompt(t("chatWorkPanel.image.promptHeight"), String(current.height));
      if (heightText === null) return;
      targetWidth = Math.round(Number(widthText));
      targetHeight = Math.round(Number(heightText));
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

  return (
    <div
      ref={rootRef}
      className={`work-panel-resource-image${editing ? " is-editing" : ""}`}
      data-native-image-dirty={dirty ? "true" : "false"}
      data-native-image-saving={saveBusy ? "true" : "false"}
      data-native-image-ai-busy={aiBusy ? "true" : "false"}
      tabIndex={0}
    >
      <div className="work-panel-image-toolbar" role="toolbar" aria-label={t("chatWorkPanel.image.toolbar")}>
        {!editing ? (
          <>
            <div className="work-panel-image-file" title={resource.fileName}>
              <PictureOutlined aria-hidden="true" />
              <span className="work-panel-image-file-name">{resource.fileName}</span>
              <span className="work-panel-image-file-meta">{imageFormat(resource.mimeType)} · {formatBytes(resource.sizeBytes)}</span>
              <span className="work-panel-image-file-size">{current ? `${current.width} × ${current.height}` : "—"}</span>
            </div>
            <Popover
              trigger="click"
              title={t("chatWorkPanel.image.info")}
              content={(
                <div className="work-panel-image-info-content">
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
            <button type="button" className="is-primary" disabled={editDisabled || !current} onClick={() => onEditingChange(true)}>
              <EditOutlined /> {t("chatWorkPanel.image.edit")}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="is-primary" disabled={Boolean(aiBusy) || saveBusy} onClick={() => onEditingChange(false)}><CheckOutlined /> {t("chatWorkPanel.image.done")}</button>
            <button type="button" disabled={historyIndex <= 0 || Boolean(aiBusy)} onClick={() => setHistoryIndex((index) => Math.max(0, index - 1))}><UndoOutlined /></button>
            <button type="button" disabled={historyIndex >= history.length - 1 || Boolean(aiBusy)} onClick={() => setHistoryIndex((index) => Math.min(history.length - 1, index + 1))}><RedoOutlined /></button>
            <span className="work-panel-image-separator" />
            <button type="button" className={tool === "pan" ? "is-active" : ""} onClick={() => setTool("pan")}><DragOutlined /> {t("chatWorkPanel.image.pan")}</button>
            <button type="button" className={tool === "annotate" ? "is-active" : ""} disabled={Boolean(aiBusy)} onClick={() => setTool("annotate")}>{t("chatWorkPanel.image.annotate")}</button>
            <button type="button" className={tool === "crop" ? "is-active" : ""} disabled={Boolean(aiBusy)} onClick={() => setTool("crop")}><ScissorOutlined /> {t("chatWorkPanel.image.crop")}</button>
            {tool === "crop" && cropRect ? <button type="button" onClick={() => void applyCrop()}>{t("chatWorkPanel.image.apply")}</button> : null}
            <button type="button" disabled={Boolean(aiBusy)} onClick={() => void transform("rotate")}>{t("chatWorkPanel.image.rotate")}</button>
            <button type="button" disabled={Boolean(aiBusy)} onClick={() => void transform("flip-x")}>{t("chatWorkPanel.image.flipHorizontal")}</button>
            <button type="button" disabled={Boolean(aiBusy)} onClick={() => void transform("flip-y")}>{t("chatWorkPanel.image.flipVertical")}</button>
            <button type="button" className={resizeAspectLocked ? "is-active" : ""} disabled={Boolean(aiBusy)} aria-pressed={resizeAspectLocked} onClick={() => setResizeAspectLocked((value) => !value)}><LinkOutlined /> {t("chatWorkPanel.image.lockAspect")}</button>
            <button type="button" disabled={Boolean(aiBusy)} onClick={() => void resizeImage()}><CompressOutlined /> {t("chatWorkPanel.image.resize")}</button>
            <button type="button" className={adjustOpen ? "is-active" : ""} disabled={Boolean(aiBusy)} onClick={() => setAdjustOpen((value) => !value)}>{t("chatWorkPanel.image.adjust")}</button>
            <button type="button" className={tool === "select" ? "is-active" : ""} disabled={Boolean(aiBusy)} onClick={() => setTool("select")}>{t("chatWorkPanel.image.selection")}</button>
            <div className="work-panel-image-more">
              <select aria-label={t("chatWorkPanel.image.aiTools")} disabled={Boolean(aiBusy)} defaultValue="" onChange={(event) => {
                const operation = event.target.value as WorkPanelResourceImageAiOperation;
                event.target.value = "";
                if (operation) void runAi(operation);
              }}>
                <option value="" disabled>{t("chatWorkPanel.image.photoTools")}</option>
                <option value="removeObject">{t("chatWorkPanel.image.removeObject")}</option>
                <option value="removeBackground">{t("chatWorkPanel.image.removeBackground")}</option>
                <option value="replaceBackground">{t("chatWorkPanel.image.replaceBackground")}</option>
                <option value="outpaint">{t("chatWorkPanel.image.outpaint")}</option>
                <option value="enhance">{t("chatWorkPanel.image.enhance")}</option>
              </select>
            </div>
            <div className="work-panel-image-spacer" />
            <button type="button" onClick={() => stepZoom(-1)}><ZoomOutOutlined /></button>
            <span className="work-panel-image-zoom-control is-compact">
              <input type="number" min={10} max={800} value={Math.round(effectiveZoom)} onChange={(event) => changeZoom(Number(event.target.value))} />
              <span>%</span>
            </span>
            <button type="button" onClick={() => stepZoom(1)}><ZoomInOutlined /></button>
            <span className="work-panel-image-open-with">
              <ExportOutlined aria-hidden="true" />
              <select aria-label={t("chatWorkPanel.image.openWith")} disabled={Boolean(aiBusy) || saveBusy} value="" onChange={(event) => {
                const mode = event.target.value as "default" | "choose";
                if (mode) void openExternal(mode);
              }}>
                <option value="" disabled>{t(resource.localOriginal ? "chatWorkPanel.image.openWith" : "chatWorkPanel.image.downloadOpen")}</option>
                <option value="default">{t("chatWorkPanel.image.openDefault")}</option>
                <option value="choose">{t("chatWorkPanel.image.openOther")}</option>
              </select>
            </span>
            <button type="button" className="is-primary" disabled={!pixelDirty || saveBusy || Boolean(aiBusy) || sourceConflict} onClick={() => setSaveOpen(true)}><SaveOutlined /> {t("chatWorkPanel.image.save")}</button>
          </>
        )}
      </div>

      {editing && tool === "select" ? (
        <div className="work-panel-image-subtoolbar">
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
        </div>
      ) : null}

      {editing && adjustOpen ? (
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
              onPointerCancel={() => { panRef.current = null; drawStartRef.current = null; }}
            >
              <img src={current.url} alt={resource.fileName} draggable={false} style={{ filter: imageFilter }} />
              <canvas ref={selectionCanvasRef} className="work-panel-image-selection-layer" />
              {cropRect ? <div className="work-panel-image-crop-rect" style={{
                left: cropRect.x * effectiveZoom / 100,
                top: cropRect.y * effectiveZoom / 100,
                width: cropRect.width * effectiveZoom / 100,
                height: cropRect.height * effectiveZoom / 100,
              }} /> : null}
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

      {editing && annotations.length > 0 ? (
        <aside className="work-panel-image-annotations">
          <strong>{t("chatWorkPanel.image.annotations")}</strong>
          {annotations.map((annotation) => (
            <label key={annotation.id}>
              <span>{annotation.number}</span>
              <textarea value={annotation.requirement} maxLength={1_000} onChange={(event) => setAnnotations((items) => items.map((item) => item.id === annotation.id ? { ...item, requirement: event.target.value } : item))} />
              <button type="button" onClick={() => setAnnotations((items) => items.filter((item) => item.id !== annotation.id).map((item, index) => ({ ...item, number: index + 1 })))}>{t("chatWorkPanel.image.remove")}</button>
            </label>
          ))}
          <button type="button" className="is-primary" disabled={handoffBusy} onClick={() => void handoff()}>{t("chatWorkPanel.image.handoff")}</button>
        </aside>
      ) : null}

      {saveOpen ? (
        <div className="work-panel-image-modal-backdrop" role="presentation" onMouseDown={() => !saveBusy && setSaveOpen(false)}>
          <div className="work-panel-image-save-dialog" role="dialog" aria-modal="true" aria-label={t("chatWorkPanel.image.saveChoice")} onMouseDown={(event) => event.stopPropagation()}>
            <strong>{t("chatWorkPanel.image.saveChoice")}</strong>
            <p>{t("chatWorkPanel.image.saveChoiceDescription")}</p>
            {resource.profile === "artifact" && !sourceConflict ? (
              <button type="button" disabled={saveBusy} onClick={() => void save("overwrite")}>{t("chatWorkPanel.image.overwrite")}</button>
            ) : null}
            <button type="button" className="is-primary" disabled={saveBusy} onClick={() => void save("new-artifact")}>{t("chatWorkPanel.image.saveNew")}</button>
            <button type="button" disabled={saveBusy} onClick={() => setSaveOpen(false)}>{t("chatWorkPanel.image.cancel")}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
