"use client";

import { ChangeEvent, Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Konva from "konva";
import { nanoid } from "nanoid";
import useImage from "use-image";
import { Circle, Ellipse, Group, Image as KonvaImage, Layer, Line, Rect, Stage, Text, Transformer } from "react-konva";
import { useRouter } from "next/navigation";
import {
  Circle as CircleIcon,
  Copy,
  Download,
  Eraser,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Layers2,
  Lock,
  Minus,
  MousePointer2,
  Pencil,
  Plus,
  Square,
  Trash2,
  Type as TypeIcon,
  Undo2,
  Redo2,
  Unlock,
  Upload,
} from "lucide-react";
import type { AdjustmentShape, BlendMode, EditorShape, EditorTool, ImageShape, LineShape } from "@/lib/editor-types";

type Presence = {
  clientId: string;
  name: string;
  color: string;
  x?: number;
  y?: number;
};

type HistoryEntry = {
  id: string;
  timestamp: number;
  version: number;
  actorId: string;
  actorName: string;
  action: string;
  targetId?: string;
  targetName?: string;
};

type RoomPayload = {
  version: number;
  state: EditorShape[];
  updatedBy: string | null;
  collaborators: Presence[];
  history: HistoryEntry[];
};

type ActionPayload = {
  action: string;
  targetId?: string;
  targetName?: string;
};

type PointerLikeEvent = {
  evt?: {
    pressure?: number;
  };
  target: {
    getStage: () => {
      getPointerPosition: () => { x: number; y: number } | null;
    } | null;
  };
};

type ShapeBounds = { x: number; y: number; width: number; height: number };
type GuideLine = { points: [number, number, number, number] };

const POLL_INTERVAL_MS = 1000;
const PRESENCE_INTERVAL_MS = 900;
const HISTORY_LIMIT = 40;

const BLEND_OPTIONS: Array<{ label: string; value: BlendMode }> = [
  { label: "Normal", value: "source-over" },
  { label: "Multiply", value: "multiply" },
  { label: "Screen", value: "screen" },
  { label: "Overlay", value: "overlay" },
  { label: "Darken", value: "darken" },
  { label: "Lighten", value: "lighten" },
];

const TOOL_ITEMS: Array<{
  value: EditorTool;
  label: string;
  icon: typeof MousePointer2;
  keyHint: string;
}> = [
  { value: "select", label: "Select", icon: MousePointer2, keyHint: "V" },
  { value: "marquee", label: "Marquee", icon: MousePointer2, keyHint: "M" },
  { value: "rect", label: "Rectangle", icon: Square, keyHint: "R" },
  { value: "ellipse", label: "Ellipse", icon: CircleIcon, keyHint: "E" },
  { value: "line", label: "Line", icon: Minus, keyHint: "L" },
  { value: "brush", label: "Brush", icon: Pencil, keyHint: "B" },
  { value: "text", label: "Text", icon: TypeIcon, keyHint: "T" },
  { value: "eraser", label: "Eraser", icon: Eraser, keyHint: "X" },
];

const CURSOR_COLORS = ["#0f766e", "#7c3aed", "#be123c", "#2563eb", "#15803d", "#c2410c"];

function copyShapes(shapes: EditorShape[]) {
  return JSON.parse(JSON.stringify(shapes)) as EditorShape[];
}

function getPointerPosition(event: PointerLikeEvent) {
  const stage = event.target.getStage();
  if (!stage) {
    return null;
  }
  return stage.getPointerPosition();
}

function getCanvasPointerPosition(event: PointerLikeEvent, zoom: number, panX: number, panY: number) {
  const pointer = getPointerPosition(event);
  if (!pointer) {
    return null;
  }

  return {
    x: (pointer.x - panX) / zoom,
    y: (pointer.y - panY) / zoom,
  };
}

function makeShapeName(type: EditorShape["type"], count: number) {
  return `${type.toUpperCase()} ${count}`;
}

function formatHistoryTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function splitSegments(points: Array<number | null>) {
  const segments: number[][] = [];
  let current: number[] = [];

  points.forEach((value) => {
    if (value === null) {
      if (current.length >= 4) {
        segments.push(current);
      }
      current = [];
      return;
    }
    current.push(value);
  });

  if (current.length >= 4) {
    segments.push(current);
  }

  return segments;
}

function normalizeBounds(bounds: ShapeBounds): ShapeBounds {
  return {
    x: bounds.width < 0 ? bounds.x + bounds.width : bounds.x,
    y: bounds.height < 0 ? bounds.y + bounds.height : bounds.y,
    width: Math.abs(bounds.width),
    height: Math.abs(bounds.height),
  };
}

function getShapeBounds(shape: EditorShape): ShapeBounds | null {
  if (shape.type === "rect") {
    return normalizeBounds({ x: shape.x, y: shape.y, width: shape.width, height: shape.height });
  }

  if (shape.type === "ellipse") {
    return {
      x: shape.x - shape.radiusX,
      y: shape.y - shape.radiusY,
      width: shape.radiusX * 2,
      height: shape.radiusY * 2,
    };
  }

  if (shape.type === "image") {
    return {
      x: shape.x,
      y: shape.y,
      width: shape.width,
      height: shape.height,
    };
  }

  if (shape.type === "text") {
    const estimatedWidth = Math.max(24, shape.text.length * shape.fontSize * 0.58);
    return {
      x: shape.x,
      y: shape.y,
      width: estimatedWidth,
      height: shape.fontSize * 1.25,
    };
  }

  if (shape.type === "line") {
    const values = shape.points.filter((value): value is number => value !== null);
    if (values.length < 2) {
      return null;
    }

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < values.length; index += 2) {
      const x = values[index];
      const y = values[index + 1];
      if (typeof x !== "number" || typeof y !== "number") {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
      return null;
    }

    const padding = Math.max(2, shape.strokeWidth / 2);
    return {
      x: minX - padding,
      y: minY - padding,
      width: maxX - minX + padding * 2,
      height: maxY - minY + padding * 2,
    };
  }

  return null;
}

function intersectsBounds(a: ShapeBounds, b: ShapeBounds) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function moveShapeBy(shape: EditorShape, dx: number, dy: number): EditorShape {
  if (shape.type === "rect" || shape.type === "ellipse" || shape.type === "text" || shape.type === "image") {
    return { ...shape, x: shape.x + dx, y: shape.y + dy };
  }

  if (shape.type === "line") {
    return {
      ...shape,
      points: shape.points.map((value, index) => {
        if (value === null) {
          return null;
        }
        return index % 2 === 0 ? value + dx : value + dy;
      }),
    };
  }

  return shape;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function getImageSize(src: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => {
      resolve({
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    };
    image.onerror = () => reject(new Error("Invalid image"));
    image.src = src;
  });
}

function normalizeShape(shape: EditorShape): EditorShape {
  if (shape.type === "rect") {
    return {
      ...shape,
      width: Math.abs(shape.width),
      height: Math.abs(shape.height),
      x: shape.width < 0 ? shape.x + shape.width : shape.x,
      y: shape.height < 0 ? shape.y + shape.height : shape.y,
    };
  }

  if (shape.type === "ellipse") {
    return {
      ...shape,
      radiusX: Math.abs(shape.radiusX),
      radiusY: Math.abs(shape.radiusY),
    };
  }

  return shape;
}

function hydrateShape(shape: EditorShape, index: number): EditorShape {
  const base = {
    name: shape.name || makeShapeName(shape.type, index + 1),
    groupName: shape.groupName,
    hidden: !!shape.hidden,
    locked: !!shape.locked,
    opacity: typeof shape.opacity === "number" ? shape.opacity : 1,
    blendMode: shape.blendMode || "source-over",
    shadowColor: shape.shadowColor || "#000000",
    shadowBlur: typeof shape.shadowBlur === "number" ? shape.shadowBlur : 0,
    shadowOffsetX: typeof shape.shadowOffsetX === "number" ? shape.shadowOffsetX : 0,
    shadowOffsetY: typeof shape.shadowOffsetY === "number" ? shape.shadowOffsetY : 0,
    shadowOpacity: typeof shape.shadowOpacity === "number" ? shape.shadowOpacity : 0,
  };

  if (shape.type === "rect") {
    return {
      ...shape,
      ...base,
      fill: shape.fill || "#e4e4e7",
      stroke: shape.stroke || "#18181b",
      strokeWidth: typeof shape.strokeWidth === "number" ? shape.strokeWidth : 2,
    };
  }

  if (shape.type === "ellipse") {
    return {
      ...shape,
      ...base,
      fill: shape.fill || "#e4e4e7",
      stroke: shape.stroke || "#18181b",
      strokeWidth: typeof shape.strokeWidth === "number" ? shape.strokeWidth : 2,
    };
  }

  if (shape.type === "text") {
    return {
      ...shape,
      ...base,
      fill: shape.fill || "#18181b",
      fontSize: typeof shape.fontSize === "number" ? shape.fontSize : 20,
    };
  }

  if (shape.type === "image") {
    return {
      ...shape,
      ...base,
      width: Math.max(20, shape.width),
      height: Math.max(20, shape.height),
      rotation: typeof shape.rotation === "number" ? shape.rotation : 0,
      brightness: typeof shape.brightness === "number" ? shape.brightness : 0,
      contrast: typeof shape.contrast === "number" ? shape.contrast : 0,
      saturation: typeof shape.saturation === "number" ? shape.saturation : 0,
      blurRadius: typeof shape.blurRadius === "number" ? shape.blurRadius : 0,
      grayscale: typeof shape.grayscale === "number" ? shape.grayscale : 0,
      invert: typeof shape.invert === "number" ? shape.invert : 0,
      clipToPrevious: !!shape.clipToPrevious,
    };
  }

  if (shape.type === "adjustment") {
    return {
      ...shape,
      ...base,
      brightness: typeof shape.brightness === "number" ? shape.brightness : 0,
      contrast: typeof shape.contrast === "number" ? shape.contrast : 0,
      saturation: typeof shape.saturation === "number" ? shape.saturation : 0,
    };
  }

  return {
    ...shape,
    ...base,
    stroke: shape.stroke || "#18181b",
    strokeWidth: typeof shape.strokeWidth === "number" ? shape.strokeWidth : 2,
    points: Array.isArray(shape.points) ? shape.points : [],
  };
}

function CanvasImageShape({
  shape,
  selected,
  canDrag,
  canTransform,
  keepRatio,
  onSelect,
  onDragMove,
  onDrag,
  onTransform,
}: {
  shape: ImageShape;
  selected: boolean;
  canDrag: boolean;
  canTransform: boolean;
  keepRatio: boolean;
  onSelect: () => void;
  onDragMove?: (x: number, y: number) => void;
  onDrag: (x: number, y: number) => void;
  onTransform: (next: { x: number; y: number; width: number; height: number; rotation: number }) => void;
}) {
  const [image] = useImage(shape.src);
  const imageRef = useRef<Konva.Image | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const activeFilters = [
    Konva.Filters.Brighten,
    Konva.Filters.Contrast,
    Konva.Filters.HSL,
    Konva.Filters.Blur,
    ...(shape.grayscale ? [Konva.Filters.Grayscale] : []),
    ...(shape.invert ? [Konva.Filters.Invert] : []),
  ];

  useEffect(() => {
    if (!imageRef.current) {
      return;
    }

    imageRef.current.clearCache();
    imageRef.current.cache();
    imageRef.current.getLayer()?.batchDraw();
  }, [
    image,
    shape.width,
    shape.height,
    shape.rotation,
    shape.brightness,
    shape.contrast,
    shape.saturation,
    shape.blurRadius,
    shape.grayscale,
    shape.invert,
  ]);

  useEffect(() => {
    if (!transformerRef.current || !imageRef.current) {
      return;
    }

    if (selected && canTransform) {
      transformerRef.current.nodes([imageRef.current]);
    } else {
      transformerRef.current.nodes([]);
    }
    transformerRef.current.getLayer()?.batchDraw();
  }, [selected, canTransform]);

  return (
    <Fragment>
      <KonvaImage
        ref={imageRef}
        image={image}
        x={shape.x}
        y={shape.y}
        width={shape.width}
        height={shape.height}
        rotation={shape.rotation || 0}
        opacity={shape.opacity ?? 1}
        globalCompositeOperation={shape.blendMode ?? "source-over"}
        stroke={selected ? "#2563eb" : undefined}
        strokeWidth={selected ? 1 : 0}
        draggable={canDrag}
        filters={activeFilters}
        brightness={shape.brightness ?? 0}
        contrast={shape.contrast ?? 0}
        saturation={shape.saturation ?? 0}
        blurRadius={shape.blurRadius ?? 0}
        shadowColor={shape.shadowColor}
        shadowBlur={shape.shadowBlur || 0}
        shadowOffsetX={shape.shadowOffsetX || 0}
        shadowOffsetY={shape.shadowOffsetY || 0}
        shadowOpacity={shape.shadowOpacity || 0}
        onClick={onSelect}
        onTap={onSelect}
        onDragMove={(event) => onDragMove?.(event.target.x(), event.target.y())}
        onDragEnd={(event) => onDrag(event.target.x(), event.target.y())}
        onTransformEnd={(event) => {
          const node = event.target as Konva.Image;
          const scaleX = node.scaleX();
          const scaleY = node.scaleY();
          const width = Math.max(20, node.width() * scaleX);
          const height = Math.max(20, node.height() * scaleY);
          node.scaleX(1);
          node.scaleY(1);
          onTransform({
            x: node.x(),
            y: node.y(),
            width,
            height,
            rotation: node.rotation(),
          });
        }}
      />
      {selected && canTransform && (
        <Transformer
          ref={transformerRef}
          rotateEnabled
          flipEnabled={false}
          keepRatio={keepRatio}
          borderStroke="#2563eb"
          anchorStroke="#2563eb"
          anchorFill="#ffffff"
          anchorSize={8}
          borderDash={[4, 4]}
          enabledAnchors={[
            "top-left",
            "top-center",
            "top-right",
            "middle-right",
            "bottom-right",
            "bottom-center",
            "bottom-left",
            "middle-left",
          ]}
          boundBoxFunc={(_, nextBox) => {
            if (nextBox.width < 20 || nextBox.height < 20) {
              return _;
            }
            return nextBox;
          }}
        />
      )}
    </Fragment>
  );
}

export default function Home() {
  const router = useRouter();

  const [tool, setTool] = useState<EditorTool>("select");
  const [shapes, setShapes] = useState<EditorShape[]>([]);
  const [draftShape, setDraftShape] = useState<EditorShape | null>(null);
  const [draftTool, setDraftTool] = useState<EditorTool | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeDrawLayerId, setActiveDrawLayerId] = useState<string | null>(null);
  const [past, setPast] = useState<EditorShape[][]>([]);
  const [future, setFuture] = useState<EditorShape[][]>([]);
  const [stageSize, setStageSize] = useState({ width: 1100, height: 680 });
  const [canvasSize, setCanvasSize] = useState({ width: 1920, height: 1080 });
  const [canvasInput, setCanvasInput] = useState({ width: 1920, height: 1080 });
  const [canvasColor, setCanvasColor] = useState("#ffffff");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [showGrid, setShowGrid] = useState(true);
  const [snapToGrid, setSnapToGrid] = useState(false);
  const [showRulers, setShowRulers] = useState(true);
  const [showGuides, setShowGuides] = useState(true);
  const [showThirds, setShowThirds] = useState(false);
  const [showSafeArea, setShowSafeArea] = useState(false);
  const [pressureBrush, setPressureBrush] = useState(true);
  const [lockImageRatio, setLockImageRatio] = useState(false);
  const [isShiftPressed, setIsShiftPressed] = useState(false);
  const [gridSize, setGridSize] = useState(24);
  const [guides, setGuides] = useState<{ vertical: number[]; horizontal: number[] }>({ vertical: [], horizontal: [] });
  const [smartGuides, setSmartGuides] = useState<GuideLine[]>([]);
  const [marqueeBox, setMarqueeBox] = useState<ShapeBounds | null>(null);
  const [showCursors, setShowCursors] = useState(true);
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState("Connecting");
  const [roomId, setRoomId] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [fillColor, setFillColor] = useState("#e4e4e7");
  const [strokeColor, setStrokeColor] = useState("#18181b");
  const [shadowColor, setShadowColor] = useState("#000000");
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [shadowBlur, setShadowBlur] = useState(0);
  const [shadowOffsetX, setShadowOffsetX] = useState(0);
  const [shadowOffsetY, setShadowOffsetY] = useState(0);
  const [shadowOpacity, setShadowOpacity] = useState(0);
  const [opacity, setOpacity] = useState(1);
  const [fontSize, setFontSize] = useState(20);
  const [blendMode, setBlendMode] = useState<BlendMode>("source-over");
  const [peers, setPeers] = useState<Presence[]>([]);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [localDraftAvailable, setLocalDraftAvailable] = useState(false);

  const stageRef = useRef<Konva.Stage | null>(null);
  const stageShellRef = useRef<HTMLDivElement | null>(null);
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const syncTimerRef = useRef<NodeJS.Timeout | null>(null);
  const presenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const skipNextSyncRef = useRef(false);
  const versionRef = useRef(0);
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const nameRef = useRef("");
  const pendingActionRef = useRef<ActionPayload | null>(null);

  const clientId = useMemo(() => nanoid(10), []);
  const generatedName = useMemo(() => `Artist-${nanoid(4).toUpperCase()}`, []);
  const clientColor = useMemo(() => CURSOR_COLORS[Math.floor(Math.random() * CURSOR_COLORS.length)], []);

  const selectedShape = shapes.find((shape) => shape.id === selectedId) ?? null;
  const draftStorageKey = useMemo(() => (roomId ? `luma-local-draft-${roomId}` : ""), [roomId]);
  const globalAdjustment = useMemo(() => {
    const active = shapes.filter((shape): shape is AdjustmentShape => shape.type === "adjustment" && !shape.hidden);
    return active.reduce(
      (acc, layer) => ({
        brightness: acc.brightness + (layer.brightness || 0),
        contrast: acc.contrast + (layer.contrast || 0),
        saturation: acc.saturation + (layer.saturation || 0),
      }),
      { brightness: 0, contrast: 0, saturation: 0 },
    );
  }, [shapes]);
  const gridLines = useMemo(() => {
    if (!showGrid) {
      return { vertical: [] as number[], horizontal: [] as number[] };
    }

    const vertical: number[] = [];
    for (let x = 0; x <= canvasSize.width; x += gridSize) {
      vertical.push(x);
    }

    const horizontal: number[] = [];
    for (let y = 0; y <= canvasSize.height; y += gridSize) {
      horizontal.push(y);
    }

    return { vertical, horizontal };
  }, [showGrid, gridSize, canvasSize.width, canvasSize.height]);

  const snapPoint = useCallback(
    (x: number, y: number) => {
      if (!snapToGrid) {
        return { x, y };
      }
      return {
        x: Math.round(x / gridSize) * gridSize,
        y: Math.round(y / gridSize) * gridSize,
      };
    },
    [snapToGrid, gridSize],
  );

  const nudgeZoom = useCallback((delta: number) => {
    setZoom((current) => {
      const next = Math.min(4, Math.max(0.25, Number((current + delta).toFixed(2))));
      return next;
    });
  }, []);

  const fitCanvasToViewport = useCallback(() => {
    const scaleX = (stageSize.width - 40) / canvasSize.width;
    const scaleY = (stageSize.height - 40) / canvasSize.height;
    const nextZoom = Math.min(4, Math.max(0.1, Math.min(scaleX, scaleY)));
    setZoom(nextZoom);
    setPan({
      x: (stageSize.width - canvasSize.width * nextZoom) / 2,
      y: (stageSize.height - canvasSize.height * nextZoom) / 2,
    });
  }, [stageSize.width, stageSize.height, canvasSize.width, canvasSize.height]);

  const applyCanvasSize = useCallback(() => {
    const width = Math.max(64, Math.min(8000, Math.round(canvasInput.width || 1)));
    const height = Math.max(64, Math.min(8000, Math.round(canvasInput.height || 1)));
    setCanvasSize({ width, height });
  }, [canvasInput.height, canvasInput.width]);

  const placePoint = useCallback(
    (x: number, y: number) => {
      const snapped = snapPoint(x, y);
      return {
        x: Math.max(0, Math.min(canvasSize.width, snapped.x)),
        y: Math.max(0, Math.min(canvasSize.height, snapped.y)),
      };
    },
    [snapPoint, canvasSize.width, canvasSize.height],
  );

  const computeSmartGuides = useCallback(
    (movingId: string, candidateBounds: ShapeBounds) => {
      const threshold = 6;
      const lines: GuideLine[] = [];
      const candidateX = [candidateBounds.x, candidateBounds.x + candidateBounds.width / 2, candidateBounds.x + candidateBounds.width];
      const candidateY = [candidateBounds.y, candidateBounds.y + candidateBounds.height / 2, candidateBounds.y + candidateBounds.height];

      const boundsPool: ShapeBounds[] = [];
      for (const shape of shapes) {
        if (shape.id === movingId || shape.hidden || shape.type === "adjustment") {
          continue;
        }
        const bounds = getShapeBounds(shape);
        if (bounds) {
          boundsPool.push(bounds);
        }
      }
      boundsPool.push({ x: 0, y: 0, width: canvasSize.width, height: canvasSize.height });

      let minY = 0;
      let maxY = canvasSize.height;
      let minX = 0;
      let maxX = canvasSize.width;

      boundsPool.forEach((bounds) => {
        minY = Math.min(minY, bounds.y);
        maxY = Math.max(maxY, bounds.y + bounds.height);
        minX = Math.min(minX, bounds.x);
        maxX = Math.max(maxX, bounds.x + bounds.width);

        const targetX = [bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width];
        for (const x of candidateX) {
          for (const tx of targetX) {
            if (Math.abs(x - tx) <= threshold) {
              lines.push({ points: [tx, minY, tx, maxY] });
            }
          }
        }

        const targetY = [bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height];
        for (const y of candidateY) {
          for (const ty of targetY) {
            if (Math.abs(y - ty) <= threshold) {
              lines.push({ points: [minX, ty, maxX, ty] });
            }
          }
        }
      });

      const unique = new Map(lines.map((line) => [line.points.join(","), line]));
      setSmartGuides(Array.from(unique.values()).slice(0, 8));
    },
    [shapes, canvasSize.width, canvasSize.height],
  );

  useEffect(() => {
    versionRef.current = version;
  }, [version]);

  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  useEffect(() => {
    nameRef.current = displayName;
  }, [displayName]);

  useEffect(() => {
    if (!selectedShape || selectedShape.type === "adjustment") {
      return;
    }

    setShadowColor(selectedShape.shadowColor || "#000000");
    setShadowBlur(typeof selectedShape.shadowBlur === "number" ? selectedShape.shadowBlur : 0);
    setShadowOffsetX(typeof selectedShape.shadowOffsetX === "number" ? selectedShape.shadowOffsetX : 0);
    setShadowOffsetY(typeof selectedShape.shadowOffsetY === "number" ? selectedShape.shadowOffsetY : 0);
    setShadowOpacity(typeof selectedShape.shadowOpacity === "number" ? selectedShape.shadowOpacity : 0);
  }, [selectedShape]);

  useEffect(() => {
    const savedName = window.localStorage.getItem("luma-display-name");
    const name = savedName?.trim() || generatedName;
    setDisplayName(name);
  }, [generatedName]);

  useEffect(() => {
    if (displayName.trim()) {
      window.localStorage.setItem("luma-display-name", displayName.trim());
    }
  }, [displayName]);

  useEffect(() => {
    if (!draftStorageKey) {
      setLocalDraftAvailable(false);
      return;
    }
    const hasDraft = !!window.localStorage.getItem(draftStorageKey);
    setLocalDraftAvailable(hasDraft);
  }, [draftStorageKey]);

  useEffect(() => {
    if (!draftStorageKey) {
      return;
    }

    const payload = {
      savedAt: Date.now(),
      shapes,
      canvasSize,
      canvasColor,
      guides,
      showGrid,
      gridSize,
    };

    window.localStorage.setItem(draftStorageKey, JSON.stringify(payload));
    setLocalDraftAvailable(true);
  }, [
    draftStorageKey,
    shapes,
    canvasSize,
    canvasColor,
    guides,
    showGrid,
    gridSize,
  ]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const existingRoom = params.get("room")?.toUpperCase() ?? "";

    if (existingRoom) {
      setRoomId(existingRoom);
      setJoinCode(existingRoom);
      if (params.get("room") !== existingRoom) {
        router.replace(`/?room=${existingRoom}`);
      }
      return;
    }

    const newRoom = nanoid(8).toUpperCase();
    setRoomId(newRoom);
    setJoinCode(newRoom);
    router.replace(`/?room=${newRoom}`);
  }, [router]);

  useEffect(() => {
    if (!stageShellRef.current) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }

      const width = Math.max(300, entry.contentRect.width - 12);
      const height = Math.max(280, entry.contentRect.height - 12);
      setStageSize({ width, height });
    });

    observer.observe(stageShellRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (stageSize.width < 10 || stageSize.height < 10) {
      return;
    }
    fitCanvasToViewport();
  }, [fitCanvasToViewport, stageSize.width, stageSize.height]);

  useEffect(() => {
    if (!roomId) {
      return;
    }

    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
    }

    const pollRoom = async () => {
      const response = await fetch(`/api/rooms/${roomId}`, { cache: "no-store" });
      if (!response.ok) {
        setStatus("Connection issue");
        return;
      }

      const payload = (await response.json()) as RoomPayload;
      setPeers(payload.collaborators.filter((peer) => peer.clientId !== clientId));
      setHistory(payload.history);

      if (payload.version > versionRef.current && payload.updatedBy !== clientId) {
        skipNextSyncRef.current = true;
        setShapes(payload.state.map(hydrateShape));
        setVersion(payload.version);
      }

      setStatus("Live");
    };

    pollRoom().catch(() => setStatus("Connection issue"));
    pollTimerRef.current = setInterval(() => {
      pollRoom().catch(() => setStatus("Connection issue"));
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, [roomId, clientId]);

  useEffect(() => {
    if (!roomId || !displayName.trim()) {
      return;
    }

    if (presenceTimerRef.current) {
      clearInterval(presenceTimerRef.current);
    }

    const heartbeat = async () => {
      await fetch(`/api/rooms/${roomId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          stateChanged: false,
          presence: {
            x: cursorRef.current?.x,
            y: cursorRef.current?.y,
            color: clientColor,
            name: nameRef.current,
          },
        }),
      });
    };

    heartbeat().catch(() => undefined);
    presenceTimerRef.current = setInterval(() => {
      heartbeat().catch(() => undefined);
    }, PRESENCE_INTERVAL_MS);

    return () => {
      if (presenceTimerRef.current) {
        clearInterval(presenceTimerRef.current);
      }
    };
  }, [roomId, clientId, clientColor, displayName]);

  useEffect(() => {
    if (!roomId || !displayName.trim()) {
      return;
    }

    if (skipNextSyncRef.current) {
      skipNextSyncRef.current = false;
      return;
    }

    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
    }

    syncTimerRef.current = setTimeout(async () => {
      const response = await fetch(`/api/rooms/${roomId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          version: versionRef.current,
          state: shapes,
          stateChanged: true,
          action: pendingActionRef.current,
          presence: {
            x: cursorRef.current?.x,
            y: cursorRef.current?.y,
            color: clientColor,
            name: nameRef.current,
          },
        }),
      });

      if (!response.ok) {
        setStatus("Connection issue");
        return;
      }

      const payload = (await response.json()) as RoomPayload & { applied: boolean };
      setPeers(payload.collaborators.filter((peer) => peer.clientId !== clientId));
      setHistory(payload.history);

      if (!payload.applied) {
        skipNextSyncRef.current = true;
        setShapes(payload.state.map(hydrateShape));
      }

      pendingActionRef.current = null;
      setVersion(payload.version);
      setStatus("Live");
    }, 180);

    return () => {
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
      }
    };
  }, [roomId, shapes, clientId, clientColor, displayName]);

  const commitShapes = useCallback(
    (next: EditorShape[], action?: ActionPayload) => {
      setPast((prev) => [...prev, copyShapes(shapes)].slice(-HISTORY_LIMIT));
      setFuture([]);
      setShapes(next);
      pendingActionRef.current = action || { action: "Updated canvas" };
    },
    [shapes],
  );

  const updateSelectedShape = useCallback(
    (updater: (shape: EditorShape) => EditorShape, action: string) => {
      if (!selectedShape) {
        return;
      }

      const next = shapes.map((shape) => (shape.id === selectedShape.id ? updater(shape) : shape));
      commitShapes(next, {
        action,
        targetId: selectedShape.id,
        targetName: selectedShape.name,
      });
    },
    [selectedShape, shapes, commitShapes],
  );

  const appendToDrawLayer = useCallback(
    (newPoints: number[], mode: "line" | "brush") => {
      if (newPoints.length < 4) {
        return;
      }

      const existing = activeDrawLayerId
        ? shapes.find((shape) => shape.id === activeDrawLayerId && shape.type === "line")
        : null;

      const canReuse =
        !!existing &&
        existing.type === "line" &&
        !existing.locked &&
        !existing.hidden &&
        existing.stroke === strokeColor &&
        existing.strokeWidth === strokeWidth;

      if (canReuse && existing?.type === "line") {
        const merged: LineShape = {
          ...existing,
          points:
            existing.points.length === 0
              ? [...newPoints]
              : [...existing.points, null, ...newPoints],
          opacity,
          blendMode,
        };

        commitShapes(
          shapes.map((shape) => (shape.id === existing.id ? merged : shape)),
          {
            action: mode === "line" ? "Added segment to draw layer" : "Painted on draw layer",
            targetId: existing.id,
            targetName: existing.name,
          },
        );
        return;
      }

      const drawLayer: LineShape = {
        id: nanoid(),
        type: "line",
        name: makeShapeName("line", shapes.length + 1),
        points: [...newPoints],
        stroke: strokeColor,
        strokeWidth,
        opacity,
        blendMode,
      };

      commitShapes([...shapes, drawLayer], {
        action: "Created draw layer",
        targetId: drawLayer.id,
        targetName: drawLayer.name,
      });
      setActiveDrawLayerId(drawLayer.id);
      setSelectedId(drawLayer.id);
    },
    [activeDrawLayerId, shapes, strokeColor, strokeWidth, opacity, blendMode, commitShapes],
  );

  const addImageLayer = useCallback(
    async (src: string, customName?: string) => {
      try {
        const original = await getImageSize(src);
        const maxWidth = Math.max(220, stageSize.width * 0.45);
        const scale = Math.min(1, maxWidth / original.width);

        const imageShape: ImageShape = {
          id: nanoid(),
          type: "image",
          name: customName || makeShapeName("image", shapes.length + 1),
          x: Math.max(16, stageSize.width / 2 - (original.width * scale) / 2),
          y: Math.max(16, stageSize.height / 2 - (original.height * scale) / 2),
          width: Math.max(40, original.width * scale),
          height: Math.max(40, original.height * scale),
          src,
          opacity,
          blendMode,
          rotation: 0,
          brightness: 0,
          contrast: 0,
          saturation: 0,
          blurRadius: 0,
          grayscale: 0,
          invert: 0,
          clipToPrevious: false,
        };

        commitShapes([...shapes, imageShape], {
          action: "Added image layer",
          targetId: imageShape.id,
          targetName: imageShape.name,
        });
        setSelectedId(imageShape.id);
      } catch {
        setStatus("Invalid image");
      }
    },
    [shapes, stageSize.width, stageSize.height, opacity, blendMode, commitShapes],
  );

  const addAdjustmentLayer = useCallback(() => {
    const layer: AdjustmentShape = {
      id: nanoid(),
      type: "adjustment",
      name: makeShapeName("adjustment", shapes.length + 1),
      brightness: 0,
      contrast: 0,
      saturation: 0,
      opacity: 1,
      blendMode: "source-over",
    };
    commitShapes([...shapes, layer], {
      action: "Added adjustment layer",
      targetId: layer.id,
      targetName: layer.name,
    });
    setSelectedId(layer.id);
  }, [shapes, commitShapes]);

  const generateMasterpiece = useCallback(
    (preset: "cyber" | "magazine" | "blueprint") => {
      const cx = canvasSize.width / 2;
      const cy = canvasSize.height / 2;
      const nowTag = nanoid(4).toUpperCase();

      const baseLayers: EditorShape[] =
        preset === "cyber"
          ? [
              {
                id: nanoid(), type: "rect", name: `Backdrop ${nowTag}`,
                x: 0, y: 0, width: canvasSize.width, height: canvasSize.height,
                fill: "#0a0a23", stroke: "#1f2937", strokeWidth: 0, opacity: 1, blendMode: "source-over",
              },
              {
                id: nanoid(), type: "ellipse", name: `Glow Core ${nowTag}`,
                x: cx, y: cy, radiusX: canvasSize.width * 0.2, radiusY: canvasSize.width * 0.2,
                fill: "#2563eb", stroke: "#60a5fa", strokeWidth: 1, opacity: 0.45, blendMode: "screen",
                shadowColor: "#60a5fa", shadowBlur: 40, shadowOpacity: 0.8,
              },
              {
                id: nanoid(), type: "text", name: `Title ${nowTag}`,
                x: cx - 260, y: cy - 40, text: "LUMA MASTERPIECE", fill: "#e0f2fe", fontSize: 64,
                opacity: 1, blendMode: "screen", shadowColor: "#38bdf8", shadowBlur: 24, shadowOpacity: 0.9,
              },
              {
                id: nanoid(), type: "adjustment", name: `Polish ${nowTag}`,
                brightness: 0.08, contrast: 24, saturation: 0.45,
              },
            ]
          : preset === "magazine"
            ? [
                {
                  id: nanoid(), type: "rect", name: `Paper ${nowTag}`,
                  x: 0, y: 0, width: canvasSize.width, height: canvasSize.height,
                  fill: "#fef3c7", stroke: "#fde68a", strokeWidth: 0, opacity: 1, blendMode: "source-over",
                },
                {
                  id: nanoid(), type: "rect", name: `Accent ${nowTag}`,
                  x: canvasSize.width * 0.08, y: canvasSize.height * 0.12,
                  width: canvasSize.width * 0.84, height: canvasSize.height * 0.76,
                  fill: "#ef4444", stroke: "#dc2626", strokeWidth: 0, opacity: 0.16, blendMode: "multiply",
                },
                {
                  id: nanoid(), type: "text", name: `Cover ${nowTag}`,
                  x: canvasSize.width * 0.1, y: canvasSize.height * 0.2,
                  text: "CREATIVE ISSUE", fill: "#111827", fontSize: 72,
                  opacity: 1, blendMode: "source-over", shadowColor: "#000000", shadowBlur: 8, shadowOpacity: 0.25,
                },
                {
                  id: nanoid(), type: "text", name: `Subhead ${nowTag}`,
                  x: canvasSize.width * 0.1, y: canvasSize.height * 0.34,
                  text: "Build visuals that look published", fill: "#1f2937", fontSize: 34,
                  opacity: 0.92, blendMode: "source-over",
                },
                {
                  id: nanoid(), type: "adjustment", name: `Grade ${nowTag}`,
                  brightness: 0.03, contrast: 12, saturation: 0.2,
                },
              ]
            : [
                {
                  id: nanoid(), type: "rect", name: `Board ${nowTag}`,
                  x: 0, y: 0, width: canvasSize.width, height: canvasSize.height,
                  fill: "#0f172a", stroke: "#1e293b", strokeWidth: 0, opacity: 1, blendMode: "source-over",
                },
                {
                  id: nanoid(), type: "rect", name: `Frame ${nowTag}`,
                  x: canvasSize.width * 0.08, y: canvasSize.height * 0.08,
                  width: canvasSize.width * 0.84, height: canvasSize.height * 0.84,
                  fill: "#0f172a", stroke: "#38bdf8", strokeWidth: 2, opacity: 0.9, blendMode: "source-over",
                },
                {
                  id: nanoid(), type: "line", name: `Wire ${nowTag}`,
                  points: [canvasSize.width * 0.12, cy, canvasSize.width * 0.88, cy, null, cx, canvasSize.height * 0.12, cx, canvasSize.height * 0.88],
                  stroke: "#38bdf8", strokeWidth: 2, opacity: 0.8, blendMode: "screen",
                },
                {
                  id: nanoid(), type: "text", name: `Label ${nowTag}`,
                  x: canvasSize.width * 0.14, y: canvasSize.height * 0.14,
                  text: "SYSTEM DESIGN // LUMA", fill: "#7dd3fc", fontSize: 30,
                  opacity: 1, blendMode: "screen",
                },
                {
                  id: nanoid(), type: "adjustment", name: `Boost ${nowTag}`,
                  brightness: 0.06, contrast: 18, saturation: 0.3,
                },
              ];

      const next = [...shapes, ...baseLayers.map((shape, index) => hydrateShape(shape, shapes.length + index))];
      commitShapes(next, { action: `Generated masterpiece (${preset})` });
      setSelectedId(baseLayers[baseLayers.length - 1]?.id ?? null);
      setStatus(`Masterpiece ready: ${preset}`);
    },
    [canvasSize.width, canvasSize.height, shapes, commitShapes],
  );

  const polishSelectedImage = useCallback(() => {
    if (!selectedShape || selectedShape.type !== "image") {
      return;
    }

    const next = shapes.map((shape) => {
      if (shape.id !== selectedShape.id || shape.type !== "image") {
        return shape;
      }

      return {
        ...shape,
        brightness: 0.08,
        contrast: 16,
        saturation: 0.22,
        blurRadius: 0,
        grayscale: 0,
        invert: 0,
        shadowColor: "#000000",
        shadowBlur: 18,
        shadowOffsetX: 0,
        shadowOffsetY: 8,
        shadowOpacity: 0.26,
      };
    });

    commitShapes(next, {
      action: "Applied image polish preset",
      targetId: selectedShape.id,
      targetName: selectedShape.name,
    });
  }, [selectedShape, shapes, commitShapes]);

  const assignSelectedToGroup = useCallback(() => {
    if (!selectedShape) {
      return;
    }
    const nextGroup = window.prompt("Group/Folder name", selectedShape.groupName || "Group 1")?.trim();
    if (!nextGroup) {
      return;
    }
    const next = shapes.map((shape) => (shape.id === selectedShape.id ? { ...shape, groupName: nextGroup } : shape));
    commitShapes(next, {
      action: "Assigned layer to group",
      targetId: selectedShape.id,
      targetName: selectedShape.name,
    });
  }, [selectedShape, shapes, commitShapes]);

  const clearSelectedGroup = useCallback(() => {
    if (!selectedShape?.groupName) {
      return;
    }
    const next = shapes.map((shape) => (shape.id === selectedShape.id ? { ...shape, groupName: undefined } : shape));
    commitShapes(next, {
      action: "Removed layer from group",
      targetId: selectedShape.id,
      targetName: selectedShape.name,
    });
  }, [selectedShape, shapes, commitShapes]);

  const onPointerDown = useCallback(
    (event: PointerLikeEvent) => {
      const rawPointer = getCanvasPointerPosition(event, zoom, pan.x, pan.y);
      const pointer = rawPointer ? placePoint(rawPointer.x, rawPointer.y) : null;
      if (!pointer) {
        return;
      }

      if (tool === "marquee") {
        setMarqueeBox({ x: pointer.x, y: pointer.y, width: 0, height: 0 });
        return;
      }

      if (
        rawPointer &&
        (rawPointer.x < 0 ||
          rawPointer.y < 0 ||
          rawPointer.x > canvasSize.width ||
          rawPointer.y > canvasSize.height)
      ) {
        return;
      }

      if (tool === "select" || tool === "eraser") {
        return;
      }

      if (tool === "rect") {
        setDraftTool(tool);
        setDraftShape({
          id: nanoid(),
          type: "rect",
          name: makeShapeName("rect", shapes.length + 1),
          x: pointer.x,
          y: pointer.y,
          width: 0,
          height: 0,
          fill: fillColor,
          stroke: strokeColor,
          strokeWidth,
          opacity,
          blendMode,
        });
        return;
      }

      if (tool === "ellipse") {
        setDraftTool(tool);
        setDraftShape({
          id: nanoid(),
          type: "ellipse",
          name: makeShapeName("ellipse", shapes.length + 1),
          x: pointer.x,
          y: pointer.y,
          radiusX: 0,
          radiusY: 0,
          fill: fillColor,
          stroke: strokeColor,
          strokeWidth,
          opacity,
          blendMode,
        });
        return;
      }

      if (tool === "line") {
        setDraftTool(tool);
        setDraftShape({
          id: nanoid(),
          type: "line",
          name: "Draft Line",
          points: [pointer.x, pointer.y, pointer.x, pointer.y],
          stroke: strokeColor,
          strokeWidth,
          opacity,
          blendMode,
        });
        return;
      }

      if (tool === "brush") {
        const pressure = pressureBrush ? Math.max(0.2, event.evt?.pressure || 1) : 1;
        setDraftTool(tool);
        setDraftShape({
          id: nanoid(),
          type: "line",
          name: "Draft Brush",
          points: [pointer.x, pointer.y],
          stroke: strokeColor,
          strokeWidth: Number((strokeWidth * pressure).toFixed(2)),
          opacity,
          blendMode,
        });
        return;
      }

      if (tool === "text") {
        const text = window.prompt("Text", "New Text")?.trim();
        if (!text) {
          return;
        }

        const textShape: EditorShape = {
          id: nanoid(),
          type: "text",
          name: makeShapeName("text", shapes.length + 1),
          x: pointer.x,
          y: pointer.y,
          text,
          fill: strokeColor,
          fontSize,
          opacity,
          blendMode,
        };

        commitShapes([...shapes, textShape], {
          action: "Added text layer",
          targetId: textShape.id,
          targetName: textShape.name,
        });
        setSelectedId(textShape.id);
      }
    },
    [
      tool,
      shapes,
      zoom,
      pan.x,
      pan.y,
      placePoint,
      canvasSize.width,
      canvasSize.height,
      fillColor,
      strokeColor,
      strokeWidth,
      pressureBrush,
      opacity,
      fontSize,
      blendMode,
      commitShapes,
    ],
  );

  const onPointerMove = useCallback(
    (event: PointerLikeEvent) => {
      const pointer = getCanvasPointerPosition(event, zoom, pan.x, pan.y);
      if (pointer) {
        const placed = placePoint(pointer.x, pointer.y);
        setCursor({ x: placed.x, y: placed.y });

        if (marqueeBox) {
          setMarqueeBox({
            ...marqueeBox,
            width: placed.x - marqueeBox.x,
            height: placed.y - marqueeBox.y,
          });
        }
      }

      if (!draftShape || !pointer) {
        return;
      }

      if (draftShape.type === "rect") {
        setDraftShape({
          ...draftShape,
          width: pointer.x - draftShape.x,
          height: pointer.y - draftShape.y,
        });
        return;
      }

      if (draftShape.type === "ellipse") {
        setDraftShape({
          ...draftShape,
          radiusX: Math.abs(pointer.x - draftShape.x),
          radiusY: Math.abs(pointer.y - draftShape.y),
        });
        return;
      }

      if (draftShape.type === "line") {
        if (draftTool === "line") {
          setDraftShape({
            ...draftShape,
            points: [draftShape.points[0], draftShape.points[1], pointer.x, pointer.y],
          });
          return;
        }

        setDraftShape({
          ...draftShape,
          points: [...draftShape.points, pointer.x, pointer.y],
        });
      }
    },
    [draftShape, draftTool, zoom, pan.x, pan.y, placePoint, marqueeBox],
  );

  const onPointerUp = useCallback(() => {
    if (marqueeBox) {
      const normalized = normalizeBounds(marqueeBox);
      const target = [...shapes]
        .reverse()
        .find((shape) => {
          if (shape.hidden || shape.type === "adjustment") {
            return false;
          }
          const bounds = getShapeBounds(shape);
          return bounds ? intersectsBounds(normalized, bounds) : false;
        });
      setSelectedId(target?.id ?? null);
      setMarqueeBox(null);
      return;
    }

    if (!draftShape || draftShape.type !== "line") {
      if (draftShape) {
        const normalized = normalizeShape(draftShape);
        commitShapes([...shapes, normalized], {
          action: `Added ${normalized.type} layer`,
          targetId: normalized.id,
          targetName: normalized.name,
        });
        setSelectedId(normalized.id);
      }
      setDraftShape(null);
      setDraftTool(null);
      setSmartGuides([]);
      return;
    }

    const justPoints = draftShape.points.filter((value): value is number => value !== null);
    if (draftTool === "line") {
      appendToDrawLayer(justPoints.slice(0, 4), "line");
    } else {
      appendToDrawLayer(justPoints, "brush");
    }

    setDraftShape(null);
    setDraftTool(null);
    setSmartGuides([]);
  }, [marqueeBox, shapes, draftShape, draftTool, appendToDrawLayer, commitShapes]);

  const onStageLeave = useCallback(() => {
    setCursor(null);
  }, []);

  const onShapeSelect = useCallback(
    (shape: EditorShape) => {
      if (tool === "eraser") {
        if (shape.locked) {
          return;
        }

        const next = shapes.filter((item) => item.id !== shape.id);
        commitShapes(next, {
          action: "Erased layer",
          targetId: shape.id,
          targetName: shape.name,
        });

        if (activeDrawLayerId === shape.id) {
          setActiveDrawLayerId(null);
        }

        if (selectedId === shape.id) {
          setSelectedId(null);
        }
        return;
      }

      setSelectedId(shape.id);
      if (shape.type === "line") {
        setActiveDrawLayerId(shape.id);
      }
    },
    [tool, shapes, commitShapes, activeDrawLayerId, selectedId],
  );

  const undo = useCallback(() => {
    if (past.length === 0) {
      return;
    }
    const previous = past[past.length - 1];
    setPast((prev) => prev.slice(0, -1));
    setFuture((prev) => [copyShapes(shapes), ...prev].slice(0, HISTORY_LIMIT));
    setShapes(copyShapes(previous));
    pendingActionRef.current = { action: "Undo" };
    setSelectedId(null);
  }, [past, shapes]);

  const redo = useCallback(() => {
    if (future.length === 0) {
      return;
    }
    const next = future[0];
    setFuture((prev) => prev.slice(1));
    setPast((prev) => [...prev, copyShapes(shapes)].slice(-HISTORY_LIMIT));
    setShapes(copyShapes(next));
    pendingActionRef.current = { action: "Redo" };
    setSelectedId(null);
  }, [future, shapes]);

  const deleteSelected = useCallback(() => {
    if (!selectedShape) {
      return;
    }

    const next = shapes.filter((shape) => shape.id !== selectedShape.id);
    commitShapes(next, {
      action: "Deleted layer",
      targetId: selectedShape.id,
      targetName: selectedShape.name,
    });

    if (activeDrawLayerId === selectedShape.id) {
      setActiveDrawLayerId(null);
    }
    setSelectedId(null);
  }, [selectedShape, shapes, commitShapes, activeDrawLayerId]);

  const duplicateSelected = useCallback(() => {
    if (!selectedShape) {
      return;
    }

    const duplicated = {
      ...selectedShape,
      id: nanoid(),
      name: `${selectedShape.name} Copy`,
    } as EditorShape;

    if (duplicated.type === "rect" || duplicated.type === "ellipse" || duplicated.type === "text" || duplicated.type === "image") {
      duplicated.x += 20;
      duplicated.y += 20;
    }

    commitShapes([...shapes, duplicated], {
      action: "Duplicated layer",
      targetId: duplicated.id,
      targetName: duplicated.name,
    });
    setSelectedId(duplicated.id);
  }, [selectedShape, shapes, commitShapes]);

  const moveLayer = useCallback(
    (index: number, direction: "up" | "down") => {
      if ((direction === "up" && index === shapes.length - 1) || (direction === "down" && index === 0)) {
        return;
      }

      const target = direction === "up" ? index + 1 : index - 1;
      const next = copyShapes(shapes);
      [next[index], next[target]] = [next[target], next[index]];
      commitShapes(next, { action: `Moved layer ${direction}` });
    },
    [shapes, commitShapes],
  );

  const moveLayerExtreme = useCallback(
    (shapeId: string, to: "top" | "bottom") => {
      const sourceIndex = shapes.findIndex((shape) => shape.id === shapeId);
      if (sourceIndex < 0) {
        return;
      }

      const next = copyShapes(shapes);
      const [item] = next.splice(sourceIndex, 1);
      if (to === "top") {
        next.push(item);
      } else {
        next.unshift(item);
      }

      commitShapes(next, {
        action: to === "top" ? "Moved layer to top" : "Moved layer to bottom",
        targetId: item.id,
        targetName: item.name,
      });
    },
    [shapes, commitShapes],
  );

  const toggleLayerFlag = useCallback(
    (shapeId: string, key: "hidden" | "locked") => {
      const current = shapes.find((shape) => shape.id === shapeId);
      const next = shapes.map((shape) =>
        shape.id === shapeId
          ? {
              ...shape,
              [key]: !shape[key],
            }
          : shape,
      );

      commitShapes(next, {
        action: key === "hidden" ? "Toggled visibility" : "Toggled lock",
        targetId: shapeId,
        targetName: current?.name,
      });
    },
    [shapes, commitShapes],
  );

  const renameLayer = useCallback(
    (shapeId: string) => {
      const shape = shapes.find((item) => item.id === shapeId);
      if (!shape) {
        return;
      }

      const nextName = window.prompt("Layer name", shape.name)?.trim();
      if (!nextName) {
        return;
      }

      commitShapes(
        shapes.map((item) => (item.id === shapeId ? { ...item, name: nextName } : item)),
        {
          action: "Renamed layer",
          targetId: shapeId,
          targetName: nextName,
        },
      );
    },
    [shapes, commitShapes],
  );

  const clearCanvas = useCallback(() => {
    commitShapes([], { action: "Cleared canvas" });
    setSelectedId(null);
    setActiveDrawLayerId(null);
  }, [commitShapes]);

  const startNewDrawLayer = useCallback(() => {
    setActiveDrawLayerId(null);
    setTool("brush");
  }, []);

  const setSelectedAsDrawLayer = useCallback(() => {
    if (selectedShape?.type === "line") {
      setActiveDrawLayerId(selectedShape.id);
      setTool("brush");
    }
  }, [selectedShape]);

  const alignSelected = useCallback(
    (mode: "left" | "center" | "right" | "top" | "middle" | "bottom") => {
      if (!selectedShape || selectedShape.type === "adjustment") {
        return;
      }

      const bounds = getShapeBounds(selectedShape);
      if (!bounds) {
        return;
      }

      let dx = 0;
      let dy = 0;

      if (mode === "left") dx = -bounds.x;
      if (mode === "center") dx = canvasSize.width / 2 - (bounds.x + bounds.width / 2);
      if (mode === "right") dx = canvasSize.width - (bounds.x + bounds.width);
      if (mode === "top") dy = -bounds.y;
      if (mode === "middle") dy = canvasSize.height / 2 - (bounds.y + bounds.height / 2);
      if (mode === "bottom") dy = canvasSize.height - (bounds.y + bounds.height);

      if (dx === 0 && dy === 0) {
        return;
      }

      const next = shapes.map((shape) => (shape.id === selectedShape.id ? moveShapeBy(shape, dx, dy) : shape));
      commitShapes(next, {
        action: `Aligned layer ${mode}`,
        targetId: selectedShape.id,
        targetName: selectedShape.name,
      });
    },
    [selectedShape, canvasSize.width, canvasSize.height, shapes, commitShapes],
  );

  const applyStyleToSelected = useCallback(() => {
    updateSelectedShape((shape) => {
      if (shape.type === "line") {
        return {
          ...shape,
          stroke: strokeColor,
          strokeWidth,
          opacity,
          blendMode,
          shadowColor,
          shadowBlur,
          shadowOffsetX,
          shadowOffsetY,
          shadowOpacity,
        };
      }
      if (shape.type === "text") {
        return {
          ...shape,
          fill: strokeColor,
          fontSize,
          opacity,
          blendMode,
          shadowColor,
          shadowBlur,
          shadowOffsetX,
          shadowOffsetY,
          shadowOpacity,
        };
      }
      if (shape.type === "image") {
        return {
          ...shape,
          opacity,
          blendMode,
          shadowColor,
          shadowBlur,
          shadowOffsetX,
          shadowOffsetY,
          shadowOpacity,
        };
      }
      if (shape.type === "adjustment") {
        return { ...shape, opacity, blendMode };
      }
      return {
        ...shape,
        fill: fillColor,
        stroke: strokeColor,
        strokeWidth,
        opacity,
        blendMode,
        shadowColor,
        shadowBlur,
        shadowOffsetX,
        shadowOffsetY,
        shadowOpacity,
      };
    }, "Updated layer style");
  }, [
    updateSelectedShape,
    strokeColor,
    strokeWidth,
    opacity,
    blendMode,
    fontSize,
    fillColor,
    shadowColor,
    shadowBlur,
    shadowOffsetX,
    shadowOffsetY,
    shadowOpacity,
  ]);

  const copyRoomLink = useCallback(async () => {
    if (!roomId) {
      return;
    }
    await navigator.clipboard.writeText(`${window.location.origin}/?room=${roomId}`);
  }, [roomId]);

  const restoreLocalDraft = useCallback(() => {
    if (!draftStorageKey) {
      return;
    }

    const raw = window.localStorage.getItem(draftStorageKey);
    if (!raw) {
      setStatus("No local draft");
      return;
    }

    try {
      const parsed = JSON.parse(raw) as {
        shapes?: EditorShape[];
        canvasSize?: { width: number; height: number };
        canvasColor?: string;
        guides?: { vertical: number[]; horizontal: number[] };
        showGrid?: boolean;
        gridSize?: number;
      };

      const restoredShapes = Array.isArray(parsed.shapes) ? parsed.shapes.map(hydrateShape) : [];
      setPast([]);
      setFuture([]);
      setShapes(restoredShapes);
      setSelectedId(null);
      setActiveDrawLayerId(restoredShapes.find((shape) => shape.type === "line")?.id ?? null);

      if (parsed.canvasSize?.width && parsed.canvasSize?.height) {
        const width = Math.max(64, Math.min(8000, Math.round(parsed.canvasSize.width)));
        const height = Math.max(64, Math.min(8000, Math.round(parsed.canvasSize.height)));
        setCanvasSize({ width, height });
        setCanvasInput({ width, height });
      }
      if (typeof parsed.canvasColor === "string") {
        setCanvasColor(parsed.canvasColor);
      }
      if (parsed.guides && Array.isArray(parsed.guides.vertical) && Array.isArray(parsed.guides.horizontal)) {
        setGuides({
          vertical: parsed.guides.vertical.filter((value) => Number.isFinite(value)),
          horizontal: parsed.guides.horizontal.filter((value) => Number.isFinite(value)),
        });
      }
      if (typeof parsed.showGrid === "boolean") {
        setShowGrid(parsed.showGrid);
      }
      if (typeof parsed.gridSize === "number" && Number.isFinite(parsed.gridSize)) {
        setGridSize(Math.max(8, Math.min(80, Math.round(parsed.gridSize))));
      }

      pendingActionRef.current = { action: "Restored local draft" };
      setStatus("Draft restored");
    } catch {
      setStatus("Draft restore failed");
    }
  }, [draftStorageKey]);

  const joinRoom = useCallback(() => {
    const nextRoom = joinCode.trim().toUpperCase();
    if (!nextRoom) {
      return;
    }

    setRoomId(nextRoom);
    router.push(`/?room=${nextRoom}`);
    setShapes([]);
    setPast([]);
    setFuture([]);
    setVersion(0);
    setSelectedId(null);
    setActiveDrawLayerId(null);
    setHistory([]);
  }, [joinCode, router]);

  const exportPng = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }

    const dataUrl = stage.toDataURL({ pixelRatio: 2 });
    const anchor = document.createElement("a");
    anchor.href = dataUrl;
    anchor.download = `${roomId || "luma"}-export.png`;
    anchor.click();
  }, [roomId]);

  const exportJson = useCallback(() => {
    const blob = new Blob([JSON.stringify(shapes, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${roomId || "luma"}-scene.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [roomId, shapes]);

  const importAnyFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      try {
        if (file.type.startsWith("image/")) {
          const src = await readFileAsDataUrl(file);
          await addImageLayer(src, file.name.replace(/\.[^.]+$/, ""));
        } else {
          const raw = await file.text();
          const parsed = JSON.parse(raw) as EditorShape[];
          if (Array.isArray(parsed)) {
            const hydrated = parsed.map(hydrateShape);
            commitShapes(hydrated, { action: "Imported scene JSON" });
            setSelectedId(null);
            const activeLine = hydrated.find((shape) => shape.type === "line");
            setActiveDrawLayerId(activeLine?.id || null);
          }
        }
      } catch {
        setStatus("Import failed");
      } finally {
        event.target.value = "";
      }
    },
    [addImageLayer, commitShapes],
  );

  useEffect(() => {
    const onPaste = async (event: ClipboardEvent) => {
      if (!event.clipboardData) {
        return;
      }

      const item = Array.from(event.clipboardData.items).find((entry) => entry.type.startsWith("image/"));
      if (!item) {
        return;
      }

      const file = item.getAsFile();
      if (!file) {
        return;
      }

      event.preventDefault();
      const src = await readFileAsDataUrl(file);
      await addImageLayer(src, "Pasted Image");
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addImageLayer]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        exportJson();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        exportPng();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        generateMasterpiece("cyber");
        return;
      }

      if ((event.ctrlKey || event.metaKey) && ["d", "j"].includes(event.key.toLowerCase())) {
        event.preventDefault();
        duplicateSelected();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
        event.preventDefault();
        startNewDrawLayer();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key === "0") {
        event.preventDefault();
        setZoom(1);
        setPan({ x: 0, y: 0 });
        return;
      }

      if ((event.ctrlKey || event.metaKey) && ["+", "="].includes(event.key)) {
        event.preventDefault();
        nudgeZoom(0.1);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key === "-") {
        event.preventDefault();
        nudgeZoom(-0.1);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelected();
        return;
      }

      if (event.key === "[") {
        setStrokeWidth((value) => Math.max(1, value - 1));
        return;
      }

      if (event.key === "]") {
        setStrokeWidth((value) => Math.min(50, value + 1));
        return;
      }

      if (event.key.toLowerCase() === "g") {
        setShowGrid((value) => !value);
        return;
      }

      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && selectedShape && selectedShape.type !== "adjustment") {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        const next = shapes.map((shape) => (shape.id === selectedShape.id ? moveShapeBy(shape, dx, dy) : shape));
        commitShapes(next, {
          action: "Nudged layer",
          targetId: selectedShape.id,
          targetName: selectedShape.name,
        });
        return;
      }

      const map: Record<string, EditorTool> = {
        v: "select",
        m: "marquee",
        r: "rect",
        e: "ellipse",
        l: "line",
        b: "brush",
        t: "text",
        x: "eraser",
      };

      const next = map[event.key.toLowerCase()];
      if (next) {
        setTool(next);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    undo,
    redo,
    deleteSelected,
    exportJson,
    exportPng,
    duplicateSelected,
    startNewDrawLayer,
    nudgeZoom,
    generateMasterpiece,
    selectedShape,
    shapes,
    commitShapes,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift") {
        setIsShiftPressed(true);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") {
        setIsShiftPressed(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  const renderShape = (shape: EditorShape, shapeIndex: number) => {
    if (shape.type === "adjustment") {
      return null;
    }

    const common = {
      opacity: shape.opacity ?? 1,
      globalCompositeOperation: shape.blendMode ?? "source-over",
      shadowColor: shape.shadowColor,
      shadowBlur: shape.shadowBlur || 0,
      shadowOffsetX: shape.shadowOffsetX || 0,
      shadowOffsetY: shape.shadowOffsetY || 0,
      shadowOpacity: shape.shadowOpacity || 0,
      onClick: () => onShapeSelect(shape),
      onTap: () => onShapeSelect(shape),
    };

    if (shape.type === "rect") {
      return (
        <Rect
          key={shape.id}
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          fill={shape.fill}
          stroke={shape.stroke}
          strokeWidth={shape.strokeWidth}
          draggable={tool === "select" && !shape.locked}
          onDragMove={(event) => {
            const bounds = getShapeBounds({ ...shape, x: event.target.x(), y: event.target.y() });
            if (bounds) {
              computeSmartGuides(shape.id, bounds);
            }
          }}
          onDragEnd={(event) => {
            const snapped = placePoint(event.target.x(), event.target.y());
            const next = shapes.map((item) =>
              item.id === shape.id ? { ...item, x: snapped.x, y: snapped.y } : item,
            );
            commitShapes(next, { action: "Moved layer", targetId: shape.id, targetName: shape.name });
            setSmartGuides([]);
          }}
          {...common}
        />
      );
    }

    if (shape.type === "ellipse") {
      return (
        <Ellipse
          key={shape.id}
          x={shape.x}
          y={shape.y}
          radiusX={shape.radiusX}
          radiusY={shape.radiusY}
          fill={shape.fill}
          stroke={shape.stroke}
          strokeWidth={shape.strokeWidth}
          draggable={tool === "select" && !shape.locked}
          onDragMove={(event) => {
            const bounds = getShapeBounds({ ...shape, x: event.target.x(), y: event.target.y() });
            if (bounds) {
              computeSmartGuides(shape.id, bounds);
            }
          }}
          onDragEnd={(event) => {
            const snapped = placePoint(event.target.x(), event.target.y());
            const next = shapes.map((item) =>
              item.id === shape.id ? { ...item, x: snapped.x, y: snapped.y } : item,
            );
            commitShapes(next, { action: "Moved layer", targetId: shape.id, targetName: shape.name });
            setSmartGuides([]);
          }}
          {...common}
        />
      );
    }

    if (shape.type === "text") {
      return (
        <Text
          key={shape.id}
          text={shape.text}
          x={shape.x}
          y={shape.y}
          fontSize={shape.fontSize}
          fill={shape.fill}
          draggable={tool === "select" && !shape.locked}
          onDragMove={(event) => {
            const bounds = getShapeBounds({ ...shape, x: event.target.x(), y: event.target.y() });
            if (bounds) {
              computeSmartGuides(shape.id, bounds);
            }
          }}
          onDblClick={() => {
            if (shape.locked) {
              return;
            }
            const value = window.prompt("Edit text", shape.text)?.trim();
            if (!value) {
              return;
            }
            const next = shapes.map((item) =>
              item.id === shape.id && item.type === "text" ? { ...item, text: value } : item,
            );
            commitShapes(next, { action: "Edited text", targetId: shape.id, targetName: shape.name });
          }}
          onDragEnd={(event) => {
            const snapped = placePoint(event.target.x(), event.target.y());
            const next = shapes.map((item) =>
              item.id === shape.id ? { ...item, x: snapped.x, y: snapped.y } : item,
            );
            commitShapes(next, { action: "Moved layer", targetId: shape.id, targetName: shape.name });
            setSmartGuides([]);
          }}
          {...common}
        />
      );
    }

    if (shape.type === "image") {
      const effectiveImage: ImageShape = {
        ...shape,
        brightness: Math.max(-1, Math.min(1, (shape.brightness || 0) + globalAdjustment.brightness)),
        contrast: Math.max(-100, Math.min(100, (shape.contrast || 0) + globalAdjustment.contrast)),
        saturation: Math.max(-2, Math.min(2, (shape.saturation || 0) + globalAdjustment.saturation)),
      };

      let clipBounds: ShapeBounds | null = null;
      if (shape.clipToPrevious) {
        for (let index = shapeIndex - 1; index >= 0; index -= 1) {
          const previous = shapes[index];
          if (!previous || previous.hidden || previous.type === "adjustment") {
            continue;
          }
          clipBounds = getShapeBounds(previous);
          if (clipBounds) {
            break;
          }
        }
      }

      const imageNode = (
        <CanvasImageShape
          key={shape.id}
          shape={effectiveImage}
          selected={selectedId === shape.id}
          canDrag={tool === "select" && !shape.locked}
          canTransform={tool === "select" && !shape.locked}
          keepRatio={lockImageRatio || isShiftPressed}
          onSelect={() => onShapeSelect(shape)}
          onDragMove={(x, y) => {
            const bounds = getShapeBounds({ ...shape, x, y });
            if (bounds) {
              computeSmartGuides(shape.id, bounds);
            }
          }}
          onDrag={(x, y) => {
            const snapped = placePoint(x, y);
            const next = shapes.map((item) =>
              item.id === shape.id ? { ...item, x: snapped.x, y: snapped.y } : item,
            );
            commitShapes(next, {
              action: "Moved image layer",
              targetId: shape.id,
              targetName: shape.name,
            });
            setSmartGuides([]);
          }}
          onTransform={(nextRect) => {
            const snapped = placePoint(nextRect.x, nextRect.y);
            const clampedX = Math.max(0, Math.min(canvasSize.width - nextRect.width, snapped.x));
            const clampedY = Math.max(0, Math.min(canvasSize.height - nextRect.height, snapped.y));
            const next = shapes.map((item) =>
              item.id === shape.id && item.type === "image"
                ? {
                    ...item,
                    x: clampedX,
                    y: clampedY,
                    width: nextRect.width,
                    height: nextRect.height,
                    rotation: nextRect.rotation,
                  }
                : item,
            );
            commitShapes(next, {
              action: "Transformed image layer",
              targetId: shape.id,
              targetName: shape.name,
            });
            setSmartGuides([]);
          }}
        />
      );

      if (clipBounds) {
        return (
          <Group key={shape.id} clipX={clipBounds.x} clipY={clipBounds.y} clipWidth={clipBounds.width} clipHeight={clipBounds.height}>
            {imageNode}
          </Group>
        );
      }

      return imageNode;
    }

    const segments = splitSegments(shape.points);
    return (
      <Fragment key={shape.id}>
        {segments.map((segment, index) => (
          <Line
            key={`${shape.id}-${index}`}
            points={segment}
            stroke={shape.stroke}
            strokeWidth={shape.strokeWidth}
            lineCap="round"
            lineJoin="round"
            {...common}
          />
        ))}
      </Fragment>
    );
  };

  return (
    <div className="h-screen overflow-hidden bg-zinc-100 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="h-14 border-b border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex h-full max-w-[1800px] items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-base font-semibold">Luma</h1>
            <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">Paste images, paint on reusable draw layers, collaborate live</p>
          </div>

          <div className="flex items-center gap-1 text-xs">
            <span className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">Room {roomId || "..."}</span>
            <span className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">{status}</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Name"
              className="w-24 rounded border border-zinc-300 bg-white px-2 py-1 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button
              type="button"
              onClick={copyRoomLink}
              className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Copy Link
            </button>
            <input
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value)}
              placeholder="Room"
              className="w-20 rounded border border-zinc-300 bg-white px-2 py-1 outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button
              type="button"
              onClick={joinRoom}
              className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Join
            </button>
            <button type="button" onClick={exportPng} title="Export PNG" className="rounded border border-zinc-300 p-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
              <Download size={14} />
            </button>
            <button type="button" onClick={exportJson} title="Export JSON" className="rounded border border-zinc-300 p-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
              <Upload size={14} />
            </button>
            <label title="Import image or JSON" className="cursor-pointer rounded border border-zinc-300 p-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
              <ImageIcon size={14} />
              <input type="file" accept="image/*,application/json" className="hidden" onChange={importAnyFile} />
            </label>
          </div>
        </div>
      </header>

      <main className="mx-auto grid h-[calc(100vh-56px)] max-w-[1800px] grid-cols-[60px_minmax(0,1fr)_360px] gap-3 p-3">
        <aside className="min-h-0 rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex flex-col gap-2">
            {TOOL_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.value}
                  type="button"
                  title={`${item.label} (${item.keyHint})`}
                  onClick={() => setTool(item.value)}
                  className={`rounded p-2 ${
                    tool === item.value
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  }`}
                >
                  <Icon size={18} className="mx-auto" />
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex flex-col gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <button type="button" title="Undo" onClick={undo} disabled={past.length === 0} className="rounded border border-zinc-300 p-2 disabled:opacity-40 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
              <Undo2 size={18} className="mx-auto" />
            </button>
            <button type="button" title="Redo" onClick={redo} disabled={future.length === 0} className="rounded border border-zinc-300 p-2 disabled:opacity-40 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
              <Redo2 size={18} className="mx-auto" />
            </button>
            <button type="button" title="Duplicate selected" onClick={duplicateSelected} disabled={!selectedShape} className="rounded border border-zinc-300 p-2 disabled:opacity-40 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
              <Copy size={18} className="mx-auto" />
            </button>
            <button type="button" title="Delete selected" onClick={deleteSelected} disabled={!selectedShape} className="rounded border border-zinc-300 p-2 disabled:opacity-40 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
              <Trash2 size={18} className="mx-auto" />
            </button>
          </div>
        </aside>

        <section ref={stageShellRef} className="min-h-0 rounded-lg border border-zinc-200 bg-white p-1.5 dark:border-zinc-800 dark:bg-zinc-900">
          <Stage
            ref={stageRef}
            width={stageSize.width}
            height={stageSize.height}
            className="rounded border border-zinc-200 bg-white dark:border-zinc-800"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onMouseLeave={onStageLeave}
            onWheel={(event) => {
              event.evt.preventDefault();

              if (event.evt.ctrlKey || event.evt.metaKey) {
                const stage = stageRef.current;
                const pointer = stage?.getPointerPosition();
                if (!pointer) {
                  return;
                }

                const oldScale = zoom;
                const direction = event.evt.deltaY > 0 ? -1 : 1;
                const nextScale = Math.min(4, Math.max(0.25, oldScale + direction * 0.08));

                const mousePointTo = {
                  x: (pointer.x - pan.x) / oldScale,
                  y: (pointer.y - pan.y) / oldScale,
                };

                setZoom(nextScale);
                setPan({
                  x: pointer.x - mousePointTo.x * nextScale,
                  y: pointer.y - mousePointTo.y * nextScale,
                });
                return;
              }

              setPan((current) => ({
                x: current.x - event.evt.deltaX,
                y: current.y - event.evt.deltaY,
              }));
            }}
            onMouseDown={(event) => {
              if (event.target === event.target.getStage()) {
                setSelectedId(null);
                setSmartGuides([]);
              }
            }}
          >
            <Layer>
              <Group x={pan.x} y={pan.y} scaleX={zoom} scaleY={zoom} listening={false}>
                <Rect
                  x={-20000}
                  y={-20000}
                  width={40000}
                  height={40000}
                  fill="#e4e4e7"
                />
                {showRulers && (
                  <Fragment>
                    <Rect x={0} y={-20} width={canvasSize.width} height={20} fill="#f4f4f5" stroke="#d4d4d8" strokeWidth={0.5} />
                    <Rect x={-20} y={0} width={20} height={canvasSize.height} fill="#f4f4f5" stroke="#d4d4d8" strokeWidth={0.5} />
                    {Array.from({ length: Math.floor(canvasSize.width / 100) + 1 }).map((_, index) => {
                      const x = index * 100;
                      return <Line key={`ruler-x-${x}`} points={[x, -20, x, -8]} stroke="#71717a" strokeWidth={0.5} />;
                    })}
                    {Array.from({ length: Math.floor(canvasSize.height / 100) + 1 }).map((_, index) => {
                      const y = index * 100;
                      return <Line key={`ruler-y-${y}`} points={[-20, y, -8, y]} stroke="#71717a" strokeWidth={0.5} />;
                    })}
                  </Fragment>
                )}
                <Rect
                  x={0}
                  y={0}
                  width={canvasSize.width}
                  height={canvasSize.height}
                  fill={canvasColor}
                  stroke="#71717a"
                  strokeWidth={1}
                  shadowColor="#00000022"
                  shadowBlur={8}
                  shadowOffset={{ x: 0, y: 2 }}
                />
              </Group>

              <Group x={pan.x} y={pan.y} scaleX={zoom} scaleY={zoom} clipX={0} clipY={0} clipWidth={canvasSize.width} clipHeight={canvasSize.height}>
                {gridLines.vertical.map((x) => (
                  <Line
                    key={`grid-v-${x}`}
                    points={[x, 0, x, canvasSize.height]}
                    stroke="#d4d4d8"
                    strokeWidth={0.5}
                    listening={false}
                  />
                ))}
                {gridLines.horizontal.map((y) => (
                  <Line
                    key={`grid-h-${y}`}
                    points={[0, y, canvasSize.width, y]}
                    stroke="#d4d4d8"
                    strokeWidth={0.5}
                    listening={false}
                  />
                ))}

                {showThirds && (
                  <Fragment>
                    <Line points={[canvasSize.width / 3, 0, canvasSize.width / 3, canvasSize.height]} stroke="#f59e0b" strokeWidth={1} dash={[4, 4]} listening={false} />
                    <Line points={[(canvasSize.width * 2) / 3, 0, (canvasSize.width * 2) / 3, canvasSize.height]} stroke="#f59e0b" strokeWidth={1} dash={[4, 4]} listening={false} />
                    <Line points={[0, canvasSize.height / 3, canvasSize.width, canvasSize.height / 3]} stroke="#f59e0b" strokeWidth={1} dash={[4, 4]} listening={false} />
                    <Line points={[0, (canvasSize.height * 2) / 3, canvasSize.width, (canvasSize.height * 2) / 3]} stroke="#f59e0b" strokeWidth={1} dash={[4, 4]} listening={false} />
                  </Fragment>
                )}

                {showSafeArea && (
                  <Rect
                    x={canvasSize.width * 0.05}
                    y={canvasSize.height * 0.05}
                    width={canvasSize.width * 0.9}
                    height={canvasSize.height * 0.9}
                    stroke="#22c55e"
                    strokeWidth={1}
                    dash={[8, 6]}
                    listening={false}
                  />
                )}

                {showGuides && guides.vertical.map((x, index) => (
                  <Line key={`guide-v-${index}-${x}`} points={[x, 0, x, canvasSize.height]} stroke="#0ea5e9" strokeWidth={1} dash={[6, 4]} listening={false} />
                ))}
                {showGuides && guides.horizontal.map((y, index) => (
                  <Line key={`guide-h-${index}-${y}`} points={[0, y, canvasSize.width, y]} stroke="#0ea5e9" strokeWidth={1} dash={[6, 4]} listening={false} />
                ))}

                {smartGuides.map((line, index) => (
                  <Line key={`smart-guide-${index}`} points={line.points} stroke="#2563eb" strokeWidth={1} dash={[3, 3]} listening={false} />
                ))}

                {shapes.map((shape, index) => (shape.hidden ? null : renderShape(shape, index)))}

                {draftShape?.type === "rect" && (
                  <Rect
                    x={draftShape.x}
                    y={draftShape.y}
                    width={draftShape.width}
                    height={draftShape.height}
                    fill={draftShape.fill}
                    stroke={draftShape.stroke}
                    strokeWidth={draftShape.strokeWidth}
                    opacity={draftShape.opacity ?? 1}
                    globalCompositeOperation={draftShape.blendMode ?? "source-over"}
                  />
                )}

                {draftShape?.type === "ellipse" && (
                  <Ellipse
                    x={draftShape.x}
                    y={draftShape.y}
                    radiusX={draftShape.radiusX}
                    radiusY={draftShape.radiusY}
                    fill={draftShape.fill}
                    stroke={draftShape.stroke}
                    strokeWidth={draftShape.strokeWidth}
                    opacity={draftShape.opacity ?? 1}
                    globalCompositeOperation={draftShape.blendMode ?? "source-over"}
                  />
                )}

                {draftShape?.type === "line" && (
                  <Line
                    points={draftShape.points.filter((value): value is number => value !== null)}
                    stroke={draftShape.stroke}
                    strokeWidth={draftShape.strokeWidth}
                    opacity={draftShape.opacity ?? 1}
                    lineCap="round"
                    lineJoin="round"
                    globalCompositeOperation={draftShape.blendMode ?? "source-over"}
                  />
                )}

                {marqueeBox && (
                  <Rect
                    x={normalizeBounds(marqueeBox).x}
                    y={normalizeBounds(marqueeBox).y}
                    width={normalizeBounds(marqueeBox).width}
                    height={normalizeBounds(marqueeBox).height}
                    fill="#2563eb22"
                    stroke="#2563eb"
                    strokeWidth={1}
                    dash={[6, 4]}
                    listening={false}
                  />
                )}
              </Group>
            </Layer>

            <Layer listening={false}>
              {showCursors && peers.map((peer) => (
                <Fragment key={peer.clientId}>
                  {typeof peer.x === "number" && typeof peer.y === "number" && (
                    <Circle x={pan.x + peer.x * zoom} y={pan.y + peer.y * zoom} radius={4} fill={peer.color} />
                  )}
                  {typeof peer.x === "number" && typeof peer.y === "number" && (
                    <Text x={pan.x + peer.x * zoom + 8} y={pan.y + peer.y * zoom - 7} text={peer.name} fontSize={12} fill={peer.color} />
                  )}
                </Fragment>
              ))}
            </Layer>
          </Stage>
        </section>

        <aside className="min-h-0 overflow-auto rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-semibold">Inspector</h2>

          <div className="space-y-3 rounded border border-zinc-200 p-3 text-xs dark:border-zinc-700">
            <label className="flex items-center justify-between gap-2">
              Fill
              <input type="color" value={fillColor} onChange={(event) => setFillColor(event.target.value)} className="h-7 w-9" />
            </label>
            <label className="flex items-center justify-between gap-2">
              Stroke
              <input type="color" value={strokeColor} onChange={(event) => setStrokeColor(event.target.value)} className="h-7 w-9" />
            </label>
            <label className="grid gap-1">
              Stroke Width {strokeWidth}px
              <input type="range" min={1} max={20} value={strokeWidth} onChange={(event) => setStrokeWidth(Number(event.target.value))} />
            </label>
            <label className="grid gap-1">
              Opacity {(opacity * 100).toFixed(0)}%
              <input type="range" min={0.1} max={1} step={0.05} value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} />
            </label>
            <label className="grid gap-1">
              Text Size {fontSize}px
              <input type="range" min={12} max={72} value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))} />
            </label>
            <label className="grid gap-1">
              Blend Mode
              <select value={blendMode} onChange={(event) => setBlendMode(event.target.value as BlendMode)} className="rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900">
                {BLEND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <div className="rounded border border-zinc-300 p-2 dark:border-zinc-700">
              <p className="mb-2 text-[11px] font-semibold">Layer FX (Drop Shadow)</p>
              <label className="mb-1 flex items-center justify-between gap-2">
                Shadow Color
                <input type="color" value={shadowColor} onChange={(event) => setShadowColor(event.target.value)} className="h-7 w-9" />
              </label>
              <label className="grid gap-1">
                Shadow Blur {Math.round(shadowBlur)}
                <input type="range" min={0} max={60} value={shadowBlur} onChange={(event) => setShadowBlur(Number(event.target.value))} />
              </label>
              <label className="grid gap-1">
                Shadow Offset X {Math.round(shadowOffsetX)}
                <input type="range" min={-80} max={80} value={shadowOffsetX} onChange={(event) => setShadowOffsetX(Number(event.target.value))} />
              </label>
              <label className="grid gap-1">
                Shadow Offset Y {Math.round(shadowOffsetY)}
                <input type="range" min={-80} max={80} value={shadowOffsetY} onChange={(event) => setShadowOffsetY(Number(event.target.value))} />
              </label>
              <label className="grid gap-1">
                Shadow Opacity {Math.round(shadowOpacity * 100)}%
                <input type="range" min={0} max={1} step={0.01} value={shadowOpacity} onChange={(event) => setShadowOpacity(Number(event.target.value))} />
              </label>
            </div>
            <div className="rounded border border-zinc-300 p-2 dark:border-zinc-700">
              <p className="mb-2 text-[11px] font-semibold">Align To Canvas</p>
              <div className="grid grid-cols-3 gap-1">
                <button type="button" onClick={() => alignSelected("left")} disabled={!selectedShape || selectedShape.type === "adjustment"} className="rounded border border-zinc-300 px-2 py-1 disabled:opacity-40 dark:border-zinc-700">Left</button>
                <button type="button" onClick={() => alignSelected("center")} disabled={!selectedShape || selectedShape.type === "adjustment"} className="rounded border border-zinc-300 px-2 py-1 disabled:opacity-40 dark:border-zinc-700">Center</button>
                <button type="button" onClick={() => alignSelected("right")} disabled={!selectedShape || selectedShape.type === "adjustment"} className="rounded border border-zinc-300 px-2 py-1 disabled:opacity-40 dark:border-zinc-700">Right</button>
                <button type="button" onClick={() => alignSelected("top")} disabled={!selectedShape || selectedShape.type === "adjustment"} className="rounded border border-zinc-300 px-2 py-1 disabled:opacity-40 dark:border-zinc-700">Top</button>
                <button type="button" onClick={() => alignSelected("middle")} disabled={!selectedShape || selectedShape.type === "adjustment"} className="rounded border border-zinc-300 px-2 py-1 disabled:opacity-40 dark:border-zinc-700">Middle</button>
                <button type="button" onClick={() => alignSelected("bottom")} disabled={!selectedShape || selectedShape.type === "adjustment"} className="rounded border border-zinc-300 px-2 py-1 disabled:opacity-40 dark:border-zinc-700">Bottom</button>
              </div>
            </div>
            <div className="rounded border border-zinc-300 p-2 dark:border-zinc-700">
              <p className="mb-2 text-[11px] font-semibold">Settings</p>
              <div className="mb-2 flex items-center justify-between gap-2">
                <span>Zoom {(zoom * 100).toFixed(0)}%</span>
                <div className="flex gap-1">
                  <button type="button" onClick={() => nudgeZoom(-0.1)} className="rounded border border-zinc-300 px-2 py-0.5 dark:border-zinc-700">-</button>
                  <button type="button" onClick={() => nudgeZoom(0.1)} className="rounded border border-zinc-300 px-2 py-0.5 dark:border-zinc-700">+</button>
                  <button type="button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} className="rounded border border-zinc-300 px-2 py-0.5 dark:border-zinc-700">Reset</button>
                </div>
              </div>
              <label className="mb-1 flex items-center justify-between gap-2">
                Grid
                <input type="checkbox" checked={showGrid} onChange={(event) => setShowGrid(event.target.checked)} />
              </label>
              <label className="mb-1 flex items-center justify-between gap-2">
                Snap To Grid
                <input type="checkbox" checked={snapToGrid} onChange={(event) => setSnapToGrid(event.target.checked)} />
              </label>
              <label className="mb-1 flex items-center justify-between gap-2">
                Show Cursors
                <input type="checkbox" checked={showCursors} onChange={(event) => setShowCursors(event.target.checked)} />
              </label>
              <label className="mb-1 flex items-center justify-between gap-2">
                Show Rulers
                <input type="checkbox" checked={showRulers} onChange={(event) => setShowRulers(event.target.checked)} />
              </label>
              <label className="mb-1 flex items-center justify-between gap-2">
                Show Guides
                <input type="checkbox" checked={showGuides} onChange={(event) => setShowGuides(event.target.checked)} />
              </label>
              <label className="mb-1 flex items-center justify-between gap-2">
                Rule of Thirds
                <input type="checkbox" checked={showThirds} onChange={(event) => setShowThirds(event.target.checked)} />
              </label>
              <label className="mb-1 flex items-center justify-between gap-2">
                Safe Area
                <input type="checkbox" checked={showSafeArea} onChange={(event) => setShowSafeArea(event.target.checked)} />
              </label>
              <label className="mb-1 flex items-center justify-between gap-2">
                Pressure Brush
                <input type="checkbox" checked={pressureBrush} onChange={(event) => setPressureBrush(event.target.checked)} />
              </label>
              <label className="mb-1 flex items-center justify-between gap-2">
                Lock Image Ratio
                <input type="checkbox" checked={lockImageRatio} onChange={(event) => setLockImageRatio(event.target.checked)} />
              </label>
              <label className="grid gap-1">
                Grid Size {gridSize}px
                <input type="range" min={8} max={80} value={gridSize} onChange={(event) => setGridSize(Number(event.target.value))} />
              </label>
              <div className="mt-1 grid grid-cols-3 gap-1">
                <button type="button" onClick={() => setGuides((prev) => ({ ...prev, vertical: [...prev.vertical, Math.round(canvasSize.width / 2)] }))} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">Add V Guide</button>
                <button type="button" onClick={() => setGuides((prev) => ({ ...prev, horizontal: [...prev.horizontal, Math.round(canvasSize.height / 2)] }))} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">Add H Guide</button>
                <button type="button" onClick={() => setGuides({ vertical: [], horizontal: [] })} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">Clear</button>
              </div>
              <div className="mt-2 rounded border border-zinc-300 p-2 dark:border-zinc-700">
                <p className="mb-2 text-[11px] font-semibold">Canvas Size</p>
                <div className="mb-2 grid grid-cols-2 gap-2">
                  <label className="grid gap-1">
                    Width
                    <input
                      type="number"
                      min={64}
                      max={8000}
                      value={canvasInput.width}
                      onChange={(event) => setCanvasInput((prev) => ({ ...prev, width: Number(event.target.value) }))}
                      className="rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                    />
                  </label>
                  <label className="grid gap-1">
                    Height
                    <input
                      type="number"
                      min={64}
                      max={8000}
                      value={canvasInput.height}
                      onChange={(event) => setCanvasInput((prev) => ({ ...prev, height: Number(event.target.value) }))}
                      className="rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                    />
                  </label>
                </div>
                <label className="mb-2 flex items-center justify-between gap-2">
                  Canvas Color
                  <input type="color" value={canvasColor} onChange={(event) => setCanvasColor(event.target.value)} className="h-7 w-9" />
                </label>
                <div className="mb-2 flex flex-wrap gap-1">
                  <button type="button" onClick={() => setCanvasInput({ width: 1920, height: 1080 })} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">1080p</button>
                  <button type="button" onClick={() => setCanvasInput({ width: 1080, height: 1080 })} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">Square</button>
                  <button type="button" onClick={() => setCanvasInput({ width: 1080, height: 1920 })} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">Story</button>
                  <button type="button" onClick={() => setCanvasInput({ width: 3508, height: 2480 })} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">A4 300dpi</button>
                </div>
                <div className="flex gap-1">
                  <button type="button" onClick={applyCanvasSize} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">Apply</button>
                  <button type="button" onClick={fitCanvasToViewport} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">Fit To View</button>
                </div>
                <p className="mt-1 text-[11px] text-zinc-500">Current: {canvasSize.width} × {canvasSize.height}</p>
              </div>

              <div className="mt-2 rounded border border-zinc-300 p-2 dark:border-zinc-700">
                <p className="mb-2 text-[11px] font-semibold">Publishing Prep</p>
                <button
                  type="button"
                  onClick={restoreLocalDraft}
                  disabled={!localDraftAvailable}
                  className="mb-2 w-full rounded border border-zinc-300 px-2 py-1 disabled:opacity-40 dark:border-zinc-700"
                >
                  Restore Local Draft
                </button>
                <div className="grid grid-cols-3 gap-1">
                  <button type="button" onClick={() => generateMasterpiece("cyber")} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">Cyber</button>
                  <button type="button" onClick={() => generateMasterpiece("magazine")} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">Magazine</button>
                  <button type="button" onClick={() => generateMasterpiece("blueprint")} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">Blueprint</button>
                </div>
                <p className="mt-1 text-[11px] text-zinc-500">Autosave is active for this room.</p>
              </div>
            </div>
            <button type="button" onClick={applyStyleToSelected} disabled={!selectedShape} className="w-full rounded border border-zinc-300 px-2 py-1.5 disabled:opacity-40 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
              Apply Style to Selected
            </button>
            <button type="button" onClick={clearCanvas} className="w-full rounded border border-zinc-300 px-2 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
              Clear Canvas
            </button>
          </div>

          {selectedShape?.type === "image" && (
            <div className="mt-3 space-y-2 rounded border border-zinc-200 p-3 text-xs dark:border-zinc-700">
              <p className="font-semibold">Image Editing</p>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">Resize directly on canvas using the transform handles.</p>
              <button
                type="button"
                onClick={polishSelectedImage}
                className="w-full rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                Auto Polish Image
              </button>
              <label className="grid gap-1">
                Rotation {Math.round(selectedShape.rotation || 0)}°
                <input
                  type="range"
                  min={-180}
                  max={180}
                  value={selectedShape.rotation || 0}
                  onChange={(event) => {
                    const rotation = Number(event.target.value);
                    updateSelectedShape((shape) =>
                      shape.type === "image" ? { ...shape, rotation } : shape,
                      "Rotated image",
                    );
                  }}
                />
              </label>
              <label className="flex items-center justify-between gap-2">
                Clip To Previous Layer
                <input
                  type="checkbox"
                  checked={Boolean(selectedShape.clipToPrevious)}
                  onChange={(event) => {
                    const clipToPrevious = event.target.checked;
                    updateSelectedShape((shape) =>
                      shape.type === "image" ? { ...shape, clipToPrevious } : shape,
                      clipToPrevious ? "Enabled clipping mask" : "Disabled clipping mask",
                    );
                  }}
                />
              </label>
              <label className="grid gap-1">
                Brightness {Math.round((selectedShape.brightness || 0) * 100)}
                <input
                  type="range"
                  min={-1}
                  max={1}
                  step={0.01}
                  value={selectedShape.brightness || 0}
                  onChange={(event) => {
                    const brightness = Number(event.target.value);
                    updateSelectedShape((shape) =>
                      shape.type === "image" ? { ...shape, brightness } : shape,
                      "Adjusted brightness",
                    );
                  }}
                />
              </label>
              <label className="grid gap-1">
                Contrast {Math.round(selectedShape.contrast || 0)}
                <input
                  type="range"
                  min={-100}
                  max={100}
                  step={1}
                  value={selectedShape.contrast || 0}
                  onChange={(event) => {
                    const contrast = Number(event.target.value);
                    updateSelectedShape((shape) =>
                      shape.type === "image" ? { ...shape, contrast } : shape,
                      "Adjusted contrast",
                    );
                  }}
                />
              </label>
              <label className="grid gap-1">
                Saturation {Math.round(selectedShape.saturation || 0)}
                <input
                  type="range"
                  min={-2}
                  max={2}
                  step={0.05}
                  value={selectedShape.saturation || 0}
                  onChange={(event) => {
                    const saturation = Number(event.target.value);
                    updateSelectedShape((shape) =>
                      shape.type === "image" ? { ...shape, saturation } : shape,
                      "Adjusted saturation",
                    );
                  }}
                />
              </label>
              <label className="grid gap-1">
                Blur {Math.round(selectedShape.blurRadius || 0)}
                <input
                  type="range"
                  min={0}
                  max={40}
                  step={1}
                  value={selectedShape.blurRadius || 0}
                  onChange={(event) => {
                    const blurRadius = Number(event.target.value);
                    updateSelectedShape((shape) =>
                      shape.type === "image" ? { ...shape, blurRadius } : shape,
                      "Adjusted blur",
                    );
                  }}
                />
              </label>
              <label className="flex items-center justify-between gap-2">
                Grayscale
                <input
                  type="checkbox"
                  checked={Boolean(selectedShape.grayscale)}
                  onChange={(event) => {
                    const grayscale = event.target.checked ? 1 : 0;
                    updateSelectedShape((shape) =>
                      shape.type === "image" ? { ...shape, grayscale } : shape,
                      "Toggled grayscale",
                    );
                  }}
                />
              </label>
              <label className="flex items-center justify-between gap-2">
                Invert
                <input
                  type="checkbox"
                  checked={Boolean(selectedShape.invert)}
                  onChange={(event) => {
                    const invert = event.target.checked ? 1 : 0;
                    updateSelectedShape((shape) =>
                      shape.type === "image" ? { ...shape, invert } : shape,
                      "Toggled invert",
                    );
                  }}
                />
              </label>
            </div>
          )}

          {selectedShape?.type === "adjustment" && (
            <div className="mt-3 space-y-2 rounded border border-zinc-200 p-3 text-xs dark:border-zinc-700">
              <p className="font-semibold">Adjustment Layer</p>
              <label className="grid gap-1">
                Brightness {Math.round((selectedShape.brightness || 0) * 100)}
                <input
                  type="range"
                  min={-1}
                  max={1}
                  step={0.01}
                  value={selectedShape.brightness || 0}
                  onChange={(event) => {
                    const brightness = Number(event.target.value);
                    updateSelectedShape((shape) =>
                      shape.type === "adjustment" ? { ...shape, brightness } : shape,
                      "Adjusted layer brightness",
                    );
                  }}
                />
              </label>
              <label className="grid gap-1">
                Contrast {Math.round(selectedShape.contrast || 0)}
                <input
                  type="range"
                  min={-100}
                  max={100}
                  value={selectedShape.contrast || 0}
                  onChange={(event) => {
                    const contrast = Number(event.target.value);
                    updateSelectedShape((shape) =>
                      shape.type === "adjustment" ? { ...shape, contrast } : shape,
                      "Adjusted layer contrast",
                    );
                  }}
                />
              </label>
              <label className="grid gap-1">
                Saturation {Math.round(selectedShape.saturation || 0)}
                <input
                  type="range"
                  min={-2}
                  max={2}
                  step={0.05}
                  value={selectedShape.saturation || 0}
                  onChange={(event) => {
                    const saturation = Number(event.target.value);
                    updateSelectedShape((shape) =>
                      shape.type === "adjustment" ? { ...shape, saturation } : shape,
                      "Adjusted layer saturation",
                    );
                  }}
                />
              </label>
            </div>
          )}

          <h2 className="mb-3 mt-4 flex items-center gap-2 text-sm font-semibold">
            <Layers2 size={15} /> Layers
          </h2>

          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={startNewDrawLayer} className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
                <span className="inline-flex items-center gap-1"><Plus size={12} /> New Draw Layer</span>
              </button>
              <button type="button" onClick={setSelectedAsDrawLayer} disabled={selectedShape?.type !== "line"} className="rounded border border-zinc-300 px-2 py-1 text-xs disabled:opacity-40 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
                Use Selected
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={addAdjustmentLayer} className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
                New Adjustment
              </button>
              <button type="button" onClick={assignSelectedToGroup} disabled={!selectedShape} className="rounded border border-zinc-300 px-2 py-1 text-xs disabled:opacity-40 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
                Group Selected
              </button>
            </div>
            <button type="button" onClick={clearSelectedGroup} disabled={!selectedShape?.groupName} className="w-full rounded border border-zinc-300 px-2 py-1 text-xs disabled:opacity-40 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
              Remove From Group
            </button>

            {activeDrawLayerId && (
              <p className="text-[11px] text-zinc-500">
                Active draw layer: {shapes.find((shape) => shape.id === activeDrawLayerId)?.name || "None"}
              </p>
            )}

            {shapes.length === 0 && <p className="text-xs text-zinc-500">No layers yet.</p>}
            {[...shapes].reverse().map((shape, reverseIndex) => {
              const index = shapes.length - 1 - reverseIndex;
              return (
                <div key={shape.id} className={`rounded border p-2 text-xs ${selectedId === shape.id ? "border-zinc-900 bg-zinc-100 dark:border-zinc-100 dark:bg-zinc-800" : "border-zinc-300 dark:border-zinc-700"}`}>
                  <button type="button" onClick={() => setSelectedId(shape.id)} className="w-full text-left font-medium">
                    {shape.name}
                    {activeDrawLayerId === shape.id && <span className="ml-1 text-[10px] text-zinc-500">(draw)</span>}
                  </button>
                  {shape.groupName && <p className="mt-1 text-[11px] text-zinc-500">Group: {shape.groupName}</p>}
                  <p className="mt-1 text-[11px] text-zinc-500">{shape.type.toUpperCase()} · {shape.id.slice(0, 6)}</p>

                  <div className="mt-2 grid grid-cols-2 gap-1">
                    <button type="button" onClick={() => toggleLayerFlag(shape.id, "hidden")} className="rounded border border-zinc-300 p-1 dark:border-zinc-600">
                      {shape.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                    <button type="button" onClick={() => toggleLayerFlag(shape.id, "locked")} className="rounded border border-zinc-300 p-1 dark:border-zinc-600">
                      {shape.locked ? <Lock size={14} /> : <Unlock size={14} />}
                    </button>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1">
                    <button type="button" onClick={() => renameLayer(shape.id)} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600">Rename</button>
                    <button type="button" onClick={() => moveLayer(index, "up")} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600">Up</button>
                    <button type="button" onClick={() => moveLayer(index, "down")} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600">Down</button>
                    <button type="button" onClick={() => moveLayerExtreme(shape.id, "top")} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600">Top</button>
                    <button type="button" onClick={() => moveLayerExtreme(shape.id, "bottom")} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600">Bottom</button>
                  </div>
                </div>
              );
            })}
          </div>

          <h2 className="mb-3 mt-4 text-sm font-semibold">Collaboration</h2>
          <div className="rounded border border-zinc-200 p-3 text-xs dark:border-zinc-700">
            <p className="font-medium">Online ({peers.length + 1})</p>
            <ul className="mt-2 space-y-1">
              <li className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: clientColor }} />
                {displayName || "You"} (you)
              </li>
              {peers.map((peer) => (
                <li key={peer.clientId} className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: peer.color }} />
                  {peer.name}
                </li>
              ))}
            </ul>
          </div>

          <h2 className="mb-3 mt-4 text-sm font-semibold">Edit History</h2>
          <div className="max-h-64 space-y-2 overflow-auto rounded border border-zinc-200 p-3 text-xs dark:border-zinc-700">
            {history.length === 0 && <p className="text-zinc-500">No edits yet.</p>}
            {[...history].reverse().map((entry) => (
              <div key={entry.id} className="rounded border border-zinc-200 p-2 dark:border-zinc-700">
                <p className="font-medium">{entry.actorName}</p>
                <p className="text-zinc-600 dark:text-zinc-300">{entry.action}</p>
                {entry.targetName && <p className="text-zinc-500">Layer: {entry.targetName}</p>}
                <p className="text-zinc-500">v{entry.version} · {formatHistoryTime(entry.timestamp)}</p>
              </div>
            ))}
          </div>

          <p className="mt-4 text-xs text-zinc-500">Shortcuts: V/M/R/E/L/B/T/X tools · Shift constrain transform · Ctrl+S JSON · Ctrl+Shift+E PNG · Ctrl+Shift+M masterpiece · Ctrl+D duplicate · Ctrl+L new draw layer · Ctrl+0 reset view · Ctrl+ +/- zoom · Arrow nudge (Shift=10px) · [ ] brush size · G grid · Ctrl/Cmd+V paste image</p>
        </aside>
      </main>
    </div>
  );
}
