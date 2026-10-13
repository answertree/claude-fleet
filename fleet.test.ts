// Tests for the parts of fleet.ts that are plain logic. Run with: bun test
// Nothing here reads a real login, a real transcript or the network.

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import * as F from "./fleet.ts";

const here = import.meta.dir;
/** A fixed clock for every test: Tue 13 Oct 2026, 23:51:22 local time. */
const NOW = new Date(2026, 9, 13, 23, 51, 22).getTime();
const MIN = 60_000;
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

/** A tail fed with transcript rows, as pump() would feed it from a file. */
function tailOf(rows: object[], file = "memory.jsonl"): F.Tail {
  const t = F.newTail(file);
  for (const r of rows) F.ingest(t, JSON.stringify(r));
  return t;
}
const iso = (t: number) => new Date(t).toISOString();
const toolCall = (t: number, name = "Bash", input: object = { description: "Run the tests" }, id = `m${t}`) => ({
  type: "assistant",
  timestamp: iso(t),
  message: { id, model: "claude-opus-5-5", content: [{ type: "tool_use", name, input }], usage: { input_tokens: 4, cache_read_input_tokens: 90_000, output_tokens: 100 } },
});
const toolResult = (t: number) => ({ type: "user", timestamp: iso(t), message: { content: [{ type: "tool_result" }] } });
const reply = (t: number, text: string, used = 90_000) => ({
  type: "assistant",
  timestamp: iso(t),
  message: { id: `s${t}`, model: "claude-opus-5-5", content: [{ type: "text", text }], usage: { input_tokens: 4, cache_read_input_tokens: used, output_tokens: 300 } },
});
const prompt = (t: number, text: string) => ({ type: "user", timestamp: iso(t), message: { content: text } });

describe("program shape", () => {
  test("importing fleet.ts runs nothing and prints nothing", () => {
    const r = Bun.spawnSync(["bun", "-e", `await import(${JSON.stringify(path.join(here, "fleet.ts"))}); console.log("imported")`], { timeout: 20_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("imported\n");
    expect(r.stderr.toString()).toBe("");
  });

  test("parseArgs reads the window, the mode and the switches", () => {
    const before = { ...F.opt };
    try {
      expect(F.parseArgs(["--help"])).toBe("help");
      expect(F.parseArgs(["--mode", "far", "45", "--all", "--bell", "--no-mouse", "--once"])).toBeUndefined();
      expect(F.opt.mode).toBe("far");
      expect(F.opt.windowMin).toBe(45);
      expect(F.opt.showAll).toBe(true);
      expect(F.opt.bell).toBe(true);
      expect(F.opt.mouse).toBe(false);
      expect(F.opt.once).toBe(true);
      F.parseArgs(["--mode", "sideways"]);
      expect(F.opt.mode).toBe("far"); // an unknown mode changes nothing
    } finally {
      Object.assign(F.opt, before);
    }
  });
});

describe("text helpers", () => {
  test("fit pads and cuts to an exact number of cells", () => {
    expect(F.fit("abc", 5)).toBe("abc  ");
    expect(F.fit("abc", 5, "r")).toBe("  abc");
    expect(F.fit("abcdefgh", 5)).toBe("abcd…");
    expect(F.width(F.fit("日本語のテキスト", 7))).toBe(7);
    expect(F.fit("anything", 0)).toBe("");
  });

  test("ago and human keep their short forms", () => {
    expect(F.ago(3_000)).toBe("now");
    expect(F.ago(42_000)).toBe("42s");
    expect(F.ago(6 * MIN)).toBe("6m");
    expect(F.ago(64 * MIN)).toBe("1h04");
    expect(F.human(999)).toBe("999");
    expect(F.human(7_900)).toBe("7.9k");
    expect(F.human(558_000)).toBe("558k");
    expect(F.human(1_000_000)).toBe("1.0M");
  });

  test("ingest records tool calls, replies, prompts and the context reading", () => {
    const t = tailOf([prompt(NOW - 29 * MIN, "fix the tests"), toolCall(NOW - 5 * MIN), toolResult(NOW - 5 * MIN + 900), reply(NOW - 2 * MIN, "Done.", 123_000)]);
    expect(t.tools).toEqual([NOW - 5 * MIN]);
    expect(t.ask).toEqual({ text: "fix the tests", t: NOW - 29 * MIN });
    expect(t.say?.text).toBe("Done.");
    expect(t.ctx?.used).toBe(123_004);
    expect(t.lastT).toBe(NOW - 2 * MIN);
    expect(strip(F.spark([0, 1, 4], 4, [0, 0, 0], [255, 255, 255]))).toBe("▁▄█");
  });
});

/** A session as scan() would build it, without touching the disk. */
function sessionOf(o: Partial<F.Session> & { sid: string }): F.Session {
  return { pid: 0, name: o.sid, kind: "bg", status: "busy", cwd: "/work/shop", startedAt: NOW - 64 * MIN - 30_000, mains: [], agents: [], workflows: [], ...o };
}
const agentOf = (id: string, tail: F.Tail, o: Partial<F.Agent> = {}): F.Agent => ({ id, label: id, type: "Explore", model: "haiku", tail, done: false, ...o });
/** `count` tool-call times spread over the `spanMin` minutes before `end`, the same every run. */
function callTimes(count: number, end: number, spanMin = 30, seed = 7): number[] {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return Array.from({ length: count }, () => Math.round(end - rnd() * spanMin * MIN)).sort((a, b) => a - b);
}

describe("graphs hold still", () => {
  const WINDOW = 30 * MIN;

  test("bars sit on clock edges and the window ends with the bar still filling", () => {
    for (const n of [20, 25, 30, 58, 110]) {
      const bar = WINDOW / n;
      const win = F.timeWindow(NOW, WINDOW, n);
      expect(win.bar).toBe(bar);
      expect(win.end).toBeCloseTo(Math.ceil(NOW / bar) * bar, 3);
      expect(win.end - win.start).toBeCloseTo(WINDOW, 3);
      expect(win.start).toBeCloseTo(win.first * bar, 6);
      expect(win.end).toBeGreaterThan(NOW);
      expect(win.end - NOW).toBeLessThanOrEqual(bar);
      expect(F.barOf(NOW, win)).toBe(n - 1); // "now" is always in the rightmost bar
    }
    // Exactly on an edge, the bar that has just opened is the one still filling.
    const edge = Math.ceil(NOW / MIN) * MIN;
    const win = F.timeWindow(edge, WINDOW, 30);
    expect(win.end).toBe(edge + MIN);
    expect(F.bucketsIn([[edge - 1, edge]], win).slice(-2)).toEqual([1, 1]);
  });

  test("with fixed data, every second inside one bar gives identical buckets and totals", () => {
    const calls = callTimes(400, NOW);
    for (const n of [20, 25, 30, 58, 110]) {
      const first = F.timeWindow(NOW, WINDOW, n);
      const base = F.bucketsIn([calls], first);
      expect(F.sum(base)).toBeGreaterThan(300);
      // Walk second by second from the start of the bar that holds NOW to its last whole second.
      const barStart = Math.ceil((first.end - first.bar) / 1000) * 1000;
      let checked = 0;
      for (let now = barStart; now < first.end; now += 1000) {
        const b = F.bucketsIn([calls], F.timeWindow(now, WINDOW, n));
        expect(b).toEqual(base);
        checked++;
      }
      expect(checked).toBeGreaterThanOrEqual(Math.floor(first.bar / 1000));
    }
  });

  test("when a bar closes the strip shifts left by exactly one cell", () => {
    const calls = callTimes(400, NOW);
    for (const n of [20, 25, 30, 58]) {
      const before = F.timeWindow(NOW, WINDOW, n);
      const after = F.timeWindow(before.end, WINDOW, n); // the first moment of the next bar
      expect(after.first).toBe(before.first + 1);
      const a = F.bucketsIn([calls], before);
      const b = F.bucketsIn([calls], after);
      expect(b.slice(0, n - 1)).toEqual(a.slice(1));
      expect(b[n - 1]).toBe(0); // the new bar is empty until a call lands in it
      // and one second earlier nothing had moved
      expect(F.bucketsIn([calls], F.timeWindow(before.end - 1000, WINDOW, n))).toEqual(a);
    }
  });

  test("a call that lands changes only its own bar", () => {
    const calls = callTimes(120, NOW - 2 * MIN);
    const win = F.timeWindow(NOW, WINDOW, 30);
    const a = F.bucketsIn([calls], win);
    const b = F.bucketsIn([[...calls, NOW - 5_000]], win);
    expect(b.slice(0, 29)).toEqual(a.slice(0, 29));
    expect(b[29]).toBe(a[29] + 1);
  });

  test("output-token totals read the same edges as the sparkline", () => {
    const t = F.newTail("m");
    const win = F.timeWindow(NOW, WINDOW, 30);
    t.tokens.set("before", [win.start - 1, 1000]);
    t.tokens.set("first", [win.start, 200]);
    t.tokens.set("last", [NOW - 1, 30]);
    expect(F.tokensIn([t], win)).toBe(230);
    expect(F.tokensIn([t], F.timeWindow(NOW + 1000, WINDOW, 30))).toBe(230);
  });

  test("bar lengths are named as the header prints them", () => {
    const label = (min: number, n: number) => F.barLabel(F.timeWindow(NOW, min * MIN, n));
    expect([5, 15, 30, 60, 180].map((m) => label(m, 30))).toEqual(["10s", "30s", "1m", "2m", "6m"]);
    expect([5, 15, 30, 60, 180].map((m) => label(m, 20))).toEqual(["15s", "45s", "90s", "3m", "9m"]);
  });

  test("a whole frame at now and at now + 1s differs only in its clock, in every mode", () => {
    // Pick a second in which no strip on the screen closes a bar (today's layout uses 25, 58 and 110 bars at 150 columns).
    let now = NOW;
    const sameBars = (t: number) => [25, 58, 110].every((n) => F.timeWindow(t, WINDOW, n).first === F.timeWindow(t + 1000, WINDOW, n).first);
    while (!sameBars(now)) now += 1000;

    const half = 30_000; // every age on screen sits half a minute from its next tick
    const main1 = tailOf([prompt(now - 29 * MIN - half, "move coupons to the new table"), ...callTimes(46, now - 6 * MIN - half).map((t) => toolCall(t)), reply(now - 6 * MIN - half, "The migration is written.")]);
    const main2 = tailOf([prompt(now - 29 * MIN - half, "why are the tests flaky?"), ...callTimes(60, now - 20_000, 30, 11).map((t) => toolCall(t)), reply(now - 2 * MIN - half, "Two of the three share a cause.")]);
    const sub = tailOf(callTimes(30, now - 20_000, 30, 3).map((t) => toolCall(t)));
    const sessions = [
      sessionOf({ sid: "aaaaaaaa-1", name: "checkout flow redesign", status: "idle", mains: [main1], job: { state: "blocked", detail: "migration drafted", needs: "Approve dropping the column?" } }),
      sessionOf({ sid: "bbbbbbbb-2", name: "flaky test hunt", mains: [main2], agents: [agentOf("s1", sub)] }),
    ];
    const frameAt = (t: number) => F.render(sessions, 150, 44, t).map(strip).join("\n").replace(/\d\d:\d\d:\d\d/, "HH:MM:SS");
    const before = { ...F.opt };
    try {
      for (const mode of ["detail", "compact", "far"] as F.Mode[]) {
        F.opt.mode = mode;
        const a = frameAt(now);
        expect(a).toContain(mode === "far" ? "F L A K Y" : "flaky test hunt");
        expect(frameAt(now + 1000)).toBe(a);
        // Sanity: the test can see movement. Half an hour later every bar has emptied.
        expect(frameAt(now + 31 * MIN)).not.toBe(a);
      }
    } finally {
      Object.assign(F.opt, before);
    }
  });
});
