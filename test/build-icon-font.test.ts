import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFont, planFont } from "../scripts/build-icon-font.ts";
import { ICON_FONT_FAMILY, isGlyph } from "../src/domain.ts";
import { logos } from "../src/providers/index.ts";
import type { Logo } from "../src/providers/index.ts";
import { tempDir } from "./support.ts";

const ROOT = join(import.meta.dir, "..");
const LOGO_DIR = join(ROOT, "assets", "logos");
const MONOCHROME = '<svg fill="currentColor" fill-rule="evenodd" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M2 2h20v20H2z"/></svg>';

function row(id: string, codePoint: number, hasAdapter: boolean): Logo {
  if (!isGlyph(codePoint)) throw new RangeError(`not a glyph: ${codePoint}`);
  return { id, glyph: codePoint, hasAdapter };
}

function shippedSvgs(): Map<string, string> {
  const names = readdirSync(LOGO_DIR).filter((name) => name.endsWith(".svg"));
  return new Map(names.map((name) => [name, readFileSync(join(LOGO_DIR, name), "utf8")]));
}

function plannedGlyphs(rows: readonly Logo[] = logos, svgs: ReadonlyMap<string, string> = shippedSvgs()) {
  const planned = planFont(rows, svgs);
  if (planned.kind !== "plan") throw new Error(`the font cannot be planned: ${JSON.stringify(planned.problems)}`);
  return planned.glyphs;
}

describe("planFont", () => {
  test("pairs every row that has an SVG with it", () => {
    const claude = row("claude", 0xe900, true);
    const grok = row("grok", 0xe901, false);
    const svgs = new Map([["claude.svg", MONOCHROME], ["grok.svg", MONOCHROME]]);
    expect(planFont([claude, grok], svgs)).toEqual({
      kind: "plan",
      glyphs: [
        { logo: claude, svg: MONOCHROME },
        { logo: grok, svg: MONOCHROME },
      ],
    });
  });

  test("reports a missing SVG for a row that has an adapter", () => {
    const planned = planFont([row("claude", 0xe900, true)], new Map());
    expect(planned).toEqual({ kind: "problems", problems: [{ kind: "missingSvg", id: "claude" }] });
  });

  test("skips a reserved row that has no SVG yet", () => {
    const rows = [row("claude", 0xe900, true), row("codex", 0xe902, false)];
    expect(planFont(rows, new Map([["claude.svg", MONOCHROME]]))).toMatchObject({
      kind: "plan",
      glyphs: [{ logo: { id: "claude" } }],
    });
  });

  test("reports an SVG that no row claims", () => {
    const svgs = new Map([["claude.svg", MONOCHROME], ["stray.svg", MONOCHROME]]);
    expect(planFont([row("claude", 0xe900, true)], svgs)).toEqual({
      kind: "problems",
      problems: [{ kind: "svgWithoutRow", file: "stray.svg" }],
    });
  });

  test.each([
    ['<svg viewBox="0 0 24 24"><path fill="#D97757" d="M2 2h20v20H2z"/></svg>', "#D97757"],
    ['<svg viewBox="0 0 24 24"><path stroke="red" d="M2 2h20v20H2z"/></svg>', "red"],
    ['<svg viewBox="0 0 24 24"><path style="fill: rgb(1, 2, 3)" d="M2 2h20v20H2z"/></svg>', "rgb(1, 2, 3)"],
  ])("reports a logo that carries its own colour: %s", (svg, found) => {
    expect(planFont([row("claude", 0xe900, true)], new Map([["claude.svg", svg]]))).toEqual({
      kind: "problems",
      problems: [{ kind: "colouredSvg", file: "claude.svg", found }],
    });
  });

  test("accepts currentColor and none", () => {
    const svg = '<svg fill="currentColor" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" d="M2 2h20"/></svg>';
    expect(planFont([row("claude", 0xe900, true)], new Map([["claude.svg", svg]])).kind).toBe("plan");
  });

  test("reports every problem, not only the first", () => {
    const rows = [row("claude", 0xe900, true), row("grok", 0xe901, true)];
    const svgs = new Map([["grok.svg", MONOCHROME.replace("currentColor", "blue")], ["stray.svg", MONOCHROME]]);
    const planned = planFont(rows, svgs);
    expect(planned.kind === "problems" && planned.problems.map((problem) => problem.kind).sort()).toEqual([
      "colouredSvg",
      "missingSvg",
      "svgWithoutRow",
    ]);
  });

  test("plans the shipped logos for every adapter in the registry", () => {
    const planned = plannedGlyphs().map((glyph) => glyph.logo.id);
    for (const logo of logos.filter((candidate) => candidate.hasAdapter)) expect(planned).toContain(logo.id);
  });
});

describe("buildFont", () => {
  afterEach(() => {
    setSystemTime();
  });

  test("returns the same bytes for the same input, whenever it is built", async () => {
    const today = await buildFont(plannedGlyphs());
    setSystemTime(new Date("2031-05-05T05:05:05Z"));
    const yearsLater = await buildFont(plannedGlyphs());
    expect(Buffer.from(today).equals(Buffer.from(yearsLater))).toBe(true);
  });

  test("does not depend on the order it is given the glyphs in", async () => {
    const glyphs = plannedGlyphs();
    const forward = await buildFont(glyphs);
    const backward = await buildFont([...glyphs].reverse());
    expect(Buffer.from(forward).equals(Buffer.from(backward))).toBe(true);
  });

  test("maps exactly the planned code points, each to a glyph with an outline", async () => {
    const glyphs = plannedGlyphs();
    const font = readFont(await buildFont(glyphs));
    expect(font.codePoints).toEqual(glyphs.map((glyph) => glyph.logo.glyph).sort((a, b) => a - b));
    expect(font.codePoints).toEqual(expect.arrayContaining([0xe900, 0xe901]));
    expect(font.emptyGlyphCodePoints).toEqual([]);
  });

  test("draws each code point from its own logo", async () => {
    const glyphs = plannedGlyphs();
    const font = readFont(await buildFont(glyphs));
    for (const glyph of glyphs) {
      const alone = readFont(await buildFont([glyph]));
      const sameOutline = font.outlineAt(glyph.logo.glyph).equals(alone.outlineAt(glyph.logo.glyph));
      expect(sameOutline, `U+${glyph.logo.glyph.toString(16)} is the ${glyph.logo.id} logo`).toBe(true);
    }
    expect(font.outlineAt(0xe900).equals(font.outlineAt(0xe901))).toBe(false);
  });

  test("maps every glyph of the registry to an outline", async () => {
    const font = readFont(await buildFont(plannedGlyphs()));
    expect(font.codePoints).toEqual(logos.map((logo) => logo.glyph).sort((a, b) => a - b));
    expect(font.emptyGlyphCodePoints).toEqual([]);
  });

  test("names the font family the module's markup asks for", async () => {
    expect(readFont(await buildFont(plannedGlyphs())).family).toBe(ICON_FONT_FAMILY);
    expect(ICON_FONT_FAMILY).toBe("usage-plugin-icons");
  });
});

describe("scripts/build-icon-font.ts", () => {
  async function build(output: string) {
    const proc = Bun.spawn([process.execPath, join(ROOT, "scripts", "build-icon-font.ts"), output], {
      cwd: tempDir(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited, await new Response(proc.stderr).text()).toBe(0);
    return readFileSync(output);
  }

  test("writes a byte-identical font on every build", async () => {
    const dir = tempDir();
    const first = await build(join(dir, "first", "icons.ttf"));
    const second = await build(join(dir, "second", "icons.ttf"));
    expect(first.equals(second)).toBe(true);
    expect(readFont(first).codePoints).toEqual(expect.arrayContaining([0xe900, 0xe901]));
    expect(readdirSync(join(dir, "first"))).toEqual(["icons.ttf"]);
  });
});

function readFont(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tableOffset = (tag: string): number => {
    for (let record = 12; record < 12 + view.getUint16(4) * 16; record += 16) {
      if (String.fromCharCode(...bytes.subarray(record, record + 4)) === tag) return view.getUint32(record + 8);
    }
    throw new Error(`the font has no ${tag} table`);
  };

  const name = tableOffset("name");
  let family = "";
  for (let record = name + 6; record < name + 6 + view.getUint16(name + 2) * 12; record += 12) {
    const isWindowsFamily = view.getUint16(record) === 3 && view.getUint16(record + 6) === 1;
    if (!isWindowsFamily) continue;
    const start = name + view.getUint16(name + 4) + view.getUint16(record + 10);
    family = new TextDecoder("utf-16be").decode(bytes.subarray(start, start + view.getUint16(record + 8)));
  }

  const longLoca = view.getInt16(tableOffset("head") + 50) === 1;
  const loca = tableOffset("loca");
  const glyf = tableOffset("glyf");
  const outlineOf = (glyphId: number): Buffer => {
    const at = (index: number) => (longLoca ? view.getUint32(loca + index * 4) : view.getUint16(loca + index * 2) * 2);
    return Buffer.from(bytes.subarray(glyf + at(glyphId), glyf + at(glyphId + 1)));
  };

  const cmap = tableOffset("cmap");
  const glyphIds = new Map<number, number>();
  for (let record = cmap + 4; record < cmap + 4 + view.getUint16(cmap + 2) * 8; record += 8) {
    const subtable = cmap + view.getUint32(record + 4);
    if (view.getUint16(subtable) !== 4) continue;
    const segments = view.getUint16(subtable + 6) / 2;
    const ends = subtable + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const rangeOffsets = deltas + segments * 2;
    for (let segment = 0; segment < segments; segment += 1) {
      const end = view.getUint16(ends + segment * 2);
      if (end === 0xffff) continue;
      for (let codePoint = view.getUint16(starts + segment * 2); codePoint <= end; codePoint += 1) {
        const rangeOffset = view.getUint16(rangeOffsets + segment * 2);
        const start = view.getUint16(starts + segment * 2);
        const raw =
          rangeOffset === 0
            ? codePoint
            : view.getUint16(rangeOffsets + segment * 2 + rangeOffset + (codePoint - start) * 2);
        const glyphId = (raw + view.getUint16(deltas + segment * 2)) & 0xffff;
        if (glyphId !== 0) glyphIds.set(codePoint, glyphId);
      }
    }
  }

  const codePoints = [...glyphIds.keys()].sort((a, b) => a - b);
  const outlineAt = (codePoint: number): Buffer => outlineOf(glyphIds.get(codePoint) ?? 0);
  return {
    family,
    codePoints,
    emptyGlyphCodePoints: codePoints.filter((codePoint) => outlineAt(codePoint).length === 0),
    outlineAt,
  };
}
