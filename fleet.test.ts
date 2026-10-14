// Tests for the parts of fleet.ts that are plain logic. Run with: bun test
// Nothing here reads a real login, a real transcript or the network.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as F from "./fleet.ts";

const here = import.meta.dir;
// Everything the usage code reads or writes while under test lives in a throwaway directory.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fleet-test-"));
process.env.XDG_CACHE_HOME = path.join(SCRATCH, "cache");
process.env.FLEET_HOME = path.join(SCRATCH, "home");
// Nothing here may read a real login: a usage switch from the shell that runs the tests is taken out first.
delete process.env.FLEET_USAGE;
delete process.env.FLEET_USAGE_FIXTURE;
delete process.env.FLEET_USAGE_FAIL;
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));
/** A fixed clock for every test: Tue 13 Oct 2026, 23:51:22. (bun test runs in UTC, so local-time formatting is the same on every machine.) */
const NOW = Date.UTC(2026, 9, 13, 23, 51, 22);
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
  }, 30_000);

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

  test("the lane's window has one bar per lane cell, and a session's threads are all counted", () => {
    expect(F.laneWindow(NOW, 150)).toEqual(F.timeWindow(NOW, F.opt.windowMin * MIN, 30));
    expect(F.laneWindow(NOW, 110).n).toBe(20);
    const wf: F.Workflow = { id: "wf_1", name: "w", status: "running", phase: "", phases: [], seen: [], started: NOW, finished: 0, agents: [agentOf("w1", tailOf([toolCall(NOW - 3 * MIN)]))], lastT: NOW };
    const s = sessionOf({ sid: "x", mains: [tailOf([toolCall(NOW - MIN)])], agents: [agentOf("s1", tailOf([toolCall(NOW - 2 * MIN), toolCall(NOW - 2 * MIN + 5)]))], workflows: [wf] });
    expect(F.tailsOf(s).length).toBe(3);
    expect(F.sum(F.bucketsIn(F.tailsOf(s).map((t) => t.tools), F.laneWindow(NOW, 150)))).toBe(4);
  });

  test("bar lengths are named as the header prints them", () => {
    const label = (min: number, n: number) => F.barLabel(F.timeWindow(NOW, min * MIN, n));
    expect([5, 15, 30, 60, 180].map((m) => label(m, 30))).toEqual(["10s", "30s", "1m", "2m", "6m"]);
    expect([5, 15, 30, 60, 180].map((m) => label(m, 20))).toEqual(["15s", "45s", "90s", "3m", "9m"]);
  });

  test("a whole frame at now and at now + 1s differs only in its clock, in every mode", () => {
    // Pick a second in which no strip on the screen closes a bar (at 150 columns: 30 in the lane, 25 in compact rows and 58 in its header, 110 in far cards).
    let now = NOW;
    const sameBars = (t: number) => [25, 30, 58, 110].every((n) => F.timeWindow(t, WINDOW, n).first === F.timeWindow(t + 1000, WINDOW, n).first);
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
        expect(a).toContain(mode === "compact" ? "flaky test hunt" : "F L A K Y");
        expect(frameAt(now + 1000)).toBe(a);
        // Sanity: the test can see movement. Half an hour later every bar has emptied.
        expect(frameAt(now + 31 * MIN)).not.toBe(a);
      }
    } finally {
      Object.assign(F.opt, before);
    }
  });
});

describe("layout grid", () => {
  test("150 columns: the columns the design names", () => {
    const g = F.grid(150);
    expect(g).toMatchObject({ wide: true, narrow: false, small: false, rail: 2, icon: 5, childIcon: 7, text: 7, textEnd: 104, measure: 92, ageEnd: 104 });
    expect(g).toMatchObject({ lane: 107, laneW: 30, laneEnd: 136, fig: 138, figW: 12, figEnd: 149 });
    expect(g).toMatchObject({ label: 7, labelEnd: 48, action: 51, actionEnd: 87, type: 90, typeEnd: 104 });
    expect(g).toMatchObject({ machine: 2, machineEnd: 57, account: 61, accountEnd: 104, gaugeW: 12, histW: 20 });
    expect(g.text + g.measure - 1).toBe(98); // text 7-98
  });

  test("110 columns: the narrow layout", () => {
    const g = F.grid(110);
    expect(g).toMatchObject({ wide: false, narrow: true, small: false, lane: 80, laneW: 20, laneEnd: 99, fig: 101, figW: 9, figEnd: 109 });
    expect(g).toMatchObject({ measure: 96, ageEnd: 109, label: 7, labelEnd: 42, action: 45, actionEnd: 77, type: 0, typeEnd: 0 });
    expect(g).toMatchObject({ machine: 2, machineEnd: 38, account: 42, accountEnd: 77, gaugeW: 8, histW: 12 });
    expect(g.text + g.measure - 1).toBe(102); // text 7-102
  });

  test("breakpoints, and the lane and measure limits above 150", () => {
    expect(F.grid(129).wide).toBe(false);
    expect(F.grid(130).wide).toBe(true);
    expect(F.grid(99).small).toBe(true);
    expect(F.grid(100).small).toBe(false);
    expect(F.grid(130)).toMatchObject({ laneW: 30, lane: 87, textEnd: 84, measure: 72, labelEnd: 37, action: 40, actionEnd: 67 });
    expect(F.grid(200)).toMatchObject({ laneW: 30, measure: 96, labelEnd: 48, action: 51, actionEnd: 137, figEnd: 199 });
    // The header's wide blocks end at column 104, so they need 150 columns; from 130 to 149 the lane sits where they would end.
    for (const W of [130, 140, 149]) expect(F.grid(W)).toMatchObject({ account: 42, machineEnd: 38, gaugeW: 8, histW: 12, accountEnd: W - 46 });
    expect(F.grid(200)).toMatchObject({ account: 61, machineEnd: 57, gaugeW: 12, histW: 20, accountEnd: 154 });
  });

  test("at every width the columns are in order and stay on the screen", () => {
    for (let W = 60; W <= 260; W++) {
      const g = F.grid(W);
      expect(g.figEnd).toBe(W - 1);
      expect(g.fig + g.figW - 1).toBe(g.figEnd);
      expect(g.lane + g.laneW - 1).toBe(g.laneEnd);
      expect(g.fig).toBe(g.laneEnd + 2);
      expect(g.textEnd).toBe(g.lane - 3);
      expect(g.label).toBeLessThan(g.labelEnd);
      expect(g.action).toBe(g.labelEnd + 3);
      expect(g.action).toBeLessThanOrEqual(g.actionEnd);
      expect(g.actionEnd).toBeLessThanOrEqual(g.textEnd);
      expect(g.measure).toBeLessThanOrEqual(96);
      expect(g.text + g.measure - 1).toBeLessThanOrEqual(g.wide ? g.textEnd : g.figEnd);
      if (g.wide) expect(g.type).toBe(g.actionEnd + 3);
    }
  });

  test("Row puts text at absolute columns and reports the cells it used", () => {
    const r = new F.Row(40);
    expect(r.put(5, "hello", F.C.white, true)).toBe(10);
    expect(r.putr(39, "6m", F.C.dim)).toBe(37);
    r.paste(20, F.spark([0, 1, 4, 9], 9, ...F.RAMP.session));
    r.segsr(34, [["up ", F.C.dim], ["14m", F.C.green]]);
    expect(r.plain()).toBe("    hello          ▁▃▆█     up 14m   6m ");
    expect(r.plain().indexOf("hello")).toBe(4); // column 5
    expect(r.plain().indexOf("6m") + 2).toBe(39); // ends at column 39
    expect(F.cells(r.toString())).toBe(39); // nothing is drawn past the last glyph
    r.put(38, "overflowing"); // past the right edge: dropped, never wrapped
    expect(r.plain().length).toBe(40);
    expect(F.cells(new F.Row(30, F.C.tint).toString())).toBe(30); // a tinted row is painted across its full width
  });
});

describe("vocabulary", () => {
  test("no glyph has an emoji form or is wider than one cell", () => {
    const all = [...Object.values(F.GLYPHS).flatMap((v) => [v.g, (v as { plain?: string }).plain ?? ""]), F.BARS, F.SPIN, ...Object.values(F.STATE).map((x) => x.glyph)].join("");
    for (const ch of all) {
      const cp = ch.codePointAt(0)!;
      expect(`${ch} emoji form: ${F.hasEmojiForm(cp)}`).toBe(`${ch} emoji form: false`);
      expect(`${ch} cells: ${Bun.stringWidth(ch)}`).toBe(`${ch} cells: 1`);
      expect(F.charWidth(cp)).toBe(1);
    }
    for (const retired of "⚠⚙▪") expect(F.hasEmojiForm(retired.codePointAt(0)!)).toBe(true);
  });

  test("every icon in the design is in the table", () => {
    const want = "▲●▸◆◇⠋◐○✓✗≡█▌━─╌┼┿░■•–│…@·┴▼";
    const have = Object.values(F.GLYPHS).map((v) => v.g).join("");
    for (const ch of want) expect(have).toContain(ch);
    expect(F.BARS).toBe("▁▂▃▄▅▆▇█");
    expect(F.SPIN).toBe("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏");
  });

  test("--plain-glyphs swaps in the four fallbacks and nothing else", () => {
    const normal = { ...F.ICON };
    try {
      F.setPlainGlyphs(true);
      expect([F.ICON.workflow, F.ICON.paceFilled, F.ICON.gaugeNone, F.ICON.earlier]).toEqual(["◇", "┼", "─", "◆"]);
      const changed = (Object.keys(normal) as F.IconName[]).filter((k) => F.ICON[k] !== normal[k]);
      expect(changed.sort()).toEqual(["earlier", "gaugeNone", "paceFilled", "workflow"]);
      expect(F.glyphCard()).toContain("standing in for ≡");
    } finally {
      F.setPlainGlyphs(false);
    }
    expect(F.ICON).toEqual(normal);
  });

  test("the glyph card shows every glyph between bars, one line each", () => {
    const card = F.glyphCard();
    for (const v of Object.values(F.GLYPHS)) expect(card).toContain(`|${v.g}|`);
    for (const ch of F.BARS + F.SPIN) expect(card).toContain(`|${ch}|`);
    const rows = card.split("\n").filter((l) => l.startsWith(" |"));
    // Every row's second closing bar is in the same column, which is the whole point of the card.
    expect(new Set(rows.map((l) => F.width(l.slice(0, l.indexOf("|  ", 8) + 1)))).size).toBe(1);
  });

  test("state colours and the gauge rule", () => {
    expect(F.STATE_ORDER).toEqual(["needs", "stalled", "working", "yourTurn", "idle", "finished"]);
    expect(F.STATE.needs).toEqual({ glyph: "▲", word: "NEEDS YOU", color: [229, 181, 68] });
    expect(F.STATE.stalled).toEqual({ glyph: "◐", word: "STALLED?", color: [240, 98, 92] });
    expect(F.STATE.working).toEqual({ glyph: "●", word: "WORKING", color: [80, 200, 120] });
    expect(F.STATE.yourTurn).toEqual({ glyph: "▸", word: "YOUR TURN", color: [97, 170, 255] });
    expect(F.STATE.idle.glyph).toBe("○");
    expect(F.STATE.finished).toEqual({ glyph: "✓", word: "FINISHED", color: [62, 128, 92] });
    expect([0, 59, 60, 79, 80, 100].map(F.limitTone)).toEqual([F.C.calm, F.C.calm, F.C.white, F.C.white, F.C.red, F.C.red]);
    expect(F.figureTone(59)).toEqual({ color: F.C.text, bold: false });
    expect(F.figureTone(60)).toEqual({ color: F.C.white, bold: true });
    expect(F.figureTone(80)).toEqual({ color: F.C.red, bold: true });
    expect(F.railTone("working", true)).toEqual(F.C.green);
    expect(F.railTone("working", false)).toEqual(F.mix(F.C.green, F.C.faint, 0.45));
    expect([F.railTone("needs", true, 0), F.railTone("needs", true, 1)]).toEqual([F.C.amber, F.mix(F.C.amber, F.C.faint, 0.6)]); // a waiting session's rail alternates
    expect(F.railTone("stalled", true, 1)).toEqual(F.C.red); // nothing else moves
    expect(F.coolTone(0)).toEqual([40, 100, 110]);
    expect(F.coolTone(1)).toEqual([150, 225, 235]);
  });
});

describe("safe text", () => {
  test("ticks and crosses become ✓ and ✗, other emoji go, tabs become two spaces", () => {
    expect(F.safeText("done ✅ ☑ ✔ / failed ❌ ✖")).toBe("done ✓ ✓ ✓ / failed ✗ ✗");
    expect(F.safeText("ship it 🚀 now ❤️ ok")).toBe("ship it  now  ok");
    expect(F.safeText("a\tb")).toBe("a  b");
    expect(F.safeText("keycap 1️⃣ flag 🇬🇧 family 👨‍👩‍👧 end")).toBe("keycap 1 flag  family  end");
    expect(F.safeText("⚠️ careful ➡️ here")).toBe("! careful → here");
  });

  test("control characters and terminal escape sequences cannot reach the screen", () => {
    expect(F.safeText("\x1b[31mred\x1b[0m \x1b]2;title\x07text\x07\x00\x7f")).toBe("red text");
    expect(F.safeText("one\r\ntwo\rthree four")).toBe("one\ntwo\nthree\nfour");
    expect(F.safeText("zero​width‍ ﻿bom so­ft")).toBe("zerowidth bom soft");
  });

  test("double-width characters never survive, so every character is one cell", () => {
    expect(F.safeText("ＡＢＣ　１２３")).toBe("ABC 123");
    expect(F.safeText("日本語 ok")).toBe("??? ok");
    expect(F.safeText("café é naïve")).toBe("café é naïve"); // accents are composed, not dropped
    for (const sample of ["✅ done 🚀\tＡ日本語 é \x1b[1mbold\x1b[0m ⚠️ → • … │ ▲ ≡", "plain ascii", "👨‍👩‍👧‍👦🇬🇧1️⃣"]) {
      const safe = F.safeText(sample);
      expect(Bun.stringWidth(safe)).toBe([...safe].length);
      expect(F.width(safe)).toBe([...safe].length);
      expect(F.safeText(safe)).toBe(safe); // and it is stable
    }
  });

  test("the dashboard's own glyphs and ordinary punctuation pass through untouched", () => {
    const own = "▲●▸◆◇◐○✓✗≡█▌━─╌┼┿░■•–│…@·┴▼▁▂▃▄▅▆▇⠋ → ← “quotes” £12 — naïve";
    expect(F.safeText(own)).toBe(own);
  });

  test("text is made safe as it is read from a transcript", () => {
    const t = tailOf([prompt(NOW - 9 * MIN, "please fix ✅ this 🙏"), toolCall(NOW - 5 * MIN, "Bash", { description: "Run 🚀\tthe tests" }), reply(NOW - 2 * MIN, "All good ✅\n- one ❌ left 🎉")]);
    expect(t.ask?.text).toBe("please fix ✓ this ");
    expect(t.lastTool?.hint).toBe("Run the tests");
    expect(t.say?.text).toBe("All good ✓\n- one ✗ left ");
    expect(F.safeLine("  a \n\t b 🚀 ")).toBe("a b");
  });
});

describe("session state and subheading", () => {
  const main = (rows: object[]) => tailOf(rows);
  const asked = [prompt(NOW - 29 * MIN, "find out why the tests are flaky")];
  const said = reply(NOW - 2 * MIN, "## Result\n\nTwo of the three **share** a cause.\nMore detail follows.");

  test("one state per session, by the rules", () => {
    const state = (o: Partial<F.Session>, stalled = false) => F.sessionState(F.factsOf(sessionOf({ sid: "x", ...o })), stalled);
    expect(state({ status: "idle", job: { state: "blocked", detail: "", needs: "Approve?" } })).toBe("needs");
    expect(state({ status: "busy", mains: [main([toolCall(NOW - MIN, "AskUserQuestion", { questions: [{ question: "Which one?" }] })])] })).toBe("needs");
    expect(state({ status: "busy" })).toBe("working");
    expect(state({ status: "idle", job: { state: "working", detail: "", needs: "" } })).toBe("working");
    expect(state({ status: "busy" }, true)).toBe("stalled");
    expect(state({ status: "idle", job: { state: "blocked", detail: "", needs: "Approve?" } }, true)).toBe("needs"); // needing you outranks a stall
    expect(state({ status: "idle", mains: [main([...asked, said])] })).toBe("yourTurn");
    expect(state({ status: "idle", mains: [main([said, prompt(NOW - MIN, "and now this")])] })).toBe("idle");
    expect(state({ status: "idle" })).toBe("idle");
    expect(state({ status: "idle", job: { state: "done", detail: "merged", needs: "" } })).toBe("finished");
    expect(state({ status: "idle", mains: [main([...asked, said])] }, true)).toBe("yourTurn"); // only a working session can be stalled
  });

  test("sort order: needs you, stalled, working, then the quiet ones; newest first within a state", () => {
    const row = (name: string, state: F.SessionState, upMin: number) => ({ state, s: sessionOf({ sid: name, startedAt: NOW - upMin * MIN }) });
    const rows = [row("idle", "idle", 1), row("old-work", "working", 90), row("turn", "yourTurn", 2), row("stalled", "stalled", 5), row("new-work", "working", 10), row("done", "finished", 3), row("needs", "needs", 200)];
    expect(rows.sort(F.byState).map((r) => r.s.sid)).toEqual(["needs", "stalled", "new-work", "old-work", "turn", "idle", "done"]);
  });

  test("the state's time: up while working, otherwise how long it has been so", () => {
    const s = sessionOf({ sid: "x", startedAt: NOW - 64 * MIN, mains: [main([...asked, said])] });
    const f = F.factsOf(s);
    expect(F.stateTime(s, f, "working", NOW)).toBe("up 1h04");
    expect(F.stateTime(s, f, "yourTurn", NOW)).toBe("2m");
    expect(F.stateTime(s, f, "needs", NOW)).toBe("2m");
    expect(F.stateTime(s, f, "stalled", NOW, NOW - 14 * MIN)).toBe("14m");
    const asking = sessionOf({ sid: "y", mains: [main([toolCall(NOW - 6 * MIN, "AskUserQuestion", { questions: [{ question: "Which one?" }] })])] });
    expect(F.stateTime(asking, F.factsOf(asking), "needs", NOW)).toBe("6m");
  });

  test("subheading chain while working: now-line, task, prompt, reply", () => {
    const sub = (o: Partial<F.Session>) => {
      const s = sessionOf({ sid: "x", ...o });
      return F.subheading(s, F.factsOf(s), "working");
    };
    const tasks = { done: 2, doing: 1, total: 6, active: "Fixing the clock-dependent tests" };
    expect(sub({ job: { state: "working", detail: "bisecting the tests", needs: "" }, tasks, mains: [main([...asked, said])] })).toEqual({ source: "now", text: "bisecting the tests" });
    expect(sub({ tasks, mains: [main([...asked, said])] })).toEqual({ source: "task", text: "Fixing the clock-dependent tests" });
    expect(sub({ mains: [main([...asked, said])] })).toEqual({ source: "prompt", text: "find out why the tests are flaky", t: NOW - 29 * MIN });
    expect(sub({ mains: [main([said])] })).toEqual({ source: "reply", text: "Result", t: NOW - 2 * MIN });
    expect(sub({})).toEqual({ source: "none", text: "" });
    // Only the transcript's last-prompt marker is known: the prompt has no age.
    const marker = F.newTail("m");
    F.ingest(marker, JSON.stringify({ type: "last-prompt", lastPrompt: "tidy the build" }));
    expect(sub({ mains: [marker] })).toEqual({ source: "prompt", text: "tidy the build", t: undefined });
  });

  test("the away summary is the now-line only when it is newer than the last prompt", () => {
    const summary = (t: number) => ({ type: "system", subtype: "away_summary", timestamp: iso(t), content: "Refactored the cart ✅ and ran the suite" });
    const newer = sessionOf({ sid: "x", mains: [main([...asked, summary(NOW - 5 * MIN)])] });
    expect(newer.mains[0].summaryT).toBe(NOW - 5 * MIN);
    expect(F.subheading(newer, F.factsOf(newer), "working")).toEqual({ source: "now", text: "Refactored the cart ✓ and ran the suite" });
    const older = sessionOf({ sid: "y", mains: [main([summary(NOW - 40 * MIN), ...asked])] });
    expect(F.factsOf(older).now).toBe("");
    expect(F.subheading(older, F.factsOf(older), "working").source).toBe("prompt");
  });

  test("subheading for the other states: the question; or the reply, else the now-line", () => {
    const waiting = sessionOf({ sid: "x", status: "idle", job: { state: "blocked", detail: "migration drafted", needs: "Approve dropping the column?" }, mains: [main([...asked, said])] });
    expect(F.subheading(waiting, F.factsOf(waiting), "needs")).toEqual({ source: "question", text: "Approve dropping the column?" });
    const turn = sessionOf({ sid: "y", status: "idle", job: { state: "done", detail: "merged", needs: "" }, mains: [main([...asked, said])] });
    expect(F.subheading(turn, F.factsOf(turn), "finished")).toEqual({ source: "reply", text: "Result", t: NOW - 2 * MIN });
    const silent = sessionOf({ sid: "z", status: "idle", job: { state: "done", detail: "merged", needs: "" } });
    expect(F.subheading(silent, F.factsOf(silent), "finished")).toEqual({ source: "now", text: "merged" });
    expect(F.firstLine("```ts\ncode\n```\n\n- **first** `point`\n- second")).toBe("code");
    expect(F.firstLine("\n\n- **first** `point`\n- second")).toBe("first point");
  });

  test("an idle session with no reply and no now-line falls back to its last prompt, in far mode as in detail", () => {
    const quiet = sessionOf({ sid: "scratch", status: "idle", mains: [main([prompt(NOW - 29 * MIN, "what does the totals helper round to?")])] });
    expect(F.subheading(quiet, F.factsOf(quiet), "idle")).toEqual({ source: "prompt", text: "what does the totals helper round to?", t: NOW - 29 * MIN });
    const saved = { ...F.opt };
    try {
      Object.assign(F.opt, { mode: "far", showAll: true, usage: false });
      const frame = F.render([quiet], 150, 30, NOW).map(strip);
      expect(frame.some((l) => l.includes("▸ what does the totals helper round to?"))).toBe(true);
    } finally {
      Object.assign(F.opt, saved);
    }
  });
});

describe("head rows keep what was written", () => {
  // The question, the now-line, your prompt and the reply's first line: marks in pairs (code, bold, links) may go, but no character is deleted on its own.
  const QUESTION = "Is a retry count > 3 OK for issue #412, i.e. timeout = 2 * base and map a -> b with x >= 5? Use C# or `ls *.ts`?";
  test("the question and the now-line lose only paired marks", () => {
    const s = sessionOf({ sid: "x", status: "idle", job: { state: "blocked", detail: "waiting: coverage >= 80% on PR #1184", needs: QUESTION } });
    const f = F.factsOf(s);
    expect(f.needs).toBe("Is a retry count > 3 OK for issue #412, i.e. timeout = 2 * base and map a -> b with x >= 5? Use C# or ls *.ts?");
    expect(f.now).toBe("waiting: coverage >= 80% on PR #1184");
    const names = sessionOf({ sid: "y", status: "idle", job: { state: "blocked", detail: "", needs: "Delete __init__.py and _private_cache_?\n- **yes**: now\n- no" } });
    expect(F.factsOf(names).needs).toBe("Delete __init__.py and _private_cache_? • yes: now • no");
    // On the screen, in every mode.
    const saved = { ...F.opt };
    try {
      for (const mode of ["detail", "compact", "far"] as F.Mode[]) {
        Object.assign(F.opt, { mode, usage: false });
        const frame = F.render([s], 150, 30, NOW).map(strip).join("\n");
        expect([mode, frame.includes("retry count > 3 OK for issue #412")]).toEqual([mode, true]);
      }
    } finally {
      Object.assign(F.opt, saved);
    }
  });

  test("your prompt is shown as you typed it", () => {
    const typed = "fix issue #412: retries > 3 hang, see src/**/*.test.ts and `__init__`";
    const s = sessionOf({ sid: "x", mains: [tailOf([prompt(NOW - 29 * MIN, typed)])] });
    expect(F.subheading(s, F.factsOf(s), "working")).toEqual({ source: "prompt", text: typed, t: NOW - 29 * MIN });
  });

  test("a reply's first line: links as their text, a table as its cells, literal marks kept", () => {
    expect(F.firstLine("See [the plan](https://example.com/plan), then PR #1184 -> main")).toBe("See the plan, then PR #1184 -> main");
    expect(F.firstLine("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("a · b");
    expect(F.firstLine("Use `x >= 5` and **not** x > 5")).toBe("Use x >= 5 and not x > 5");
  });

  test("a prompt of one long unbroken token costs a frame no more than an ordinary one", () => {
    const blob = "eyJ" + "QUJDRA".repeat(46_000); // 276k characters of base64, no spaces
    const t = tailOf([prompt(NOW - 5 * MIN, blob), toolCall(NOW - MIN)]);
    expect(t.ask!.text.length).toBeLessThan(5000); // only what can be drawn is kept
    const s = sessionOf({ sid: "blob", job: { state: "working", detail: "copying", needs: "" }, mains: [t] });
    const saved = { ...F.opt };
    try {
      Object.assign(F.opt, { mode: "detail", usage: false });
      const start = performance.now();
      for (let i = 0; i < 5; i++) F.render([s], 150, 44, NOW);
      expect(performance.now() - start).toBeLessThan(500);
    } finally {
      Object.assign(F.opt, saved);
    }
    const word = "x".repeat(290_000);
    const start = performance.now();
    expect(F.wrap(word, 92).length).toBe(Math.ceil(290_000 / 92));
    expect(performance.now() - start).toBeLessThan(300); // it was quadratic: 1.6 s
  });
});

describe("workflow phase trail", () => {
  const journal = [
    { type: "launched" },
    { type: "started", agentId: "w1", label: "reproduce:a", phase: "Reproduce" },
    { type: "started", agentId: "w2", label: "reproduce:b", phase: "Reproduce" },
    { type: "result", agentId: "w1" },
    { type: "result", agentId: "w2" },
    { type: "started", agentId: "w3", label: "fix:a", phase: "Fix" },
    { type: "started", agentId: "w4", label: "review:a", phase: "Fix" },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n");
  const j = F.readJournal(journal);
  const agents = (running: string[]) => [...j.started.values()].map((st) => agentOf(st.agentId, F.newTail(st.agentId), { wf: "wf_1", phase: st.phase, done: !running.includes(st.agentId) }));
  const wfOf = (o: Partial<F.Workflow>): F.Workflow => ({ id: "wf_1", name: "bisect-and-fix", status: "running", phase: "", phases: [], seen: j.phases, started: NOW - 14 * MIN, finished: 0, agents: [], lastT: NOW, ...o });

  test("phases are listed in the order the journal's started entries name them", () => {
    expect(j.phases).toEqual(["Reproduce", "Fix"]);
    expect([...j.results]).toEqual(["w1", "w2"]);
    expect(F.readJournal('not json\n{"type":"started","agentId":"a","phase":"Only"}\n').phases).toEqual(["Only"]);
  });

  test("the current phase is the latest one with an agent still running", () => {
    expect(F.currentPhase(j.phases, agents(["w3", "w4"]).filter((a) => !a.done))).toBe("Fix");
    expect(F.currentPhase(j.phases, agents(["w2"]).filter((a) => !a.done))).toBe("Reproduce");
    expect(F.currentPhase(j.phases, [])).toBe("Fix"); // nobody running: the latest phase started
    expect(F.currentPhase([], [])).toBe("");
  });

  test("a running workflow shows what has happened, never a guess", () => {
    const wf = wfOf({ phase: "Fix", agents: agents(["w3", "w4"]) });
    expect(F.phaseTrail(wf)).toEqual([{ name: "Reproduce", state: "done" }, { name: "Fix", state: "now" }]);
    expect(F.wfOutcome(wf)).toBe("running");
    // Two phases with agents still running are both current.
    expect(F.phaseTrail(wfOf({ phase: "Fix", agents: agents(["w2", "w3"]) })).map((p) => p.state)).toEqual(["now", "now"]);
  });

  test("later phases appear only when the declared list is known", () => {
    const declared = ["Reproduce", "Fix", "Verify", "Open the pull request"];
    const wf = wfOf({ phase: "Fix", phases: declared, agents: agents(["w3"]) });
    expect(F.phaseTrail(wf).map((p) => p.state)).toEqual(["done", "now", "next", "next"]);
    const ended = wfOf({ status: "completed", phase: "Fix", phases: declared, seen: declared, agents: agents([]), finished: NOW - MIN, tokens: 412_000 });
    expect(F.phaseTrail(ended).every((p) => p.state === "done")).toBe(true);
    expect(F.wfOutcome(ended)).toBe("completed");
    expect(F.wfOutcome(wfOf({ status: "failed" }))).toBe("failed");
    expect(F.wfOutcome(wfOf({ status: "stopped" }))).toBe("failed");
  });

  test("a workflow that goes back to an earlier phase lists it again, so the current phase is always the last", () => {
    const rows = [
      ["started", "w1", "Reproduce"], ["result", "w1"], ["started", "w2", "Fix"], ["result", "w2"],
      ["started", "w3", "Verify"], ["result", "w3"], ["started", "w4", "Fix"], // Verify sent the work back
    ].map(([type, agentId, phase]) => JSON.stringify({ type, agentId, phase }));
    const looped = F.readJournal(rows.join("\n"));
    expect(looped.phases).toEqual(["Reproduce", "Fix", "Verify", "Fix"]);
    const agentsHere = [...looped.started.values()].map((st) => agentOf(st.agentId, F.newTail(st.agentId), { wf: "wf_1", phase: st.phase, done: st.agentId !== "w4" }));
    expect(F.currentPhase(looped.phases, agentsHere.filter((a) => !a.done))).toBe("Fix");
    const wf = wfOf({ phase: "Fix", seen: looped.phases, agents: agentsHere });
    expect(F.phaseTrail(wf)).toEqual([{ name: "Reproduce", state: "done" }, { name: "Fix", state: "done" }, { name: "Verify", state: "done" }, { name: "Fix", state: "now" }]);
    // With the declared list known, the history still comes first and the phases not yet reached follow it.
    expect(F.phaseTrail({ ...wf, phases: ["Reproduce", "Fix", "Verify", "Ship"] }).map((p) => `${p.state} ${p.name}`)).toEqual(["done Reproduce", "done Fix", "done Verify", "now Fix", "next Ship"]);
    // Agents of one phase started while another phase's agents still run are the same visit, not a new one.
    const parallel = F.readJournal([["started", "a1", "A"], ["started", "b1", "B"], ["started", "a2", "A"]].map(([type, agentId, phase]) => JSON.stringify({ type, agentId, phase })).join("\n"));
    expect(parallel.phases).toEqual(["A", "B"]);
  });

  test("a trail too long for its row says that passed phases were left out", () => {
    const names = ["Plan", "Research", "Reproduce", "Isolate", "Fix", "Verify", "Review"];
    const rows = names.flatMap((phase, i) => [JSON.stringify({ type: "started", agentId: `p${i}`, phase }), ...(i < names.length - 1 ? [JSON.stringify({ type: "result", agentId: `p${i}` })] : [])]);
    const jr = F.readJournal(rows.join("\n"));
    const agentsHere = [...jr.started.values()].map((st) => agentOf(st.agentId, tailOf([toolCall(NOW - MIN)], st.agentId), { wf: "wf_long", phase: st.phase, done: st.agentId !== "p6" }));
    const wf: F.Workflow = { id: "wf_long", name: "long-pipeline", status: "running", phase: "Review", phases: [], seen: jr.phases, started: NOW - 30 * MIN, finished: 0, agents: agentsHere, lastT: NOW };
    const row = (W: number) => strip(F.detailView(F.buildViews([sessionOf({ sid: "long", workflows: [wf] })], NOW), W, 44, NOW).find((l) => l.includes("long-pipeline"))!);
    expect(row(150)).toMatch(/long-pipeline +… ✓ \S+ .*◐ Review/);
    expect(row(250)).toContain("✓ Plan  ✓ Research");
    expect(row(250)).not.toContain("…");
  });
});

describe("the dashboard survives what it reads", () => {
  const root = path.join(SCRATCH, "survive");
  /** A home with one genuine waiting session, plus whatever `plant` adds; drawn once by fleet.ts in a child process under a time limit. */
  const once = (name: string, plant: (home: string) => void, mode = "detail") => {
    const home = path.join(root, name);
    fs.rmSync(home, { recursive: true, force: true });
    const sid = "good0000-0000-4000-8000-000000000001";
    fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(home, "projects", "-p"), { recursive: true });
    fs.writeFileSync(path.join(home, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: sid, name: "good", kind: "bg", status: "idle", cwd: "/work", jobId: "j1", startedAt: NOW - 60 * MIN }));
    fs.mkdirSync(path.join(home, "jobs", "j1"), { recursive: true });
    fs.writeFileSync(path.join(home, "jobs", "j1", "state.json"), JSON.stringify({ state: "blocked", detail: "", needs: "Approve the plan?" }));
    fs.writeFileSync(path.join(home, "projects", "-p", `${sid}.jsonl`), [prompt(NOW - 9 * MIN, "plan it"), reply(NOW - 6 * MIN, "Here is the plan.")].map((r) => JSON.stringify(r)).join("\n") + "\n");
    plant(home);
    const r = Bun.spawnSync([process.execPath, path.join(here, "fleet.ts"), "--once", "--mode", mode], { env: { PATH: process.env.PATH!, HOME: path.join(root, "nobody"), TZ: "UTC", FLEET_NOW: String(NOW), COLUMNS: "150", LINES: "44", FLEET_HOME: home, XDG_CACHE_HOME: path.join(root, "cache"), FLEET_HIDE_PROCESSES: "1" }, timeout: 15_000 });
    return { code: r.exitCode, signal: r.signalCode ?? null, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const reg = (home: string, n: number, o: object) => fs.writeFileSync(path.join(home, "sessions", `${n}.json`), JSON.stringify({ pid: process.pid, status: "busy", cwd: "/x", ...o }));

  test("a session id that is not a plain id is skipped: no escape reaches the terminal, no path leaves the projects folder, nothing throws", () => {
    for (const [name, sessionId] of [["osc", "\u001b]2;OWN\u0007"], ["clear", "\u001b[2J\u001b[H"], ["number", 7], ["object", { a: 1 }], ["up", "../../outside/secret"], ["dotdot", ".."]] as [string, unknown][]) {
      const r = once(`sid-${name}`, (home) => {
        reg(home, 2, { sessionId, name: "planted" });
        fs.mkdirSync(path.join(home, "outside"), { recursive: true });
        fs.writeFileSync(path.join(home, "outside", "secret.jsonl"), JSON.stringify(reply(NOW - MIN, "TEXT-FROM-OUTSIDE")) + "\n");
      });
      expect([name, r.code, r.err]).toEqual([name, 0, ""]);
      expect([name, r.out.includes("\u001b]2;"), r.out.includes("\u001b[2J"), r.out.includes("TEXT-FROM-OUTSIDE"), r.out.includes("PLANTED")]).toEqual([name, false, false, false, false]);
      expect([name, strip(r.out).includes("Approve the plan?")]).toEqual([name, true]);
    }
  }, 60_000);

  test("token counts that are not numbers are not drawn; human() never returns text it was not given", () => {
    const t = F.newTail("x");
    F.ingest(t, JSON.stringify({ type: "assistant", timestamp: iso(NOW - MIN), message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "text", text: "hi" }], usage: { input_tokens: "\n\n\n\n\n\n\n\n\n\n5", cache_read_input_tokens: 90_000, output_tokens: 1 } } }));
    expect(t.ctx?.used).toBe(90_000);
    expect(F.human(Number.NaN)).toBe("?");
    expect(F.human("\n\n5" as unknown as number)).toBe("?");
  });

  test("a named pipe, a directory where a file should be, or a tool schema nested 120,000 deep: drawn, never hung, never thrown", () => {
    const sid2 = "other000-0000-4000-8000-000000000002";
    const cases: [string, (home: string) => void][] = [
      ["fifo-session", (home) => Bun.spawnSync(["mkfifo", path.join(home, "sessions", "pipe.json")])],
      ["fifo-task", (home) => (fs.mkdirSync(path.join(home, "tasks", "good0000-0000-4000-8000-000000000001"), { recursive: true }), Bun.spawnSync(["mkfifo", path.join(home, "tasks", "good0000-0000-4000-8000-000000000001", "pipe.json")]))],
      ["dir-journal", (home) => {
        reg(home, 2, { sessionId: sid2, name: "wf" });
        fs.mkdirSync(path.join(home, "projects", "-p", sid2, "subagents", "workflows", "wf_x", "journal.jsonl"), { recursive: true });
      }],
      ["dir-agent", (home) => {
        reg(home, 2, { sessionId: sid2, name: "ag" });
        fs.mkdirSync(path.join(home, "projects", "-p", sid2, "subagents", "agent-zz.jsonl"), { recursive: true });
      }],
      ["deep-schema", (home) => {
        reg(home, 2, { sessionId: sid2, name: "deep" });
        const deep = '{"type":"attachment","attachment":{"type":"prompt_snapshot","tools":[{"name":"x","schema":' + '{"a":'.repeat(120_000) + "1" + "}".repeat(120_000) + "}]}}";
        fs.writeFileSync(path.join(home, "projects", "-p", `${sid2}.jsonl`), deep + "\n" + JSON.stringify(reply(NOW - MIN, "still here")) + "\n");
      }],
    ];
    for (const [name, plant] of cases) {
      const r = once(name, plant);
      expect([name, r.signal, r.code, r.err.slice(0, 200)]).toEqual([name, null, 0, ""]);
      expect([name, strip(r.out).includes("Approve the plan?")]).toEqual([name, true]);
    }
  }, 120_000);

  test("whatever ends the program, the terminal is put back first", () => {
    const script = `import { guardTerminal } from ${JSON.stringify(path.join(here, "fleet.ts"))};
guardTerminal(() => process.stdout.write("RESTORED\\n"));
setTimeout(() => { throw new Error("boom in a scan"); }, 5);`;
    const r = Bun.spawnSync([process.execPath, "-e", script], { timeout: 15_000 });
    expect(r.stdout.toString()).toBe("RESTORED\n");
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("boom in a scan");
    const rejected = Bun.spawnSync([process.execPath, "-e", script.replace('setTimeout(() => { throw new Error("boom in a scan"); }, 5);', 'void Promise.reject(new Error("rejected"));')], { timeout: 15_000 });
    expect([rejected.stdout.toString(), rejected.exitCode]).toEqual(["RESTORED\n", 1]);
    // Leaving puts the tab title back where the terminal keeps a title stack, and clears it where it does not.
    expect(F.enterScreen(true)).toContain("\x1b[22;0t");
    expect(F.leaveScreen(true)).toMatch(/\x1b\]2;\x07.*\x1b\[23;0t/);
    expect(F.leaveScreen(true)).toContain("\x1b[?1049l");
  }, 30_000);

  test("split surrogates cannot join into an emoji, and characters above U+FFFF are never cut in half", () => {
    expect(F.safeText("a\ud83d​\ude00b\ude00c\ud83d")).toBe("abc");
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|�/;
    const astral = "𝐀𝐁𝐂𝐃𝐄𝐅𝐆𝐇𝐈𝐉𝐊𝐋𝐌𝐍𝐎𝐏𝐐𝐑𝐒𝐓𝐔𝐕𝐖𝐗𝐘𝐙";
    const s = sessionOf({ sid: "astral", name: astral + " name", agents: [agentOf("a", tailOf([toolCall(NOW - 2 * MIN, astral.repeat(3), { description: astral })]), { label: astral })] });
    const saved = { opt: { ...F.opt }, procs: F.machine.procs };
    try {
      F.machine.procs = [{ pid: 9, ppid: 1, cpu: 212, rss: 1, name: F.procName("x" + astral.repeat(3)) }];
      for (const mode of ["detail", "compact", "far"] as F.Mode[]) {
        Object.assign(F.opt, { mode, usage: false });
        for (const W of [80, 110, 150]) {
          const frame = F.render([s], W, 30, NOW).join("\n");
          expect([mode, W, lone.test(frame)]).toEqual([mode, W, false]);
        }
      }
    } finally {
      Object.assign(F.opt, saved.opt);
      F.machine.procs = saved.procs;
    }
  });

  test("a transcript replaced by a different file at the same path is read afresh", () => {
    const home = path.join(root, "replaced");
    fs.rmSync(home, { recursive: true, force: true });
    const sid = "repl0000-0000-4000-8000-000000000001";
    const file = path.join(home, "projects", "-p", `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(home, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: sid, name: "r", kind: "bg", status: "idle", cwd: "/w", startedAt: NOW - 60 * MIN }));
    const rows = (who: string, n: number) => [prompt(NOW - 20 * MIN, `the ${who} prompt`), ...Array.from({ length: n }, (_, i) => toolCall(NOW - 10 * MIN + i)), reply(NOW - 5 * MIN, `The ${who} reply`)].map((r) => JSON.stringify(r)).join("\n") + "\n";
    const saved = process.env.FLEET_HOME;
    process.env.FLEET_HOME = home;
    try {
      fs.writeFileSync(file, rows("first", 3));
      expect(F.scan(NOW).find((x) => x.sid === sid)!.mains[0].says.map((x) => x.text)).toEqual(["The first reply"]);
      fs.writeFileSync(file + ".new", rows("second", 40)); // longer, so a size check alone would read on from the old offset
      fs.renameSync(file + ".new", file);
      const t = F.scan(NOW + 2000).find((x) => x.sid === sid)!.mains[0];
      expect([t.says.map((x) => x.text), t.ask?.text, t.tools.length]).toEqual([["The second reply"], "the second prompt", 40]);
    } finally {
      process.env.FLEET_HOME = saved;
    }
  });

  test("what was read for sessions and agents that have gone is let go, so a dashboard left running does not grow", () => {
    const home = path.join(root, "churn");
    const saved = process.env.FLEET_HOME;
    process.env.FLEET_HOME = home;
    try {
      fs.rmSync(home, { recursive: true, force: true });
      for (let n = 0; n < 5; n++) {
        const sid = `churn00${n}-0000-4000-8000-000000000001`;
        const dir = path.join(home, "projects", "-p", sid);
        fs.mkdirSync(path.join(dir, "subagents", "workflows", "wf_c"), { recursive: true });
        fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
        fs.writeFileSync(path.join(home, "sessions", `${n}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, name: `c${n}`, kind: "bg", status: "busy", cwd: "/w", startedAt: NOW - 60 * MIN }));
        fs.writeFileSync(dir + ".jsonl", JSON.stringify(reply(NOW - MIN, "hello")) + "\n");
        fs.writeFileSync(path.join(dir, "subagents", "agent-a.jsonl"), JSON.stringify(toolCall(NOW - MIN)) + "\n");
        fs.writeFileSync(path.join(dir, "subagents", "agent-a.meta.json"), JSON.stringify({ agentType: "Explore" }));
        fs.writeFileSync(path.join(dir, "subagents", "workflows", "wf_c", "journal.jsonl"), JSON.stringify({ type: "launched" }) + "\n");
      }
      const ours = () => F.cachedKeys().filter((k) => k.includes(home) || k.startsWith("churn00")).length;
      F.scan(NOW);
      expect(ours()).toBeGreaterThan(10);
      fs.rmSync(path.join(home, "sessions"), { recursive: true, force: true }); // every session exits; their files stay on disk
      for (let i = 1; i <= 12; i++) F.scan(NOW + i * 2000);
      expect(ours()).toBe(0);
    } finally {
      process.env.FLEET_HOME = saved;
    }
  });

  test("after the clock is set back, the usage figures are not current for hours and new things are marked new", () => {
    const saved = { usage: { ...F.usage }, seen: { ...F.seen } };
    try {
      Object.assign(F.usage, { fetchedAt: NOW + 120 * MIN, nextTry: NOW + 125 * MIN, sharedAt: NOW + 120 * MIN, data: { five_hour: { utilization: 38, resets_at: null } }, reason: "" });
      Object.assign(F.seen, { at: NOW + 120 * MIN });
      F.steadyClock(NOW);
      expect(F.usage.nextTry).toBeLessThanOrEqual(NOW); // a read is due now
      expect(F.usage.fetchedAt).toBeLessThanOrEqual(NOW);
      expect(F.seen.at).toBe(NOW);
      expect(F.isNew(NOW + 10 * MIN)).toBe(true);
    } finally {
      Object.assign(F.usage, saved.usage);
      Object.assign(F.seen, saved.seen);
    }
  });
});

describe("new since you looked, on the conversation", () => {
  test("every reply newer than the mark is marked new, earlier ones (◇) too, so the digest's count can be found", () => {
    const saved = { ...F.seen, events: [...F.seen.events], known: new Map(F.seen.known) };
    try {
      Object.assign(F.seen, { at: NOW - 18 * MIN, events: [], known: new Map(), primed: true });
      const main = tailOf([prompt(NOW - 29 * MIN, "go"), reply(NOW - 25 * MIN, "Old news."), reply(NOW - 7 * MIN, "Found it."), reply(NOW - MIN, "Shall I open the pull request?")]);
      const s = sessionOf({ sid: "news", mains: [main] });
      F.noteScan([s], NOW, () => undefined);
      expect(F.digest().groups.find((g) => g.kind === "replies")?.count).toBe(2);
      const rows = F.detailView(F.buildViews([s], NOW), 150, 30, NOW).map(strip);
      const marked = rows.filter((l) => / new$/.test(l.slice(0, 104).trimEnd()));
      expect(marked.map((l) => l.slice(4).trim().split(" ").slice(0, 2).join(" "))).toEqual(["◇ Found", "◆ Shall"]);
      expect(rows.some((l) => l.includes("◇ Old news.") && l.slice(0, 104).trimEnd().endsWith("25m"))).toBe(true);
    } finally {
      Object.assign(F.seen, saved);
    }
  });
});

describe("a blocked job's wait", () => {
  const home = path.join(SCRATCH, "blocked");
  const sid = "blocked0-0000-4000-8000-000000000001";
  const file = path.join(home, "projects", "-b", `${sid}.jsonl`);
  const stateFile = path.join(home, "jobs", "jobB", "state.json");
  const saved = { home: process.env.FLEET_HOME };
  beforeAll(() => (process.env.FLEET_HOME = home));
  afterAll(() => (process.env.FLEET_HOME = saved.home));
  const append = (row: object, t: number) => {
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
    fs.utimesSync(file, new Date(t), new Date(t));
  };
  const block = (needs: string, t: number) => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ state: "blocked", detail: "", needs }));
    fs.utimesSync(stateFile, new Date(t), new Date(t));
  };

  test("starts when the job blocked, and does not restart when its transcript is written to", () => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(path.join(home, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: sid, name: "job", kind: "bg", status: "idle", cwd: "/work", jobId: "jobB", startedAt: NOW - 60 * MIN }));
    fs.writeFileSync(file, "");
    append(reply(NOW - 6 * MIN, "Shall I drop the column?"), NOW - 6 * MIN);
    block("Approve dropping the column?", NOW - 6 * MIN);
    Object.assign(F.seen, { at: NOW - 30 * MIN, events: [], known: new Map(), primed: false });
    const look = (now: number) => {
      const s = F.scan(now).find((x) => x.sid === sid)!;
      const f = F.factsOf(s);
      F.noteScan([s], now, () => undefined);
      return F.stateTime(s, f, "needs", now);
    };
    expect(look(NOW)).toBe("6m");
    append({ type: "system", subtype: "away_summary", timestamp: iso(NOW + 60_000), content: "Waiting for approval to drop the column." }, NOW + 60_000);
    expect(look(NOW + 62_000)).toBe("7m");
    append({ type: "ai-title", aiTitle: "Coupon migration" }, NOW + 9 * MIN); // no timestamp: only the file's time moves
    expect(look(NOW + 9 * MIN + 2_000)).toBe("15m");
    expect(F.seen.events.filter((e) => e.kind === "asked").length).toBe(1);
    // A different question is a new wait.
    block("Approve dropping the table too?", NOW + 10 * MIN);
    expect(look(NOW + 10 * MIN + 2_000)).toBe("now");
    expect(F.seen.events.filter((e) => e.kind === "asked").length).toBe(2);
  });
});

describe("a workflow between its agents", () => {
  // A workflow's state file is written when it ends. Until then the journal and the agents' transcripts are all there is,
  // and there are moments (just launched, between two agents, after the last one reports) when no agent is running.
  const home = path.join(SCRATCH, "wf-gap");
  const sid = "wfgap000-0000-4000-8000-000000000001";
  const dir = path.join(home, "projects", "-gap", sid);
  const wfDir = path.join(dir, "subagents", "workflows", "wf_gap");
  const put = (file: string, rows: object[], t: number) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    fs.utimesSync(file, new Date(t), new Date(t));
  };
  const setUp = () => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(home, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: sid, name: "pipe", kind: "bg", status: "busy", cwd: "/work/shop", startedAt: NOW - 30 * MIN }));
    put(dir + ".jsonl", [prompt(NOW - 20 * MIN, "run the pipeline")], NOW - 20 * MIN);
    fs.mkdirSync(path.join(dir, "workflows", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "workflows", "scripts", "pipe-and-fix-wf_gap.js"), "");
  };
  const journal = (rows: object[], t: number) => put(path.join(wfDir, "journal.jsonl"), [{ type: "launched" }, ...rows], t);
  const agentFile = (id: string, end: number, final: boolean) => put(path.join(wfDir, `agent-${id}.jsonl`), [toolCall(end - 5000), toolResult(end - 4000), ...(final ? [toolCall(end - 1000, "StructuredOutput", {}), toolResult(end)] : [toolCall(end)])], end);
  const statusAt = (now: number) => {
    const s = F.scan(now).find((x) => x.sid === sid)!;
    return { s, status: s.workflows[0].status };
  };
  const saved = { home: process.env.FLEET_HOME };
  beforeAll(() => (process.env.FLEET_HOME = home));
  afterAll(() => (process.env.FLEET_HOME = saved.home));

  test("just launched, between two agents, or after the last one reports: still running, and nothing failed", () => {
    setUp();
    Object.assign(F.seen, { at: NOW - 30 * MIN, events: [], known: new Map(), primed: false });
    let now = NOW - 10 * MIN;
    const step = (body: () => void) => {
      body();
      const { s, status } = statusAt(now);
      F.noteScan([s], now, () => undefined);
      now += 2000;
      return status;
    };
    expect(step(() => journal([], now - 1000))).toBe("running"); // launched, no agent yet
    expect(step(() => (journal([{ type: "started", agentId: "a1", phase: "Pipe" }], now - 1000), agentFile("a1", now - 500, false)))).toBe("running");
    expect(step(() => (agentFile("a1", now - 3000, true), journal([{ type: "started", agentId: "a1", phase: "Pipe" }, { type: "result", agentId: "a1" }], now - 2500)))).toBe("running"); // between the two
    expect(step(() => (journal([{ type: "started", agentId: "a1", phase: "Pipe" }, { type: "result", agentId: "a1" }, { type: "started", agentId: "a2", phase: "Fix" }, { type: "result", agentId: "a2" }], now - 1000), agentFile("a2", now - 1500, true)))).toBe("running"); // the last has reported; the state file is not written yet
    expect(F.seen.events.filter((e) => e.kind === "failed")).toEqual([]);
    fs.writeFileSync(path.join(dir, "workflows", "wf_gap.json"), JSON.stringify({ workflowName: "pipe-and-fix", status: "completed", startTime: NOW - 11 * MIN, durationMs: 60_000 }));
    expect(step(() => undefined)).toBe("completed");
    expect(F.seen.events.map((e) => e.kind).filter((k) => k === "failed" || k === "workflowDone")).toEqual(["workflowDone"]);
  });

  test("a workflow silent for minutes with no agent running and no state file has stopped; if it starts again, that was not a failure", () => {
    setUp();
    Object.assign(F.seen, { at: NOW - 30 * MIN, events: [], known: new Map(), primed: false });
    journal([{ type: "started", agentId: "a1", phase: "Pipe" }, { type: "result", agentId: "a1" }], NOW - 20 * MIN);
    agentFile("a1", NOW - 20 * MIN, true);
    const first = statusAt(NOW - 19 * MIN); // a minute after the last write: still between agents
    expect(first.status).toBe("running");
    F.noteScan([first.s], NOW - 19 * MIN, () => undefined);
    const later = statusAt(NOW);
    expect(later.status).toBe("stopped");
    expect(F.wfOutcome(later.s.workflows[0])).toBe("failed");
    F.noteScan([later.s], NOW, () => undefined);
    expect(F.seen.events.filter((e) => e.kind === "failed").length).toBe(1);
    // It was only waiting: a new agent starts. The stop was a guess, and the guess is withdrawn.
    journal([{ type: "started", agentId: "a1", phase: "Pipe" }, { type: "result", agentId: "a1" }, { type: "started", agentId: "a2", phase: "Fix" }], NOW + 1000);
    agentFile("a2", NOW + 1000, false);
    const again = statusAt(NOW + 2000);
    expect(again.status).toBe("running");
    F.noteScan([again.s], NOW + 2000, () => undefined);
    expect(F.seen.events.filter((e) => e.kind === "failed")).toEqual([]);
  });
});

describe("usage read tells the truth", () => {
  const k = (o: Partial<F.KeychainOutcome>): F.KeychainOutcome => ({ status: 0, stderr: "", timedOut: false, parse: "login", ...o });
  const NOT_FOUND = "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.";
  const NO_INTERACTION = "security: SecKeychainItemCopyContent: User interaction is not allowed.";
  const reason = (kc: F.KeychainOutcome | undefined, f: F.FileOutcome, remote = false) => {
    const d = F.loginDecision(kc, f, remote);
    return "reason" in d ? d.reason : `use ${d.use}`;
  };

  test("a login is used from the keychain first, then the file", () => {
    expect(reason(k({}), "missing")).toBe("use keychain");
    expect(reason(k({}), "login")).toBe("use keychain");
    expect(reason(k({ status: 44, stderr: NOT_FOUND, parse: "empty" }), "login")).toBe("use file");
    expect(reason(undefined, "login")).toBe("use file");
    expect(reason(k({ status: 36, stderr: NO_INTERACTION, parse: "empty" }), "login", true)).toBe("use file");
  });

  test("each keychain failure is reported exactly", () => {
    expect(reason(k({ status: 44, stderr: NOT_FOUND, parse: "empty" }), "no-login")).toBe("keychain: item not found");
    expect(reason(k({ status: null, timedOut: true, parse: "empty" }), "missing")).toBe("keychain: no answer in 5s");
    expect(reason(k({ status: 1, stderr: "security: something else went wrong", parse: "empty" }), "missing")).toBe("keychain: exit 1");
    expect(reason(k({ status: 51, parse: "empty" }), "no-login")).toBe("keychain: exit 51");
    expect(reason(k({ parse: "not-json" }), "missing")).toBe("keychain: entry is not JSON");
    expect(reason(k({ parse: "empty" }), "missing")).toBe("keychain: entry is not JSON");
    expect(reason(k({ parse: "no-login" }), "missing")).toBe("keychain: no claude.ai login in entry");
  });

  test("the owner's case: a remote session is told the keychain is closed to it, not that there is no login", () => {
    // mosh on macOS: the item is found, its content is refused, the call exits non-zero; the login file exists without a claude.ai entry.
    expect(reason(k({ status: 36, stderr: NO_INTERACTION, parse: "empty" }), "no-login", true)).toBe("keychain: closed to remote sessions (ssh/mosh)");
    expect(reason(k({ status: 36, stderr: NO_INTERACTION, parse: "empty" }), "no-login", false)).toBe("keychain: closed to remote sessions (ssh/mosh)"); // stderr alone is enough
    expect(reason(k({ status: 1, stderr: "", parse: "empty" }), "no-login", true)).toBe("keychain: closed to remote sessions (ssh/mosh)"); // so is being remote
    expect(reason(k({ status: null, timedOut: true, parse: "empty" }), "missing", true)).toBe("keychain: closed to remote sessions (ssh/mosh)");
    // An item that really is missing is still reported as missing, remote or not.
    expect(reason(k({ status: 44, stderr: NOT_FOUND, parse: "empty" }), "no-login", true)).toBe("keychain: item not found");
    const d = F.loginDecision(k({ status: 36, stderr: NO_INTERACTION, parse: "empty" }), "no-login", true);
    expect(d).toEqual({ reason: "keychain: closed to remote sessions (ssh/mosh)", keychain: "keychain: closed to remote sessions (ssh/mosh)", file: "login file: no claude.ai login in it" });
    expect(F.usageRemedy(F.REASON.keychainRemote)).toContain("security unlock-keychain ~/Library/Keychains/login.keychain-db");
    expect(F.usageRemedy(F.REASON.keychainRemote)).toContain("tmux");
    expect(F.usageRemedy(F.REASON.expired)).toBe("");
    // The line is given the fullest wording that fits where it is drawn; the command is the last thing to be cut.
    const command = "run: security unlock-keychain ~/Library/Keychains/login.keychain-db";
    expect(F.usageRemedy(F.REASON.keychainRemote, 103)).toBe(`${command} · or use a tmux started on the Mac`);
    expect(F.usageRemedy(F.REASON.keychainRemote, 76)).toBe(command);
    expect(F.usageRemedy(F.REASON.keychainRemote, 40)).toBe("run: security unlock-keychain ~/Library…");
    for (const w of [20, 40, 76, 103, 140]) expect(F.width(F.usageRemedy(F.REASON.keychainRemote, w))).toBeLessThanOrEqual(w);
  });

  test("'no Claude Code login found' only when the keychain and the file both said not found", () => {
    expect(reason(k({ status: 44, stderr: NOT_FOUND, parse: "empty" }), "missing")).toBe("no Claude Code login found");
    const all: [F.KeychainOutcome | undefined, F.FileOutcome, boolean][] = [];
    for (const kc of [undefined, k({ status: 44, stderr: NOT_FOUND, parse: "empty" }), k({ status: 36, stderr: NO_INTERACTION, parse: "empty" }), k({ status: null, timedOut: true, parse: "empty" }), k({ status: 2, parse: "empty" }), k({ parse: "not-json" }), k({ parse: "no-login" })])
      for (const f of ["missing", "no-login", "not-json", "empty"] as F.FileOutcome[]) for (const remote of [false, true]) all.push([kc, f, remote]);
    const allowed = [/^keychain: (item not found|no answer in 5s|exit \d+|entry is not JSON|no claude\.ai login in entry|closed to remote sessions \(ssh\/mosh\))$/, /^login file: (not found|no claude\.ai login in it)$/, /^no Claude Code login found$/];
    for (const [kc, f, remote] of all) {
      const r = reason(kc, f, remote);
      expect(allowed.some((re) => re.test(r)) ? "listed" : r).toBe("listed");
      if (r === "no Claude Code login found") expect([kc?.status, f]).toEqual([44, "missing"]);
    }
  });

  test("without a keychain (not macOS) the login file's own reason is given", () => {
    expect(reason(undefined, "missing")).toBe("login file: not found");
    expect(reason(undefined, "no-login")).toBe("login file: no claude.ai login in it");
    expect(reason(undefined, "not-json")).toBe("login file: no claude.ai login in it");
  });

  test("a remote session is recognised by its environment or its ancestors", () => {
    expect(F.isRemoteSession({}, ["zsh", "login", "Terminal"])).toBe(false);
    expect(F.isRemoteSession({ SSH_CONNECTION: "10.0.0.2 50000 10.0.0.1 22" }, [])).toBe(true);
    expect(F.isRemoteSession({ SSH_TTY: "/dev/ttys004" }, [])).toBe(true);
    expect(F.isRemoteSession({ SSH_CLIENT: "10.0.0.2 50000 22" }, [])).toBe(true);
    expect(F.isRemoteSession({ MOSH_SERVER_NETWORK_TMOUT: "604800" }, [])).toBe(true);
    expect(F.isRemoteSession({}, ["zsh", "mosh-server", "launchd"])).toBe(true);
    expect(F.isRemoteSession({}, ["zsh", "sshd-session", "sshd"])).toBe(true);
    expect(F.isRemoteSession({ TERM_PROGRAM: "tmux" }, ["zsh", "tmux"])).toBe(false); // a tmux begun on the Mac itself
  });

  test("retries come sooner after a failure and back off while it keeps failing", () => {
    expect(F.retryDelay("", 0)).toBe(5 * MIN);
    expect([1, 2, 3, 4, 5, 9].map((n) => F.retryDelay("network: timed out", n) / MIN)).toEqual([1, 2, 4, 5, 5, 5]);
    expect([1, 2, 3, 4, 9].map((n) => F.retryDelay("Anthropic answered 429", n) / MIN)).toEqual([5, 10, 20, 30, 30]);
    expect(F.retryDelay("Anthropic answered 401", 1)).toBe(MIN);
    expect(F.retryDelay(F.REASON.keychainSilent, 1)).toBe(5 * MIN); // each try blocks for five seconds
    expect(F.retryDelay(F.REASON.keychainRemote, 1)).toBe(5 * MIN); // it stays closed until you unlock it, and u retries at once
  });

  const figures = (five = 38, week = 21): F.UsageFigures => ({
    five_hour: { utilization: five, resets_at: iso(NOW + 130 * MIN) },
    seven_day: { utilization: week, resets_at: iso(NOW + 3 * 24 * 60 * MIN) },
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1200, currency: "GBP", decimal_places: 2 },
  });

  test("current, stale and no reading are told apart by the age of the figures", () => {
    const at = (ageMin: number, reason = "") => F.usageStateOf({ data: figures(), fetchedAt: NOW - ageMin * MIN, reason, nextTry: NOW + 4 * MIN }, NOW);
    expect(at(0).kind).toBe("current");
    expect(at(9.9)).toMatchObject({ kind: "current", failing: "" });
    expect(at(3, "keychain: closed to remote sessions (ssh/mosh)")).toMatchObject({ kind: "current", failing: "keychain: closed to remote sessions (ssh/mosh)" });
    expect(at(10, "Anthropic answered 429")).toMatchObject({ kind: "stale", asOf: NOW - 10 * MIN, reason: "Anthropic answered 429" });
    expect(at(39, "Anthropic answered 429").kind).toBe("stale");
    expect(at(23 * 60 + 59, "network: timed out").kind).toBe("stale");
    expect(at(24 * 60, "network: timed out")).toEqual({ kind: "none", reason: "network: timed out", nextTry: NOW + 4 * MIN });
    expect(F.usageStateOf({ data: undefined, fetchedAt: 0, reason: "keychain: no answer in 5s", nextTry: NOW + 5 * MIN }, NOW)).toEqual({ kind: "none", reason: "keychain: no answer in 5s", nextTry: NOW + 5 * MIN });
  });

  test("the account view carries limits, extra usage, the reason and its remedy", () => {
    const current = F.accountViewOf({ kind: "current", data: { ...figures(), seven_day_opus: { utilization: 12, resets_at: null } }, asOf: NOW, failing: "" }, { nextTry: NOW + 5 * MIN, busy: false }, NOW);
    expect(current.limits.map((l) => [l.label, l.pct, l.windowMs / 3600_000])).toEqual([["5h", 38, 5], ["7d", 21, 168], ["opus", 12, 168]]);
    expect(current.limits[0].resetsAt).toBe(NOW + 130 * MIN);
    expect(current.limits[2].resetsAt).toBe(0);
    expect(current.extra).toEqual({ enabled: true, pct: 24, used: "£12", limit: "£50" });
    expect(current).toMatchObject({ kind: "current", reason: "", remedy: "", asOf: NOW });
    const off = F.accountViewOf({ kind: "current", data: { ...figures(), extra_usage: { is_enabled: false } }, asOf: NOW, failing: "" }, { nextTry: 0, busy: false }, NOW);
    expect(off.extra).toEqual({ enabled: false, pct: 0, used: "$0", limit: "$0" });
    const none = F.accountViewOf({ kind: "none", reason: F.REASON.keychainRemote, nextTry: NOW + MIN }, { nextTry: NOW + MIN, busy: false }, NOW);
    expect(none).toMatchObject({ kind: "none", limits: [], asOf: 0, reason: "keychain: closed to remote sessions (ssh/mosh)", nextTry: NOW + MIN });
    expect(none.remedy).toContain("unlock-keychain");
    const stale = F.accountViewOf({ kind: "stale", data: figures(), asOf: NOW - 39 * MIN, reason: "Anthropic answered 429" }, { nextTry: NOW, busy: true }, NOW);
    expect(stale).toMatchObject({ kind: "stale", asOf: NOW - 39 * MIN, reason: "Anthropic answered 429", busy: true });
    expect(stale.limits.length).toBe(2);
  });

  test("reset times read as the header prints them", () => {
    const fri = new Date(2026, 9, 16, 9, 0, 0).getTime();
    expect(F.resetText(NOW + 130 * MIN, NOW)).toBe("resets in 2h10");
    expect(F.resetText(NOW + 130 * MIN, NOW, "short")).toBe("2h10 left");
    expect(F.resetText(NOW + 130 * MIN, NOW, "bare")).toBe("2h10");
    expect(F.resetText(NOW + 35 * MIN, NOW)).toBe("resets in 35m");
    expect(F.resetText(fri, NOW)).toBe("resets Fri 09:00");
    expect(F.resetText(fri, NOW, "short")).toBe("Fri 09:00");
    expect(F.resetText(fri - 400, NOW)).toBe("resets Fri 09:00"); // a reset time a fraction of a second short of the minute
    expect(F.resetText(NOW - MIN, NOW)).toBe("");
    expect(F.resetText(0, NOW)).toBe("");
  });

  /** An answer with things in it that are not figures. None of them may survive. */
  const dirty = { ...figures(), accessToken: "sk-ant-oat01-SECRET", token: "SECRET", refresh_token: "SECRET", account: { email: "someone@example.com", token: "SECRET" }, five_hour: { utilization: 38, resets_at: iso(NOW + 130 * MIN), token: "SECRET", note: "SECRET" }, extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1200, currency: "GBP", decimal_places: 2, payment_token: "SECRET" } };
  const scalarsOf = (o: any): unknown[] => (o && typeof o === "object" ? Object.values(o).flatMap(scalarsOf) : [o]);
  const keysOf = (o: any): string[] => (o && typeof o === "object" ? Object.entries(o).flatMap(([key, v]) => [key, ...keysOf(v)]) : []);

  test("figuresOnly keeps utilisation, reset times and the extra-usage numbers, and nothing else", () => {
    const clean = F.figuresOnly(dirty);
    expect(clean).toEqual({ five_hour: { utilization: 38, resets_at: iso(NOW + 130 * MIN) }, seven_day: { utilization: 21, resets_at: iso(NOW + 3 * 24 * 60 * MIN) }, extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1200, currency: "GBP", decimal_places: 2 } });
    expect(JSON.stringify(clean)).not.toContain("SECRET");
    expect(F.figuresOnly(null)).toEqual({});
    expect(F.figuresOnly("a string")).toEqual({});
    expect(F.figuresOnly({ five_hour: { utilization: "38" }, weird: { utilization: 5, resets_at: "not a date" } })).toEqual({ weird: { utilization: 5, resets_at: null } });
  });

  test("the shared file holds figures and fetchedAt only: no token key, nothing that is not a number, a time, a flag or a currency code", () => {
    const text = F.sharedUsageContent(dirty, NOW);
    expect(text.toLowerCase()).not.toContain("token");
    expect(text).not.toContain("SECRET");
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed).sort()).toEqual(["extra_usage", "fetchedAt", "five_hour", "seven_day"]);
    expect(keysOf(parsed).filter((key) => /token|secret|key|auth|password|email/i.test(key))).toEqual([]);
    for (const v of scalarsOf(parsed)) expect(typeof v === "number" || typeof v === "boolean" || v === null || /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(String(v)) || /^[A-Z]{3}$/.test(String(v))).toBe(true);
  });

  const resetUsage = () => Object.assign(F.usage, { at: 0, nextTry: 0, busy: false, failures: 0, reason: "", data: undefined, fetchedAt: 0, source: "", sharedAt: 0 });
  const shared = () => F.sharedUsagePath();

  test("a successful read writes the shared file: figures only, mode 0600, and a later failure reads it back", async () => {
    resetUsage();
    fs.rmSync(path.dirname(shared()), { recursive: true, force: true });
    expect(shared().startsWith(SCRATCH)).toBe(true); // never the real cache
    await F.fetchUsage(NOW, async (now) => ({ figures: dirty as unknown as F.UsageFigures, fetchedAt: now }));
    expect(F.usage).toMatchObject({ reason: "", failures: 0, source: "own", fetchedAt: NOW, nextTry: NOW + 5 * MIN });
    const text = fs.readFileSync(shared(), "utf8");
    expect(text.toLowerCase()).not.toContain("token");
    expect(text).not.toContain("SECRET");
    expect(JSON.parse(text)).toEqual({ fetchedAt: NOW, ...F.figuresOnly(dirty) });
    expect(fs.statSync(shared()).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(shared()))).toEqual(["usage.json"]); // no temporary file left behind

    // A second dashboard, in a remote terminal, cannot read the login. It shows the shared figures and says why its own read fails.
    resetUsage();
    await F.fetchUsage(NOW + 3 * MIN, async () => ({ reason: F.REASON.keychainRemote }));
    expect(F.usage).toMatchObject({ reason: "keychain: closed to remote sessions (ssh/mosh)", failures: 1, source: "shared", fetchedAt: NOW, nextTry: NOW + 8 * MIN });
    expect(F.usageState(NOW + 3 * MIN)).toMatchObject({ kind: "current", failing: "keychain: closed to remote sessions (ssh/mosh)" });
    expect(F.usageState(NOW + 40 * MIN)).toMatchObject({ kind: "stale", asOf: NOW, reason: "keychain: closed to remote sessions (ssh/mosh)" });
    expect(F.usageState(NOW + 25 * 60 * MIN).kind).toBe("none");
    expect(fs.readFileSync(shared(), "utf8")).toBe(text); // a failing dashboard writes nothing
  });

  test("with no shared file, Claude Code's own cached figures are used, and only that one key is read", async () => {
    resetUsage();
    fs.rmSync(path.dirname(shared()), { recursive: true, force: true });
    const home = process.env.FLEET_HOME!;
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "someone@example.com" }, userID: "SECRET", cachedUsageUtilization: { fetchedAtMs: NOW - 2 * MIN, accountUuid: "SECRET", utilization: { five_hour: { utilization: 44, resets_at: iso(NOW + 60 * MIN), limit_dollars: null }, seven_day: null } } }));
    const read = F.readClaudeUsage();
    expect(read).toEqual({ fetchedAt: NOW - 2 * MIN, figures: { five_hour: { utilization: 44, resets_at: iso(NOW + 60 * MIN) } } });
    await F.fetchUsage(NOW, async () => ({ reason: "network: timed out" }));
    expect(F.usage).toMatchObject({ source: "claude", fetchedAt: NOW - 2 * MIN, reason: "network: timed out" });
    expect(JSON.stringify(F.usage.data)).not.toContain("SECRET");
    expect(F.accountView(NOW).limits.map((l) => [l.label, l.pct])).toEqual([["5h", 44]]);
    // Fresher shared figures win over it.
    F.writeSharedUsage(figures(50), NOW - MIN);
    await F.fetchUsage(NOW + 1000, async () => ({ reason: "network: timed out" }));
    expect(F.usage).toMatchObject({ source: "shared", fetchedAt: NOW - MIN, failures: 2 });
    fs.rmSync(path.join(home, ".claude.json"));
  });

  test("no figures anywhere: no reading yet, the exact reason, and when the next try is", async () => {
    resetUsage();
    fs.rmSync(path.dirname(shared()), { recursive: true, force: true });
    await F.fetchUsage(NOW, async () => ({ reason: F.REASON.keychainSilent }));
    expect(F.usageState(NOW)).toEqual({ kind: "none", reason: "keychain: no answer in 5s", nextTry: NOW + 5 * MIN });
    expect(fs.existsSync(shared())).toBe(false);
  });

  test("figures stamped in the future are not believed: they would count as current for ever", async () => {
    resetUsage();
    fs.rmSync(path.dirname(shared()), { recursive: true, force: true });
    const home = process.env.FLEET_HOME!;
    fs.mkdirSync(home, { recursive: true });
    try {
      // A damaged shared file, or one written before the clock was set back: three days ahead.
      F.writeSharedUsage(figures(50), NOW + 3 * 24 * 60 * MIN);
      fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: NOW + 2 * 60 * MIN, utilization: figures(60) } }));
      await F.fetchUsage(NOW, async () => ({ reason: "network: timed out" }));
      expect(F.usage).toMatchObject({ source: "", fetchedAt: 0, data: undefined });
      expect(F.usageState(NOW)).toMatchObject({ kind: "none", reason: "network: timed out" });
      // A reader whose clock runs a few seconds behind the writer's is not a damaged file.
      F.writeSharedUsage(figures(50), NOW + 20_000);
      await F.fetchUsage(NOW + 1000, async () => ({ reason: "network: timed out" }));
      expect(F.usage).toMatchObject({ source: "shared", fetchedAt: NOW + 20_000 });
      expect(F.usageState(NOW + 1000).kind).toBe("current");
    } finally {
      fs.rmSync(path.join(home, ".claude.json"), { force: true });
      fs.rmSync(path.dirname(shared()), { recursive: true, force: true });
      resetUsage();
    }
  });

  test("test hooks: FLEET_USAGE_FIXTURE supplies figures, FLEET_USAGE_FAIL forces a reason, and made-up figures are never shared", async () => {
    const fixture = path.join(SCRATCH, "fixture.json");
    fs.writeFileSync(fixture, JSON.stringify({ ...figures(86), fetchedAt: NOW - 39 * MIN }));
    try {
      resetUsage();
      fs.rmSync(path.dirname(shared()), { recursive: true, force: true });
      process.env.FLEET_USAGE_FIXTURE = fixture;
      await F.fetchUsage(NOW); // the real reader, which the hook keeps away from the login and the network
      expect(F.usage).toMatchObject({ reason: "", source: "own", fetchedAt: NOW - 39 * MIN });
      expect((F.usage.data!.five_hour as F.UsageWindow).utilization).toBe(86);
      expect(fs.existsSync(shared())).toBe(false);

      resetUsage();
      process.env.FLEET_USAGE_FAIL = "Anthropic answered 429";
      await F.fetchUsage(NOW); // with both set, the fixture stands in for the shared file
      expect(F.usageState(NOW)).toMatchObject({ kind: "stale", asOf: NOW - 39 * MIN, reason: "Anthropic answered 429" });
      expect(F.usage.nextTry).toBe(NOW + 5 * MIN);

      resetUsage();
      delete process.env.FLEET_USAGE_FIXTURE;
      process.env.FLEET_USAGE_FAIL = "keychain: closed to remote sessions (ssh/mosh)";
      await F.fetchUsage(NOW);
      expect(F.usageState(NOW)).toEqual({ kind: "none", reason: "keychain: closed to remote sessions (ssh/mosh)", nextTry: NOW + 5 * MIN });
    } finally {
      delete process.env.FLEET_USAGE_FIXTURE;
      delete process.env.FLEET_USAGE_FAIL;
      resetUsage();
    }
  });
});

describe("runway", () => {
  const MAX = 1_000_000;
  /** Readings every `stepMin` minutes from `fromMin` minutes ago to `toMin` minutes ago, growing by `perMin` tokens a minute from `start`. */
  const grow = (start: number, perMin: number, fromMin: number, toMin = 0, stepMin = 1): [number, number][] => {
    const out: [number, number][] = [];
    for (let m = fromMin; m >= toMin; m -= stepMin) out.push([NOW - m * MIN, start + (fromMin - m) * perMin]);
    return out;
  };

  test("steady growth gives the minutes until the window is full", () => {
    // 600k ten minutes ago, 10k a minute since: 700k now, 300k left, 30 minutes.
    expect(F.ctxRunway(grow(600_000, 10_000, 10), MAX, NOW)).toBeCloseTo(30, 6);
    // 611k used and "full in ~40m", as in the design: 389k left at 9,725 a minute.
    expect(F.fullInText(F.ctxRunway(grow(611_000 - 97_250, 9_725, 10), MAX, NOW)!)).toBe("full in ~40m");
    expect(F.ctxRunway(grow(190_000, 1_000, 8), 200_000, NOW)).toBeCloseTo(2, 6); // a 200k window nearly full
  });

  test("it needs five minutes of history and uses the last ten", () => {
    expect(F.ctxRunway(grow(600_000, 10_000, 4), MAX, NOW)).toBeUndefined();
    expect(F.ctxRunway(grow(600_000, 10_000, 5), MAX, NOW)).toBeCloseTo(35, 6);
    // Fast growth more than ten minutes ago is ignored: only the slow last ten count, and they are over the hour.
    const log = [...grow(100_000, 50_000, 15, 11), ...grow(300_000, 1_000, 10)];
    expect(F.ctxRunway(log, MAX, NOW)).toBeUndefined();
    expect(F.ctxRunway([], MAX, NOW)).toBeUndefined();
    expect(F.ctxRunway(grow(600_000, 10_000, 10).slice(0, 2), MAX, NOW)).toBeUndefined();
  });

  test("it stays silent beyond the hour, when flat, and when shrinking", () => {
    expect(F.ctxRunway(grow(600_000, 1_000, 10), MAX, NOW)).toBeUndefined(); // 390 minutes away
    expect(F.ctxRunway(grow(700_000, 5_000, 10), MAX, NOW)).toBeCloseTo(50, 6);
    expect(F.ctxRunway(grow(700_000, 4_000, 10), MAX, NOW)).toBeUndefined(); // 65 minutes away
    expect(F.ctxRunway(grow(600_000, 0, 10), MAX, NOW)).toBeUndefined();
    expect(F.ctxRunway(grow(600_000, -3_000, 10), MAX, NOW)).toBeUndefined();
  });

  test("one jump, growth that has stopped, and a compaction are not a trend", () => {
    const jump: [number, number][] = grow(600_000, 0, 10).map(([t, u]) => [t, t >= NOW - 2 * MIN ? u + 150_000 : u]);
    expect(F.ctxRunway(jump, MAX, NOW)).toBeUndefined();
    expect(F.ctxRunway(grow(600_000, 20_000, 10, 6), MAX, NOW)).toBeUndefined(); // nothing written for six minutes
    // Compacted four minutes ago: the history starts again there, so there is not yet five minutes of it.
    const compacted: [number, number][] = [...grow(800_000, 15_000, 10, 5), ...grow(120_000, 15_000, 4)];
    expect(F.ctxRunway(compacted, MAX, NOW)).toBeUndefined();
    // Six minutes after a compaction the new history is enough, though this one is far from full.
    expect(F.ctxRunway([...grow(800_000, 15_000, 10, 7), ...grow(120_000, 15_000, 6)], MAX, NOW)).toBeCloseTo((MAX - 210_000) / 15_000, 6);
    expect(F.ctxRunway(grow(995_000, 1_000, 10), MAX, NOW)).toBe(0); // already full
  });

  test("the transcript's own readings feed it", () => {
    const rows = Array.from({ length: 21 }, (_, i) => reply(NOW - (20 - i) * MIN, `step ${i}`, 500_000 + i * 12_000));
    const main = tailOf(rows);
    expect(main.ctxLog.length).toBe(16); // fifteen minutes are kept
    expect(main.ctxLog[0]).toEqual([NOW - 15 * MIN, 560_004]);
    expect(F.sessionRunway(main, NOW)).toBeCloseTo((1_000_000 - 740_004) / 12_000, 6);
    expect(F.sessionRunway(undefined, NOW)).toBeUndefined();
    expect(F.sessionRunway(tailOf([toolResult(NOW)]), NOW)).toBeUndefined();
  });

  test("forecasts are worded roughly, and turn red under fifteen minutes", () => {
    expect([0.2, 3.4, 9.4, 12.4, 14, 38, 57, 58, 85, 600, 1500, 3000].map(F.roughly)).toEqual(["1m", "3m", "9m", "10m", "15m", "40m", "55m", "1h00", "1h25", "10h00", "1d1h", "2d2h"]);
    expect(F.fullInText(35)).toBe("full in ~35m");
    expect(F.runwayTone(14.9)).toEqual(F.C.red);
    expect(F.runwayTone(15)).toEqual(F.C.white);
  });

  const H = 60 * MIN;
  test("the pace tick is the share of the limit's window that has passed", () => {
    expect(F.paceTick(NOW + 130 * MIN, 5 * H, NOW)).toBeCloseTo(170 / 300, 9); // 5h window, resets in 2h10
    expect(F.paceTick(NOW + 5 * H, 5 * H, NOW)).toBe(0);
    expect(F.paceTick(NOW + 1, 5 * H, NOW)).toBeCloseTo(1, 6);
    expect(F.paceTick(NOW + 6 * H, 5 * H, NOW)).toBe(0); // a reset further off than the window is long: clamped
    expect(F.paceTick(NOW - MIN, 5 * H, NOW)).toBeUndefined(); // the window has rolled over since the figures were read
    expect(F.paceTick(0, 5 * H, NOW)).toBeUndefined();
    const week = 7 * 24 * H;
    expect(F.paceTick(NOW + 0.36 * week, week, NOW)).toBeCloseTo(0.64, 9);
  });

  test("the tick's cell and glyph: ┿ once the fill has passed it, ┼ on the empty track", () => {
    expect(F.paceCell(0.57, 38, 12)).toEqual({ cell: 6, glyph: "┼" }); // ━━━━━─┼─────
    expect(F.paceCell(0.64, 21, 12)).toEqual({ cell: 7, glyph: "┼" }); // ━━━────┼────
    expect(F.paceCell(0.57, 86, 12)).toEqual({ cell: 6, glyph: "┿" }); // ━━━━━━┿━━━──
    expect(F.paceCell(0.57, 38, 8)).toEqual({ cell: 4, glyph: "┼" }); // ━━━─┼───
    expect(F.paceCell(1, 100, 12)).toEqual({ cell: 11, glyph: "┿" });
  });

  test("an account forecast appears only when the pace reaches 100% before the reset", () => {
    // 38% after 2h50 of 5h: at that pace full in 4h37, but the limit resets in 2h10. Nothing to say.
    expect(F.paceForecast(38, NOW + 130 * MIN, 5 * H, NOW)).toBeUndefined();
    // 86% after 3h35, resetting in 1h25: full in 35 minutes.
    const fullIn = F.paceForecast(86, NOW + 85 * MIN, 5 * H, NOW)!;
    expect(fullIn / MIN).toBeCloseTo(35, 9);
    expect(F.fullInText(fullIn / MIN)).toBe("full in ~35m");
    expect(F.paceForecast(100, NOW + 85 * MIN, 5 * H, NOW)).toBeUndefined(); // already full: see "runway and pace, worked by hand"
    expect(F.paceForecast(50, NOW - MIN, 5 * H, NOW)).toBeUndefined();
  });

  test("the account forecast is suppressed early in a window and under 5% used", () => {
    expect(F.paceForecast(40, NOW + 4.5 * H, 5 * H, NOW)).toBeUndefined(); // 10% of the window gone: too early, however fast
    expect(F.paceForecast(40, NOW + 4.25 * H - 1, 5 * H, NOW)! / MIN).toBeCloseTo(67.5, 3); // 15% gone: now it counts
    expect(F.paceForecast(4.9, NOW + 0.2 * H, 5 * H, NOW)).toBeUndefined();
    const week = 7 * 24 * H;
    expect(F.paceForecast(60, NOW + 5 * 24 * H, week, NOW)! / H).toBeCloseTo(32, 6); // two days in at 60%: full in 32 hours
  });

  test("the account view carries the tick and the forecast for each limit", () => {
    const data: F.UsageFigures = { five_hour: { utilization: 86, resets_at: iso(NOW + 85 * MIN) }, seven_day: { utilization: 21, resets_at: iso(NOW + 0.36 * 7 * 24 * H) } };
    const view = F.accountViewOf({ kind: "current", data, asOf: NOW, failing: "" }, { nextTry: 0, busy: false }, NOW);
    expect(view.limits[0].tick).toBeCloseTo(215 / 300, 9);
    expect(view.limits[0].fullIn! / MIN).toBeCloseTo(35, 9);
    expect(view.limits[1].tick).toBeCloseTo(0.64, 9);
    expect(view.limits[1].fullIn).toBeUndefined();
    const stale = F.accountViewOf({ kind: "stale", data, asOf: NOW - 30 * MIN, reason: "network: timed out" }, { nextTry: 0, busy: false }, NOW);
    expect(stale.limits[0].tick).toBeCloseTo(215 / 300, 9);
    expect(stale.limits[0].fullIn).toBeUndefined(); // no forecast from figures that are not current
  });
});

describe("stall watch", () => {
  const STALL = 10 * MIN;
  /** A thread that made a tool call `quietMin` minutes ago; `answered` says whether its result came back. */
  const thread = (quietMin: number, answered = false) => tailOf([toolCall(NOW - quietMin * MIN - 5_000), toolResult(NOW - quietMin * MIN - 4_000), toolCall(NOW - quietMin * MIN), ...(answered ? [toolResult(NOW - quietMin * MIN + 1)] : [])]);

  test("an agent left on a tool call is not a stall once the session has moved on since it last wrote", () => {
    const busyMain = tailOf([prompt(NOW - 4 * 60 * MIN, "keep going"), ...callTimes(40, NOW - 2_000, 60).flatMap((t) => [toolCall(t), toolResult(t + 500)])]);
    const dead = agentOf("old1", thread(180)); // cut off three hours ago on an unanswered Bash call, by a run of the session before this one
    const s = sessionOf({ sid: "x", status: "busy", startedAt: NOW - 60 * MIN, mains: [busyMain], agents: [dead] });
    expect(F.stallOf(s, F.factsOf(s), NOW, 0.4, STALL, new Map()).count).toBe(0);
    expect(F.stallOf({ ...s, startedAt: NOW - 5 * 60 * MIN }, F.factsOf(s), NOW, 0.4, STALL, new Map()).threads).toEqual(["old1"]); // in this run, with no prompt since: still a candidate
    // A new prompt since it last wrote also means its turn is over, inside a workflow too.
    const later = tailOf([prompt(NOW - 30 * MIN, "now something else"), toolCall(NOW - 2 * MIN, "Workflow")]);
    const wf: F.Workflow = { id: "wf_1", name: "w", status: "running", phase: "Fix", phases: [], seen: ["Fix"], started: NOW - 3 * 60 * MIN, finished: 0, agents: [agentOf("w1", thread(180), { wf: "wf_1" })], lastT: NOW - 180 * MIN };
    const t = sessionOf({ sid: "y", status: "busy", mains: [later], workflows: [wf] });
    expect(F.stallOf(t, F.factsOf(t), NOW, 0.4, STALL, new Map()).threads).toEqual([]);
    // But an agent the main thread is still waiting on (its Agent call made before the agent's silence, nothing back since) is one.
    const waiting = tailOf([prompt(NOW - 40 * MIN, "measure it"), toolCall(NOW - 30 * MIN, "Agent", { description: "measure" })]);
    const u = sessionOf({ sid: "z", status: "busy", mains: [waiting], agents: [agentOf("m1", thread(14))] });
    expect(F.stallOf(u, F.factsOf(u), NOW, 0.4, STALL, new Map()).threads).toEqual(["main", "m1"]); // the main thread waits on it, so it is quiet too
    // And a workflow's agent stays one while the main thread works on beside it (the design's own example).
    const beside = tailOf([prompt(NOW - 40 * MIN, "fix the tests"), ...callTimes(20, NOW - 2 * MIN, 30).flatMap((x) => [toolCall(x), toolResult(x + 500)])]);
    const wf2: F.Workflow = { ...wf, agents: [agentOf("w5", thread(14), { wf: "wf_1" })], lastT: NOW - 14 * MIN };
    const v = sessionOf({ sid: "w", status: "busy", mains: [beside], workflows: [wf2] });
    expect(F.stallOf(v, F.factsOf(v), NOW, 0.4, STALL, new Map()).threads).toEqual(["w5"]);
  });

  test("a thread: a tool call outstanding, nothing written for the stall time, the tree under 1% CPU", () => {
    const quiet = (min: number, pending = true) => ({ pending, lastWrite: NOW - min * MIN });
    expect(F.threadStalled(quiet(14), 0.2, NOW, STALL)).toBe(true);
    expect(F.threadStalled(quiet(10), 0, NOW, STALL)).toBe(true);
    expect(F.threadStalled(quiet(9.9), 0, NOW, STALL)).toBe(false); // not long enough
    expect(F.threadStalled(quiet(14), 1, NOW, STALL)).toBe(false); // something in the tree is still working
    expect(F.threadStalled(quiet(14), 37.5, NOW, STALL)).toBe(false);
    expect(F.threadStalled(quiet(14, false), 0, NOW, STALL)).toBe(false); // nothing outstanding: quiet, not stuck
    expect(F.threadStalled(quiet(14), undefined, NOW, STALL)).toBe(false); // the process was not sampled: claim nothing
    expect(F.threadStalled(quiet(14), 0, NOW, 0)).toBe(false); // --stall 0 turns it off
    expect(F.threadStalled(quiet(4), 0, NOW, 3 * MIN)).toBe(true); // --stall 3
  });

  test("a session: busy, no thread at all has written for the stall time, the tree under 1% CPU", () => {
    expect(F.sessionStalled(true, NOW - 11 * MIN, 0.4, NOW, STALL)).toBe(true);
    expect(F.sessionStalled(false, NOW - 11 * MIN, 0.4, NOW, STALL)).toBe(false); // not busy: it is waiting on you, not stuck
    expect(F.sessionStalled(true, NOW - 9 * MIN, 0.4, NOW, STALL)).toBe(false);
    expect(F.sessionStalled(true, NOW - 11 * MIN, 3, NOW, STALL)).toBe(false);
    expect(F.sessionStalled(true, NOW - 11 * MIN, undefined, NOW, STALL)).toBe(false);
    expect(F.sessionStalled(true, NOW - 11 * MIN, 0, NOW, 0)).toBe(false);
    expect(F.sessionStalled(true, 0, 0, NOW, STALL)).toBe(false); // nothing has ever been written
  });

  /** The verdict with the session's tree at `cpu` percent; "unknown" when its process was not sampled. */
  const verdict = (s: F.Session, cpu: number | "unknown" = 0.3, stallMs = STALL) => {
    const saved = { procs: F.machine.procs, kids: F.machine.kids };
    F.machine.procs = cpu === "unknown" ? [] : [{ pid: s.pid, ppid: 1, cpu, rss: 1000, name: "claude" }];
    F.machine.kids = new Map();
    try {
      return F.stallOf(s, F.factsOf(s), NOW, undefined, stallMs); // reads the tree's CPU itself, as the screen does
    } finally {
      Object.assign(F.machine, saved);
    }
  };

  test("one agent stuck on a tool marks that thread and reports a count, while live agents carry on", () => {
    const s = sessionOf({ sid: "b", mains: [thread(2)], agents: [agentOf("live", thread(0.2)), agentOf("stuck", thread(14)), agentOf("answered", thread(20, true)), agentOf("finished", thread(30), { done: true })] });
    expect(verdict(s)).toEqual({ session: false, threads: ["stuck"], count: 1, since: NOW - 14 * MIN });
    expect(F.sessionState(F.factsOf(s), verdict(s).count > 0)).toBe("stalled");
    expect(F.stallKeys("b", verdict(s))).toEqual(["b/stuck"]);
    expect(verdict(s, 12).count).toBe(0); // the tree is busy
    expect(verdict(s, "unknown").count).toBe(0); // its process was not in the sample: claim nothing
    expect(verdict(s, 0.3, 0).count).toBe(0); // --stall 0
    expect(verdict(s, 0.3, 15 * MIN).count).toBe(0); // --stall 15
  });

  test("a whole session gone quiet is stalled, and its main thread with it when it holds a tool call", () => {
    const s = sessionOf({ sid: "b", mains: [thread(12)], agents: [agentOf("a1", thread(15)), agentOf("a2", thread(11, true))] });
    expect(verdict(s)).toEqual({ session: true, threads: ["main", "a1"], count: 2, since: NOW - 15 * MIN });
    // Nothing outstanding anywhere, but busy and silent: the session itself is the one stalled thing.
    const silent = sessionOf({ sid: "c", mains: [thread(12, true)] });
    expect(verdict(silent)).toEqual({ session: true, threads: [], count: 1, since: NOW - 12 * MIN + 1 });
    expect(F.stallKeys("c", verdict(silent))).toEqual(["c"]);
    // The main thread waits on its agents: while one of them is writing, it is not stalled.
    const waiting = sessionOf({ sid: "d", mains: [thread(25)], agents: [agentOf("a1", thread(1))] });
    expect(verdict(waiting).count).toBe(0);
  });

  test("only a working session can be stalled, and only a running workflow's agents count", () => {
    const stuck = [agentOf("stuck", thread(14))];
    expect(verdict(sessionOf({ sid: "idle", status: "idle", mains: [thread(2)], agents: stuck })).count).toBe(0);
    expect(verdict(sessionOf({ sid: "asks", status: "idle", job: { state: "blocked", detail: "", needs: "Approve?" }, mains: [thread(2)], agents: stuck })).count).toBe(0);
    expect(verdict(sessionOf({ sid: "job", status: "idle", job: { state: "working", detail: "", needs: "" }, mains: [thread(2)], agents: stuck })).count).toBe(1);
    const wf = (status: string): F.Workflow => ({ id: "wf_1", name: "w", status, phase: "Fix", phases: [], seen: ["Fix"], started: NOW - 20 * MIN, finished: 0, agents: [agentOf("w5", thread(14), { wf: "wf_1" })], lastT: NOW });
    expect(verdict(sessionOf({ sid: "run", mains: [thread(2)], workflows: [wf("running")] })).threads).toEqual(["w5"]);
    expect(verdict(sessionOf({ sid: "ended", mains: [thread(2)], workflows: [wf("failed")] })).count).toBe(0);
  });

  test("the bell rings once per newly stalled thing", () => {
    const known = new Set<string>();
    expect(F.newSince(known, ["b/stuck"])).toEqual(["b/stuck"]);
    expect(F.newSince(known, ["b/stuck"])).toEqual([]); // still stalled: no second ring
    expect(F.newSince(known, ["b/stuck", "b/other", "c"])).toEqual(["b/other", "c"]);
    expect(F.newSince(known, [])).toEqual([]);
    expect(F.newSince(known, ["b/stuck"])).toEqual(["b/stuck"]); // recovered and stalled again: it rings again
  });

  test("--stall sets the minutes, 0 turns the watch off, and its value is not taken for the window", () => {
    const before = { ...F.opt };
    try {
      F.parseArgs([]);
      expect(F.opt.stallMin).toBe(10);
      F.parseArgs(["--stall", "3"]);
      expect([F.opt.stallMin, F.opt.windowMin]).toEqual([3, before.windowMin]);
      F.parseArgs(["60", "--stall", "0"]);
      expect([F.opt.stallMin, F.opt.windowMin]).toEqual([0, 60]);
    } finally {
      Object.assign(F.opt, before);
    }
  });

  test("a stalled session sorts under the ones that need you and above the working ones, and says so", () => {
    const stuck = sessionOf({ sid: "stuck", name: "flaky test hunt", pid: 4242, startedAt: NOW - 64 * MIN, mains: [thread(2)], agents: [agentOf("review", thread(14))] });
    const busy = sessionOf({ sid: "busy", name: "docs site search", pid: 4243, startedAt: NOW - 5 * MIN, mains: [thread(0.1)] });
    const asks = sessionOf({ sid: "asks", name: "checkout flow redesign", pid: 4244, status: "idle", job: { state: "blocked", detail: "", needs: "Approve?" }, mains: [thread(6)] });
    const procs = [4242, 4243, 4244].map((pid) => ({ pid, ppid: 1, cpu: pid === 4243 ? 9 : 0.2, rss: 1000, name: "claude" }));
    const saved = { procs: F.machine.procs, kids: F.machine.kids };
    F.machine.procs = procs;
    F.machine.kids = new Map();
    try {
      const views = F.buildViews([busy, stuck, asks], NOW);
      expect(views.map((v) => [v.s.sid, v.state, v.stall.count])).toEqual([["asks", "needs", 0], ["stuck", "stalled", 1], ["busy", "working", 0]]);
      expect(F.stateTime(stuck, views[1].facts, "stalled", NOW, views[1].stall.since)).toBe("14m");
      const frame = F.render([busy, stuck, asks], 150, 40, NOW).map(strip).join("\n");
      expect(frame).toContain("◐ S T A L L E D ?  ·  14m");
      expect(frame).toContain("stalled? Bash");
    } finally {
      Object.assign(F.machine, saved);
    }
  });
});

describe("since you looked", () => {
  const resetSeen = (at: number) => Object.assign(F.seen, { at, events: [], known: new Map(), primed: false });
  const noJobs = () => undefined;
  const blocked = { state: "blocked", detail: "", needs: "Approve?" };
  const wfOf = (status: string, agents: F.Agent[], finished = 0): F.Workflow => ({ id: "wf_1", name: "bisect-and-fix", status, phase: "Fix", phases: [], seen: ["Fix"], started: NOW - 20 * MIN, finished, agents, lastT: NOW - MIN });
  /** A thread that last wrote `min` minutes ago and holds a tool call. */
  const thread = (min: number) => tailOf([toolCall(NOW - min * MIN)]);
  const kinds = () => F.seen.events.map((e) => e.kind);

  test("the mark starts where it is put, space moves it, and a timestamp is new when it is after the mark", () => {
    resetSeen(NOW - 10 * MIN);
    expect(F.isNew(NOW - 9 * MIN)).toBe(true);
    expect(F.isNew(NOW - 10 * MIN)).toBe(false);
    expect(F.isNew(NOW - 11 * MIN)).toBe(false);
    F.seen.events.push({ kind: "reply", t: NOW - MIN, sid: "a", key: "say:a" });
    expect(F.newCount()).toBe(1);
    F.markSeen(NOW);
    expect([F.seen.at, F.newCount(), F.isNew(NOW - MIN), F.isNew(NOW + 1)]).toEqual([NOW, 0, false, true]);
  });

  test("the first scan is the baseline: what was already so at launch is not news", () => {
    resetSeen(NOW);
    const s = sessionOf({ sid: "a", status: "idle", job: blocked, mains: [tailOf([reply(NOW - 3 * MIN, "Done."), toolCall(NOW - 2 * MIN)])], agents: [agentOf("s1", thread(5), { done: true })], workflows: [wfOf("completed", [], NOW - 4 * MIN)] });
    F.noteScan([s], NOW, noJobs);
    expect(F.seen.events).toEqual([]);
    expect(F.newCount()).toBe(0);
    expect(F.digest().groups).toEqual([]);
    F.noteScan([s], NOW + 2000, noJobs); // nothing changed
    expect(F.seen.events).toEqual([]);
  });

  test("successive scans turn changes into events: asked, agents done, a workflow done, one failed, replies", () => {
    resetSeen(NOW);
    const main = tailOf([prompt(NOW - 29 * MIN, "go"), reply(NOW - 3 * MIN, "Started.")]);
    const agents = ["w1", "w2", "w3"].map((id) => agentOf(id, thread(1), { wf: "wf_1" }));
    const solo = agentOf("s1", thread(1));
    const s = sessionOf({ sid: "b", mains: [main], agents: [solo], workflows: [wfOf("running", agents), { ...wfOf("running", []), id: "wf_2" }] });
    F.noteScan([s], NOW, noJobs);
    expect(F.seen.events).toEqual([]);

    // Two seconds later: three agents have finished, both workflows have ended, Claude has replied twice and now asks a question.
    const later = NOW + 2000;
    for (const a of [agents[0], agents[1], solo]) a.done = true;
    s.workflows[0].status = "completed";
    s.workflows[1].status = "failed";
    F.ingest(main, JSON.stringify(reply(NOW + 500, "Two of the three share a cause.")));
    F.ingest(main, JSON.stringify(reply(NOW + 900, "Fixed.")));
    F.ingest(main, JSON.stringify(toolCall(NOW + 1000, "AskUserQuestion", { questions: [{ question: "Merge it?" }] })));
    F.noteScan([s], later, noJobs);
    expect(kinds().sort()).toEqual(["agentDone", "agentDone", "agentDone", "asked", "failed", "reply", "reply", "workflowDone"]);
    expect(F.seen.events.every((e) => e.t > NOW && e.t <= later && e.sid === "b")).toBe(true);
    expect(F.seen.events.filter((e) => e.kind === "reply").map((e) => e.t)).toEqual([NOW + 500, NOW + 900]); // a reply keeps its own time
    expect(F.newCount()).toBe(8);

    F.noteScan([s], later + 2000, noJobs); // the same picture again adds nothing
    expect(F.newCount()).toBe(8);

    const d = F.digest();
    expect(d.since).toBe(NOW);
    expect(d.groups.map((g) => `${g.glyph} ${g.text}`)).toEqual(["▲ 1 asked", "✗ 1 failed", "✓ 1 workflow done", "✓ 3 agents done", "◆ 2 new replies"]);
    expect(d.groups.map((g) => g.kind)).toEqual(["asked", "failed", "finished", "finished", "replies"]);
    expect(d.groups.map((g) => g.color)).toEqual([F.C.amber, F.C.red, F.C.green, F.C.green, F.C.cyan]);

    F.markSeen(later + 3000); // space: seen it
    expect([F.newCount(), F.digest().groups.length]).toEqual([0, 0]);
    F.noteScan([s], later + 4000, noJobs); // and what was already known does not come back
    expect(F.newCount()).toBe(0);
    F.ingest(main, JSON.stringify(reply(later + 5000, "One more thing.")));
    F.noteScan([s], later + 6000, noJobs);
    expect(F.digest().groups.map((g) => g.text)).toEqual(["1 new reply"]);
  });

  test("a stall, a session that finishes, and a job that exits between scans", () => {
    resetSeen(NOW);
    const procs = { procs: F.machine.procs, kids: F.machine.kids };
    F.machine.procs = [{ pid: 77, ppid: 1, cpu: 0.1, rss: 1, name: "claude" }];
    F.machine.kids = new Map();
    try {
      const stuck = sessionOf({ sid: "b", pid: 77, mains: [thread(1)], agents: [agentOf("review", thread(9.5))] });
      const job = sessionOf({ sid: "j", status: "idle", jobId: "job7", job: { state: "working", detail: "", needs: "" }, mains: [thread(1)] });
      const gone = sessionOf({ sid: "g", status: "idle", jobId: "job8", job: { state: "working", detail: "", needs: "" }, mains: [thread(1)] });
      const crash = sessionOf({ sid: "c", status: "idle", jobId: "job9", job: { state: "working", detail: "", needs: "" }, mains: [thread(1)] });
      F.noteScan([stuck, job, gone, crash], NOW, noJobs);
      expect(F.seen.events).toEqual([]);
      // A minute later the agent has been silent for 10.5 minutes; one job says it is done; two sessions have exited.
      job.job!.state = "done";
      F.noteScan([stuck, job], NOW + MIN, (id) => ({ job8: "done", job9: "failed" })[id]);
      expect(kinds().sort()).toEqual(["failed", "sessionDone", "sessionDone", "stalled"]);
      expect(F.seen.events.find((e) => e.kind === "stalled")).toMatchObject({ sid: "b", key: "stall:b/review", t: NOW + 30_000 }); // when it crossed ten minutes
      expect(F.digest().groups.map((g) => `${g.glyph} ${g.text}`)).toEqual(["✗ 1 failed", "◐ 1 stalled", "✓ 2 sessions done"]);
      F.noteScan([stuck, job], NOW + 2 * MIN, (id) => ({ job8: "done", job9: "failed" })[id]);
      expect(F.newCount()).toBe(4); // each is reported once
    } finally {
      Object.assign(F.machine, procs);
    }
  });

  test("with the mark in the past, the first scan dates things by their own timestamps", () => {
    resetSeen(NOW - 18 * MIN); // as FLEET_SEEN does for a screenshot
    const main = tailOf([reply(NOW - 25 * MIN, "Old."), reply(NOW - 7 * MIN, "Newer."), reply(NOW - 2 * MIN, "Newest.")]);
    const s = sessionOf({ sid: "a", status: "idle", job: blocked, mains: [main], agents: [agentOf("old", thread(25), { done: true }), agentOf("new", thread(9), { done: true }), agentOf("busy", thread(1))] });
    F.noteScan([s], NOW, noJobs);
    expect(kinds().sort()).toEqual(["agentDone", "asked", "reply", "reply"]);
    expect(main.says.map((x) => F.isNew(x.t))).toEqual([false, true, true]);
    expect(F.digest().groups.map((g) => g.text)).toEqual(["1 asked", "1 agent done", "2 new replies"]);
  });

  test("the digest keeps the design's order and wording", () => {
    const ev = (kind: F.EventKind, n: number): F.FleetEvent[] => Array.from({ length: n }, (_, i) => ({ kind, t: NOW + i, sid: "x", key: `${kind}${i}` }));
    const all = [...ev("reply", 4), ...ev("agentDone", 3), ...ev("asked", 1), ...ev("stalled", 2), ...ev("failed", 1), ...ev("workflowDone", 2), ...ev("sessionDone", 1)];
    const d = F.digest(all, NOW - 47 * MIN);
    expect(d.groups.map((g) => `${g.glyph} ${g.text}`)).toEqual(["▲ 1 asked", "✗ 1 failed", "◐ 2 stalled", "✓ 1 session done", "✓ 2 workflows done", "✓ 3 agents done", "◆ 4 new replies"]);
    expect(d.groups.reduce((n, g) => n + g.count, 0)).toBe(all.length);
    expect(F.digest([...ev("asked", 1), ...ev("agentDone", 3), ...ev("reply", 4)], NOW).groups.map((g) => `${g.glyph} ${g.text}`).join("  ·  ")).toBe("▲ 1 asked  ·  ✓ 3 agents done  ·  ◆ 4 new replies");
  });

  test("the mark's place on the time axis", () => {
    const win = F.timeWindow(NOW, 30 * MIN, 30);
    resetSeen(NOW - 18 * MIN);
    expect(F.seenCell(win)).toBe(F.barOf(NOW - 18 * MIN, win));
    expect(F.seenCell(win)).toBeGreaterThanOrEqual(11);
    expect(F.seenCell(win)).toBeLessThanOrEqual(12);
    resetSeen(NOW);
    expect(F.seenCell(win)).toBe(29); // just looked: the bar still filling
    resetSeen(NOW - 47 * MIN);
    expect(F.seenCell(win)).toBeUndefined(); // before the window
  });

  test("fleet counts put every session in exactly one tile", () => {
    const busy = (sid: string, o: Partial<F.Session> = {}) => sessionOf({ sid, mains: [thread(0.2)], ...o });
    const running = wfOf("running", [agentOf("w1", thread(0.2), { wf: "wf_1" }), agentOf("w2", thread(0.2), { wf: "wf_1", done: true })]);
    const sessions = [
      sessionOf({ sid: "asks", status: "idle", job: blocked, mains: [thread(6)] }),
      busy("flaky", { workflows: [running], agents: [agentOf("s1", thread(0.5)), agentOf("old", thread(45))] }),
      busy("docs"),
      sessionOf({ sid: "done", status: "idle", job: { state: "done", detail: "merged", needs: "" }, mains: [thread(50)] }),
      sessionOf({ sid: "turn", status: "idle", mains: [tailOf([prompt(NOW - 9 * MIN, "hi"), reply(NOW - 8 * MIN, "Hello.")])] }),
      sessionOf({ sid: "idle-with-agent", status: "idle", agents: [agentOf("s2", thread(1))] }),
    ];
    const c = F.fleetCounts(sessions, NOW);
    expect(c).toEqual({ sessions: 6, needs: 1, stalled: 0, working: 3, idle: 2, agents: 3, workflows: 1 });
    expect(c.needs + c.stalled + c.working + c.idle).toBe(c.sessions);
    const views = F.buildViews(sessions, NOW);
    expect(views.filter(F.isHidden).map((v) => v.s.sid).sort()).toEqual(["done", "turn"]);
  });

  test("the terminal title is the fleet's state in the screen's glyphs, written only when it changes", () => {
    expect(F.titleFor({ needs: 1, stalled: 0, working: 2, workflows: 1 })).toBe("▲1 ●2 ≡1 Claude Fleet");
    expect(F.titleFor({ needs: 0, stalled: 1, working: 12, workflows: 0 })).toBe("◐1 ●12 Claude Fleet");
    expect(F.titleFor({ needs: 0, stalled: 0, working: 0, workflows: 0 })).toBe("Claude Fleet");
    expect(F.titleSequence("▲1 Claude Fleet")).toBe("\x1b]2;▲1 Claude Fleet\x07");
    expect(F.titleSequence("")).toBe("\x1b]2;\x07"); // cleared on exit
    expect(F.titleChange("▲1 ●2 ≡1 Claude Fleet")).toBe("\x1b]2;▲1 ●2 ≡1 Claude Fleet\x07");
    expect(F.titleChange("▲1 ●2 ≡1 Claude Fleet")).toBe(""); // unchanged: nothing is written
    expect(F.titleChange("●3 ≡1 Claude Fleet")).toBe("\x1b]2;●3 ≡1 Claude Fleet\x07");
  });

  test("the buttons carry the hidden count and the count of new things", () => {
    resetSeen(NOW);
    expect(strip(F.buttonBar(150, 44, 1))).toContain(" a All · 1 idle ");
    expect(strip(F.buttonBar(150, 44, 0))).toContain(" a All ");
    expect(strip(F.buttonBar(150, 44))).toContain(" space Seen ");
    F.seen.events.push(...Array.from({ length: 4 }, (_, i) => ({ kind: "reply" as F.EventKind, t: NOW + i, sid: "a", key: "k" })));
    expect(strip(F.buttonBar(150, 44, 1))).toContain(" space Seen · 4 new ");
    expect(strip(F.buttonBar(150, 44, 1))).not.toContain("Retry usage"); // only while a usage read is failing
    for (const W of [80, 100, 110, 130, 150, 200]) expect(F.cells(F.buttonBar(W, 44, 3))).toBeLessThanOrEqual(W);
    resetSeen(NOW);
  });
});

describe("header and chrome", () => {
  // The design's frames show the design's clock and reset times (23:51:22 on Tue 13 Oct, "resets Fri 09:00"), which
  // NOW and the fixtures are only in UTC. These tests are held to UTC whatever zone the suite was started in, and the zone is then put back.
  const zone = process.env.TZ;
  beforeAll(() => void (process.env.TZ = "UTC"));
  afterAll(() => void (process.env.TZ = zone ?? "UTC")); // with no zone given, bun test itself runs in UTC
  const WINDOW = 30 * MIN;
  const SIZES: [number, number][] = [[80, 24], [100, 30], [110, 44], [130, 40], [150, 34], [150, 44], [200, 60]];
  /** The design's made-up machine: 54% CPU, 38% of 128G, sixteen cores, three busy processes. Process 4243 is an idle session's. */
  const MACHINE = {
    cpu: 54, load: 14.6, memTotal: 128 * 1024 ** 3, memUsed: 0.38 * 128 * 1024 ** 3,
    cores: [58, 62, 49, 44, 37, 33, 30, 35, 41, 47, 66, 70, 72, 69, 81, 84],
    hist: [6, 7, 8, 8, 8, 9, 10, 14, 16, 22, 24, 20, 26, 33, 41, 44, 38, 43, 52, 55, 47, 54, 63, 54],
    procs: [{ pid: 1, ppid: 0, cpu: 212, rss: 0, name: "bun" }, { pid: 2, ppid: 0, cpu: 88, rss: 0, name: "node" }, { pid: 3, ppid: 0, cpu: 41, rss: 0, name: "tsc" }, { pid: 4243, ppid: 0, cpu: 0.2, rss: 1000, name: "claude" }],
    kids: new Map<number, F.Proc[]>(),
  };
  /** Tool calls a minute across the lane, as the design's fleet chart draws them (372 in all, 286 in the last twenty). */
  const FLEET = [6, 9, 7, 11, 0, 8, 12, 14, 10, 9, 13, 16, 12, 8, 5, 3, 6, 9, 13, 17, 15, 12, 16, 19, 22, 18, 21, 24, 20, 17];
  /** A thread that wrote five seconds ago and has made no tool call, so it adds nothing to the chart. */
  const live = () => Object.assign(tailOf([]), { mtime: NOW - 5_000 });
  /**
   * The design's fleet: one session needs you, two are working with `agents` agents and one workflow
   * between them, and one finished job is kept off the screen. `stalled` leaves one agent silent on a
   * tool call for 14 minutes in a session whose processes are idle.
   */
  function fleet(laneW = 30, o: { agents?: number; stalled?: boolean } = {}): F.Session[] {
    const win = F.timeWindow(NOW, WINDOW, laneW);
    const calls = FLEET.slice(-laneW).flatMap((n, k) => Array.from({ length: n }, (_, i) => toolCall(win.start + k * win.bar + 1000 + i, "Read", {}, `c${k}-${i}`)));
    const wf: F.Workflow = { id: "wf_1", name: "bisect-and-fix", status: "running", phase: "Fix", phases: [], seen: ["Fix"], started: NOW - 14 * MIN, finished: 0, agents: ["w3", "w4", "w5"].map((id) => agentOf(id, live(), { wf: "wf_1" })), lastT: NOW - 5_000 };
    const solo = Array.from({ length: (o.agents ?? 5) - 3 }, (_, i) => agentOf(`s${i}`, o.stalled && i === 0 ? tailOf([toolCall(NOW - 14 * MIN)]) : live()));
    return [
      sessionOf({ sid: "aaaaaaaa", status: "idle", job: { state: "blocked", detail: "", needs: "Approve dropping the column?" } }),
      sessionOf({ sid: "bbbbbbbb", mains: [tailOf(calls)], workflows: [wf] }),
      sessionOf({ sid: "cccccccc", pid: 4243, mains: [live()], agents: solo }),
      sessionOf({ sid: "dddddddd", status: "idle", job: { state: "done", detail: "merged", needs: "" } }),
    ];
  }
  /** The design's account: 38% of the 5-hour limit with 2h10 to go, 21% of the week resetting on Friday at 09:00, £12 of £50 extra. */
  const figures = (five = 38, resetsIn = 130 * MIN): F.UsageFigures => ({
    five_hour: { utilization: five, resets_at: iso(NOW + resetsIn) },
    seven_day: { utilization: 21, resets_at: iso(Date.UTC(2026, 9, 16, 9, 0, 0)) },
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1200, currency: "GBP", decimal_places: 2 },
  });
  const week = (pct: number): F.UsageWindow => ({ utilization: pct, resets_at: iso(Date.UTC(2026, 9, 16, 9, 0, 0)) });
  /** Every state the account block can be in. `false` is a dashboard started without --usage. */
  const ACCOUNT: Record<string, Partial<typeof F.usage> | false> = {
    current: { data: figures(), fetchedAt: NOW },
    early: { data: figures(86, 85 * MIN), fetchedAt: NOW }, // 86% with 1h25 to go: full in about 35 minutes
    extraOff: { data: { ...figures(), extra_usage: { is_enabled: false } }, fetchedAt: NOW },
    modelWeeks: { data: { ...figures(), extra_usage: { is_enabled: false }, seven_day_opus: week(12), seven_day_sonnet: week(4) }, fetchedAt: NOW },
    sonnetWeek: { data: { ...figures(), extra_usage: { is_enabled: false }, seven_day_sonnet: week(64) }, fetchedAt: NOW },
    shared: { data: figures(), fetchedAt: NOW - 3 * MIN, reason: F.REASON.keychainRemote, source: "shared" }, // our read fails, another dashboard's figures are fresh
    stale: { data: figures(), fetchedAt: NOW - 39 * MIN - 22_000, reason: "Anthropic answered 429" }, // fetched at 23:12
    staleRemote: { data: figures(), fetchedAt: NOW - 39 * MIN - 22_000, reason: F.REASON.keychainRemote },
    none: { reason: "keychain: no answer in 5s" },
    remote: { reason: F.REASON.keychainRemote },
    reading: { busy: true, nextTry: 0 },
    off: false,
  };
  /** Draw on the design's machine with one of those accounts and nothing new since you looked, then put every global back. */
  function draw<T>(account: string, fn: () => T, o: { mode?: F.Mode; all?: boolean; windowMin?: number } = {}): T {
    const saved = { opt: { ...F.opt }, machine: { ...F.machine }, usage: { ...F.usage }, seen: { ...F.seen } };
    const u = ACCOUNT[account];
    Object.assign(F.machine, MACHINE);
    Object.assign(F.opt, { mode: o.mode ?? "detail", usage: u !== false, windowMin: o.windowMin ?? 30, showAll: !!o.all, showDone: false });
    Object.assign(F.usage, { at: NOW, nextTry: NOW + 5 * MIN, busy: false, failures: 0, reason: "", data: undefined, fetchedAt: 0, source: "", sharedAt: 0 }, u || {});
    Object.assign(F.seen, { at: NOW, events: [], known: new Map(), primed: true });
    try {
      return fn();
    } finally {
      Object.assign(F.opt, saved.opt);
      Object.assign(F.machine, saved.machine);
      Object.assign(F.usage, saved.usage);
      Object.assign(F.seen, saved.seen);
    }
  }
  const raw = (W: number, rows: number, account = "current", sessions = fleet(F.grid(W).laneW), o: Parameters<typeof draw>[2] = {}) => draw(account, () => F.header(sessions, W, rows, NOW), o);
  const head = (...args: Parameters<typeof raw>) => raw(...args).map(strip);
  /** The account block's three rows, by its own columns. */
  const block = (W: number, account: string) => {
    const g = F.grid(W);
    return head(W, 44, account).slice(1, 4).map((line) => line.padEnd(W).slice(g.account - 1, g.accountEnd).trimEnd());
  };

  // The designer's own frames (reference/header_*.txt), with the totals this fleet adds up to.
  const TALL_150 = [
    " ◆ CLAUDE FLEET     ▲ 1 needs you    ● 2 working    ⠋ 5 agents    ≡ 1 workflow    ○ 1 idle                                       Tue 13 Oct  23:51:22",
    " cpu  ━━━━━━──────  54%  ▁▁▁▂▂▂▂▂▃▃▄▄▄▄▅▅▄▅▆▅  load 14.6    5h    ━━━━━─┼─────  38%  resets in 2h10                          ▁   ▃▆▂▅█▄▁    372 tools",
    " mem  ━━━━━───────  38%  49G of 128G                        7d    ━━━────┼────  21%  resets Fri 09:00      ▁ ▃  ▄▆▂▁▅█▄    ▁▅█▇▄████████      37k out",
    " core ▅▅▄▄▃▃▃▃▄▄▆▆▆▆▇▇   top bun 212% · node 88%            extra ━━━─────────  24%  £12 of £50           ▆█▇█▁█████████▅▃▆█████████████     1m a bar",
    " ──────────────────────────────────────────────────────────────────────────────────────────────────────── 30m ──────┴─────────┴───── now ────────────",
  ];
  const MEDIUM_150 = [
    TALL_150[0],
    " cpu ━━━━────  54%   mem ━━━─────  38%   load 14.6    5h ━━━─┼───  38% 2h10   7d ━━───┼──  21% Fri 09:00  ▂▃▃▄▁▃▄▅▄▃▅▆▄▃▂▁▂▃▅▆▅▄▆▇█▆▇█▇▆    372 tools",
    TALL_150[4],
  ];
  const TALL_110 = [
    " ◆ CLAUDE FLEET   ▲ 1 needs you    ● 2 working    ⠋ 5 agents    ≡ 1 workflow    ○ 1 idle             23:51:22",
    " cpu  ━━━━────  54%  ▃▃▄▄▄▄▅▅▄▅▆▅        5h    ━━━─┼───  38%  2h10 left                 ▁   ▃▆▂▅█▄▁ 286 tools",
    " mem  ━━━─────  38%  49G of 128G         7d    ━━───┼──  21%  Fri 09:00        ▅█▄    ▁▅█▇▄████████   29k out",
    " core ▅▅▄▄▃▃▃▃▄▄▆▆▆▆▇▇  load 14.6        extra ━━──────  24%  £12 of £50       ████▅▃▆█████████████ 90s a bar",
    " ───────────────────────────────────────────────────────────────────────────── 30m ──┴─────┴─── now ─────────",
  ];
  const MEDIUM_110 = [
    TALL_110[0],
    " cpu ━━━━────  54%   mem ━━━─────  38%   5h ━━━─┼───  38%   7d ━━───┼──  21%   ▅▆▄▃▂▁▂▃▅▆▅▄▆▇█▆▇█▇▆ 286 tools",
    TALL_110[4],
  ];

  test("five rows from 40 terminal rows, three below; compact mode and under 100 columns keep the older header", () => {
    expect([F.headerKind(150, 40, "detail"), F.headerKind(150, 39, "detail"), F.headerKind(150, 44, "far"), F.headerKind(110, 30, "far")]).toEqual(["tall", "medium", "tall", "medium"]);
    expect([F.headerKind(150, 44, "compact"), F.headerKind(99, 60, "detail"), F.headerKind(100, 60, "detail")]).toEqual(["old", "old", "tall"]);
    expect([head(150, 44).length, head(150, 34).length, head(110, 44).length, head(110, 30).length]).toEqual([5, 3, 5, 3]);
    // The height follows the terminal's rows, never the number of sessions, so the header does not jump.
    expect([head(150, 44, "current", []).length, head(150, 44, "current", [...fleet(), ...fleet(), ...fleet()]).length]).toEqual([5, 5]);
    // Compact: the older lines, with ▲ where ⚠ was and amber spent on that alone.
    const compact = raw(150, 44, "current", fleet(), { mode: "compact" });
    expect(compact.length).toBe(4); // fleet line, machine line, account line, rule
    expect(strip(compact[0])).toContain("▲ 1 needs you · 3 active sessions · 5 agents running · 1 work…");
    expect(compact[0]).toContain(F.bold(F.fg(F.C.amber, "▲ 1 needs you")));
    expect(compact.join("")).not.toContain("⚠");
    expect(strip(head(90, 44).join("\n"))).toContain("active sessions"); // under 100 columns, whatever the mode
  });

  test("at 150 columns the header is the design's, cell for cell: tall and medium", () => {
    expect(head(150, 44)).toEqual(TALL_150);
    expect(head(150, 34)).toEqual(MEDIUM_150);
    expect(draw("current", () => F.render(fleet(), 150, 44, NOW).slice(0, 5).map(strip), { mode: "far" })).toEqual(TALL_150); // far mode takes the same header
  });

  test("at 110 columns: narrow blocks, a 20-cell lane, shorter reset times, no date and no top processes", () => {
    expect(head(110, 44)).toEqual(TALL_110);
    expect(head(110, 34)).toEqual(MEDIUM_110);
  });

  test("masthead: tiles sit in fixed slots, a zero goes dim instead of leaving, and the stalled tile is added only while something is stalled", () => {
    const columns = (line: string) => ["▲", "●", "⠋", "≡", "○"].map((g) => line.indexOf(g) + 1);
    expect(columns(head(150, 44)[0])).toEqual([21, 38, 53, 67, 83]);
    expect(columns(head(110, 44)[0])).toEqual([19, 36, 51, 65, 81]);
    // A count going from 9 to 10 moves nothing.
    const nine = head(150, 44, "current", fleet(30, { agents: 9 }))[0];
    const ten = head(150, 44, "current", fleet(30, { agents: 10 }))[0];
    expect([nine.slice(52, 63), ten.slice(52, 63)]).toEqual(["⠋ 9 agents ", "⠋ 10 agents"]);
    expect(ten.slice(63)).toBe(nine.slice(63));
    // The needs-you tile is the one warm thing: bold amber on the amber tint, columns 20 to 34.
    expect(raw(150, 44)[0]).toContain(`\x1b[48;2;52;38;0m${F.bold(F.fg(F.C.amber, " ▲ 1 needs you "))}\x1b[49m`);
    // Nothing anywhere: the slot reads "none waiting" in receded green, and every zero is dim, the agents' spinner a ○.
    const empty = raw(150, 44, "current", []);
    expect(strip(empty[0])).toBe(" ◆ CLAUDE FLEET     ✓ none waiting   ● 0 working    ○ 0 agents    ≡ 0 workflows   ○ 0 idle                                       Tue 13 Oct  23:51:22");
    expect(empty[0]).toContain(F.fg(F.C.done, "✓ none waiting"));
    expect(empty[0]).toContain(F.fg(F.C.dim, "● 0 working"));
    expect(empty[0]).not.toContain("\x1b[48;2;"); // no tint
    // Stall watch: a red tile at column 95, and the stalled session is no longer counted as working.
    const stalled = raw(150, 44, "current", fleet(30, { stalled: true }));
    expect(strip(stalled[0])).toBe(" ◆ CLAUDE FLEET     ▲ 1 needs you    ● 1 working    ⠋ 5 agents    ≡ 1 workflow    ○ 1 idle    ◐ 1 stalled?                       Tue 13 Oct  23:51:22");
    expect(strip(stalled[0]).indexOf("◐") + 1).toBe(95);
    expect(stalled[0]).toContain(F.fg(F.C.red, "◐") + F.bold(F.fg(F.C.red, " 1")) + F.fg(F.C.red, " stalled?"));
    expect(head(150, 44)[0]).not.toContain("stalled");
    // Where they do not all fit, the stalled tile outranks the date, then the idle tile, then workflows.
    expect(head(130, 44, "current", fleet(30, { stalled: true }))[0]).toBe(" ◆ CLAUDE FLEET     ▲ 1 needs you    ● 1 working    ⠋ 5 agents    ≡ 1 workflow    ○ 1 idle    ◐ 1 stalled?               23:51:22");
    expect(head(110, 44, "current", fleet(20, { stalled: true }))[0]).toBe(" ◆ CLAUDE FLEET   ▲ 1 needs you    ● 1 working    ⠋ 5 agents    ≡ 1 workflow    ◐ 1 stalled?         23:51:22");
    expect(head(100, 44, "current", fleet(20, { stalled: true }))[0]).toBe(" ◆ CLAUDE FLEET   ▲ 1 needs you    ● 1 working    ⠋ 5 agents    ◐ 1 stalled?               23:51:22");
  });

  test("the account block shows every state exactly, on the design's columns", () => {
    expect(block(150, "current")).toEqual(["5h    ━━━━━─┼─────  38%  resets in 2h10", "7d    ━━━────┼────  21%  resets Fri 09:00", "extra ━━━─────────  24%  £12 of £50"]);
    // No reading yet: ╌ gauges, when the next try is, and the exact reason.
    expect(block(150, "none")).toEqual(["5h    ╌╌╌╌╌╌╌╌╌╌╌╌   --  no reading yet", "7d    ╌╌╌╌╌╌╌╌╌╌╌╌   --  next try 23:56", "✗ keychain: no answer in 5s · u retries"]);
    expect(block(150, "reading")).toEqual(["5h    ╌╌╌╌╌╌╌╌╌╌╌╌   --  no reading yet", "7d    ╌╌╌╌╌╌╌╌╌╌╌╌   --  reading now", ""]);
    // Stale: the figures stay, over the time they date from and the reason.
    expect(block(150, "stale")).toEqual(["5h    ━━━━━─┼─────  38%  resets in 2h10", "7d    ━━━────┼────  21%  resets Fri 09:00", "✗ as of 23:12 · Anthropic answered 429"]);
    // Without --usage: the busiest processes on the same columns, one full core to a full gauge, and the machine's third row counts cores instead.
    expect(block(150, "off")).toEqual(["top   ━━━━━━━━━━━━ 212%  bun", "      ━━━━━━━━━━━─  88%  node", "      ━━━━━───────  41%  tsc"]);
    expect(head(150, 44, "off")[3].slice(0, 57).trimEnd()).toBe(" core ▅▅▄▄▃▃▃▃▄▄▆▆▆▆▇▇   16 cores");
    // Extra usage off: the Opus and Sonnet weeks take the third row, but only when Anthropic returned them.
    expect(block(150, "extraOff")[2]).toBe("extra off");
    expect(block(150, "modelWeeks")[2]).toBe("opus  ━──────┼────  12%  sonnet 4%");
    expect(block(150, "sonnetWeek")[2]).toBe("sonn… ━━━━━━━┿────  64%  resets Fri 09:00");
    // 110 columns: the same block on narrower columns, with reasons cut rather than spilling under the lane.
    expect(block(110, "none")).toEqual(["5h    ╌╌╌╌╌╌╌╌   --  no reading yet", "7d    ╌╌╌╌╌╌╌╌   --  next try 23:56", "✗ keychain: no answer in 5s"]);
    expect(block(110, "stale")[2]).toBe("✗ 23:12 · Anthropic answered 429"); // the status is worth more than the words "as of"
    expect(block(110, "off")).toEqual(["top   ━━━━━━━━ 212%  bun", "      ━━━━━━━─  88%  node", "      ━━━─────  41%  tsc"]);
  });

  test("stale figures are drawn dim, a limit from 60% is bold white and from 80% red, and CPU never turns warm", () => {
    const stale = raw(150, 44, "stale");
    expect(stale[1]).toContain(F.fg(F.C.dim, "━━━━━") + F.fg(F.C.faint, "─") + F.fg(F.C.dim, "┼") + F.fg(F.C.faint, "─────")); // the fill and the tick recede
    expect(stale[1]).toContain(F.fg(F.C.dim, "38%"));
    expect(stale[3]).toContain(F.fg(F.C.red, "✗ ") + F.fg(F.C.dim, "as of 23:12 · Anthropic answered 429"));
    const early = raw(150, 44, "early");
    expect(early[1]).toContain(F.fg(F.C.red, "━━━━━━━━") + F.fg(F.C.white, "┿") + F.fg(F.C.red, "━") + F.fg(F.C.faint, "──"));
    expect(early[1]).toContain(F.bold(F.fg(F.C.red, "86%")));
    expect(raw(150, 44, "sonnetWeek")[3]).toContain(F.bold(F.fg(F.C.white, "64%")));
    expect(raw(150, 44)[1]).toContain(F.fg(F.C.calm, "━━━━━") + F.fg(F.C.faint, "─") + F.fg(F.C.white, "┼")); // 38%: calm, with a white tick
    // The machine at 100% CPU: still the cool ramp. Memory at 85% is a limit, and red.
    const hot = draw("current", () => {
      Object.assign(F.machine, { cpu: 100, cores: MACHINE.cores.map(() => 100), hist: MACHINE.hist.map(() => 100), memUsed: 0.85 * MACHINE.memTotal });
      return F.header(fleet(), 150, 44, NOW);
    });
    for (const warm of [F.C.amber, F.C.red]) expect(hot[1]).not.toContain(F.fg(warm, "━").slice(0, -5));
    expect(hot[1]).toContain(F.fg(F.coolTone(0.75), "━".repeat(12)));
    expect(hot[2]).toContain(F.fg(F.C.red, "━".repeat(10)));
    expect(hot[2]).toContain(F.bold(F.fg(F.C.red, "85%")));
  });

  test("the core strip is one glyph a core, and past 18 cores neighbours are averaged so it keeps to its columns", () => {
    const strip18 = (cores: number[], W = 150) =>
      draw("off", () => {
        F.machine.cores = cores;
        return strip(F.header(fleet(F.grid(W).laneW), W, 44, NOW)[3]).slice(6, 26).trimEnd();
      });
    expect(strip18(MACHINE.cores)).toBe("▅▅▄▄▃▃▃▃▄▄▆▆▆▆▇▇   1"); // sixteen cores from column 7, then the detail at column 26
    expect(strip18(Array.from({ length: 18 }, () => 50))).toBe("▅".repeat(18) + " 1"); // eighteen still fit, one cell short of the detail
    expect(strip18(Array.from({ length: 24 }, (_, i) => (i % 2 ? 100 : 0)))).toBe("▅".repeat(12) + "       2"); // pairs: 0 and 100 average to 50
    expect(strip18(Array.from({ length: 64 }, () => 100)).replace(/ .*/, "")).toBe("█".repeat(16)); // fours
    expect(strip18(Array.from({ length: 19 }, () => 0)).replace(/ .*/, "")).toBe("▁".repeat(10));
    // Narrow: load follows the strip, two cells on, wherever the strip ends.
    expect(strip18(Array.from({ length: 18 }, () => 50), 110)).toBe("▅".repeat(18));
    expect(draw("off", () => ((F.machine.cores = Array.from({ length: 18 }, () => 50)), strip(F.header(fleet(20), 110, 44, NOW)[3]).slice(0, 38)))).toBe(" core " + "▅".repeat(18) + "  load 14.6   ");
  });

  test("runway in the header: pace ticks on the 5h and 7d gauges, and 'full in' in bold red when the limit fills before it resets", () => {
    expect(strip(F.limitGauge(38, 12, 170 / 300))).toBe("━━━━━─┼─────"); // 2h50 of 5 hours gone, 38% used: under pace, ┼ on the track
    expect(strip(F.limitGauge(86, 12, 215 / 300))).toBe("━━━━━━━━┿━──"); // the fill has passed the tick: ┿
    expect(strip(F.limitGauge(38, 12))).toBe("━━━━━───────"); // no tick without a reset time
    expect(strip(F.limitGauge(undefined, 12))).toBe("╌".repeat(12));
    expect(strip(F.limitGauge(0, 8, 0))).toBe("┼───────");
    expect(strip(F.limitGauge(100, 8, 1))).toBe("━━━━━━━┿");
    for (const w of [6, 8, 12, 16]) for (const pct of [0, 1, 50, 99, 100, 140]) expect(F.cells(F.limitGauge(pct, w, 0.5))).toBe(w);
    expect(block(150, "early")).toEqual(["5h    ━━━━━━━━┿━──  86%  full in ~35m", "7d    ━━━────┼────  21%  resets Fri 09:00", "extra ━━━─────────  24%  £12 of £50"]);
    expect(raw(150, 44, "early")[1]).toContain(F.bold(F.fg(F.C.red, "full in ~35m")));
    expect(block(110, "early")[0]).toBe("5h    ━━━━━┿━─  86%  full in ~35m");
    expect(head(150, 34, "early")[1]).toContain("load 14.6    5h ━━━━━┿━─  86% full ~35m   7d ━━───┼──  21%  "); // the forecast says what it is; the week's reset time gives way
    expect(block(150, "stale")[0]).not.toContain("full in"); // no forecast from stale figures
  });

  test("the usage read that fails with a remedy gets one dim line under the blocks, and the chart grows a row to stay on its axis", () => {
    const remote = head(150, 44, "remote");
    expect(remote.length).toBe(6);
    expect(remote.slice(1, 4).map((l) => l.slice(60, 104).trimEnd())).toEqual(["5h    ╌╌╌╌╌╌╌╌╌╌╌╌   --  no reading yet", "7d    ╌╌╌╌╌╌╌╌╌╌╌╌   --  next try 23:56", "✗ keychain: closed over ssh/mosh · u retries"]);
    expect(remote[4].slice(0, 104).trimEnd()).toBe(" run: security unlock-keychain ~/Library/Keychains/login.keychain-db · or use a tmux started on the Mac");
    expect(remote[4].slice(106, 136)).toMatch(/^[▁▂▃▄▅▆▇█]{30}$/); // the chart's bottom row, directly above the axis
    expect(remote[5]).toBe(TALL_150[4]);
    expect(raw(150, 44, "remote")[4]).toContain(F.fg(F.C.dim, "run: security unlock-keychain ~/Library/Keychains/login.keychain-db · or use a tmux started on the Mac"));
    // The line is there for as long as the reason is: with stale figures, and with fresh ones another reader fetched.
    // (Those come and go as that reader does, and the header must not change height each time.)
    expect(head(150, 44, "staleRemote").length).toBe(6);
    expect(block(150, "staleRemote")[2]).toBe("✗ 23:12 · keychain: closed over ssh/mosh");
    const shared = head(150, 44, "shared");
    expect(shared.length).toBe(6);
    expect(block(150, "shared")).toEqual(block(150, "current")); // the figures are current, so the block shows them as usual
    // …and the line under it says whose they are and why, not a command you have chosen not to run.
    expect(shared[4].slice(0, 104).trimEnd()).toBe(" shared figures · keychain: closed to remote sessions (ssh/mosh) · u retries");
    // Other reasons have no remedy, so no line.
    expect([head(150, 44, "none").length, head(150, 44, "stale").length]).toEqual([5, 5]);
    // Medium: one more row, with the chart two rows tall. Narrow: the command is the last thing to be cut.
    const medium = head(150, 34, "remote");
    expect(medium.length).toBe(4);
    expect(medium[1]).toContain("load 14.6    ✗ keychain: closed to remote sessions (ssh/mosh)");
    expect(medium[2].slice(0, 104).trimEnd()).toBe(remote[4].slice(0, 104).trimEnd());
    expect(head(110, 44, "remote")[4].slice(0, 77).trimEnd()).toBe(" run: security unlock-keychain ~/Library/Keychains/login.keychain-db");
  });

  test("stale figures are never told by colour alone: a red ✗ and their time, at every width, and the reason somewhere on the header", () => {
    for (let W = 100; W <= 160; W++)
      for (const rows of [36, 44])
        for (const account of ["stale", "staleRemote"]) {
          const lines = head(W, rows, account);
          const text = lines.join("\n");
          const where = `${account} ${W}x${rows}`;
          expect([where, /✗ (as of )?23:12/.test(text)]).toEqual([where, true]);
          if (account === "staleRemote") expect([where, /keychain:? closed/.test(text)]).toEqual([where, true]);
          for (const line of lines) expect([where, F.width(line) <= W]).toEqual([where, true]);
        }
    // The design's frames hold where they fit: the 150-column medium row keeps its gauges and load.
    expect(head(150, 34, "stale")[1]).toContain("load 14.6    5h ━━━─┼───  38%   7d ━━───┼──  21%  ✗ as of 23:12");
    // At 110 there was no room at all: the gauges shorten to make it.
    expect(head(110, 36, "stale")[1]).toMatch(/7d ━+[─┼]+  21%  ✗ 23:12/);
  });

  test("the remote reason is never cut in the tall header; with someone else's current figures, the line under it says so at every size", () => {
    for (let W = 100; W <= 200; W += 2) {
      const text = head(W, 44, "remote").join("\n");
      expect([W, /✗ keychain:? closed (to remote sessions \(ssh\/mosh\)|over ssh\/mosh|over ssh)( ·|  |$)/m.test(text)]).toEqual([W, true]);
      for (const rows of [36, 44]) {
        const shared = head(W, rows, "shared").join("\n");
        expect([W, rows, shared.includes("shared figures · keychain"), shared.includes("unlock-keychain")]).toEqual([W, rows, true, false]);
      }
    }
  });

  test("the three-row header shows the 5-hour forecast at every width, and the 5-hour reset time wherever it fits", () => {
    expect(head(120, 36, "early")[1]).toContain("86% full ~35m");
    expect(head(136, 36, "early")[1]).toContain("86% full ~35m");
    expect(head(110, 36, "early")[1]).toMatch(/86% (full )?~35m/);
    expect(head(100, 30, "early")[1]).toMatch(/86% (full )?~35m/);
    for (let W = 100; W <= 160; W++) expect([W, head(W, 36, "early")[1].includes("~35m")]).toEqual([W, true]);
    expect(head(120, 36)[1]).toContain("38% 2h10   7d ━━───┼──  21%");
    expect(head(110, 36)[1]).toContain("5h ━━━─┼───  38%   7d ━━───┼──  21%   "); // the design's 110-column row, unchanged
  });

  test("the fleet chart: linear against its own peak, in the lane, with its totals and the bar length", () => {
    expect(F.fleetChart(FLEET, 3).map(strip)).toEqual(TALL_150.slice(1, 4).map((l) => l.slice(106, 136)));
    expect(F.fleetChart(FLEET, 1).map(strip)).toEqual([MEDIUM_150[1].slice(106, 136)]);
    // Linear: a bar a quarter of the peak is a quarter of the height (24 levels over three rows), where a square-root sparkline would draw half.
    expect(F.fleetChart([24, 6, 1, 0], 3).map(strip)).toEqual(["█   ", "█   ", "█▆▁▁"]);
    expect(F.fleetChart([24, 6, 1, 0], 3)[2]).toContain(F.fg(F.C.faint, "▁")); // an empty bar is a faint ▁ on the bottom row
    expect(F.fleetChart([0, 0], 2).map(strip)).toEqual(["  ", "▁▁"]);
    for (const [W, laneW] of [[150, 30], [110, 20], [130, 30], [200, 30]]) {
      const g = F.grid(W);
      const rows = head(W, 44);
      expect(g.laneW).toBe(laneW);
      for (const line of rows.slice(1, 4)) expect(line.padEnd(W).slice(g.figEnd - 5, g.figEnd)).toMatch(/tools$| out$| bar$/); // figures end at the figure field's last column
      expect(rows[3].slice(g.lane - 1, g.laneEnd)).toMatch(new RegExp(`^[▁▂▃▄▅▆▇█]{${laneW}}$`));
    }
    // The bar length follows the window: 30 bars at 150 columns, 20 at 110.
    const barOf = (W: number, windowMin: number) => head(W, 44, "current", fleet(F.grid(W).laneW), { windowMin })[3].trimEnd().split(/\s{2,}/).pop();
    expect([5, 15, 30, 60, 180].map((m) => barOf(150, m))).toEqual(["10s a bar", "30s a bar", "1m a bar", "2m a bar", "6m a bar"]);
    expect([5, 15, 30, 60, 180].map((m) => barOf(110, m)?.trim().split(" ").slice(-3).join(" "))).toEqual(["15s a bar", "45s a bar", "90s a bar", "3m a bar", "9m a bar"]);
  });

  test("the rule is the time axis: the window, a tick at each third, now; the mark for when you last looked; the digest of what is new", () => {
    const ev = (kind: F.EventKind, n: number): F.FleetEvent[] => Array.from({ length: n }, (_, i) => ({ kind, t: NOW - i, sid: "a", key: `${kind}${i}` }));
    const axis = (W: number, seenAt: number, events: F.FleetEvent[] = [], windowMin = 30) =>
      draw("current", () => {
        Object.assign(F.seen, { at: seenAt, events });
        return strip(F.header(fleet(F.grid(W).laneW), W, 44, NOW).at(-1)!);
      }, { windowMin });
    expect(axis(150, NOW)).toBe(TALL_150[4]); // just looked: nothing new, and the mark does not sit on "now"
    expect(axis(110, NOW)).toBe(TALL_110[4]);
    expect(axis(150, NOW, [], 180).slice(105)).toBe(" 180m ─────┴─────────┴───── now ────────────");
    // The design's own digest row, 17 minutes after looking: the mark falls in the lane's bar for 23:34.
    const news = [...ev("asked", 1), ...ev("agentDone", 3), ...ev("reply", 4)];
    expect(axis(150, NOW - 17 * MIN, news)).toBe(" ── since 23:34  ·  ▲ 1 asked  ·  ✓ 3 agents done  ·  ◆ 4 new replies ─────────────────────────────────── 30m ──────┴─▼───────┴───── now ────────────");
    const rule = draw("current", () => {
      Object.assign(F.seen, { at: NOW - 17 * MIN, events: news });
      return F.header(fleet(), 150, 44, NOW).at(-1)!;
    });
    expect(rule).toContain(F.bold(F.fg(F.C.white, "▼")));
    expect(rule).toContain(F.bold(F.fg(F.C.amber, "▲ ")) + F.fg(F.C.text, "1 asked"));
    // The mark with nothing new: still drawn. On a tick it takes the tick's place. Under either label it gives way.
    expect(axis(150, NOW - 17 * MIN).slice(105)).toBe(" 30m ──────┴─▼───────┴───── now ────────────");
    expect(axis(150, NOW - 19 * MIN).slice(105)).toBe(" 30m ──────▼─────────┴───── now ────────────");
    for (const minutes of [0, 1, 2, 3, 27, 28, 29, 31, 60]) expect(axis(150, NOW - minutes * MIN)).toBe(TALL_150[4]);
    // Order: asked, failed, stalled, finished, new replies; as many as fit before the lane, whole groups only.
    const everything = [...ev("reply", 2), ...ev("agentDone", 1), ...ev("workflowDone", 1), ...ev("stalled", 1), ...ev("failed", 2), ...ev("asked", 1)];
    expect(axis(200, NOW - 17 * MIN, everything)).toContain(" ── since 23:34  ·  ▲ 1 asked  ·  ✗ 2 failed  ·  ◐ 1 stalled  ·  ✓ 1 workflow done  ·  ✓ 1 agent done  ·  ◆ 2 new replies ──");
    expect(axis(150, NOW - 17 * MIN, everything)).toContain(" ── since 23:34  ·  ▲ 1 asked  ·  ✗ 2 failed  ·  ◐ 1 stalled  ·  ✓ 1 workflow done ───");
    expect(axis(110, NOW - 17 * MIN, everything)).toBe(" ── since 23:34  ·  ▲ 1 asked  ·  ✗ 2 failed  ·  ◐ 1 stalled ───────────────── 30m ──┴▼────┴─── now ─────────");
  });

  test("nothing in the header reaches the lane or the edge, at any width, in any account state", () => {
    const fleets = { 20: fleet(20, { stalled: true }), 30: fleet(30, { stalled: true }) };
    for (let W = 100; W <= 220; W++) {
      const g = F.grid(W);
      for (const rows of [30, 44])
        for (const account of Object.keys(ACCOUNT)) {
          const lines = head(W, rows, account, fleets[g.laneW as 20 | 30]);
          const where = `${W}x${rows} ${account}`;
          const remedy = account === "remote" || account === "staleRemote" || account === "shared" ? 1 : 0;
          expect([where, lines.length]).toEqual([where, (rows >= 40 ? 5 : 3) + remedy]);
          for (const line of lines) expect([where, F.width(line) <= W - 1]).toEqual([where, true]); // column W stays blank
          for (const line of lines.slice(1, -1)) {
            const cells = line.padEnd(W);
            expect([where, cells.slice(g.textEnd, g.lane - 1)]).toEqual([where, "  "]); // the two cells before the lane
            expect([where, cells[0], cells[g.laneEnd]]).toEqual([where, " ", " "]); // column 1, and the cell between the lane and the figures
          }
          expect([where, lines.at(-1)!.slice(g.lane - 1, g.lane + 3)]).toEqual([where, "30m "]);
          expect([where, lines.join("\n").includes("undefined") || lines.join("\n").includes("NaN")]).toEqual([where, false]);
        }
    }
  });

  test("the button bar carries the hidden count, and its labels shorten in two steps", () => {
    const bar = (W: number, idle = 1, account = "current") => draw(account, () => strip(F.buttonBar(W, 44, idle)).trimEnd());
    expect(bar(150)).toBe("  1 Detail   2 Compact   3 Far    −  30m  +    a All · 1 idle   d Finished agents   b Bell   space Seen   ? Legend    q Quit");
    expect(bar(110)).toBe("  1   2   3    −  30m  +    a All · 1 idle   d Done   b Bell   space Seen   ?    q Quit");
    expect(bar(80, 1, "remote")).toBe("  1   2   3    −  30m  +    a   d   b   u   space   ?    q");
    // "u Retry usage" is there only while a usage read is failing, whatever figures are on screen.
    expect([bar(170, 1, "none"), bar(170, 1, "stale"), bar(170, 1, "shared")].map((b) => b.includes(" u Retry usage "))).toEqual([true, true, true]);
    expect([bar(170), bar(170, 1, "off")].map((b) => b.includes("Retry"))).toEqual([false, false]);
    expect(bar(120, 1, "none")).toContain(" u Retry ");
    for (let W = 80; W <= 200; W += 5) for (const account of ["current", "none"]) expect(F.width(bar(W, 12, account))).toBeLessThanOrEqual(W);
    // The line that used to name the hidden sessions is gone from every mode.
    for (const mode of ["detail", "compact", "far"] as F.Mode[]) {
      const frame = draw("current", () => F.render(fleet(), 150, 44, NOW).map(strip), { mode });
      expect(frame.length).toBe(44);
      expect(frame.join("\n")).not.toMatch(/hidden|a shows/);
      expect(frame.at(-1)).toContain(" a All · 1 idle ");
    }
  });

  test("key ?: the legend names every mark and key on one screen, at every terminal size", () => {
    for (const [cols, rows] of SIZES) {
      const lines = F.legend(cols, rows).map(strip);
      expect(lines.length).toBe(rows);
      for (const line of lines) expect(F.width(line)).toBeLessThanOrEqual(cols);
      const text = lines.join("\n");
      for (const word of ["needs you", "stalled?", "working", "your turn", "idle", "finished", "you", "Claude", "earlier", "live", "in progress", "not started", "done", "failed", "workflow", "no reading", "pace", "context", "rail"]) expect([cols, word, text.includes(word)]).toEqual([cols, word, true]);
      for (const glyph of ["▲", "◐", "●", "▸", "○", "✓", "✗", "◆", "◇", "⠋", "≡", "━", "┼", "╌", "█", "▌", "░", "┴", "▼"]) expect([cols, glyph, text.includes(glyph)]).toEqual([cols, glyph, true]);
      for (const key of ["1 2 3", "+ -", "a ", "d ", "tab", "esc", "b ", "u ", "space", "? ", "q "]) expect([cols, key, lines.some((l) => l.includes(key))]).toEqual([cols, key, true]);
      expect(lines.at(-1)).toContain("any key or click returns");
    }
    // With --plain-glyphs it shows the stand-ins the screen is drawing.
    F.setPlainGlyphs(true);
    try {
      const text = F.legend(150, 44).map(strip).join("\n");
      for (const missing of ["≡", "╌", "┿"]) expect(text).not.toContain(missing);
      expect(text).toContain("◇ workflow"); // ≡ → ◇
      expect(text).toContain("◆ earlier"); // ◇ → ◆
    } finally {
      F.setPlainGlyphs(false);
    }
  });

  // Sessions with names, places and words, for the rows under the header.
  const say = (t: number, text: string, branch: string) => ({ ...reply(t, text, 372_000), gitBranch: branch });
  function story(): F.Session[] {
    const quick = (id: string, label: string) => agentOf(id, tailOf([toolCall(NOW - 9_000), toolResult(NOW - 8_000)]), { label, type: "workflow-subagent", model: "opus", wf: "wf_1", phase: "Fix" });
    const reviewer = agentOf("w5", tailOf([toolCall(NOW - 4 * MIN, "Bash", { description: "Run the refund tests 200 times under load" })]), { label: "review:clock-in-refund", type: "workflow-subagent", model: "opus", wf: "wf_1", phase: "Fix" });
    const passed = ["w1", "w2"].map((id) => agentOf(id, tailOf([toolCall(NOW - 12 * MIN), toolResult(NOW - 12 * MIN + 1)]), { label: id, wf: "wf_1", phase: "Reproduce", done: true }));
    const wf: F.Workflow = { id: "wf_1", name: "bisect-and-fix", status: "running", phase: "Fix", phases: [], seen: ["Reproduce", "Fix"], started: NOW - 14 * MIN - 20_000, finished: 0, agents: [...passed, quick("w3", "fix:clock-in-refund"), quick("w4", "fix:retry-backoff"), reviewer], lastT: NOW - 8_000 };
    return [
      sessionOf({ sid: "aaaaaaaa-1", name: "checkout flow redesign", status: "idle", job: { state: "blocked", detail: "migration drafted and tested against a copy", needs: "Approve dropping the legacy coupon_code column before I run the migration?" }, mains: [tailOf([say(NOW - 6 * MIN - 20_000, "The migration is written.", "feature/checkout-v2")])] }),
      sessionOf({ sid: "cccccccc-3", name: "docs site search", kind: "interactive", cwd: "/work/docs", startedAt: NOW - 22 * MIN - 20_000, mains: [tailOf([{ ...prompt(NOW - 29 * MIN, "why does search miss pages added this week?"), gitBranch: "main" }, toolCall(NOW - 20_000), toolResult(NOW - 19_000)])], agents: [agentOf("s1", tailOf([toolCall(NOW - 9_000), toolResult(NOW - 8_000)]), { label: "Find where the search index is built" }), agentOf("s3", tailOf([toolCall(NOW - 9 * MIN), toolResult(NOW - 9 * MIN + 1)]), { label: "List pages added since the last release", done: true })] }),
      sessionOf({ sid: "bbbbbbbb-2", name: "flaky test hunt", job: { state: "working", detail: "bisecting the three payment tests that fail one run in twenty", needs: "" }, mains: [tailOf([say(NOW - 2 * MIN - 20_000, "Two of the three share a cause.", "fix/flaky-payments"), toolCall(NOW - 2 * MIN, "Workflow", { description: "Bisect and fix the flaky payment tests" })])], workflows: [wf], tasks: { done: 2, doing: 1, total: 6, active: "Fixing the clock-dependent tests" } }),
      sessionOf({ sid: "eeeeeeee-5", name: "release notes draft", kind: "interactive", status: "idle", cwd: "/work/docs", mains: [tailOf([prompt(NOW - 14 * MIN, "draft the release notes"), say(NOW - 12 * MIN - 20_000, "The draft is in docs/releases/4.2.md. Shall I open a pull request?", "docs/release-4.2")])] }),
      sessionOf({ sid: "dddddddd-4", name: "rename billing module", status: "idle", job: { state: "done", detail: "merged", needs: "" }, mains: [tailOf([say(NOW - 50 * MIN, "Merged.", "main")])] }),
    ];
  }
  const screen = (mode: F.Mode, cols = 150, rows = 44, all = true) => draw("off", () => F.render(story(), cols, rows, NOW), { mode, all });

  test("far cards: the state glyph leads the state word, the subheading says who is speaking, and the side column uses the one vocabulary", () => {
    const rawFrame = screen("far", 150, 60);
    const frame = rawFrame.map(strip);
    const line = (text: string) => frame.find((l) => l.includes(text)) ?? "";
    // Title row: the name from column 5, the state ending at column 149.
    expect(line("C H E C K O U T")).toBe(" ██ C H E C K O U T   F L O W   R E D E S I G N" + " ".repeat(83) + "▲ N E E D S   Y O U ");
    for (const state of ["● W O R K I N G", "▸ Y O U R   T U R N", "✓ F I N I S H E D"]) expect(frame.some((l) => l.endsWith(state) && F.width(l) === 149)).toBe(true);
    expect(rawFrame.join("\n")).toContain(F.bold(F.fg(F.C.blue, "▸ Y O U R   T U R N"))); // blue, no longer purple
    expect(rawFrame.join("\n")).not.toContain(F.fg(F.C.purple, "Y O U R"));
    // Subheading: the question; the now-line; a promoted prompt led by ▸; a reply led by ◆.
    expect(line("Approve dropping")).toBe(" ██ Approve dropping the legacy coupon_code column before I run the migration?" + " ".repeat(72));
    expect(line("bisecting")).toBe(" ██ bisecting the three payment tests that fail one run in twenty");
    expect(line("why does search")).toBe(" ██ ▸ why does search miss pages added this week?");
    expect(line("The draft is in")).toBe(" ██ ◆ The draft is in docs/releases/4.2.md. Shall I open a pull request?");
    // A waiting card is tinted across its whole width, on every one of its rows.
    const top = frame.findIndex((l) => l.includes("C H E C K O U T"));
    const height = frame.slice(top).findIndex((l) => l === "");
    expect(height).toBeGreaterThanOrEqual(6);
    for (const l of rawFrame.slice(top, top + height)) expect(l.startsWith("\x1b[48;2;52;38;0m") && F.cells(l) === 150).toBe(true);
    // Side column from column 118: agents and workflows, context on the limit rule, the process tree, tool calls, tasks.
    for (const text of ["○ 0 AGENTS", "⠋ 1 AGENT", "⠋ 3 AGENTS   ≡ 1 WORKFLOW", "CTX ━━━━━━────────── 37%", "CPU 0% · 0.0G", "3 tool calls / 30m", "✓✓◐○○○  2/6"]) expect([text, line(text).indexOf(text) + 1]).toEqual([text, 118]);
    expect(rawFrame.join("\n")).toContain(F.fg(F.C.calm, "━".repeat(6))); // 37%: calm, never yellow
    for (const retired of ["⚠", "⚙", "⎇"]) expect(frame.join("\n")).not.toContain(retired);
    for (const l of frame) expect(F.width(l)).toBeLessThanOrEqual(150);
  });

  test("compact rows keep today's columns with the new glyphs and words", () => {
    const rawFrame = screen("compact");
    const frame = rawFrame.map(strip);
    const text = frame.join("\n");
    const line = (part: string) => frame.find((l) => l.includes(part)) ?? "";
    // Session rows: the lead glyph is the state; the place uses @; the status cell has no second warning glyph.
    expect(line("checkout flow")).toMatch(/^ ▲ checkout flow red…  bg aaaaaaaa    work\/shop @ feature\/c…  NEEDS YOU · 6m       [▁▂▃▄▅▆▇█]{25} +\d+ tools +\S+ out   ctx 37%/);
    expect(line("flaky test hunt")).toMatch(/^ ● flaky test hunt     bg bbbbbbbb    work\/shop @ fix\/flaky…  working · up 1h04    /);
    expect(line("docs site search")).toMatch(/^ ● docs site search    interactive …  work\/docs @ main        working · up 22m     /); // "busy" reads "working"
    expect(line("release notes")).toMatch(/^ ▸ release notes dra…  interactive …  work\/docs @ docs\/rele…  your turn · 12m      /);
    expect(line("rename billing")).toMatch(/^ ✓ rename billing mo…  bg dddddddd    work\/shop @ main        finished · 50m       /);
    expect(rawFrame.join("\n")).toContain(F.bold(F.fg(F.C.amber, "NEEDS YOU · 6m     ")));
    expect(rawFrame.join("\n")).toContain(F.fg(F.C.blue, "▸") + " "); // a your-turn row leads with a blue ▸
    expect(rawFrame.join("\n")).toContain(F.fg(F.C.dim, "work/shop @ feature/c…")); // the place is dim, no longer blue
    // The question: ▲ and bold white on the amber tint, under the session.
    expect(line("Approve dropping")).toBe("   └─ ▲ Approve dropping the legacy coupon_code column before I run the migration? ");
    expect(rawFrame.join("\n")).toContain(`\x1b[48;2;52;38;0m${F.bold(F.fg(F.C.amber, "▲"))}${F.bold(F.fg(F.C.white, " Approve dropping the legacy coupon_code column before I run the migration? "))}\x1b[49m`);
    // Workflow row: ≡, the current phase as ◐ and its name, steps as ticks.
    expect(line("bisect-and-fix")).toMatch(/^   └─ ≡ bisect-and-fix                     ◐ Fix                        ✓✓◐◐◐                2\/5     [▁▂▃▄▅▆▇█]{25}     up 14m/);
    expect(rawFrame.join("\n")).toContain(F.fg(F.C.green, "✓✓") + F.fg(F.C.white, "◐◐◐"));
    // Agent rows: live is a green spinner; a tool call outstanding is a white ◐ with the tool's name in cyan and its hint after it.
    expect(line("fix:retry-backoff")).toMatch(/^      ├─ ⠋ fix:retry-backoff +workflow · opus +[▁▂▃▄▅▆▇█]{25}  thinking +live$/);
    expect(line("review:clock-in-refund")).toMatch(/^      └─ ◐ review:clock-in-refund +workflow · opus +[▁▂▃▄▅▆▇█]{25}  Bash  Run the refund tests 200 times un… +4m$/);
    expect(rawFrame.join("\n")).toContain(F.fg(F.C.white, "◐") + " " + F.fg(F.C.text, "review:clock-in-refund").slice(0, -5));
    expect(rawFrame.join("\n")).toContain(F.fg(F.C.cyan, "Bash") + "  " + F.fg(F.C.text, "Run the refund tests 200 times un…"));
    expect(line("agent finished")).toBe("   └─ ✓ 1 agent finished in the last 30m  ·  d lists them");
    // None of the old vocabulary is left, and nothing but the needs-you marks is amber.
    for (const old of ["⚠", "⚙", "⎇", "? needs you", "(d to list)", "busy ·", "phase ", "●●"]) expect([old, text.includes(old)]).toEqual([old, false]);
    const amber = "\x1b[38;2;229;181;68m";
    const amberText = rawFrame.join("\n").split(amber).slice(1).map((piece) => strip(piece.split("\x1b[39m")[0]).trim());
    expect([...new Set(amberText)].sort()).toEqual(["NEEDS YOU · 6m", "▲", "▲ 1 needs you"]);
    for (const l of frame) expect(F.width(l)).toBeLessThanOrEqual(150);
  });

  test("an ended workflow shows ✓ or ✗ in place of ≡, and step glyphs are ticks, never dots", () => {
    expect(strip(F.pips(2, 1, 6, 6))).toBe("✓✓◐○○○");
    expect(strip(F.pips(6, 0, 6, 6))).toBe("✓✓✓✓✓✓");
    expect(F.cells(F.pips(40, 3, 60, 20))).toBe(20); // scaled past the width it is given
    expect(F.pips(2, 1, 6, 6)).toContain(F.fg(F.C.white, "◐")); // in progress is white, never yellow
    const ended = (status: string): F.Session[] => {
      const s = story();
      Object.assign(s[2].workflows[0], { status, finished: NOW - 2 * MIN, tokens: 412_000, agents: s[2].workflows[0].agents.map((a) => ({ ...a, done: true })) });
      return s;
    };
    const row = (status: string) => draw("off", () => F.render(ended(status), 150, 44, NOW).map(strip).find((l) => l.includes("bisect-and-fix")) ?? "", { mode: "compact" });
    expect(row("completed")).toMatch(/^   └─ ✓ bisect-and-fix +✓✓✓✓✓ +5\/5 +[▁▂▃▄▅▆▇█]{25}  completed   412k tok$/);
    expect(row("failed")).toMatch(/^   └─ ✗ bisect-and-fix .* failed/);
    expect(row("completed")).not.toContain("◐");
  });

  test("every mode's whole frame fits at every size with the new header, in every account state", () => {
    for (const [cols, rows] of SIZES)
      for (const mode of ["detail", "compact", "far"] as F.Mode[])
        for (const account of ["current", "remote", "stale", "off"]) {
          const frame = draw(account, () => F.render(story(), cols, rows, NOW), { mode, all: true });
          const where = `${cols}x${rows} ${mode} ${account}`;
          expect([where, frame.length]).toEqual([where, rows]);
          for (const l of frame) expect([where, F.cells(l) <= cols]).toEqual([where, true]);
        }
  });
});

describe("the detail view", () => {
  const plain = (rows: string[]) => rows.map((r) => strip(r).trimEnd());
  const text = (segs: F.Seg[]) => segs.map((s) => s[0]).join("");
  /** A transcript's rows with the branch it was on, as Claude Code writes them. */
  const on = (branch: string, rows: object[]) => rows.map((r) => ({ ...r, gitBranch: branch }));
  const calls = (count: number, end: number, seed = 7) => callTimes(count, end, 28, seed).flatMap((t) => [toolCall(t), toolResult(t + 900)]);

  /** The demo's session that needs you: a question, a now-line, a prompt and two replies. */
  function waiting(now: number): F.Session {
    const main = tailOf(on("feature/checkout-v2", [
      prompt(now - 29 * MIN, "move coupons to the new promotions table and remove the old column"),
      ...calls(46, now - 8 * MIN),
      reply(now - 7 * MIN - 20_000, "The new promotions table is in place and every read now goes through it. All 212 checkout tests pass.", 372_000),
      reply(now - 6 * MIN - 40_000, "The migration that drops coupon_code is written and has run cleanly against a copy of the data.\n- 41,208 rows were copied to promotions\n- 0 rows differ between the old column and the new table\n\nI have not run it for real, because dropping a column cannot be undone.", 372_000),
    ]));
    return sessionOf({ sid: "aaaaaaaa-0001", name: "checkout flow redesign", status: "idle", startedAt: now - 190 * MIN, mains: [main], job: { state: "blocked", detail: "migration drafted and tested against a copy", needs: "Approve dropping the legacy coupon_code column before I run the migration?" } });
  }
  /** The demo's interactive session: no now-line, so its prompt is the subheading; two agents at work and one finished. */
  function withAgents(now: number): F.Session {
    const main = tailOf(on("main", [
      prompt(now - 29 * MIN, "why does search miss pages added this week?"),
      ...calls(18, now - 60_000, 11),
      reply(now - 55_000, "Search is built from an index that is only regenerated on release, so pages added since the last release are missing. I'm checking whether the build can regenerate it on every deploy.", 96_000),
      toolCall(now - 15_000),
      toolResult(now - 14_000),
    ]));
    const live = tailOf([...calls(22, now - 20_000, 3), toolCall(now - 5_000), toolResult(now - 4_000)]);
    const tool = tailOf([...calls(9, now - 4 * MIN, 5), toolCall(now - 3 * MIN, "Bash", { description: "Build the site with the index step enabled" })]);
    const over = tailOf(calls(11, now - 9 * MIN, 9));
    return sessionOf({
      sid: "cccccccc-0003", name: "docs site search", kind: "interactive", cwd: "/work/docs", startedAt: now - 22 * MIN - 30_000, mains: [main],
      agents: [
        agentOf("s1", live, { label: "Find where the search index is built" }),
        agentOf("s2", tool, { label: "Measure index build time on a full deploy", type: "general-purpose", model: "opus" }),
        agentOf("s3", over, { label: "List pages added since the last release", done: true }),
      ],
    });
  }
  /** The demo's busy job: a now-line, tasks, the main thread on a tool, and a workflow with two agents done and three running. */
  function busy(now: number, name = "flaky test hunt", upMin = 64, sid = "bbbbbbbb-0002"): F.Session {
    const main = tailOf(on("fix/flaky-payments", [
      prompt(now - 29 * MIN, "find out why the payment tests are flaky and fix them"),
      ...calls(30, now - 4 * MIN, upMin),
      reply(now - 3 * MIN - 20_000, "Three tests fail intermittently, all in the payments suite. I'm running each two hundred times under load to find which ones share a cause.", 611_000),
      reply(now - 2 * MIN - 40_000, "Two of the three share a cause: both read the clock twice and assume the same second. The third is separate. I've started a workflow with one agent per test, and a reviewer to confirm each fix.", 611_000),
      { ...toolCall(now - 2 * MIN, "Workflow", { description: "Bisect and fix the flaky payment tests" }), message: { ...toolCall(now - 2 * MIN, "Workflow", { description: "Bisect and fix the flaky payment tests" }).message, usage: { input_tokens: 4, cache_read_input_tokens: 611_000, output_tokens: 60 } } },
    ]));
    const member = (id: string, label: string, phase: string, tail: F.Tail, done = false) => agentOf(id, tail, { label, type: "workflow-subagent", model: "opus", wf: "wf_1", phase, done });
    const agents = [
      member("w1", "reproduce:refund-rounding", "Reproduce", tailOf(calls(14, now - 14 * MIN, 21)), true),
      member("w2", "reproduce:retry-backoff", "Reproduce", tailOf(calls(14, now - 12 * MIN, 22)), true),
      member("w3", "fix:retry-backoff", "Fix", tailOf([...calls(16, now - 30_000, 23), toolCall(now - 20_000), toolResult(now - 19_000)])),
      member("w4", "fix:clock-in-refund", "Fix", tailOf([...calls(16, now - 30_000, 24), toolCall(now - 8_000), toolResult(now - 7_000)])),
      member("w5", "review:clock-in-refund", "Fix", tailOf([...calls(12, now - 5 * MIN, 25), toolCall(now - 4 * MIN, "Bash", { description: "Run the refund tests 200 times under load" })])),
    ];
    const wf: F.Workflow = { id: "wf_1", name: "bisect-and-fix", status: "running", phase: "Fix", phases: [], seen: ["Reproduce", "Fix"], started: now - 14 * MIN - 30_000, finished: 0, agents, lastT: now };
    return sessionOf({
      sid, name, startedAt: now - upMin * MIN - 30_000, mains: [main], workflows: [wf],
      job: { state: "working", detail: "bisecting the three payment tests that fail one run in twenty", needs: "" },
      tasks: { done: 2, doing: 1, total: 6, active: "Fixing the clock-dependent tests" },
    });
  }
  const three = (now: number) => [waiting(now), withAgents(now), busy(now)];
  const six = (now: number) => [waiting(now), busy(now), ...["search reindex", "billing export", "upgrade tooling", "onboarding emails"].map((name, i) => busy(now, name, 71 + 12 * i, `${"defg"[i].repeat(8)}-001${i}`))];
  /** The views as render() hands them over: in order, quiet ones left out unless asked for. */
  const viewsOf = (sessions: F.Session[], now: number, all = false) => F.buildViews(sessions, now).filter((v) => all || !F.isHidden(v));
  /** Plan the blocks without drawing them: each block's rows, and what the ladder left it. */
  function plan(sessions: F.Session[], W: number, avail: number, now = NOW, focus = false) {
    const g = F.grid(W);
    const blocks = viewsOf(sessions, now).map((v) => F.blockOf(v, g, now, F.laneWindow(now, W), focus));
    const fit = F.fitBlocks(blocks, g, avail, now);
    return { ...fit, blocks, heights: blocks.map((b) => (b.folded ? 0 : F.blockRows(b, g, now))) };
  }
  const draw = (sessions: F.Session[], W: number, avail: number, now = NOW, focus = false) => plain(F.detailView(viewsOf(sessions, now), W, avail, now, 0, focus));
  /** Nothing is "new since you looked" unless a test says so. */
  const quietly = <T>(run: () => T): T => {
    const before = F.seen.at;
    F.seen.at = NOW + MIN;
    try {
      return run();
    } finally {
      F.seen.at = before;
    }
  };

  // Not demo text: the design's specimen, which exercises every formatting rule.
  const SPECIMEN =
    "The slow part is the join against `audit_log`, which has **no index** on `run_id`. Adding one takes the export from 41 minutes to 3.\n\n" +
    "- the index builds in about 90 seconds on a copy of the data\n" +
    "- nothing else writes to that column often enough for the extra index to cost anything worth worrying about\n" +
    "  - checked the last 30 days of writes\n\n" +
    "```sql\nCREATE INDEX CONCURRENTLY audit_log_run_id\n  ON audit_log (run_id);\nANALYZE audit_log;\nSELECT pg_size_pretty(pg_relation_size('audit_log_run_id'));\n```\n\n" +
    "I ran the full export twice with the index in place to confirm the timing holds.\n\n" +
    "The second run was slightly faster because the cache was warm.\n\nNothing in the export output changed.\n\nRow counts match exactly.\n\n" +
    "Shall I add the index on staging first, or go straight to a migration?";

  test("the design's specimen: a clipped reply keeps its final line, and the mark sits on the row above", () => {
    const rows = F.replyRows(SPECIMEN, 92);
    expect(rows.length).toBe(15);
    const shown = F.clipReply(rows, 10, 92);
    expect(shown.map((r) => text(r.segs))).toEqual([
      "The slow part is the join against audit_log, which has no index on run_id. Adding one takes",
      "the export from 41 minutes to 3.",
      "• the index builds in about 90 seconds on a copy of the data",
      "• nothing else writes to that column often enough for the extra index to cost anything worth",
      "  worrying about",
      "  – checked the last 30 days of writes",
      "│ CREATE INDEX CONCURRENTLY audit_log_run_id",
      "│   ON audit_log (run_id);",
      "│ ANALYZE audit_log;",
      "Shall I add the index on staging first, or go straight to a migration?",
    ]);
    expect(shown.map((r) => r.mark)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "… +5 lines", undefined]);
    // In colour: the two names are code colour, "no index" is bold white, the rest is text colour.
    const styled = Object.fromEntries(rows[0].map(([t, color, isBold]) => [t, [color, !!isBold]]));
    expect(styled["audit_log"]).toEqual([F.C.code, false]);
    expect(styled["run_id"]).toEqual([F.C.code, false]);
    expect(styled["no index"]).toEqual([F.C.white, true]);
    expect(styled["The slow part is the join against "]).toEqual([F.C.text, false]);
    expect(rows[2][0]).toEqual(["• ", F.C.cyan]); // bullet
    expect(rows[5][0]).toEqual(["  – ", F.C.dim]); // nested bullet
    expect(rows[6][0]).toEqual(["│ ", F.C.faint]); // code gutter
    expect(rows[6][1][1]).toBe(F.C.code);
  });

  test("markdown is rendered, not stripped", () => {
    const md = (s: string, w = 60, focus = false) => F.replyRows(s, w, { focus }).map(text);
    expect(md("# The plan\n\nFirst para.\nSecond line.")).toEqual(["The plan", "First para.", "Second line."]); // blank lines are not kept
    expect(md("# The plan\n\nFirst para.", 60, true)).toEqual(["The plan", "", "First para."]); // …except in focus
    expect(F.replyRows("## Bold **heading**", 60)[0]).toEqual([["Bold heading", F.C.white, true]]);
    expect(md("1. first\n2. second item that is long enough to wrap around the line\n10. tenth", 30)).toEqual(["1. first", "2. second item that is long", "   enough to wrap around the", "   line", "10. tenth"]);
    expect(md("> quoted words that go on and on past the edge", 24)).toEqual(["│ quoted words that go", "│ on and on past the", "│ edge"]);
    expect(md("- one\n* two\n+ three\n    - deep\n        - deeper")).toEqual(["• one", "• two", "• three", "  – deep", "  – deeper"]); // deeper levels are flattened to the second
    expect(md("see [the docs](https://example.com/a/b) and https://github.com/pdaddyo/claude-fleet/pull/12?x=1.")).toEqual(["see the docs and github.com/…/12."]);
    expect(md("before\n\n---\n<!-- a note\nto self -->\nafter")).toEqual(["before", "after"]); // rules and comments are dropped
    expect(md("*italic* and _also_ and ~~struck~~ and __strong__")).toEqual(["italic and also and struck and strong"]);
    expect(md("- [x] shipped\n- [ ] still to do")).toEqual(["✓ shipped", "○ still to do"]);
  });

  test("a mark counts only where emphasis can be; anything doubtful stays as typed", () => {
    const one = (s: string) => text(F.inlineSegs(s));
    expect(one("rename coupon_code to promo_code")).toBe("rename coupon_code to promo_code");
    expect(one("5*3*2 is 30")).toBe("5*3*2 is 30");
    expect(one("src/*.ts and lib/*.ts")).toBe("src/*.ts and lib/*.ts");
    expect(one("src/**/*.ts")).toBe("src/**/*.ts");
    expect(one("an **unclosed bold")).toBe("an **unclosed bold");
    expect(one("a `lone backtick")).toBe("a `lone backtick");
    expect(one("2 * 3 * 4")).toBe("2 * 3 * 4");
    expect(one("\\*not italic\\*")).toBe("*not italic*");
    expect(F.inlineSegs("`a*b*c` stays code")[0]).toEqual(["a*b*c", F.C.code]);
    expect(F.inlineSegs("**bold with `code` inside**")).toEqual([["bold with ", F.C.white, true], ["code", F.C.code, true], [" inside", F.C.white, true]]);
    expect(F.shortUrl("https://example.com")).toBe("example.com");
    expect(F.shortUrl("https://example.com/docs")).toBe("example.com/docs");
    expect(F.shortUrl("https://example.com/a/b/c.html#top")).toBe("example.com/…/c.html");
  });

  test("a reply full of stray marks is still read quickly", () => {
    const started = performance.now();
    for (const mark of ["*a ", "_a ", "[x ", "`a ", "~~a ", "![ ", "<http "]) expect(F.replyRows(mark.repeat(40_000), 92).length).toBeGreaterThan(100);
    expect(F.flatReply("*a ".repeat(40_000)).length).toBe(119_999);
    expect(performance.now() - started).toBeLessThan(5_000); // about half a second on the machine this was written on; without a bound on how far a mark's partner is sought, minutes
  });

  test("wrapping happens after the marks are gone, and a styled span may run across the break", () => {
    const rows = F.wrapSegs(F.inlineSegs("plain words then **a bold run that is long** and `code` to finish"), 20);
    expect(rows.map(text)).toEqual(["plain words then a", "bold run that is", "long and code to", "finish"]);
    for (const r of rows) expect(F.width(text(r))).toBeLessThanOrEqual(20);
    expect(rows[0][rows[0].length - 1]).toEqual(["a", F.C.white, true]); // the bold span starts on one row…
    expect(rows[1][0]).toEqual(["bold run that is", F.C.white, true]); // …and carries on across two more
    expect(rows[2][0]).toEqual(["long", F.C.white, true]);
    expect(F.wrapSegs([["a-very-long-word-with-no-spaces-in-it"]], 10).map(text)).toEqual(["a-very-lon", "g-word-wit", "h-no-space", "s-in-it"]);
    expect(F.wrapSegs([["  spaced    out  "]], 20).map(text)).toEqual(["spaced out"]);
    expect(F.wrapSegs([], 20)).toEqual([]);
  });

  test("code fences, tables and the lines they hide", () => {
    const md = (s: string, w = 60, focus = false) => F.replyRows(s, w, { focus }).map(text);
    const code = "```ts\n" + Array.from({ length: 14 }, (_, i) => `  const line${i} = ${"x".repeat(i * 5)};`).join("\n") + "\n```";
    expect(md(code, 30)).toEqual(["│   const line0 = ;", "│   const line1 = xxxxx;", "│   const line2 = xxxxxxxxxx;", "│ … +11 lines"]); // indentation kept
    expect(md(code, 24)[2]).toBe("│   const line2 = xxxxx…"); // cut, never wrapped
    expect(md(code, 30, true).length).toBe(13); // 12 lines in focus, then the count
    expect(md(code, 30, true)[12]).toBe("│ … +2 lines");
    const table = "| Name | Count |\n| --- | ---: |\n| alpha | 1 |\n| beta | 22 |\n| gamma | 333 |";
    expect(md(table)).toEqual(["Name  │ Count", "alpha │ 1", "beta  │ 22", "… +1 row"]); // the rule row is dropped
    expect(F.replyRows(table, 60)[0][0]).toEqual(["Name ", F.C.white, true]); // header row bold
    expect(md(table, 60, true)).toEqual(["Name  │ Count", "alpha │ 1", "beta  │ 22", "gamma │ 333"]);
    const wide = "| a | b | c | d | e |\n|---|---|---|---|---|\n" + "| xxxxxxxxxxxxxxxx | yyyyyyyyyyyyyyyy | zzzzzzzzzzzz | wwwwwwwwwwwwwww | vvvvvvvvv |\n".repeat(12);
    expect(md(wide)).toEqual(["table · 5 columns x 12 rows"]);
    for (const row of F.replyRows(SPECIMEN + "\n\n" + table + "\n\n" + code, 40)) expect(F.width(text(row))).toBeLessThanOrEqual(40);
  });

  test("an earlier reply is flattened to plain text", () => {
    expect(F.flatReply("## Done\n\nThe **table** is in `place`.\n- 41,208 rows\n\n```\nselect 1;\n```\n---\n| a | b |\n|---|---|\n| 1 | 2 |")).toBe("Done The table is in place. • 41,208 rows select 1; a · b 1 · 2");
    expect(F.clipWords("one two three four", 9)).toBe("one two");
    expect(F.clipWords("one two three four", 7)).toBe("one two");
    expect(F.clipWords("onetwothreefour", 7)).toBe("onetwot");
    expect(F.cutTo("one two three", 7)).toBe("one tw…");
    expect(F.cutTo("short", 7)).toBe("short");
  });

  test("clipping a reply: from the top, the mark on the last row before the cut, the final line kept from 3 rows up", () => {
    const rows = F.replyRows(["first paragraph", "second paragraph", "third paragraph", "fourth paragraph", "the question at the end?"].join("\n\n"), 40);
    const shown = (cap: number) => F.clipReply(rows, cap, 40).map((r) => text(r.segs) + (r.mark ? ` [${r.mark}]` : ""));
    expect(shown(0)).toEqual([]);
    expect(shown(1)).toEqual(["first paragraph [… +4 lines]"]);
    expect(shown(2)).toEqual(["first paragraph", "second paragraph [… +3 lines]"]);
    expect(shown(3)).toEqual(["first paragraph", "second paragraph [… +2 lines]", "the question at the end?"]);
    expect(shown(4)).toEqual(["first paragraph", "second paragraph", "third paragraph [… +1 line]", "the question at the end?"]);
    expect(shown(5)).toEqual(["first paragraph", "second paragraph", "third paragraph", "fourth paragraph", "the question at the end?"]);
    expect(shown(9)).toEqual(shown(5));
    // The row that carries the mark is shortened at a word boundary to make room for it.
    const long = F.replyRows("Two of the three share a cause: both read the clock twice and assume the same second. The third is separate. I've started a workflow with one agent per test, and a reviewer to confirm each fix.", 92);
    expect(F.clipReply(long, 1, 92).map((r) => [text(r.segs), r.mark])).toEqual([["Two of the three share a cause: both read the clock twice and assume the same", "… +2 lines"]]);
    // A final paragraph that wraps is shown by its start, not by its last few words.
    const wrapsAtEnd = F.replyRows("one\n\ntwo\n\nthree\n\nI have not run it for real, because dropping a column cannot be undone.", 40);
    expect(F.clipReply(wrapsAtEnd, 3, 40).map((r) => text(r.segs))).toEqual(["one", "two", "I have not run it for real, because …"]);
    // One long paragraph is simply kept from the top.
    const single = F.replyRows("word ".repeat(60).trim(), 40);
    expect(F.clipReply(single, 3, 40).map((r) => r.mark)).toEqual([undefined, undefined, `… +${single.length - 3} lines`]);
  });

  test("a clipped reply keeps up to three rows of its closing paragraph, so a closing question longer than a row is not what goes missing", () => {
    const text = (segs: F.Seg[]) => segs.map((s) => s[0]).join("");
    const wrapsAtEnd = F.replyRows("one\n\ntwo\n\nthree\n\nI have not run it for real, because dropping a column cannot be undone.", 40);
    expect(F.clipReply(wrapsAtEnd, 4, 40).map((r) => text(r.segs) + (r.mark ? ` [${r.mark}]` : ""))).toEqual(["one", "two [… +1 line]", "I have not run it for real, because", "dropping a column cannot be undone."]);
    const paras = Array.from({ length: 7 }, (_, i) => `Paragraph ${i + 1} says a little about what was found, and it is long enough to wrap onto a second row here.`);
    const ask = "So the closing question is a long one too: do you want me to carry on and fix the progress bar, or stop here and open the pull request?";
    const rows = F.replyRows([...paras, ask].join("\n\n"), 92);
    const kept = F.clipReply(rows, 10, 92).map((r) => text(r.segs));
    expect(kept.slice(-2).join(" ")).toBe(ask); // the whole question, on its own rows
    expect(kept.length).toBe(10);
    // A closing paragraph longer than three rows shows its first three, the third ending in …
    const longEnd = F.replyRows([...paras, "word ".repeat(100).trim()].join("\n\n"), 92);
    const end = F.clipReply(longEnd, 10, 92).map((r) => text(r.segs));
    expect(end.slice(-3).map((l) => l.startsWith("word"))).toEqual([true, true, true]);
    expect(end.at(-1)!.endsWith(" …")).toBe(true);
  });

  test("in focus a question longer than three rows is shown whole; out of focus it is three rows at most", () => {
    const question = "Two things before I go on. First, the nightly export is still timing out on the largest customer, and the only fix I can see is to split it per region, which is quick but means the next large customer needs the same treatment by hand. Second, the migration that drops coupon_code is ready, but the promotions table is locked for about four minutes while it runs. Shall I split the export per region now, and may I run the migration tonight at 02:00 when traffic is lowest?";
    const s = sessionOf({ sid: "ask", status: "idle", job: { state: "blocked", detail: "", needs: question } });
    const views = F.buildViews([s], NOW);
    for (const W of [80, 110, 150]) {
      const focused = F.detailView(views, W, 40, NOW, 0, true).map(strip);
      const shown = focused.slice(1).filter((l) => l.startsWith(" ██ ")).map((l) => l.slice(4, F.grid(W).textEnd).trim()).join(" ");
      expect([W, shown.includes(question)]).toEqual([W, true]);
      const normal = F.detailView(views, W, 40, NOW, 0, false).map(strip);
      expect([W, normal.filter((l) => l.startsWith(" ██ ")).length]).toEqual([W, W >= 150 ? 1 + 3 : 1 + 3]);
      // In focus on a screen too short for the whole question, it takes every row it can and is cut there.
      const short = F.detailView(views, W, 5, NOW, 0, true).map(strip);
      expect([W, short.length <= 5, short.filter((l) => l.startsWith(" ██ ")).length]).toEqual([W, true, 5]);
    }
  });

  test("one glyph per step: spaced out up to 10, packed up to 20, scaled to 20 cells beyond", () => {
    const strip = (d: number, r: number, n: number) => text(F.stepStrip(d, r, n));
    expect(strip(2, 1, 6)).toBe("✓ ✓ ◐ ○ ○ ○");
    expect(strip(10, 0, 10)).toBe("✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓ ✓");
    expect(strip(3, 2, 12)).toBe("✓✓✓◐◐○○○○○○○");
    expect(strip(30, 4, 60)).toBe("✓✓✓✓✓✓✓✓✓✓◐○○○○○○○○○");
    expect(F.width(strip(199, 1, 200))).toBe(20);
    expect(strip(0, 0, 0)).toBe("");
    expect(F.stepStrip(1, 1, 3).map((s) => s[1])).toEqual([F.C.green, F.C.white, F.C.faint]);
  });

  test("three sessions at 150 columns: the block the design shows, on the design's columns", () => {
    quietly(() => {
      expect(plan(three(NOW), 150, 38).heights).toEqual([11, 8, 14]);
      const rows = draw(three(NOW), 150, 38);
      expect(rows.length).toBe(35); // 33 rows of sessions and the two blank rows between them
      const at = (line: string, what: string) => line.indexOf(what) + 1; // the 1-based column, as the design counts
      // Title row: thick rail at 2, title from 5, place ending at 104, state ending at 149.
      expect(rows[0]).toBe(" ██ C H E C K O U T   F L O W   R E D E S I G N            work/shop @ feature/checkout-v2 · bg aaaaaaaa                   ▲ N E E D S   Y O U  ·  6m");
      expect(rows[1].slice(0, 105)).toBe(" ██ Approve dropping the legacy coupon_code column before I run the migration?".padEnd(105));
      expect(rows[1]).toMatch(/ tools$/);
      expect(F.width(rows[1])).toBe(149);
      // Body: thin rail, the now-line at 5, then prompt, earlier reply and newest reply with ages ending at 104.
      expect(rows[2].slice(0, 50)).toBe(" ▌  migration drafted and tested against a copy".padEnd(50));
      expect(rows[3].slice(0, 104)).toBe(" ▌  ▸ move coupons to the new promotions table and remove the old column".padEnd(101) + "29m");
      expect(rows[4].slice(0, 104)).toBe(" ▌  ◇ The new promotions table is in place and every read now goes through it. All 212 checkout".padEnd(102) + "7m");
      expect(rows[5]).toBe(" ▌    tests pass.");
      expect(rows[6].slice(0, 104)).toBe(" ▌  ◆ The migration that drops coupon_code is written and has run cleanly against a copy of the".padEnd(102) + "6m");
      expect(rows.slice(7, 11)).toEqual([" ▌    data.", " ▌    • 41,208 rows were copied to promotions", " ▌    • 0 rows differ between the old column and the new table", " ▌    I have not run it for real, because dropping a column cannot be undone."]);
      expect(rows[11]).toBe("");
      // The instruments sit in the lane beside the left stack, from its first row, and cost no row: context bar, key, figures.
      expect(at(rows[2], "░")).toBeGreaterThanOrEqual(107);
      expect(rows[2]).toMatch(/ 37% of 1\.0M$/);
      expect(at(rows[3], "■")).toBe(107);
      expect(at(rows[4], " out")).toBeGreaterThan(107);
      expect(rows[6].length).toBe(104); // nothing beside the fourth row of the stack
      // A promoted prompt is the subheading, with ▸ and its age, and is not repeated below.
      expect(rows[12]).toBe(" ██ D O C S   S I T E   S E A R C H                              work/docs @ main · interactive cccccccc                   ● W O R K I N G  ·  up 22m");
      expect(rows[13].slice(0, 104)).toBe(" ██ ▸ why does search miss pages added this week?".padEnd(101) + "29m");
      expect(rows.filter((r) => r.includes("why does search miss")).length).toBe(1);
      // Roster: label 7-48, action from 51, type and model ending at 104, age ending at 149.
      expect(rows[16].slice(0, 59)).toBe(" ▌  ⠋ main thread                                 thinking ");
      expect(rows[17].slice(0, 104)).toBe(" ▌  ⠋ Find where the search index is built        thinking".padEnd(89) + "Explore · haiku");
      expect(rows[18].slice(0, 104)).toBe(" ▌  ◐ Measure index build time on a full deploy   Bash  Build the site with the index …   general · opus");
      expect(rows[17]).toMatch(/ {9}live$/);
      expect(rows[18]).toMatch(/ {11}3m$/);
      expect(rows[19]).toBe(" ▌  ✓ 1 agent finished in the last 30m  ·  d lists them");
      for (const r of rows.slice(16, 19)) expect(F.width(r)).toBe(149);
      // The busy block: tasks row, main thread on a tool (its action runs to 104), workflow with trail and strip, agents indented 2.
      expect(rows[21]).toBe(" ██ F L A K Y   T E S T   H U N T                           work/shop @ fix/flaky-payments · bg bbbbbbbb                  ● W O R K I N G  ·  up 1h04");
      expect(rows[22].slice(0, 66)).toBe(" ██ bisecting the three payment tests that fail one run in twenty ");
      expect(rows[29]).toBe(" ▌  ✓ ✓ ◐ ○ ○ ○  2/6  Fixing the clock-dependent tests");
      expect(rows[30].slice(0, 98)).toBe(" ▌  ◐ main thread                                 Workflow  Bisect and fix the flaky payment tests".padEnd(98));
      expect(rows[31].slice(0, 104)).toBe(" ▌  ≡ bisect-and-fix                              ✓ Reproduce  ◐ Fix                      ✓ ✓ ◐ ◐ ◐  2/5");
      expect(rows[31]).toMatch(/ up 14m$/);
      expect(rows[32].slice(0, 104)).toBe(" ▌    ⠋ fix:retry-backoff                         thinking".padEnd(100) + "opus");
      expect(rows[34].slice(0, 104)).toBe(" ▌    ◐ review:clock-in-refund                    Bash  Run the refund tests 200 times…             opus");
      // No tree lines and no word labels anywhere.
      for (const r of rows) expect(r).not.toMatch(/[├└]|claude ▸|you {4}▸|context |tasks |phase /);
    });
  });

  test("34 rows: only steps 1 to 3 of the ladder are needed, and every session keeps its prompt, its newest reply, its tasks and every thread", () => {
    quietly(() => {
      const p = plan(three(NOW), 150, 30);
      expect(p.heights).toEqual([9, 7, 12]);
      expect(p.gaps).toBe(true);
      expect(p.rows).toBe(30);
      expect(p.blocks.map((b) => b.keep.earlier)).toEqual([[0], [], [0]]); // earlier replies went (4 rows)…
      expect(p.blocks.map((b) => b.keep.done)).toEqual([false, false, false]); // …and the finished-agents line (1)
      for (const b of p.blocks) expect([b.keep.reply, b.keep.main || !b.v.showMain, b.keep.fold, b.keep.agents, b.keep.roster]).toEqual([10, true, false, Infinity, true]);
      expect(p.blocks.map((b) => b.keep.prompt)).toEqual([1, 0, 1]); // the middle one's prompt is its subheading
      expect(p.blocks[0].keep.now).toBe(true);
      const rows = draw(three(NOW), 150, 30);
      expect(rows.length).toBe(30);
      expect(rows.join("\n")).not.toContain("◇");
      expect(rows.join("\n")).not.toContain("finished in the last");
      expect(rows.filter((r) => r.includes("main thread")).length).toBe(2);
    });
  });

  test("six sessions in 38 rows: the squeezed five-row block, the waiting session's seven rows, and the top two with their agents", () => {
    quietly(() => {
      const p = plan(six(NOW), 150, 38);
      expect(p.heights).toEqual([7, 8, 8, 5, 5, 5]);
      expect(p.gaps).toBe(false);
      expect(p.rows).toBe(38);
      const rows = draw(six(NOW), 150, 38);
      expect(rows.length).toBe(38);
      // The waiting session keeps title, question, prompt and 4 reply lines with its final line.
      expect(rows.slice(2, 7).map((r) => r.slice(0, 98).trimEnd())).toEqual([
        " ▌  ▸ move coupons to the new promotions table and remove the old column",
        " ▌  ◆ The migration that drops coupon_code is written and has run cleanly against a copy of the",
        " ▌    data.",
        " ▌    • 41,208 rows were copied to promotions                                            … +1 line",
        " ▌    I have not run it for real, because dropping a column cannot be undone.",
      ]);
      // The squeezed block: title, subheading with sparkline, one reply line beside the context bar, tasks beside the key, workflow row.
      const squeezed = rows.slice(33, 38);
      expect(squeezed[0]).toContain("O N B O A R D I N G   E M A I L S");
      expect(squeezed[1].slice(0, 66)).toBe(" ██ bisecting the three payment tests that fail one run in twenty ");
      expect(squeezed[2].slice(0, 104)).toBe(" ▌  ◆ Two of the three share a cause: both read the clock twice and assume the same     … +2 lines    2m");
      expect(squeezed[2]).toMatch(/ 61% of 1\.0M$/);
      expect(squeezed[3].slice(0, 107)).toBe(" ▌  ✓ ✓ ◐ ○ ○ ○  2/6  Fixing the clock-dependent tests".padEnd(106) + "■");
      expect(squeezed[4].slice(0, 104)).toBe(" ▌  ≡ bisect-and-fix                              ✓ Reproduce  ◐ Fix                      ✓ ✓ ◐ ◐ ◐  2/5");
      // The rows left over unfold the agents of the top two working sessions, and nobody else's.
      expect(rows.filter((r) => r.includes("fix:retry-backoff")).length).toBe(2);
      expect(rows.slice(7, 15).filter((r) => /fix:|review:/.test(r)).length).toBe(3);
      // Lost: earlier replies, the gaps, the prompts of the working sessions, the main-thread rows.
      expect(rows.join("\n")).not.toContain("◇");
      expect(rows).not.toContain("");
      expect(rows.join("\n")).not.toContain("main thread");
      expect(rows.filter((r) => r.includes("▸ find out why")).length).toBe(0);
    });
  });

  test("rows left over are handed back in reverse order, top session first", () => {
    quietly(() => {
      // Two rows more than the six sessions need: not enough to unfold a third workflow's agents (3 rows),
      // so they go to the step before that, the main-thread row, for the top two working sessions.
      const p = plan(six(NOW), 150, 40);
      expect(p.heights).toEqual([7, 9, 9, 5, 5, 5]);
      expect(p.rows).toBe(40);
      const rows = draw(six(NOW), 150, 40);
      expect(rows.flatMap((r, i) => (r.includes("main thread") ? [i] : []))).toEqual([11, 20]);
      // With every row it could want, nothing is cut and the blank rows are back.
      const roomy = plan(six(NOW), 150, 200);
      expect(roomy.heights).toEqual([11, 14, 14, 14, 14, 14]);
      expect(roomy.gaps).toBe(true);
      // A cut to the newest reply comes back a line at a time.
      const long = busy(NOW);
      long.mains[0].says[1].text = Array.from({ length: 9 }, (_, i) => `Paragraph ${i + 1} of the reply.`).join("\n\n");
      const natural = plan([long], 150, 100).heights[0];
      expect(natural).toBe(20);
      const less2 = plan([long], 150, natural - 2).blocks[0].keep;
      expect([less2.earlier, less2.reply]).toEqual([[0], 10]); // two rows short: the earlier reply goes, the newest is untouched
      const less5 = plan([long], 150, natural - 5).blocks[0].keep;
      expect([less5.earlier, less5.reply]).toEqual([[0], 6]); // five short: capped at 4 by step 4, then the two spare rows handed back as lines
    });
  });

  test("step 5: an agent group longer than 3 folds to its 3 most active, and comes back an agent at a time", () => {
    quietly(() => {
      const quiet = (id: string) => agentOf(id, tailOf([toolCall(NOW - 8 * MIN), toolResult(NOW - 8 * MIN + 900)]));
      const inTool = (id: string) => agentOf(id, tailOf([toolCall(NOW - 3 * MIN)]));
      const live = (id: string) => agentOf(id, tailOf([toolCall(NOW - 5_000), toolResult(NOW - 4_000)]));
      const s = sessionOf({ sid: "many-agents", mains: [tailOf([prompt(NOW - 5 * MIN, "look into it"), reply(NOW - 30_000, "On it.\n\nFirst the logs.")])], agents: [quiet("quiet-1"), quiet("quiet-2"), inTool("tool-1"), quiet("quiet-3"), live("live-1"), inTool("tool-2"), quiet("quiet-4")] });
      const label = (row: string) => row.slice(4, 24).trim().replace(/^[⠋◐○] /, ""); // the row without its state glyph
      const labels = (avail: number, stalled: string[] = []) => {
        const views = F.buildViews([s], NOW);
        views[0].stall = { session: false, threads: stalled, count: stalled.length, since: stalled.length ? NOW - 3 * MIN : 0 };
        return plain(F.detailView(views, 150, avail, NOW, 0, false)).slice(5).map(label);
      };
      // Rows 1 to 5 are the title, the promoted prompt, two reply lines and the main thread. With room, every agent: live, in a tool, then quiet.
      expect(labels(30)).toEqual(["live-1", "tool-1", "tool-2", "quiet-1", "quiet-2", "quiet-3", "quiet-4"]);
      // One row short: the 3 most active and a count. A working agent outranks a quiet one.
      expect(plan([s], 150, 11).blocks[0].keep.agents).toBe(5); // 3, then the two spare rows handed back
      expect(labels(11)).toEqual(["live-1", "tool-1", "tool-2", "quiet-1", "quiet-2", "… 2 more agents"]);
      expect(labels(9)).toEqual(["live-1", "tool-1", "tool-2", "… 4 more agents"]);
      // A stalled agent is the last to be folded away, and keeps its place in the list.
      const mostlyLive = sessionOf({ sid: "live-ones", mains: s.mains, agents: [live("live-1"), live("live-2"), live("live-3"), live("live-4"), live("live-5"), inTool("stuck")] });
      const views = F.buildViews([mostlyLive], NOW);
      views[0].stall = { session: false, threads: ["stuck"], count: 1, since: NOW - 3 * MIN };
      expect(plain(F.detailView(views, 150, 9, NOW, 0, false)).slice(5).map(label)).toEqual(["live-1", "live-2", "stuck", "… 3 more agents"]);
      // A count that would take the row of the one agent it hides is never drawn: four agents stay four.
      const four = sessionOf({ sid: "four", mains: s.mains, agents: [live("live-1"), live("live-2"), live("live-3"), inTool("tool-1")] });
      expect(plain(F.detailView(F.buildViews([four], NOW), 150, 8, NOW, 0, false)).slice(4).map(label)).toEqual(["live-1", "live-2", "live-3", "tool-1"]);
      // Shorter still (step 11): standalone agents fold into one line.
      expect(plain(F.detailView(F.buildViews([s], NOW), 150, 5, NOW, 0, false))[4]).toBe(" ▌  ⠋ 1 live   ◐ 2 in a tool   ○ 4 quiet");
    });
  });

  test("spare rows: a long prompt gets a second line; without them it is one line, cut", () => {
    quietly(() => {
      const long = "find out why the payment tests are flaky and fix them, starting with the three that fail one run in twenty on the build machine but never locally";
      const s = busy(NOW);
      s.mains[0].ask = { text: long, t: NOW - 29 * MIN };
      const first = " ▌  ▸ find out why the payment tests are flaky and fix them, starting with the three that fail one";
      const roomy = draw([s], 150, 40);
      expect(roomy.length).toBe(15);
      expect(roomy.slice(2, 4).map((r) => r.slice(0, 98).trimEnd())).toEqual([first, " ▌    run in twenty on the build machine but never locally"]);
      const exact = draw([s], 150, 14);
      expect(exact[2].slice(0, 98)).toBe(first.slice(0, 97) + "…");
      expect(exact[3]).toContain("◇");
    });
  });

  test("the conversation reads as it happened: a prompt typed after the last reply comes after it", () => {
    quietly(() => {
      const s = busy(NOW);
      const icons = () => draw([s], 150, 40).slice(2, 9).map((r) => r[4]).join("");
      expect(icons()).toBe("▸◇ ◆  ✓"); // asked, said (twice), then the tasks it led to
      s.mains[0].ask = { text: "also check the refund tests", t: NOW - 30_000 };
      expect(icons()).toBe("◇ ◆  ▸✓");
      expect(draw([s], 150, 40)[7].slice(0, 104)).toBe(" ▌  ▸ also check the refund tests".padEnd(101) + "30s");
      // Only the transcript's last-prompt marker: no age, and it leads.
      s.mains[0].ask = undefined;
      s.mains[0].lastPrompt = "find out why the payment tests are flaky";
      expect(draw([s], 150, 40)[2].slice(0, 104).trimEnd()).toBe(" ▌  ▸ find out why the payment tests are flaky");
    });
  });

  test("a workflow that has ended: ✓ or ✗ in place of ≡, and how it ended in place of the trail", () => {
    quietly(() => {
      const s = busy(NOW);
      const ended = (id: string, name: string, status: string, tokens?: number): F.Workflow => ({ ...s.workflows[0], id, name, status, tokens, finished: NOW - 4 * MIN, lastT: NOW - 4 * MIN, agents: s.workflows[0].agents.slice(0, 2) });
      s.workflows = [ended("wf_2", "link-check", "completed", 412_000), ended("wf_3", "reindex-preview", "failed")];
      const raw = F.detailView(F.buildViews([s], NOW), 150, 40, NOW, 0, false);
      const [okRow, badRow] = ["link-check", "reindex-preview"].map((name) => raw.find((r) => r.includes(name))!);
      expect(strip(okRow).slice(0, 104)).toBe(" ▌  ✓ link-check                                  completed · 412k tok                          ✓ ✓  2/2");
      expect(strip(okRow)).toMatch(/ 4m$/);
      expect(strip(badRow).slice(0, 104)).toBe(" ▌  ✗ reindex-preview                             failed                                        ✓ ✓  2/2");
      expect(badRow).toContain(F.fg(F.C.red, "✗"));
      expect(badRow).toContain(F.fg(F.C.red, "failed"));
      expect(okRow).not.toContain("≡");
    });
  });

  test("with no left stack the context row still shows, with the key and the figures on its left", () => {
    quietly(() => {
      const s = sessionOf({ sid: "just-started", mains: [tailOf([{ ...toolCall(NOW - 5_000), message: { ...toolCall(NOW - 5_000).message, usage: { input_tokens: 4, cache_read_input_tokens: 120_000, output_tokens: 200 } } }, toolResult(NOW - 4_000)])] });
      const rows = draw([s], 150, 20);
      expect(rows.length).toBe(4);
      expect(rows[2].slice(0, 104).trimEnd()).toBe(" ▌  ■ Used 120k   200 out");
      expect(rows[2]).toMatch(/[█▌]+░+  12% of 1\.0M$/);
      expect(rows[3].slice(0, 59)).toBe(" ▌  ⠋ main thread                                 thinking ");
      // Step 14 takes the tasks row and then that context row; step 15 the roster. What is left is the two-row card.
      expect(draw([s, waiting(NOW)], 150, 6).filter((r) => r.startsWith(" ▌")).length).toBe(2); // only the waiting session's two reply lines
    });
  });

  test("a session that needs you never gives up its title, its whole question or two lines of the reply", () => {
    quietly(() => {
      for (let avail = 14; avail <= 38; avail++) {
        const p = plan(six(NOW), 150, avail);
        const rows = draw(six(NOW), 150, avail);
        expect(rows.length).toBeLessThanOrEqual(avail);
        expect(p.blocks[0].folded).toBe(false);
        expect(rows[0]).toContain("N E E D S   Y O U");
        expect(rows[1]).toContain("Approve dropping the legacy coupon_code column before I run the migration?");
        expect(rows[2] + rows[3]).toContain("The migration that drops coupon_code");
        expect(p.blocks[0].keep.reply).toBeGreaterThanOrEqual(2);
      }
      // At 110 columns the question wraps to two rows instead of being cut, and both stay.
      const narrow = draw(six(NOW), 110, 16);
      expect(narrow.slice(1, 3).map((r) => r.slice(0, 77).trim())).toEqual(["██ Approve dropping the legacy coupon_code column before I run the", "██ migration?"]);
    });
  });

  test("whole sessions fold into one line from the bottom, never one that needs you", () => {
    quietly(() => {
      const p = plan(six(NOW), 150, 9);
      expect(p.blocks.map((b) => b.folded)).toEqual([false, false, false, true, true, true]);
      const rows = draw(six(NOW), 150, 9);
      expect(rows.length).toBe(9);
      expect(rows[8]).toBe(" … 3 more: billing export, upgrade tooling, onboarding emails");
      expect(rows.slice(4, 8).map((r) => r.slice(0, 4))).toEqual([" ██ ", " ██ ", " ██ ", " ██ "]); // what is left of the working ones: title and subheading, a small far card
      // Before a session folds it has given up everything but its two head rows.
      expect(plan(six(NOW), 150, 14).heights).toEqual([4, 2, 2, 2, 2, 2]);
      // Too small even for the ladder: the waiting session is the last to go, and is still named.
      expect(draw(six(NOW), 150, 1)).toEqual([" … 6 more: ▲ checkout flow redesign, flaky test hunt, search reindex, billing export, upgrade tooling, onboarding emails"]);
      expect(draw(six(NOW), 150, 0)).toEqual([]);
    });
  });

  test("the renderer never returns more rows than it was given, nor a row wider than the screen, at any size", () => {
    quietly(() => {
      const idle = sessionOf({ sid: "eeeeeeee-0005", name: "release notes draft", status: "idle", kind: "interactive", mains: [tailOf([prompt(NOW - 29 * MIN, "draft the release notes"), reply(NOW - 12 * MIN, "The draft is in `docs/releases/4.2.md`. Shall I open a pull request with it?")])] });
      const sets: [string, F.Session[], boolean][] = [["three", three(NOW), false], ["six", six(NOW), false], ["with a quiet one", [...three(NOW), idle], true], ["one", [busy(NOW)], false], ["none", [], false]];
      for (const [name, sessions, all] of sets)
        for (const W of [60, 80, 99, 100, 110, 129, 130, 150, 200])
          for (let avail = 0; avail <= 60; avail++)
            for (const focus of sessions.length === 1 ? [false, true] : [false]) {
              const views = F.buildViews(sessions, NOW).filter((v) => all || !F.isHidden(v));
              const g = F.grid(W);
              const blocks = views.map((v) => F.blockOf(v, g, NOW, F.laneWindow(NOW, W), focus));
              const fit = F.fitBlocks(blocks, g, avail, NOW);
              const rows = F.detailView(views, W, avail, NOW, 0, focus).map(strip);
              const where = `${name} at ${W}x${avail}${focus ? " in focus" : ""}`;
              if (rows.length > avail) throw new Error(`${where}: ${rows.length} rows`);
              if (avail > 0 && views.length && rows.length !== fit.rows) throw new Error(`${where}: drew ${rows.length} rows but planned ${fit.rows}`);
              for (const r of rows) {
                if (Bun.stringWidth(r) > W) throw new Error(`${where}: a row ${Bun.stringWidth(r)} cells wide: ${r}`);
                if (/undefined|NaN/.test(r)) throw new Error(`${where}: ${r}`);
                if (r.trim() && r[0] !== " ") throw new Error(`${where}: column 1 is not blank: ${r}`);
              }
            }
    });
  });

  test("110 columns: the instruments become one row under the head, the conversation runs the full width, a workflow shows its current phase", () => {
    quietly(() => {
      expect(plan(three(NOW), 110, 38).heights).toEqual([12, 9, 15]); // the whole screen at 110 by 44, nothing dropped
      const rows = draw(three(NOW), 110, 38);
      expect(rows.length).toBe(38);
      expect(rows[0]).toBe(" ██ C H E C K O U T   F L O W   R E D E S I G N    shop @ feature/checkout-v2      ▲ N E E D S   Y O U  ·  6m"); // the place lost its kind and id, then its parent folder
      expect(rows[2].trimEnd()).toBe(" ██ migration?");
      expect(rows[3]).toMatch(/^ ▌  [▌█░]{20}  37% of 1\.0M   ■ Used 372k   \S+ out$/);
      expect(rows[4]).toBe(" ▌  migration drafted and tested against a copy");
      expect(rows[5]).toBe(" ▌  ▸ move coupons to the new promotions table and remove the old column".padEnd(106) + "29m"); // ages end at 109
      expect(rows[6]).toBe(" ▌  ◇ The new promotions table is in place and every read now goes through it. All 212 checkout tests".padEnd(107) + "7m");
      expect(rows[8]).toBe(" ▌  ◆ The migration that drops coupon_code is written and has run cleanly against a copy of the data.".padEnd(107) + "6m");
      const wf = rows.find((r) => r.includes("bisect-and-fix"))!;
      expect(wf.slice(0, 77)).toBe(" ▌  ≡ bisect-and-fix                        ◐ Fix              ✓ ✓ ◐ ◐ ◐  2/5"); // label 7-42, action 45-77, no passed phases
      const tool = rows.find((r) => r.includes("review:clock-in-refund"))!;
      expect(tool.slice(0, 77)).toBe(" ▌    ◐ review:clock-in-refund              Bash  Run the refund tests 200 t…");
      expect(tool).not.toContain("opus"); // the type-and-model column is dropped
      for (const r of rows) expect(F.width(r)).toBeLessThanOrEqual(109);
      // Under 100 columns the place leaves the title row and agent rows lose the action column.
      const small = draw(three(NOW), 90, 60);
      expect(small[0]).toBe(" ██ C H E C K O U T   F L O W   R E D E S I G N                ▲ N E E D S   Y O U  ·  6m");
      expect(small.find((r) => r.includes("review:clock-in-refund"))).not.toContain("Bash");
      // Above 150 the lane stays 30 cells and the measure stops at 96.
      const wide = draw(three(NOW), 200, 60);
      expect(wide[6].indexOf("6m") + 2).toBe(154);
      expect(wide[5].slice(0, 150).trimEnd()).toBe(" ▌    pass."); // the first line of that reply filled the measure: 96 cells, to column 102
      expect(wide[4].slice(0, 150).trimEnd().length).toBeLessThanOrEqual(102);
    });
  });

  test("idle, finished and your-turn sessions shown with a: the two head rows only, title in text colour", () => {
    quietly(() => {
      const turn = sessionOf({ sid: "eeeeeeee-0005", name: "release notes draft", status: "idle", kind: "interactive", cwd: "/work/docs", mains: [tailOf(on("docs/release-4.2", [prompt(NOW - 29 * MIN, "draft the release notes for 4.2"), ...calls(12, NOW - 13 * MIN), reply(NOW - 12 * MIN - 20_000, "The draft is in `docs/releases/4.2.md`: 14 changes under Features, Fixes and Upgrading.\n\nShall I open a pull request with it?")]))] });
      const done = sessionOf({ sid: "dddddddd-0004", name: "rename billing module", status: "idle", mains: [tailOf([reply(NOW - 50 * MIN, "Merged.")])], job: { state: "done", detail: "merged", needs: "" } });
      const views = F.buildViews([busy(NOW), turn, done], NOW);
      expect(views.map((v) => [v.state, v.quiet])).toEqual([["working", false], ["yourTurn", true], ["finished", true]]);
      const raw = F.detailView(views, 150, 60, NOW, 0, false);
      const rows = plain(raw);
      expect(rows.length).toBe(14 + 1 + 2 + 1 + 2);
      expect(rows[15]).toBe(" ██ R E L E A S E   N O T E S   D R A F T            work/docs @ docs/release-4.2 · interactive eeeeeeee                  ▸ Y O U R   T U R N  ·  12m");
      expect(rows[16].slice(0, 104).trimEnd()).toBe(" ██ ◆ The draft is in docs/releases/4.2.md: 14 changes under Features, Fixes and Upgrading.");
      expect(rows[18]).toContain("✓ F I N I S H E D");
      expect(rows[19].slice(0, 104)).toBe(" ██ ◆ Merged.".padEnd(101) + "50m");
      const bold = (c: F.RGB, s: string) => F.bold(F.fg(c, s));
      expect(raw[15]).toContain(bold(F.C.text, "R E L E A S E   N O T E S   D R A F T")); // text colour, not white
      expect(raw[0]).toContain(bold(F.C.white, "F L A K Y   T E S T   H U N T"));
      expect(raw[15]).toContain(F.fg(F.C.blue, "██")); // your turn is blue
      // In focus the same session gets its body: the prompt and the whole reply.
      const focused = plain(F.detailView([views[1]], 150, 60, NOW, 0, true));
      expect(focused.slice(2).map((r) => r.slice(0, 98).trimEnd())).toEqual([
        " ▌  ▸ draft the release notes for 4.2",
        " ▌  ◆ The draft is in docs/releases/4.2.md: 14 changes under Features, Fixes and Upgrading.",
        " ▌",
        " ▌    Shall I open a pull request with it?",
      ]);
    });
  });

  test("a quiet session with no reply and no now-line shows its last prompt, not an empty row", () => {
    quietly(() => {
      const idle = sessionOf({ sid: "ffffffff-0006", name: "scratch", status: "idle", kind: "interactive", mains: [tailOf([prompt(NOW - 48 * MIN, "what does the totals helper round to?")])] });
      const views = F.buildViews([idle], NOW);
      expect([views[0].state, views[0].quiet]).toEqual(["idle", true]);
      const rows = plain(F.detailView(views, 150, 20, NOW, 0, false));
      expect(rows.length).toBe(2);
      expect(rows[1].slice(0, 104)).toBe(" ██ ▸ what does the totals helper round to?".padEnd(101) + "48m");
    });
  });

  test("a reply is formatted once, and again when its text changes", () => {
    quietly(() => {
      const s = busy(NOW);
      const views = () => F.buildViews([s], NOW);
      const g = F.grid(150);
      const first = F.blockOf(views()[0], g, NOW, F.laneWindow(NOW, 150));
      const second = F.blockOf(views()[0], g, NOW, F.laneWindow(NOW, 150));
      expect(second.newest!.rows).toBe(first.newest!.rows); // the same rows, not an equal copy
      expect(F.blockOf(views()[0], F.grid(110), NOW, F.laneWindow(NOW, 110)).newest!.rows).not.toBe(first.newest!.rows); // another width is another wrap
      s.mains[0].says[1].text = "Something else entirely.";
      expect(draw([s], 150, 40).some((r) => r.includes("◆ Something else entirely."))).toBe(true);
    });
  });

  test("focus: one session takes the screen, with every stored reply in full and every agent", () => {
    quietly(() => {
      const s = busy(NOW);
      const said = (n: number) => `Reply ${n}, first paragraph.\n\n- a bullet in reply ${n}\n- another\n\nReply ${n}, last paragraph.`;
      s.mains[0].says = [1, 2, 3, 4, 5, 6].map((n) => ({ text: said(n), t: NOW - (8 - n) * MIN }));
      const views = F.buildViews([s], NOW);
      const all = plain(F.detailView(views, 150, 80, NOW, 0, true));
      for (let n = 1; n <= 6; n++) for (const part of [`Reply ${n}, first paragraph.`, `• a bullet in reply ${n}`, `Reply ${n}, last paragraph.`]) expect(all.filter((r) => r.includes(part)).length).toBe(1);
      expect(all.filter((r) => r.includes("◇")).length).toBe(5);
      expect(all.filter((r) => r.slice(0, 104).trimEnd() === " ▌").length).toBe(12); // a blank row between paragraphs
      expect(all.filter((r) => /fix:|review:/.test(r)).length).toBe(3);
      // Outside focus the dashboard shows the two before the newest, flattened, and the newest formatted.
      const dash = plain(F.detailView(views, 150, 80, NOW, 0, false));
      expect(dash.filter((r) => r.includes("◇")).length).toBe(2);
      expect(dash.join("\n")).not.toContain("Reply 3");
      expect(dash.some((r) => r.includes("◇ Reply 5, first paragraph. • a bullet in reply 5 • another Reply 5, last paragraph."))).toBe(true);
      // When even one session is too much for the screen, focus comes back down the same ladder: oldest replies first.
      const tight = plain(F.detailView(views, 150, 24, NOW, 0, true));
      expect(tight.length).toBeLessThanOrEqual(24);
      expect(tight.join("\n")).not.toContain("Reply 1,");
      expect(tight.some((r) => r.includes("Reply 6, last paragraph."))).toBe(true);
    });
  });

  test("new since you looked, a stalled thread and the runway each show where the design puts them", () => {
    const before = F.seen.at;
    try {
      const s = busy(NOW);
      F.seen.at = NOW - 3 * MIN; // you looked three minutes ago: the newest reply (2m) is new, the one before it (3m) is not
      const views = F.buildViews([s], NOW);
      const raw = F.detailView(views, 150, 40, NOW, 0, false);
      const rows = plain(raw);
      const newest = rows.findIndex((r) => r.includes("◆ Two of the three"));
      expect(rows[newest].slice(0, 104)).toMatch(/ new$/);
      expect(raw[newest]).toContain(F.bold(F.fg(F.C.white, "◆")));
      expect(raw[newest]).toContain(F.bold(F.fg(F.C.white, "new")));
      expect(rows[rows.findIndex((r) => r.includes("◇ Three tests"))].slice(0, 104)).toMatch(/ 3m$/);
      // A thread the stall watch has marked: red ◐ and age, and its action says so first.
      views[0].stall = { session: false, threads: ["w5"], count: 1, since: NOW - 4 * MIN };
      views[0].state = "stalled";
      const stalled = F.detailView(views, 150, 40, NOW, 0, false);
      const row = stalled.find((r) => r.includes("review:clock-in-refund"))!;
      expect(strip(row).slice(0, 104)).toBe(" ▌    ◐ review:clock-in-refund                    stalled? Bash  Run the refund tests …             opus");
      expect(row).toContain(F.fg(F.C.red, "◐"));
      expect(row).toContain(F.bold(F.fg(F.C.red, "stalled? ")));
      expect(row).toContain(F.bold(F.fg(F.C.red, "4m")));
      expect(strip(stalled[0])).toMatch(/◐ S T A L L E D \?  ·  4m$/);
      expect(stalled[0]).toContain(F.fg(F.C.red, "██"));
      // The runway sits at the right end of the key row, and the key gives way to it.
      const growing = busy(NOW);
      growing.mains[0].ctxLog = Array.from({ length: 11 }, (_, i): [number, number] => [NOW - (10 - i) * MIN, 611_000 - 97_500 + i * 9_750]);
      const key = plain(F.detailView(F.buildViews([growing], NOW), 150, 40, NOW, 0, false))[3];
      expect(key).toMatch(/■ Used \d+k {2,}full in ~40m$/);
      expect(F.width(key)).toBe(149);
    } finally {
      F.seen.at = before;
    }
  });

  test("render() draws detail mode with this view and leaves compact mode's tree alone", () => {
    const before = { ...F.opt };
    try {
      F.opt.mode = "detail";
      const detail = F.render(three(NOW), 150, 44, NOW).map(strip);
      expect(detail.length).toBe(44);
      expect(detail.some((r) => r.startsWith(" ██ C H E C K O U T   F L O W   R E D E S I G N"))).toBe(true);
      expect(detail.some((r) => r.startsWith(" ▌  ≡ bisect-and-fix"))).toBe(true);
      expect(detail.join("\n")).not.toMatch(/[├└]/);
      F.opt.mode = "compact";
      const compact = F.render(three(NOW), 150, 44, NOW).map(strip);
      expect(compact.join("\n")).toMatch(/[├└]─/);
      expect(compact.join("\n")).not.toContain("C H E C K O U T");
    } finally {
      Object.assign(F.opt, before);
    }
  });

  test("both head rows of a session are click targets that focus it", () => {
    quietly(() => {
      const sessions = three(NOW);
      F.detailView(viewsOf(sessions, NOW), 150, 38, NOW, 5);
      const targets = F.clickTargets().filter((h) => h.act.startsWith("focus:"));
      expect(targets.slice(-6).map((h) => [h.row, h.act])).toEqual([
        [6, "focus:aaaaaaaa-0001"], [7, "focus:aaaaaaaa-0001"],
        [18, "focus:cccccccc-0003"], [19, "focus:cccccccc-0003"],
        [27, "focus:bbbbbbbb-0002"], [28, "focus:bbbbbbbb-0002"],
      ]);
      for (const h of targets.slice(-6)) expect([h.x0, h.x1]).toEqual([1, 150]);
    });
  });
});

describe("one program: the header, the sessions and the buttons agree", () => {
  const MODES: F.Mode[] = ["detail", "compact", "far"];
  /** Tool calls spread over the 33 minutes before `end`, so some fall off the far edge of every window on the screen. */
  const calls = (count: number, end: number, seed: number) => callTimes(count, end, 33, seed).flatMap((t, i) => [toolCall(t, "Read", {}, `c${seed}-${i}`), toolResult(t + 900)]);
  /** A fleet with every kind of row: a session that needs you, one running a workflow with tasks, one with two agents, and an idle one that has been busy inside the window. */
  function fleet(now: number): F.Session[] {
    const member = (id: string, seed: number, done = false) => agentOf(id, tailOf(calls(14, now - (done ? 12 * MIN : 20_000), seed)), { label: `fix:${id}`, type: "workflow-subagent", model: "opus", wf: "wf_1", phase: "Fix", done });
    const wf: F.Workflow = { id: "wf_1", name: "bisect-and-fix", status: "running", phase: "Fix", phases: [], seen: ["Reproduce", "Fix"], started: now - 14 * MIN, finished: 0, agents: [member("w1", 21, true), member("w2", 22), member("w3", 23)], lastT: now };
    return [
      sessionOf({ sid: "aaaaaaaa", name: "checkout flow redesign", status: "idle", mains: [tailOf([prompt(now - 29 * MIN, "move coupons to the new table"), ...calls(46, now - 7 * MIN, 7), reply(now - 6 * MIN, "The migration is written.\n- 41,208 rows were copied\n- 0 rows differ")])], job: { state: "blocked", detail: "migration drafted", needs: "Approve dropping the legacy coupon_code column before I run the migration?" } }),
      sessionOf({ sid: "bbbbbbbb", name: "flaky test hunt", mains: [tailOf([prompt(now - 29 * MIN, "why are the tests flaky?"), ...calls(60, now - 3 * MIN, 11), reply(now - 2 * MIN, "Two of the three share a cause.")])], workflows: [wf], job: { state: "working", detail: "bisecting the payment tests", needs: "" }, tasks: { done: 2, doing: 1, total: 6, active: "Fixing the clock-dependent tests" } }),
      sessionOf({ sid: "cccccccc", name: "docs site search", kind: "interactive", startedAt: now - 22 * MIN, mains: [tailOf([prompt(now - 29 * MIN, "why does search miss new pages?"), ...calls(18, now - 60_000, 3), reply(now - 55_000, "Search is built from an index that is only regenerated on release.")])], agents: [agentOf("s1", tailOf(calls(22, now - 20_000, 5)), { label: "Find where the index is built" }), agentOf("s2", tailOf([...calls(9, now - 4 * MIN, 9), toolCall(now - 3 * MIN, "Bash", { description: "Build the site" })]), { label: "Measure the build" })] }),
      sessionOf({ sid: "dddddddd", name: "release notes", kind: "interactive", status: "idle", mains: [tailOf([prompt(now - 31 * MIN, "draft the release notes"), ...calls(12, now - 12 * MIN, 13), reply(now - 12 * MIN, "The draft is ready.")])] }),
    ];
  }
  /** One frame as plain text, on a quiet machine with nothing new since you looked; every global is put back afterwards. */
  function frame(mode: F.Mode, cols: number, rows: number, now = NOW, all = true, sessions = fleet(now)): string[] {
    const saved = { opt: { ...F.opt }, machine: { ...F.machine }, seen: { ...F.seen } };
    Object.assign(F.opt, { mode, usage: false, windowMin: 30, showAll: all, showDone: false });
    Object.assign(F.machine, { cpu: 54, load: 14.6, cores: [58, 62, 49, 44], hist: [6, 7, 8, 22, 54], procs: [], kids: new Map() });
    Object.assign(F.seen, { at: now, events: [], known: new Map(), primed: true });
    try {
      return F.render(sessions, cols, rows, now).map(strip);
    } finally {
      Object.assign(F.opt, saved.opt);
      Object.assign(F.machine, saved.machine);
      Object.assign(F.seen, saved.seen);
    }
  }

  test("at every width from 100 columns, every sparkline sits in the header's lane and every figure ends on its figure column", () => {
    for (let W = 100; W <= 230; W++)
      for (const rows of [34, 44]) {
        const g = F.grid(W);
        const lines = frame("detail", W, rows);
        const where = `${W}x${rows}`;
        // The rule under the header is the time axis: the window at the lane's left edge, "now" at its right.
        const axis = lines[rows >= 40 ? 4 : 2];
        expect([where, axis.slice(g.lane - 1, g.lane + 2), axis.slice(g.laneEnd - 3, g.laneEnd)]).toEqual([where, "30m", "now"]);
        // A full strip of bars is as wide as the lane and nothing else on the screen is: find each, wherever it was drawn.
        const strips = lines.flatMap((line, i) => [...line.matchAll(new RegExp(`[${F.BARS}]{${g.laneW},}`, "g"))].map((m) => ({ i, at: m.index! + 1, w: m[0].length })));
        expect([where, [...new Set(strips.map((x) => `${x.at}+${x.w}`))]]).toEqual([where, [`${g.lane}+${g.laneW}`]]);
        const head = strips.filter((x) => x.i < (rows >= 40 ? 4 : 2)).length;
        expect([where, head, strips.length - head >= 4 + 6]).toEqual([where, 1, true]); // the fleet chart's bottom row; then four sessions and six thread rows
        // Beside each strip, the figure (a total, an age, "live") ends on the figure field's last column, one short of the edge.
        for (const x of strips) expect([where, x.i, lines[x.i].padEnd(W)[g.figEnd - 1] !== " ", lines[x.i].padEnd(W)[g.figEnd]]).toEqual([where, x.i, true, " "]);
      }
  });

  test("the header's total is the sum of the sessions' own figures, in every mode and wherever the bars' edges fall", () => {
    const sumOf = (lines: string[], figure: RegExp) => F.sum(lines.flatMap((line) => [...line.matchAll(figure)].map((m) => Number(m[1]))));
    // The clock moves through a whole minute, so each window's far edge sweeps across the oldest calls.
    for (let now = NOW; now < NOW + MIN; now += 7000) {
      for (const W of [110, 150, 200]) {
        const detail = frame("detail", W, 60, now);
        expect([now, W, sumOf(detail.slice(5), / (\d+) tools\s*$/g)]).toEqual([now, W, sumOf(detail.slice(1, 2), / (\d+) tools$/g)]);
        const far = frame("far", W, 60, now);
        expect([now, W, sumOf(far.slice(5), / (\d+) tool calls \/ 30m/g)]).toEqual([now, W, sumOf(far.slice(1, 2), / (\d+) tools$/g)]);
        // Detail and far count on the same bars, so a figure does not change when the view does.
        expect(sumOf(far.slice(1, 2), / (\d+) tools$/g)).toBe(sumOf(detail.slice(1, 2), / (\d+) tools$/g));
      }
      const compact = frame("compact", 200, 60, now);
      const total = sumOf(compact.slice(0, 1), / (\d+) tool calls \/ 30m/g);
      expect(total).toBeGreaterThan(100);
      expect([now, sumOf(compact.slice(3), / (\d+) tools /g)]).toEqual([now, total]);
    }
  });

  test("the masthead counts the sessions the screen shows, and the a button carries the ones it keeps off", () => {
    const lines = frame("detail", 150, 44, NOW, false);
    expect(lines[0]).toContain("▲ 1 needs you    ● 2 working    ⠋ 4 agents    ≡ 1 workflow    ○ 1 idle");
    expect(lines.filter((l) => l.startsWith(" ██ ")).length).toBe(3 * 2); // three sessions on screen, two head rows each
    expect(lines[43]).toContain(" a All · 1 idle ");
    expect(lines.join("\n")).not.toContain("hidden"); // the line that used to say so is gone from every mode
    for (const mode of MODES) expect([mode, frame(mode, 150, 44, NOW, false).join("\n").includes("hidden")]).toEqual([mode, false]);

    // "In the window" means one thing on a frame. An agent that last wrote just before the lane's first bar (but under 30 minutes ago)
    // is past the left edge of every sparkline, so it is neither counted in the masthead nor given a row; one bar later it is both.
    const edge = F.laneWindow(NOW, 150).start;
    expect(NOW - 30 * MIN).toBeLessThan(edge - 10_000);
    const withAgent = (lastWrite: number) => {
      const sessions = fleet(NOW);
      sessions[2].agents.push(agentOf("s9", Object.assign(tailOf([]), { mtime: lastWrite }), { label: "Check the release log" }));
      const text = frame("detail", 150, 44, NOW, false, sessions);
      return [/(\d+) agents/.exec(text[0])![1], text.some((l) => l.includes("Check the release log"))];
    };
    expect([withAgent(edge - 10_000), withAgent(edge + 10_000)]).toEqual([["4", false], ["5", true]]);
    // The frame's window is the lane's in detail and far mode, and the rows' own shorter strips in compact mode.
    expect([F.frameWindow(NOW, 150, "detail"), F.frameWindow(NOW, 150, "far"), F.frameWindow(NOW, 110, "detail").n, F.frameWindow(NOW, 150, "compact").n]).toEqual([F.laneWindow(NOW, 150), F.laneWindow(NOW, 150), 20, 25]);
  });

  test("tab walks the sessions in the order the screen lists them, and passes over the ones it keeps off", () => {
    const saved = { ...F.opt };
    try {
      // On disk the sessions come in no particular order: here the idle one first and the one that needs you last.
      const sessions = [...fleet(NOW)].reverse();
      const walk = (all: boolean) => {
        Object.assign(F.opt, { mode: "detail", windowMin: 30, showAll: all });
        const seen: (string | null)[] = [];
        for (let at: string | null = null, i = 0; i < 6; i++) seen.push((at = F.nextFocus(sessions, NOW, 150, at)));
        return seen;
      };
      expect(walk(false)).toEqual(["aaaaaaaa", "cccccccc", "bbbbbbbb", null, "aaaaaaaa", "cccccccc"]); // needs you, then the working ones, newest first; then back to the whole fleet
      expect(walk(true).slice(0, 5)).toEqual(["aaaaaaaa", "cccccccc", "bbbbbbbb", "dddddddd", null]);
      // A session focused by a click and since gone quiet still has a place to step on from.
      Object.assign(F.opt, { showAll: false });
      expect(F.nextFocus(sessions, NOW, 150, "dddddddd")).toBe(null);
      expect(F.nextFocus([], NOW, 150, null)).toBe(null);
    } finally {
      Object.assign(F.opt, saved);
    }
  });

  test("detail mode's rows run down to the buttons; compact rows and far cards keep one row clear above them", () => {
    // Enough sessions to fill any screen: the row above the button bar is a session's in detail mode, blank in the other two.
    const crowd = (now: number) => [...fleet(now), ...fleet(now).map((s) => ({ ...s, sid: s.sid + "-2" })), ...fleet(now).map((s) => ({ ...s, sid: s.sid + "-3" }))];
    const saved = { ...F.opt };
    try {
      for (const [cols, rows] of [[150, 34], [150, 44], [110, 44], [200, 60]]) {
        const at = (mode: F.Mode) => (Object.assign(F.opt, { mode, usage: false, windowMin: 30, showAll: true }), F.render(crowd(NOW), cols, rows, NOW).map(strip));
        expect([cols, rows, at("detail")[rows - 2].trim() !== "", at("compact")[rows - 2].trim(), at("far")[rows - 2].trim()]).toEqual([cols, rows, true, "", ""]);
        for (const mode of MODES) expect(at(mode).length).toBe(rows);
      }
    } finally {
      Object.assign(F.opt, saved);
    }
  });

  test("compact mode cuts a session only when one does not fit, and says so on a row of its own", () => {
    const views = () => F.buildViews(fleet(NOW), NOW);
    const need = F.sum(views().map(F.rowsOf));
    expect(need).toBe(1 + 1 + (1 + 1 + 2) + (1 + 2) + 1); // a row each, the question, a workflow and its two running agents, two agents
    expect(F.fitViews(views(), need + 3)).toMatchObject({ gaps: true, cut: 0 });
    expect(F.fitViews(views(), need)).toMatchObject({ gaps: false, cut: 0 }); // exactly full is not too full
    const tight = F.fitViews(views(), need - 1);
    expect([tight.cut > 0, tight.views.length + tight.cut, F.sum(tight.views.map(F.rowsOf)) + 1 <= need - 1]).toEqual([true, 4, true]); // what is left, and the line that says the rest are not shown
  });

  test("no mode draws a retired glyph, one of the old word labels or the old approximate sign", () => {
    for (const mode of MODES)
      for (const [cols, rows] of [[80, 24], [110, 44], [150, 44], [200, 60]])
        for (const all of [false, true]) {
          const text = frame(mode, cols, rows, NOW, all).join("\n");
          const where = `${mode} ${cols}x${rows}`;
          expect([where, text.match(/[⚠⚙⎇▪◈▤┆≈]/)?.[0]]).toEqual([where, undefined]);
          expect([where, text.match(/context [█▌░]|now +▸|you +▸|claude +▸|tasks [✓◐○]|phase |\? needs you|\(d to list\)/)?.[0]]).toEqual([where, undefined]);
        }
  });

  test("a terminal narrower than the layout was made for cuts its rows at the edge: none wraps, at any size", () => {
    const row = F.fg(F.C.cyan, "abc") + F.bold("def") + `\x1b[48;2;52;38;0m${F.fg(F.C.white, "ghi")}\x1b[49m`;
    expect([F.clipRow(row, 9), F.clipRow(row, 40)]).toEqual([row, row]);
    expect([strip(F.clipRow(row, 5)), strip(F.clipRow(row, 1)), strip(F.clipRow(row, 0))]).toEqual(["abcde", "a", ""]);
    // Every code is kept, so a cut row leaves no colour, bold or background switched on.
    expect(F.clipRow(row, 2).match(/\x1b\[[0-9;]*m/g)).toEqual(row.match(/\x1b\[[0-9;]*m/g));
    expect(strip(F.clipRow("日本語", 3))).toBe("日"); // a wide character that does not fit is left out whole
    for (const mode of MODES)
      for (let cols = 20; cols < 80; cols += 3)
        for (const rows of [1, 2, 3, 8, 24]) {
          const lines = frame(mode, cols, rows);
          expect([mode, cols, rows, lines.length, Math.max(...lines.map((l) => Bun.stringWidth(l))) <= cols]).toEqual([mode, cols, rows, rows, true]);
        }
    const key = F.legend(40, 12);
    expect([key.length, Math.max(...key.map((l) => Bun.stringWidth(strip(l)))) <= 40]).toEqual([12, true]);
  });
});

describe("demo", () => {
  const FIXED = String(NOW);
  const SLOW = 60_000; // these start processes; allow for a busy machine
  /** One frame of the demo as plain text, with a pinned clock. */
  const demo = (args: string[], cols = 200, rows = 60) => {
    const r = Bun.spawnSync(["bun", path.join(here, "demo.ts"), "--once", ...args], { env: { ...process.env, FLEET_NOW: FIXED, TZ: "UTC", COLUMNS: String(cols), LINES: String(rows) }, timeout: 30_000 });
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
    return r.stdout.toString();
  };
  /** Lower case with the spaces out, so a word is found however a renderer letter-spaces or pads it. */
  const squash = (frame: string) => strip(frame).toLowerCase().replace(/[ \t]/g, "");

  test("a pinned clock gives the same frame every time, and --once never touches the terminal title", () => {
    const a = demo(["--surprise"], 150, 44);
    const b = demo(["--surprise"], 150, 44);
    expect(a).toBe(b);
    expect(a).not.toContain("\x1b]"); // no title sequence
    expect(a.split("\n").length).toBe(45); // 44 rows and the final line break
    expect(strip(a).split("\n")[0]).toContain("23:51:22"); // the pinned clock, in the UTC the demo is run in here
  }, SLOW);

  test("the default demo is today's three sessions with one finished job kept off the screen", () => {
    const frame = squash(demo([]));
    for (const name of ["checkoutflowredesign", "flakytesthunt", "docssitesearch"]) expect(frame).toContain(name);
    expect(frame).not.toContain("searchreindex");
    expect(frame).not.toContain("stalled?");
    expect(frame).not.toContain("fullin~");
    expect(frame).toContain("aall·1idle");
    expect(frame).toContain("212%bun"); // the made-up machine: without --usage the account block lists its busiest processes
    expect(frame).not.toContain("hidden"); // the line that named the hidden sessions is gone; the a button carries their count
  }, SLOW);

  test("--surprise shows a stalled agent, a context forecast and things new since you looked", () => {
    const frame = squash(demo(["--surprise"]));
    expect(frame).toContain("stalled?");
    expect(frame).toContain("fullin~40m");
    expect(frame).toMatch(/seen·\d+new/);
    expect(frame).toContain("86%"); // the 5-hour limit that runs out before it resets
  }, SLOW);

  test("--six, --all and --ended add their sessions and workflows", () => {
    const sixFrame = squash(demo(["--six", "--mode", "compact"]));
    for (const name of ["checkoutflow", "flakytesthunt", "searchreindex", "billingexport", "upgradetooling", "onboardingemails"]) expect(sixFrame).toContain(name);
    const allFrame = squash(demo(["--all", "--ended", "--mode", "compact"]));
    for (const name of ["releasenotesdraft", "scratch", "renamebillingmodule", "link-check", "reindex-preview", "completed", "failed", "412ktok"]) expect(allFrame).toContain(name);
    expect(allFrame).toContain("aall·3idle");
  }, SLOW);

  test("--account shows each account state without a real account", () => {
    const frame = Object.fromEntries(["current", "extra-off", "stale", "none", "remote"].map((a) => [a, squash(demo(["--account", a]))]));
    expect(frame.current).toContain("38%");
    expect(frame.current).toContain("£12of£50");
    expect(frame.current).not.toContain("uretryusage");
    expect(frame["extra-off"]).toContain("12%"); // the Opus week, returned only here
    expect(frame.stale).toContain("anthropicanswered429");
    expect(frame.stale).toMatch(/asof\d\d:\d\d/);
    expect(frame.none).toContain("keychain:noanswerin5s");
    expect(frame.none).not.toContain("unlock-keychain");
    expect(frame.remote).toContain("keychain:closedtoremote");
    expect(frame.remote).toContain("uretryusage");
    expect(frame.remote).toContain("securityunlock-keychain~/library/keychains/login.keychain-db"); // the remedy
  }, SLOW);
});

describe("the login stays inside the process", () => {
  // The whole usage read, entry point included, with stand-ins for the two things it must not touch here:
  // a made-up `security` first (and alone) on PATH, and a preload that answers every fetch(). The "login" is a
  // made-up word, so if it leaks anywhere it can be found by searching for it.
  const CANARY = "CANARY-LOGIN-0000";
  const dir = path.join(SCRATCH, "login-e2e");
  const bin = path.join(dir, "bin");
  const log = path.join(dir, "calls.log");
  const cache = path.join(dir, "cache");
  const login = JSON.stringify({ claudeAiOauth: { accessToken: CANARY, refreshToken: CANARY + "-refresh", expiresAt: 99999999999999 } });
  const setUp = () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.join(dir, "home", "sessions"), { recursive: true });
    // On a Mac the dashboard asks the keychain tool; elsewhere it reads the login file. Both are made up here.
    fs.writeFileSync(path.join(bin, "security"), `#!/bin/sh\necho "security $*" >> "$CALLS_LOG"\nprintf '%s\\n' '${login}'\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "home", ".credentials.json"), login);
    fs.writeFileSync(path.join(dir, "machine.json"), JSON.stringify({ cpu: 5, cores: [5, 5], hist: [5], memTotal: 1000, memUsed: 100, load: 1, procs: [] }));
    fs.writeFileSync(
      path.join(dir, "preload.ts"),
      `import * as fs from "node:fs";
(globalThis as any).fetch = async (url: any, init: any = {}) => {
  const auth = String(init?.headers?.Authorization ?? "");
  fs.appendFileSync(process.env.CALLS_LOG!, "fetch " + JSON.stringify({ url: String(url), auth: auth === "Bearer ${CANARY}" ? "the login" : auth ? "something else" : "none", verbose: init.verbose }) + "\\n");
  const status = Number(process.env.FAKE_STATUS);
  // An answer that repeats the login back in places that are not figures: none of it may be kept.
  if (status === 200) return Response.json({ five_hour: { utilization: 38, resets_at: new Date(Date.now() + 130 * 60000).toISOString(), echo: "${CANARY}" }, seven_day: { utilization: 21, resets_at: new Date(Date.now() + 3 * 86400000).toISOString() }, access_token: "${CANARY}", account: { token: "${CANARY}" } });
  return new Response(JSON.stringify({ error: { message: "${CANARY} was rejected" } }), { status });
};
`,
    );
  };
  const run = (args: string[], status = 200, extra: Record<string, string> = {}) => {
    fs.rmSync(log, { force: true });
    fs.rmSync(cache, { recursive: true, force: true });
    const r = Bun.spawnSync([process.execPath, "--preload", path.join(dir, "preload.ts"), path.join(here, "fleet.ts"), "--once", ...args], {
      env: { PATH: bin, HOME: path.join(dir, "nobody"), TZ: "UTC", COLUMNS: "150", LINES: "12", FLEET_HOME: path.join(dir, "home"), XDG_CACHE_HOME: cache, FLEET_MACHINE_FIXTURE: path.join(dir, "machine.json"), CALLS_LOG: log, FAKE_STATUS: String(status), ...extra },
      timeout: 30_000,
    });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
    const written: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) e.isDirectory() ? walk(path.join(d, e.name)) : written.push(path.join(d, e.name));
    };
    walk(cache);
    const ours = written.filter((f) => !f.startsWith(path.join(cache, "bun") + path.sep)); // all but the runtime's own cache of compiled scripts
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString(), security: calls.filter((c) => c.startsWith("security ")), fetches: calls.filter((c) => c.startsWith("fetch ")).map((c) => JSON.parse(c.slice(6))), ours, everything: r.stdout.toString() + r.stderr.toString() + written.map((f) => fs.readFileSync(f, "latin1")).join("") };
  };

  test("a working read: one request, to Anthropic, with the runtime's request printing turned off; the login is not printed or saved", () => {
    setUp();
    // BUN_CONFIG_VERBOSE_FETCH=curl makes the runtime print every request as a curl command, Authorization header and all, unless the request says no.
    const r = run(["--usage"], 200, { BUN_CONFIG_VERBOSE_FETCH: "curl" });
    expect(r.code).toBe(0);
    expect(strip(r.out)).toContain("38%");
    if (process.platform === "darwin") expect(r.security).toEqual(["security find-generic-password -s Claude Code-credentials -w"]);
    expect(r.fetches).toEqual([{ url: "https://api.anthropic.com/api/oauth/usage", auth: "the login", verbose: false }]);
    expect(r.everything).not.toContain(CANARY);
    expect(r.err).toBe("");
    expect(r.out).not.toContain("\x1b]"); // and no title either
    // The one file written: figures and when they were fetched, readable only by its owner.
    expect(r.ours).toEqual([path.join(cache, "claude-fleet", "usage.json")]);
    expect(fs.statSync(r.ours[0]).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(fs.readFileSync(r.ours[0], "utf8"))).sort()).toEqual(["fetchedAt", "five_hour", "seven_day"]);
  }, 60_000);

  test("a refused read says so exactly, and still neither prints nor saves anything of the login or the answer", () => {
    setUp();
    for (const status of [401, 429]) {
      const r = run(["--usage"], status);
      expect(strip(r.out)).toContain(`✗ Anthropic answered ${status}`); // the header's account line: the exact reason, behind a red ✗
      expect(r.fetches.length).toBe(1);
      expect(r.everything).not.toContain(CANARY);
      expect(r.ours).toEqual([]);
    }
  }, 60_000);

  test("without --usage the keychain is not asked and no request is made, in any mode", () => {
    setUp();
    for (const mode of ["detail", "compact", "far"]) {
      const r = run(["--mode", mode]);
      expect(r.code).toBe(0);
      expect([r.security, r.fetches, r.ours]).toEqual([[], [], []]);
    }
  }, 60_000);
});

/**
 * The live dashboard on a pseudo-terminal, against the demo's made-up sessions and a pinned clock. `after()`
 * is what has been written since the screen was last cleared: every change of view clears it and draws in full.
 */
async function liveDemo(args: string[] = [], cols = 150, rows = 44) {
  let out = "";
  const proc = Bun.spawn([process.execPath, path.join(here, "demo.ts"), ...args], {
    env: { ...process.env, TZ: "UTC", FLEET_NOW: String(NOW) },
    terminal: { cols, rows, data: (_t: unknown, d: Uint8Array) => void (out += new TextDecoder().decode(d)) },
  } as any);
  const t = (proc as any).terminal;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let exited = false;
  void proc.exited.then(() => (exited = true));
  const until = async (ok: () => boolean, ms = 15_000) => {
    for (const end = Date.now() + ms; Date.now() < end && !ok(); ) await sleep(25);
    return ok();
  };
  await until(() => out.includes("q Quit"));
  return {
    write: (s: string) => t.write(s),
    sleep,
    until,
    all: () => out,
    after: () => out.slice(out.lastIndexOf("\x1b[2J")),
    alive: () => !exited,
    stop: async () => {
      if (!exited) proc.kill();
      await proc.exited;
    },
  };
}

describe("keys and clicks", () => {
  test("a read is split into keys, left-button presses and sequences that do nothing; a sequence cut off at the end is kept for the next read", () => {
    const keys = (s: string) => F.inputEvents(s).events.map((e) => (e.kind === "key" ? e.key : e.kind === "press" ? `press ${e.col},${e.row}` : "other"));
    expect(keys("q")).toEqual(["q"]);
    expect(keys("23")).toEqual(["2", "3"]); // two keys that arrived together both count
    expect(keys("++")).toEqual(["+", "+"]);
    expect(keys("\x1b[<0;108;44M")).toEqual(["press 108,44"]);
    expect(keys("\x1b[<0;108;44m")).toEqual(["other"]); // the release of the same click
    expect(keys("\x1b[<0;108;44M\x1b[<0;108;44m")).toEqual(["press 108,44", "other"]);
    expect(keys("\x1b[<64;10;10M\x1b[<2;10;10M")).toEqual(["other", "other"]); // the wheel, the right button
    expect(keys("\x1b[A\x1bOP\x1b[5~\x1b[I")).toEqual(["other", "other", "other", "other"]); // arrow, F1, page down, focus in
    expect(keys("\x1bx")).toEqual(["other"]); // alt+x
    expect(keys("\x1b\x1b")).toEqual(["\x1b"]); // two escapes: the first is Esc, the second may yet begin a sequence
    expect(F.inputEvents("\x1b\x1b").rest).toBe("\x1b");
    for (const cut of ["\x1b", "\x1b[", "\x1b[<0;40", "\x1bO"]) expect(F.inputEvents("a" + cut)).toEqual({ events: [{ kind: "key", key: "a" }], rest: cut });
    expect(F.inputEvents("\x1b[<0;40;6M").rest).toBe("");
  });

  test("- and + step to the next listed window, from any window given on the command line", () => {
    expect([F.stepWindow(30, -1), F.stepWindow(30, 1)]).toEqual([15, 60]);
    expect([F.stepWindow(5, -1), F.stepWindow(180, 1)]).toEqual([5, 180]);
    expect([F.stepWindow(10, -1), F.stepWindow(10, 1)]).toEqual([5, 15]); // never the wrong way
    expect([F.stepWindow(120, -1), F.stepWindow(120, 1)]).toEqual([60, 180]);
    expect([F.stepWindow(1, -1), F.stepWindow(1, 1)]).toEqual([1, 5]);
    expect([F.stepWindow(45, -1), F.stepWindow(45, 1)]).toEqual([30, 60]);
    expect([F.stepWindow(300, -1), F.stepWindow(300, 1)]).toEqual([180, 300]);
  });

  test("live: a click on the legend button keeps the legend up after the button is let go; two keys in one read both act", async () => {
    const saved = { events: F.seen.events };
    F.seen.events = [];
    F.buttonBar(150, 44, 1); // the bar the live demo draws: one idle session kept off the screen, nothing new yet
    F.seen.events = saved.events;
    const button = F.clickTargets().filter((h) => h.act === "legend").pop()!;
    const live = await liveDemo();
    try {
      live.write(`\x1b[<0;${button.x0 + 2};${button.row}M`);
      expect(await live.until(() => live.after().includes("returns to the fleet"))).toBe(true);
      await live.sleep(150);
      live.write(`\x1b[<0;${button.x0 + 2};${button.row}m`); // the release, in a read of its own, as a real click sends it
      await live.sleep(1500); // a redraw or two
      expect(live.after()).toContain("returns to the fleet");
      live.write("x"); // any key closes it
      expect(await live.until(() => live.after().includes("q Quit"))).toBe(true);
      live.write("++"); // 30m, 60m, 180m
      expect(await live.until(() => strip(live.after()).includes(" 180m "))).toBe(true);
      live.write("\x1b"); // an arrow key whose escape arrived on its own: not a bare Esc, which would quit
      await live.sleep(10);
      live.write("[A");
      await live.sleep(400);
      expect(live.alive()).toBe(true);
      live.write("aq"); // q in a read with another key still quits
      expect(await live.until(() => !live.alive(), 5000)).toBe(true);
      // …and gives the terminal back: the title saved on entry is popped, mouse reports off, the main screen back.
      expect(live.all().startsWith("\x1b[22;0t")).toBe(true);
      expect(live.all()).toContain(F.leaveScreen(true));
    } finally {
      await live.stop();
    }
  }, 60_000);
});

describe("the demo never reads the real login", () => {
  // A made-up `security` alone on PATH (beside bun itself) records every call. Whatever usage switch is given, the demo,
  // the frame checker and the screenshots must draw made-up figures and never ask it.
  const dir = path.join(SCRATCH, "demo-login");
  const bin = path.join(dir, "bin");
  const log = path.join(dir, "calls.log");
  const setUp = () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "security"), `#!/bin/sh\necho "security $*" >> "$CALLS_LOG"\nexit 44\n`, { mode: 0o755 });
    fs.symlinkSync(process.execPath, path.join(bin, "bun"));
  };
  const run = (cmd: string[], extra: Record<string, string> = {}) => {
    fs.rmSync(log, { force: true });
    const r = Bun.spawnSync(cmd, { env: { PATH: bin, HOME: path.join(dir, "nobody"), TZ: "UTC", FLEET_NOW: String(NOW), COLUMNS: "150", LINES: "44", CALLS_LOG: log, ...extra }, timeout: 60_000 });
    return { code: r.exitCode, out: strip(r.stdout.toString()), err: r.stderr.toString(), calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [] };
  };

  test("bun demo.ts --usage, or FLEET_USAGE=1 in the environment, shows the made-up account and asks nothing", () => {
    setUp();
    for (const [args, extra] of [[["--usage"], {}], [[], { FLEET_USAGE: "1" }], [["--usage"], { FLEET_USAGE: "1", FLEET_USAGE_FIXTURE: "", FLEET_USAGE_FAIL: "" }]] as [string[], Record<string, string>][]) {
      const r = run([path.join(bin, "bun"), path.join(here, "demo.ts"), "--once", ...args], extra);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(r.calls).toEqual([]);
      expect(r.out).toContain("£12 of £50"); // the made-up current account
    }
  }, 60_000);

  test("the frame checker with FLEET_USAGE=1 asks nothing either", () => {
    setUp();
    const r = run([path.join(bin, "bun"), path.join(here, "tools", "check-frames"), "--only", "default-detail-150x44"], { FLEET_USAGE: "1" });
    expect(r.out).toContain("1 frames fit");
    expect(r.calls).toEqual([]);
  }, 60_000);

  test("this test file runs with the usage switch taken out of its environment", () => {
    expect(process.env.FLEET_USAGE).toBeUndefined();
  });
});

/**
 * Whether fleet.ts is looking at the throwaway home this file set up, and not at the real ~/.claude.
 * Asked in a way that is harmless when the answer is no: a made-up job's state file exists only in the
 * throwaway home, and the one thing read is that file's path under whichever home is in force.
 */
function homeIsScratch(): boolean {
  const home = process.env.FLEET_HOME!;
  if (!home.startsWith(SCRATCH)) return false;
  fs.mkdirSync(path.join(home, "jobs", "probe-job"), { recursive: true });
  fs.writeFileSync(path.join(home, "jobs", "probe-job", "state.json"), JSON.stringify({ state: "done" }));
  const saved = { ...F.seen, events: [...F.seen.events], known: new Map(F.seen.known) };
  Object.assign(F.seen, { at: NOW, events: [], known: new Map(), primed: false });
  try {
    const job = sessionOf({ sid: "probe", status: "idle", jobId: "probe-job", job: { state: "working", detail: "", needs: "" } });
    F.noteScan([job], NOW); // with no reader passed, a job's state is read from the home
    F.noteScan([], NOW + 2000); // the session has gone: how did its job end?
    return F.seen.events.some((e) => e.kind === "sessionDone");
  } finally {
    Object.assign(F.seen, saved);
  }
}

describe("the tests never look at the real home", () => {
  test("FLEET_HOME is read when it is used, so pointing it at a throwaway directory after the import takes effect", () => {
    expect(homeIsScratch()).toBe(true);
  });
});

describe("safe text holds against anything", () => {
  // Text that tries everything: colour and title escape sequences, a bell, a backspace, a NUL, C1 controls,
  // emoji joined and flagged, CJK, full-width Latin and money signs, combining marks, a right-to-left
  // override, zero-width and line-separator characters, lone Hangul vowels, and one very long word.
  const EVIL = "\x1b[31mRED\x1b[0m\x1b]2;pwned\x07 \x07\x08\r\x00 \t👨‍👩‍👧‍👦✅❌⚠️🇬🇧1️⃣ 日本語テキスト ＡＢＣ￥１００ é́ ‮gnp.exe ​  한국어 가 ☰ ︐ \x9b31m " + "W".repeat(400);
  /** Cells as the runtime counts them, which is not fleet's own table: charWidth() must not mark its own homework. */
  const drawn = (s: string) => Bun.stringWidth(s);

  test("nothing survives as a double-width character, whatever the codepoint", () => {
    const wide: string[] = [];
    for (let cp = 0x20; cp <= 0x3ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const s = F.safeText(String.fromCodePoint(cp));
      if (drawn(s) > [...s].length) wide.push("U+" + cp.toString(16).toUpperCase());
    }
    expect([wide.length, ...wide.slice(0, 8)]).toEqual([0]);
  });

  test("full-width money signs become ordinary ones, other wide characters become ?, and a lone Hangul vowel (which fills no cell) goes", () => {
    expect(F.safeText("￥１００ ￡５ ￠ ￢ ￣ ￤ ￦")).toBe("¥100 £5 ¢ ¬ ¯ ¦ ₩");
    expect(F.safeText("☰ ︐ ꥠ 𗀀 𛀀")).toBe("? ? ? ? ?");
    expect(F.safeText("aᅡbᆨcힰd")).toBe("abcd");
    for (const ch of ["￥", "︐", "ꥠ", "𗀀", "𛀀"]) expect(F.width(ch)).toBe(2); // fleet's own table agrees they are wide
    const safe = F.safeLine(EVIL);
    expect(drawn(safe)).toBe([...safe].length);
    expect(safe).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });

  test("a process's name is made safe like any other text that comes from outside", () => {
    expect(F.procName("/Applications/Some App.app/Contents/MacOS/Some App")).toBe("Some App");
    expect(F.procName(" bun ")).toBe("bun");
    const name = F.procName("/opt/\x1b[41m日本語アプリ🙂\x1b]2;pwned\x07\x07");
    expect(name).toBe("??????"); // six wide characters; the picture and both escape sequences are gone
    expect(F.procName("ｔｓｃ￥\t✅")).toBe("tsc¥ ✓");
  });

  test("wrap and fit always return, and never give a line wider than asked, even for a width of nothing", () => {
    const text = F.safeLine(EVIL);
    for (const w of [1, 2, 7, 37, 96]) {
      const lines = F.wrap(text, w);
      expect(lines.join("").replace(/ /g, "")).toBe(text.replace(/ /g, "")); // nothing lost, nothing added
      expect(Math.max(...lines.map(drawn))).toBeLessThanOrEqual(w);
      expect(drawn(F.fit(text, w))).toBe(w);
    }
    // A width of zero or less used to loop for ever; so did a character wider than the width.
    expect(F.wrap("hello world", 0)).toEqual(["h", "e", "l", "l", "o", "w", "o", "r", "l", "d"]);
    expect(F.wrap("hello", -3).length).toBe(5);
    expect(F.wrap("日本", 1)).toEqual(["日", "本"]);

    expect(F.fit(text, 0)).toBe("");
  });

  /** Sessions on disk whose every piece of text is hostile, read back through scan() as a real home would be. */
  function hostileHome(): F.Session[] {
    if (!homeIsScratch()) throw new Error("fleet.ts is not looking at the throwaway home: refusing to scan");
    const home = process.env.FLEET_HOME!;
    const put = (file: string, data: string, t = NOW - 20_000) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
      fs.utimesSync(file, new Date(t), new Date(t));
    };
    const lines = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    fs.rmSync(path.join(home, "sessions"), { recursive: true, force: true });
    fs.rmSync(path.join(home, "projects"), { recursive: true, force: true });
    const talk = (extra: object[] = []) => [
      { type: "ai-title", aiTitle: EVIL },
      { ...prompt(NOW - 29 * MIN, EVIL), gitBranch: EVIL },
      ...callTimes(40, NOW - MIN).map((t) => toolCall(t, EVIL, { description: EVIL })),
      { type: "system", subtype: "away_summary", timestamp: iso(NOW - 3 * MIN), content: EVIL },
      reply(NOW - 2 * MIN, `# ${EVIL}\n\n- ${EVIL}\n- **bold** and \`code\`\n\n| a | b |\n|---|---|\n| ${EVIL} | 2 |\n\n${EVIL}`, 611_000),
      ...extra,
    ];
    [
      { n: 1, sid: "aaaaaaaa-evil", status: "idle", job: { state: "blocked", detail: EVIL, needs: EVIL }, rows: talk() },
      { n: 2, sid: "bbbbbbbb-evil", status: "busy", job: undefined, rows: talk([toolCall(NOW - 30_000, "AskUserQuestion", { questions: [{ question: EVIL }] })]) },
      { n: 3, sid: "cccccccc-evil", status: "busy", job: { state: "working", detail: EVIL, needs: "" }, rows: talk() },
      { n: 4, sid: "dddddddd-evil", status: "idle", job: undefined, rows: talk() }, // your turn: kept off the screen without --all
    ].forEach(({ n, sid, status, job, rows }) => {
      put(path.join(home, "sessions", `${n}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, name: EVIL, kind: EVIL, status, cwd: `/work/${EVIL}/shop`, jobId: job ? `evil${n}` : undefined, startedAt: NOW - 64 * MIN }));
      if (job) put(path.join(home, "jobs", `evil${n}`, "state.json"), JSON.stringify(job));
      const dir = path.join(home, "projects", "-evil", sid);
      put(dir + ".jsonl", lines(rows));
      put(path.join(home, "tasks", sid, "1.json"), JSON.stringify({ id: "1", subject: EVIL, activeForm: EVIL, status: "in_progress" }));
      put(path.join(home, "tasks", sid, "2.json"), JSON.stringify({ id: "2", subject: EVIL, status: "pending" }));
      for (const id of ["s1", "s2"]) {
        put(path.join(dir, "subagents", `agent-${id}.jsonl`), lines(callTimes(12, NOW - 30_000).map((t) => toolCall(t, EVIL, { description: EVIL }))));
        put(path.join(dir, "subagents", `agent-${id}.meta.json`), JSON.stringify({ agentType: EVIL, model: EVIL, description: EVIL }));
      }
      const wf = path.join(dir, "subagents", "workflows", "wf_evil");
      put(path.join(dir, "workflows", "scripts", "bisect-wf_evil.js"), "");
      put(path.join(wf, "journal.jsonl"), lines([{ type: "launched" }, ...["w1", "w2"].map((id) => ({ type: "started", agentId: id, label: EVIL, phase: `${id} ${EVIL}` }))]));
      for (const id of ["w1", "w2"]) {
        put(path.join(wf, `agent-${id}.jsonl`), lines(callTimes(9, NOW - 30_000).map((t) => toolCall(t, EVIL, { file_path: `/x/${EVIL}` }))));
        put(path.join(wf, `agent-${id}.meta.json`), JSON.stringify({ agentType: "workflow-subagent", model: EVIL, workflowPhase: EVIL }));
      }
    });
    return F.scan(NOW);
  }

  test("whatever the sessions, tasks, workflows and processes say, every frame keeps its size and no control character reaches the terminal", () => {
    const sessions = hostileHome();
    expect(sessions.length).toBe(4);
    expect(sessions.every((s) => s.agents.length === 2 && s.workflows.length === 1 && s.workflows[0].agents.length === 2 && s.tasks?.total === 2)).toBe(true);
    const saved = { opt: { ...F.opt }, procs: F.machine.procs, cores: F.machine.cores };
    F.machine.procs = [{ pid: 1, ppid: 0, cpu: 212, rss: 1, name: F.procName("/opt/" + EVIL) }, { pid: 2, ppid: 0, cpu: 88, rss: 1, name: F.procName("ｔｓｃ￥") }];
    F.machine.cores = [50, 60, 70, 80];
    const problems: string[] = [];
    try {
      for (const showAll of [false, true])
        for (const [cols, rows] of [[80, 24], [100, 30], [110, 44], [130, 40], [150, 34], [150, 44], [200, 60]])
          for (const mode of ["detail", "compact", "far"] as F.Mode[]) {
            Object.assign(F.opt, { mode, showAll, usage: false });
            const frame = F.render(sessions, cols, rows, NOW);
            const where = `${mode} ${cols}x${rows}${showAll ? " --all" : ""}`;
            if (frame.length !== rows) problems.push(`${where}: ${frame.length} rows`);
            frame.map(strip).forEach((line, i) => {
              if (drawn(line) > cols) problems.push(`${where}: row ${i + 1} is ${drawn(line)} cells`);
              if (/[\x00-\x1f\x7f-\x9f]/.test(line)) problems.push(`${where}: row ${i + 1} has a control character`);
              if (/undefined|NaN/.test(line)) problems.push(`${where}: row ${i + 1} shows undefined or NaN`);
            });
          }
    } finally {
      Object.assign(F.opt, saved.opt);
      Object.assign(F.machine, { procs: saved.procs, cores: saved.cores });
    }
    expect(problems).toEqual([]);
  });
});

describe("stall watch and news under rough conditions", () => {
  const noJobs = () => undefined;
  const resetSeen = (at: number) => Object.assign(F.seen, { at, events: [], known: new Map(), primed: false });
  /** A thread holding a tool call, silent for `min` minutes before NOW. */
  const stuckFor = (min: number) => tailOf([toolCall(NOW - min * MIN)]);
  const kinds = () => F.seen.events.map((e) => e.kind).sort().join(",");
  /** Run `body` with the session's process tree at `cpu` percent. */
  const withCpu = <T>(pid: number, cpu: number, body: () => T): T => {
    const saved = { procs: F.machine.procs, kids: F.machine.kids };
    F.machine.procs = [{ pid, ppid: 1, cpu, rss: 1, name: "claude" }];
    F.machine.kids = new Map();
    try {
      return body();
    } finally {
      Object.assign(F.machine, saved);
    }
  };

  test("a stalled agent stays on the screen when its silence is longer than the window: it is the thing to look at", () => {
    const before = { ...F.opt };
    try {
      F.opt.windowMin = 5; // the shortest window; the agent has been silent for 14 minutes
      const wf: F.Workflow = { id: "wf_1", name: "bisect-and-fix", status: "running", phase: "Fix", phases: [], seen: ["Fix"], started: NOW - 30 * MIN, finished: 0, agents: [agentOf("w5", stuckFor(14), { wf: "wf_1", label: "review:clock-in-refund" })], lastT: NOW - 14 * MIN };
      const s = sessionOf({ sid: "b", pid: 4242, name: "flaky test hunt", mains: [stuckFor(1)], agents: [agentOf("s1", stuckFor(14), { label: "measure build time" }), agentOf("old", tailOf([toolCall(NOW - 20 * MIN), toolResult(NOW - 19 * MIN)]))], workflows: [wf] });
      withCpu(4242, 0.2, () => {
        const v = F.buildViews([s], NOW)[0];
        expect([v.state, [...v.stall.threads].sort()]).toEqual(["stalled", ["s1", "w5"]]);
        expect(v.groups.flatMap((g) => g.rows.map((a) => a.id)).sort()).toEqual(["s1", "w5"]); // the quiet, unstalled one has aged out; these two have not
        expect(v.groups.some((g) => g.wf?.id === "wf_1")).toBe(true);
        const frame = F.render([s], 150, 30, NOW).map(strip).join("\n");
        expect(frame).toContain("review:clock-in-refund");
        expect(frame).toContain("measure build time");
        expect(frame.match(/stalled\? Bash/g)?.length).toBe(2);
      });
    } finally {
      Object.assign(F.opt, before);
    }
  });

  test("one silence is one stall: the tree's CPU flickering either side of 1% does not ring or report it again", () => {
    const agent = agentOf("review", stuckFor(9.5));
    const s = sessionOf({ sid: "b", pid: 77, mains: [stuckFor(0.5)], agents: [agent] });
    const known = new Map<string, number>();
    let rings = 0;
    const scanAt = (t: number, cpu: number) =>
      withCpu(77, cpu, () => {
        const f = F.factsOf(s);
        rings += F.newStalls(known, F.stallMarks(s, f, F.stallOf(s, f, t))).length;
        F.noteScan([s], t, noJobs);
      });
    resetSeen(NOW);
    scanAt(NOW, 0.2); // 9.5 minutes of silence: not yet
    expect([rings, kinds()]).toEqual([0, ""]);
    [0.2, 1.4, 0.3, 2.0, 0.1, 0.9].forEach((cpu, i) => scanAt(NOW + MIN + i * 2000, cpu)); // stalled, clear, stalled, clear, stalled, stalled
    expect([rings, kinds()]).toEqual([1, "stalled"]);
    expect(F.seen.events[0]).toMatchObject({ key: "stall:b/review", t: NOW + 30_000 }); // when it crossed ten minutes
    expect(F.stallMarks(s, F.factsOf(s), { session: false, threads: ["review"], count: 1, since: NOW - 9.5 * MIN })).toEqual([["b/review", NOW - 9.5 * MIN]]);

    // It gets its answer, calls another tool, and that one hangs too: a new silence, so a new stall.
    F.ingest(agent.tail, JSON.stringify(toolResult(NOW + 2 * MIN)));
    F.ingest(agent.tail, JSON.stringify(toolCall(NOW + 2 * MIN + 1000)));
    scanAt(NOW + 3 * MIN, 0.2);
    expect([rings, kinds()]).toEqual([1, "stalled"]);
    F.ingest(s.mains[0], JSON.stringify(toolCall(NOW + 12.5 * MIN))); // the main thread is still at work, so only the agent is stuck
    scanAt(NOW + 13 * MIN, 0.2);
    scanAt(NOW + 13 * MIN + 2000, 0.2);
    expect([rings, kinds()]).toEqual([2, "stalled,stalled"]);

    // A whole session gone quiet, with nothing outstanding, is known by its own name.
    const silent = sessionOf({ sid: "c", pid: 77, mains: [tailOf([toolCall(NOW - 12 * MIN), toolResult(NOW - 12 * MIN + 1)])] });
    const marks = withCpu(77, 0, () => F.stallMarks(silent, F.factsOf(silent), F.stallOf(silent, F.factsOf(silent), NOW)));
    expect(marks).toEqual([["c", NOW - 12 * MIN + 1]]);
    expect([F.newStalls(known, marks), F.newStalls(known, marks)]).toEqual([["c"], []]);
  });

  test("a stall on show is held while the tree idles either side of 1%, and let go when it is properly busy or the thread writes", () => {
    const agent = agentOf("review", stuckFor(14));
    const s = sessionOf({ sid: "b", pid: 77, mains: [stuckFor(0.5)], agents: [agent] });
    const held = new Map<string, number>();
    /** One scan with the tree at `cpu`: the verdict the screen would show, then what refresh() remembers for the next. */
    const scanAt = (cpu: number) =>
      withCpu(77, cpu, () => {
        F.holdStalls([s], NOW, held);
        return F.stallOf(s, F.factsOf(s), NOW, undefined, undefined, held).threads.join();
      });
    expect([0.2, 1.4, 0.3, 2.0, 4.9].map(scanAt)).toEqual(["review", "review", "review", "review", "review"]); // under 1% to begin, under 5% to stay
    expect([...held]).toEqual([["b/review", NOW - 14 * MIN]]);
    expect([5, 1.4, 0.9].map(scanAt)).toEqual(["", "", "review"]); // busy lets it go; after that it takes under 1% again
    // Without the memory of the last scan the rule is the plain one, as the tests above use it.
    expect(withCpu(77, 1.4, () => F.stallOf(s, F.factsOf(s), NOW, undefined, undefined, new Map()).count)).toBe(0);
    // It writes again and falls silent on a new tool call: that is a different silence, which starts from under 1% like any other.
    F.ingest(agent.tail, JSON.stringify(toolResult(NOW - 12 * MIN)));
    F.ingest(agent.tail, JSON.stringify(toolCall(NOW - 11 * MIN)));
    expect([1.4, 0.5, 1.4].map(scanAt)).toEqual(["", "review", "review"]);
    // A whole session gone quiet is held by its own name, and its main thread with it.
    const silent = sessionOf({ sid: "c", pid: 77, mains: [stuckFor(12)] });
    const verdict = (cpu: number) =>
      withCpu(77, cpu, () => {
        F.holdStalls([silent], NOW, held);
        const st = F.stallOf(silent, F.factsOf(silent), NOW, undefined, undefined, held);
        return [st.session, st.threads.join()];
      });
    expect([verdict(0.4), verdict(1.8), verdict(7)]).toEqual([[true, "main"], [true, "main"], [false, ""]]);
    expect(held.size).toBe(0);
  });

  test("the bell for a question rings once, even when its session is missing from one scan", () => {
    const waiting = new Set<string>();
    const asked = new Map<string, number>();
    const ring = (current: [string, number][]) => F.newAsks(waiting, asked, current);
    expect(ring([["a", NOW - 6 * MIN]])).toEqual(["a"]);
    expect(ring([["a", NOW - 6 * MIN]])).toEqual([]); // still waiting
    expect(ring([])).toEqual([]); // its registry file was caught half-written: the session is missing from this scan
    expect(ring([["a", NOW - 6 * MIN]])).toEqual([]); // back, with the same question: it has not asked again
    expect(ring([["a", NOW - 6 * MIN], ["b", NOW]])).toEqual(["b"]);
    expect(ring([["a", NOW - 5 * MIN], ["b", NOW]])).toEqual([]); // its transcript was touched while it waited: the same wait, not a new one
    expect(ring([["b", NOW]])).toEqual([]); // a was answered
    expect(ring([["a", NOW + MIN], ["b", NOW]])).toEqual(["a"]); // and has asked something new
    // The time a question was asked is the time the state rail and the news list use for it.
    const s = sessionOf({ sid: "q", status: "idle", mains: [tailOf([toolCall(NOW - 6 * MIN, "AskUserQuestion", { questions: [{ question: "Merge it?" }] })])] });
    expect(F.stateSince(s, F.factsOf(s), "needs")).toBe(NOW - 6 * MIN);
  });

  test("a session that drops out of one scan and comes back is not news a second time", () => {
    resetSeen(NOW);
    const main = tailOf([reply(NOW - 3 * MIN, "Old.")], "/p/a.jsonl");
    const agent = agentOf("s1", tailOf([toolCall(NOW - MIN)], "/p/s1.jsonl"));
    const wf: F.Workflow = { id: "wf_1", name: "w", status: "running", phase: "", phases: [], seen: [], started: NOW - 20 * MIN, finished: 0, agents: [], lastT: NOW - MIN };
    const s = sessionOf({ sid: "a", mains: [main], agents: [agent], workflows: [wf] });
    F.noteScan([s], NOW, noJobs);
    // Two replies in one message carry one timestamp, and are two replies.
    const twice = { ...reply(NOW + 500, "First part."), message: { id: "x", model: "claude-opus-5-5", content: [{ type: "text", text: "First part." }, { type: "text", text: "Second part." }], usage: { input_tokens: 4, cache_read_input_tokens: 90_000, output_tokens: 300 } } };
    F.ingest(main, JSON.stringify(twice));
    F.ingest(main, JSON.stringify(toolCall(NOW + 900, "AskUserQuestion", { questions: [{ question: "Merge it?" }] })));
    agent.done = true;
    agent.tail.mtime = NOW + 800;
    wf.status = "completed";
    wf.finished = NOW + 700;
    F.noteScan([s], NOW + 2000, noJobs);
    const news = "agentDone,asked,reply,reply,workflowDone";
    expect(kinds()).toBe(news);
    F.noteScan([], NOW + 4000, noJobs); // its registry file was caught half-written, say: the session is missing from one scan
    F.noteScan([s], NOW + 6000, noJobs);
    expect(kinds()).toBe(news);
    F.noteScan([], NOW + 8000, noJobs);
    F.ingest(main, JSON.stringify(reply(NOW + 8500, "One more."))); // something new while it was out of sight is still news, once
    F.noteScan([s], NOW + 10_000, noJobs);
    F.noteScan([s], NOW + 12_000, noJobs);
    expect(kinds()).toBe("agentDone,asked,reply,reply,reply,workflowDone");
    expect(F.newCount()).toBe(6);
  });
});

describe("a row never grows", () => {
  const drawn = (s: string) => Bun.stringWidth(strip(s));
  /** The background a terminal would have behind each glyph of a coloured string: "" for none, else "r;g;b". */
  const backgrounds = (ansi: string): string[] => {
    const out: string[] = [];
    let bg = "";
    for (const part of ansi.split(/(\x1b\[[0-9;?]*[a-zA-Z])/)) {
      const m = /^\x1b\[(?:48;2;([\d;]+)|(49|0))m$/.exec(part);
      if (m) bg = m[1] ?? "";
      else if (!part.startsWith("\x1b[")) for (const _ of part) out.push(bg);
    }
    return out;
  };

  test("text put over part of a gauge or a sparkline replaces just those cells", () => {
    const r = new F.Row(20);
    r.paste(5, F.gauge(50, 12, F.C.calm)); // ━━━━━━──────
    r.put(11, "┼", F.C.white); // a pace tick, over the gauge
    expect(r.plain()).toBe("    ━━━━━━┼─────    ");
    expect(r.toString()).toBe("    " + F.fg(F.C.calm, "━━━━━━") + F.fg(F.C.white, "┼") + F.fg(F.C.faint, "─────")); // the colours either side are kept
    const s = new F.Row(12);
    s.paste(3, F.spark([1, 2, 3, 4, 5, 6, 7, 8], 8, ...F.RAMP.session));
    s.put(6, "▼", F.C.white, true);
    s.paste(9, F.fg(F.C.green, "ab"));
    expect(strip(F.spark([1, 2, 3, 4, 5, 6, 7, 8], 8, ...F.RAMP.session))).toBe("▃▄▅▆▇▇██");
    expect(s.plain()).toBe("  ▃▄▅▼▇▇ab  ");
    expect(drawn(s.toString())).toBe(10);
    // Told it is narrower than it is, a paste is cut to what it was told; told wider, it leaves the rest blank.
    const t = new F.Row(10);
    expect(t.paste(2, F.fg(F.C.green, "abcdef"), 3)).toBe(5);
    t.paste(7, "xy", 4);
    expect(t.plain()).toBe(" abc  xy  ");
  });

  test("a context bar keeps its own half-cell backgrounds on a tinted row, and the tint carries on after it", () => {
    const bar = F.stacked([{ tokens: 30, color: [120, 120, 120] }, { tokens: 50, color: [177, 185, 249] }], 200, 10);
    const r = new F.Row(16, F.C.tint);
    r.paste(3, bar);
    r.put(14, "x");
    expect(r.plain()).toBe("  " + strip(bar) + " x  ");
    const out = r.toString();
    const tint = F.C.tint.join(";");
    const behind = backgrounds(out);
    expect(behind.length).toBe(16);
    expect(behind.slice(0, 2)).toEqual([tint, tint]);
    expect(behind[3]).toBe("177;185;249"); // the half-cell where two categories meet: the second one's colour behind the first one's ▌
    expect(strip(bar)[1]).toBe("▌");
    expect(behind.filter((b) => b !== tint).length).toBe(1); // every other cell, the x and the end of the row included, is on the tint
    expect(out.endsWith("\x1b[49m")).toBe(true);
    expect(drawn(out)).toBe(16);
  });

  test("a wide character that is half overwritten is blanked rather than pushed along", () => {
    const r = new F.Row(10);
    r.put(3, "日本");
    r.put(4, "x");
    expect(r.plain()).toBe("   x本    ");
    expect(drawn(r.toString())).toBe(6);
    r.put(6, "y");
    expect(r.plain()).toBe("   x y    ");
  });

  test("a paste with escape codes this file does not write is kept whole, and goes whole when written over", () => {
    const odd = "\x1b[4munder\x1b[24m"; // underline: not ours
    const r = new F.Row(12, F.C.tint);
    r.paste(3, odd);
    expect(r.plain()).toBe("  under     ");
    expect(r.toString()).toContain(odd);
    expect(drawn(r.toString())).toBe(12);
    r.put(5, "Z");
    expect(r.plain()).toBe("    Z       ");
    expect(drawn(r.toString())).toBe(12);
  });

  test("whatever is put or pasted where, the row is exactly as wide as it was made", () => {
    let x = 11;
    const rnd = (n: number) => ((x = (x * 1103515245 + 12345) & 0x7fffffff) % n);
    const things = [
      () => F.spark([0, 3, 9, 1, 0, 7], 9, ...F.RAMP.agent),
      () => F.gauge(rnd(100), 8, F.C.calm),
      () => F.stacked([{ tokens: 10 + rnd(50), color: [0, 204, 204] }, { tokens: rnd(90), color: [215, 119, 87] }], 200, 9),
      () => F.bold(F.fg(F.C.amber, "NEEDS YOU")),
      () => "\x1b[4mraw\x1b[24m",
      () => "plain",
    ];
    const words = ["working", "日本語", "ＡＢ", "a", "up 1h04", "é", "▲ ● ◐", ""];
    for (let round = 0; round < 300; round++) {
      const W = 20 + rnd(30);
      const r = new F.Row(W, rnd(3) === 0 ? F.C.tint : undefined);
      for (let i = 0; i < 12; i++) {
        const col = rnd(W + 12) - 5;
        const op = rnd(5);
        if (op === 0) r.paste(col, things[rnd(things.length)]());
        else if (op === 1) r.putr(col, words[rnd(words.length)], F.C.dim);
        else if (op === 2) r.tint(rnd(2) ? F.C.tint : undefined, col, col + rnd(10));
        else r.put(col, words[rnd(words.length)], F.C.text, rnd(2) === 0);
      }
      expect(Bun.stringWidth(r.plain())).toBe(W);
      expect(drawn(r.toString())).toBeLessThanOrEqual(W);
      expect(strip(r.toString()).trimEnd()).toBe(r.plain().trimEnd());
    }
  });
});

describe("graphs hold still, checked independently", () => {
  test("awkward windows: lengths that do not divide by the width, calls exactly on an edge, and the moment a bar closes", () => {
    let x = 5;
    const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (const windowMin of [1, 7, 13, 30, 77, 180])
      for (const n of [1, 12, 25, 58, 110, 160]) {
        const span = windowMin * MIN;
        const bar = span / n; // 7 minutes over 58 bars is 7241.379… ms a bar
        const calls = Array.from({ length: 300 }, () => Math.round(NOW + 3 * bar - rnd() * (span + 6 * bar)));
        // …and calls exactly on bar edges, and a millisecond either side of them.
        for (let k = Math.floor(NOW / bar) - n - 1; k <= Math.floor(NOW / bar) + 1; k += Math.max(1, Math.floor(n / 7))) for (const d of [-1, 0, 1]) calls.push(Math.round(k * bar) + d);
        calls.sort((a, b) => a - b);
        const step = Math.min(1000, Math.max(1, Math.floor(bar / 10)));
        let before = F.timeWindow(NOW, span, n);
        let was = F.bucketsIn([calls], before);
        let closings = 0;
        for (let t = NOW + step; t < NOW + 3 * bar + step; t += step) {
          const win = F.timeWindow(t, span, n);
          const b = F.bucketsIn([calls], win);
          expect(F.barOf(t, win)).toBe(n - 1); // the bar still filling is the last one
          // Counted another way: bar k of the strip is wall-clock bar floor(now / bar) - n + 1 + k.
          const again = new Array(n).fill(0);
          for (const c of calls) {
            const k = Math.floor(c / bar) - Math.floor(t / bar) + n - 1;
            if (k >= 0 && k < n) again[k]++;
          }
          expect(b).toEqual(again);
          const moved = win.first - before.first;
          if (moved === 0) expect(b).toEqual(was); // no bar closed: nothing may move, the total included
          else {
            expect(moved).toBe(1);
            expect(b.slice(0, n - 1)).toEqual(was.slice(1)); // one closed: everything steps left one cell
            closings++;
          }
          before = win;
          was = b;
        }
        expect(closings).toBeGreaterThanOrEqual(2);
      }
  });

  /** A session with one busy agent, one that is nearly idle, and a main thread, where folding would hide the busy one. `idle` puts that many agents which have gone quiet ahead of it. */
  const twoAgents = (idle = 0) => {
    const quietBusy = agentOf("busy-but-quiet", tailOf([...callTimes(90, NOW - 5 * MIN, 3, 3).map((t) => toolCall(t)), toolResult(NOW - 5 * MIN + 1)]), { label: "the busy one" });
    const live = agentOf("live", tailOf(callTimes(6, NOW - 10_000, 25, 5).map((t) => toolCall(t))), { label: "the live one" });
    const other = agentOf("other", tailOf(callTimes(5, NOW - 20_000, 25, 9).map((t) => toolCall(t))), { label: "another live one" });
    const idlers = Array.from({ length: idle }, (_, i) => agentOf(`idle-${i}`, tailOf([toolCall(NOW - 9 * MIN - i * 1000), toolResult(NOW - 9 * MIN - i * 1000 + 1)]), { label: `an idle one ${i}` }));
    return sessionOf({ sid: "b", name: "flaky test hunt", mains: [tailOf(callTimes(12, NOW - 30_000, 25, 2).map((t) => toolCall(t)))], agents: [live, other, ...idlers, quietBusy] });
  };
  const barsOf = (frame: string[], label: string) => frame.map(strip).find((l) => l.includes(label))?.match(/[▁▂▃▄▅▆▇█]{12,}/)?.[0];

  test("a row that folds away to fit the screen does not rescale the rows that stay", () => {
    const before = { ...F.opt };
    try {
      for (const mode of ["detail", "compact"] as F.Mode[]) {
        F.opt.mode = mode;
        // The detail view folds an agent group only once it is longer than three (and then shows as many as fit), so there six idle agents stand ahead of the busy one.
        const session = () => twoAgents(mode === "detail" ? 6 : 0);
        const tall = F.render([session()], 150, 30, NOW);
        const short = F.render([session()], 150, mode === "compact" ? 8 : 15, NOW);
        expect(barsOf(tall, "the busy one")).toBeDefined(); // on the tall screen every thread has its row
        expect(barsOf(short, "the busy one")).toBeUndefined(); // on the short one the quiet agent has folded away
        expect(short.map(strip).join("\n")).toContain("more agent");
        expect(barsOf(short, "the live one")).toBe(barsOf(tall, "the live one")!);
      }
    } finally {
      Object.assign(F.opt, before);
    }
  });
});

describe("runway and pace, worked by hand", () => {
  const H = 60 * MIN;
  const view = (pct: number, resetsInMs: number) => F.accountViewOf({ kind: "current", data: { five_hour: { utilization: pct, resets_at: iso(NOW + resetsInMs) } }, asOf: NOW, failing: "" }, { nextTry: 0, busy: false }, NOW).limits[0];

  test("a limit that is already full has no forecast: what matters then is when it resets", () => {
    // 100% used with 1h25 to go. "full in ~1m" would be a forecast of something that has happened, shown until the reset.
    expect(F.paceForecast(100, NOW + 85 * MIN, 5 * H, NOW)).toBeUndefined();
    expect(F.paceForecast(104, NOW + 85 * MIN, 5 * H, NOW)).toBeUndefined();
    expect(view(100, 85 * MIN)).toMatchObject({ pct: 100, fullIn: undefined });
    expect(F.resetText(view(100, 85 * MIN).resetsAt, NOW)).toBe("resets in 1h25");
    expect(F.limitTone(100)).toEqual(F.C.red);
    // One point short of full, at the same moment: 3h35 gone at 99%, so 215/99 minutes for the last point.
    expect(F.paceForecast(99, NOW + 85 * MIN, 5 * H, NOW)! / MIN).toBeCloseTo(215 / 99, 9);
    expect(F.fullInText(215 / 99)).toBe("full in ~2m");
  });

  test("a window that has just reset, nothing used, and a reset time already past", () => {
    // Just reset: the whole 5 hours lie ahead. The tick is at the very start and nothing is forecast, however much is used.
    expect(view(0, 5 * H)).toMatchObject({ pct: 0, tick: 0, fullIn: undefined });
    expect(view(60, 5 * H - 1000)).toMatchObject({ fullIn: undefined }); // a second in: 60% already would be alarming, but one second is no pace
    expect(F.paceCell(0, 0, 12)).toEqual({ cell: 0, glyph: "┼" });
    // 0% used at any point in the window: nothing to forecast.
    expect(F.paceForecast(0, NOW + 2 * H, 5 * H, NOW)).toBeUndefined();
    expect(view(0, 2 * H).tick).toBeCloseTo(0.6, 9); // 3 of 5 hours gone
    // The reset time is in the past: the figures belong to a window that has rolled over. No tick, no forecast, no "resets in".
    expect(view(97, -5 * MIN)).toMatchObject({ pct: 97, tick: undefined, fullIn: undefined });
    expect(F.resetText(NOW - 5 * MIN, NOW)).toBe("");
    // By hand, mid-window: 2h30 of 5h gone at 51% used. 49 points to go at 51 points per 150 minutes = 144.1 minutes, and 150 remain.
    expect(F.paceForecast(51, NOW + 2.5 * H, 5 * H, NOW)! / MIN).toBeCloseTo((49 / 51) * 150, 9);
    expect(F.paceForecast(50, NOW + 2.5 * H, 5 * H, NOW)).toBeUndefined(); // exactly on pace: full at the reset, not before it
    // The week: 6 days gone at 90%. 10 points at 15 points a day = 16 hours, and 24 remain.
    expect(F.paceForecast(90, NOW + 24 * H, 7 * 24 * H, NOW)! / H).toBeCloseTo(16, 9);
    expect(F.fullInText(16 * 60)).toBe("full in ~16h00");
  });

  test("context that shrinks: a compaction starts the history again, a slow decline says nothing", () => {
    const at = (min: number, used: number): [number, number] => [NOW - min * MIN, used];
    // 880k, 900k, 920k, then compacted to 200k six minutes ago and growing 20k a minute: 320k now, 680k to go, 34 minutes.
    const compacted = [at(9, 880_000), at(8, 900_000), at(7, 920_000), ...[6, 5, 4, 3, 2, 1, 0].map((m) => at(m, 200_000 + (6 - m) * 20_000))];
    expect(F.ctxRunway(compacted, 1_000_000, NOW)).toBeCloseTo(34, 9);
    // The same, but compacted only four minutes ago: not yet five minutes of new history.
    expect(F.ctxRunway([at(9, 880_000), at(7, 920_000), ...[4, 3, 2, 1, 0].map((m) => at(m, 200_000 + (4 - m) * 20_000))], 1_000_000, NOW)).toBeUndefined();
    // Before the compaction it was 4 minutes from full; the forecast must not come from those readings.
    expect(F.ctxRunway(compacted.slice(0, 3).map(([t, u]) => [t + 7 * MIN, u] as [number, number]), 1_000_000, NOW)).toBeUndefined(); // and three readings two minutes long are not enough either
    // Shrinking a little at a time (no single drop big enough to be a compaction): no trend upward, so nothing.
    expect(F.ctxRunway(Array.from({ length: 11 }, (_, i) => at(10 - i, 600_000 - i * 1_000)), 1_000_000, NOW)).toBeUndefined();
    // Two compactions in the last ten minutes: only what follows the second counts (60k to 180k in six minutes: 20k a minute, 41 minutes to 1M).
    const twice = [at(10, 900_000), at(9, 300_000), at(8, 320_000), at(7, 340_000), ...[6, 5, 4, 3, 2, 1, 0].map((m) => at(m, 60_000 + (6 - m) * 20_000))];
    expect(F.ctxRunway(twice, 1_000_000, NOW)).toBeCloseTo(41, 9);
    // A reading stamped later than now (clocks disagree) is left out rather than trusted.
    expect(F.ctxRunway([...Array.from({ length: 11 }, (_, i) => at(10 - i, 600_000 + i * 10_000)), [NOW + 5 * MIN, 999_000]], 1_000_000, NOW)).toBeCloseTo(30, 9);
  });
});

describe("what turns the usage read on", () => {
  test("--usage, or FLEET_USAGE=1 in the environment, and nothing else", () => {
    const before = { ...F.opt };
    const saved = process.env.FLEET_USAGE;
    try {
      delete process.env.FLEET_USAGE;
      for (const argv of [[], ["--all", "--bell", "--once"], ["--mode", "far", "60"], ["--stall", "5"], ["--plain-glyphs"]]) {
        F.parseArgs(argv);
        expect(F.opt.usage).toBe(false);
      }
      F.parseArgs(["--usage"]);
      expect(F.opt.usage).toBe(true);
      for (const [value, on] of [["1", true], ["0", false], ["true", false], ["", false]] as [string, boolean][]) {
        process.env.FLEET_USAGE = value;
        F.parseArgs([]);
        expect(F.opt.usage).toBe(on);
      }
    } finally {
      if (saved === undefined) delete process.env.FLEET_USAGE;
      else process.env.FLEET_USAGE = saved;
      Object.assign(F.opt, before);
    }
  });

  test("the README names every environment variable fleet.ts reads, so none is a hidden switch", () => {
    const source = fs.readFileSync(path.join(here, "fleet.ts"), "utf8");
    const readme = fs.readFileSync(path.join(here, "README.md"), "utf8");
    const read = [...new Set([...source.matchAll(/process\.env\.(FLEET_[A-Z_]+)/g)].map((m) => m[1]))].sort();
    expect(read).toContain("FLEET_USAGE");
    expect(read.filter((name) => !readme.includes("`" + name))).toEqual([]);
    // And it does not promise that --usage is the only way to switch the read on.
    expect(readme).toContain("`FLEET_USAGE=1`");
    expect(readme).not.toMatch(/Without `--usage`, Claude Fleet makes no network requests/);
  });
});

describe("a remote session is told apart from one that merely uses mosh", () => {
  test("mosh's own client settings in the environment do not make a local session remote", () => {
    // MOSH_ESCAPE_KEY, MOSH_PREDICTION_DISPLAY and MOSH_TITLE_NOPREFIX configure the mosh client. Someone who
    // sets them in a shell profile has them in every local terminal on the Mac too.
    const local = ["zsh", "login", "Terminal"];
    expect(F.isRemoteSession({ MOSH_ESCAPE_KEY: "~", MOSH_PREDICTION_DISPLAY: "always", MOSH_TITLE_NOPREFIX: "1" }, local)).toBe(false);
    expect(F.isRemoteSession({ MOSH_SERVER_NETWORK_TMOUT: "604800" }, local)).toBe(true); // set for the server side of a session
    expect(F.isRemoteSession({ MOSH_SERVER_SIGNAL_TMOUT: "60" }, local)).toBe(true);
    expect(F.isRemoteSession({ MOSH_ESCAPE_KEY: "~" }, ["zsh", "mosh-server"])).toBe(true); // the ancestor still says so
    // So a local keychain that does not answer is reported as that, not as closed to remote sessions.
    const silent: F.KeychainOutcome = { status: null, stderr: "", timedOut: true, parse: "empty" };
    const d = F.loginDecision(silent, "missing", F.isRemoteSession({ MOSH_ESCAPE_KEY: "~" }, local));
    expect("reason" in d && d.reason).toBe("keychain: no answer in 5s");
  });
});
