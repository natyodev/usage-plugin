import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import svg2ttf from "svg2ttf";
import { SVGIcons2SVGFontStream } from "svgicons2svgfont";
import { ICON_FONT_FAMILY } from "../src/domain.ts";
import { logos } from "../src/providers/index.ts";
import type { Logo } from "../src/providers/index.ts";

const ROOT = join(import.meta.dir, "..");
const LOGO_DIR = join(ROOT, "assets", "logos");
const OUTPUT = join(ROOT, "dist", "usage-plugin-icons.ttf");

interface GlyphSource {
  readonly logo: Logo;
  readonly svg: string;
}

type BuildProblem =
  | { readonly kind: "missingSvg"; readonly id: string }
  | { readonly kind: "svgWithoutRow"; readonly file: string }
  | { readonly kind: "colouredSvg"; readonly file: string; readonly found: string };

export function planFont(
  rows: readonly Logo[],
  svgs: ReadonlyMap<string, string>,
):
  | { readonly kind: "plan"; readonly glyphs: readonly GlyphSource[] }
  | { readonly kind: "problems"; readonly problems: readonly BuildProblem[] } {
  const glyphs: GlyphSource[] = [];
  const problems: BuildProblem[] = [];

  for (const logo of rows) {
    const file = `${logo.id}.svg`;
    const svg = svgs.get(file);
    if (svg === undefined) {
      if (logo.hasAdapter) problems.push({ kind: "missingSvg", id: logo.id });
      continue;
    }
    const colour = ownColour(svg);
    if (colour === null) glyphs.push({ logo, svg });
    else problems.push({ kind: "colouredSvg", file, found: colour });
  }

  const claimed = new Set(rows.map((logo) => `${logo.id}.svg`));
  for (const file of svgs.keys()) {
    if (!claimed.has(file)) problems.push({ kind: "svgWithoutRow", file });
  }
  return problems.length === 0 ? { kind: "plan", glyphs } : { kind: "problems", problems };
}

function ownColour(svg: string): string | null {
  const paints = svg.matchAll(/\b(?:fill|stroke)\s*(?:=\s*["']([^"']*)["']|:\s*([^;"']+))/g);
  for (const [, attribute, declaration] of paints) {
    const paint = (attribute ?? declaration ?? "").trim();
    if (!/^(currentColor|none)$/i.test(paint)) return paint;
  }
  return null;
}

export async function buildFont(glyphs: readonly GlyphSource[]): Promise<Uint8Array> {
  const svgFont = new SVGIcons2SVGFontStream({ fontName: ICON_FONT_FAMILY, normalize: true, fontHeight: 1000 });
  const inCodePointOrder = glyphs.toSorted((a, b) => a.logo.glyph - b.logo.glyph);
  for (const { logo, svg } of inCodePointOrder) {
    // The code point is set on each glyph, because the library's own numbering starts at U+EA01.
    const metadata = { name: logo.id, unicode: [String.fromCodePoint(logo.glyph)] };
    svgFont.write(Object.assign(Readable.from([svg]), { metadata }));
  }
  svgFont.end();
  return svg2ttf(await text(svgFont), { ts: 0, version: "1.0" }).buffer;
}

function describe(problem: BuildProblem): string {
  switch (problem.kind) {
    case "missingSvg":
      return `${problem.id} has an adapter and no assets/logos/${problem.id}.svg`;
    case "svgWithoutRow":
      return `assets/logos/${problem.file} matches no row of the registry`;
    case "colouredSvg":
      return `assets/logos/${problem.file} carries its own colour (${problem.found}). Use currentColor`;
  }
}

async function main(output: string): Promise<void> {
  const files = readdirSync(LOGO_DIR).filter((name) => name.endsWith(".svg"));
  const planned = planFont(logos, new Map(files.map((name) => [name, readFileSync(join(LOGO_DIR, name), "utf8")])));
  if (planned.kind === "problems") {
    for (const problem of planned.problems) console.error(`build-icon-font: ${describe(problem)}`);
    process.exit(1);
  }

  mkdirSync(dirname(output), { recursive: true });
  const temp = `${output}.${process.pid}.tmp`;
  writeFileSync(temp, await buildFont(planned.glyphs));
  renameSync(temp, output);
}

if (import.meta.main) await main(process.argv[2] ?? OUTPUT);
