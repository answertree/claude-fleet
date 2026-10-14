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
      expect(frame).toContain("stalled? · 14m");
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
      expect(strip(r.out)).toContain(`no reading yet: Anthropic answered ${status}`);
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
