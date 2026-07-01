"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Circle, MousePointer2, Pencil, Redo2, Send, Shapes, Square, Undo2, X } from "lucide-react";

const colors = ["#111827", "#FF3B63", "#FF8A00", "#FFC400", "#22C55E", "#14B8A6", "#3F7CF5", "#7C3AED"];
const widths = [2, 4, 8, 12];
const fontSizes = [18, 24, 32, 48];

type Point = { x: number; y: number };
type ShapeTool = "rectangle" | "ellipse" | "arrow" | "filledRectangle" | "filledEllipse";
type Tool = "select" | "text" | "brush" | ShapeTool;
type Transform = { rotation: number; scaleX: number; scaleY: number; tx: number; ty: number };
type AnnotationBase = Transform & { color: string; id: string; width: number };
type Annotation =
  | (AnnotationBase & { points: Point[]; type: "brush" })
  | (AnnotationBase & { end: Point; start: Point; type: ShapeTool })
  | (AnnotationBase & {
      fontSize: number;
      point: Point;
      text: string;
      textMetrics?: { ascent: number; descent: number; left: number; right: number };
      type: "text";
    });
type Bounds = { height: number; width: number; x: number; y: number };
type HandleAction =
  | { mode: "move" }
  | { mode: "rotate" }
  | { mode: "resize"; x: -1 | 0 | 1; y: -1 | 0 | 1 };
type TransformInteraction = {
  annotationId: string;
  action: HandleAction;
  anchor: Point;
  center: Point;
  initialAnnotations: Annotation[];
  initialPoint: Point;
  initialRotation: number;
  initialScaleX: number;
  initialScaleY: number;
  initialTx: number;
  initialTy: number;
};

const rotateCursor = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'%3E%3Cpath d='M20.5 8.2A8 8 0 1 0 22 17' fill='none' stroke='%23111827' stroke-width='2' stroke-linecap='round'/%3E%3Cpath d='m18 4 3 4.5-5 .8' fill='none' stroke='%23111827' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\") 14 14, grab";

function makeTransform(): Transform {
  return { rotation: 0, scaleX: 1, scaleY: 1, tx: 0, ty: 0 };
}

function getBounds(annotation: Annotation): Bounds {
  if (annotation.type === "text") {
    const fallbackWidth = Array.from(annotation.text).reduce((width, character) => (
      width + (/[^\u0000-\u00ff]/.test(character) ? annotation.fontSize : annotation.fontSize * 0.62)
    ), 0);
    const left = annotation.textMetrics?.left ?? 0;
    const right = annotation.textMetrics?.right ?? Math.max(annotation.fontSize, fallbackWidth);
    const ascent = annotation.textMetrics?.ascent ?? annotation.fontSize;
    const descent = annotation.textMetrics?.descent ?? annotation.fontSize * 0.3;
    const padding = annotation.fontSize * 0.1;
    return {
      height: ascent + descent + padding * 2,
      width: left + right + padding * 2,
      x: annotation.point.x - left - padding,
      y: annotation.point.y - ascent - padding
    };
  }
  if (annotation.type === "brush") {
    const xs = annotation.points.map((point) => point.x);
    const ys = annotation.points.map((point) => point.y);
    const padding = Math.max(annotation.width, 8);
    return {
      height: Math.max(1, Math.max(...ys) - Math.min(...ys)) + padding * 2,
      width: Math.max(1, Math.max(...xs) - Math.min(...xs)) + padding * 2,
      x: Math.min(...xs) - padding,
      y: Math.min(...ys) - padding
    };
  }
  return {
    height: Math.max(1, Math.abs(annotation.end.y - annotation.start.y)),
    width: Math.max(1, Math.abs(annotation.end.x - annotation.start.x)),
    x: Math.min(annotation.start.x, annotation.end.x),
    y: Math.min(annotation.start.y, annotation.end.y)
  };
}

function getCenter(annotation: Annotation) {
  const bounds = getBounds(annotation);
  return { x: bounds.x + bounds.width / 2 + annotation.tx, y: bounds.y + bounds.height / 2 + annotation.ty };
}

function rotateVector(point: Point, angle: number) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}

function transformPoint(point: Point, annotation: Annotation) {
  const bounds = getBounds(annotation);
  const baseCenter = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const dx = (point.x - baseCenter.x) * annotation.scaleX;
  const dy = (point.y - baseCenter.y) * annotation.scaleY;
  const cos = Math.cos(annotation.rotation);
  const sin = Math.sin(annotation.rotation);
  return {
    x: baseCenter.x + annotation.tx + dx * cos - dy * sin,
    y: baseCenter.y + annotation.ty + dx * sin + dy * cos
  };
}

function inverseTransformPoint(point: Point, annotation: Annotation) {
  const bounds = getBounds(annotation);
  const baseCenter = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const dx = point.x - baseCenter.x - annotation.tx;
  const dy = point.y - baseCenter.y - annotation.ty;
  const cos = Math.cos(-annotation.rotation);
  const sin = Math.sin(-annotation.rotation);
  return {
    x: baseCenter.x + (dx * cos - dy * sin) / annotation.scaleX,
    y: baseCenter.y + (dx * sin + dy * cos) / annotation.scaleY
  };
}

function distanceToSegment(point: Point, start: Point, end: Point) {
  const lengthSquared = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y)) / lengthSquared));
  return Math.hypot(point.x - (start.x + t * (end.x - start.x)), point.y - (start.y + t * (end.y - start.y)));
}

function hitAnnotation(point: Point, annotation: Annotation, screenUnit = 1) {
  const local = inverseTransformPoint(point, annotation);
  const bounds = getBounds(annotation);
  const hitWidth = Math.max(screenUnit * 14, annotation.width * 2);
  if (annotation.type === "brush") {
    return annotation.points.some((item, index) => index > 0 && distanceToSegment(local, annotation.points[index - 1], item) <= hitWidth);
  }
  if (annotation.type === "arrow") return distanceToSegment(local, annotation.start, annotation.end) <= hitWidth;
  const padding = screenUnit * 10;
  return local.x >= bounds.x - padding && local.x <= bounds.x + bounds.width + padding && local.y >= bounds.y - padding && local.y <= bounds.y + bounds.height + padding;
}

function applyTransform(context: CanvasRenderingContext2D, annotation: Annotation) {
  const bounds = getBounds(annotation);
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  context.translate(center.x + annotation.tx, center.y + annotation.ty);
  context.rotate(annotation.rotation);
  context.scale(annotation.scaleX, annotation.scaleY);
  context.translate(-center.x, -center.y);
}

function drawAnnotation(context: CanvasRenderingContext2D, annotation: Annotation) {
  context.save();
  applyTransform(context, annotation);
  context.strokeStyle = annotation.color;
  context.fillStyle = annotation.color;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = annotation.width;

  if (annotation.type === "text") {
    context.font = `600 ${annotation.fontSize}px Inter, "PingFang SC", sans-serif`;
    context.textBaseline = "alphabetic";
    context.fillText(annotation.text, annotation.point.x, annotation.point.y);
    return context.restore();
  }

  if (annotation.type === "brush") {
    if (!annotation.points.length) return context.restore();
    context.beginPath();
    context.moveTo(annotation.points[0].x, annotation.points[0].y);
    annotation.points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
    if (annotation.points.length === 1) context.lineTo(annotation.points[0].x + 0.01, annotation.points[0].y + 0.01);
    context.stroke();
    return context.restore();
  }

  const x = Math.min(annotation.start.x, annotation.end.x);
  const y = Math.min(annotation.start.y, annotation.end.y);
  const width = Math.abs(annotation.end.x - annotation.start.x);
  const height = Math.abs(annotation.end.y - annotation.start.y);
  context.beginPath();
  if (annotation.type === "rectangle") context.strokeRect(x, y, width, height);
  else if (annotation.type === "filledRectangle") context.fillRect(x, y, width, height);
  else if (annotation.type === "ellipse" || annotation.type === "filledEllipse") {
    context.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    if (annotation.type === "filledEllipse") context.fill();
    else context.stroke();
  } else {
    const dx = annotation.end.x - annotation.start.x;
    const dy = annotation.end.y - annotation.start.y;
    const angle = Math.atan2(dy, dx);
    const head = Math.max(12, annotation.width * 4);
    context.moveTo(annotation.start.x, annotation.start.y);
    context.lineTo(annotation.end.x, annotation.end.y);
    context.lineTo(annotation.end.x - head * Math.cos(angle - Math.PI / 6), annotation.end.y - head * Math.sin(angle - Math.PI / 6));
    context.moveTo(annotation.end.x, annotation.end.y);
    context.lineTo(annotation.end.x - head * Math.cos(angle + Math.PI / 6), annotation.end.y - head * Math.sin(angle + Math.PI / 6));
    context.stroke();
  }
  context.restore();
}

function drawSelection(context: CanvasRenderingContext2D, annotation: Annotation, unit: number) {
  const bounds = getBounds(annotation);
  const cornerHandles = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height }
  ];
  context.save();
  applyTransform(context, annotation);
  context.strokeStyle = "#6C63FF";
  context.fillStyle = "#FFFFFF";
  const averageScale = (Math.abs(annotation.scaleX) + Math.abs(annotation.scaleY)) / 2;
  context.lineWidth = unit * 1.5 / averageScale;
  context.setLineDash([unit * 5 / averageScale, unit * 3 / averageScale]);
  context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  context.setLineDash([]);
  cornerHandles.forEach((point) => {
    context.beginPath();
    context.rect(point.x - unit * 4 / annotation.scaleX, point.y - unit * 4 / annotation.scaleY, unit * 8 / annotation.scaleX, unit * 8 / annotation.scaleY);
    context.fill();
    context.stroke();
  });
  const edgeHandles = [
    { x: bounds.x + bounds.width / 2, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 },
    { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height / 2 }
  ];
  context.fillStyle = "#6C63FF";
  edgeHandles.forEach((point) => {
    context.beginPath();
    context.roundRect(point.x - unit * 5 / annotation.scaleX, point.y - unit * 3.5 / annotation.scaleY, unit * 10 / annotation.scaleX, unit * 7 / annotation.scaleY, unit * 3 / averageScale);
    context.fill();
  });
  context.fillStyle = "#FFFFFF";
  const rotationPoint = { x: bounds.x + bounds.width / 2, y: bounds.y - unit * 24 / annotation.scaleY };
  context.beginPath();
  context.moveTo(bounds.x + bounds.width / 2, bounds.y);
  context.lineTo(rotationPoint.x, rotationPoint.y);
  context.stroke();
  context.beginPath();
  context.arc(rotationPoint.x, rotationPoint.y, unit * 5 / averageScale, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.restore();
}

function getDrawableUrl(imageUrl: string) {
  if (!/^https?:\/\//.test(imageUrl)) return imageUrl;
  return `/api/canvas/image-download?url=${encodeURIComponent(imageUrl)}&filename=annotation-source.png`;
}

function getImageLoadSources(imageUrl: string) {
  const drawableUrl = getDrawableUrl(imageUrl);
  return drawableUrl === imageUrl ? [imageUrl] : [drawableUrl, imageUrl];
}

function makeId() {
  return `annotation-${Date.now()}-${Math.round(Math.random() * 10000)}`;
}

export function ImageAnnotationEditor({ imageUrl, onClose, onSend }: { imageUrl: string; onClose: () => void; onSend: (imageUrl: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ pointerX: number; pointerY: number; x: number; y: number } | null>(null);
  const drawingRef = useRef<Annotation | null>(null);
  const transformRef = useRef<TransformInteraction | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [undoStack, setUndoStack] = useState<Annotation[][]>([]);
  const [redoStack, setRedoStack] = useState<Annotation[][]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [color, setColor] = useState(colors[0]);
  const [lineWidth, setLineWidth] = useState(4);
  const [fontSize, setFontSize] = useState(32);
  const [tool, setTool] = useState<Tool>("select");
  const [canvasCursor, setCanvasCursor] = useState("default");
  const [toolMenu, setToolMenu] = useState<"brush" | "shape" | "text" | null>(null);
  const [textDraft, setTextDraft] = useState<{ canvasPoint: Point; left: number; top: number; value: string } | null>(null);
  const [imageReady, setImageReady] = useState(false);
  const [exportReady, setExportReady] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [imageLoading, setImageLoading] = useState(true);
  const [imageRevision, setImageRevision] = useState(0);
  const [position, setPosition] = useState(() => {
    if (typeof window === "undefined") return { x: 24, y: 64 };
    return { x: Math.max(24, (window.innerWidth - Math.min(1120, window.innerWidth - 48)) / 2), y: 64 };
  });

  const panelSize = useMemo(() => ({
    height: typeof window === "undefined" ? 720 : Math.max(420, Math.min(820, window.innerHeight - 96)),
    width: typeof window === "undefined" ? 960 : Math.max(640, Math.min(1120, window.innerWidth - 48))
  }), []);

  const redraw = useCallback((options?: { current?: Annotation | null; showSelection?: boolean }) => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image || !imageReady) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    annotations.forEach((annotation) => drawAnnotation(context, annotation));
    if (options?.current) drawAnnotation(context, options.current);
    const selected = annotations.find((annotation) => annotation.id === selectedId);
    if (options?.showSelection !== false && selected) {
      const bounds = canvas.getBoundingClientRect();
      drawSelection(context, selected, canvas.width / Math.max(1, bounds.width));
    }
  }, [annotations, imageReady, selectedId]);

  useEffect(() => {
    let cancelled = false;
    let activeImage: HTMLImageElement | null = null;
    const showImage = (image: HTMLImageElement, canExport: boolean) => {
      if (cancelled) return;
      imageRef.current = image;
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      setImageError(false);
      setImageLoading(false);
      setImageReady(true);
      setExportReady(canExport);
      setImageRevision((revision) => revision + 1);
    };

    setImageLoading(true);
    setImageReady(false);
    setExportReady(false);
    setImageError(false);

    const loadSources = getImageLoadSources(imageUrl);
    const loadImage = (sourceIndex: number) => {
      const source = loadSources[sourceIndex];
      if (!source) {
        if (!cancelled) {
          setImageLoading(false);
          setImageError(true);
        }
        return;
      }
      const image = new Image();
      activeImage = image;
      image.onload = () => showImage(image, source === getDrawableUrl(imageUrl));
      image.onerror = () => {
        if (cancelled) return;
        loadImage(sourceIndex + 1);
      };
      image.src = source;
    };

    loadImage(0);
    return () => {
      cancelled = true;
      if (activeImage) {
        activeImage.onload = null;
        activeImage.onerror = null;
      }
    };
  }, [imageUrl]);

  useEffect(() => {
    redraw({ current: drawingRef.current });
  }, [imageRevision, redraw]);

  useLayoutEffect(() => {
    if (!textDraft) return;
    const focusInput = () => {
      const input = textInputRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    };
    focusInput();
    const frame = window.requestAnimationFrame(focusInput);
    return () => window.cancelAnimationFrame(frame);
  }, [textDraft]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!dragRef.current) return;
      const dx = event.clientX - dragRef.current.pointerX;
      const dy = event.clientY - dragRef.current.pointerY;
      setPosition({
        x: Math.min(window.innerWidth - panelSize.width - 16, Math.max(16, dragRef.current.x + dx)),
        y: Math.min(window.innerHeight - 56, Math.max(16, dragRef.current.y + dy))
      });
    };
    const stop = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [panelSize.width]);

  useEffect(() => {
    if (!selectedId || textDraft) return undefined;
    const deleteSelectedAnnotation = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']")) return;
      if (!annotations.some((annotation) => annotation.id === selectedId)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setUndoStack((stack) => [...stack, annotations]);
      setAnnotations(annotations.filter((annotation) => annotation.id !== selectedId));
      setRedoStack([]);
      setSelectedId(null);
    };
    window.addEventListener("keydown", deleteSelectedAnnotation, true);
    return () => window.removeEventListener("keydown", deleteSelectedAnnotation, true);
  }, [annotations, selectedId, textDraft]);

  const commitAnnotations = (next: Annotation[]) => {
    setUndoStack((stack) => [...stack, annotations]);
    setAnnotations(next);
    setRedoStack([]);
  };

  const getPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const bounds = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) * (canvas.width / bounds.width),
      y: (event.clientY - bounds.top) * (canvas.height / bounds.height)
    };
  };

  const getScreenUnit = () => {
    const canvas = canvasRef.current;
    return canvas ? canvas.width / Math.max(1, canvas.getBoundingClientRect().width) : 1;
  };

  const getHandleAction = (point: Point, annotation: Annotation): HandleAction => {
    const bounds = getBounds(annotation);
    const corners = [
      { point: transformPoint({ x: bounds.x, y: bounds.y }, annotation), x: -1 as const, y: -1 as const },
      { point: transformPoint({ x: bounds.x + bounds.width, y: bounds.y }, annotation), x: 1 as const, y: -1 as const },
      { point: transformPoint({ x: bounds.x + bounds.width, y: bounds.y + bounds.height }, annotation), x: 1 as const, y: 1 as const },
      { point: transformPoint({ x: bounds.x, y: bounds.y + bounds.height }, annotation), x: -1 as const, y: 1 as const }
    ];
    const edges = [
      { point: transformPoint({ x: bounds.x + bounds.width / 2, y: bounds.y }, annotation), x: 0 as const, y: -1 as const },
      { point: transformPoint({ x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 }, annotation), x: 1 as const, y: 0 as const },
      { point: transformPoint({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height }, annotation), x: 0 as const, y: 1 as const },
      { point: transformPoint({ x: bounds.x, y: bounds.y + bounds.height / 2 }, annotation), x: -1 as const, y: 0 as const }
    ];
    const canvas = canvasRef.current;
    const screenUnit = canvas ? canvas.width / Math.max(1, canvas.getBoundingClientRect().width) : 1;
    const corner = corners.find((handle) => Math.hypot(point.x - handle.point.x, point.y - handle.point.y) <= screenUnit * 12);
    if (corner) return { mode: "resize", x: corner.x, y: corner.y };
    const edge = edges.find((handle) => Math.hypot(point.x - handle.point.x, point.y - handle.point.y) <= screenUnit * 12);
    if (edge) return { mode: "resize", x: edge.x, y: edge.y };
    const rotationPoint = transformPoint({ x: bounds.x + bounds.width / 2, y: bounds.y - screenUnit * 24 / annotation.scaleY }, annotation);
    if (Math.hypot(point.x - rotationPoint.x, point.y - rotationPoint.y) <= screenUnit * 14) return { mode: "rotate" };
    return { mode: "move" };
  };

  const getCursor = (action: HandleAction, rotation: number) => {
    if (action.mode === "move") return "move";
    if (action.mode === "rotate") return rotateCursor;
    const angle = Math.atan2(action.y, action.x) + rotation;
    const direction = ((Math.round(angle / (Math.PI / 4)) % 4) + 4) % 4;
    return ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"][direction];
  };

  const startDrawing = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!imageReady || event.button !== 0) return;
    const point = getPoint(event);

    if (tool === "select") {
      const currentSelected = annotations.find((annotation) => annotation.id === selectedId);
      const currentAction = currentSelected ? getHandleAction(point, currentSelected) : null;
      const screenUnit = getScreenUnit();
      const target = currentSelected && (currentAction?.mode !== "move" || hitAnnotation(point, currentSelected, screenUnit))
        ? currentSelected
        : [...annotations].reverse().find((annotation) => hitAnnotation(point, annotation, screenUnit));
      if (!target) {
        setSelectedId(null);
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      setSelectedId(target.id);
      const action = getHandleAction(point, target);
      const center = getCenter(target);
      const bounds = getBounds(target);
      const anchorLocal = action.mode === "resize"
        ? {
            x: bounds.x + bounds.width / 2 - action.x * bounds.width / 2,
            y: bounds.y + bounds.height / 2 - action.y * bounds.height / 2
          }
        : { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      transformRef.current = {
        action,
        annotationId: target.id,
        anchor: transformPoint(anchorLocal, target),
        center,
        initialAnnotations: annotations,
        initialPoint: point,
        initialRotation: target.rotation,
        initialScaleX: target.scaleX,
        initialScaleY: target.scaleY,
        initialTx: target.tx,
        initialTy: target.ty
      };
      return;
    }

    if (tool === "text") {
      event.preventDefault();
      event.stopPropagation();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const containerBounds = canvas.parentElement?.getBoundingClientRect() ?? canvas.getBoundingClientRect();
      const screenUnit = getScreenUnit();
      setTextDraft({
        canvasPoint: { x: point.x, y: point.y + fontSize * screenUnit },
        left: event.clientX - containerBounds.left,
        top: event.clientY - containerBounds.top,
        value: ""
      });
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    const screenUnit = getScreenUnit();
    drawingRef.current = tool === "brush"
      ? { ...makeTransform(), color, id: makeId(), points: [point], type: "brush", width: lineWidth * screenUnit }
      : { ...makeTransform(), color, end: point, id: makeId(), start: point, type: tool, width: lineWidth * screenUnit };
    redraw({ current: drawingRef.current });
  };

  const continueDrawing = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = getPoint(event);
    const interaction = transformRef.current;
    if (interaction) {
      setAnnotations(interaction.initialAnnotations.map((annotation) => {
        if (annotation.id !== interaction.annotationId) return annotation;
        if (interaction.action.mode === "move") {
          return { ...annotation, tx: interaction.initialTx + point.x - interaction.initialPoint.x, ty: interaction.initialTy + point.y - interaction.initialPoint.y };
        }
        if (interaction.action.mode === "resize") {
          const initialVector = rotateVector({ x: interaction.initialPoint.x - interaction.anchor.x, y: interaction.initialPoint.y - interaction.anchor.y }, -interaction.initialRotation);
          const pointerVector = rotateVector({ x: point.x - interaction.anchor.x, y: point.y - interaction.anchor.y }, -interaction.initialRotation);
          let nextVector = { ...pointerVector };
          let scaleX = interaction.initialScaleX;
          let scaleY = interaction.initialScaleY;

          if (interaction.action.x && interaction.action.y) {
            const denominator = initialVector.x ** 2 + initialVector.y ** 2;
            const factor = Math.max(0.15, (pointerVector.x * initialVector.x + pointerVector.y * initialVector.y) / Math.max(1, denominator));
            nextVector = { x: initialVector.x * factor, y: initialVector.y * factor };
            scaleX *= factor;
            scaleY *= factor;
          } else if (interaction.action.x) {
            const ratio = Math.max(0.15, pointerVector.x / initialVector.x);
            nextVector = { x: initialVector.x * ratio, y: 0 };
            scaleX *= ratio;
          } else {
            const ratio = Math.max(0.15, pointerVector.y / initialVector.y);
            nextVector = { x: 0, y: initialVector.y * ratio };
            scaleY *= ratio;
          }

          const centerOffset = rotateVector({ x: nextVector.x / 2, y: nextVector.y / 2 }, interaction.initialRotation);
          const nextCenter = { x: interaction.anchor.x + centerOffset.x, y: interaction.anchor.y + centerOffset.y };
          return {
            ...annotation,
            scaleX,
            scaleY,
            tx: interaction.initialTx + nextCenter.x - interaction.center.x,
            ty: interaction.initialTy + nextCenter.y - interaction.center.y
          };
        }
        const initialAngle = Math.atan2(interaction.initialPoint.y - interaction.center.y, interaction.initialPoint.x - interaction.center.x);
        const angle = Math.atan2(point.y - interaction.center.y, point.x - interaction.center.x);
        return { ...annotation, rotation: interaction.initialRotation + angle - initialAngle };
      }));
      return;
    }

    const current = drawingRef.current;
    if (!current) {
      if (tool === "select") {
        const selected = annotations.find((annotation) => annotation.id === selectedId);
        if (!selected) setCanvasCursor("default");
        else {
          const action = getHandleAction(point, selected);
          setCanvasCursor(action.mode !== "move" || hitAnnotation(point, selected, getScreenUnit()) ? getCursor(action, selected.rotation) : "default");
        }
      }
      return;
    }
    drawingRef.current = current.type === "brush"
      ? { ...current, points: [...current.points, point] }
      : current.type !== "text" ? { ...current, end: point } : current;
    redraw({ current: drawingRef.current });
  };

  const finishDrawing = () => {
    if (transformRef.current) {
      const interaction = transformRef.current;
      transformRef.current = null;
      setUndoStack((stack) => [...stack, interaction.initialAnnotations]);
      setRedoStack([]);
      return;
    }
    const current = drawingRef.current;
    if (!current) return;
    drawingRef.current = null;
    commitAnnotations([...annotations, current]);
  };

  const finishPointerInteraction = (event: React.PointerEvent<HTMLCanvasElement>) => {
    finishDrawing();
    if (tool !== "text") return;
    event.preventDefault();
    window.requestAnimationFrame(() => {
      const input = textInputRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    });
  };

  const commitText = () => {
    if (!textDraft?.value.trim()) {
      setTextDraft(null);
      return;
    }
    const scaledFontSize = fontSize * getScreenUnit();
    const context = canvasRef.current?.getContext("2d");
    let textMetrics: Extract<Annotation, { type: "text" }>["textMetrics"];
    if (context) {
      context.save();
      context.font = `600 ${scaledFontSize}px Inter, "PingFang SC", sans-serif`;
      const measured = context.measureText(textDraft.value.trim());
      context.restore();
      textMetrics = {
        ascent: measured.actualBoundingBoxAscent || scaledFontSize,
        descent: measured.actualBoundingBoxDescent || scaledFontSize * 0.3,
        left: Math.max(0, measured.actualBoundingBoxLeft),
        right: Math.max(measured.width, measured.actualBoundingBoxRight)
      };
    }
    const next: Annotation = {
      ...makeTransform(),
      color,
      fontSize: scaledFontSize,
      id: makeId(),
      point: textDraft.canvasPoint,
      text: textDraft.value.trim(),
      textMetrics,
      type: "text",
      width: 1
    };
    commitAnnotations([...annotations, next]);
    setSelectedId(next.id);
    setTool("select");
    setTextDraft(null);
  };

  const undo = () => {
    const previous = undoStack[undoStack.length - 1];
    if (!previous) return;
    setUndoStack((stack) => stack.slice(0, -1));
    setRedoStack((stack) => [...stack, annotations]);
    setAnnotations(previous);
    setSelectedId(null);
  };

  const redo = () => {
    const next = redoStack[redoStack.length - 1];
    if (!next) return;
    setRedoStack((stack) => stack.slice(0, -1));
    setUndoStack((stack) => [...stack, annotations]);
    setAnnotations(next);
    setSelectedId(null);
  };

  const send = () => {
    const canvas = canvasRef.current;
    if (!canvas || !imageReady || !exportReady) return;
    redraw({ showSelection: false });
    onSend(canvas.toDataURL("image/png"));
  };

  const selectTool = (nextTool: Tool, menu?: "brush" | "shape" | "text") => {
    setTool(nextTool);
    setSelectedId(nextTool === "select" ? selectedId : null);
    setToolMenu(menu ? (current) => current === menu ? null : menu : null);
  };

  return (
    <section
      aria-label="图片标注编辑器"
      className="absolute z-[80] flex flex-col overflow-hidden rounded-[14px] border border-[#D9DDE6] bg-white shadow-[0_20px_56px_rgba(15,23,42,0.18)]"
      data-image-preview="true"
      style={{ height: panelSize.height, left: position.x, top: position.y, width: panelSize.width }}
    >
      <header
        className="relative flex h-14 shrink-0 cursor-grab items-center border-b border-[#ECEFF5] px-4 active:cursor-grabbing"
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
          dragRef.current = { pointerX: event.clientX, pointerY: event.clientY, x: position.x, y: position.y };
        }}
      >
        <strong className="mr-auto text-[15px] text-primary">图片标注</strong>
        <div className="flex items-center gap-1.5" onPointerDown={(event) => event.stopPropagation()}>
          <ToolButton active={tool === "select"} label="选择" onClick={() => selectTool("select")}><MousePointer2 size={18} /></ToolButton>
          <ToolButton active={tool === "text"} label="文字" onClick={() => selectTool("text", "text")}><span className="text-[18px] font-bold leading-none">A</span></ToolButton>
          <ToolButton active={tool !== "select" && tool !== "text" && tool !== "brush"} label="形状" onClick={() => selectTool(tool === "brush" || tool === "select" || tool === "text" ? "rectangle" : tool, "shape")}><Square size={18} /></ToolButton>
          <ToolButton active={tool === "brush"} label="画笔" onClick={() => selectTool("brush", "brush")}><Pencil size={18} /></ToolButton>
          <ToolButton disabled={!undoStack.length} label="撤回" onClick={undo}><Undo2 size={18} /></ToolButton>
          <ToolButton disabled={!redoStack.length} label="重做" onClick={redo}><Redo2 size={18} /></ToolButton>
          <ToolButton disabled={!exportReady} label={exportReady ? "发送到画布" : "正在准备高清导出"} onClick={send}><Send size={18} /></ToolButton>
          <ToolButton label="关闭" onClick={onClose}><X size={18} /></ToolButton>
        </div>
        {toolMenu ? (
          <div className="absolute right-4 top-[62px] z-20 flex items-center gap-4 rounded-[10px] border border-[#D9DDE6] bg-white px-3 py-2.5 shadow-[0_12px_30px_rgba(15,23,42,0.15)]">
            {toolMenu === "shape" ? (
              <div className="flex items-center gap-1 border-r border-[#ECEFF5] pr-3">
                <ToolButton active={tool === "rectangle"} label="空心正方形" onClick={() => setTool("rectangle")}><Square size={17} /></ToolButton>
                <ToolButton active={tool === "ellipse"} label="空心圆形" onClick={() => setTool("ellipse")}><Circle size={17} /></ToolButton>
                <ToolButton active={tool === "filledRectangle"} label="实心正方形" onClick={() => setTool("filledRectangle")}><Square fill="currentColor" size={17} /></ToolButton>
                <ToolButton active={tool === "filledEllipse"} label="实心圆形" onClick={() => setTool("filledEllipse")}><Circle fill="currentColor" size={17} /></ToolButton>
                <ToolButton active={tool === "arrow"} label="箭头" onClick={() => setTool("arrow")}><ArrowUpRight size={17} /></ToolButton>
              </div>
            ) : null}
            <div className="flex items-center gap-2.5">
              {colors.map((item) => (
                <button
                  aria-label={`颜色 ${item}`}
                  className={`h-5 w-5 rounded-[4px] border ${color === item ? "ring-2 ring-selected/35" : "border-[#C8CCD4]"}`}
                  key={item}
                  onClick={() => setColor(item)}
                  style={{ backgroundColor: item }}
                  title={item}
                  type="button"
                />
              ))}
            </div>
            {toolMenu === "text" ? (
              <div className="flex items-center gap-1 border-l border-[#ECEFF5] pl-3">
                {fontSizes.map((item) => (
                  <button
                    aria-label={`字号 ${item}`}
                    className={`h-8 min-w-8 rounded-[6px] px-2 text-xs font-semibold ${fontSize === item ? "bg-[#F0EFFF] text-selected" : "text-secondary hover:bg-[#F4F6FA]"}`}
                    key={item}
                    onClick={() => setFontSize(item)}
                    type="button"
                  >
                    {item}
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-1 border-l border-[#ECEFF5] pl-3">
                {widths.map((item) => (
                  <button
                    aria-label={`粗细 ${item}`}
                    className={`grid h-8 w-8 place-items-center rounded-full ${lineWidth === item ? "bg-[#F0EFFF]" : "hover:bg-[#F4F6FA]"}`}
                    key={item}
                    onClick={() => setLineWidth(item)}
                    title={`粗细 ${item}`}
                    type="button"
                  >
                    <span className="rounded-full bg-primary" style={{ height: Math.min(item, 10), width: Math.min(item, 10) }} />
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 bg-[#F5F6FA] p-5">
        <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
          {imageError ? (
            <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center text-sm font-medium text-danger">图片加载失败，请关闭后重试</div>
          ) : null}
          {imageLoading ? (
            <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center text-sm font-semibold text-secondary">图片载入中...</div>
          ) : null}
          <canvas
            aria-label="图片标注画布"
            className="max-h-full max-w-full touch-none bg-white shadow-sm"
            onPointerCancel={finishDrawing}
            onPointerDown={startDrawing}
            onPointerLeave={() => {
              if (!transformRef.current) setCanvasCursor("default");
            }}
            onPointerMove={continueDrawing}
            onPointerUp={finishPointerInteraction}
            ref={canvasRef}
            style={{ cursor: tool === "select" ? canvasCursor : tool === "text" ? "text" : "crosshair" }}
          />
          {textDraft ? (
            <input
              aria-label="输入标注文字"
              autoFocus
              className="absolute z-10 min-w-[160px] rounded-[6px] border border-selected bg-white/95 px-2.5 py-1.5 font-semibold outline-none shadow-sm"
              onBlur={(event) => {
                const input = event.currentTarget;
                window.setTimeout(() => {
                  if (document.activeElement !== input) commitText();
                }, 0);
              }}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setTextDraft((current) => current ? { ...current, value } : current);
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitText();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setTextDraft(null);
                }
              }}
              onPointerDown={(event) => event.stopPropagation()}
              placeholder="输入文字"
              ref={textInputRef}
              style={{ color, fontSize, left: textDraft.left, top: textDraft.top }}
              value={textDraft.value}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ToolButton({ active, children, disabled, label, onClick }: { active?: boolean; children: ReactNode; disabled?: boolean; label: string; onClick: () => void }) {
  return (
    <button
      aria-label={label}
      className={`grid h-9 w-9 place-items-center rounded-full transition ${active ? "bg-[#EEEFFD] text-selected" : "text-secondary hover:bg-[#F4F6FA] hover:text-primary"} disabled:cursor-not-allowed disabled:opacity-30`}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}
