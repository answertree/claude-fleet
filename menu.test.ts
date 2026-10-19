// Tests for the menu (key m) and the slimmer button bar. Nothing here reads a real login or the network.

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as F from "./fleet.ts";

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fleet-menu-test-"));
process.env.XDG_CONFIG_HOME = path.join(SCRATCH, "config");
process.env.XDG_CACHE_HOME = path.join(SCRATCH, "cache");
process.env.FLEET_HOME = path.join(SCRATCH, "home");
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));
const NOW = Date.UTC(2026, 9, 13, 23, 51, 22);
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

describe("the menu", () => {
  test("the one-off features are in it, each on its own key, and off the bar", () => {
    expect(F.menuItems().map((i) => i.key)).toEqual(["d", "b", "w", "t", "i"]);
    const bar = strip(F.buttonBar(220, 44, 0));
    for (const gone of ["Finished agents", "Bell", "Phone", "Telegram"]) expect(bar).not.toContain(gone);
    expect(bar).toContain(" m Menu ");
  });
  test("open, it sits just above the bar, every entry clickable and nothing under it", () => {
    for (const [W, H] of [[80, 24], [150, 44]] as const) {
      F.menu.open = true;
      try {
        const frame = F.render([], W, H, NOW).map(strip);
        expect(frame).toHaveLength(H);
        const at = frame.findIndex((l) => l.includes(" MENU "));
        expect(at).toBeGreaterThan(0);
        const rows = W >= 90 ? 3 : 5;
        expect(at).toBe(H - 2 - rows); // the rule, then the entries, then the bar
        expect(frame.slice(at + 1, H - 1).join("\n")).toContain("Telegram");
        const below = F.clickTargets().filter((h) => h.row > at && h.row < H);
        expect(new Set(below.map((h) => h.act))).toEqual(new Set(["done", "bell", "web", "telegram", "service"]));
        for (const l of frame) expect(F.width(l)).toBeLessThanOrEqual(W);
      } finally {
        F.menu.open = false;
      }
    }
  });
  test("the switches say how they stand", () => {
    const was = F.opt.bell;
    F.opt.bell = true;
    expect(F.menuItems().find((i) => i.key === "b")?.state).toBe("on");
    F.opt.bell = was;
    expect([...F.MENU_SWITCHES]).toEqual(["done", "bell"]);
  });
});

describe("live", () => {
  test("m opens the menu, b in it rings the bell and leaves it open, esc closes it; u opens the usage screen", async () => {
    let out = "";
    const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "demo.ts"), "--plain"], {
      env: { ...process.env, TZ: "UTC", FLEET_NOW: String(NOW) },
      terminal: { cols: 150, rows: 44, data: (_t: unknown, d: Uint8Array) => void (out += new TextDecoder().decode(d)) },
    } as any);
    const t = (proc as any).terminal;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const until = async (ok: () => boolean, ms = 10_000) => {
      for (const end = Date.now() + ms; Date.now() < end && !ok(); ) await sleep(25);
      return ok();
    };
    let mark = 0;
    const after = () => strip(out.slice(mark));
    const write = (s: string) => {
      mark = out.length;
      t.write(s);
    };
    try {
      expect(await until(() => strip(out).includes("q Quit"))).toBe(true);
      write("m");
      expect(await until(() => after().includes(" MENU "))).toBe(true);
      write("b");
      expect(await until(() => /Bell\s+on/.test(after()))).toBe(true);
      write("\x1b");
      await sleep(400);
      expect(proc.exitCode).toBeNull(); // esc closed the menu, not the fleet
      write("u");
      expect(await until(() => after().includes("CLAUDE USAGE"))).toBe(true);
      write("z"); // any key it has no use for closes it
      expect(await until(() => after().includes("q Quit"))).toBe(true);
    } finally {
      proc.kill();
    }
  }, 30_000);
});
