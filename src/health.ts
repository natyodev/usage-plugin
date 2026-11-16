import type { Entry } from "./cache.ts";
import type { Instant, Miss, Reading } from "./domain.ts";

export type Health =
  | { readonly kind: "fresh"; readonly reading: Reading }
  | { readonly kind: "stale"; readonly reading: Reading; readonly holdup: Holdup }
  | { readonly kind: "waiting"; readonly holdup: Exclude<Holdup, { kind: "loginExpired" | "noT3" }> }
  | { readonly kind: "expired" }
  /** `detail` is null when T3 Code, not the provider, could not check. */
  | { readonly kind: "broken"; readonly detail: string | null }
  | { readonly kind: "signedOut" };

export type Holdup =
  | { readonly kind: "loginExpired" }
  | { readonly kind: "rateLimited"; readonly retryAt: Instant }
  | { readonly kind: "unreachable"; readonly cause: Extract<Miss, { kind: "unreachable" }>["cause"] }
  | Extract<Miss, { kind: "noT3" }>;

export function healthOf(entry: Entry): Health {
  if (entry.status === "read") return { kind: "fresh", reading: entry.reading };

  const { miss, reading } = entry;
  switch (miss.kind) {
    case "signedOut":
      return { kind: "signedOut" };
    case "unreadable":
      return { kind: "broken", detail: miss.detail };
    case "loginExpired":
      return reading === null ? { kind: "expired" } : { kind: "stale", reading, holdup: { kind: "loginExpired" } };
    case "rateLimited":
      return heldUp(reading, { kind: "rateLimited", retryAt: entry.dueAt });
    case "unreachable":
      return heldUp(reading, { kind: "unreachable", cause: miss.cause });
    case "probeFailed":
      return { kind: "broken", detail: null };
    case "noT3":
      return reading?.via.kind === "t3" ? { kind: "stale", reading, holdup: miss } : { kind: "signedOut" };
  }
}

function heldUp(reading: Reading | null, holdup: Exclude<Holdup, { kind: "loginExpired" | "noT3" }>): Health {
  return reading === null ? { kind: "waiting", holdup } : { kind: "stale", reading, holdup };
}
