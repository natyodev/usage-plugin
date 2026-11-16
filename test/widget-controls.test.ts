import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closesOnKey, DEBOUNCE_MICROSECONDS, faceOf, INITIAL, plainLabel, sameBurst, step, waitOf } from "../widget/controls.ts";
import type { Hover, Lifecycle, LifecycleEvent, Timing } from "../widget/controls.ts";

const MAIN = readFileSync(join(import.meta.dir, "..", "widget", "main.ts"), "utf8");

describe("sameBurst", () => {
  test("the first click counts", () => {
    expect(sameBurst(null, 5_000_000)).toBe(false);
  });

  test("a click right after one that counted is the same burst", () => {
    expect(sameBurst(5_000_000, 5_000_000 + DEBOUNCE_MICROSECONDS - 1)).toBe(true);
  });

  test("a later click counts again", () => {
    expect(sameBurst(5_000_000, 5_000_000 + DEBOUNCE_MICROSECONDS)).toBe(false);
    expect(sameBurst(5_000_000, 60_000_000)).toBe(false);
  });
});

const TIMING: Timing = { openDelayMs: 150, closeGraceMs: 300 };
const ENTER: LifecycleEvent = { kind: "moduleEnter", timing: TIMING };
const LEAVE: LifecycleEvent = { kind: "moduleLeave", timing: TIMING };
const CLICK: LifecycleEvent = { kind: "moduleClick" };
const INTO_PANEL: LifecycleEvent = { kind: "panelEnter" };
const OUT_OF_PANEL: LifecycleEvent = { kind: "panelLeave" };
const TOGGLE: LifecycleEvent = { kind: "toggle" };
const DISMISS: LifecycleEvent = { kind: "dismiss" };
const TIMEOUT: LifecycleEvent = { kind: "timeout" };

function after(...events: readonly LifecycleEvent[]): Hover {
  return events.reduce(step, INITIAL);
}

function states(...events: readonly LifecycleEvent[]): readonly Lifecycle[] {
  return events.map((_event, index) => after(...events.slice(0, index + 1)).state);
}

describe("hovering the module", () => {
  test("opens the widget once the pointer has rested on it for the open delay", () => {
    expect(states(ENTER, TIMEOUT)).toEqual(["opening", "hover"]);
    expect(waitOf(after(ENTER))).toBe(150);
    expect(waitOf(after(ENTER, TIMEOUT))).toBeNull();
  });

  test("opens nothing for a pointer that only passes over", () => {
    expect(states(ENTER, LEAVE)).toEqual(["opening", "hidden"]);
    expect(waitOf(after(ENTER, LEAVE))).toBeNull();
  });

  test("closes the widget once the pointer has been gone for the close grace", () => {
    expect(states(ENTER, TIMEOUT, LEAVE, TIMEOUT)).toEqual(["opening", "hover", "closing", "hidden"]);
    expect(waitOf(after(ENTER, TIMEOUT, LEAVE))).toBe(300);
  });

  test("keeps the widget open when the pointer moves into the panel, and closes it after it leaves the panel", () => {
    expect(states(ENTER, TIMEOUT, LEAVE, INTO_PANEL, OUT_OF_PANEL, TIMEOUT)).toEqual([
      "opening",
      "hover",
      "closing",
      "hover",
      "closing",
      "hidden",
    ]);
  });

  test("keeps the widget open when the pointer comes back to the module before the grace ends", () => {
    expect(states(ENTER, TIMEOUT, LEAVE, ENTER)).toEqual(["opening", "hover", "closing", "hover"]);
    expect(states(ENTER, TIMEOUT, LEAVE, INTO_PANEL, OUT_OF_PANEL, ENTER).at(-1)).toBe("hover");
  });

  test("waits as long as the module last said", () => {
    const slower: Timing = { openDelayMs: 400, closeGraceMs: 900 };
    expect(waitOf(after({ kind: "moduleEnter", timing: slower }))).toBe(400);
    expect(waitOf(after(ENTER, TIMEOUT, { kind: "moduleLeave", timing: slower }))).toBe(900);
    expect(waitOf(after(ENTER, TIMEOUT, { kind: "moduleLeave", timing: slower }, INTO_PANEL, OUT_OF_PANEL))).toBe(900);
  });
});

describe("clicking the module", () => {
  test("pins the widget, whether or not the hover had opened it yet", () => {
    expect(after(CLICK).state).toBe("pinned");
    expect(after(ENTER, CLICK).state).toBe("pinned");
    expect(after(ENTER, TIMEOUT, CLICK).state).toBe("pinned");
    expect(after(ENTER, TIMEOUT, LEAVE, CLICK).state).toBe("pinned");
  });

  test("a pinned widget stays while the pointer comes and goes", () => {
    expect(states(CLICK, LEAVE, INTO_PANEL, OUT_OF_PANEL, ENTER, TIMEOUT)).toEqual([
      "pinned",
      "pinned",
      "pinned",
      "pinned",
      "pinned",
      "pinned",
    ]);
    expect(waitOf(after(CLICK, LEAVE))).toBeNull();
  });

  test("a second click hands a pinned widget back to the pointer, which closes it by leaving", () => {
    expect(states(CLICK, CLICK, LEAVE, TIMEOUT)).toEqual(["pinned", "hover", "closing", "hidden"]);
  });
});

describe("widget --toggle", () => {
  test("pins a widget that is hidden or only hovered", () => {
    expect(after(TOGGLE).state).toBe("pinned");
    expect(after(ENTER, TOGGLE).state).toBe("pinned");
    expect(after(ENTER, TIMEOUT, TOGGLE).state).toBe("pinned");
    expect(after(ENTER, TIMEOUT, LEAVE, TOGGLE).state).toBe("pinned");
  });

  test("closes a pinned widget", () => {
    expect(states(TOGGLE, TOGGLE)).toEqual(["pinned", "hidden"]);
  });
});

describe("Escape, a click outside and losing the keyboard", () => {
  test("close a pinned widget", () => {
    expect(states(CLICK, DISMISS)).toEqual(["pinned", "hidden"]);
  });

  test("do nothing to a hover widget, which gives the keyboard up when it is unpinned", () => {
    expect(states(CLICK, CLICK, DISMISS)).toEqual(["pinned", "hover", "hover"]);
    expect(after(ENTER, DISMISS).state).toBe("opening");
  });
});

describe("faceOf", () => {
  test("shows nothing until the widget opens, a hover panel while it closes, and a pinned one when pinned", () => {
    const faces = (["hidden", "opening", "hover", "closing", "pinned"] as const).map(faceOf);
    expect(faces).toEqual([null, null, "hover", "hover", "pinned"]);
  });
});

describe("closesOnKey", () => {
  test("is Escape and no other key", () => {
    expect(closesOnKey(0xff1b)).toBe(true);
    expect(closesOnKey(0xff0d)).toBe(false);
    expect(closesOnKey(0x71)).toBe(false);
  });
});

describe("plainLabel", () => {
  test("shows provider text as it is, whatever else is asked for", () => {
    const props = plainLabel("<b>Chat</b> & co", ["chip"], { use_markup: true, use_underline: true, label: "x" });
    expect(props).toMatchObject({ label: "<b>Chat</b> & co", use_markup: false, use_underline: false, css_classes: ["chip"] });
  });
});

describe("widget/main.ts", () => {
  test("builds every label through plainLabel and sets no markup", () => {
    expect(MAIN.match(/new Gtk\.Label\(/g)).toHaveLength(1);
    expect(MAIN).toContain("new Gtk.Label(plainLabel(");
    expect(MAIN).not.toMatch(/markup/i);
  });

  test("decides clicks, keys and the lifecycle through the tested functions", () => {
    expect(MAIN).toMatch(/if \(sameBurst\(clickedAt, now\)\) return;\s*clickedAt = now;\s*dispatch\(event, brought\);/);
    expect(MAIN).toMatch(/if \(!closesOnKey\(keyval\)\) return false;\s*dispatch\(\{ kind: "dismiss" \}\)/);
    expect(MAIN).toMatch(/hover = step\(hover, event\);/);
    expect(MAIN).toMatch(/const wait = waitOf\(hover\);/);
    expect(MAIN).toMatch(/const face = faceOf\(hover\.state\);/);
  });

  test("leaves the screen only by settling the lifecycle", () => {
    expect(MAIN.match(/app\.quit\(\)/g)).toHaveLength(1);
    expect(MAIN).toMatch(/if \(hover\.state === "hidden"\) \{[^}]*if \(!resident\) app\.quit\(\);/);
  });

  test("closes instead of presenting anything when layer shell is missing, where GTK would map an ordinary window", () => {
    const settle = MAIN.slice(MAIN.indexOf("function settle()"));
    expect(settle).toMatch(/if \(hover\.state !== "hidden" && !LayerShell\.is_supported\(\)\) \{[^}]*hover = \{ \.\.\.hover, state: "hidden" \};\s*\}\s*if \(hover\.state === "hidden"\)/);
    expect(settle.indexOf("LayerShell.is_supported()")).toBeLessThan(settle.indexOf("readPayload()"));
    expect(settle.indexOf("LayerShell.is_supported()")).toBeLessThan(settle.indexOf("present("));
    expect(MAIN.match(/LayerShell\.is_supported\(\)/g)).toHaveLength(1);
  });
});
