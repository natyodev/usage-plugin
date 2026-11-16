import { isRecord } from "../src/domain.ts";

/**
 * Imported by both the Bun launcher and the GJS widget, so it imports only `domain.ts`.
 *
 * Every coordinate is in logical pixels. Hyprland reports a monitor's mode in physical pixels and
 * everything else (its position, the cursor, layer surfaces, reserved space) in logical ones.
 */

export type Edge = "left" | "right" | "top" | "bottom";

export function isEdge(value: unknown): value is Edge {
  return value === "left" || value === "right" || value === "top" || value === "bottom";
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * `size` and `pointer` describe the area a layer surface is placed in, which is the monitor less
 * the space bars reserve, because that is where the compositor puts the origin of the margins.
 * Both are null when no monitor holds the pointer.
 */
export interface Scene {
  /** The monitor's connector name, such as "eDP-1". */
  readonly monitor: string | null;
  readonly size: Size | null;
  readonly edge: Edge;
  /** Relative to the top left corner of `size`. */
  readonly pointer: Point | null;
}

export interface HyprMonitor {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  /** Physical pixels of the current mode, before scale and transform. */
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  /** wl_output transform. An odd value turns the monitor a quarter. */
  readonly transform: number;
  /** Logical pixels kept clear by exclusive layer surfaces: left, top, right, bottom. */
  readonly reserved: readonly [number, number, number, number];
}

export interface Placement {
  readonly anchors: readonly Edge[];
  readonly margins: Partial<Record<Edge, number>>;
}

export const DEFAULT_GAP = 8;

const OWN_NAMESPACE = "usage-plugin";

export function sceneOf(
  input: { readonly cursor: Point | null; readonly monitors: readonly HyprMonitor[]; readonly layers: unknown },
  configuredEdge: Edge | null,
): Scene {
  const { cursor } = input;
  const fallback = configuredEdge ?? "top";
  const monitor =
    cursor === null ? undefined : input.monitors.find((candidate) => contains(screenOf(candidate), cursor));
  if (cursor === null || monitor === undefined) return { monitor: null, size: null, edge: fallback, pointer: null };

  const screen = screenOf(monitor);
  const [left, top, right, bottom] = monitor.reserved;
  return {
    monitor: monitor.name,
    size: { width: screen.width - left - right, height: screen.height - top - bottom },
    edge: barEdge(parseLayers(input.layers), screen, cursor) ?? fallback,
    pointer: { x: cursor.x - screen.x - left, y: cursor.y - screen.y - top },
  };
}

/**
 * The clicked edge takes a `gap` margin. The compositor already keeps the surface clear of every
 * bar's reserved space, so the bar's own size is never needed. Along the bar the widget is
 * centred on the pointer and kept `gap` inside the area. With no pointer the compositor centres it.
 */
export function place(scene: Scene, widget: Size, gap: number = DEFAULT_GAP): Placement {
  const { edge, size, pointer } = scene;
  if (size === null || pointer === null) return { anchors: [edge], margins: { [edge]: gap } };

  const along: Edge = edge === "left" || edge === "right" ? "top" : "left";
  const [room, length, at] =
    along === "top" ? [size.height, widget.height, pointer.y] : [size.width, widget.width, pointer.x];
  const offset = Math.max(gap, Math.min(room - length - gap, Math.round(at - length / 2)));
  return { anchors: [edge, along], margins: { [edge]: gap, [along]: offset } };
}

/** `hyprctl -j cursorpos`. */
export function parseCursor(json: unknown): Point | null {
  if (!isRecord(json) || !isNumber(json.x) || !isNumber(json.y)) return null;
  return { x: json.x, y: json.y };
}

/** `hyprctl -j monitors`. A monitor that does not read whole is left out. */
export function parseMonitors(json: unknown): readonly HyprMonitor[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((item: unknown): HyprMonitor[] => {
    if (!isRecord(item)) return [];
    const { name, x, y, width, height, scale, transform, reserved = [0, 0, 0, 0] } = item;
    if (typeof name !== "string" || !isNumber(scale) || scale <= 0 || !isReserved(reserved)) return [];
    if (!isNumber(x) || !isNumber(y) || !isNumber(width) || !isNumber(height) || !isNumber(transform)) return [];
    return [{ name, x, y, width, height, scale, transform, reserved }];
  });
}

interface Rect extends Point, Size {}

function screenOf(monitor: HyprMonitor): Rect {
  const width = Math.round(monitor.width / monitor.scale);
  const height = Math.round(monitor.height / monitor.scale);
  const turned = monitor.transform % 2 === 1;
  return { x: monitor.x, y: monitor.y, width: turned ? height : width, height: turned ? width : height };
}

function contains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}

function barEdge(layers: readonly Rect[], screen: Rect, cursor: Point): Edge | null {
  const bar = layers.find((layer) => contains(layer, cursor) && isBarShaped(layer, screen));
  if (bar === undefined) return null;
  if (bar.height > bar.width) return bar.x + bar.width / 2 < screen.x + screen.width / 2 ? "left" : "right";
  return bar.y + bar.height / 2 < screen.y + screen.height / 2 ? "top" : "bottom";
}

/** `hyprctl -j layers`: by monitor, then by level, a list of surfaces. */
function parseLayers(json: unknown): readonly Rect[] {
  if (!isRecord(json)) return [];
  return Object.values(json).flatMap((monitor) => {
    if (!isRecord(monitor) || !isRecord(monitor.levels)) return [];
    return Object.values(monitor.levels).flatMap((level) => {
      if (!Array.isArray(level)) return [];
      return level.flatMap((layer: unknown): Rect[] => {
        if (!isRecord(layer) || layer.namespace === OWN_NAMESPACE) return [];
        const { x, y, w, h } = layer;
        return isNumber(x) && isNumber(y) && isNumber(w) && isNumber(h) ? [{ x, y, width: w, height: h }] : [];
      });
    });
  });
}

function isBarShaped(layer: Rect, screen: Rect): boolean {
  return layer.width < screen.width / 2 || layer.height < screen.height / 2;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isReserved(value: unknown): value is HyprMonitor["reserved"] {
  return Array.isArray(value) && value.length === 4 && value.every(isNumber);
}
