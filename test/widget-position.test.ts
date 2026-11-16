import { describe, expect, test } from "bun:test";
import { parseCursor, parseMonitors, place, sceneOf } from "../widget/placement.ts";
import type { Edge, Scene } from "../widget/placement.ts";

const WIDGET = { width: 340, height: 300 };

function monitor(overrides: Record<string, unknown> = {}) {
  return {
    name: "eDP-1",
    x: 0,
    y: 0,
    width: 3840,
    height: 2160,
    scale: 2,
    transform: 0,
    reserved: [0, 0, 0, 0],
    ...overrides,
  };
}

function layer(namespace: string, x: number, y: number, w: number, h: number) {
  return { address: "0x1", x, y, w, h, alpha: 1, namespace, pid: 1 };
}

const WALLPAPER = layer("hyprpaper", 0, 0, 1920, 1080);

function layersOn(name: string, ...surfaces: ReturnType<typeof layer>[]) {
  return {
    [name]: {
      levels: {
        "0": surfaces.filter((s) => s.namespace === "hyprpaper"),
        "2": surfaces.filter((s) => s.namespace !== "hyprpaper"),
      },
    },
  };
}

function sceneAt(
  cursor: { x: number; y: number } | null,
  monitors: readonly unknown[],
  layers: unknown,
  configuredEdge: Edge | null = null,
): Scene {
  return sceneOf({ cursor, monitors: parseMonitors(monitors), layers }, configuredEdge);
}

describe("a widget opened from a bar", () => {
  test("on the right opens left of it, centred on the pointer's height", () => {
    const scene = sceneAt(
      { x: 1890, y: 400 },
      [monitor({ reserved: [0, 0, 56, 0] })],
      layersOn("eDP-1", WALLPAPER, layer("waybar", 1864, 0, 56, 1080)),
    );
    expect(scene).toEqual({
      monitor: "eDP-1",
      size: { width: 1864, height: 1080 },
      edge: "right",
      pointer: { x: 1890, y: 400 },
    });
    expect(place(scene, WIDGET)).toEqual({ anchors: ["right", "top"], margins: { right: 8, top: 250 } });
  });

  test("on the left opens right of it", () => {
    const scene = sceneAt(
      { x: 20, y: 500 },
      [monitor({ reserved: [56, 0, 0, 0] })],
      layersOn("eDP-1", layer("waybar", 0, 0, 56, 1080)),
    );
    expect(place(scene, WIDGET)).toEqual({ anchors: ["left", "top"], margins: { left: 8, top: 350 } });
  });

  test("at the top opens below it, centred on the pointer's x", () => {
    const scene = sceneAt(
      { x: 700, y: 15 },
      [monitor({ reserved: [0, 30, 0, 0] })],
      layersOn("eDP-1", layer("waybar", 0, 0, 1920, 30)),
    );
    expect(place(scene, WIDGET)).toEqual({ anchors: ["top", "left"], margins: { top: 8, left: 530 } });
  });

  test("at the bottom opens above it", () => {
    const scene = sceneAt(
      { x: 700, y: 1065 },
      [monitor({ reserved: [0, 0, 0, 30] })],
      layersOn("eDP-1", layer("waybar", 0, 1050, 1920, 30)),
    );
    expect(place(scene, WIDGET)).toEqual({ anchors: ["bottom", "left"], margins: { bottom: 8, left: 530 } });
  });

  test("at the top, beside a left bar, still centres on the pointer, because margins start past the left bar", () => {
    const scene = sceneAt(
      { x: 700, y: 15 },
      [monitor({ reserved: [56, 30, 0, 0] })],
      layersOn("eDP-1", layer("waybar", 0, 0, 56, 1080), layer("waybar", 56, 0, 1864, 30)),
    );
    expect(place(scene, WIDGET)).toEqual({ anchors: ["top", "left"], margins: { top: 8, left: 474 } });
  });

  test("near the bottom of a side bar stays a gap above the screen's bottom edge", () => {
    const scene = sceneAt(
      { x: 1890, y: 1070 },
      [monitor({ reserved: [0, 0, 56, 0] })],
      layersOn("eDP-1", layer("waybar", 1864, 0, 56, 1080)),
    );
    expect(place(scene, WIDGET)).toEqual({ anchors: ["right", "top"], margins: { right: 8, top: 1080 - 300 - 8 } });
  });

  test("near the top of a side bar stays a gap below the screen's top edge", () => {
    const scene = sceneAt(
      { x: 1890, y: 10 },
      [monitor({ reserved: [0, 0, 56, 0] })],
      layersOn("eDP-1", layer("waybar", 1864, 0, 56, 1080)),
    );
    expect(place(scene, WIDGET).margins.top).toBe(8);
  });

  test("taller than the screen sits a gap below the top", () => {
    const scene = sceneAt(
      { x: 1890, y: 500 },
      [monitor({ reserved: [0, 0, 56, 0] })],
      layersOn("eDP-1", layer("waybar", 1864, 0, 56, 1080)),
    );
    expect(place(scene, { width: 340, height: 1200 }).margins.top).toBe(8);
  });

  test("on a scale 2 monitor right of another opens on that monitor, in its own coordinates", () => {
    const monitors = [
      monitor({ name: "DP-1", width: 2560, height: 1440, scale: 1 }),
      monitor({ name: "eDP-1", x: 2560, y: 200, reserved: [0, 0, 56, 0] }),
    ];
    const layers = {
      "DP-1": { levels: { "0": [layer("hyprpaper", 0, 0, 2560, 1440)] } },
      "eDP-1": { levels: { "2": [layer("waybar", 2560 + 1864, 200, 56, 1080)] } },
    };
    const scene = sceneAt({ x: 2560 + 1890, y: 200 + 600 }, monitors, layers);
    expect(scene).toEqual({
      monitor: "eDP-1",
      size: { width: 1864, height: 1080 },
      edge: "right",
      pointer: { x: 1890, y: 600 },
    });
    expect(place(scene, WIDGET)).toEqual({ anchors: ["right", "top"], margins: { right: 8, top: 450 } });
  });

  test("on a monitor turned a quarter swaps its width and height", () => {
    const scene = sceneAt(
      { x: 1060, y: 1500 },
      [monitor({ transform: 1 })],
      layersOn("eDP-1", layer("waybar", 1024, 0, 56, 1920)),
    );
    expect(scene.size).toEqual({ width: 1080, height: 1920 });
    expect(scene.edge).toBe("right");
  });
});

describe("with no bar under the pointer", () => {
  const away = { x: 960, y: 540 };

  test("takes the edge from the Waybar config", () => {
    const scene = sceneAt(away, [monitor()], layersOn("eDP-1", WALLPAPER), "bottom");
    expect(scene.edge).toBe("bottom");
  });

  test("and no edge in the Waybar config, opens from the top", () => {
    expect(sceneAt(away, [monitor()], layersOn("eDP-1", WALLPAPER)).edge).toBe("top");
  });

  test("ignores a wallpaper covering the whole screen", () => {
    expect(sceneAt(away, [monitor()], layersOn("eDP-1", WALLPAPER), "left").edge).toBe("left");
  });

  test("ignores its own surface from a widget still open", () => {
    const own = layer("usage-plugin", 900, 400, 340, 300);
    expect(sceneAt(away, [monitor()], layersOn("eDP-1", WALLPAPER, own), "left").edge).toBe("left");
  });
});

describe("with nothing known about the screen", () => {
  test("opens on the configured edge, centred along it by the compositor", () => {
    const scene = sceneAt(null, [], null, "right");
    expect(scene).toEqual({ monitor: null, size: null, edge: "right", pointer: null });
    expect(place(scene, WIDGET)).toEqual({ anchors: ["right"], margins: { right: 8 } });
  });

  test("a pointer on no listed monitor counts as no pointer", () => {
    expect(sceneAt({ x: 5000, y: 5000 }, [monitor()], {})).toEqual({
      monitor: null,
      size: null,
      edge: "top",
      pointer: null,
    });
  });
});

describe("reading hyprctl", () => {
  test("a cursor needs two numbers", () => {
    expect(parseCursor({ x: 443, y: 388 })).toEqual({ x: 443, y: 388 });
    expect(parseCursor({ x: "443", y: 388 })).toBeNull();
    expect(parseCursor(null)).toBeNull();
  });

  test("a monitor that does not read whole is left out, and the others stay", () => {
    const monitors = parseMonitors([
      monitor({ scale: 0 }),
      monitor({ name: 7 }),
      monitor({ reserved: [1, 2] }),
      monitor({ name: "DP-2" }),
    ]);
    expect(monitors.map((m) => m.name)).toEqual(["DP-2"]);
  });

  test("a monitor with no reserved list reserves nothing", () => {
    const { reserved: _, ...bare } = monitor();
    expect(parseMonitors([bare])[0]?.reserved).toEqual([0, 0, 0, 0]);
  });

  test("layers that are not the expected shape count as none", () => {
    expect(
      sceneAt({ x: 1890, y: 400 }, [monitor()], { "eDP-1": { levels: { "2": [{ x: "1864" }] } } }, "left").edge,
    ).toBe("left");
    expect(sceneAt({ x: 1890, y: 400 }, [monitor()], "not json", "left").edge).toBe("left");
  });
});
