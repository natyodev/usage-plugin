import { afterAll } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runRoot = mkdtempSync(join(tmpdir(), "usage-plugin-test-"));
process.env.TMPDIR = runRoot;
afterAll(() => rmSync(runRoot, { recursive: true, force: true }));

process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/nonexistent/usage-plugin-test-bus";
const noT3 = mkdtempSync(join(tmpdir(), "usage-plugin-no-t3-"));
writeFileSync(join(noT3, "t3"), "#!/bin/sh\necho 'a test ran t3' >&2\nexit 97\n");
chmodSync(join(noT3, "t3"), 0o755);
process.env.PATH = `${noT3}:${process.env.PATH ?? ""}`;
const realFetch = globalThis.fetch;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

globalThis.fetch = Object.assign(
  (input: Parameters<typeof realFetch>[0], init?: Parameters<typeof realFetch>[1]) => {
    const { hostname } = new URL(input instanceof Request ? input.url : input.toString());
    if (!LOOPBACK.has(hostname)) throw new Error(`a test tried to reach ${hostname}`);
    return realFetch(input, init);
  },
  { preconnect: realFetch.preconnect },
);
