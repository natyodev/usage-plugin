import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a test run leaves nothing behind in the temporary directory", () => {
  const scratch = mkdtempSync(join(tmpdir(), "usage-plugin-cleanup-check-"));
  try {
    const run = Bun.spawnSync([process.execPath, "test", "test/notify.test.ts", "test/theme/widget.test.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, TMPDIR: scratch },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(readdirSync(scratch)).toEqual([]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
