import { describe, expect, test } from "bun:test";
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { moduleLine } from "../../src/render/module.ts";
import type { Layout } from "../../src/render/module.ts";
import { isProviderId } from "../../src/providers/index.ts";
import { deadlineFromNow, fixtureCase, requestsIn, tempDir, testRun } from "../support.ts";
import type { TestRun } from "../support.ts";

const logo = (codePoint: number) =>
  `<span font_family='usage-plugin-icons' size='x-large'>${String.fromCodePoint(codePoint)}</span>`;
const CLAUDE_LOGO = logo(0xe900);
const GROK_LOGO = logo(0xe901);

const CLAUDE_TOOLTIP = [
  "<b>Claude</b>",
  "<tt>5-hour ███░░░░░░░  34% left</tt>  resets in 23m",
  "<tt>Weekly █████████░  88% left</tt>  resets in 3d 6h",
  "direct",
];

async function module(run: TestRun, options: { readonly only?: string; readonly layout?: Layout } = {}) {
  const only = options.only ?? null;
  if (only !== null && !isProviderId(only)) throw new Error(`not a provider: ${only}`);
  return JSON.parse(await moduleLine({ only, layout: options.layout ?? "inline" }, run));
}

function grokSignedOut(): string {
  const dir = join(tempDir(), "grok-ok");
  cpSync(fixtureCase("grok-ok"), dir, { recursive: true });
  rmSync(join(dir, "home", ".grok", "auth.json"));
  return dir;
}

describe("the combined module", () => {
  test("shows Grok after Claude with its weekly percent left", async () => {
    expect(await module(testRun({ fixtures: fixtureCase("grok-ok") }))).toEqual({
      text: `${CLAUDE_LOGO} 34%  ${GROK_LOGO} 41%`,
      tooltip: [...CLAUDE_TOOLTIP, "<b>Grok</b>", "<tt>Weekly ████░░░░░░  41% left</tt>  resets in 2d 16h", "direct"].join("\n"),
      class: ["ok", "claude", "grok", "claude-ok", "grok-ok"],
      percentage: 34,
    });
  });

  test("stacks Grok below Claude in a vertical bar", async () => {
    const line = await module(testRun({ fixtures: fixtureCase("grok-ok") }), { layout: "stacked" });
    expect(line.text).toBe(`${CLAUDE_LOGO}\n34%\n<span size='5pt'> </span>\n${GROK_LOGO}\n41%`);
  });

  test("marks Grok critical while Claude stays ok", async () => {
    const line = await module(testRun({ fixtures: fixtureCase("grok-92") }));
    expect(line).toMatchObject({ class: ["critical", "claude", "grok", "claude-ok", "grok-critical"], percentage: 8 });
  });

  test("shows the legacy shape as broken, not as 0 percent", async () => {
    const line = await module(testRun({ fixtures: fixtureCase("grok-legacy-shape") }));
    expect(line.text).toBe(`${CLAUDE_LOGO} 34%  ${GROK_LOGO} <span foreground='#E5484D' weight='bold'>!</span>`);
    expect(line.tooltip).toContain("cannot read Grok&apos;s reply: config.creditUsagePercent is not a number");
    expect(line.class).toEqual(["ok", "broken", "claude", "grok", "claude-ok", "grok-broken"]);
  });

  test("hides Grok when its auth file is gone and still shows Claude", async () => {
    const run = testRun({ fixtures: grokSignedOut() });
    expect(await module(run)).toMatchObject({ text: `${CLAUDE_LOGO} 34%`, class: ["ok", "claude", "claude-ok"] });
    expect(requestsIn(run.events)).toMatchObject([{ provider: "claude" }]);
  });

  test("on a 401 asks for the Grok login once and tells the user how to renew it", async () => {
    const run = testRun({ fixtures: fixtureCase("grok-401") });
    const line = await module(run, { only: "grok" });
    expect(line).toEqual({
      text: `<span fgalpha='50%'>${GROK_LOGO}</span> <b>?</b>`,
      tooltip: "<b>Grok</b>\nlogin expired, run `grok` to refresh login",
      class: ["expired", "grok", "grok-expired"],
      percentage: 0,
    });
    const grokRequests = requestsIn(run.events).filter((event) => "provider" in event && event.provider === "grok");
    expect(grokRequests).toMatchObject([{ url: "https://cli-chat-proxy.grok.com/v1/billing?format=credits" }]);
  });

  test("prints inside one second with Claude intact while Grok hangs", async () => {
    const startedAt = performance.now();
    const line = await module(testRun({ fixtures: fixtureCase("grok-hang"), deadline: deadlineFromNow(750) }));
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(line.text).toBe(`${CLAUDE_LOGO} 34%  <span fgalpha='50%'>${GROK_LOGO} –</span>`);
    expect(line.tooltip).toEndWith("<b>Grok</b>\nno reading yet. no answer in time");
    expect(line.class).toEqual(["ok", "waiting", "claude", "grok", "claude-ok", "grok-waiting"]);
  });
});

test("the split module --provider grok renders Grok alone", async () => {
  const line = await module(testRun({ fixtures: fixtureCase("grok-ok") }), { only: "grok" });
  expect(line).toMatchObject({ text: `${GROK_LOGO} 41%`, class: ["ok", "grok", "grok-ok"], percentage: 41 });
});
