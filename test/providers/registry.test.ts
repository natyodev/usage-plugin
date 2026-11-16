import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isGlyph } from "../../src/domain.ts";
import { adapters, isProviderId, logos, providers } from "../../src/providers/index.ts";

const LOGO_DIR = join(import.meta.dir, "..", "..", "assets", "logos");

test("every id and every glyph is used once", () => {
  const ids = logos.map((logo) => logo.id);
  const glyphs = logos.map((logo) => logo.glyph);
  expect(new Set(ids).size).toBe(ids.length);
  expect(new Set(glyphs).size).toBe(glyphs.length);
  expect(new Set(adapters.map((adapter) => adapter.id)).size).toBe(adapters.length);
});

test("every glyph is a private use code point from U+E900", () => {
  for (const logo of logos) expect(isGlyph(logo.glyph)).toBe(true);
});

test("the code points the installed prototype font already maps stay where they are", () => {
  const glyphOf = Object.fromEntries(logos.map((logo) => [logo.id, logo.glyph]));
  expect(glyphOf).toMatchObject({ claude: 0xe900, grok: 0xe901, codex: 0xe902, gemini: 0xe903 });
});

test("every adapter has its logo SVG", () => {
  for (const adapter of adapters) {
    expect(existsSync(join(LOGO_DIR, `${adapter.id}.svg`)), `assets/logos/${adapter.id}.svg`).toBe(true);
  }
});

test("every adapter is a row of the logo table, with the same glyph", () => {
  for (const adapter of adapters) {
    expect(logos).toContainEqual({ id: adapter.id, glyph: adapter.glyph, hasAdapter: true });
  }
  expect(logos.filter((logo) => logo.hasAdapter)).toHaveLength(adapters.length);
});

test("Claude is registered with the command that renews its login", () => {
  expect(adapters).toContainEqual(expect.objectContaining({ id: "claude", name: "Claude", loginCommand: "claude" }));
});

test("isProviderId accepts exactly the ids of named rows, with an adapter or read only through T3 Code", () => {
  for (const provider of providers) expect(isProviderId(provider.id)).toBe(true);
  expect(providers.map((provider): string => provider.id)).toEqual(["claude", "grok", "codex", "cursor", "antigravity", "muse"]);
  for (const id of ["gemini", "", "nope", "Claude", "toString", "__proto__", "constructor"]) expect(isProviderId(id)).toBe(false);
});

test("every provider has its logo SVG", () => {
  for (const provider of providers) {
    expect(existsSync(join(LOGO_DIR, `${provider.id}.svg`)), `assets/logos/${provider.id}.svg`).toBe(true);
  }
});
