import { isRecord } from "../domain.ts";

export type Appearance = "light" | "dark";

/** Role name to a CSS colour, as T3 writes it, such as `oklch(0.972 0.005 157.15)` or `#fcfcfc`. */
export type ThemeColors = Readonly<Record<string, string>>;

/** T3's `ThemeDefinition`, cut to what decides colours. */
export interface ThemeDefinition {
  readonly appearance: Appearance;
  readonly colors: ThemeColors;
  readonly variants?: Readonly<Partial<Record<Appearance, ThemeColors>>>;
}

export interface PinnedPalettes {
  /** T3 Code's version, from its package.json. */
  readonly version: string;
  /** Every colour role of that version, in T3's order. */
  readonly roles: readonly string[];
  /** What T3 paints when no theme is picked. */
  readonly standard: Readonly<Record<Appearance, ThemeColors>>;
  /** The built-in themes, by id. */
  readonly themes: Readonly<Record<string, ThemeDefinition>>;
}

export function isAppearance(value: unknown): value is Appearance {
  return value === "light" || value === "dark";
}

/** Throws on a file that does not have the shape the extractor writes. */
export function parsePinned(value: unknown): PinnedPalettes {
  const fail = (what: string): never => {
    throw new Error(`a pinned T3 palette file ${what}`);
  };
  if (!isRecord(value) || typeof value.version !== "string") return fail("has no version");
  const { version, roles, standard, themes } = value;
  if (!Array.isArray(roles) || !roles.every((role) => typeof role === "string")) return fail(`${version} has no roles`);
  const colorsOf = (colors: unknown, where: string): ThemeColors => {
    if (!isRecord(colors) || !roles.every((role) => typeof colors[role] === "string")) return fail(`${version} misses roles in ${where}`);
    return colors as ThemeColors;
  };
  if (!isRecord(standard)) return fail(`${version} has no standard palette`);
  const parsedThemes: Record<string, ThemeDefinition> = {};
  for (const [id, theme] of Object.entries(isRecord(themes) ? themes : fail(`${version} has no themes`))) {
    if (!isRecord(theme) || !isAppearance(theme.appearance)) return fail(`${version} has a theme ${id} without an appearance`);
    const variants = isRecord(theme.variants) ? theme.variants : {};
    parsedThemes[id] = {
      appearance: theme.appearance,
      colors: colorsOf(theme.colors, id),
      variants: Object.fromEntries(
        Object.entries(variants).map(([mode, colors]) =>
          isAppearance(mode) ? [mode, colorsOf(colors, `${id}'s ${mode} variant`)] : fail(`${version} has a variant ${mode} of ${id}`),
        ),
      ),
    };
  }
  return {
    version,
    roles: roles as string[],
    standard: { light: colorsOf(standard.light, "standard light"), dark: colorsOf(standard.dark, "standard dark") },
    themes: parsedThemes,
  };
}
