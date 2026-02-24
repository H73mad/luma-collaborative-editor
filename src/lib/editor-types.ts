export type EditorTool = "select" | "marquee" | "rect" | "ellipse" | "text" | "brush" | "line" | "eraser";

export type BlendMode = "source-over" | "multiply" | "screen" | "overlay" | "darken" | "lighten";

interface EditorShapeBase {
  id: string;
  name: string;
  groupName?: string;
  hidden?: boolean;
  locked?: boolean;
  opacity?: number;
  blendMode?: BlendMode;
  shadowColor?: string;
  shadowBlur?: number;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  shadowOpacity?: number;
}

export interface RectShape extends EditorShapeBase {
  type: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
}

export interface EllipseShape extends EditorShapeBase {
  type: "ellipse";
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
}

export interface TextShape extends EditorShapeBase {
  type: "text";
  x: number;
  y: number;
  text: string;
  fill: string;
  fontSize: number;
}

export interface LineShape extends EditorShapeBase {
  type: "line";
  points: Array<number | null>;
  stroke: string;
  strokeWidth: number;
}

export interface ImageShape extends EditorShapeBase {
  type: "image";
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  src: string;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  blurRadius?: number;
  grayscale?: number;
  invert?: number;
  clipToPrevious?: boolean;
}

export interface AdjustmentShape extends EditorShapeBase {
  type: "adjustment";
  brightness?: number;
  contrast?: number;
  saturation?: number;
}

export type EditorShape = RectShape | EllipseShape | TextShape | LineShape | ImageShape | AdjustmentShape;
