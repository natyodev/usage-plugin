import { describe, expect, test } from "bun:test";
import { extractPalettes, readLiteral } from "../../scripts/extract-t3-palettes.ts";
import { parsePinned } from "../../src/theme/palettes.ts";
import pinned from "../../assets/t3-themes/0.1.9.json";

const ROLES = "canvas.chrome.surface.text.textMuted.accent.warning.error";

function colors(shade: string): string {
  return ROLES.split(".")
    .map((role) => `${role}:\`oklch(${shade} 0.01 150)\``)
    .join(",");
}

const CHUNK = [
  `var Nt=\`${ROLES}\`.split(\`.\`),Pt={${colors("0.98")}},Ft={${colors("0.1")}},`,
  `It={id:\`t3-chat\`,label:\`T3 Chat\`,appearance:\`light\`,colors:{${colors("0.9")}},variants:{dark:{${colors("0.2")}}},sidebarArtwork:!0},`,
  `Lt={id:\`grove\`,label:\`Grove\`,appearance:\`light\`,colors:{${colors("0.8")}},variants:{dark:{${colors("0.3")}}},sidebarArtwork:!0};`,
  "function ea(e){return e===`dark`?ia??=fa({...Ft,canvas:`#000000`}):ra??=fa(Pt)}",
].join("");

describe("extractPalettes", () => {
  test("takes the roles, every built-in theme with its variants, and the standard palette with T3's dark canvas", () => {
    const palettes = extractPalettes(CHUNK, "9.9.9");
    expect(palettes.version).toBe("9.9.9");
    expect(palettes.roles).toEqual(ROLES.split("."));
    expect(Object.keys(palettes.themes)).toEqual(["t3-chat", "grove"]);
    expect(palettes.themes.grove?.appearance).toBe("light");
    expect(palettes.themes.grove?.colors.accent).toBe("oklch(0.8 0.01 150)");
    expect(palettes.themes.grove?.variants?.dark?.canvas).toBe("oklch(0.3 0.01 150)");
    expect(palettes.standard.light.canvas).toBe("oklch(0.98 0.01 150)");
    expect(palettes.standard.dark.canvas).toBe("#000000");
    expect(palettes.standard.dark.surface).toBe("oklch(0.1 0.01 150)");
  });

  test("refuses a chunk whose theme misses a role, rather than pinning a partial palette", () => {
    expect(() => extractPalettes(CHUNK.replace("variants:{dark:{canvas", "variants:{dark:{base"), "9.9.9")).toThrow(/misses roles/);
  });
});

describe("readLiteral", () => {
  test("reads quoted keys, numbers, arrays and the minifier's booleans", () => {
    expect(readLiteral(`{"a":1.5,'b':[!0,!1,-2e3],c:\`x\`}`, 0)).toEqual({ a: 1.5, b: [true, false, -2000], c: "x" });
  });

  test("refuses code: a template substitution, a call, or an unknown name", () => {
    expect(() => readLiteral("{a:`${evil()}`}", 0)).toThrow(/substitution/);
    expect(() => readLiteral("{a:fetch(`x`)}", 0)).toThrow(/not a literal/);
    expect(() => readLiteral("{...nowhere}", 0)).toThrow(/never assigns/);
  });
});

describe("the pinned 0.1.9 palettes", () => {
  test("hold T3's five built-in themes, each with a light and a dark palette", () => {
    const palettes = parsePinned(pinned);
    expect(palettes.version).toBe("0.1.9");
    expect(Object.keys(palettes.themes).sort()).toEqual(["ember", "grove", "iris", "ocean", "t3-chat"]);
    for (const theme of Object.values(palettes.themes)) {
      expect(theme.appearance).toBe("light");
      expect(Object.keys(theme.variants ?? {})).toEqual(["dark"]);
    }
    expect(palettes.standard.dark.canvas).toBe("#000000");
  });
});
