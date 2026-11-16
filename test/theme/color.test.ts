import { describe, expect, test } from "bun:test";
import { contrast, hexOf, oklchToRgb, parseCssColor, readableOn, rgbToOklch } from "../../src/theme/color.ts";

function hex(css: string): string {
  const parsed = parseCssColor(css);
  if (parsed === null) throw new Error(`${css} did not parse`);
  return hexOf(oklchToRgb(parsed.color));
}

describe("oklch to hex", () => {
  test("lightness 0 is black and lightness 1 is white, whatever the chroma", () => {
    expect(hex("oklch(0 0 0)")).toBe("#000000");
    expect(hex("oklch(1 0 0)")).toBe("#ffffff");
    expect(hex("oklch(0 0.3 140)")).toBe("#000000");
    expect(hex("oklch(1 0.3 140)")).toBe("#ffffff");
  });

  test("CSS red and blue land on their sRGB values", () => {
    expect(hex("oklch(0.627955 0.257683 29.234)")).toBe("#ff0000");
    expect(hex("oklch(45.2% 0.313214 264.052)")).toBe("#0000ff");
  });

  test("hue 360 is hue 0", () => {
    expect(hex("oklch(0.6 0.1 360)")).toBe(hex("oklch(0.6 0.1 0)"));
    expect(hex("oklch(0.6 0.1 360deg)")).toBe(hex("oklch(0.6 0.1 0)"));
  });

  test("chroma out of the sRGB gamut keeps its lightness and hue at the most chroma that fits", () => {
    const parsed = parseCssColor("oklch(0.7 0.5 30)");
    if (parsed === null) throw new Error("did not parse");
    const shown = rgbToOklch(oklchToRgb(parsed.color));
    expect(shown.L).toBeCloseTo(0.7, 2);
    expect(shown.h).toBeCloseTo(30, 0);
    expect(shown.C).toBeLessThan(0.5);
    expect(shown.C).toBeGreaterThan(0.15);
  });

  test("a hex colour survives the trip through oklch", () => {
    for (const color of ["#1b4ed8", "#fcfcfc", "#0a0a0a", "#fe9a00"]) expect(hex(color)).toBe(color);
  });
});

describe("parseCssColor", () => {
  test("reads the forms T3 and its theme files write", () => {
    expect(hex("#abc")).toBe("#aabbcc");
    expect(hex("rgb(255, 0, 0)")).toBe("#ff0000");
    expect(hex("rgb(0 0 255 / 50%)")).toBe("#0000ff");
    expect(parseCssColor("rgba(0, 0, 255, 0.25)")?.alpha).toBe(0.25);
    expect(parseCssColor("oklch(0.5 0.1 120 / 0.4)")?.alpha).toBe(0.4);
    expect(parseCssColor("#00000080")?.alpha).toBeCloseTo(0.5, 2);
    expect(hex("oklch(none none none)")).toBe("#000000");
  });

  test("clamps lightness into 0 to 1 and chroma to at least 0", () => {
    expect(parseCssColor("oklch(1.4 -0.2 10)")?.color).toEqual({ L: 1, C: 0, h: 10 });
  });

  test("turns any finite hue into a real colour, however far past 360 it is", () => {
    for (const hue of ["5.7e307", "5.8e307", "-1.7e308", "1e300", "720.5"]) expect(hex(`oklch(0.6 0.1 ${hue})`)).toMatch(/^#[0-9a-f]{6}$/);
    expect(hex("oklch(0.6 0.1 730)")).toBe(hex("oklch(0.6 0.1 10)"));
    expect(hex("oklch(0.6 0.1 -350)")).toBe(hex("oklch(0.6 0.1 10)"));
  });

  test("turns huge chroma and channels past 255 into real colours", () => {
    expect(hex("oklch(0.6 1e300 30)")).toMatch(/^#[0-9a-f]{6}$/);
    expect(hex("rgb(300 -20 0)")).toBe("#ff0000");
  });

  test("answers null for what it cannot read, so a role falls back instead of painting garbage", () => {
    for (const text of ["", "red", "oklch(0.5 0.1)", "#12", "rgb(1 2 three)", "oklch(0.5 0.1 120) x", "url(x)"]) {
      expect(parseCssColor(text)).toBeNull();
    }
  });
});

describe("contrast and readableOn", () => {
  const black = { r: 0, g: 0, b: 0 };
  const white = { r: 255, g: 255, b: 255 };

  test("black on white is 21 and a colour on itself is 1", () => {
    expect(contrast(black, white)).toBeCloseTo(21, 5);
    expect(contrast(white, white)).toBe(1);
  });

  test("a dim colour on a dark surface gets lighter until it reads, keeping its hue", () => {
    const surface = { r: 16, g: 20, b: 18 };
    const dim = { L: 0.46, C: 0.1, h: 150 };
    const solved = readableOn(dim, [surface], 3);
    expect(contrast(solved, surface)).toBeGreaterThanOrEqual(3);
    expect(rgbToOklch(solved).L).toBeGreaterThan(0.46);
    expect(rgbToOklch(solved).h).toBeCloseTo(150, -1);
  });

  test("a pale colour on a light surface gets darker, and one that already reads is left alone", () => {
    const pale = { L: 0.9, C: 0.05, h: 60 };
    expect(contrast(readableOn(pale, [white], 3), white)).toBeGreaterThanOrEqual(3);
    expect(rgbToOklch(readableOn(pale, [white], 3)).L).toBeLessThan(0.9);
    const strong = { L: 0.4, C: 0.1, h: 60 };
    expect(readableOn(strong, [white], 3)).toEqual(oklchToRgb(strong));
  });
});
