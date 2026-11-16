import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isGlyph } from "../../src/domain.ts";
import { T3_DRIVERS } from "../support.ts";
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

/** Every code point ever assigned. Append new rows. Never edit or remove one. */
const ASSIGNED: (readonly [string, number])[] = [
  ["claude", 0xe900],
  ["grok", 0xe901],
  ["codex", 0xe902],
  ["gemini", 0xe903],
  ["cursor", 0xe904],
  ["antigravity", 0xe905],
  ["muse", 0xe906],
  ["opencode", 0xe907],
  ["pi", 0xe908],
  ["kiro", 0xe909],
  ["fx", 0xe90a],
  ["acp-registry", 0xe90b],
  ["github-copilot", 0xe90c],
  ["windsurf", 0xe90d],
  ["amp", 0xe90e],
  ["cline", 0xe90f],
  ["roo-code", 0xe910],
  ["kilo-code", 0xe911],
  ["trae", 0xe912],
  ["qoder", 0xe913],
  ["openai", 0xe914],
  ["anthropic", 0xe915],
  ["xai", 0xe916],
  ["deepseek", 0xe917],
  ["mistral", 0xe918],
  ["qwen", 0xe919],
  ["kimi", 0xe91a],
  ["zhipu", 0xe91b],
  ["zai", 0xe91c],
  ["minimax", 0xe91d],
  ["perplexity", 0xe91e],
  ["openrouter", 0xe91f],
  ["groq", 0xe920],
  ["cerebras", 0xe921],
  ["together", 0xe922],
  ["fireworks", 0xe923],
  ["replicate", 0xe924],
  ["huggingface", 0xe925],
  ["vertex-ai", 0xe926],
  ["azure-openai", 0xe927],
  ["bedrock", 0xe928],
  ["meta", 0xe929],
  ["cohere", 0xe92a],
  ["ollama", 0xe92b],
  ["lmstudio", 0xe92c],
  ["baichuan", 0xe92d],
  ["doubao", 0xe92e],
  ["hunyuan", 0xe92f],
];

test("rows are append only: every code point ever assigned keeps its id and its place", () => {
  expect(logos.slice(0, ASSIGNED.length).map((logo): readonly [string, number] => [logo.id, logo.glyph])).toEqual(ASSIGNED);
  const glyphs = logos.map((logo): number => logo.glyph);
  expect(glyphs).toEqual(glyphs.toSorted((a, b) => a - b));
});

test("every driver T3 Code ships maps to exactly one provider", () => {
  for (const driver of T3_DRIVERS) expect(providers.filter((provider) => provider.t3Driver === driver), driver).toHaveLength(1);
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
  expect(providers.map((provider): string => provider.id)).toEqual(logos.map((logo) => logo.id));
  for (const id of ["", "nope", "Claude", "toString", "__proto__", "constructor"]) expect(isProviderId(id)).toBe(false);
});

test("every provider has its logo SVG", () => {
  for (const provider of providers) {
    expect(existsSync(join(LOGO_DIR, `${provider.id}.svg`)), `assets/logos/${provider.id}.svg`).toBe(true);
  }
});
