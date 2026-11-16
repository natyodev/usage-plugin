/**
 * Writes `assets/t3-themes/<version>.json` from an installed T3 Code: its built-in themes and its
 * standard palette, every role as T3 wrote it. Reads the bundle chunk as text with a small object
 * literal reader. Never evaluates it.
 *
 *   bun scripts/extract-t3-palettes.ts /opt/t3code-bin/resources/app.asar
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asarPaths, asarVersion, openAsar, readAsarFile } from "../src/theme/asar.ts";
import { isAppearance, parsePinned } from "../src/theme/palettes.ts";
import type { PinnedPalettes, ThemeColors, ThemeDefinition } from "../src/theme/palettes.ts";

const OUTPUT_DIR = join(import.meta.dir, "..", "assets", "t3-themes");
const CHUNK = /(?:^|\/)themePalette-[\w-]+\.js$/;

type Literal = string | number | boolean | null | readonly Literal[] | { readonly [key: string]: Literal };

export function extractPalettes(chunk: string, version: string): PinnedPalettes {
  const roles = /`(canvas\.chrome\.[A-Za-z.]+)`/.exec(chunk)?.[1]?.split(".").filter(Boolean);
  if (roles === undefined) throw new Error("the chunk has no list of colour roles starting canvas.chrome");

  const themes: Record<string, ThemeDefinition> = {};
  for (const match of chunk.matchAll(/\{id:`([a-z0-9-]+)`,label:`/g)) {
    const theme = readLiteral(chunk, match.index);
    if (!isObject(theme) || typeof theme.id !== "string") throw new Error(`the theme at ${match.index} has no id`);
    themes[theme.id] = definitionOf(theme);
  }

  // T3's getStandardThemeColors: `e===`dark`?x??=decode({...DARK,canvas:`#000000`}):y??=decode(LIGHT)`.
  const standard = /===`dark`\?\w+\?\?=\w+\((\{[^}]*\})\):\w+\?\?=\w+\((\w+)\)/.exec(chunk);
  if (standard?.index === undefined || standard[1] === undefined || standard[2] === undefined) {
    throw new Error("the chunk has no standard palette choice between dark and light");
  }
  const darkAt = standard.index + standard[0].indexOf(standard[1]);
  return parsePinned({
    version,
    roles,
    standard: { light: definitionLiteral(chunk, standard[2]), dark: readLiteral(chunk, darkAt) },
    themes,
  });
}

function definitionOf(theme: { readonly [key: string]: Literal }): ThemeDefinition {
  const { appearance, colors, variants } = theme;
  if (!isAppearance(appearance) || !isObject(colors)) throw new Error(`theme ${String(theme.id)} has no appearance or colours`);
  return {
    appearance,
    colors: colors as ThemeColors,
    ...(isObject(variants) ? { variants: variants as Readonly<Record<string, ThemeColors>> } : {}),
  };
}

function isObject(value: Literal | undefined): value is { readonly [key: string]: Literal } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function definitionLiteral(chunk: string, name: string): Literal {
  const found = new RegExp(`[,;\\s]${name}=\\{`).exec(chunk);
  if (found === null) throw new Error(`the chunk never assigns ${name} an object`);
  return readLiteral(chunk, found.index + found[0].length - 1);
}

/**
 * Reads the JavaScript literal at `start`: objects (bare, quoted or backtick keys, `...name`
 * spreads of other literals), arrays, strings without `${`, numbers, and the minifier's `!0` and `!1`.
 */
export function readLiteral(source: string, start: number): Literal {
  let at = start;
  const fail = (what: string): never => {
    throw new Error(`${what} at ${at}: ${JSON.stringify(source.slice(at, at + 40))}`);
  };
  const skip = () => {
    while (/\s/.test(source[at] ?? "")) at += 1;
  };
  const string = (): string => {
    const quote = source[at] as string;
    let end = at + 1;
    let text = "";
    while (source[end] !== quote) {
      if (end >= source.length) fail("a string is never closed");
      if (quote === "`" && source[end] === "$" && source[end + 1] === "{") fail("a template string has a substitution");
      if (source[end] === "\\") end += 1;
      text += source[end++];
    }
    at = end + 1;
    return text;
  };
  const word = (what: string): string => {
    const pattern = /[\w$]+/y;
    pattern.lastIndex = at;
    const name = pattern.exec(source)?.[0] ?? fail(what);
    at += name.length;
    return name;
  };
  const value = (): Literal => {
    skip();
    const char = source[at];
    if (char === "{") {
      at += 1;
      const object: Record<string, Literal> = {};
      for (;;) {
        skip();
        if (source[at] === "}") break;
        if (source.startsWith("...", at)) {
          at += 3;
          const spread = definitionLiteral(source, word("a spread of something other than a name"));
          if (!isObject(spread)) fail("a spread of something other than an object");
          Object.assign(object, spread);
        } else {
          const key = source[at] === "`" || source[at] === '"' || source[at] === "'" ? string() : word("a key");
          skip();
          if (source[at] !== ":") fail(`expected a colon after ${key}`);
          at += 1;
          object[key] = value();
        }
        skip();
        if (source[at] === ",") at += 1;
        else if (source[at] !== "}") fail("expected a comma or a closing brace");
      }
      at += 1;
      return object;
    }
    if (char === "[") {
      at += 1;
      const items: Literal[] = [];
      for (;;) {
        skip();
        if (source[at] === "]") break;
        items.push(value());
        skip();
        if (source[at] === ",") at += 1;
        else if (source[at] !== "]") fail("expected a comma or a closing bracket");
      }
      at += 1;
      return items;
    }
    if (char === "`" || char === '"' || char === "'") return string();
    if (source.startsWith("!0", at) || source.startsWith("!1", at)) {
      at += 2;
      return source[at - 1] === "0";
    }
    const pattern = /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/y;
    pattern.lastIndex = at;
    const number = pattern.exec(source)?.[0];
    if (number === undefined) return fail("not a literal");
    at += number.length;
    return Number(number);
  };
  return value();
}

function main(argv: readonly string[]): void {
  const [path] = argv;
  if (path === undefined || argv.length !== 1) {
    console.error("usage: bun scripts/extract-t3-palettes.ts <path to T3 Code's app.asar>");
    process.exit(2);
  }
  const asar = openAsar(path);
  const version = asarVersion(asar);
  if (version === null) throw new Error(`${path} has no version in its package.json`);
  const chunks = asarPaths(asar.header).filter((inner) => CHUNK.test(inner));
  if (chunks.length !== 1) throw new Error(`expected one themePalette chunk in ${path}, found ${chunks.length}: ${chunks.join(", ")}`);
  const chunk = Buffer.from(readAsarFile(asar, chunks[0] as string)).toString("utf8");
  const palettes = extractPalettes(chunk, version);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const output = join(OUTPUT_DIR, `${version}.json`);
  writeFileSync(`${output}.tmp`, `${JSON.stringify(palettes, null, 2)}\n`);
  renameSync(`${output}.tmp`, output);
  console.log(`wrote ${output}: ${Object.keys(palettes.themes).join(", ")} and the standard palette, ${palettes.roles.length} roles each`);
}

if (import.meta.main) main(process.argv.slice(2));
