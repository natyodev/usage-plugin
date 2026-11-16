import { describe, expect, test } from "bun:test";
import { contrast, parseCssColor, oklchToRgb } from "../../src/theme/color.ts";
import { parsePinned } from "../../src/theme/palettes.ts";
import type { Appearance } from "../../src/theme/palettes.ts";
import { resolveT3 } from "../../src/theme/t3.ts";
import type { Palette, T3State } from "../../src/theme/t3.ts";
import pinned from "../../assets/t3-themes/0.1.9.json";

const PALETTES = parsePinned(pinned);

function resolve(storage: Readonly<Record<string, string>>, more: Partial<Omit<T3State, "storage">> = {}, systemDark = false, bar: readonly string[] = []) {
  const state: T3State = { storage: new Map(Object.entries(storage)), themeFiles: new Map(), clientSettings: null, ...more };
  return resolveT3(state, PALETTES, () => systemDark, bar.map(rgb));
}

function rgb(hex: string) {
  const parsed = parseCssColor(hex);
  if (parsed === null) throw new Error(`${hex} is not a colour`);
  return oklchToRgb(parsed.color);
}

function contrastOf(a: string, b: string): number {
  return contrast(rgb(a), rgb(b));
}

function oklab(hex: string): readonly [number, number, number] {
  const parsed = parseCssColor(hex);
  if (parsed === null) throw new Error(`${hex} is not a colour`);
  const { L, C, h } = parsed.color;
  return [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];
}

function distance(a: string, b: string): number {
  const [first, second] = [oklab(a), oklab(b)];
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}

/** OKLab distance at which two colours read as different at a glance: five times the smallest difference people notice. */
const APART = 0.1;
const DARK_BAR = ["#0b1612", "#172a22"];
const LIGHT_BAR = ["#f4f4f4", "#ffffff"];

/** What every palette promises, on the widget's panel and cards and on the bar it was solved for. */
function expectLegibleLevels(palette: Palette, bar: readonly string[], what: string): void {
  for (const [levels, surfaces] of [[palette, [palette.background, palette.card]], [palette.bar, bar.length === 0 ? [palette.background] : bar]] as const) {
    const where = `${what} on ${surfaces.join(", ")}`;
    for (const surface of surfaces) {
      expect(contrastOf(levels.accent, surface), `${where}: accent`).toBeGreaterThanOrEqual(3);
      expect(contrastOf(levels.warning, surface), `${where}: warning`).toBeGreaterThanOrEqual(4.5);
      expect(contrastOf(levels.critical, surface), `${where}: critical`).toBeGreaterThanOrEqual(4.5);
    }
    expect(distance(levels.warning, levels.accent), `${where}: warning from accent`).toBeGreaterThanOrEqual(APART);
    expect(distance(levels.critical, levels.accent), `${where}: critical from accent`).toBeGreaterThanOrEqual(APART);
    expect(distance(levels.warning, levels.critical), `${where}: warning from critical`).toBeGreaterThanOrEqual(APART);
  }
}

/**
 * Hex of T3 0.1.9's own oklch values (canvas, surface or surfaceRaised, text, textMuted), checked
 * against an independent oklch conversion. accent, warning and critical are T3's where they read
 * on the canvas and the cards and stand apart, and moved where they do not, as the tests below require.
 */
const BUILT_IN: readonly [string, Appearance, Record<string, string>][] = [
  ["t3-chat", "light", { background: "#fdf7fd", card: "#faf3fb", text: "#501854", muted: "#ac1668", accent: "#db2777", warning: "#9e6400", critical: "#da0023" }],
  ["t3-chat", "dark", { background: "#1f1a24", card: "#29232d", text: "#f9f8fb", muted: "#e7d0dd", accent: "#c73468", warning: "#f59e0b", critical: "#e75e70" }],
  ["grove", "light", { background: "#f3f7f4", card: "#ecefed", text: "#241523", muted: "#746c73", accent: "#1b7d50", warning: "#9e5d00", critical: "#da0021" }],
  ["grove", "dark", { background: "#1b2821", card: "#36413c", text: "#fffaff", muted: "#919595", accent: "#69d69a", warning: "#fe9a00", critical: "#ff8580" }],
  ["ocean", "light", { background: "#f5f7f8", card: "#edeff1", text: "#241523", muted: "#746c75", accent: "#2672af", warning: "#9e5d00", critical: "#db0021" }],
  ["ocean", "dark", { background: "#17212b", card: "#333b45", text: "#fffaff", muted: "#8d8f97", accent: "#70b9ee", warning: "#fe9a00", critical: "#ff7b77" }],
  ["ember", "light", { background: "#f9f7f5", card: "#f1efee", text: "#241523", muted: "#766c74", accent: "#ae552a", warning: "#7c6700", critical: "#dc0022" }],
  ["ember", "dark", { background: "#291e1a", card: "#433835", text: "#fffaff", muted: "#968e8f", accent: "#f09a64", warning: "#fdb500", critical: "#ffb4b3" }],
  ["iris", "light", { background: "#f8f7f9", card: "#f0eff2", text: "#241523", muted: "#766c76", accent: "#7253b9", warning: "#9e5e00", critical: "#dc0022" }],
  ["iris", "dark", { background: "#1d1929", card: "#383443", text: "#fffaff", muted: "#8e8a95", accent: "#9d7df2", warning: "#fe9a00", critical: "#ff716e" }],
];

describe("each built-in theme", () => {
  for (const [id, appearance, expected] of BUILT_IN) {
    test(`${id} ${appearance} paints T3's colours`, () => {
      const resolved = resolve({ "t3code:theme": id, "t3code:theme-appearance-mode": appearance });
      expect(resolved.themeId).toBe(id);
      expect(resolved.appearance).toBe(appearance);
      expect(resolved.palette).toMatchObject({ ...expected, panelAlpha: 0.976 } as never);
    });
  }

  test("the cards stand apart from the panel", () => {
    for (const [, , palette] of BUILT_IN) expect(palette.card).not.toBe(palette.background);
  });
});

describe("warning and critical", () => {
  const pinned: [string, Record<string, string>][] = [
    ...Object.keys(PALETTES.themes).flatMap((id) =>
      (["dark", "light"] as const).map((mode): [string, Record<string, string>] => [`${id} ${mode}`, { "t3code:theme": id, "t3code:theme-appearance-mode": mode }]),
    ),
    ["standard dark", { "t3code:theme-appearance-mode": "dark" }],
    ["standard light", { "t3code:theme-appearance-mode": "light" }],
  ];

  test("stand apart from the accent and each other, and read as text, in every pinned palette and on any bar", () => {
    for (const [name, storage] of pinned) {
      for (const bar of [[], DARK_BAR, LIGHT_BAR]) expectLegibleLevels(resolve(storage, {}, false, bar).palette, bar, name);
    }
  });

  test("do the same in every custom theme, whatever its accent", () => {
    for (const canvas of ["#0b1723", "#fafafa", "#3a3a3a"]) {
      for (let hue = 0; hue < 360; hue += 10) {
        for (const lightness of [0.45, 0.65, 0.8]) {
          const custom = { ...DUSK, appearance: canvas === "#fafafa" ? "light" : "dark", colors: { canvas, accent: `oklch(${lightness} 0.16 ${hue})` } };
          const storage = { "t3code:theme": "my-dusk", "t3code:themes:v1": JSON.stringify([custom]) };
          for (const bar of [[], DARK_BAR, LIGHT_BAR]) expectLegibleLevels(resolve(storage, {}, false, bar).palette, bar, `accent ${hue} at ${lightness} on ${canvas}`);
        }
      }
    }
  });

  test("keep T3's own colour where it already reads and stands apart", () => {
    const grove = resolve({ "t3code:theme": "grove", "t3code:theme-appearance-mode": "dark" }).palette;
    expect<string[]>([grove.accent, grove.warning]).toEqual(["#69d69a", "#fe9a00"]);
  });

  test("move T3 Chat's critical, which is its accent's colour, to a red", () => {
    for (const mode of ["dark", "light"]) {
      const palette = resolve({ "t3code:theme": "t3-chat", "t3code:theme-appearance-mode": mode }).palette;
      const hue = parseCssColor(palette.critical)?.color.h ?? Number.NaN;
      expect(hue, mode).toBeGreaterThanOrEqual(10);
      expect(hue, mode).toBeLessThanOrEqual(40);
    }
  });
});

describe("the module's colours on the bar", () => {
  test("are solved for the bar's own colours, so a light theme still reads on a dark bar", () => {
    const standardLight = resolve({ "t3code:theme-appearance-mode": "light" }, {}, false, DARK_BAR).palette;
    expect(contrastOf("#1b4ed8", DARK_BAR[1] as string)).toBeLessThan(3);
    expect(contrastOf(standardLight.bar.accent, DARK_BAR[1] as string)).toBeGreaterThanOrEqual(3);
    expect<string>(standardLight.accent).toBe("#1b4ed8");
  });

  test("are solved on T3's canvas alone when the bar's colours are not known", () => {
    const { palette } = resolve({ "t3code:theme": "grove", "t3code:theme-appearance-mode": "dark" });
    expect<string>(palette.critical).toBe("#ff8580");
    expect(palette.bar).toEqual({ accent: "#69d69a", warning: "#fe9a00", critical: "#ff454d" } as never);
  });
});

describe("which theme and appearance T3 paints", () => {
  test("the operator's shape: no theme key, dark mode, Grove for both halves", () => {
    const resolved = resolve({ "t3code:theme-appearance-mode": "dark", "t3code:theme-halves:v1": '{"light":"grove","dark":"grove"}' });
    expect<string[]>([resolved.themeId, resolved.appearance, resolved.palette.background]).toEqual(["grove", "dark", "#1b2821"]);
  });

  test("a half for the current appearance beats the base theme", () => {
    const resolved = resolve({ "t3code:theme": "ocean", "t3code:theme-appearance-mode": "dark", "t3code:theme-halves:v1": '{"dark":"iris"}' });
    expect<string[]>([resolved.themeId, resolved.appearance]).toEqual(["iris", "dark"]);
    expect(resolve({ "t3code:theme": "ocean", "t3code:theme-appearance-mode": "light", "t3code:theme-halves:v1": '{"dark":"iris"}' }).themeId).toBe("ocean");
  });

  test("system mode asks the desktop, and only then", () => {
    let asked = 0;
    const state: T3State = { storage: new Map([["t3code:theme", "ember"], ["t3code:theme-appearance-mode", "system"]]), themeFiles: new Map(), clientSettings: null };
    expect(resolveT3(state, PALETTES, () => ++asked > 0).appearance).toBe("dark");
    expect(resolveT3(state, PALETTES, () => false).appearance).toBe("light");
    const fixed: T3State = { ...state, storage: new Map([["t3code:theme", "ember"], ["t3code:theme-appearance-mode", "light"]]) };
    resolveT3(fixed, PALETTES, () => ++asked > 0);
    expect(asked).toBe(1);
  });

  test("no stored keys at all is T3's default: follow the system, standard palette", () => {
    expect(resolve({}, {}, true)).toMatchObject({ themeId: "standard", appearance: "dark", palette: { background: "#000000", card: "#111111" } });
    expect(resolve({}, {}, false)).toMatchObject({ themeId: "standard", appearance: "light", palette: { background: "#fcfcfc", card: "#ffffff" } });
  });

  test("legacy ids still pick their themes, and t3-chat-dark means T3 Chat in dark", () => {
    expect(resolve({ "t3code:theme": "t3-grove", "t3code:theme-appearance-mode": "dark" }).themeId).toBe("grove");
    expect(resolve({ "t3code:theme": "t3-chat-dark" })).toMatchObject({ themeId: "t3-chat", appearance: "dark" });
  });

  test("without a mode key, the legacy follow-system key and then the theme's own appearance decide", () => {
    expect(resolve({ "t3code:theme": "iris", "t3code:theme-follow-system": "true" }, {}, true).appearance).toBe("dark");
    expect(resolve({ "t3code:theme": "iris", "t3code:theme-follow-system": "false" }, {}, true).appearance).toBe("light");
  });

  test("a stored theme id T3 no longer knows falls back to the system appearance and the standard palette", () => {
    expect(resolve({ "t3code:theme": "deleted-theme" }, {}, true)).toMatchObject({ themeId: "standard", appearance: "dark" });
  });

  test("broken JSON in the halves or the custom themes is ignored, as T3 ignores it", () => {
    const resolved = resolve({ "t3code:theme": "ember", "t3code:theme-appearance-mode": "dark", "t3code:theme-halves:v1": "{", "t3code:themes:v1": "nope" });
    expect<string[]>([resolved.themeId, resolved.appearance]).toEqual(["ember", "dark"]);
  });
});

const DUSK = {
  id: "my-dusk",
  label: "My Dusk",
  appearance: "dark",
  colors: { canvas: "oklch(0.2 0.03 250)", accent: "#ffaa00", notARole: "#ffffff", text: "not a colour" },
};

describe("a stored custom theme", () => {
  test("paints its own colours, and T3 Chat's for every role it leaves out or cannot use", () => {
    const resolved = resolve({ "t3code:theme": "my-dusk", "t3code:themes:v1": JSON.stringify([DUSK]) });
    const t3ChatDark = BUILT_IN.find(([id, mode]) => id === "t3-chat" && mode === "dark")?.[2];
    expect(resolved).toMatchObject({ themeId: "my-dusk", appearance: "dark" });
    expect<string>(resolved.palette.background).toBe("#0b1723");
    expect<string>(resolved.palette.accent).toBe("#ffaa00");
    expect<string>(resolved.palette.text).toBe(t3ChatDark?.text as string);
    expect<string>(resolved.palette.card).toBe(t3ChatDark?.card as string);
  });

  test("an asked appearance it has no palette for gives way to its own", () => {
    const resolved = resolve({ "t3code:theme": "my-dusk", "t3code:theme-appearance-mode": "light", "t3code:themes:v1": JSON.stringify([DUSK]) });
    expect(resolved.appearance).toBe("dark");
  });

  test("its light variant applies in light mode", () => {
    const withLight = { ...DUSK, variants: { light: { canvas: "#fafafa", accent: "#0055aa" } } };
    const resolved = resolve({ "t3code:theme": "my-dusk", "t3code:theme-appearance-mode": "light", "t3code:themes:v1": JSON.stringify([withLight]) });
    expect<string[]>([resolved.appearance, resolved.palette.background, resolved.palette.accent]).toEqual(["light", "#fafafa", "#0055aa"]);
  });

  test("one that claims a built-in id, has no label, or has an unknown variant is skipped", () => {
    const impostor = { ...DUSK, id: "grove" };
    const unlabelled = { ...DUSK, id: "no-label", label: " " };
    const odd = { ...DUSK, id: "odd", variants: { dim: {} } };
    const storage = { "t3code:theme-appearance-mode": "dark", "t3code:themes:v1": JSON.stringify([impostor, unlabelled, odd]) };
    expect<string>(resolve({ ...storage, "t3code:theme": "grove" }).palette.background).toBe("#1b2821");
    expect(resolve({ ...storage, "t3code:theme": "no-label" }).themeId).toBe("standard");
    expect(resolve({ ...storage, "t3code:theme": "odd" }).themeId).toBe("standard");
  });
});

describe("a theme file in ~/.t3/userdata/themes", () => {
  const sunset = { name: "Sunset", appearance: "light", canvas: "#fff4e6", accent: "#c2410c" };

  test("the canvas and accent shorthand builds the rest the way T3's generator does", () => {
    const resolved = resolve({ "t3code:theme": "sunset" }, { themeFiles: new Map([["sunset", sunset]]) }, false);
    const { palette } = resolved;
    expect(resolved).toMatchObject({ themeId: "sunset", appearance: "light" });
    expect<string[]>([palette.background, palette.accent]).toEqual(["#fff4e6", "#c2410c"]);
    expect(contrastOf(palette.warning, palette.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastOf("#fe9a00", palette.background)).toBeLessThan(4.5);
    expect(contrastOf(palette.text, palette.background)).toBeGreaterThanOrEqual(7);
    expect(contrastOf(palette.muted, palette.background)).toBeCloseTo(4.705, 1);
    expect(palette.card).not.toBe(palette.background);
  });

  test("colors laid over the shorthand win for their roles", () => {
    const resolved = resolve({ "t3code:theme": "sunset" }, { themeFiles: new Map([["sunset", { ...sunset, colors: { text: "#111111" } }]]) });
    expect<string>(resolved.palette.text).toBe("#111111");
  });

  test("a full file without the shorthand is its own palette over the defaults", () => {
    const night = { name: "Night", appearance: "dark", colors: { canvas: "#05070a", surface: "#10141a", accent: "#7dd3fc" } };
    const resolved = resolve({ "t3code:theme": "night" }, { themeFiles: new Map([["night", night]]) });
    expect<string[]>([resolved.palette.background, resolved.palette.card, resolved.palette.accent]).toEqual(["#05070a", "#10141a", "#7dd3fc"]);
  });

  test("a stored custom theme with the same id is found first", () => {
    const resolved = resolve({ "t3code:theme": "my-dusk", "t3code:themes:v1": JSON.stringify([DUSK]) }, { themeFiles: new Map([["my-dusk", sunset]]) });
    expect<string>(resolved.palette.background).toBe("#0b1723");
  });

  test("a file T3's server would refuse is ignored", () => {
    const refused = new Map<string, unknown>([
      ["grove", sunset],
      ["named-red", { ...sunset, canvas: "red" }],
      ["no-colours", { name: "Empty", appearance: "dark" }],
      ["Upper", sunset],
    ]);
    for (const id of ["named-red", "no-colours", "Upper"]) expect(resolve({ "t3code:theme": id }, { themeFiles: refused }).themeId).toBe("standard");
    expect<string>(resolve({ "t3code:theme": "grove", "t3code:theme-appearance-mode": "light" }, { themeFiles: refused }).palette.background).toBe("#f3f7f4");
  });
});

describe("T3's appearance settings", () => {
  const grove = { "t3code:theme": "grove", "t3code:theme-appearance-mode": "dark" };

  test("contrast above 100 moves muted text toward text, below 100 toward the canvas", () => {
    const base = resolve(grove).palette;
    const high = resolve(grove, { clientSettings: { appearanceContrast: 200 } }).palette;
    const low = resolve(grove, { clientSettings: { appearanceContrast: 50 } }).palette;
    expect(high.muted).toBe(base.text);
    expect(contrastOf(low.muted, base.background)).toBeLessThan(contrastOf(base.muted, base.background));
    expect(contrastOf(low.muted, base.background)).toBeGreaterThan(1);
    expect({ ...high, muted: base.muted }).toEqual(base);
  });

  test("glass opacity sets how opaque the panel is, from 0.88 to 1, and 80 by default", () => {
    expect(resolve(grove, { clientSettings: { glassOpacity: 70 } }).palette.panelAlpha).toBe(0.964);
    expect(resolve(grove, { clientSettings: { glassOpacity: 0 } }).palette.panelAlpha).toBe(0.88);
    expect(resolve(grove, { clientSettings: { glassOpacity: 100 } }).palette.panelAlpha).toBe(1);
    expect(resolve(grove, { clientSettings: { glassOpacity: "lots" } }).palette.panelAlpha).toBe(0.976);
  });
});
