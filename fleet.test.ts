// Tests for the parts of fleet.ts that are plain logic. Run with: bun test
// Nothing here reads a real login, a real transcript or the network.

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as F from "./fleet.ts";

const here = import.meta.dir;
// Everything the usage code reads or writes while under test lives in a throwaway directory.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fleet-test-"));
process.env.XDG_CACHE_HOME = path.join(SCRATCH, "cache");
process.env.FLEET_HOME = path.join(SCRATCH, "home");
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
    // Pick a second in which no strip on the screen closes a bar (at 150 columns the lane has 30 bars; today's header and far cards use 25, 58 and 110).
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
    expect(F.paceForecast(100, NOW + 85 * MIN, 5 * H, NOW)).toBe(0);
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
      const views = F.buildViews([busy, stuck, asks], NOW, 80);
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
    const views = F.buildViews(sessions, NOW, 80);
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
  const viewsOf = (sessions: F.Session[], now: number, all = false) => F.buildViews(sessions, now, 80).filter((v) => all || !F.isHidden(v));
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
        const views = F.buildViews([s], NOW, 80);
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
      const views = F.buildViews([mostlyLive], NOW, 80);
      views[0].stall = { session: false, threads: ["stuck"], count: 1, since: NOW - 3 * MIN };
      expect(plain(F.detailView(views, 150, 9, NOW, 0, false)).slice(5).map(label)).toEqual(["live-1", "live-2", "stuck", "… 3 more agents"]);
      // A count that would take the row of the one agent it hides is never drawn: four agents stay four.
      const four = sessionOf({ sid: "four", mains: s.mains, agents: [live("live-1"), live("live-2"), live("live-3"), inTool("tool-1")] });
      expect(plain(F.detailView(F.buildViews([four], NOW, 80), 150, 8, NOW, 0, false)).slice(4).map(label)).toEqual(["live-1", "live-2", "live-3", "tool-1"]);
      // Shorter still (step 11): standalone agents fold into one line.
      expect(plain(F.detailView(F.buildViews([s], NOW, 80), 150, 5, NOW, 0, false))[4]).toBe(" ▌  ⠋ 1 live   ◐ 2 in a tool   ○ 4 quiet");
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

  test("a workflow that has ended: ✓ or ✗ in place of ≡, and how it ended in place of the trail", () => {
    quietly(() => {
      const s = busy(NOW);
      const ended = (id: string, name: string, status: string, tokens?: number): F.Workflow => ({ ...s.workflows[0], id, name, status, tokens, finished: NOW - 4 * MIN, lastT: NOW - 4 * MIN, agents: s.workflows[0].agents.slice(0, 2) });
      s.workflows = [ended("wf_2", "link-check", "completed", 412_000), ended("wf_3", "reindex-preview", "failed")];
      const raw = F.detailView(F.buildViews([s], NOW, 80), 150, 40, NOW, 0, false);
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
              const views = F.buildViews(sessions, NOW, 80).filter((v) => all || !F.isHidden(v));
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
      const views = F.buildViews([busy(NOW), turn, done], NOW, 80);
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

  test("focus: one session takes the screen, with every stored reply in full and every agent", () => {
    quietly(() => {
      const s = busy(NOW);
      const said = (n: number) => `Reply ${n}, first paragraph.\n\n- a bullet in reply ${n}\n- another\n\nReply ${n}, last paragraph.`;
      s.mains[0].says = [1, 2, 3, 4, 5, 6].map((n) => ({ text: said(n), t: NOW - (8 - n) * MIN }));
      const views = F.buildViews([s], NOW, 80);
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
      const views = F.buildViews([s], NOW, 80);
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
      const key = plain(F.detailView(F.buildViews([growing], NOW, 80), 150, 40, NOW, 0, false))[3];
      expect(key).toMatch(/■ Used \d+k {2,}full in ~40m$/);
      expect(F.width(key)).toBe(149);
    } finally {
      F.seen.at = before;
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
    expect(frame).toContain("bun212%"); // the made-up machine
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
