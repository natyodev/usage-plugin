import type { Run } from "../cache.ts";
import type { SourceSetting } from "../config.ts";
import type { Miss } from "../domain.ts";
import { providers as registered } from "../providers/index.ts";
import type { Adapter, FetchContext, FetchResult, Listed } from "../providers/index.ts";
import { readT3 } from "./t3.ts";
import type { T3Read } from "./t3.ts";

const OWN_ADAPTER_RESERVE_MS = 300;

/**
 * The providers the cache fetches, each with a `fetch` that picks its source.
 *
 *   direct  the provider's own adapter. T3 is never contacted, and a T3-only provider is left out.
 *   t3      T3 Code. No adapter is ever called.
 *   auto    T3 Code when it reports the provider, else the provider's own adapter. When that finds
 *           no login either, the reason T3 gave nothing stands in for "signed out", so a reading
 *           T3 brought earlier stays on the bar, dimmed, with "open T3 Code".
 *
 * A row with neither a T3 driver nor an adapter only lends its logo, and is never fetched.
 * Every provider fetched in one run shares one T3 read, so a poll sends one `server.getConfig`.
 */
export function sourcedProviders(setting: SourceSetting, run: Run, rows: readonly Listed[] = registered): readonly Adapter[] {
  if (setting === "direct") return rows.flatMap(({ fetch, ...provider }) => (fetch === null ? [] : [{ ...provider, fetch }]));

  let shared: Promise<T3Read> | null = null;
  const t3 = () => {
    shared ??= readT3(run, setting === "auto" ? OWN_ADAPTER_RESERVE_MS : 0);
    return shared;
  };
  return rows.flatMap((row) => {
    if (row.t3Driver === null && (setting === "t3" || row.fetch === null)) return [];
    const { fetch: own, ...provider } = row;
    const { t3Driver } = row;
    const fetch = async (ctx: FetchContext): Promise<FetchResult> => {
      const read: T3Read = t3Driver === null ? { kind: "answered", byDriver: new Map() } : await t3();
      const fromT3 = reported(read, t3Driver);
      if (fromT3 !== null) return fromT3;
      if (setting === "t3" || own === null) return unreportedMiss(read);
      const direct = await own(ctx);
      if (direct.kind === "signedOut") return unreportedMiss(read);
      if (direct.kind !== "windows" || read.kind !== "unusable" || read.why.kind !== "unsupported") return direct;
      return { ...direct, via: { kind: "direct", unsupportedT3: read.why.version } };
    };
    return [{ ...provider, fetch }];
  });
}

function reported(read: T3Read, driver: string | null): FetchResult | null {
  const limits = read.kind === "answered" && driver !== null ? read.byDriver.get(driver) : undefined;
  if (limits === undefined) return null;
  if (limits.kind === "probeFailed") return { kind: "probeFailed" };
  return { kind: "windows", windows: limits.windows, plan: null, via: { kind: "t3" } };
}

function unreportedMiss(read: T3Read): Miss {
  return read.kind === "unusable" ? { kind: "noT3", why: read.why } : { kind: "signedOut" };
}
