#!/usr/bin/env bun
// Claude Fleet: one screen showing every live Claude Code session on this
// machine and the subagents, workflows and tasks under each.
//
// Read-only: it tails the transcripts under ~/.claude/projects and reads the
// session registry, workflow journals and task files. With --usage it also
// asks Anthropic for your account's usage figures, using the Claude Code login
// already stored on this machine.
//
// Usage: bun fleet.ts [minutes] [options]     (see --help)

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StringDecoder } from "node:string_decoder";
import { spawnSync } from "node:child_process";

/**
 * Where Claude Code keeps its files; the demo and the tests point FLEET_HOME at made-up sessions. Read each
 * time it is used, not once at import: a test sets FLEET_HOME after its import of this file has already run,
 * and must never be left looking at the real sessions.
 */
const claudeHome = (): string => process.env.FLEET_HOME || process.env.AGENT_FLEET_HOME || path.join(os.homedir(), ".claude");
/** The time. FLEET_NOW (test only) pins it, in milliseconds since 1970, so a frame can be reproduced exactly. */
export const clock = (): number => Number(process.env.FLEET_NOW) || Date.now();
const HIDE_TOP = process.env.FLEET_HIDE_PROCESSES === "1"; // leave other programs' names off the machine row
export const WINDOWS = [5, 15, 30, 60, 180];
const TAIL_BYTES = 2 * 1024 * 1024;
const ACTIVE_MS = 60_000;
const FINAL_TOOLS = new Set(["SubagentHandback", "StructuredOutput"]);
const CTX_LOG_MS = 15 * 60_000; // how far back a session's context readings are kept, for the runway forecast

// ───────────────────────── options ─────────────────────────

const HELP = `Claude Fleet: every live Claude Code session on one screen.

Usage: bun fleet.ts [minutes] [options]

  minutes        width of the sparkline window (default 30)
  --mode <m>     detail (default), compact, or far (big, readable from a distance)
  --all          also show idle and finished sessions
  --usage        show your Claude account usage limits (reads the stored Claude
                 Code login and asks api.anthropic.com every five minutes)
  --bell         ring the terminal bell when a session starts waiting on you,
                 or when something stalls
  --stall <min>  mark a thread "stalled?" after this many minutes sitting on a
                 tool call in silence with the session idle (default 10, 0 = off)
  --no-mouse     do not capture mouse clicks
  --once         print one frame and exit
  --glyphs       print a test card of every glyph the screen uses, to check that
                 your terminal draws each one a single cell wide, and exit
  --plain-glyphs use fallbacks for glyphs some fonts lack (≡ ┿ ╌ ◇)

Keys: 1 2 3 view mode · + - window · a all sessions · d finished agents
      tab focus next session · b bell · u retry the usage read
      space seen it (marks what is new from now on) · esc leave focus · q quit
`;

export type Mode = "detail" | "compact" | "far";
const MODES: Mode[] = ["detail", "compact", "far"];
/** Everything the command line and the keys can change. These are the defaults; parseArgs() fills them in when fleet.ts is run as a program. */
export const opt = {
  mode: "detail" as Mode,
  windowMin: 30,
  showDone: false,
  showAll: false,
  bell: false,
  usage: false,
  mouse: true,
  once: false,
  plainGlyphs: false, // --plain-glyphs: fallbacks for fonts that lack ≡ ┿ ╌ ◇
  stallMin: 10, // --stall <minutes>: how long a thread may sit on a tool call in silence; 0 turns the stall watch off
};

/** Read the command line into `opt`. Returns the one-shot command it asked for, if any. */
export function parseArgs(argv: string[]): "help" | "glyphs" | undefined {
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  setPlainGlyphs(argv.includes("--plain-glyphs"));
  if (argv.includes("--glyphs")) return "glyphs";
  const TAKES_VALUE = ["--mode", "--stall"];
  const valueOf = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const modeArg = valueOf("--mode");
  if (MODES.includes(modeArg as Mode)) opt.mode = modeArg as Mode;
  const minutes = argv.find((a, i) => /^\d+$/.test(a) && !TAKES_VALUE.includes(argv[i - 1]));
  if (minutes && Number(minutes) > 0) opt.windowMin = Number(minutes);
  opt.once = argv.includes("--once");
  opt.showAll = argv.includes("--all");
  opt.bell = argv.includes("--bell");
  opt.usage = argv.includes("--usage") || process.env.FLEET_USAGE === "1";
  opt.mouse = !argv.includes("--no-mouse");
  const stall = valueOf("--stall");
  if (stall !== undefined && /^\d+(\.\d+)?$/.test(stall)) opt.stallMin = Number(stall);
  return undefined;
}

let focusSid: string | null = null;
let frame = 0;
/** Clickable regions of the last frame, in 1-based terminal cells. */
const hits: { row: number; x0: number; x1: number; act: string }[] = [];

// ───────────────────────── colour and text helpers ─────────────────────────

export type RGB = [number, number, number];
/** The palette. One law: warm means you. Amber only where the person is needed, red only where something is broken or nearly out. */
export const C = {
  white: [245, 247, 250] as RGB, // bold: titles, the clock, counts, the question, the current phase
  text: [198, 205, 215] as RGB, // the newest reply, live labels, figures
  dim: [92, 99, 112] as RGB, // earlier replies, places, labels, units, ages
  faint: [58, 64, 74] as RGB, // gauge tracks, empty buckets, free context, rules
  amber: [229, 181, 68] as RGB, // you are needed: ▲, NEEDS YOU, that session's rail, the masthead tile
  tint: [52, 38, 0] as RGB, // background behind a waiting session's title and question
  warmDim: [150, 130, 90] as RGB, // dim text on the tint
  red: [240, 98, 92] as RGB, // broken or nearly out: ✗, failed, any limit at 80% or more, stalled
  green: [80, 200, 120] as RGB, // alive: ●, WORKING, the spinner, "live", ✓ inside strips
  done: [62, 128, 92] as RGB, // receded green: ✓ on rows that are history, passed phases, "none waiting"
  blue: [97, 170, 255] as RGB, // you: ▸ and YOUR TURN
  pale: [150, 190, 245] as RGB, // the text of your prompt
  cyan: [86, 205, 214] as RGB, // Claude: the brand, ◆, bullets, pending tool names
  purple: [190, 148, 255] as RGB, // workflow, and nothing else
  code: [150, 196, 204] as RGB, // inline code and code lines
  calm: [96, 170, 182] as RGB, // a limit gauge below 60%
  button: [40, 45, 54] as RGB,
  yellow: [229, 181, 68] as RGB, // the old name for amber, still used by the old renderer
};
/** Sparkline ramps, low to high. Hue says whose activity it is, height says how much. */
export const RAMP = {
  fleet: [[40, 110, 90], [120, 240, 170]] as [RGB, RGB],
  session: [[52, 84, 150], [150, 200, 255]] as [RGB, RGB],
  agent: [[38, 86, 110], [96, 214, 226]] as [RGB, RGB], // agents and the main thread
  workflow: [[90, 70, 140], [200, 165, 255]] as [RGB, RGB],
  machine: [[40, 100, 110], [150, 225, 235]] as [RGB, RGB], // cpu gauge, history and cores: a rate, so it never turns warm
};
export const fg = (c: RGB, s: string) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${s}\x1b[39m`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
export const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as RGB;

const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Cf}]/u; // combining marks, variation selectors, joiners, direction marks
export function charWidth(cp: number): number {
  if (cp < 0x300) return cp === 0xad ? 0 : 1;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2630 && cp <= 0x2637) || // Yijing trigrams and digrams: wide since Unicode 16
    (cp >= 0x268a && cp <= 0x268f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) || // more Hangul lead consonants
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) || // vertical punctuation
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || // full-width ￠ ￡ ￢ ￣ ￤ ￥ ￦
    (cp >= 0x16fe0 && cp <= 0x18dff) || // Tangut and Khitan
    (cp >= 0x1aff0 && cp <= 0x1b2ff) || // more kana, Nushu
    (cp >= 0x1d300 && cp <= 0x1d37f) || // Tai Xuan Jing, counting rods
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  if ((cp >= 0x1160 && cp <= 0x11ff) || (cp >= 0xd7b0 && cp <= 0xd7ff)) return 0; // Hangul vowels and tails join the letter before them
  if (cp >= 0x2190 && cp <= 0x2bff) return 1; // arrows, box drawing, blocks, shapes, braille: what the screen is built from
  return ZERO_WIDTH.test(String.fromCodePoint(cp)) ? 0 : 1;
}
export const width = (s: string) => [...s].reduce((n, ch) => n + charWidth(ch.codePointAt(0)!), 0);

// Codepoints below U+3000 that Unicode gives an emoji form (emoji-data.txt, Emoji=Yes). A terminal or
// font may draw any of them as a two-cell colour picture, which is what pushes columns out of line on iOS.
const EMOJI_FORM: number[] = [
  0xa9, 0xa9, 0xae, 0xae, 0x203c, 0x203c, 0x2049, 0x2049, 0x2122, 0x2122, 0x2139, 0x2139, 0x2194, 0x2199, 0x21a9, 0x21aa, 0x231a, 0x231b,
  0x2328, 0x2328, 0x23cf, 0x23cf, 0x23e9, 0x23f3, 0x23f8, 0x23fa, 0x24c2, 0x24c2, 0x25aa, 0x25ab, 0x25b6, 0x25b6, 0x25c0, 0x25c0, 0x25fb, 0x25fe,
  0x2600, 0x2604, 0x260e, 0x260e, 0x2611, 0x2611, 0x2614, 0x2615, 0x2618, 0x2618, 0x261d, 0x261d, 0x2620, 0x2620, 0x2622, 0x2623, 0x2626, 0x2626,
  0x262a, 0x262a, 0x262e, 0x262f, 0x2638, 0x263a, 0x2640, 0x2640, 0x2642, 0x2642, 0x2648, 0x2653, 0x265f, 0x2660, 0x2663, 0x2663, 0x2665, 0x2666,
  0x2668, 0x2668, 0x267b, 0x267b, 0x267e, 0x267f, 0x2692, 0x2697, 0x2699, 0x2699, 0x269b, 0x269c, 0x26a0, 0x26a1, 0x26a7, 0x26a7, 0x26aa, 0x26ab,
  0x26b0, 0x26b1, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26c8, 0x26c8, 0x26ce, 0x26cf, 0x26d1, 0x26d1, 0x26d3, 0x26d4, 0x26e9, 0x26ea, 0x26f0, 0x26f5,
  0x26f7, 0x26fa, 0x26fd, 0x26fd, 0x2702, 0x2702, 0x2705, 0x2705, 0x2708, 0x270d, 0x270f, 0x270f, 0x2712, 0x2712, 0x2714, 0x2714, 0x2716, 0x2716,
  0x271d, 0x271d, 0x2721, 0x2721, 0x2728, 0x2728, 0x2733, 0x2734, 0x2744, 0x2744, 0x2747, 0x2747, 0x274c, 0x274c, 0x274e, 0x274e, 0x2753, 0x2755,
  0x2757, 0x2757, 0x2763, 0x2764, 0x2795, 0x2797, 0x27a1, 0x27a1, 0x27b0, 0x27b0, 0x27bf, 0x27bf, 0x2934, 0x2935, 0x2b05, 0x2b07, 0x2b1b, 0x2b1c,
  0x2b50, 0x2b50, 0x2b55, 0x2b55,
];
/** True when Unicode gives this codepoint an emoji form, so it is not safe to draw in a one-cell column. */
export function hasEmojiForm(cp: number): boolean {
  if (cp >= 0x1f000 && cp <= 0x1ffff) return true;
  if (cp < 0xa9 || cp > 0x2b55) return false;
  for (let i = 0; i < EMOJI_FORM.length; i += 2) if (cp >= EMOJI_FORM[i] && cp <= EMOJI_FORM[i + 1]) return true;
  return false;
}
/** Pictures that stand for something the safe glyph set can say. Everything else with an emoji form is dropped. */
const SAFE_SWAP: Record<string, string> = {
  "✅": "✓", "☑": "✓", "✔": "✓", "❌": "✗", "✖": "✗", "❎": "✗",
  "⚠": "!", "❗": "!", "❕": "!", "‼": "!!", "⁉": "!?", "❓": "?", "❔": "?",
  "➡": "→", "⬅": "←", "⬆": "↑", "⬇": "↓", "↔": "<->", "▶": "▸", "◀": "◂", "▪": "■", "▫": "□",
  "©": "(c)", "®": "(R)", "™": "TM", "ℹ": "i", "⭐": "*",
};
/**
 * Reduce text that came from a session (replies, prompts, questions, now-lines, labels, tool hints,
 * names) to glyphs that are exactly one cell wide everywhere, so nothing it contains can push a column
 * out of line. Ticks and crosses become ✓ and ✗; other emoji, variation selectors, joiners, combining
 * marks, control characters and terminal escape sequences are removed; tabs become two spaces;
 * full-width Latin and money signs become plain ones; any other double-width character becomes "?". Line breaks stay.
 * Afterwards every character other than a line break is one cell: width(s) equals its character count.
 */
export function safeText(s: string): string {
  if (/^[\x20-\x7e\n]*$/.test(s)) return s; // plain ASCII, the usual case
  s = s
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "")
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(/\t/g, "  ")
    .normalize("NFC");
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const swap = SAFE_SWAP[ch];
    if (cp === 0x0a) out += ch;
    else if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
    else if (swap !== undefined) out += swap;
    else if (cp < 0x300) out += cp === 0xa0 ? " " : cp === 0xad ? "" : ch;
    else if ((cp >= 0x2000 && cp <= 0x200a) || cp === 0x202f || cp === 0x205f || cp === 0x3000) out += " ";
    else if (cp >= 0xff01 && cp <= 0xff5e) out += String.fromCodePoint(cp - 0xfee0);
    else if (cp >= 0xffe0 && cp <= 0xffe6) out += "¢£¬¯¦¥₩"[cp - 0xffe0];
    else if (hasEmojiForm(cp) || charWidth(cp) === 0) continue;
    else if (charWidth(cp) !== 1) out += "?";
    else out += ch;
  }
  return out;
}
/** Session text as one safe line: safeText(), then every run of white space becomes one space. */
export const safeLine = (s: unknown): string => safeText(String(s ?? "")).replace(/\s+/g, " ").trim();

/** Truncate or pad plain text to exactly `w` display columns. */
export function fit(s: string, w: number, align: "l" | "r" = "l", keepSpacing = false): string {
  if (w <= 0) return "";
  if (!keepSpacing) s = s.replace(/\s+/g, " ").trim();
  if (width(s) > w) {
    let out = "";
    let n = 0;
    for (const ch of s) {
      const cw = charWidth(ch.codePointAt(0)!);
      if (n + cw > w - 1) break;
      out += ch;
      n += cw;
    }
    s = out + "…";
  }
  const gap = " ".repeat(Math.max(0, w - width(s)));
  return align === "l" ? s + gap : gap + s;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

export function human(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1) + "k";
  if (n < 1_000_000) return Math.round(n / 1000) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

export const BARS = "▁▂▃▄▅▆▇█";
/** Sparkline of `counts`, scaled against `max` (square root, so quiet rows stay visible). */
export function spark(counts: number[], max: number, lo: RGB, hi: RGB): string {
  return counts
    .map((v) => {
      if (v <= 0) return fg(C.faint, "▁");
      const t = Math.sqrt(v / Math.max(1, max));
      return fg(mix(lo, hi, t), BARS[Math.min(7, Math.max(0, Math.ceil(t * 8) - 1))]);
    })
    .join("");
}

export function bar(done: number, total: number, w: number, c: RGB): string {
  const filled = total > 0 ? Math.round((done / total) * w) : 0;
  return fg(c, "█".repeat(filled)) + fg(C.faint, "░".repeat(w - filled));
}

/** Progress as one glyph per step: ● done, ◐ in progress, ○ not started. Scaled down past `w` steps. */
export function pips(done: number, doing: number, total: number, w: number, c: RGB): string {
  let n = total;
  let d = done;
  let r = doing;
  if (total > w) {
    n = w;
    d = Math.min(w, Math.round((done / total) * w));
    r = doing > 0 ? Math.min(w - d, Math.max(1, Math.round((doing / total) * w))) : 0;
  }
  r = Math.min(r, n - d);
  return fg(c, "●".repeat(d)) + fg(C.yellow, "◐".repeat(r)) + fg(C.faint, "○".repeat(Math.max(0, n - d - r))) + " ".repeat(Math.max(0, w - n));
}

/** A bar of `w` cells split into coloured segments at half-cell resolution; the rest is free space. */
export function stacked(segments: { tokens: number; color: RGB }[], max: number, w: number): string {
  const halves = w * 2;
  const live = segments.filter((x) => x.tokens > 0);
  const usedHalves = Math.min(halves, Math.max(live.length, Math.round((live.reduce((n, x) => n + x.tokens, 0) / max) * halves)));
  // Every category present gets at least one half-cell, so small ones stay visible.
  const sizes = live.map(() => 1);
  let left = usedHalves - live.length;
  const total = live.reduce((n, x) => n + x.tokens, 0) || 1;
  const want = live.map((x) => (x.tokens / total) * usedHalves);
  while (left > 0) {
    let best = 0;
    for (let i = 1; i < live.length; i++) if (want[i] - sizes[i] > want[best] - sizes[best]) best = i;
    sizes[best]++;
    left--;
  }
  const cells: (RGB | null)[] = [];
  live.forEach((x, i) => {
    for (let k = 0; k < sizes[i]; k++) cells.push(x.color);
  });
  while (cells.length < halves) cells.push(null);
  let out = "";
  for (let i = 0; i < halves; i += 2) {
    const a = cells[i];
    const b = cells[i + 1];
    if (!a) out += fg(C.faint, "░");
    else if (!b) out += fg(a, "▌");
    else if (a === b) out += fg(a, "█");
    else out += `\x1b[48;2;${b[0]};${b[1]};${b[2]}m${fg(a, "▌")}\x1b[49m`;
  }
  return out;
}

/** Word-wrap plain text to `w` display columns. A width under one is taken as one, and a character wider than `w` gets a line to itself, so this always returns. */
export function wrap(text: string, w: number): string[] {
  w = Math.max(1, w);
  const lines: string[] = [];
  let cur = "";
  for (let word of text.split(" ")) {
    while (width(word) > w) {
      if (cur) lines.push(cur), (cur = "");
      let head = "";
      for (const ch of word) {
        if (head && width(head + ch) > w) break;
        head += ch;
      }
      lines.push(head);
      word = word.slice(head.length);
    }
    if (!cur) cur = word;
    else if (width(cur) + 1 + width(word) <= w) cur += " " + word;
    else lines.push(cur), (cur = word);
  }
  if (cur) lines.push(cur);
  return lines;
}

/** A message as readable lines: markdown marks dropped, bullets kept, code fences and blanks skipped. */
export function messageLines(text: string, w: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("```") || /^[|:\- ]+$/.test(line)) continue;
    line = line
      .replace(/^#+\s*/, "")
      .replace(/^[-*]\s+/, "• ")
      .replace(/[*`]+/g, "")
      .replace(/\s+/g, " ");
    out.push(...wrap(line, w));
  }
  return out;
}

export const toneFor = (pct: number): RGB => (pct >= 80 ? C.red : pct >= 50 ? C.yellow : C.green);
/** A thin horizontal gauge. */
export function gauge(pct: number, w: number, c: RGB): string {
  const n = Math.max(pct > 0 ? 1 : 0, Math.min(w, Math.round((pct / 100) * w)));
  return fg(c, "━".repeat(n)) + fg(C.faint, "─".repeat(w - n));
}

/** A bar chart `h` rows tall, returned top row first. */
export function tallSpark(counts: number[], max: number, h: number, lo: RGB, hi: RGB): string[] {
  const rows: string[] = [];
  for (let r = h - 1; r >= 0; r--) {
    rows.push(
      counts
        .map((v) => {
          const t = v <= 0 ? 0 : Math.sqrt(v / Math.max(1, max));
          const eighths = Math.round(t * h * 8) - r * 8;
          if (eighths <= 0) return r === 0 ? fg(C.faint, "▁") : " ";
          return fg(mix(lo, hi, t), BARS[Math.min(7, eighths - 1)]);
        })
        .join(""),
    );
  }
  return rows;
}

export const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

// ───────────────────────── vocabulary ─────────────────────────

/**
 * Every glyph the screen may use, in one table: `g` is the glyph, `plain` the fallback --plain-glyphs
 * swaps in for a font that lacks it, `is` what it means. None has an emoji form and none is outside box
 * drawing, block elements, braille, the common geometric shapes, ✓ ✗ and Latin punctuation; the test
 * suite checks that. Retired, never to be drawn again: ⚠ ⚙ ⎇ ▪ ◈ ▤ ┆.
 */
export const GLYPHS = {
  needs: { g: "▲", is: "needs you: blocked on the person" },
  working: { g: "●", is: "working: a session that is alive and busy" },
  you: { g: "▸", is: "you: something you typed, or your turn" },
  claude: { g: "◆", is: "Claude: the brand, and its newest reply" },
  earlier: { g: "◇", plain: "◆", is: "an earlier Claude reply" },
  live: { g: SPIN[0], is: "live: wrote within the last minute (animated)" },
  progress: { g: "◐", is: "in progress: started, not finished" },
  idle: { g: "○", is: "not started, quiet or idle" },
  done: { g: "✓", is: "done" },
  failed: { g: "✗", is: "failed, stopped or unavailable" },
  workflow: { g: "≡", plain: "◇", is: "workflow" },
  railThick: { g: "██", is: "state rail on a session's head rows" },
  railThin: { g: "▌", is: "state rail on body rows" },
  gaugeFill: { g: "━", is: "gauge: filled" },
  gaugeTrack: { g: "─", is: "gauge: remaining; rules" },
  gaugeNone: { g: "╌", plain: "─", is: "gauge: no reading" },
  pace: { g: "┼", is: "pace tick on the empty track" },
  paceFilled: { g: "┿", plain: "┼", is: "pace tick inside the filled part" },
  ctxFull: { g: "█", is: "context window: a full cell" },
  ctxHalf: { g: "▌", is: "context window: half a cell" },
  ctxFree: { g: "░", is: "context window: free space" },
  swatch: { g: "■", is: "colour key swatch" },
  bullet: { g: "•", is: "bullet in a reply" },
  nested: { g: "–", is: "nested bullet" },
  gutter: { g: "│", is: "code-line and quote gutter" },
  cut: { g: "…", is: "text was cut" },
  at: { g: "@", is: "joins folder and branch" },
  sep: { g: "·", is: "separates facts on one line" },
  tick: { g: "┴", is: "time-axis tick at each third of the window" },
  seen: { g: "▼", is: "when you last looked" },
} satisfies Record<string, { g: string; plain?: string; is: string }>;
export type IconName = keyof typeof GLYPHS;
/** The glyph to draw for each name: ICON.needs, ICON.workflow… Always read glyphs from here, so --plain-glyphs reaches them. */
export const ICON = Object.fromEntries(Object.entries(GLYPHS).map(([k, v]) => [k, v.g])) as Record<IconName, string>;
/** --plain-glyphs: swap in the fallbacks (≡→◇, ┿→┼, ╌→─, ◇→◆) for a terminal font that lacks the originals. */
export function setPlainGlyphs(on: boolean) {
  opt.plainGlyphs = on;
  for (const [k, v] of Object.entries(GLYPHS) as [IconName, { g: string; plain?: string }][]) ICON[k] = on && v.plain ? v.plain : v.g;
}

export type SessionState = "needs" | "stalled" | "working" | "yourTurn" | "idle" | "finished";
/** Each session state has its own glyph, word and colour, so the screen still reads without colour. Listed in sort order. */
export const STATE: Record<SessionState, { glyph: string; word: string; color: RGB }> = {
  needs: { glyph: "▲", word: "NEEDS YOU", color: C.amber },
  stalled: { glyph: "◐", word: "STALLED?", color: C.red },
  working: { glyph: "●", word: "WORKING", color: C.green },
  yourTurn: { glyph: "▸", word: "YOUR TURN", color: C.blue },
  idle: { glyph: "○", word: "IDLE", color: C.dim },
  finished: { glyph: "✓", word: "FINISHED", color: C.done },
};
export const STATE_ORDER = Object.keys(STATE) as SessionState[];
/**
 * The state rail's colour: the state colour on a session's head rows (thick), mixed 45% toward faint on
 * its body rows (thin). A waiting session's thick rail alternates amber and dimmed amber; pass the frame counter as `tick`.
 */
export const railTone = (state: SessionState, thick: boolean, tick = 0): RGB =>
  thick ? (state === "needs" && tick % 2 ? mix(C.amber, C.faint, 0.6) : STATE[state].color) : mix(STATE[state].color, C.faint, 0.45);

/** One rule for every limit gauge (memory, 5h, 7d, extra, context %): calm below 60%, bold white to 79%, red from 80%. */
export const limitTone = (pct: number): RGB => (pct >= 80 ? C.red : pct >= 60 ? C.white : C.calm);
/** The figure printed beside a limit gauge follows the same rule, in text colour while calm. */
export const figureTone = (pct: number): { color: RGB; bold: boolean } => (pct >= 80 ? { color: C.red, bold: true } : pct >= 60 ? { color: C.white, bold: true } : { color: C.text, bold: false });
/** CPU is a rate, not a limit: its gauge, history and core strip run this cool ramp (t from 0 to 1) and never turn warm. */
export const coolTone = (t: number): RGB => mix(RAMP.machine[0], RAMP.machine[1], Math.max(0, Math.min(1, t)));

/** fleet --glyphs: every glyph between bars, so a glyph the terminal draws two cells wide pushes its closing bar out of line. */
export function glyphCard(): string {
  const cp = (g: string) => [...g].map((ch) => "U+" + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")).join(" ");
  const row = (g: string, note: string) => {
    const cells = width(g);
    return ` |${g}|${" ".repeat(3 - cells)} |${g.repeat(Math.floor(10 / cells))}|  ${fit(cp(g), 15, "l", true)}${note}`;
  };
  const ruler = " | |   |1234567890|  every closing bar below should sit under these";
  const lines = ["Claude Fleet glyph test card" + (opt.plainGlyphs ? "  (--plain-glyphs)" : ""), "", ruler];
  for (const [name, v] of Object.entries(GLYPHS) as [IconName, { g: string; plain?: string; is: string }][]) {
    if (name === "live") continue; // the spinner's frames are listed below
    lines.push(row(ICON[name], v.is + (v.plain ? (opt.plainGlyphs ? `  (standing in for ${v.g})` : `  (--plain-glyphs draws ${v.plain})`) : "")));
  }
  for (const g of BARS) lines.push(row(g, g === BARS[0] ? "activity over time, lowest to highest" : ""));
  for (const g of SPIN) lines.push(row(g, g === SPIN[0] ? "live spinner, one frame each" : ""));
  lines.push(ruler, "", "If a bar is out of line, that glyph is not one cell wide in this terminal. Try --plain-glyphs.");
  return lines.join("\n") + "\n";
}

// ───────────────────────── layout grid ─────────────────────────

/**
 * The columns every row shares, for a terminal `W` cells wide. Columns count from 1 and ranges include
 * both ends, as in the design; column c is string index c - 1. Columns 1 and W stay blank.
 */
export interface Grid {
  W: number;
  wide: boolean; // 130 and up: instruments sit beside the conversation, agents get a type column
  narrow: boolean; // 100 to 129: instruments become one vitals row, the conversation runs the full width
  small: boolean; // under 100: also today's header, no action column, no place on the title row
  rail: number; // the state rail: ██ fills rail and rail + 1, ▌ sits on rail
  icon: number; // speaker, task and thread glyphs
  childIcon: number; // a workflow's agents, indented 2
  text: number; // conversation text and roster labels start here
  textEnd: number; // the left stack ends here; the place on the title row ends here too
  measure: number; // cells of conversation text, from `text`
  ageEnd: number; // ages in the conversation are right-aligned to end here
  lane: number; // the lane: every sparkline on the screen sits in these columns
  laneW: number; // …and has this many buckets
  laneEnd: number;
  fig: number; // figure field: totals, right-aligned to figEnd; roster ages end at figEnd too
  figW: number;
  figEnd: number;
  label: number; // roster: thread label (from `text`; a workflow's agents start 2 further in)
  labelEnd: number;
  action: number; // roster: what the thread is doing
  actionEnd: number;
  type: number; // roster: type and model, right-aligned to typeEnd; 0 when there is no such column
  typeEnd: number;
  gaugeW: number; // header gauges
  histW: number; // header cpu history
  machine: number; // header blocks: machine from `machine` to machineEnd, account from `account` to accountEnd
  machineEnd: number;
  account: number;
  accountEnd: number;
}
export function grid(W: number): Grid {
  const wide = W >= 130;
  const laneW = wide ? 30 : 20;
  const figW = wide ? 12 : 9;
  const figEnd = W - 1;
  const lane = W - figW - laneW - 1;
  const laneEnd = lane + laneW - 1;
  const textEnd = lane - 3;
  const actionEnd = textEnd - (wide ? 17 : 0);
  const labelEnd = 7 + Math.min(42, Math.floor((actionEnd - 6) * 0.52)) - 1;
  const account = wide ? 61 : 42;
  return {
    W,
    wide,
    narrow: !wide && W >= 100,
    small: W < 100,
    rail: 2,
    icon: 5,
    childIcon: 7,
    text: 7,
    textEnd,
    measure: wide ? Math.min(96, textEnd - 12) : Math.min(96, W - 14),
    ageEnd: wide ? textEnd : figEnd,
    lane,
    laneW,
    laneEnd,
    fig: laneEnd + 2,
    figW,
    figEnd,
    label: 7,
    labelEnd,
    action: labelEnd + 3,
    actionEnd,
    type: wide ? textEnd - 14 : 0,
    typeEnd: wide ? textEnd : 0,
    gaugeW: wide ? 12 : 8,
    histW: wide ? 20 : 12,
    machine: 2,
    machineEnd: account - 4,
    account,
    accountEnd: textEnd,
  };
}

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;
/** Display cells a string takes once its colour codes are left out. */
export const cells = (s: string) => width(s.replace(ANSI, ""));

interface Cell {
  ch: string; // what is drawn; "" for a cell covered by the one to its left
  color?: RGB;
  bold?: boolean;
  bg?: RGB; // its own background (the context bar's half-cells), which wins over the row's tint
  raw?: boolean; // ch is a coloured string kept whole
  span?: number; // cells it covers, when more than one: a wide character, or a paste kept whole
}
/**
 * A coloured string as one cell per glyph, or undefined when it holds anything but the colour,
 * background and bold codes this file writes, or a glyph that is not one cell wide.
 */
function ansiCells(ansi: string): Cell[] | undefined {
  const out: Cell[] = [];
  let color: RGB | undefined;
  let bg: RGB | undefined;
  let isBold = false;
  for (const part of ansi.split(/(\x1b\[[0-9;?]*[a-zA-Z])/)) {
    if (part.startsWith("\x1b[")) {
      const m = /^\x1b\[(?:(38|48);2;(\d+);(\d+);(\d+)|(39|49|1|22))m$/.exec(part);
      if (!m) return undefined;
      if (m[1] === "38") color = [+m[2], +m[3], +m[4]];
      else if (m[1] === "48") bg = [+m[2], +m[3], +m[4]];
      else if (m[5] === "39") color = undefined;
      else if (m[5] === "49") bg = undefined;
      else isBold = m[5] === "1";
      continue;
    }
    for (const ch of part) {
      if (ch === "\x1b" || charWidth(ch.codePointAt(0)!) !== 1) return undefined;
      out.push({ ch, color, bold: isBold, bg });
    }
  }
  return out;
}
/**
 * One screen row as cells, so text can be put at the columns grid() gives instead of being padded into
 * place. Columns count from 1. Later text overwrites earlier text, cell for cell (a tick put on a gauge
 * replaces one cell of it); anything past the last column is dropped. The row is always exactly W cells.
 */
export class Row {
  private cell: Cell[];
  private bg: (RGB | undefined)[];
  constructor(public W: number, bg?: RGB) {
    this.cell = Array.from({ length: W }, () => ({ ch: " " }));
    this.bg = new Array(W).fill(bg);
  }
  /** Make cell `i` (from 0) free to write on. Something wider than a cell that covers it is blanked whole, so the row cannot grow. */
  private free(i: number) {
    let head = i;
    while (head > 0 && this.cell[head].ch === "") head--;
    const span = this.cell[head].span ?? 1;
    if (span > 1 && head + span > i) for (let k = head; k < head + span; k++) this.cell[k] = { ch: " " };
  }
  /** Put plain text starting at `col`. Returns the column after it. */
  put(col: number, text: string, color: RGB = C.text, isBold = false): number {
    for (const ch of text) {
      const w = charWidth(ch.codePointAt(0)!);
      if (w === 0) continue;
      if (col >= 1 && col + w - 1 <= this.W) {
        for (let k = 0; k < w; k++) this.free(col - 1 + k);
        this.cell[col - 1] = w === 2 ? { ch, color, bold: isBold, span: 2 } : { ch, color, bold: isBold };
        if (w === 2) this.cell[col] = { ch: "" };
      }
      col += w;
    }
    return col;
  }
  /** Put plain text so that it ends at `end`. Returns the column before it. */
  putr(end: number, text: string, color: RGB = C.text, isBold = false): number {
    this.put(end - width(text) + 1, text, color, isBold);
    return end - width(text);
  }
  /** Put several pieces one after another: [text, colour, bold?]. Returns the column after the last. */
  segs(col: number, parts: [string, RGB?, boolean?][]): number {
    for (const [text, color, isBold] of parts) col = this.put(col, text, color, isBold);
    return col;
  }
  /** The same, ending at `end`. */
  segsr(end: number, parts: [string, RGB?, boolean?][]): number {
    const start = end - parts.reduce((n, p) => n + width(p[0]), 0) + 1;
    this.segs(start, parts);
    return start - 1;
  }
  /** Place something already coloured (a sparkline, a gauge, a context bar) that is `w` cells wide. Dropped if it does not fit. */
  paste(col: number, ansi: string, w = cells(ansi)): number {
    if (col >= 1 && w > 0 && col + w - 1 <= this.W) {
      for (let i = 0; i < w; i++) this.free(col - 1 + i);
      const split = ansiCells(ansi);
      if (split) split.slice(0, w).forEach((c, i) => (this.cell[col - 1 + i] = c)); // never more cells than it was said to have
      else {
        // Codes that are not ours: keep it whole.
        this.cell[col - 1] = { ch: ansi, raw: true, span: w };
        for (let i = 1; i < w; i++) this.cell[col - 1 + i] = { ch: "" };
      }
    }
    return col + w;
  }
  /** Set the background from column `from` to `to`, for the amber tint. */
  tint(bg: RGB | undefined, from = 1, to = this.W): this {
    for (let c = Math.max(1, from); c <= Math.min(this.W, to); c++) this.bg[c - 1] = bg;
    return this;
  }
  /** The plain text of the row, without colour. */
  plain(): string {
    return this.cell.map((c) => (c.raw ? c.ch.replace(ANSI, "") : c.ch)).join("");
  }
  toString(): string {
    const bgAt = (i: number) => this.cell[i].bg ?? this.bg[i];
    let out = "";
    let last = this.W;
    while (last > 0 && this.cell[last - 1].ch === " " && !bgAt(last - 1)) last--; // nothing to draw past here
    const UNKNOWN: RGB = [-1, -1, -1]; // after a string kept whole, which may have changed the background itself
    let bg: RGB | undefined;
    for (let i = 0; i < last; ) {
      const c = this.cell[i];
      if (c.ch === "") {
        i++;
        continue;
      }
      if (bgAt(i) !== bg) {
        bg = bgAt(i);
        out += bg ? `\x1b[48;2;${bg[0]};${bg[1]};${bg[2]}m` : "\x1b[49m";
      }
      if (c.raw) {
        out += c.ch;
        bg = UNKNOWN;
        i++;
        continue;
      }
      // Gather the run of cells that share a style and a background.
      let run = "";
      let j = i;
      for (; j < last; j++) {
        const d = this.cell[j];
        if (d.raw || d.color !== c.color || !!d.bold !== !!c.bold || (d.ch !== "" && bgAt(j) !== bg)) break;
        run += d.ch;
      }
      const painted = c.color ? fg(c.color, run) : run;
      out += c.bold ? bold(painted) : painted;
      i = j;
    }
    return out + (bg ? "\x1b[49m" : "");
  }
}

// ───────────────────────── transcript tailing ─────────────────────────

export interface Tail {
  path: string;
  offset: number;
  carry: string;
  decoder: StringDecoder;
  tools: number[]; // timestamps of tool calls
  tokens: Map<string, [number, number]>; // message id -> [timestamp, output tokens]
  lastTool?: { name: string; hint: string; t: number };
  lastResultT: number;
  lastT: number;
  mtime: number;
  birth: number;
  branch?: string;
  title?: string;
  lastPrompt?: string; // from the transcript's own last-prompt marker
  ask?: { text: string; t: number }; // last thing the person typed
  say?: { text: string; t: number }; // last thing Claude wrote
  says: { text: string; t: number }[]; // its last few messages, oldest first
  sayTs: number[]; // when each of its replies in the window was written, for "new since you looked"
  summary?: string; // the session's own "while you were away" summary
  summaryT?: number; // when it was written, so it can be compared with the last prompt
  ctx?: { used: number; model: string; req: string };
  ctxLog: [number, number][]; // its context readings over the last 15 minutes: [time, tokens used]
  parts?: Partial<Record<PartKey, number>>; // characters per context category, from the transcript's own attachments
}
export type PartKey = "system" | "tools" | "mcp" | "agents" | "memory" | "skills";
const ATTACHMENT = /"attachment":\{"type":"(prompt_snapshot|instructions|skill_listing|agent_listing_delta)"/;
const len = (v: unknown) => (typeof v === "string" ? v.length : v == null ? 0 : JSON.stringify(v).length);

/** Record the size of what the session loaded into its window: prompt, tools, memory files, skills, agents. */
export function absorb(t: Tail, line: string) {
  if (line.length > 4_000_000) return;
  let a: any;
  try {
    a = JSON.parse(line).attachment;
  } catch {
    return;
  }
  const parts = (t.parts ??= {});
  if (a?.type === "prompt_snapshot") {
    if (Array.isArray(a.systemPrompt)) parts.system = a.systemPrompt.reduce((n: number, x: unknown) => n + len(x), 0);
    if (Array.isArray(a.tools)) {
      parts.tools = 0;
      parts.mcp = 0;
      for (const tool of a.tools) parts[String(tool?.name).startsWith("mcp__") ? "mcp" : "tools"]! += len(tool?.description) + len(tool?.schema);
    }
  } else if (a?.type === "instructions" && Array.isArray(a.files)) {
    parts.memory = a.files.reduce((n: number, f: any) => n + len(f?.content), 0);
  } else if (a?.type === "skill_listing") {
    parts.skills = (a.isInitial === false ? (parts.skills ?? 0) : 0) + len(a.content);
  } else if (a?.type === "agent_listing_delta" && Array.isArray(a.addedLines)) {
    parts.agents = (a.isInitial === false ? (parts.agents ?? 0) : 0) + a.addedLines.reduce((n: number, x: unknown) => n + len(x), 0);
  }
}
const tails = new Map<string, Tail>();

export function hintFor(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  if (typeof input.questions?.[0]?.question === "string") return input.questions[0].question;
  if (typeof input.description === "string") return input.description;
  if (typeof input.file_path === "string") return path.basename(input.file_path);
  if (typeof input.pattern === "string") return input.pattern;
  if (typeof input.skill === "string") return input.skill;
  return "";
}

/** Read one transcript line into the tail. Text a session wrote is made safe here, once, so everything drawn later already is. */
export function ingest(t: Tail, line: string) {
  if (ATTACHMENT.test(line.slice(0, 2000)) || (line.length < 400_000 && ATTACHMENT.test(line))) return absorb(t, line);
  if (line.length < 2 || !line.includes('"timestamp"')) {
    if (line.length < 20_000 && (line.includes('"ai-title"') || line.includes('"last-prompt"'))) {
      try {
        const o = JSON.parse(line);
        if (typeof o.aiTitle === "string") t.title = safeLine(o.aiTitle);
        if (typeof o.lastPrompt === "string") t.lastPrompt = safeText(o.lastPrompt);
      } catch {}
    }
    return;
  }
  if (line.length > 300_000) {
    // Oversized line (a large tool result): take the timestamp without parsing it.
    const m = /"timestamp":"([^"]+)"/.exec(line.slice(-4000)) ?? /"timestamp":"([^"]+)"/.exec(line.slice(0, 4000));
    const ts = m ? Date.parse(m[1]) : NaN;
    if (!Number.isNaN(ts)) {
      t.lastT = Math.max(t.lastT, ts);
      if (line.startsWith('{"type":"user"') || line.includes('"tool_result"')) t.lastResultT = Math.max(t.lastResultT, ts);
    }
    return;
  }
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  const ts = Date.parse(o.timestamp);
  if (Number.isNaN(ts)) return;
  if (o.type === "system" && o.subtype === "away_summary" && typeof o.content === "string") {
    t.summary = safeText(o.content);
    t.summaryT = ts;
  }
  if (o.type !== "assistant" && o.type !== "user") return;
  t.lastT = Math.max(t.lastT, ts);
  if (typeof o.gitBranch === "string" && o.gitBranch) t.branch = safeLine(o.gitBranch);
  const content = o.message?.content;
  if (o.type === "assistant") {
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item?.type === "tool_use") {
          t.tools.push(ts);
          t.lastTool = { name: safeLine(item.name), hint: safeLine(hintFor(item.name, item.input)), t: ts };
        }
      }
    }
    const u = o.message?.usage;
    const out = u?.output_tokens;
    if (typeof out === "number" && o.message?.id) t.tokens.set(o.message.id, [ts, out]);
    if (!o.isSidechain) {
      if (Array.isArray(content)) for (const item of content) if (item?.type === "text" && typeof item.text === "string" && item.text.trim()) {
          t.say = { text: safeText(item.text), t: ts };
          t.says.push(t.say);
          if (t.says.length > 6) t.says.shift();
          t.sayTs.push(ts);
        }
      if (u) {
        const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        if (used > 0) {
          t.ctx = { used, model: String(o.message?.model ?? ""), req: String(o.requestedModel ?? "") };
          t.ctxLog.push([ts, used]);
          while (t.ctxLog[0][0] < ts - CTX_LOG_MS) t.ctxLog.shift();
        }
      }
    }
  } else if (Array.isArray(content) && content.some((i: any) => i?.type === "tool_result")) {
    t.lastResultT = Math.max(t.lastResultT, ts);
  } else if (!o.isMeta && !o.isSidechain) {
    // Something the person typed. Harness-injected turns start with a tag; skip those.
    const texts: string[] = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((i: any) => i?.type === "text").map((i: any) => String(i.text ?? "")) : [];
    const typed = texts.map((x) => x.trim()).find((x) => x && !x.startsWith("<"));
    if (typed) t.ask = { text: safeText(typed), t: ts };
  }
}

const HEAD_BYTES = 6 * 1024 * 1024;
/** The attachments sit at the start of a transcript, before the part pump() tails; read them once. */
function scanHead(t: Tail, upTo: number) {
  let fd: number;
  try {
    fd = fs.openSync(t.path, "r");
  } catch {
    return;
  }
  try {
    const decoder = new StringDecoder("utf8");
    const buf = Buffer.allocUnsafe(1 << 20);
    let carry = "";
    let pos = 0;
    const end = Math.min(upTo, HEAD_BYTES);
    while (pos < end) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, end - pos), pos);
      if (n <= 0) break;
      pos += n;
      const lines = (carry + decoder.write(buf.subarray(0, n))).split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) if (ATTACHMENT.test(line)) absorb(t, line);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** An empty tail that will start reading `file` at byte `start`. */
export function newTail(file: string, start = 0, birth = 0): Tail {
  return {
    path: file,
    offset: start,
    carry: start > 0 ? "\u0000" : "", // marker: drop the first, partial line
    decoder: new StringDecoder("utf8"),
    tools: [],
    says: [],
    sayTs: [],
    ctxLog: [],
    tokens: new Map(),
    lastResultT: 0,
    lastT: 0,
    mtime: 0,
    birth,
  };
}

const chunk = Buffer.allocUnsafe(1 << 20);
function pump(file: string, isMain = false): Tail | undefined {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    tails.delete(file);
    return undefined;
  }
  let t = tails.get(file);
  if (!t || st.size < t.offset) {
    const start = Math.max(0, st.size - TAIL_BYTES);
    t = newTail(file, start, st.birthtimeMs);
    tails.set(file, t);
    if (isMain && start > 0) scanHead(t, start);
  }
  t.mtime = st.mtimeMs;
  if (st.size === t.offset) return t;
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return t;
  }
  try {
    while (t.offset < st.size) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, st.size - t.offset), t.offset);
      if (n <= 0) break;
      t.offset += n;
      const text = t.carry + t.decoder.write(chunk.subarray(0, n));
      const lines = text.split("\n");
      t.carry = lines.pop() ?? "";
      for (let i = 0; i < lines.length; i++) {
        if (i === 0 && lines[0].startsWith("\u0000")) continue;
        ingest(t, lines[i]);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return t;
}

function prune(now: number) {
  const cutoff = now - WINDOWS[WINDOWS.length - 1] * 60_000;
  for (const t of tails.values()) {
    if (t.tools.length && t.tools[0] < cutoff) t.tools = t.tools.filter((x) => x >= cutoff);
    if (t.sayTs.length && t.sayTs[0] < cutoff) t.sayTs = t.sayTs.filter((x) => x >= cutoff);
    if (t.tokens.size > 5000) for (const [k, v] of t.tokens) if (v[0] < cutoff) t.tokens.delete(k);
  }
}

// ───────────────────────── discovery ─────────────────────────

export interface Agent {
  id: string;
  label: string;
  type: string;
  model: string;
  tail: Tail;
  done: boolean;
  wf?: string;
  phase?: string; // the workflow phase it was started in
}
export interface Workflow {
  id: string;
  name: string;
  status: string;
  phase: string; // the current phase
  phases: string[]; // the declared phase list; known only once the workflow's state file exists
  seen: string[]; // phases that have started, in order, from the journal: what has happened, never a guess
  started: number;
  finished: number;
  agents: Agent[];
  lastT: number;
  tokens?: number;
}
export interface Session {
  sid: string;
  pid: number;
  name: string;
  kind: string;
  status: string;
  cwd: string;
  startedAt: number;
  mains: Tail[];
  agents: Agent[];
  workflows: Workflow[];
  tasks?: { done: number; doing: number; total: number; active: string };
  job?: { state: string; detail: string; needs: string };
  jobId?: string;
}

const readJson = (f: string): any => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
};
const ls = (d: string): string[] => {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
};
/** FLEET_MACHINE_FIXTURE (test only): a JSON file that stands in for this machine (CPU, memory, load, processes), so a frame can be reproduced exactly. */
let machineFixture: any;
const fixtureMachine = (): any => (machineFixture ??= (process.env.FLEET_MACHINE_FIXTURE && readJson(process.env.FLEET_MACHINE_FIXTURE)) || false);
const alive = (pid: number) => {
  if (fixtureMachine() && (fixtureMachine().procs ?? []).some((p: any) => p.pid === pid)) return true; // a made-up process is as alive as its fixture says
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
};

const metaCache = new Map<string, any>();
function meta(jsonl: string): any {
  let m = metaCache.get(jsonl);
  if (!m) {
    m = readJson(jsonl.replace(/\.jsonl$/, ".meta.json"));
    if (m) metaCache.set(jsonl, m);
  }
  return m ?? {};
}

interface Journal {
  mtime: number;
  started: Map<string, any>; // agent id -> its "started" entry
  results: Set<string>; // agents that have reported a result
  phases: string[]; // phases in the order their first agent started
}
/** Read a workflow journal's text: who started, in which phase, and who has finished. */
export function readJournal(text: string, mtime = 0): Journal {
  const started = new Map<string, any>();
  const results = new Set<string>();
  const phases: string[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (o.type === "started") {
        started.set(o.agentId, o);
        const phase = safeLine(o.phase);
        if (phase && !phases.includes(phase)) phases.push(phase);
      } else if (o.type === "result") results.add(o.agentId);
    } catch {}
  }
  return { mtime, started, results, phases };
}
const journalCache = new Map<string, Journal>();
function journal(file: string): Journal {
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return readJournal("");
  }
  const hit = journalCache.get(file);
  if (hit && hit.mtime === mtime) return hit;
  const entry = readJournal(fs.readFileSync(file, "utf8"), mtime);
  journalCache.set(file, entry);
  return entry;
}

let projectsRoot = "";
let projectDirs: string[] = [];
let projectDirsAt = 0;
const sessionDirCache = new Map<string, { at: number; dirs: string[]; mains: string[] }>();
function locate(sid: string, now: number) {
  const root = path.join(claudeHome(), "projects");
  if (root !== projectsRoot) {
    // The home has moved (a test did it): forget what was found under the old one.
    projectsRoot = root;
    projectDirsAt = 0;
    sessionDirCache.clear();
  }
  const hit = sessionDirCache.get(sid);
  if (hit && now - hit.at < 20_000) return hit;
  if (now - projectDirsAt > 20_000) {
    projectDirs = ls(root).map((d) => path.join(root, d));
    projectDirsAt = now;
  }
  const dirs: string[] = [];
  const mains: string[] = [];
  for (const p of projectDirs) {
    if (fs.existsSync(path.join(p, sid))) dirs.push(path.join(p, sid));
    if (fs.existsSync(path.join(p, sid + ".jsonl"))) mains.push(path.join(p, sid + ".jsonl"));
  }
  const entry = { at: now, dirs, mains };
  sessionDirCache.set(sid, entry);
  return entry;
}

const TYPE_SHORT: Record<string, string> = { "general-purpose": "general", "workflow-subagent": "workflow", "claude-code-guide": "guide" };
const shortType = (t: string) => TYPE_SHORT[t] ?? t;

export function shortModel(m: unknown): string {
  return String(m ?? "")
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "");
}

/** The phase a workflow is in: the latest-started phase that still has an agent running, else the latest started. */
export function currentPhase(seen: string[], running: Agent[]): string {
  const live = running.map((a) => seen.indexOf(a.phase ?? "")).filter((i) => i >= 0);
  return seen[live.length ? Math.max(...live) : seen.length - 1] ?? "";
}

export interface PhaseStep {
  name: string;
  state: "done" | "now" | "next"; // ✓ passed, ◐ current, ○ later
}
/**
 * A workflow's phase trail, oldest first. Passed and current phases come from the journal's "started"
 * entries. Later phases appear only when the declared list is known (wf.phases), which today means the
 * workflow's state file exists. A phase that still has an agent running counts as current, so two can be.
 */
export function phaseTrail(wf: Workflow): PhaseStep[] {
  const live = wf.status === "running";
  const busy = new Set(wf.agents.filter((a) => !a.done).map((a) => a.phase ?? ""));
  const list = wf.phases.length ? [...wf.phases, ...wf.seen.filter((p) => !wf.phases.includes(p))] : wf.seen;
  const at = list.indexOf(wf.phase);
  return list.map((name, i) => {
    const started = wf.seen.includes(name);
    if (live && (name === wf.phase || busy.has(name))) return { name, state: "now" };
    if (live && wf.phases.length && (at >= 0 ? i > at : !started)) return { name, state: "next" };
    return { name, state: started || !live ? "done" : "next" };
  });
}
/** How a workflow ended: ✓ completed, ✗ anything else that is not running (failed, stopped, cancelled). */
export const wfOutcome = (wf: Workflow): "running" | "completed" | "failed" => (wf.status === "running" ? "running" : wf.status === "completed" ? "completed" : "failed");

function loadAgent(file: string, wf?: string, started?: any, done = false): Agent | undefined {
  const tail = pump(file);
  if (!tail) return undefined;
  const m = meta(file);
  const finalTool = !!tail.lastTool && FINAL_TOOLS.has(tail.lastTool.name) && tail.lastResultT >= tail.lastTool.t;
  return {
    id: path.basename(file, ".jsonl").replace(/^agent-/, ""),
    label: safeLine(started?.label || m.description || path.basename(file, ".jsonl")),
    type: safeLine(m.agentType),
    model: safeLine(shortModel(m.model)),
    tail,
    done: done || finalTool,
    wf,
    phase: wf ? safeLine(started?.phase ?? m.workflowPhase) : undefined,
  };
}

export function scan(now: number): Session[] {
  const sessions: Session[] = [];
  const CLAUDE = claudeHome();
  for (const f of ls(path.join(CLAUDE, "sessions"))) {
    if (!f.endsWith(".json")) continue;
    const reg = readJson(path.join(CLAUDE, "sessions", f));
    if (!reg?.sessionId || !alive(reg.pid)) continue;
    const sid: string = reg.sessionId;
    const loc = locate(sid, now);
    const mains = loc.mains.map((m) => pump(m, true)).filter(Boolean) as Tail[];
    const agents: Agent[] = [];
    const workflows: Workflow[] = [];

    for (const dir of loc.dirs) {
      const sub = path.join(dir, "subagents");
      for (const name of ls(sub)) {
        if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
        const a = loadAgent(path.join(sub, name));
        if (a) agents.push(a);
      }
      const scripts = ls(path.join(dir, "workflows", "scripts"));
      for (const wfId of ls(path.join(sub, "workflows"))) {
        if (!wfId.startsWith("wf_")) continue;
        const wfDir = path.join(sub, "workflows", wfId);
        const j = journal(path.join(wfDir, "journal.jsonl"));
        const state = readJson(path.join(dir, "workflows", wfId + ".json"));
        const wfAgents: Agent[] = [];
        for (const name of ls(wfDir)) {
          if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
          const id = name.slice(6, -6);
          const a = loadAgent(path.join(wfDir, name), wfId, j.started.get(id), j.results.has(id) || !!state);
          if (a) wfAgents.push(a);
        }
        const lastT = Math.max(j.mtime, ...wfAgents.map((a) => a.tail.mtime), 0);
        const running = wfAgents.filter((a) => !a.done);
        const script = scripts.find((x) => x.endsWith(`-${wfId}.js`));
        const phases: string[] = Array.isArray(state?.phases) ? state.phases.map((p: any) => safeLine(p?.title)).filter(Boolean) : [];
        workflows.push({
          id: wfId,
          name: safeLine(state?.workflowName || (script ? script.slice(0, -(wfId.length + 4)) : wfId)),
          status: state?.status ? safeLine(state.status) : running.length ? "running" : "stopped",
          phase: currentPhase(j.phases, running),
          phases,
          seen: j.phases,
          started: state?.startTime ?? Math.min(...wfAgents.map((a) => a.tail.birth), now),
          finished: state ? (state.startTime ?? 0) + (state.durationMs ?? 0) : 0,
          agents: wfAgents,
          lastT,
          tokens: typeof state?.totalTokens === "number" ? state.totalTokens : undefined,
        });
      }
    }

    let tasks: Session["tasks"];
    const taskFiles = ls(path.join(CLAUDE, "tasks", sid)).filter((n) => n.endsWith(".json"));
    if (taskFiles.length) {
      const all = taskFiles.map((n) => readJson(path.join(CLAUDE, "tasks", sid, n))).filter(Boolean);
      const open = all.filter((t) => t.status !== "deleted");
      const current = open.find((t) => t.status === "in_progress");
      tasks = {
        done: open.filter((t) => t.status === "completed").length,
        doing: open.filter((t) => t.status === "in_progress").length,
        total: open.length,
        active: safeLine(current?.activeForm || current?.subject),
      };
    }

    let job: Session["job"];
    if (reg.jobId && /^[\w-]+$/.test(String(reg.jobId))) {
      const st = readJson(path.join(CLAUDE, "jobs", String(reg.jobId), "state.json"));
      if (st) job = { state: safeLine(st.state), detail: typeof st.detail === "string" ? safeText(st.detail) : "", needs: typeof st.needs === "string" ? safeText(st.needs) : "" };
    }

    const title = mains.map((m) => m.title).find(Boolean);
    const named = safeLine(reg.name && reg.name !== sid.slice(0, 8) ? reg.name : title || (reg.name ?? sid.slice(0, 8)));
    sessions.push({
      sid,
      pid: reg.pid,
      name: named,
      kind: safeLine(reg.kind),
      status: safeLine(reg.status),
      cwd: safeLine(reg.cwd),
      startedAt: Number(reg.startedAt ?? now),
      mains,
      agents,
      workflows,
      tasks,
      job,
      jobId: job ? String(reg.jobId) : undefined,
    });
  }
  return sessions;
}

// ───────────────────────── machine and account ─────────────────────────

export interface Proc {
  pid: number;
  ppid: number;
  cpu: number;
  rss: number; // kilobytes
  name: string;
}
export const machine = {
  cores: [] as number[],
  cpu: 0,
  hist: [] as number[],
  memUsed: 0,
  memTotal: os.totalmem(),
  load: 0,
  procs: [] as Proc[],
  kids: new Map<number, Proc[]>(),
  prev: [] as { idle: number; total: number }[],
};

/** A process's name as the screen may show it: the program's file name, made safe like any other text that did not come from here (a program can call itself anything, escape sequences included). */
export const procName = (comm: string): string => safeLine(path.basename(comm.trim()));

export function sampleMachine() {
  const fx = fixtureMachine();
  if (fx) {
    machine.cores = fx.cores ?? [];
    machine.cpu = fx.cpu ?? (machine.cores.length ? sum(machine.cores) / machine.cores.length : 0);
    machine.hist = fx.hist ?? [machine.cpu];
    machine.load = fx.load ?? 0;
    machine.memTotal = fx.memTotal ?? machine.memTotal;
    machine.memUsed = fx.memUsed ?? 0;
    machine.procs = (fx.procs ?? []).map((p: any) => ({ pid: +p.pid, ppid: +(p.ppid ?? 1), cpu: +(p.cpu ?? 0), rss: +(p.rss ?? 0), name: procName(String(p.name ?? "")) }));
    machine.kids = new Map();
    for (const p of machine.procs) machine.kids.set(p.ppid, [...(machine.kids.get(p.ppid) ?? []), p]);
    return;
  }
  const cpus = os.cpus();
  const snap = cpus.map((c) => {
    const total = c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    return { idle: c.times.idle, total };
  });
  machine.cores = snap.map((x, i) => {
    const p = machine.prev[i] ?? { idle: 0, total: 0 };
    const dt = x.total - p.total;
    return dt > 0 ? Math.max(0, Math.min(100, (1 - (x.idle - p.idle) / dt) * 100)) : 0;
  });
  machine.prev = snap;
  machine.cpu = machine.cores.length ? sum(machine.cores) / machine.cores.length : 0;
  machine.hist.push(machine.cpu);
  if (machine.hist.length > 120) machine.hist.shift();
  machine.load = os.loadavg()[0];

  machine.memUsed = os.totalmem() - os.freemem();
  try {
    if (process.platform === "darwin") {
      // "free" memory on macOS is mostly cache; count what apps, the kernel and the compressor hold.
      const vm = spawnSync("vm_stat", { encoding: "utf8", timeout: 2000 }).stdout ?? "";
      const page = Number(/page size of (\d+)/.exec(vm)?.[1] ?? 16384);
      const pages = (label: string) => Number(new RegExp(label + ":\\s+(\\d+)").exec(vm)?.[1] ?? 0);
      const used = (pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) * page;
      if (used > 0) machine.memUsed = used;
    } else if (process.platform === "linux") {
      const info = fs.readFileSync("/proc/meminfo", "utf8");
      const kb = (label: string) => Number(new RegExp(label + ":\\s+(\\d+)").exec(info)?.[1] ?? 0);
      if (kb("MemAvailable")) machine.memUsed = (kb("MemTotal") - kb("MemAvailable")) * 1024;
    }
  } catch {}

  try {
    const ps = spawnSync("ps", ["-axo", "pid=,ppid=,pcpu=,rss=,comm="], { encoding: "utf8", timeout: 3000, maxBuffer: 16 << 20 }).stdout ?? "";
    const procs: Proc[] = [];
    const kids = new Map<number, Proc[]>();
    for (const line of ps.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const proc = { pid: +m[1], ppid: +m[2], cpu: +m[3], rss: +m[4], name: procName(m[5]) };
      procs.push(proc);
      if (!kids.has(proc.ppid)) kids.set(proc.ppid, []);
      kids.get(proc.ppid)!.push(proc);
    }
    machine.procs = procs;
    machine.kids = kids;
  } catch {}
}

/** CPU and memory of a process and everything it started. `known` is false when the process was not in the last sample. */
export function treeUsage(pid: number): { cpu: number; rss: number; known: boolean } {
  const root = machine.procs.find((p) => p.pid === pid);
  let cpu = root?.cpu ?? 0;
  let rss = root?.rss ?? 0;
  const stack = [...(machine.kids.get(pid) ?? [])];
  const seen = new Set<number>([pid]);
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    cpu += p.cpu;
    rss += p.rss;
    stack.push(...(machine.kids.get(p.pid) ?? []));
  }
  return { cpu, rss, known: !!root };
}

/** The busiest processes, at 5% CPU or more, busiest first. Empty under FLEET_HIDE_PROCESSES=1, which keeps other programs' names off the screen. */
export const topProcs = (n: number): Proc[] => (HIDE_TOP ? [] : [...machine.procs].sort((a, b) => b.cpu - a.cpu).slice(0, n).filter((p) => p.cpu >= 5));

export const gb = (bytes: number) => (bytes / 1024 ** 3 >= 10 ? Math.round(bytes / 1024 ** 3) : (bytes / 1024 ** 3).toFixed(1)) + "G";

function machineRow(W: number): string {
  const cpuTone = toneFor(machine.cpu);
  const memPct = (machine.memUsed / machine.memTotal) * 100;
  const HW = W >= 150 ? 24 : 12;
  const hist = machine.hist.slice(-HW);
  const coreGlyphs = machine.cores.map((c) => fg(mix(C.faint, toneFor(c), 0.35 + (c / 100) * 0.65), BARS[Math.min(7, Math.floor((c / 100) * 8))])).join("");
  let line =
    fg(C.dim, " cpu ") + gauge(machine.cpu, 10, cpuTone) + fg(cpuTone, fit(`${Math.round(machine.cpu)}%`, 5, "r")) +
    "  " + spark([...new Array(HW - hist.length).fill(0), ...hist], 100, [40, 110, 90], [240, 200, 90]) +
    (W >= 110 ? fg(C.dim, "  cores ") + coreGlyphs : "") +
    fg(C.dim, "   mem ") + gauge(memPct, 10, toneFor(memPct)) + fg(C.text, ` ${gb(machine.memUsed)} of ${gb(machine.memTotal)}`) +
    fg(C.dim, `   load ${machine.load.toFixed(1)}`);
  const usedW = 5 + 10 + 5 + 2 + HW + (W >= 110 ? 8 + machine.cores.length : 0) + 7 + 10 + width(` ${gb(machine.memUsed)} of ${gb(machine.memTotal)}`) + width(`   load ${machine.load.toFixed(1)}`);
  const topText = topProcs(4).map((p) => `${p.name.slice(0, 18)} ${Math.round(p.cpu)}%`).join(" · ");
  if (topText && W - usedW - 9 > 16) line += fg(C.dim, "   top ") + fg(C.text, fit(topText, W - usedW - 8));
  return line;
}

// ───────────────────────── account usage ─────────────────────────
//
// With --usage the dashboard reads the Claude Code login already stored on this machine and asks
// Anthropic for the account's usage figures. The login is held in memory for the length of one request:
// it is never written, logged or printed, and only the exit status and stderr of the keychain tool may
// be shown. When the read fails the screen says exactly why, and falls back to figures (never the login)
// that another dashboard or Claude Code itself has already fetched.

/** Why a usage read failed. Each is reported exactly; the last is allowed only when the keychain and the login file both said "not found". */
export const REASON = {
  keychainMissing: "keychain: item not found",
  keychainSilent: "keychain: no answer in 5s",
  keychainExit: (status: number) => `keychain: exit ${status}`,
  keychainNotJson: "keychain: entry is not JSON",
  keychainNoLogin: "keychain: no claude.ai login in entry",
  keychainRemote: "keychain: closed to remote sessions (ssh/mosh)",
  fileMissing: "login file: not found",
  fileNoLogin: "login file: no claude.ai login in it",
  expired: "token expired · any Claude Code session renews it",
  answered: (status: number) => `Anthropic answered ${status}`,
  timedOut: "network: timed out",
  network: (code: string) => `network: ${code}`,
  none: "no Claude Code login found",
};
/** What can be done about a reason, for the one dim line under the account block. Standard remedies, not tested here. */
export function usageRemedy(reason: string): string {
  if (reason === REASON.keychainRemote) return "run: security unlock-keychain ~/Library/Keychains/login.keychain-db  ·  or start fleet in a tmux begun on the Mac itself";
  return "";
}

/** What a stored login looked like when parsed: usable, JSON without a claude.ai login, not JSON, or nothing at all. */
export type LoginParse = "login" | "no-login" | "not-json" | "empty";
/** How the keychain call ended. It never carries what the call printed. */
export interface KeychainOutcome {
  status: number | null; // exit status; null when the tool was killed or could not be run
  stderr: string;
  timedOut: boolean;
  parse: LoginParse; // what its output parsed as, when it exited 0
}
/** How reading ~/.claude/.credentials.json ended. */
export type FileOutcome = LoginParse | "missing";

/** True when this process was reached over ssh or mosh, where macOS will not hand out keychain content. */
export function isRemoteSession(env: Record<string, string | undefined>, ancestors: string[]): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return true;
  if (Object.keys(env).some((k) => k.startsWith("MOSH_SERVER_"))) return true; // not MOSH_ESCAPE_KEY and the like: those configure the mosh client, and sit in a local shell's profile
  return ancestors.some((name) => /^(mosh-server|sshd)/.test(name));
}

/** The keychain's part of the story: "" when it produced a login, else the exact reason. */
export function keychainReason(k: KeychainOutcome, remote: boolean): string {
  if (k.status === 0 && !k.timedOut) return k.parse === "login" ? "" : k.parse === "no-login" ? REASON.keychainNoLogin : REASON.keychainNotJson;
  if (!k.timedOut && (k.status === 44 || /could not be found/i.test(k.stderr))) return REASON.keychainMissing;
  // macOS finds the item but refuses to return its content to a remote login ("User interaction is not allowed").
  if (remote || k.status === 36 || /interaction is not allowed/i.test(k.stderr)) return REASON.keychainRemote;
  if (k.timedOut) return REASON.keychainSilent;
  return REASON.keychainExit(k.status ?? -1);
}
/** The login file's part: "" when it holds a login. */
export const fileReason = (f: FileOutcome): string => (f === "login" ? "" : f === "missing" ? REASON.fileMissing : REASON.fileNoLogin);

/**
 * Decide where the login comes from, or exactly why there is none, from how the two reads ended. Pure:
 * it sees outcomes, never a login. `k` is undefined where there is no keychain (not macOS).
 */
export function loginDecision(k: KeychainOutcome | undefined, f: FileOutcome, remote: boolean): { use: "keychain" | "file" } | { reason: string; keychain: string; file: string } {
  const keychain = k ? keychainReason(k, remote) : "";
  if (k && !keychain) return { use: "keychain" };
  if (f === "login") return { use: "file" };
  const file = fileReason(f);
  if (!k) return { reason: file, keychain, file };
  // "No login found" is only true when both places answered "not found"; otherwise the keychain, where Claude Code keeps the login on a Mac, explains it.
  return { reason: keychain === REASON.keychainMissing && file === REASON.fileMissing ? REASON.none : keychain, keychain, file };
}

interface Login {
  token: string;
  expiresAt: number;
}
function parseLogin(raw: string): { parse: LoginParse; login?: Login } {
  if (!raw.trim()) return { parse: "empty" };
  let o: any;
  try {
    o = JSON.parse(raw)?.claudeAiOauth;
  } catch {
    return { parse: "not-json" };
  }
  return o?.accessToken ? { parse: "login", login: { token: String(o.accessToken), expiresAt: Number(o.expiresAt ?? 0) } } : { parse: "no-login" };
}
/** Names of this process's ancestors, from the last process sample. */
function ancestorNames(): string[] {
  const names: string[] = [];
  let pid = process.pid;
  for (let i = 0; i < 40; i++) {
    const p = machine.procs.find((x) => x.pid === pid);
    if (!p || p.ppid <= 1) break;
    const parent = machine.procs.find((x) => x.pid === p.ppid);
    if (!parent) break;
    names.push(parent.name);
    pid = parent.pid;
  }
  return names;
}
/** The stored login, or the exact reason there is none. The keychain call is the one the dashboard has always made. */
function readLogin(): { login: Login } | { reason: string } {
  let k: KeychainOutcome | undefined;
  let fromKeychain: Login | undefined;
  if (process.platform === "darwin") {
    k = { status: 127, stderr: "", timedOut: false, parse: "empty" };
    try {
      const r = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", timeout: 5000 });
      const parsed: { parse: LoginParse; login?: Login } = r.status === 0 ? parseLogin(r.stdout ?? "") : { parse: "empty" };
      const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || (r.status === null && r.signal === "SIGTERM");
      k = { status: r.error && !timedOut ? 127 : r.status, stderr: String(r.stderr ?? ""), timedOut, parse: parsed.parse };
      fromKeychain = parsed.login;
    } catch {}
  }
  let f: FileOutcome = "missing";
  let fromFile: Login | undefined;
  if (!fromKeychain) {
    try {
      const parsed = parseLogin(fs.readFileSync(path.join(claudeHome(), ".credentials.json"), "utf8"));
      f = parsed.parse === "empty" ? "not-json" : parsed.parse;
      fromFile = parsed.login;
    } catch (e: any) {
      f = e?.code === "ENOENT" ? "missing" : "not-json";
    }
  }
  const d = loginDecision(k, f, isRemoteSession(process.env, ancestorNames()));
  if ("reason" in d) return { reason: d.reason };
  return { login: (d.use === "keychain" ? fromKeychain : fromFile)! };
}

/** Anthropic's usage figures: a utilisation and reset time per limit window, and the extra-usage spend. Nothing else. */
export interface UsageWindow {
  utilization: number; // percent
  resets_at: string | null; // ISO time
}
export interface ExtraUsage {
  is_enabled?: boolean;
  monthly_limit?: number;
  used_credits?: number;
  utilization?: number;
  currency?: string;
  decimal_places?: number;
}
export type UsageFigures = { extra_usage?: ExtraUsage } & { [window: string]: UsageWindow | ExtraUsage | undefined };

/**
 * Keep only figures from a usage answer: for each limit window its utilisation and reset time, and the
 * extra-usage numbers. Everything else is dropped, whatever it is, so nothing that is not a figure can
 * reach the screen or the shared file.
 */
export function figuresOnly(raw: any): UsageFigures {
  const out: UsageFigures = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, v] of Object.entries(raw) as [string, any][]) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key) || !v || typeof v !== "object") continue;
    if (key === "extra_usage") {
      const x: ExtraUsage = {};
      if (typeof v.is_enabled === "boolean") x.is_enabled = v.is_enabled;
      for (const k of ["monthly_limit", "used_credits", "utilization", "decimal_places"] as const) if (typeof v[k] === "number" && Number.isFinite(v[k])) x[k] = v[k];
      if (typeof v.currency === "string" && /^[A-Za-z]{3}$/.test(v.currency)) x.currency = v.currency.toUpperCase();
      out.extra_usage = x;
    } else if (typeof v.utilization === "number" && Number.isFinite(v.utilization)) {
      const resets = typeof v.resets_at === "string" && !Number.isNaN(Date.parse(v.resets_at)) ? new Date(Date.parse(v.resets_at)).toISOString() : null;
      out[key] = { utilization: v.utilization, resets_at: resets };
    }
  }
  return out;
}

/** The one file the dashboard ever writes: the last figures a dashboard fetched, for dashboards that cannot read the login themselves. */
export const sharedUsagePath = () => path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "claude-fleet", "usage.json");
/** What goes in that file: Anthropic's figures and when they were fetched. */
export const sharedUsageContent = (figures: unknown, fetchedAt: number): string => JSON.stringify({ fetchedAt, ...figuresOnly(figures) }) + "\n";
/** Write it for other dashboards: mode 0600, and atomically, so a reader never sees half a file. */
export function writeSharedUsage(figures: unknown, fetchedAt: number, file = sharedUsagePath()): boolean {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, sharedUsageContent(figures, fetchedAt), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return false;
  }
}
export interface Reading {
  figures: UsageFigures;
  fetchedAt: number;
}
/** Read figures another dashboard shared. */
export function readSharedUsage(file = sharedUsagePath()): Reading | undefined {
  const o = readJson(file);
  if (!o || typeof o.fetchedAt !== "number") return undefined;
  return { figures: figuresOnly(o), fetchedAt: o.fetchedAt };
}
/** Read the figures Claude Code itself last fetched: the cachedUsageUtilization entry of ~/.claude.json, and no other key. */
export function readClaudeUsage(file = path.join(process.env.FLEET_HOME || process.env.AGENT_FLEET_HOME || os.homedir(), ".claude.json")): Reading | undefined {
  const c = readJson(file)?.cachedUsageUtilization;
  if (!c || typeof c.fetchedAtMs !== "number" || !c.utilization) return undefined;
  return { figures: figuresOnly(c.utilization), fetchedAt: c.fetchedAtMs };
}

const USAGE_CURRENT_MS = 10 * 60_000; // figures younger than this count as current
const USAGE_DEAD_MS = 24 * 3600_000; // older than this is no reading at all
const USAGE_EVERY_MS = 5 * 60_000; // how often a working read is repeated

export const usage = {
  at: 0, // when a read was last tried
  nextTry: 0, // when the next one is due
  busy: false,
  failures: 0, // failed reads in a row
  reason: "", // why our own last read failed, exactly; "" when it worked or none has been tried
  data: undefined as UsageFigures | undefined, // the newest figures we have, from wherever
  fetchedAt: 0, // when Anthropic gave them
  source: "" as "" | "own" | "shared" | "claude", // our own read, another dashboard's file, or Claude Code's own cache
  sharedAt: 0, // when the fallbacks were last looked at
};

/** How long to wait before the next read: five minutes after a success, sooner after a failure, backing off while it keeps failing. */
export function retryDelay(reason: string, failures: number): number {
  if (!reason) return USAGE_EVERY_MS;
  const doubling = 2 ** Math.max(0, Math.min(6, failures - 1));
  if (/^Anthropic answered 429/.test(reason)) return Math.min(30 * 60_000, USAGE_EVERY_MS * doubling); // asked to slow down: 5, 10, 20, 30 minutes
  // A keychain call that hangs freezes the screen for five seconds, and a keychain closed to this session stays closed until you unlock it (then press u): do not hurry.
  if (reason === REASON.keychainSilent || reason === REASON.keychainRemote) return USAGE_EVERY_MS;
  return Math.min(USAGE_EVERY_MS, 60_000 * doubling); // 1, 2, 4, then every 5 minutes
}

/** One read of the figures from Anthropic with the stored login, or the exact reason it could not be done. */
async function readUsage(now: number): Promise<Reading | { reason: string }> {
  // Test hooks: a forced failure reason, or figures from a file instead of the login and the network.
  if (process.env.FLEET_USAGE_FAIL) return { reason: process.env.FLEET_USAGE_FAIL };
  if (process.env.FLEET_USAGE_FIXTURE) {
    const o = readJson(process.env.FLEET_USAGE_FIXTURE);
    return o ? { figures: figuresOnly(o), fetchedAt: typeof o.fetchedAt === "number" ? o.fetchedAt : now } : { reason: REASON.network("fixture not found") };
  }
  const found = readLogin();
  if ("reason" in found) return found;
  if (found.login.expiresAt && found.login.expiresAt < Date.now()) return { reason: REASON.expired };
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${found.login.token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10_000),
      verbose: false, // with BUN_CONFIG_VERBOSE_FETCH=curl set, Bun would print this request, login and all, to the terminal
    });
  } catch (e: any) {
    return { reason: e?.name === "TimeoutError" || e?.name === "AbortError" ? REASON.timedOut : REASON.network(String(e?.code || "no connection").slice(0, 40)) };
  }
  if (!res.ok) return { reason: REASON.answered(res.status) };
  try {
    return { figures: figuresOnly(await res.json()), fetchedAt: now };
  } catch {
    return { reason: REASON.network("answer was not JSON") };
  }
}

/** While our own read is failing, take the freshest figures somebody else fetched: another dashboard's shared file, then Claude Code's own cache. */
function adoptSharedUsage(now: number) {
  usage.sharedAt = now;
  // With both test hooks set, the fixture stands in for the shared file.
  const fixture = process.env.FLEET_USAGE_FAIL && process.env.FLEET_USAGE_FIXTURE ? readSharedUsage(process.env.FLEET_USAGE_FIXTURE) : undefined;
  const shared = fixture ?? readSharedUsage();
  const claude = readClaudeUsage();
  const best = shared && (!claude || shared.fetchedAt >= claude.fetchedAt) ? shared : claude;
  if (!best || best.fetchedAt <= usage.fetchedAt || !Object.keys(best.figures).length) return;
  usage.data = best.figures;
  usage.fetchedAt = best.fetchedAt;
  usage.source = best === shared ? "shared" : "claude";
}

/** Read the usage figures now. Key u calls this at once; refresh() calls it when the next try is due. `read` is replaced only by tests. */
export async function fetchUsage(now = clock(), read: (now: number) => Promise<Reading | { reason: string }> = readUsage) {
  if (usage.busy) return;
  usage.busy = true;
  usage.at = now;
  try {
    const r = await read(now);
    if ("reason" in r) {
      usage.reason = r.reason.slice(0, 80);
      usage.failures++;
      adoptSharedUsage(now);
    } else {
      usage.data = figuresOnly(r.figures);
      usage.fetchedAt = r.fetchedAt;
      usage.source = "own";
      usage.reason = "";
      usage.failures = 0;
      if (!process.env.FLEET_USAGE_FIXTURE) writeSharedUsage(r.figures, r.fetchedAt); // made-up figures are never shared
    }
  } finally {
    usage.busy = false;
    usage.nextTry = now + retryDelay(usage.reason, usage.failures);
  }
}
/** Called on every refresh: start a read when one is due, and while ours is failing keep an eye on the shared figures. */
function tickUsage(now: number) {
  if (now >= usage.nextTry) void fetchUsage(now);
  else if (usage.reason && now - usage.sharedAt >= 30_000) adoptSharedUsage(now);
}

/**
 * What the account block should show. current: figures under ten minutes old (failing is set when they
 * came from somewhere else because our own read fails). stale: older figures, drawn dim with "as of" and
 * the reason. none: no figures under a day old; say "no reading yet", the reason and the next try.
 */
export type UsageState =
  | { kind: "current"; data: UsageFigures; asOf: number; failing: string }
  | { kind: "stale"; data: UsageFigures; asOf: number; reason: string }
  | { kind: "none"; reason: string; nextTry: number };
export function usageStateOf(u: { data?: UsageFigures; fetchedAt: number; reason: string; nextTry: number }, now: number): UsageState {
  const age = now - u.fetchedAt;
  if (u.data && age < USAGE_CURRENT_MS) return { kind: "current", data: u.data, asOf: u.fetchedAt, failing: u.reason };
  if (u.data && age < USAGE_DEAD_MS) return { kind: "stale", data: u.data, asOf: u.fetchedAt, reason: u.reason };
  return { kind: "none", reason: u.reason, nextTry: u.nextTry };
}
export const usageState = (now: number): UsageState => usageStateOf(usage, now);

const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);
/** When a limit resets: "resets in 2h10" under a day away, else "resets Fri 09:00". short: "2h10 left" / "Fri 09:00". bare: "2h10" / "Fri 09:00". */
export function resetText(resetsAt: number, now: number, form: "long" | "short" | "bare" = "long"): string {
  if (!resetsAt || resetsAt <= now) return "";
  if (resetsAt - now < 24 * 3600_000) {
    const m = Math.max(1, Math.round((resetsAt - now) / 60_000));
    const left = m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
    return form === "long" ? `resets in ${left}` : form === "short" ? `${left} left` : left;
  }
  const at = Math.round(resetsAt / 60_000) * 60_000; // Anthropic's reset times can be a fraction of a second short of the minute
  const day = `${new Date(at).toLocaleDateString("en-GB", { weekday: "short" })} ${hhmm(at)}`;
  return form === "long" ? `resets ${day}` : day;
}

/** One limit window, ready to draw: its label, how full it is, and when it resets. */
export interface LimitView {
  key: string; // Anthropic's name: five_hour, seven_day, seven_day_opus, seven_day_sonnet
  label: string; // "5h", "7d", "opus", "sonnet"
  pct: number;
  resetsAt: number; // 0 when unknown
  windowMs: number;
  tick?: number; // pace tick: the share of the window that has passed, 0 to 1
  fullIn?: number; // milliseconds until 100% at the current pace, when that is before the reset ("full in ~35m" replaces "resets in …")
}
/** Everything the account block draws, with no layout in it. */
export interface AccountView {
  kind: "current" | "stale" | "none";
  limits: LimitView[]; // 5h and 7d first, then the Opus and Sonnet weeks when Anthropic returned them
  extra?: { enabled: boolean; pct: number; used: string; limit: string }; // "£12" of "£50"
  asOf: number; // when the figures were fetched; 0 with no reading
  reason: string; // why our own read is failing, exactly; "" when it is not
  remedy: string; // one line on what to do about it, when there is something
  nextTry: number;
  busy: boolean; // a read is in flight
}
const LIMITS: [key: string, label: string, windowMs: number][] = [
  ["five_hour", "5h", 5 * 3600_000],
  ["seven_day", "7d", 7 * 86_400_000],
  ["seven_day_opus", "opus", 7 * 86_400_000],
  ["seven_day_sonnet", "sonnet", 7 * 86_400_000],
];
export function accountViewOf(state: UsageState, u: { nextTry: number; busy: boolean }, now: number): AccountView {
  const reason = state.kind === "current" ? state.failing : state.reason;
  const view: AccountView = { kind: state.kind, limits: [], asOf: state.kind === "none" ? 0 : state.asOf, reason, remedy: usageRemedy(reason), nextTry: u.nextTry, busy: u.busy };
  if (state.kind === "none") return view;
  for (const [key, label, windowMs] of LIMITS) {
    const w = state.data[key] as UsageWindow | undefined;
    if (!w || typeof w.utilization !== "number") continue;
    const resetsAt = w.resets_at ? Date.parse(w.resets_at) || 0 : 0;
    // A forecast is made only from current figures; the tick is just the clock, so stale figures keep it.
    view.limits.push({ key, label, pct: w.utilization, resetsAt, windowMs, tick: paceTick(resetsAt, windowMs, now), fullIn: state.kind === "current" ? paceForecast(w.utilization, resetsAt, windowMs, now) : undefined });
  }
  const x = state.data.extra_usage;
  if (x) {
    const sign = x.currency === "GBP" ? "£" : x.currency === "EUR" ? "€" : "$";
    const money = (n: number) => `${sign}${(n / 10 ** (x.decimal_places ?? 2)).toFixed(0)}`;
    const limit = x.monthly_limit ?? 0;
    const used = x.used_credits ?? 0;
    view.extra = { enabled: !!x.is_enabled, pct: typeof x.utilization === "number" ? x.utilization : limit > 0 ? (used / limit) * 100 : 0, used: money(used), limit: money(limit) };
  }
  return view;
}
export const accountView = (now: number): AccountView => accountViewOf(usageState(now), usage, now);

function usageRow(W: number, now: number): string {
  const lead = fg(C.dim, " account ");
  const a = accountView(now);
  if (a.kind === "none") {
    const why = a.reason ? `no reading yet: ${a.reason} · next try ${hhmm(a.nextTry)} · u retries` : a.busy || !usage.at ? "fetching usage…" : "no reading yet";
    return lead + fg(C.dim, fit(why, W - 10));
  }
  const stale = a.kind === "stale";
  const GW = W >= 140 ? 16 : 10;
  let line = lead;
  let used = 9;
  for (const l of a.limits) {
    if ((l.key === "seven_day_opus" || l.key === "seven_day_sonnet") && W < 150) continue;
    const label = l.key === "five_hour" ? "5-hour" : l.key === "seven_day" ? "week" : `${l.label} wk`;
    const resets = resetText(l.resetsAt, now);
    const text = `  ${label} ${"━".repeat(GW)} ${Math.round(l.pct)}%${resets ? " · " + resets : ""}`;
    if (used + width(text) > W - 1) break;
    const tone = stale ? C.dim : toneFor(l.pct);
    line += fg(C.dim, `  ${label} `) + gauge(l.pct, GW, tone) + fg(tone, ` ${Math.round(l.pct)}%`) + fg(C.dim, resets ? " · " + resets : "");
    used += width(text);
  }
  // While a read is failing, say so before anything else that is optional.
  if (stale || a.reason) {
    const why = fit(`(${stale ? `as of ${hhmm(a.asOf)}` : "shared figures"}${a.reason ? " · " + a.reason : ""})`, Math.min(W - 1 - used - 3, 70)).trimEnd();
    line += "   " + fg(C.dim, why);
    used += 3 + width(why);
  }
  if (a.extra && W >= 120) {
    const text = a.extra.enabled ? `${a.extra.used} of ${a.extra.limit}` : "off";
    if (used + 15 + width(text) <= W - 1) line += fg(C.dim, "   extra usage ") + fg(stale || !a.extra.enabled ? C.dim : C.text, text);
  }
  return line;
}

// ───────────────────────── rendering ─────────────────────────

/**
 * The stretch of wall-clock time a strip of `n` bars shows. The bars sit on fixed clock edges: with a
 * bar length of window / n, bar k covers [k·bar, (k+1)·bar), and the strip ends with the bar still
 * filling. So a bar changes only when a tool call lands in it, and the strip steps left one cell when
 * a bar closes. Cutting the window at "now minus span" instead moved every edge each second, which is
 * what made the sparklines shimmer.
 */
export interface Win {
  bar: number; // milliseconds per bar
  n: number; // bars in the strip
  first: number; // index of the leftmost bar, counted from the epoch
  start: number; // first * bar: the oldest moment shown
  end: number; // (first + n) * bar: when the bar still filling will close
}
export function timeWindow(now: number, windowMs: number, n: number): Win {
  const bar = windowMs / n;
  const first = Math.floor(now / bar) - n + 1;
  return { bar, n, first, start: first * bar, end: (first + n) * bar };
}
/** Which bar of `win` the moment `t` falls in; negative before the window, `win.n` or more after it. */
export const barOf = (t: number, win: Win) => Math.floor(t / win.bar) - win.first;

/** Count the timestamps of each list (oldest first) into the bars of `win`. */
export function bucketsIn(lists: number[][], win: Win): number[] {
  const out = new Array(win.n).fill(0);
  for (const list of lists)
    for (let i = list.length - 1; i >= 0; i--) {
      const k = barOf(list[i], win);
      if (k < 0) break;
      if (k < win.n) out[k]++;
    }
  return out;
}
/** Every transcript under a session: its main thread, its agents and its workflows' agents. */
export const tailsOf = (s: Session): Tail[] => [...s.mains, ...s.agents.map((a) => a.tail), ...s.workflows.flatMap((w) => w.agents.map((a) => a.tail))];
/** The window every sparkline in the lane shows at a terminal `W` cells wide: one bar per lane cell. */
export const laneWindow = (now: number, W: number): Win => timeWindow(now, opt.windowMin * 60_000, grid(W).laneW);
/** The same, for the window the person chose (opt.windowMin). */
export const buckets = (lists: number[][], now: number, n: number): number[] => bucketsIn(lists, timeWindow(now, opt.windowMin * 60_000, n));
export const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

/** Output tokens written inside `win`: the same edges as the sparkline it is printed beside. */
export function tokensIn(tailsIn: Tail[], win: Win): number {
  let n = 0;
  for (const t of tailsIn)
    for (const [ts, out] of t.tokens.values()) {
      const k = barOf(ts, win);
      if (k >= 0 && k < win.n) n += out;
    }
  return n;
}

/** How long one bar is, for the header: "10s", "90s", "1m", "6m". */
export function barLabel(win: Win): string {
  const sec = win.bar / 1000;
  if (sec % 60 === 0) return `${sec / 60}m`;
  if (sec < 100) return `${Math.round(sec)}s`;
  return `${(sec / 60).toFixed(1)}m`;
}

/** The 5-family models run a 1M window here; anything already past 200k must be on one. (Assumed, not read from the session.) */
export function ctxMax(c: NonNullable<Tail["ctx"]>): number {
  return c.req.includes("[1m]") || c.used > 200_000 || /(opus|sonnet|fable)-5/.test(c.model) ? 1_000_000 : 200_000;
}

// Colours follow Claude Code's /context rows as the context-bar plugin draws them
// (grey system rows, orange memory, lilac messages); the rest are picked to stay distinct.
export const PARTS: { key: PartKey | "messages"; name: string; short: string; color: RGB }[] = [
  { key: "system", name: "System prompt", short: "System", color: [120, 120, 120] },
  { key: "tools", name: "System tools", short: "Tools", color: [168, 168, 168] },
  { key: "mcp", name: "MCP tools", short: "MCP", color: [0, 204, 204] },
  { key: "agents", name: "Agents", short: "Agents", color: [78, 186, 101] },
  { key: "memory", name: "Memory files", short: "Memory", color: [215, 119, 87] },
  { key: "skills", name: "Skills", short: "Skills", color: [255, 193, 7] },
  { key: "messages", name: "Messages", short: "Messages", color: [177, 185, 249] },
];
const CHARS_PER_TOKEN = 3.8;
/** Split the window's fill by category. Everything but Messages is sized from text length, so it is approximate. `short` is the name the context key uses. */
export function contextSplit(t: Tail): { name: string; short: string; tokens: number; color: RGB }[] {
  if (!t.ctx) return [];
  if (!t.parts) return [{ name: "Used", short: "Used", tokens: t.ctx.used, color: PARTS[6].color }];
  let fixed = 0;
  const out = PARTS.filter((p) => p.key !== "messages").map((p) => {
    const tokens = Math.round((t.parts![p.key as PartKey] ?? 0) / CHARS_PER_TOKEN);
    fixed += tokens;
    return { name: p.name, short: p.short, tokens, color: p.color };
  });
  if (fixed > t.ctx.used) {
    const k = t.ctx.used / fixed;
    for (const o of out) o.tokens = Math.round(o.tokens * k);
    fixed = t.ctx.used;
  }
  out.push({ name: "Messages", short: "Messages", tokens: t.ctx.used - fixed, color: PARTS[6].color });
  return out;
}

// ───────────────────────── runway ─────────────────────────
//
// Two gauges become forecasts, and stay silent unless trouble is coming: when a session's context
// window will be full, and whether the account will hit a limit before the limit resets.

const RUNWAY_USES_MS = 10 * 60_000; // the forecast is a straight line through the last ten minutes
const RUNWAY_NEEDS_MS = 5 * 60_000; // …and needs at least five minutes of history
const RUNWAY_HORIZON_MIN = 60; // nothing is said unless the window would be full within the hour

/**
 * Minutes until a context window of `max` tokens is full, or undefined when there is nothing to say.
 * `log` is the tail's context readings ([time, tokens used], oldest first). It answers only when the
 * window has grown steadily: at least five minutes of history in the last ten, no drop in it (a
 * compaction starts the history again), growth in both its older and its newer half, and a straight
 * line through it that reaches `max` within the hour.
 */
export function ctxRunway(log: [number, number][], max: number, now: number): number | undefined {
  let pts = log.filter(([t]) => t >= now - RUNWAY_USES_MS && t <= now);
  for (let i = pts.length - 1; i > 0; i--)
    if (pts[i][1] < pts[i - 1][1] - Math.max(5_000, max * 0.02)) {
      pts = pts.slice(i);
      break;
    }
  if (pts.length < 3) return undefined;
  const [t0, first] = pts[0];
  const last = pts[pts.length - 1][1];
  if (now - t0 < RUNWAY_NEEDS_MS) return undefined;
  if (last >= max) return 0;
  const mid = t0 + (now - t0) / 2;
  const atMid = pts.filter(([t]) => t <= mid).pop()![1];
  if (atMid <= first || last <= atMid) return undefined; // one jump, or growth that has stopped, is not a trend
  const perMin = (last - first) / ((now - t0) / 60_000);
  const minutes = (max - last) / perMin;
  return minutes <= RUNWAY_HORIZON_MIN ? minutes : undefined;
}
/** The forecast for a session's main thread, from the readings its transcript holds. */
export const sessionRunway = (main: Tail | undefined, now: number): number | undefined => (main?.ctx ? ctxRunway(main.ctxLog, ctxMax(main.ctx), now) : undefined);

/** A forecast's length as the screen prints it: about so long, to the nearest five minutes once past ten. */
export function roughly(minutes: number): string {
  if (minutes < 10) return `${Math.max(1, Math.round(minutes))}m`;
  const m = Math.round(minutes / 5) * 5;
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
  return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`;
}
/** "full in ~40m": bold white on a session's key row and red under 15 minutes; bold red in the account block. */
export const fullInText = (minutes: number): string => `full in ~${roughly(minutes)}`;
export const runwayTone = (minutes: number): RGB => (minutes < 15 ? C.red : C.white);

/** Where the pace tick sits on a limit's gauge: the share of the limit's window that has passed (0 to 1), from its reset time and its length. */
export function paceTick(resetsAt: number, windowMs: number, now: number): number | undefined {
  if (!resetsAt || !(windowMs > 0) || now >= resetsAt) return undefined; // no reset time, or figures from a window that has already rolled over
  return Math.max(0, Math.min(1, (now - (resetsAt - windowMs)) / windowMs));
}
/** The gauge cell a pace tick lands on, and its glyph: ┿ inside the filled part, ┼ on the empty track. */
export function paceCell(tick: number, pct: number, w: number): { cell: number; glyph: string } {
  const filled = Math.max(pct > 0 ? 1 : 0, Math.min(w, Math.round((pct / 100) * w)));
  const cell = Math.min(w - 1, Math.floor(tick * w));
  return { cell, glyph: cell < filled ? ICON.paceFilled : ICON.pace };
}
/**
 * Milliseconds until a limit reaches 100% at the pace it has kept so far, but only when that comes
 * before the reset. Says nothing in the first 15% of a window or under 5% used, where the pace means
 * little, nor once the limit is full: then there is nothing left to forecast, and the reset time is what matters.
 */
export function paceForecast(pct: number, resetsAt: number, windowMs: number, now: number): number | undefined {
  const tick = paceTick(resetsAt, windowMs, now);
  if (tick === undefined || tick < 0.15 || pct < 5 || pct >= 100) return undefined;
  const toFull = ((100 - pct) / pct) * tick * windowMs;
  return now + toFull < resetsAt ? toFull : undefined;
}

export const clean = (s: string) => s.replace(/[*`#>]+/g, "").replace(/\s+/g, " ").trim();

export interface Facts {
  main?: Tail;
  needs: string; // non-empty when the session is waiting on the person
  yourTurn: boolean; // finished its turn and is idle
  finished: boolean; // a background job that says it is done
  working: boolean; // busy, or a background job that says it is working
  now: string; // one-line summary of what it is doing: the now-line
}
export function factsOf(s: Session): Facts {
  const main = [...s.mains].sort((x, y) => y.mtime - x.mtime)[0];
  const pendingAsk = !!main?.lastTool && main.lastTool.name === "AskUserQuestion" && main.lastTool.t > main.lastResultT;
  const needs = pendingAsk
    ? main!.lastTool!.hint || "has a question for you"
    : s.job?.state === "blocked"
      ? s.job.needs || s.job.detail || "waiting on you"
      : "";
  const idle = s.status !== "busy";
  // A background job says so itself; otherwise: idle, and Claude spoke last.
  const yourTurn = !needs && (s.job ? s.job.state === "done" : idle && !!main?.say && (!main.ask || main.say.t >= main.ask.t));
  // The now-line is the job's own detail, or the away summary when that is newer than the last prompt.
  const summary = main?.summary && (main.summaryT ?? 0) >= (main.ask?.t ?? 0) ? main.summary : "";
  return { main, needs: clean(needs), yourTurn, finished: s.job?.state === "done", working: s.status === "busy" || s.job?.state === "working", now: clean(s.job?.detail || summary) };
}

/**
 * The one state a session is in. `stalled` is the stall watch's verdict (stallOf), which only matters
 * while the session is working. Sort order on screen: needs, stalled, working, then the quiet ones.
 */
export function sessionState(f: Facts, stalled = false): SessionState {
  if (f.needs) return "needs";
  if (f.finished) return "finished";
  if (f.working) return stalled ? "stalled" : "working";
  return f.yourTurn ? "yourTurn" : "idle";
}
/** Sort key: needs you first, then stalled, then working; within a state the newest session first. */
export const byState = (a: { state: SessionState; s: Session }, b: { state: SessionState; s: Session }) =>
  STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || b.s.startedAt - a.s.startedAt;

/** When the session's state began: how long it has waited, been stalled, been up, or since Claude last spoke. */
export function stateSince(s: Session, f: Facts, state: SessionState, stalledSince = 0): number {
  const m = f.main;
  const lastWrite = Math.max(m?.lastT ?? 0, m?.mtime ?? 0);
  if (state === "needs") return m?.lastTool && m.lastTool.name === "AskUserQuestion" && m.lastTool.t > m.lastResultT ? m.lastTool.t : lastWrite;
  if (state === "stalled") return stalledSince || lastWrite;
  if (state === "working") return s.startedAt;
  if (state === "yourTurn") return m?.say?.t ?? lastWrite;
  return lastWrite;
}
/** The time printed after the state word: "up 1h04" while working, otherwise how long ago the state began. Empty when unknown. */
export function stateTime(s: Session, f: Facts, state: SessionState, now: number, stalledSince = 0): string {
  const since = stateSince(s, f, state, stalledSince);
  if (!since) return "";
  return state === "working" ? `up ${ago(now - since)}` : ago(now - since);
}

/** The first line of a reply as plain text: markdown marks dropped, fences and blank lines skipped. */
export function firstLine(text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("```") || /^[|:\- ]+$/.test(line)) continue;
    const flat = clean(line.replace(/^[-*+]\s+/, ""));
    if (flat) return flat;
  }
  return "";
}

export interface Subheading {
  source: "question" | "now" | "task" | "prompt" | "reply" | "none";
  text: string; // one safe line, not yet cut to width
  t?: number; // when it was said, where that is known: a prompt's or a reply's age
}
/**
 * What a session's second row says. Needs you: the question. Working (or stalled): the now-line, else
 * the current task, else your last prompt (drawn with ▸ and its age, and then not repeated below), else
 * the first line of Claude's newest reply (drawn with ◆). Your turn, idle, finished: the reply, else the now-line.
 */
export function subheading(s: Session, f: Facts, state: SessionState): Subheading {
  const m = f.main;
  const said = m?.say ? firstLine(m.say.text) : "";
  const reply = (): Subheading | undefined => (said ? { source: "reply", text: said, t: m!.say!.t } : undefined);
  const nowLine = (): Subheading | undefined => (f.now ? { source: "now", text: f.now } : undefined);
  if (state === "needs") return { source: "question", text: f.needs };
  if (state === "working" || state === "stalled") {
    const typed = clean(m?.ask?.text || m?.lastPrompt || "");
    return (
      nowLine() ??
      (s.tasks?.active ? { source: "task", text: s.tasks.active } : undefined) ??
      (typed ? { source: "prompt", text: typed, t: m?.ask?.t } : undefined) ??
      reply() ?? { source: "none", text: "" }
    );
  }
  return reply() ?? nowLine() ?? { source: "none", text: "" };
}

// ───────────────────────── stall watch ─────────────────────────
//
// The third state worth knowing about: not working, not asking, just stuck. The evidence is
// circumstantial (a tool may be waiting on another machine), so the screen words it as a question.

/**
 * A thread (the main thread or an agent) is stalled when it has had a tool call outstanding and has
 * written nothing for `stallMs`, while the session's whole process tree is under 1% CPU. `treeCpu` is
 * undefined when the session's process was not in the last sample; then nothing is claimed.
 */
export function threadStalled(th: { pending: boolean; lastWrite: number }, treeCpu: number | undefined, now: number, stallMs: number): boolean {
  return stallMs > 0 && th.pending && treeCpu !== undefined && treeCpu < 1 && th.lastWrite > 0 && now - th.lastWrite >= stallMs;
}
/** A busy session is stalled when no thread at all has written for `stallMs` at under 1% CPU. */
export function sessionStalled(busy: boolean, lastWrite: number, treeCpu: number | undefined, now: number, stallMs: number): boolean {
  return stallMs > 0 && busy && treeCpu !== undefined && treeCpu < 1 && lastWrite > 0 && now - lastWrite >= stallMs;
}

export interface Stall {
  session: boolean; // the whole session has gone quiet
  threads: string[]; // the stalled threads: "main", or an agent's id
  count: number; // how many things are stalled here: the threads, or 1 when only the session as a whole is
  since: number; // when the longest-stalled of them last wrote, for "14m"; 0 when nothing is stalled
}
const NO_STALL: Stall = { session: false, threads: [], count: 0, since: 0 };
const treeCpuOf = (pid: number): number | undefined => {
  const u = treeUsage(pid);
  return u.known ? u.cpu : undefined;
};
const lastWriteOf = (t: Tail) => Math.max(t.lastT, t.mtime);
const pendingTool = (t: Tail) => !!t.lastTool && t.lastTool.t > t.lastResultT;
/**
 * The stall watch's verdict on one session. Only a working session can be stalled: one that needs you
 * or has finished its turn is waiting on you, not stuck. The main thread waits on its agents, so it
 * counts as stalled only when they have all gone quiet too.
 */
export function stallOf(s: Session, f: Facts, now: number, treeCpu: number | undefined = treeCpuOf(s.pid), stallMs = opt.stallMin * 60_000): Stall {
  if (stallMs <= 0 || f.needs || !f.working) return NO_STALL;
  const agents = [...s.agents, ...s.workflows.filter((w) => w.status === "running").flatMap((w) => w.agents)];
  const lastWrite = Math.max(0, ...tailsOf(s).map(lastWriteOf));
  const session = sessionStalled(true, lastWrite, treeCpu, now, stallMs);
  const threads: string[] = [];
  let since = session ? lastWrite : Infinity;
  if (session && f.main && pendingTool(f.main)) threads.push("main");
  for (const a of agents) {
    if (a.done || !threadStalled({ pending: pendingTool(a.tail), lastWrite: lastWriteOf(a.tail) }, treeCpu, now, stallMs)) continue;
    threads.push(a.id);
    since = Math.min(since, lastWriteOf(a.tail));
  }
  if (!session && !threads.length) return NO_STALL;
  return { session, threads, count: threads.length || 1, since };
}
/** One name per stalled thing, so the bell rings once for each: "sid" for a session, "sid/thread" for a thread. */
export const stallKeys = (sid: string, st: Stall): string[] => (st.threads.length ? st.threads.map((id) => `${sid}/${id}`) : st.session ? [sid] : []);
/**
 * The same names, each with when that thing last wrote. A stall is known by its silence: while the thing
 * has not written again it is the same stall, however often the CPU test flickers either side of 1%.
 */
export function stallMarks(s: Session, f: Facts, st: Stall): [key: string, wrote: number][] {
  const wrote = (id: string): number => {
    const t = id === "main" ? f.main : [...s.agents, ...s.workflows.flatMap((w) => w.agents)].find((a) => a.id === id)?.tail;
    return t ? lastWriteOf(t) : st.since;
  };
  return st.threads.length ? st.threads.map((id) => [`${s.sid}/${id}`, wrote(id)]) : st.session ? [[s.sid, st.since]] : [];
}
/** The stalls in `marks` not yet announced for the silence they are in; `known` remembers each. Used to ring the bell once per stall. */
export function newStalls(known: Map<string, number>, marks: [string, number][]): string[] {
  const fresh = marks.filter(([k, wrote]) => known.get(k) !== wrote).map(([k]) => k);
  for (const [k, wrote] of marks) known.set(k, wrote);
  return fresh;
}
/** The members of `current` that were not in `known`; `known` is then brought up to date. Used to ring the bell once per new thing. */
export function newSince(known: Set<string>, current: string[]): string[] {
  const fresh = current.filter((k) => !known.has(k));
  known.clear();
  for (const k of current) known.add(k);
  return fresh;
}

// ───────────────────────── since you looked ─────────────────────────
//
// Unread marks for a screen you walk away from. The mark starts at launch and is moved by the space
// key ("seen it"). What has happened since is a list built by comparing each scan with the one before.

export type EventKind = "asked" | "failed" | "stalled" | "sessionDone" | "workflowDone" | "agentDone" | "reply";
export interface FleetEvent {
  kind: EventKind;
  t: number; // when it happened, or when it was noticed if it was written before the mark
  sid: string;
  key: string; // what it happened to
}
export const seen = {
  at: 0, // the mark: launch, then the last press of space
  events: [] as FleetEvent[], // everything new since the mark, oldest first
  known: new Map<string, string>(), // what each thing looked like at the last scan
  primed: false, // false until the first scan has set the baseline
};
/** "Seen it": move the mark to now and forget what came before it. */
export function markSeen(now: number) {
  seen.at = now;
  seen.events = [];
}
/** Is this timestamp new since you last looked? Replies newer than the mark get a bold ◆ and the word "new" for an age. */
export const isNew = (t: number): boolean => t > seen.at;
/** How many new things in total, for the button: "space Seen · 4 new". */
export const newCount = (): number => seen.events.length;
/** The lane cell the mark falls in, for the ▼ on the time axis; undefined when it is outside the window. */
export function seenCell(win: Win): number | undefined {
  const k = barOf(seen.at, win);
  return k >= 0 && k < win.n ? k : undefined;
}

/** Whether a background job's own state word means it failed. */
const jobFailed = (state: string) => /fail|error|crash/i.test(state);
/**
 * Compare this scan with the last and add what changed to the event list: a session started needing
 * you, a session or workflow finished or failed, something stalled, an agent finished, Claude replied.
 * The first scan only sets the baseline. `jobState` reads a background job's state after its session
 * has gone, so a job that finishes and exits between two scans is not missed.
 */
export function noteScan(sessions: Session[], now: number, jobState: (jobId: string) => string | undefined = (id) => readJson(path.join(claudeHome(), "jobs", id, "state.json"))?.state) {
  const next = new Map<string, string>();
  const made = new Map<string, number>(); // how many times this scan has come up with the same event
  const push = (kind: EventKind, sid: string, key: string, t: number) => {
    if (t <= seen.at) return;
    const nth = (made.get(`${kind}|${key}|${t}`) ?? 0) + 1;
    made.set(`${kind}|${key}|${t}`, nth);
    // Listed already by an earlier scan: a session missing from one scan (its registry file caught half-written) comes back looking new.
    if (seen.events.filter((e) => e.kind === kind && e.key === key && e.t === t).length >= nth) return;
    seen.events.push({ kind, t, sid, key });
  };
  /** Record what `key` looks like now; when that is a change into `kind`, it is an event. */
  const track = (key: string, value: string, sid: string, kind: EventKind | undefined, t: number) => {
    next.set(key, value);
    const before = seen.known.get(key);
    if (before === value || !kind) return;
    // A change we watched happen is news even when its own timestamp is a moment older than the mark:
    // it is then dated now. Something first seen already in this state is news only if it happened after the mark.
    const watched = seen.primed && before !== undefined;
    push(kind, sid, key, watched && t <= seen.at ? now : t);
  };
  for (const s of sessions) {
    const f = factsOf(s);
    const asked = f.needs ? stateSince(s, f, "needs") : 0;
    track(`ask:${s.sid}`, f.needs ? String(asked) : "-", s.sid, f.needs ? "asked" : undefined, asked);
    if (s.job) {
      const word = f.finished ? "done" : jobFailed(s.job.state) ? "failed" : "open";
      track(`job:${s.sid}`, `${word}|${s.jobId ?? ""}`, s.sid, word === "done" ? "sessionDone" : word === "failed" ? "failed" : undefined, f.main ? lastWriteOf(f.main) : 0);
    }
    for (const wf of s.workflows) track(`wf:${s.sid}/${wf.id}`, wf.status, s.sid, wf.status === "running" ? undefined : wf.status === "completed" ? "workflowDone" : "failed", wf.finished || wf.lastT);
    for (const [k, wrote] of stallMarks(s, f, stallOf(s, f, now))) {
      // A stall is known by when the thing last wrote, so the same silence seen again is not news again.
      next.set(`stall:${k}`, String(wrote));
      if (seen.known.get(`stall:${k}`) === String(wrote)) continue;
      const t = Math.min(now, wrote + opt.stallMin * 60_000); // when it crossed the line
      push("stalled", s.sid, `stall:${k}`, seen.primed && t <= seen.at ? now : t); // watched happening: see track()
    }
    for (const a of [...s.agents, ...s.workflows.flatMap((w) => w.agents)]) track(`agent:${s.sid}/${a.id}`, a.done ? "done" : "running", s.sid, a.done ? "agentDone" : undefined, lastWriteOf(a.tail));
    for (const m of s.mains) {
      const key = `say:${m.path}`;
      const noted = Number(seen.known.get(key) ?? 0);
      for (const t of m.sayTs) if (t > noted) push("reply", s.sid, key, t); // a reply's own time, so the count matches the replies marked "new"
      next.set(key, String(Math.max(noted, ...m.sayTs)));
    }
  }
  // A background job whose session has gone since the last scan: ask its state file how it ended.
  for (const [key, value] of seen.known) {
    if (!key.startsWith("job:") || next.has(key)) continue;
    const [word, jobId] = value.split("|");
    if (word !== "open" || !/^[\w-]+$/.test(jobId)) continue;
    const state = String(jobState(jobId) ?? "");
    if (state === "done") push("sessionDone", key.slice(4), key, now);
    else if (jobFailed(state)) push("failed", key.slice(4), key, now);
  }
  // A stall that has cleared is remembered for a day, in case it comes back before the thing has written again.
  for (const [key, value] of seen.known) if (key.startsWith("stall:") && !next.has(key) && Number(value) > now - 24 * 3600_000) next.set(key, value);
  seen.known = next;
  seen.primed = true;
}

export interface DigestGroup {
  kind: "asked" | "failed" | "stalled" | "finished" | "replies";
  glyph: string;
  color: RGB;
  count: number;
  text: string; // "1 asked", "3 agents done", "4 new replies"
}
/**
 * What has happened since the mark, as ordered groups for the header rule: asked, failed, stalled,
 * finished (sessions, workflows, agents), new replies. Empty when nothing is new. `since` is the mark.
 */
export function digest(events: FleetEvent[] = seen.events, since = seen.at): { since: number; groups: DigestGroup[] } {
  const n = (kind: EventKind) => events.filter((e) => e.kind === kind).length;
  const some = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const groups: DigestGroup[] = [
    { kind: "asked", glyph: ICON.needs, color: C.amber, count: n("asked"), text: `${n("asked")} asked` },
    { kind: "failed", glyph: ICON.failed, color: C.red, count: n("failed"), text: `${n("failed")} failed` },
    { kind: "stalled", glyph: ICON.progress, color: C.red, count: n("stalled"), text: `${n("stalled")} stalled` },
    { kind: "finished", glyph: ICON.done, color: C.green, count: n("sessionDone"), text: some(n("sessionDone"), "session done", "sessions done") },
    { kind: "finished", glyph: ICON.done, color: C.green, count: n("workflowDone"), text: some(n("workflowDone"), "workflow done", "workflows done") },
    { kind: "finished", glyph: ICON.done, color: C.green, count: n("agentDone"), text: some(n("agentDone"), "agent done", "agents done") },
    { kind: "replies", glyph: ICON.claude, color: C.cyan, count: n("reply"), text: some(n("reply"), "new reply", "new replies") },
  ];
  return { since, groups: groups.filter((g) => g.count > 0) };
}

/** Sessions nobody needs to look at: finished background jobs, and idle sessions with nothing running under them. */
export function isQuiet(s: Session, f: Facts, since: number): boolean {
  if (f.needs) return false;
  if (s.job) return s.job.state === "done";
  if (s.status === "busy") return false;
  const shown = s.workflows.filter((wf) => (wf.status === "running" ? wf.lastT : Math.max(wf.finished, wf.lastT)) >= since);
  return !shown.some((wf) => wf.status === "running") && ![...s.agents, ...shown.flatMap((wf) => wf.agents)].some((a) => !a.done && lastWriteOf(a.tail) >= since);
}

/** The masthead's counts. Every session is in exactly one of needs, stalled, working or idle. */
export interface FleetCounts {
  sessions: number;
  needs: number; // waiting on you
  stalled: number; // working, but something in them is stuck
  working: number; // on screen and not waiting on you
  idle: number; // the idle and finished sessions kept off the screen (shown with a)
  agents: number; // agents running in the window
  workflows: number; // workflows running in the window
}
export function fleetCounts(sessions: Session[], now: number, since = now - opt.windowMin * 60_000): FleetCounts {
  const c: FleetCounts = { sessions: sessions.length, needs: 0, stalled: 0, working: 0, idle: 0, agents: 0, workflows: 0 };
  for (const s of sessions) {
    const f = factsOf(s);
    const state = sessionState(f, stallOf(s, f, now).count > 0);
    if (state === "needs") c.needs++;
    else if (isQuiet(s, f, since)) c.idle++;
    else if (state === "stalled") c.stalled++;
    else c.working++;
    c.agents += [...s.agents, ...s.workflows.flatMap((w) => w.agents)].filter((a) => !a.done && lastWriteOf(a.tail) >= since).length;
    c.workflows += s.workflows.filter((w) => w.status === "running" && w.lastT >= since).length;
  }
  return c;
}

/** The terminal title: the fleet's state in the screen's own glyphs, so a tab or window switcher shows whether anything needs you. */
export function titleFor(c: Pick<FleetCounts, "needs" | "stalled" | "working" | "workflows">): string {
  const parts = [c.needs ? `${ICON.needs}${c.needs}` : "", c.stalled ? `${ICON.progress}${c.stalled}` : "", c.working ? `${ICON.working}${c.working}` : "", c.workflows ? `${ICON.workflow}${c.workflows}` : ""];
  return [...parts.filter(Boolean), "Claude Fleet"].join(" ");
}
/** The escape sequence (OSC 2) that sets the terminal title; an empty title clears it. */
export const titleSequence = (title: string): string => `\x1b]2;${title}\x07`;
let titleShown: string | undefined;
/** What to write to move the title from what it shows now to `title`: nothing when it has not changed. */
export function titleChange(title: string): string {
  if (title === titleShown) return "";
  titleShown = title;
  return titleSequence(title);
}

export type AgentState = "active" | "tool" | "quiet" | "done";
export function stateOf(a: Agent, now: number): AgentState {
  if (a.done) return "done";
  if (now - Math.max(a.tail.lastT, a.tail.mtime) < ACTIVE_MS) return "active";
  if (a.tail.lastTool && a.tail.lastTool.t > a.tail.lastResultT) return "tool";
  return "quiet";
}

export interface Group {
  wf?: Workflow;
  rows: Agent[];
  hidden: number;
}
export interface View {
  s: Session;
  groups: Group[]; // workflows first, then one group of standalone agents
  doneCount: number;
  showTasks: boolean;
  showMain: boolean;
  showNeeds: boolean;
  showCtx: boolean;
  showNow: boolean;
  showTalk: number; // 0, 1 (Claude's last message) or 2 (plus the last prompt)
  msgs: { lines: string[]; t: number }[]; // Claude's last few messages, newest first, wrapped
  alloc: number[]; // lines shown of each
  facts: Facts;
  state: SessionState;
  stall: Stall; // the stall watch's verdict: stall.count things are stalled in this session
  quiet: boolean; // nobody needs to look at it: kept off the screen unless --all
  lastT: number;
}

export function buildViews(sessions: Session[], now: number, sayWidth: number, since = now - opt.windowMin * 60_000): View[] {
  const recent = (a: Agent) => Math.max(a.tail.lastT, a.tail.mtime) >= since;
  const order: Record<AgentState, number> = { active: 0, tool: 1, quiet: 2, done: 3 };
  const pick = (list: Agent[], stuck: string[]) =>
    list
      .filter((a) => (recent(a) || stuck.includes(a.id)) && (opt.showDone || !a.done)) // a stalled agent has been silent longer than a short window, and is the one to look at
      .sort((a, b) => Number(stuck.includes(b.id)) - Number(stuck.includes(a.id)) || order[stateOf(a, now)] - order[stateOf(b, now)] || a.tail.birth - b.tail.birth);

  return sessions
    .map((s) => {
      const facts = factsOf(s);
      const stall = stallOf(s, facts, now);
      const groups: Group[] = [];
      for (const wf of s.workflows) {
        const live = wf.status === "running" && (wf.lastT >= since || wf.agents.some((a) => stall.threads.includes(a.id)));
        const justFinished = wf.status !== "running" && Math.max(wf.finished, wf.lastT) >= since;
        if (live || justFinished) groups.push({ wf, rows: pick(wf.agents, stall.threads), hidden: 0 }); // a stalled agent is the last to be folded away
      }
      groups.sort((a, b) => a.wf!.started - b.wf!.started);
      const solo = pick(s.agents, stall.threads);
      if (solo.length) groups.push({ rows: solo, hidden: 0 });
      const doneCount = opt.showDone ? 0 : s.agents.filter((a) => a.done && recent(a)).length;
      const lastT = Math.max(0, ...s.mains.map((m) => m.mtime), ...s.agents.map((a) => a.tail.mtime));
      const m = facts.main;
      return {
        s,
        groups,
        doneCount,
        showTasks: !!s.tasks && s.tasks.total > 0,
        showMain: s.status === "busy" && s.mains.length > 0,
        showNeeds: !!facts.needs,
        showCtx: !!m?.ctx,
        showNow: !!facts.now && facts.now !== facts.needs,
        msgs: m ? [...m.says].reverse().map((x) => ({ lines: messageLines(x.text, sayWidth), t: x.t })).filter((x) => x.lines.length) : [],
        alloc: m?.say ? [1] : [],
        showTalk: (m?.say ? 1 : 0) + (m?.ask || m?.lastPrompt ? 1 : 0),
        facts,
        state: sessionState(facts, stall.count > 0),
        stall,
        quiet: isQuiet(s, facts, since),
        lastT,
      };
    })
    .sort(byState);
}

/** Kept off the screen unless --all: see isQuiet(). */
export const isHidden = (v: View): boolean => v.quiet;

// ───────────────────────── the detail view ─────────────────────────
//
// Detail mode's sessions. Each is a small card (a title row and a subheading row, as far mode draws
// them) and, under it, what was said, the tasks and every thread at work. There are no tree lines and
// no word labels: a thick rail marks the head rows and a thin one the body, an icon names each speaker,
// and every sparkline sits in the one lane. When the screen is short the blocks give rows up in a fixed
// order (the ladder, below) rather than losing whatever happens to be at the bottom.

/** One piece of a drawn row: text, colour, bold. The shape Row.segs() takes. */
export type Seg = [text: string, color?: RGB, bold?: boolean];
const segsWidth = (segs: Seg[]) => segs.reduce((n, s) => n + width(s[0]), 0);
const segsText = (segs: Seg[]) => segs.map((s) => s[0]).join("");
/** Plain text cut to at most `w` cells, ending in … when something was lost. Not padded; its spacing is kept. */
export const cutTo = (s: string, w: number): string => (w <= 0 ? "" : width(s) <= w ? s : fit(s, w, "l", true).trimEnd());
/** Plain text shortened to at most `w` cells at a word boundary, with no ellipsis of its own. */
export function clipWords(s: string, w: number): string {
  if (width(s) <= w) return s;
  const chars = [...s];
  let n = 0;
  let k = 0;
  while (k < chars.length && n + charWidth(chars[k].codePointAt(0)!) <= w) n += charWidth(chars[k++].codePointAt(0)!);
  const space = chars[k] === " " ? k : chars.lastIndexOf(" ", k - 1);
  return chars.slice(0, space > 0 ? space : k).join("").trimEnd();
}
/** The first `n` characters of styled pieces, styles kept. */
function takeSegs(segs: Seg[], n: number): Seg[] {
  const out: Seg[] = [];
  for (const [text, color, isBold] of segs) {
    if (n <= 0) break;
    out.push([text.slice(0, n), color, isBold]);
    n -= text.length;
  }
  return out;
}
/** Styled pieces cut to at most `w` cells, ending in a dim … when something was lost. */
const fitSegs = (segs: Seg[], w: number): Seg[] => (w <= 0 ? [] : segsWidth(segs) <= w ? segs : [...takeSegs(segs, cutTo(segsText(segs), w).length - 1), [ICON.cut, C.dim]]);

// ── a reply, formatted ──

/** The colours a reply is drawn in: the newest one bright, an earlier one (seen in full only in focus) receded. */
interface ReplyTone {
  text: RGB;
  strong: RGB;
  code: RGB;
  bullet: RGB;
}
const BRIGHT: ReplyTone = { text: C.text, strong: C.white, code: C.code, bullet: C.cyan };
const RECEDED: ReplyTone = { text: C.dim, strong: C.dim, code: C.dim, bullet: C.dim };
const wordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);
const SPAN_MAX = 600; // how far ahead a mark's partner is looked for: emphasis and link text are short, and a reply full of stray marks must not be slow to read

/** A bare address cut down to host/…/last part. */
export function shortUrl(url: string): string {
  const [host, ...parts] = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[?#].*$/, "").split("/").filter(Boolean);
  if (!host) return url;
  return parts.length === 0 ? host : parts.length === 1 ? `${host}/${parts[0]}` : `${host}/…/${parts[parts.length - 1]}`;
}

/**
 * One line of markdown as styled pieces with the marks gone: **bold** in bold white, `code` in code
 * colour, a link as its text, a bare address shortened, italic and strike marks dropped. It is a small
 * tokeniser rather than a set of replacements, so a mark only counts when it has a partner and sits
 * where emphasis can (snake_case, 5*3 and *.ts are left alone). Anything it is unsure of stays as typed.
 */
export function inlineSegs(src: string, tone: ReplyTone = BRIGHT): Seg[] {
  const out: Seg[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push([plain, tone.text]);
    plain = "";
  };
  /** Where the mark that closes the one at `i` starts, or -1 when the one at `i` does not open anything. */
  const closeOf = (mark: string, i: number): number => {
    const ch = mark[0];
    const single = mark.length === 1;
    const after = src[i + mark.length];
    if (!after || after === " " || after === ch) return -1;
    if ((ch === "_" || single) && wordChar(src[i - 1])) return -1; // inside a word: snake_case, 5*3
    if (single && !/[\p{L}\p{N}`\["'(]/u.test(after)) return -1; // "*.ts" is a pattern, not emphasis
    for (let j = src.indexOf(mark, i + mark.length + 1); j >= 0 && j - i <= SPAN_MAX; j = src.indexOf(mark, j + 1)) {
      const before = src[j - 1];
      const next = src[j + mark.length];
      if (before === " " || before === "\\") continue;
      if (single && (before === ch || next === ch)) continue; // half of a ** or __
      if ((ch === "_" || single) && wordChar(next)) continue;
      if (single && !/[\p{L}\p{N}`\]"').!?,;:%]/u.test(before)) continue;
      return j;
    }
    return -1;
  };
  for (let i = 0; i < src.length; ) {
    const ch = src[i];
    if (ch === "\\" && /[\\`*_{}\[\]()#+\-.!|>~]/.test(src[i + 1] ?? "")) {
      plain += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      let n = 1;
      while (src[i + n] === "`") n++;
      const end = src.indexOf("`".repeat(n), i + n);
      if (end > i) {
        flush();
        const code = src.slice(i + n, end).replace(/^ (.+) $/, "$1");
        if (code) out.push([code, tone.code]);
        i = end + n;
      } else {
        plain += src.slice(i, i + n);
        i += n;
      }
      continue;
    }
    if (ch === "*" || ch === "_" || ch === "~") {
      const mark = ["***", "**", "__", "~~", "*", "_"].find((m) => src.startsWith(m, i));
      const end = mark ? closeOf(mark, i) : -1;
      if (mark && end > 0) {
        flush();
        const strong = mark.length >= 2 && mark !== "~~";
        for (const [text, color, isBold] of inlineSegs(src.slice(i + mark.length, end), tone)) out.push(strong ? [text, color === tone.text ? tone.strong : color, true] : [text, color, isBold]);
        i = end + mark.length;
        continue;
      }
      if (mark && mark.length > 1) {
        plain += mark; // no partner: it stays as typed, and its second half is not read as a mark of its own
        i += mark.length;
        continue;
      }
    }
    if (ch === "[" || (ch === "!" && src[i + 1] === "[")) {
      const open = ch === "!" ? i + 1 : i;
      const near = src.slice(open, open + SPAN_MAX);
      const close = near.indexOf("](") < 0 ? -1 : open + near.indexOf("](");
      const end = close > 0 ? src.indexOf(")", close + 2) : -1;
      if (end > 0 && end - close <= 2100 && !src.slice(open + 1, close).includes("[")) {
        flush();
        const label = src.slice(open + 1, close);
        if (label.trim()) out.push(...inlineSegs(label, tone));
        else out.push([shortUrl(src.slice(close + 2, end).trim()), tone.text]);
        i = end + 1;
        continue;
      }
    }
    if ((src.startsWith("http", i) || src.startsWith("<http", i)) && !wordChar(src[i - 1])) {
      const m = /^<?(https?:\/\/[^\s<>`]+)/.exec(src.slice(i, i + 2100));
      if (m) {
        const url = m[1].replace(/[.,;:!?'")\]]+$/, "");
        plain += shortUrl(url);
        i += m[0].length - (m[1].length - url.length);
        if (ch === "<" && src[i] === ">") i++;
        continue;
      }
    }
    plain += ch;
    i++;
  }
  flush();
  return out;
}

/**
 * Word-wrap styled pieces to `w` cells. Wrapping happens after the marks are gone, so a mark never
 * counts towards the width and a bold or code span may run across a line break. Runs of white space
 * become one space; a word longer than the line is broken.
 */
export function wrapSegs(segs: Seg[], w: number): Seg[][] {
  w = Math.max(1, w);
  type Ch = { ch: string; w: number; color?: RGB; bold?: boolean };
  const chars: Ch[] = [];
  for (const [text, color, isBold] of segs)
    for (const ch of text) {
      if (!/\s/.test(ch)) chars.push({ ch, w: charWidth(ch.codePointAt(0)!), color, bold: isBold });
      else if (chars.length && chars[chars.length - 1].ch !== " ") chars.push({ ch: " ", w: 1, color, bold: isBold });
    }
  while (chars.length && chars[chars.length - 1].ch === " ") chars.pop();
  const lines: Ch[][] = [];
  let line: Ch[] = [];
  let used = 0;
  const close = () => {
    lines.push(line);
    line = [];
    used = 0;
  };
  for (let i = 0; i < chars.length; ) {
    let j = i;
    let wordW = 0;
    while (j < chars.length && chars[j].ch !== " ") wordW += chars[j++].w;
    if (line.length && used + 1 + wordW > w) close();
    if (line.length) {
      line.push(chars[i - 1]); // the space before this word
      used++;
    }
    for (let k = i; k < j; k++) {
      if (used + chars[k].w > w && line.length) close(); // only a word longer than the line gets here
      line.push(chars[k]);
      used += chars[k].w;
    }
    i = j + 1;
  }
  if (line.length) close();
  return lines.map((cs) => {
    const row: Seg[] = [];
    for (const c of cs) {
      const last = row[row.length - 1];
      if (last && last[1] === c.color && !!last[2] === !!c.bold) last[0] += c.ch;
      else row.push([c.ch, c.color, c.bold]);
    }
    return row;
  });
}

/** Rows that carry on the paragraph, bullet or quote the row above began. clipReply() uses it to find where a reply's last paragraph starts. */
const runsOn = new WeakSet<Seg[]>();
const wrapped = (rows: Seg[][]): Seg[][] => {
  for (const row of rows.slice(1)) runsOn.add(row);
  return rows;
};
const FENCE = /^(```|~~~)/;
const RULE = /^([-*_])(\s*\1){2,}$/;
const TABLE_RULE = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;
const NO_COMMENTS = /<!--[\s\S]*?(-->|$)/g;

/**
 * A reply as the rows the conversation draws, each a list of styled pieces starting at the text column
 * and at most `w` cells wide. Markdown is rendered, not stripped:
 * - a paragraph starts a new row; blank lines are kept only in focus (as one empty row);
 * - a bullet is a cyan • with its text two cells in and its wrapped lines under the text; a nested one is a
 *   dim – two cells further in (deeper levels the same); a numbered item keeps its number, in dim;
 * - a heading is one bold white line; a quote has a faint │ in front; rules and comments are dropped;
 * - a code fence loses its fences: each line gets a faint │, keeps its indentation and is cut, not
 *   wrapped; at most 3 lines (12 in focus), then "│ … +N lines";
 * - a table loses its rule row; the header is bold, cells are padded and split by a faint │, at most 2
 *   body rows (12 in focus) then "… +N rows"; one wider than `w` becomes "table · 5 columns x 12 rows".
 * If anything goes wrong the reply is drawn as plain wrapped text.
 */
export function replyRows(text: string, w: number, o: { focus?: boolean; receded?: boolean } = {}): Seg[][] {
  const tone = o.receded ? RECEDED : BRIGHT;
  try {
    return formatReply(text, Math.max(8, w), tone, !!o.focus);
  } catch {
    return wrap(clean(text), Math.max(8, w)).map((line): Seg[] => [[line, tone.text]]);
  }
}
function formatReply(text: string, w: number, tone: ReplyTone, focus: boolean): Seg[][] {
  const rows: Seg[][] = [];
  const codeMax = focus ? 12 : 3;
  const tableMax = focus ? 12 : 2;
  const gutter: Seg = [ICON.gutter + " ", C.faint];
  let blank = false; // a blank line has passed since the last row
  const add = (...more: Seg[][]) => {
    if (!more.length) return;
    if (blank && focus && rows.length) rows.push([]);
    blank = false;
    rows.push(...more);
  };
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const cellsOf = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => segsText(inlineSegs(c.trim(), tone)));
  const src = text.replace(NO_COMMENTS, "").split("\n");
  for (let i = 0; i < src.length; i++) {
    const raw = src[i];
    const line = raw.trim();
    const fence = FENCE.exec(line);
    if (fence) {
      const code: string[] = [];
      for (i++; i < src.length && !src[i].trim().startsWith(fence[1]); i++) code.push(src[i].replace(/\s+$/, ""));
      while (code.length && !code[0].trim()) code.shift();
      while (code.length && !code[code.length - 1].trim()) code.pop();
      const shown = code.slice(0, codeMax).map((c): Seg[] => [gutter, [cutTo(c, w - 2), tone.code]]);
      if (code.length > codeMax) shown.push([gutter, [`${ICON.cut} +${plural(code.length - codeMax, "line")}`, C.dim]]);
      add(...shown);
      continue;
    }
    if (!line) {
      blank = true;
      continue;
    }
    if (RULE.test(line)) continue;
    if (line.includes("|") && TABLE_RULE.test((src[i + 1] ?? "").trim()) && src[i + 1].includes("|")) {
      const head = cellsOf(line);
      const body: string[][] = [];
      for (i += 2; i < src.length && src[i].trim() && src[i].includes("|"); i++) body.push(cellsOf(src[i]));
      i--;
      const n = Math.max(head.length, ...body.map((r) => r.length));
      const widths = Array.from({ length: n }, (_, c) => Math.max(width(head[c] ?? ""), ...body.map((r) => width(r[c] ?? ""))));
      if (sum(widths) + 3 * (n - 1) > w) {
        add([[`table ${ICON.sep} ${plural(n, "column")} x ${plural(body.length, "row")}`, C.dim]]);
        continue;
      }
      const draw = (cells: string[], color: RGB, isBold: boolean): Seg[] =>
        widths.flatMap((cw, c): Seg[] => [...(c ? [[` ${ICON.gutter} `, C.faint] as Seg] : []), [c === n - 1 ? (cells[c] ?? "") : fit(cells[c] ?? "", cw, "l", true), color, isBold]]);
      add(draw(head, tone.strong, true), ...body.slice(0, tableMax).map((r) => draw(r, tone.text, false)));
      if (body.length > tableMax) add([[`${ICON.cut} +${plural(body.length - tableMax, "row")}`, C.dim]]);
      continue;
    }
    const heading = /^#{1,6}\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      add([[cutTo(segsText(inlineSegs(heading[1], tone)), w), tone.strong, true]]);
      continue;
    }
    const quote = /^>+\s?(.*)$/.exec(line);
    if (quote) {
      add(...wrapped(wrapSegs(inlineSegs(quote[1], tone), w - 2).map((l): Seg[] => [gutter, ...l])));
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    const numbered = bullet ? null : /^(\s*)(\d{1,3}[.)])\s+(.*)$/.exec(raw);
    if (bullet || numbered) {
      const inset = " ".repeat((bullet ?? numbered)![1].length >= 2 ? 2 : 0);
      let said = bullet ? bullet[2] : numbered![3];
      let lead: Seg = bullet ? (inset ? [`${inset}${ICON.nested} `, C.dim] : [`${ICON.bullet} `, tone.bullet]) : [`${inset}${numbered![2]} `, C.dim];
      const box = bullet ? /^\[([ xX])\]\s+(.*)$/.exec(said) : null; // a task-list item: its box becomes the glyph
      if (box) {
        said = box[2];
        lead = box[1] === " " ? [`${inset}${ICON.idle} `, C.dim] : [`${inset}${ICON.done} `, tone === BRIGHT ? C.done : C.dim];
      }
      const hang = width(lead[0]);
      add(...wrapped(wrapSegs(inlineSegs(said, tone), w - hang).map((l, k): Seg[] => [k ? [" ".repeat(hang)] : lead, ...l])));
      continue;
    }
    add(...wrapped(wrapSegs(inlineSegs(line, tone), w)));
  }
  return rows;
}
/** A reply is formatted once for each width it is drawn at, not once a second: what was made is remembered against the reply itself. */
const made = new WeakMap<object, { text: string; at: Map<string, unknown> }>();
function once<T>(say: { text: string }, key: string, make: () => T): T {
  let entry = made.get(say);
  if (!entry || entry.text !== say.text) made.set(say, (entry = { text: say.text, at: new Map() }));
  if (!entry.at.has(key)) entry.at.set(key, make());
  return entry.at.get(key) as T;
}

/** A reply as one plain line, for an earlier reply: marks, fences, rules and table rules gone, bullets kept as •. */
export function flatReply(text: string): string {
  const out: string[] = [];
  let code = false;
  for (const raw of text.replace(NO_COMMENTS, "").split("\n")) {
    const line = raw.trim();
    if (FENCE.test(line)) code = !code;
    else if (code) out.push(line);
    else if (line && !RULE.test(line) && !(line.includes("|") && TABLE_RULE.test(line)))
      out.push(segsText(inlineSegs((line.startsWith("|") ? line.replace(/^\|\s*|\s*\|$/g, "").replace(/\s*\|\s*/g, ` ${ICON.sep} `) : line).replace(/^#{1,6}\s+/, "").replace(/^>+\s?/, "").replace(/^[-*+]\s+/, ICON.bullet + " "))));
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * The rows of a reply that fit in `cap`, kept from the top. When rows are hidden, a dim "… +N lines" is
 * right-aligned at the end of the measure on the last row before the cut, and that row's text is
 * shortened at a word boundary to make room. With 3 rows or more the last row is always the reply's
 * final line, because that is its conclusion or its question; the mark then sits on the row above it.
 * A final paragraph that wraps is shown by its first row, ending in …, not by its last few words.
 */
export function clipReply(rows: Seg[][], cap: number, w: number): { segs: Seg[]; mark?: string }[] {
  if (cap <= 0) return [];
  if (rows.length <= cap) return rows.map((segs) => ({ segs }));
  const shorten = (segs: Seg[], room: number): Seg[] => (segsWidth(segs) <= room ? segs : takeSegs(segs, clipWords(segsText(segs), room).length));
  const hidden = rows.length - cap;
  let last = rows.length - 1; // where the final paragraph starts
  while (last > 0 && runsOn.has(rows[last])) last--;
  const closing = cap >= 3 && last >= cap - 1; // not when the final paragraph is already on show from its start
  const final: Seg[] = last === rows.length - 1 ? rows[last] : [...shorten(rows[last], w - 2), [` ${ICON.cut}`, C.dim]];
  const shown = closing ? [...rows.slice(0, cap - 1), final] : rows.slice(0, cap);
  const markAt = shown.length - (closing ? 2 : 1);
  const mark = `${ICON.cut} +${hidden} line${hidden === 1 ? "" : "s"}`;
  return shown.map((segs, i) => (i === markAt ? { segs: shorten(segs, w - width(mark) - 3), mark } : { segs }));
}

/** One glyph per step: ✓ done (green), ◐ under way (white), ○ not started (faint). Spaced out up to 10 steps, packed up to 20, scaled to 20 cells beyond that. */
export function stepStrip(done: number, doing: number, total: number): Seg[] {
  let n = Math.max(0, total);
  let d = Math.max(0, Math.min(done, n));
  let r = Math.max(0, Math.min(doing, n - d));
  if (n > 20) {
    d = Math.min(20, Math.round((d / n) * 20));
    r = r > 0 ? Math.min(20 - d, Math.max(1, Math.round((r / n) * 20))) : 0;
    n = 20;
  }
  const gap = total <= 10 ? " " : "";
  const glyphs: Seg[] = [];
  for (let i = 0; i < n; i++) glyphs.push(i < d ? [ICON.done, C.green] : i < d + r ? [ICON.progress, C.white] : [ICON.idle, C.faint]);
  return glyphs.map(([glyph, color], i): Seg => [glyph + (i < n - 1 ? gap : ""), color]);
}

// ── a session's block ──

/** What a block is still showing. The ladder turns these down one at a time; nothing else decides a block's height. */
export interface Keep {
  now: boolean; // the dim now-line under a question
  prompt: number; // lines of your prompt: 0, 1 or 2
  earlier: number[]; // lines of each earlier reply, oldest first; 0 removes it
  reply: number; // lines of the newest reply
  tasks: boolean;
  ctx: boolean; // the context row, where it has a row to itself
  main: boolean; // the main-thread row
  done: boolean; // the "n agents finished" line
  agents: number; // how many agents an agent group shows before "… n more agents"
  fold: boolean; // agents are folded into their workflow's row, or into one line
  roster: boolean; // workflow rows and the folded agents line
  question: number; // rows of the question
}
/** One session as the detail view draws it: what there is to show, and how much of it is still shown. */
export interface Block {
  v: View;
  body: boolean; // false: the two head rows only (an idle, finished or your-turn session shown with a)
  focus: boolean; // it has the screen to itself: every stored reply in full
  sub: Subheading;
  question: string[]; // the question, wrapped, when it needs you
  nowLine: string; // the now-line, when it says something the question does not
  prompt?: { text: string; lines: string[]; t?: number }; // your prompt, unless it is the subheading
  earlier: { flat: string[]; rich?: Seg[][]; t: number }[]; // earlier replies, oldest first
  newest?: { rows: Seg[][]; t: number };
  groups: { wf?: Workflow; rows: Agent[] }[];
  buckets: number[]; // its tool calls, all threads, one count per lane cell
  keep: Keep;
  folded: boolean; // gone into the "… n more" line
}
const AGENT_ORDER: Record<AgentState, number> = { active: 0, tool: 1, quiet: 2, done: 3 };
const EARLIER_TONE = mix(C.cyan, C.faint, 0.5);

export function blockOf(v: View, g: Grid, now: number, win: Win, focus = false): Block {
  const { s, facts: f, state } = v;
  const m = f.main;
  const body = focus || !v.quiet;
  const subW = g.textEnd - g.icon + 1;
  const typed = clean(m?.ask?.text || m?.lastPrompt || "");
  const typedAt = m?.ask?.text ? m.ask.t : undefined;
  let sub = subheading(s, f, state);
  if (sub.source === "none" && typed) sub = { source: "prompt", text: typed, t: typedAt }; // a quiet session with no reply and no now-line: better its last prompt than an empty row
  const question = state === "needs" ? wrap(f.needs, subW) : [];
  if (question.length > 3) question.splice(2, question.length, cutTo(question.slice(2).join(" "), subW));
  const nowLine = state === "needs" && f.now && f.now !== f.needs ? f.now : "";
  const prompt = body && typed && sub.source !== "prompt" ? { text: typed, lines: wrap(typed, g.measure), t: typedAt } : undefined;
  const says = body && m ? m.says : [];
  const last = says[says.length - 1];
  const formatted = (say: { text: string }, receded: boolean) => once(say, `rows ${g.measure} ${focus} ${receded} ${opt.plainGlyphs}`, () => replyRows(say.text, g.measure, { focus, receded }));
  const lastRows = last ? formatted(last, false) : [];
  // A one-line reply that is already the subheading, whole, is not said twice.
  const inHead = sub.source === "reply" && lastRows.length === 1 && width(sub.text) <= subW - 9;
  const newest = last && lastRows.length && !inHead ? { rows: lastRows, t: last.t } : undefined;
  const earlier = (focus ? says.slice(0, -1) : says.slice(0, -1).slice(-2))
    .map((x) => ({ flat: once(x, `flat ${g.measure} ${opt.plainGlyphs}`, () => wrap(flatReply(x.text), g.measure)), rich: focus ? formatted(x, true) : undefined, t: x.t }))
    .filter((x) => x.flat.length);
  // Threads keep a steady order (live, in a tool, quiet, finished; then by age) so a row does not jump when it stalls.
  const groups = body ? v.groups.map((x) => ({ wf: x.wf, rows: [...x.rows].sort((a, b) => AGENT_ORDER[stateOf(a, now)] - AGENT_ORDER[stateOf(b, now)] || a.tail.birth - b.tail.birth) })) : [];
  return {
    v,
    body,
    focus,
    sub,
    question,
    nowLine,
    prompt,
    earlier,
    newest,
    groups,
    buckets: bucketsIn(tailsOf(s).map((t) => t.tools), win),
    keep: {
      now: body && !!nowLine,
      prompt: prompt ? (focus ? Math.min(2, prompt.lines.length) : 1) : 0,
      earlier: earlier.map(() => (focus ? Infinity : 2)),
      reply: focus ? Infinity : 10,
      tasks: body && v.showTasks,
      ctx: body,
      main: body && v.showMain && !!m,
      done: body && v.doneCount > 0,
      agents: Infinity,
      fold: false,
      roster: body,
      question: 3,
    },
    folded: false,
  };
}

/** A row of the left stack: who spoke, what was said, how long ago. */
interface StackRow {
  icon?: Seg;
  at?: number; // the column its text starts at, when that is not the text column
  segs: Seg[];
  age?: Seg;
  mark?: string; // "… +N lines", right-aligned at the end of the measure
}
/**
 * The left stack, top to bottom: the now-line (a waiting session only), then the conversation as it
 * happened (your prompt, earlier replies, the newest reply; a prompt typed after the last reply comes
 * after it), then the tasks.
 */
function stackOf(b: Block, g: Grid, now: number): StackRow[] {
  if (!b.body) return [];
  const k = b.keep;
  const rows: StackRow[] = [];
  if (k.now && b.nowLine) rows.push({ at: g.icon, segs: [[cutTo(b.nowLine, g.textEnd - g.icon + 1), C.dim]] });
  const said: { t: number; rows: StackRow[] }[] = [];
  if (k.prompt > 0 && b.prompt) {
    const p = b.prompt;
    const lines = k.prompt < 2 || p.lines.length < 2 ? [cutTo(p.text, g.measure)] : [p.lines[0], cutTo(p.lines.slice(1).join(" "), g.measure)];
    said.push({ t: p.t ?? 0, rows: lines.map((line, i) => ({ icon: i ? undefined : [ICON.you, C.blue, true], segs: [[line, C.pale]], age: !i && p.t ? [ago(now - p.t), C.dim] : undefined })) });
  }
  b.earlier.forEach((e, n) => {
    const cap = k.earlier[n];
    if (cap <= 0) return;
    let lines: Seg[][];
    if (cap === Infinity && e.rich) lines = e.rich;
    else {
      const shown = e.flat.slice(0, cap);
      if (e.flat.length > shown.length) shown[shown.length - 1] = `${clipWords(shown[shown.length - 1], g.measure - 2)} ${ICON.cut}`;
      lines = shown.map((line): Seg[] => [[line, C.dim]]);
    }
    said.push({ t: e.t, rows: lines.map((segs, i) => ({ icon: i ? undefined : [ICON.earlier, EARLIER_TONE], segs, age: i ? undefined : [ago(now - e.t), C.dim] })) });
  });
  if (k.reply > 0 && b.newest) {
    const { rows: all, t } = b.newest;
    // New since you last looked: a bold white ◆, and the word "new" where its age would be.
    const fresh = isNew(t);
    said.push({ t, rows: clipReply(all, k.reply, g.measure).map((row, i) => ({ icon: i ? undefined : [ICON.claude, fresh ? C.white : C.cyan, fresh], segs: row.segs, mark: row.mark, age: i ? undefined : fresh ? ["new", C.white, true] : [ago(now - t), C.dim] })) });
  }
  for (const item of said.sort((x, y) => x.t - y.t)) rows.push(...item.rows);
  const tasks = b.v.s.tasks;
  if (k.tasks && tasks) {
    const count = `${tasks.done}/${tasks.total}`;
    const segs: Seg[] =
      tasks.done >= tasks.total
        ? [[ICON.done + " ", C.done], [`${count} tasks done`, C.dim]]
        : [...stepStrip(tasks.done, tasks.doing, tasks.total), [`  ${count}`, C.text], ...(tasks.active ? [[`  ${tasks.active}`, C.dim] as Seg] : [])];
    rows.push({ at: g.icon, segs: fitSegs(segs, (g.wide ? g.textEnd : g.figEnd) - g.icon + 1) });
  }
  return rows;
}

type Instrument = "ctx" | "key" | "figs";
/**
 * The instruments in the lane beside the left stack, from its first row: the context bar, its colour
 * key, and the figures. They never add a row: with a shorter stack the list is cut from the bottom.
 * With no stack at all the first one keeps a row to itself (the context row), until the ladder takes it.
 */
function instrumentsOf(b: Block, g: Grid, stackRows: number): Instrument[] {
  if (!b.body || !g.wide) return [];
  const all: Instrument[] = b.v.facts.main?.ctx ? ["ctx", "key", "figs"] : ["figs"];
  return stackRows ? all.slice(0, stackRows) : b.keep.ctx ? all.slice(0, 1) : [];
}

/** A row of the roster: the main thread or an agent, a workflow, or a line that stands for several agents. */
type Thread = { kind: "agent"; a: Agent; child: boolean } | { kind: "wf"; wf: Workflow } | { kind: "more"; n: number; child: boolean } | { kind: "folded"; rows: Agent[] } | { kind: "done"; n: number };
/** The roster: the main thread, each workflow and its agents, standalone agents, and the finished tally. */
function rosterOf(b: Block, now: number): Thread[] {
  const k = b.keep;
  if (!b.body || !k.roster) return [];
  const out: Thread[] = [];
  const main = b.v.facts.main;
  if (k.main && main) out.push({ kind: "agent", a: { id: "main", label: "main thread", type: "", model: "", tail: main, done: false }, child: false });
  const rank = (a: Agent) => (b.v.stall.threads.includes(a.id) ? -1 : AGENT_ORDER[stateOf(a, now)]); // a stalled agent is the last to be folded away
  for (const grp of b.groups) {
    let rows = grp.rows;
    if (rows.length > k.agents) {
      const kept = new Set([...rows].sort((x, y) => rank(x) - rank(y)).slice(0, k.agents)); // the most active, in the order they were in
      rows = rows.filter((a) => kept.has(a));
    }
    const more = grp.rows.length - rows.length;
    if (grp.wf) out.push({ kind: "wf", wf: grp.wf });
    if (k.fold && (grp.wf || grp.rows.length > 1)) {
      if (!grp.wf) out.push({ kind: "folded", rows: grp.rows }); // a workflow's own strip already counts its agents
      continue;
    }
    for (const a of rows) out.push({ kind: "agent", a, child: !!grp.wf });
    if (more) out.push({ kind: "more", n: more, child: !!grp.wf });
  }
  if (k.done && b.v.doneCount) out.push({ kind: "done", n: b.v.doneCount });
  return out;
}

/** A block laid out: how many head rows, whether the vitals row is there, the left stack, the instruments beside it, the roster. */
interface Parts {
  head: number;
  vitals: boolean; // narrow screens: the instruments as one row under the head
  stack: StackRow[];
  inst: Instrument[];
  roster: Thread[];
}
function partsOf(b: Block, g: Grid, now: number): Parts {
  const stack = stackOf(b, g, now);
  return { head: 1 + Math.max(1, Math.min(b.keep.question, b.question.length)), vitals: b.body && !g.wide && b.keep.ctx, stack, inst: instrumentsOf(b, g, stack.length), roster: rosterOf(b, now) };
}
const rowsOfParts = (p: Parts) => p.head + (p.vitals ? 1 : 0) + Math.max(p.stack.length, p.inst.length) + p.roster.length;
/** How many rows a block takes as it stands. */
export const blockRows = (b: Block, g: Grid, now: number): number => rowsOfParts(partsOf(b, g, now));

// ── the ladder ──

/** A cut made to one block: how to take it back, and whether it is still the last word on what it cut. */
interface Change {
  undo: () => void;
  stands: () => boolean; // false once a later cut has gone further; that one has to come back first
  /** For a cut that can come back in part (lines of a reply, agents of a group): restore as much as still fits, fullest first. False when nothing does. */
  ease?: (fits: () => boolean, spare: number) => boolean;
  fold?: boolean; // the whole session went into the "… n more" line
}
const change = (make: () => void, undo: () => void, stands: () => boolean, extra: Partial<Change> = {}): Change => (make(), { undo, stands, ...extra });
const needsYou = (b: Block) => b.v.state === "needs";
const turnOff = (b: Block, key: "now" | "tasks" | "ctx" | "main" | "done" | "roster") => (b.keep[key] ? change(() => (b.keep[key] = false), () => (b.keep[key] = true), () => !b.keep[key]) : undefined);
const foldAgents = (b: Block) => (b.keep.fold ? undefined : change(() => (b.keep.fold = true), () => (b.keep.fold = false), () => b.keep.fold));
/** Cap the newest reply at `lines`, when it is showing more. It comes back a line at a time. */
function replyTo(b: Block, lines: number): Change | undefined {
  const from = b.keep.reply;
  const whole = Math.min(from, b.newest?.rows.length ?? 0);
  if (whole <= lines) return undefined;
  return change(() => (b.keep.reply = lines), () => (b.keep.reply = from), () => b.keep.reply === lines, {
    ease: (fits, spare) => {
      for (let n = Math.min(whole, lines + spare + 1); n > lines; n--) {
        b.keep.reply = n === whole ? from : n;
        if (fits()) return true;
      }
      return false;
    },
  });
}
/** Cap every agent group at its `most` most active, when one is showing more. They come back an agent at a time. */
function agentsTo(b: Block, most: number): Change | undefined {
  const from = b.keep.agents;
  const longest = Math.max(0, ...b.groups.map((x) => x.rows.length));
  if (Math.min(from, longest) <= most) return undefined;
  return change(() => (b.keep.agents = most), () => (b.keep.agents = from), () => b.keep.agents === most, {
    ease: (fits, spare) => {
      for (let n = Math.min(longest, most + spare + 1); n > most; n--) {
        b.keep.agents = n === longest ? from : n;
        if (fits()) return true;
      }
      return false;
    },
  });
}
/** Cap one earlier reply at `lines`: the oldest that is showing more. `upTo` limits it to the first so many. */
function earlierTo(b: Block, lines: number, upTo = b.earlier.length): Change | undefined {
  const shown = (n: number) => (b.keep.earlier[n] === Infinity && b.earlier[n].rich ? b.earlier[n].rich!.length : Math.min(b.keep.earlier[n], b.earlier[n].flat.length));
  const n = b.earlier.findIndex((_, i) => i < upTo && shown(i) > lines);
  if (n < 0) return undefined;
  const from = b.keep.earlier[n];
  return change(() => (b.keep.earlier[n] = lines), () => (b.keep.earlier[n] = from), () => b.keep.earlier[n] === lines);
}
function promptOff(b: Block): Change | undefined {
  const from = b.keep.prompt;
  return from > 0 ? change(() => (b.keep.prompt = 0), () => (b.keep.prompt = from), () => b.keep.prompt === 0) : undefined;
}
const foldAway = (b: Block) => (b.folded ? undefined : change(() => (b.folded = true), () => (b.folded = false), () => b.folded, { fold: true }));
function questionToOneRow(b: Block): Change | undefined {
  const from = b.keep.question;
  return Math.min(from, b.question.length) > 1 ? change(() => (b.keep.question = 1), () => (b.keep.question = from), () => b.keep.question === 1) : undefined;
}

/**
 * The ladder: what the blocks give up, in this order, when they do not all fit. Each rung is taken from
 * the bottom session upward, one block at a time, and the climb stops the moment everything fits. The
 * numbers are the design's. A session that needs you skips the second half of 4 and all of 8, 9 and 13:
 * its title, its whole question and two lines of the reply always stay. "gaps" is the one rung that is
 * not a block's own.
 */
const LADDER: { step: number; cut: "gaps" | ((b: Block) => Change | undefined) }[] = [
  // In focus every stored reply starts out in full. These two bring the earlier ones back to what the dashboard shows.
  { step: 0, cut: (b) => (b.focus ? earlierTo(b, 0, b.earlier.length - 2) : undefined) },
  { step: 0, cut: (b) => (b.focus ? earlierTo(b, 2) : undefined) },
  { step: 1, cut: (b) => earlierTo(b, 1) }, // earlier replies shrink to one line each
  { step: 2, cut: (b) => earlierTo(b, 0) }, // …and are removed, oldest first
  { step: 3, cut: (b) => turnOff(b, "done") }, // the "n agents finished" line
  { step: 4, cut: (b) => (b.focus ? replyTo(b, 10) : undefined) },
  { step: 4, cut: (b) => replyTo(b, 4) }, // the newest reply is capped at 4 lines,
  { step: 4, cut: (b) => (needsYou(b) ? undefined : replyTo(b, 2)) }, // then 2
  { step: 5, cut: (b) => agentsTo(b, 3) }, // agent groups longer than 3: the 3 most active and "… n more agents"
  { step: 6, cut: (b) => turnOff(b, "now") }, // the dim now-line under a question
  { step: 7, cut: "gaps" }, // the blank rows between sessions
  { step: 8, cut: (b) => (needsYou(b) ? undefined : promptOff(b)) }, // your prompt
  { step: 9, cut: (b) => (needsYou(b) ? undefined : replyTo(b, 1)) }, // the newest reply shrinks to one line
  { step: 10, cut: (b) => turnOff(b, "main") }, // the main-thread row
  { step: 11, cut: (b) => (b.groups.some((x) => (x.wf ? x.rows.length > 0 : x.rows.length > 1)) ? foldAgents(b) : undefined) }, // agents fold: a workflow's into its own row, standalone ones into one line
  { step: 12, cut: (b) => (needsYou(b) ? promptOff(b) : undefined) }, // sessions that need you: the prompt,
  { step: 12, cut: (b) => (needsYou(b) ? replyTo(b, 2) : undefined) }, // then the reply down to 2 lines, and no further
  { step: 13, cut: (b) => (needsYou(b) ? undefined : replyTo(b, 0)) }, // the newest reply is removed
  { step: 14, cut: (b) => turnOff(b, "tasks") }, // the tasks row,
  { step: 14, cut: (b) => turnOff(b, "ctx") }, // then the context row
  { step: 15, cut: (b) => turnOff(b, "roster") }, // workflow rows and the folded agents line: now a small far card
  { step: 16, cut: (b) => (needsYou(b) ? undefined : foldAway(b)) }, // whole sessions, never one that needs you
  // Past the design's ladder, for a screen too small even for that: a waiting session's reply, then all but one row of its question, then the session.
  { step: 18, cut: (b) => (needsYou(b) ? replyTo(b, 0) : undefined) },
  { step: 18, cut: (b) => (needsYou(b) ? questionToOneRow(b) : undefined) },
  { step: 18, cut: (b) => (needsYou(b) ? foldAway(b) : undefined) },
];

/**
 * Fit the blocks into `avail` rows by climbing the ladder, then hand back what is left over (the
 * design's step 17): the cuts are undone in reverse order, top session first, each one only if it
 * still fits; a cut to the newest reply comes back a line at a time, and a cut to an agent group an
 * agent at a time. Last, a spare row goes to a second line of a long prompt. Returns whether the blank
 * rows between sessions survived, and the rows used.
 */
export function fitBlocks(blocks: Block[], g: Grid, avail: number, now: number): { gaps: boolean; rows: number } {
  const height = new Map<Block, number>();
  const rowsIn = (b: Block) => {
    let n = height.get(b);
    if (n === undefined) height.set(b, (n = blockRows(b, g, now)));
    return n;
  };
  let gaps = true;
  const total = () => {
    const open = blocks.filter((b) => !b.folded);
    return open.reduce((n, b) => n + rowsIn(b), 0) + (gaps ? Math.max(0, open.length - 1) : 0) + (open.length < blocks.length ? 1 : 0);
  };
  const over = () => total() > avail;
  const made: (Change & { step: number; at: number; seq: number })[] = [];
  for (const rung of LADDER) {
    if (!over()) break;
    if (rung.cut === "gaps") {
      made.push({ step: rung.step, at: -1, seq: made.length, ...change(() => (gaps = false), () => (gaps = true), () => !gaps) });
      continue;
    }
    for (let at = blocks.length - 1; at >= 0 && over(); at--) {
      const b = blocks[at];
      if (b.folded) continue;
      // A rung that takes one reply at a time is asked again until the block has no more of them.
      for (let c = rung.cut(b); c; c = over() ? rung.cut(b) : undefined) {
        height.delete(b);
        made.push({ step: rung.step, at, seq: made.length, ...c });
      }
    }
  }
  let unfolding = true; // sessions come back out of the "… n more" line top first, and stop at the first that does not fit
  for (const c of [...made].sort((x, y) => y.step - x.step || x.at - y.at || y.seq - x.seq)) {
    const b: Block | undefined = blocks[c.at];
    if (!c.stands() || (c.fold ? !unfolding : b?.folded)) continue;
    const before = b && { keep: { ...b.keep, earlier: [...b.keep.earlier] }, folded: b.folded };
    const back = () => {
      if (b && before) (b.keep = before.keep), (b.folded = before.folded), height.delete(b);
      else gaps = false;
    };
    if (b && c.ease) {
      if (!c.ease(() => (height.delete(b), !over()), Math.max(0, avail - total()))) back();
      continue;
    }
    c.undo();
    if (b) height.delete(b);
    if (!over()) continue;
    back();
    if (c.fold) unfolding = false;
  }
  for (const b of blocks) {
    if (b.folded || !b.prompt || b.keep.prompt !== 1 || b.prompt.lines.length < 2) continue;
    b.keep.prompt = 2;
    height.delete(b);
    if (!over()) continue;
    b.keep.prompt = 1;
    height.delete(b);
  }
  return { gaps, rows: total() };
}

// ── drawing ──

/** What every row of the view shares: the grid, the time, the lane's window and the two scales sparklines are drawn against. */
interface Paint {
  g: Grid;
  now: number;
  win: Win;
  sessionMax: number; // session and workflow sparklines
  agentMax: number; // agents and main threads
}

/** A session's context window: how full, split by category (largest first), and when it will be full if that is within the hour. */
function contextOf(b: Block, now: number) {
  const m = b.v.facts.main;
  if (!m?.ctx) return undefined;
  const max = ctxMax(m.ctx);
  const split = contextSplit(m);
  const runway = sessionRunway(m, now);
  return {
    max,
    split,
    pct: Math.round(Math.min(1, m.ctx.used / max) * 100),
    key: split.filter((x) => x.tokens > 0).sort((x, y) => y.tokens - x.tokens).map((x): Seg[] => [[ICON.swatch + " ", x.color], [`${x.short} ${human(x.tokens)}`, C.dim]]),
    runway: runway === undefined ? undefined : ([fullInText(runway), runwayTone(runway), true] as Seg),
  };
}
/** "34k out · cpu 3% · 0.4G": output tokens in the window, then the CPU and memory of the session's process tree. Fullest first, for whichever fits. */
function figuresOf(b: Block, p: Paint): Seg[][] {
  const use = treeUsage(b.v.s.pid);
  const out: Seg[] = [[human(tokensIn(tailsOf(b.v.s), p.win)), C.text], [" out", C.dim]];
  if (!use.known) return [out];
  const cpu: Seg[] = [...out, [` ${ICON.sep} `, C.faint], [`cpu ${Math.round(use.cpu)}%`, C.dim]];
  return [[...cpu, [` ${ICON.sep} `, C.faint], [gb(use.rss * 1024), C.dim]], cpu, out];
}

/** The head rows: title, place and state; then the subheading (or the question, wrapped) with the session's sparkline and tool count. */
function headRows(b: Block, p: Paint): Row[] {
  const { g, now } = p;
  const { s, facts: f, state } = b.v;
  const needs = state === "needs";
  const receded = state === "yourTurn" || state === "idle" || state === "finished";
  const tone = STATE[state].color;
  const dim = needs ? C.warmDim : C.dim;
  const start = () => {
    const r = new Row(g.W, needs ? C.tint : undefined);
    r.put(g.rail, ICON.railThick, railTone(state, true, frame));
    return r;
  };
  // Title row. The state never shrinks; the place gives way first, then the title's letter-spacing, then the title is cut.
  const r1 = start();
  const time = stateTime(s, f, state, now, b.v.stall.since);
  const stateSegs: Seg[] = [[STATE[state].glyph + " ", tone, true], [[...STATE[state].word].join(" "), tone, true], ...(time ? ([["  ·  ", dim], [time, tone]] as Seg[]) : [])];
  const stateAt = g.figEnd - segsWidth(stateSegs) + 1;
  const limit = Math.min(g.textEnd, stateAt - 3);
  const upper = s.name.toUpperCase();
  const spaced = [...upper].join(" ");
  const title = cutTo(g.icon + width(spaced) - 1 <= limit ? spaced : upper, limit - g.icon + 1);
  r1.put(g.icon, title, receded ? C.text : C.white, true);
  const folders = s.cwd.replace(os.homedir(), "~").split("/").filter(Boolean);
  const branch = s.mains.map((m) => m.branch).find(Boolean);
  const at = branch && branch !== "HEAD" ? ` ${ICON.at} ${branch}` : "";
  const where = folders.slice(-2).join("/") + at;
  const kind = `${s.kind || "cli"} ${s.sid.slice(0, 8)}`;
  // 'folder/folder @ branch · kind id' loses the kind and id first, then the parent folder, then goes. Under 100 columns it is not drawn.
  const places: Seg[][] = where ? [[[where, dim], [` ${ICON.sep} `, needs ? C.warmDim : C.faint], [kind, dim]], [[where, dim]], [[folders.slice(-1).join("") + at, dim]]] : [[[kind, dim]]];
  const place = g.small ? undefined : places.find((x) => g.icon + width(title) + 3 + segsWidth(x) - 1 <= limit);
  if (place) r1.segsr(limit, place);
  r1.segs(stateAt, stateSegs);

  const subW = g.textEnd - g.icon + 1;
  const out = [r1];
  const shown = b.question.slice(0, Math.max(1, b.keep.question));
  if (b.question.length > shown.length) shown[shown.length - 1] = cutTo(b.question.slice(shown.length - 1).join(" "), subW);
  (needs && shown.length ? shown : [""]).forEach((q, i) => {
    const r = start();
    if (needs) r.put(g.icon, q, C.white, true);
    else if (b.sub.source === "prompt" || b.sub.source === "reply") {
      // Your prompt, promoted (and then not repeated below), or the first line of Claude's newest reply.
      const mine = b.sub.source === "prompt";
      const fresh = !mine && !!b.sub.t && isNew(b.sub.t);
      const age: Seg | undefined = !b.sub.t ? undefined : fresh ? ["new", C.white, true] : mine || state !== "yourTurn" ? [ago(now - b.sub.t), C.dim] : undefined; // a your-turn session's state already says how long ago
      r.put(g.icon, mine ? ICON.you : ICON.claude, mine ? C.blue : fresh ? C.white : C.cyan, mine || fresh);
      r.put(g.text, cutTo(b.sub.text, subW - 2 - (age ? 7 : 0)), receded ? C.dim : C.white);
      if (age) r.segsr(g.textEnd, [age]);
    } else r.put(g.icon, cutTo(b.sub.text, subW), receded ? C.dim : C.white);
    if (i === 0) {
      r.paste(g.lane, spark(b.buckets, p.sessionMax, ...RAMP.session), g.laneW);
      const tools = human(sum(b.buckets));
      const unit = width(tools) + 6 <= g.figW ? " tools" : "";
      r.putr(r.putr(g.figEnd, unit, dim), tools, C.text);
    }
    out.push(r);
  });
  return out;
}

/** One row of the roster. */
function threadRow(b: Block, t: Thread, r: Row, p: Paint) {
  const { g, now, win } = p;
  if (t.kind === "done") {
    r.segs(g.icon, [[ICON.done + " ", C.done], [`${t.n} agent${t.n === 1 ? "" : "s"} finished in the last ${opt.windowMin}m`, C.dim], [`  ${ICON.sep}  d lists them`, C.faint]]);
    return;
  }
  if (t.kind === "more") {
    r.put(t.child ? g.childIcon : g.icon, `${ICON.cut} ${t.n} more agent${t.n === 1 ? "" : "s"}`, C.dim);
    return;
  }
  if (t.kind === "folded") {
    // Standalone agents folded into one line: "⠋ 2 live   ◐ 1 in a tool".
    const n = { live: 0, tool: 0, stalled: 0, quiet: 0, done: 0 };
    for (const a of t.rows) {
      const st = stateOf(a, now);
      n[b.v.stall.threads.includes(a.id) ? "stalled" : st === "active" ? "live" : st] += 1;
    }
    const parts: Seg[][] = [];
    if (n.stalled) parts.push([[ICON.progress + " ", C.red], [`${n.stalled} stalled?`, C.red, true]]);
    if (n.live) parts.push([[SPIN[frame % SPIN.length] + " ", C.green], [`${n.live} live`, C.text]]);
    if (n.tool) parts.push([[ICON.progress + " ", C.white], [`${n.tool} in a tool`, C.text]]);
    if (n.quiet) parts.push([[ICON.idle + " ", C.dim], [`${n.quiet} quiet`, C.dim]]);
    if (n.done) parts.push([[ICON.done + " ", C.done], [`${n.done} finished`, C.dim]]);
    r.segs(g.icon, parts.flatMap((x, i): Seg[] => (i ? [["   "], ...x] : x)));
    return;
  }
  if (t.kind === "wf") {
    const wf = t.wf;
    const outcome = wfOutcome(wf);
    const live = outcome === "running";
    const total = wf.agents.length;
    const finished = wf.agents.filter((a) => a.done).length;
    const count = `${finished}/${total}`;
    r.put(g.icon, live ? ICON.workflow : outcome === "completed" ? ICON.done : ICON.failed, live ? C.purple : outcome === "completed" ? C.done : C.red, live);
    if (g.small) {
      // Too narrow for the trail and the strip: the name and the count.
      r.put(g.text, cutTo(wf.name, g.textEnd - width(count) - 2 - g.text + 1), live ? C.white : C.text, live);
      r.putr(g.textEnd, count, C.text);
    } else {
      r.put(g.text, cutTo(wf.name, g.labelEnd - g.text + 1), live ? C.white : C.text, live);
      // Right-aligned: one glyph per agent and done/total. When that would leave the trail no room, the count alone.
      let right: Seg[] = [...stepStrip(finished, live ? total - finished : 0, total), [`  ${count}`, C.text]];
      if (g.textEnd - segsWidth(right) - 2 - g.action + 1 < 10) right = [[count, C.text]];
      const room = r.segsr(g.textEnd, right) - 2 - g.action + 1;
      let trail: Seg[];
      if (!live) trail = outcome === "completed" ? [[`completed${wf.tokens !== undefined ? ` ${ICON.sep} ${human(wf.tokens)} tok` : ""}`, C.dim]] : [[wf.status || "failed", C.red]];
      else {
        // The phase trail: ✓ passed, ◐ current, ○ later. Too long: passed phases go from the left. A narrow screen shows the current one only.
        const steps = phaseTrail(wf).filter((x) => g.wide || x.state === "now");
        const span = () => steps.reduce((n, x) => n + 2 + width(x.name), 0) + 2 * Math.max(0, steps.length - 1);
        while (steps.length > 1 && span() > room && steps[0].state === "done") steps.shift();
        while (steps.length > 1 && span() > room && steps[steps.length - 1].state === "next") steps.pop();
        while (steps.length > 1 && span() > room) steps.shift();
        trail = steps.flatMap((x, i): Seg[] => [
          ...(i ? [["  "] as Seg] : []),
          ...((x.state === "done" ? [[ICON.done + " ", C.done], [x.name, C.dim]] : x.state === "now" ? [[ICON.progress + " ", C.white], [x.name, C.white, true]] : [[ICON.idle + " ", C.faint], [x.name, C.dim]]) as Seg[]),
        ]);
      }
      r.segs(g.action, fitSegs(trail, room));
    }
    r.paste(g.lane, spark(bucketsIn(wf.agents.map((a) => a.tail.tools), win), p.sessionMax, ...RAMP.workflow), g.laneW);
    if (live) r.putr(g.figEnd, `up ${ago(now - wf.started)}`, C.green);
    else r.putr(g.figEnd, ago(now - Math.max(wf.finished, wf.lastT)), C.dim);
    return;
  }
  // The main thread or an agent: state glyph, label, what it is doing, type and model, sparkline, age.
  const a = t.a;
  const st = stateOf(a, now);
  const stalled = b.v.stall.threads.includes(a.id);
  const at = t.child ? g.childIcon : g.icon;
  const quietFor = now - Math.max(a.tail.lastT, a.tail.mtime);
  const receded = st === "quiet" || st === "done";
  if (stalled) r.put(at, ICON.progress, C.red);
  else if (st === "active") r.put(at, SPIN[frame % SPIN.length], C.green);
  else if (st === "tool") r.put(at, ICON.progress, C.white);
  else r.put(at, st === "done" ? ICON.done : ICON.idle, st === "done" ? C.done : C.dim);
  r.put(at + 2, cutTo(a.label, (g.small ? g.textEnd : g.labelEnd) - (at + 2) + 1), receded ? C.dim : C.text);
  if (!g.small) {
    const meta = g.wide ? (t.child ? a.model : [shortType(a.type), a.model].filter(Boolean).join(` ${ICON.sep} `)) : "";
    const room = (meta ? g.actionEnd : g.textEnd) - g.action + 1;
    const pending = a.tail.lastTool && a.tail.lastTool.t > a.tail.lastResultT ? a.tail.lastTool : undefined;
    if (st === "done") r.put(g.action, "finished", C.dim);
    else if (pending) {
      // The pending tool's name in cyan, its hint in text colour. A stalled thread says so first.
      const pre: Seg[] = stalled ? [["stalled? ", C.red, true]] : [];
      const name = cutTo(pending.name, room - segsWidth(pre));
      const hintRoom = room - segsWidth(pre) - width(name) - 2;
      r.segs(g.action, [...pre, [name, C.cyan], ...(pending.hint && hintRoom > 1 ? [["  " + cutTo(pending.hint, hintRoom), C.text] as Seg] : [])]);
    } else r.put(g.action, st === "quiet" ? "no activity" : "thinking", C.dim);
    if (meta) r.putr(g.typeEnd, cutTo(meta, g.typeEnd - g.type + 1), C.dim);
  }
  r.paste(g.lane, spark(bucketsIn([a.tail.tools], win), p.agentMax, ...RAMP.agent), g.laneW);
  if (stalled) r.putr(g.figEnd, ago(quietFor), C.red, true);
  else if (st === "active") r.putr(g.figEnd, "live", C.green);
  else r.putr(g.figEnd, ago(quietFor), C.dim);
}

/** A block's rows, drawn. `head` says how many of them are head rows (the ones a click focuses). */
function drawBlock(b: Block, p: Paint): { rows: string[]; head: number } {
  const { g, now } = p;
  const parts = partsOf(b, g, now);
  const rows: Row[] = headRows(b, p);
  const body = () => {
    const r = new Row(g.W);
    r.put(g.rail, ICON.railThin, railTone(b.v.state, false));
    rows.push(r);
    return r;
  };
  const ctx = contextOf(b, now);
  const figures = figuresOf(b, p);
  if (parts.vitals) {
    // Narrow: the instruments are one row under the head. Context bar, "pct of max", the biggest category, the figures, whatever fits.
    const r = body();
    let c = g.icon;
    if (ctx) {
      const tone = figureTone(ctx.pct);
      c = r.paste(c, stacked(ctx.split, ctx.max, 20), 20) + 2;
      c = r.segs(c, [[`${ctx.pct}%`, tone.color, tone.bold], [` of ${human(ctx.max)}`, C.dim]]) + 3;
    }
    const fits = (segs: Seg[], then = 0) => c + segsWidth(segs) + then - 1 <= g.figEnd;
    const fig = figures.find((x) => fits(x));
    if (ctx?.key[0] && fig && fits(ctx.key[0], 3 + segsWidth(fig))) c = r.segs(c, ctx.key[0]) + 3;
    if (fig) c = r.segs(c, fig) + 3;
    if (ctx?.runway && fits([ctx.runway])) r.segs(c, [ctx.runway]);
  }
  for (let i = 0; i < Math.max(parts.stack.length, parts.inst.length); i++) {
    const r = body();
    const item = parts.stack[i];
    if (item) {
      if (item.icon) r.segs(g.icon, [item.icon]);
      r.segs(item.at ?? g.text, item.segs);
      if (item.mark) r.putr(g.text + g.measure - 1, item.mark, C.dim);
      if (item.age) r.segsr(g.ageEnd, [item.age]);
    }
    const inst = parts.inst[i];
    if (inst === "ctx" && ctx) {
      const tone = figureTone(ctx.pct);
      r.paste(g.lane, stacked(ctx.split, ctx.max, g.laneW), g.laneW);
      r.putr(r.putr(g.figEnd, ` of ${human(ctx.max)}`, C.dim), `${ctx.pct}%`, tone.color, tone.bold);
    } else if (inst === "key" && ctx) {
      // The largest categories that fit, and at the right end the runway, when there is one to give.
      const room = g.figEnd - g.lane + 1 - (ctx.runway ? width(ctx.runway[0]) + 2 : 0);
      let c = g.lane;
      for (const entry of ctx.key) {
        if (c - g.lane + segsWidth(entry) > room) break;
        c = r.segs(c, entry) + 2;
      }
      if (ctx.runway) r.segsr(g.figEnd, [ctx.runway]);
    } else if (inst === "figs") r.segs(g.lane, figures[0]);
    if (inst && !item) {
      // No left stack: the context row still shows, with the key and the figures on its left side.
      const room = g.textEnd - g.icon + 1;
      const left: Seg[] = [];
      for (const entry of inst === "ctx" && ctx ? ctx.key.slice(0, 3) : []) if (segsWidth(left) + segsWidth(entry) + 3 + segsWidth(figures[0]) <= room) left.push(...entry, ["  "]);
      if (left.length) left.push([" "]);
      left.push(...figures[0]);
      if (ctx?.runway && segsWidth(left) + 3 + width(ctx.runway[0]) <= room) left.push(["   "], ctx.runway);
      if (inst === "ctx") r.segs(g.icon, left);
    }
  }
  for (const t of parts.roster) threadRow(b, t, body(), p);
  return { rows: rows.map(String), head: parts.head };
}

/**
 * Detail mode's sessions, drawn into at most `avail` rows; it returns exactly the rows it uses. `views`
 * are the sessions to show, already in order (buildViews). `top` is how many rows of the frame are
 * above, so the head rows can be registered as click targets. With one session in focus it gets the
 * whole space: every stored reply in full, blank rows between paragraphs, every agent.
 */
export function detailView(views: View[], W: number, avail: number, now: number, top = 0, focus = focusSid !== null && views.length === 1 && views[0].s.sid === focusSid): string[] {
  if (avail <= 0 || !views.length) return [];
  const g = grid(W);
  const win = laneWindow(now, W);
  const blocks = views.map((v) => blockOf(v, g, now, win, focus));
  const { gaps } = fitBlocks(blocks, g, avail, now);
  const p: Paint = {
    g,
    now,
    win,
    sessionMax: Math.max(1, ...blocks.map((b) => Math.max(...b.buckets))),
    agentMax: Math.max(1, ...blocks.flatMap((b) => [...(b.v.showMain && b.v.facts.main ? [b.v.facts.main] : []), ...b.groups.flatMap((x) => x.rows.map((a) => a.tail))]).map((t) => Math.max(...bucketsIn([t.tools], win)))),
  };
  const out: string[] = [];
  for (const b of blocks.filter((x) => !x.folded)) {
    if (out.length && gaps) out.push("");
    const { rows, head } = drawBlock(b, p);
    for (let i = 0; i < head && out.length + i < avail; i++) hits.push({ row: top + out.length + i + 1, x0: 1, x1: W, act: "focus:" + b.v.s.sid });
    out.push(...rows);
  }
  const more = blocks.filter((x) => x.folded);
  if (more.length) {
    // Whole sessions that did not fit, in one line: "… 2 more: name, name". A waiting one is still marked.
    const r = new Row(W);
    const names = more.flatMap((b, i): Seg[] => [...(i ? [[", ", C.dim] as Seg] : []), ...(needsYou(b) ? [[`${ICON.needs} ${b.v.s.name}`, C.amber, true] as Seg] : [[b.v.s.name, C.dim] as Seg])]);
    r.segs(g.rail, fitSegs([[`${ICON.cut} ${more.length} more: `, C.dim], ...names], g.figEnd - g.rail + 1));
    out.push(String(r));
  }
  return out.slice(0, avail);
}

/** The click targets registered for the frame being drawn. render() starts each frame with none. */
export const clickTargets = () => hits.map((h) => ({ ...h }));

// ───────────────────────── the tree (compact mode), the far cards and the frame ─────────────────────────

export const rowsOf = (v: View) =>
  1 +
  (v.showNeeds ? 1 : 0) +
  (v.showCtx ? 1 : 0) +
  (v.showNow ? 1 : 0) +
  v.showTalk +
  (v.showTalk > 0 ? Math.max(0, v.alloc.reduce((n, x) => n + x, 0) - 1) : 0) +
  (v.showTasks ? 1 : 0) +
  (v.showMain ? 1 : 0) +
  v.groups.reduce((n, g) => n + (g.wf ? 1 : 0) + g.rows.length + (g.hidden ? 1 : 0), 0) +
  (v.doneCount ? 1 : 0);

/** Shrink the views until they fit in `avail` rows; returns [views, blank separators?, sessions cut]. */
export function fitViews(views: View[], avail: number): { views: View[]; gaps: boolean; cut: number } {
  const total = (gaps: boolean) => views.reduce((n, v) => n + rowsOf(v), 0) + (gaps ? Math.max(0, views.length - 1) : 0);
  let gaps = true;
  if (total(gaps) > avail) gaps = false;
  while (total(gaps) > avail) {
    let big: Group | undefined;
    for (const v of views) for (const g of v.groups) if (g.rows.length > 1 && (!big || g.rows.length > big.rows.length)) big = g;
    if (!big) break;
    const take = big.hidden ? 1 : Math.min(2, big.rows.length - 1);
    big.rows.splice(big.rows.length - take, take);
    big.hidden += take;
  }
  const rev = [...views].reverse(); // give rows up from the bottom of the screen first
  for (const v of rev) if (total(gaps) > avail && v.showTalk > 1) v.showTalk = 1;
  for (const v of rev) if (total(gaps) > avail) v.showTalk = 0;
  for (const v of rev) if (total(gaps) > avail) v.showMain = false;
  for (const v of rev) if (total(gaps) > avail) v.showTasks = false;
  for (const v of rev) if (total(gaps) > avail) v.showNow = false;
  for (const v of rev) if (total(gaps) > avail) v.showCtx = false;
  for (const v of views) if (total(gaps) > avail) v.doneCount = 0;
  let cut = 0;
  while (views.length > 1 && total(gaps) + 1 > avail) {
    views = views.slice(0, -1);
    cut++;
  }
  // Spend whatever rows are left on more of each session's last reply, one line each in turn.
  let spare = avail - total(gaps) - (cut ? 1 : 0);
  for (let grew = true; grew && spare > 0; ) {
    grew = false;
    for (const v of views) {
      if (spare <= 0) break;
      if (v.showTalk === 0) continue;
      // The newest message fills out first, then each earlier one in turn gets a few lines.
      const i = v.msgs.findIndex((msg, k) => (v.alloc[k] ?? 0) < Math.min(msg.lines.length, focusSid ? 60 : k === 0 ? 10 : 4));
      if (i < 0) continue;
      v.alloc[i] = (v.alloc[i] ?? 0) + 1;
      spare--;
      grew = true;
    }
  }
  return { views, gaps, cut };
}

export function render(sessions: Session[], cols: number, rows: number, now: number): string[] {
  const W = Math.max(60, cols);
  const S = Math.min(32, Math.max(12, Math.floor(W / 6))); // sparkline columns
  // Every strip of S bars on the screen shares these clock-aligned edges; so do the totals beside them.
  const win = timeWindow(now, opt.windowMin * 60_000, S);
  const since = win.start;
  const spin = fg(C.green, SPIN[frame % SPIN.length]);
  const out: string[] = [];

  hits.length = 0;

  const sayW = Math.max(20, W - 6 - 9 - 8);
  const all = buildViews(sessions, now, sayW, since);
  if (focusSid && !all.some((v) => v.s.sid === focusSid)) focusSid = null;
  const shown = all.filter((v) => (focusSid ? v.s.sid === focusSid : opt.showAll || !isHidden(v)));
  const hidden = all.filter((v) => !shown.includes(v));
  if (opt.mode === "compact")
    for (const v of shown) {
      v.showCtx = v.showNow = v.showTasks = v.showMain = false;
      v.showTalk = 0;
    }

  const allTails = sessions.flatMap((s) => [...s.mains, ...s.agents.map((a) => a.tail), ...s.workflows.flatMap((w) => w.agents.map((a) => a.tail))]);
  const allAgents = sessions.flatMap((s) => [...s.agents, ...s.workflows.flatMap((w) => w.agents)]);
  const running = allAgents.filter((a) => !a.done && Math.max(a.tail.lastT, a.tail.mtime) >= since);
  const liveWf = sessions.flatMap((s) => s.workflows).filter((w) => w.status === "running" && w.lastT >= since).length;

  // Header: fleet totals, then the machine, then the account.
  const HS = Math.min(60, Math.max(S, W - 92));
  const headBuckets = buckets(allTails.map((t) => t.tools), now, HS);
  const clock = new Date(now).toTimeString().slice(0, 8);
  const waiting = all.filter((v) => v.facts.needs).length;
  const active = all.length - all.filter(isHidden).length;
  const stats =
    (waiting ? `⚠ ${waiting} need${waiting === 1 ? "s" : ""} you  ·  ` : "") +
    `${active} active session${active === 1 ? "" : "s"}  ·  ${running.length} agent${running.length === 1 ? "" : "s"} running  ·  ` +
    `${liveWf} workflow${liveWf === 1 ? "" : "s"}  ·  ${human(sum(headBuckets))} tool calls / ${opt.windowMin}m`;
  const left = ` ◆ CLAUDE FLEET   `;
  const room = W - width(left) - HS - 2 - clock.length - 2;
  out.push(
    fg(C.cyan, bold(left)) + fg(waiting ? C.yellow : C.text, fit(stats, Math.max(0, room))) + " " + spark(headBuckets, Math.max(...headBuckets), [40, 110, 90], [120, 240, 170]) + "  " + fg(C.dim, clock) + " ",
  );
  out.push(machineRow(W));
  if (opt.usage) {
    out.push(usageRow(W, now));
    const remedy = accountView(now).remedy;
    if (remedy) out.push(fg(C.dim, " " + fit("        " + remedy, W - 2, "l", true))); // what to do about it, when there is something
  }
  out.push(fg(C.faint, " " + "─".repeat(W - 2)));

  if (!shown.length) {
    out.push("", fg(C.dim, all.length ? "   Nothing active and nothing waiting on you." : "   No live Claude Code sessions found in ~/.claude/sessions."));
  }

  // Shared scales so rows are comparable with each other. Taken before rows are folded away to fit the
  // screen: a row that folds (an agent going quiet changes which ones fold) must not rescale the rows that stay.
  const agentMax = Math.max(1, ...shown.flatMap((v) => v.groups.flatMap((g) => g.rows.map((a) => Math.max(...buckets([a.tail.tools], now, S))))));
  const sessionTails = tailsOf;
  const sessionMax = Math.max(1, ...shown.map((v) => Math.max(...buckets(sessionTails(v.s).map((t) => t.tools), now, S))));

  const avail = rows - out.length - 2 - (hidden.length ? 1 : 0);
  const { views, gaps, cut } = opt.mode !== "compact" ? { views: [] as View[], gaps: false, cut: 0 } : fitViews(shown, avail);
  // Detail mode draws its sessions with its own renderer (the detail view, above). The tree further down is compact mode's.
  if (opt.mode === "detail") out.push(...detailView(shown, W, avail, now, out.length));

  const ACT = W >= 150 ? 40 : W >= 120 ? 28 : W >= 100 ? 18 : 0; // "what it is doing" column
  const META = W >= 110 ? 18 : 0;
  const PW = W >= 130 ? 20 : 12; // progress glyph column // agent type / model column

  if (opt.mode === "far") {
    // Big cards, readable from across the room: colour and shape carry the state.
    const H = Math.max(4, Math.min(11, Math.floor(avail / Math.max(1, shown.length))));
    const fitCount = Math.max(1, Math.floor(avail / H));
    const cards = shown.slice(0, fitCount);
    const CW = Math.max(10, W - 40);
    const farBuckets = new Map(cards.map((v) => [v.s.sid, buckets(sessionTails(v.s).map((t) => t.tools), now, CW)]));
    const farMax = Math.max(1, ...[...farBuckets.values()].map((b) => Math.max(...b)));
    for (const v of cards) {
      const s = v.s;
      const f = v.facts;
      const busyNow = s.status === "busy";
      const stalled = v.state === "stalled";
      const tone = f.needs ? C.yellow : stalled ? C.red : f.yourTurn ? C.purple : busyNow ? C.green : C.dim;
      const bandTone = f.needs && frame % 2 ? mix(C.yellow, C.faint, 0.6) : tone;
      const band = " " + fg(bandTone, "██") + " ";
      const tint = (line: string, w: number) => (f.needs ? `\x1b[48;2;52;38;0m${line}${" ".repeat(Math.max(0, w))}\x1b[49m` : line);
      const state = f.needs ? "NEEDS YOU" : stalled ? "STALLED?" : f.yourTurn ? "YOUR TURN" : s.job?.state === "working" || busyNow ? "WORKING" : "IDLE";
      const stateText = state.split("").join(" ");
      const nameRoom = W - 4 - width(stateText) - 4;
      const spaced = s.name.toUpperCase().split("").join(" ");
      const name = width(spaced) <= nameRoom ? spaced : s.name.toUpperCase();
      const top = out.length;
      hits.push({ row: top + 1, x0: 1, x1: W, act: "focus:" + s.sid });
      out.push(tint(band + bold(fg(C.white, fit(name, nameRoom, "l", true))) + "  " + bold(fg(tone, stateText)) + " ", 0));
      const lineText = f.needs || f.now || (v.msgs[0]?.lines[0] ?? "");
      out.push(tint(band + fg(f.needs ? C.white : C.text, fit(lineText, W - 5)), 0));
      const chartH = Math.max(1, H - 3);
      const cardBuckets = farBuckets.get(s.sid)!;
      const chart = tallSpark(cardBuckets, farMax, chartH, [52, 84, 150], [150, 200, 255]);
      const agentsLive = [...s.agents, ...s.workflows.flatMap((w) => w.agents)].filter((a) => !a.done && Math.max(a.tail.lastT, a.tail.mtime) >= since).length;
      const wfLive = s.workflows.filter((w) => w.status === "running" && w.lastT >= since).length;
      const ctx = f.main?.ctx;
      const ctxPct = ctx ? Math.min(100, (ctx.used / ctxMax(ctx)) * 100) : -1;
      const use = treeUsage(s.pid);
      const side: string[] = [
        fg(agentsLive ? C.cyan : C.dim, bold(fit(`${agentsLive} AGENT${agentsLive === 1 ? "" : "S"}`, 12))) + fg(wfLive ? C.purple : C.dim, fit(wfLive ? `${wfLive} WORKFLOW${wfLive === 1 ? "" : "S"}` : "", 18)),
        ctxPct >= 0 ? fg(C.dim, "CTX ") + gauge(ctxPct, 16, toneFor(ctxPct)) + " " + fg(toneFor(ctxPct), fit(`${Math.round(ctxPct)}%`, 5)) : "",
        fg(C.dim, fit(`CPU ${Math.round(use.cpu)}%  ·  ${gb(use.rss * 1024)}`, 28)),
        fg(C.dim, fit(`${human(sum(cardBuckets))} tool calls / ${opt.windowMin}m`, 28)),
      ].filter(Boolean);
      for (let r = 0; r < chartH; r++) out.push(tint(band + chart[r] + "   " + (side[r] ?? ""), 0));
      if (H > 4) out.push("");
      while (out.length < top + H) out.push("");
      out.length = top + H;
    }
    if (shown.length > cards.length) out.push(fg(C.dim, `   … ${shown.length - cards.length} more session${shown.length - cards.length === 1 ? "" : "s"} not shown (screen full)`));
  }

  const agentRow = (a: Agent, prefix: string, stalled = false): string => {
    const st = stateOf(a, now);
    const quietFor = now - Math.max(a.tail.lastT, a.tail.mtime);
    const dot = stalled ? fg(C.red, "◐") : st === "active" ? spin : st === "tool" ? fg(C.yellow, "●") : st === "done" ? fg(C.dim, "✓") : fg(C.dim, "○");
    const pending = a.tail.lastTool && a.tail.lastTool.t > a.tail.lastResultT ? a.tail.lastTool : undefined;
    const doing =
      st === "done" ? "finished" : pending ? `${pending.name}${pending.hint ? ": " + pending.hint : ""}` : st === "quiet" ? (a.id === "main" ? "waiting" : "no activity") : "thinking";
    const labelW = W - width(prefix) - 2 - (META ? META + 2 : 0) - S - 2 - (ACT ? ACT + 2 : 0) - 6 - 1;
    const b = buckets([a.tail.tools], now, S);
    const tone = st === "done" ? C.dim : st === "quiet" ? C.dim : C.text;
    return (
      fg(C.faint, prefix) +
      dot +
      " " +
      fg(tone, fit(a.label, labelW)) +
      (META ? "  " + fg(C.dim, fit([shortType(a.type), a.model].filter(Boolean).join(" · "), META)) : "") +
      "  " +
      spark(b, agentMax, [38, 86, 110], [96, 214, 226]) +
      (ACT ? "  " + fg(stalled ? C.red : st === "tool" ? C.yellow : C.dim, fit((stalled ? "stalled? " : "") + doing, ACT)) : "") +
      " " +
      fg(stalled ? C.red : st === "active" ? C.green : C.dim, fit(st === "active" ? "live" : ago(quietFor), 6, "r"))
    );
  };

  views.forEach((v, vi) => {
    const s = v.s;
    const tailsHere = sessionTails(s);
    const b = buckets(tailsHere.map((t) => t.tools), now, S);
    const branch = s.mains.map((m) => m.branch).find(Boolean);
    const home = os.homedir();
    const where = s.cwd.replace(home, "~").split("/").slice(-2).join("/") + (branch && branch !== "HEAD" ? ` ⎇ ${branch}` : "");
    const busyNow = s.status === "busy";
    const stalled = v.state === "stalled";
    const dot = v.facts.needs ? fg(C.yellow, "▲") : stalled ? fg(C.red, "◐") : busyNow ? fg(C.green, "●") : fg(C.dim, "○");
    const f = v.facts;
    const wide = W >= 120;
    const use = treeUsage(s.pid);
    const ctxNow = f.main?.ctx;
    const ctxPct = ctxNow ? Math.min(100, (ctxNow.used / ctxMax(ctxNow)) * 100) : -1;
    const right =
      fg(C.text, fit(human(sum(b)) + " tools", 10, "r")) +
      "  " +
      fg(C.text, fit(human(tokensIn(tailsHere, win)) + " out", 8, "r")) +
      (wide ? "  " + fg(ctxPct >= 0 ? toneFor(ctxPct) : C.dim, fit(ctxPct >= 0 ? `ctx ${Math.round(ctxPct)}%` : "", 8, "r")) + "  " + fg(use.cpu >= 100 ? C.yellow : C.dim, fit(use.cpu >= 1 ? `cpu ${Math.round(use.cpu)}%` : "", 9, "r")) : "");
    const rightW = 10 + 2 + 8 + (wide ? 2 + 8 + 2 + 9 : 0);
    const quiet = now - Math.max(f.main?.lastT ?? 0, f.main?.mtime ?? 0);
    const status = f.needs ? `⚠ NEEDS YOU${f.main ? " · " + ago(quiet) : ""}` : stalled ? `stalled? · ${ago(now - v.stall.since)}` : f.yourTurn ? `your turn · ${ago(now - (f.main?.say?.t ?? now))}` : `${s.job?.state === "working" ? "working" : s.status || "?"} · up ${ago(now - s.startedAt)}`;
    const statusTone = f.needs ? C.yellow : stalled ? C.red : f.yourTurn ? C.purple : busyNow ? C.green : C.dim;
    const idW = 13;
    const statusW = 19;
    // The place column appears only where the name keeps 18 cells beside it (it used to squeeze the name to 2 at 130 columns).
    const nameRoom = W - 3 - idW - 2 - statusW - 2 - S - 2 - rightW - 1;
    const whereW = W >= 160 ? 34 : nameRoom - 24 >= 18 ? 22 : 0;
    const nameW = nameRoom - (whereW ? whereW + 2 : 0);
    hits.push({ row: out.length + 1, x0: 1, x1: W, act: "focus:" + s.sid });
    out.push(
      " " +
        dot +
        " " +
        fg(busyNow ? C.white : C.text, bold(fit(s.name, nameW))) +
        "  " +
        fg(C.dim, fit(`${s.kind || "cli"} ${s.sid.slice(0, 8)}`, idW)) +
        (whereW ? "  " + fg(C.blue, fit(where, whereW)) : "") +
        "  " +
        (f.needs || stalled ? bold(fg(statusTone, fit(status, statusW))) : fg(statusTone, fit(status, statusW))) +
        "  " +
        spark(b, sessionMax, [52, 84, 150], [150, 200, 255]) +
        right +
        " ",
    );

    // Children: tasks line, workflow groups, standalone agents, finished summary.
    type Child = { kind: "needs" } | { kind: "ctx" } | { kind: "now" } | { kind: "you" } | { kind: "claude"; i: number } | { kind: "tasks" } | { kind: "wf"; g: Group } | { kind: "agent"; a: Agent } | { kind: "more"; n: number } | { kind: "done"; n: number };
    const children: Child[] = [];
    if (v.showNeeds) children.push({ kind: "needs" });
    if (v.showCtx) children.push({ kind: "ctx" });
    if (v.showNow) children.push({ kind: "now" });
    // The last prompt and Claude's recent messages, in the order they happened.
    const talk: { t: number; child: Child }[] = [];
    if (v.showTalk > 1 || (v.showTalk > 0 && !v.msgs.length)) talk.push({ t: f.main?.ask?.t ?? 0, child: { kind: "you" } });
    if (v.showTalk > 0) v.msgs.forEach((msg, i) => (v.alloc[i] ?? 0) > 0 && talk.push({ t: msg.t, child: { kind: "claude", i } }));
    talk.sort((a, b) => a.t - b.t);
    for (const item of talk) children.push(item.child);
    if (v.showTasks) children.push({ kind: "tasks" });
    const main = f.main;
    if (v.showMain && main) children.push({ kind: "agent", a: { id: "main", label: "main thread", type: "", model: "", tail: main, done: false } });
    const isStalled = (a: Agent) => v.stall.threads.includes(a.id);
    for (const g of v.groups) {
      if (g.wf) children.push({ kind: "wf", g });
      else {
        for (const a of g.rows) children.push({ kind: "agent", a });
        if (g.hidden) children.push({ kind: "more", n: g.hidden });
      }
    }
    if (v.doneCount) children.push({ kind: "done", n: v.doneCount });

    children.forEach((c, ci) => {
      const last = ci === children.length - 1;
      const elbow = last ? "   └─ " : "   ├─ ";
      const stem = last ? "      " : "   │  ";
      const rest = W - width(elbow) - 1;
      if (c.kind === "needs") {
        out.push(fg(C.faint, elbow) + bold(fg(C.yellow, "? needs you ▸ ")) + fg(C.white, fit(f.needs, rest - 14)));
      } else if (c.kind === "ctx") {
        const ctx = f.main!.ctx!;
        const max = ctxMax(ctx);
        const pct = Math.min(1, ctx.used / max);
        const tone = pct >= 0.8 ? C.red : pct >= 0.5 ? C.yellow : C.green;
        const split = contextSplit(f.main!);
        const BW = W >= 140 ? 32 : 20;
        const label = fit(`${Math.round(pct * 100)}% · ${human(ctx.used)} of ${human(max)}`, 19);
        let legend = "";
        // Runway: say when the window will be full, but only when that is within the hour.
        const runway = sessionRunway(f.main, now);
        const runwayText = runway === undefined ? "" : fullInText(runway);
        let room = rest - 8 - BW - 1 - 19 - 1 - (runwayText ? width(runwayText) + 2 : 0);
        const approx = f.main!.parts ? "≈" : "";
        for (const part of [...split].filter((x) => x.tokens > 0).sort((x, y) => y.tokens - x.tokens)) {
          const item = `${part.name} ${approx}${human(part.tokens)}`;
          if (width(item) + 4 > room) break;
          legend += " " + fg(part.color, "●") + " " + fg(C.dim, item) + " ";
          room -= width(item) + 4;
        }
        out.push(fg(C.faint, elbow) + fg(C.dim, "context ") + stacked(split, max, BW) + " " + fg(tone, label) + legend + (runwayText ? "  " + bold(fg(runwayTone(runway!), runwayText)) : ""));
      } else if (c.kind === "now") {
        out.push(fg(C.faint, elbow) + fg(C.dim, "now    ▸ ") + fg(C.text, fit(f.now, rest - 9)));
      } else if (c.kind === "you") {
        const text = clean(f.main?.ask?.text || f.main?.lastPrompt || "");
        const when = f.main?.ask ? ago(now - f.main.ask.t) : "";
        out.push(fg(C.faint, elbow) + fg(C.blue, "you    ▸ ") + fg(C.text, fit(text, rest - 9 - 7)) + " " + fg(C.dim, fit(when, 6, "r")));
      } else if (c.kind === "claude") {
        const msg = v.msgs[c.i];
        const latest = c.i === 0;
        const shown = msg.lines.slice(0, v.alloc[c.i]);
        if (msg.lines.length > shown.length) shown[shown.length - 1] = fit(shown[shown.length - 1], Math.max(1, sayW - 2)).trimEnd() + " …";
        shown.forEach((line, li) => {
          if (li === 0)
            out.push(
              fg(C.faint, elbow) + fg(latest ? C.cyan : mix(C.cyan, C.faint, 0.55), "claude ▸ ") + fg(latest ? C.text : C.dim, fit(line, rest - 9 - 7)) + " " + fg(C.dim, fit(ago(now - msg.t), 6, "r")),
            );
          else out.push(fg(C.faint, stem) + " ".repeat(9) + fg(C.dim, fit(line, rest - 9)));
        });
      } else if (c.kind === "tasks") {
        const t = s.tasks!;
        out.push(
          fg(C.faint, elbow) +
            fg(C.dim, "tasks ") +
            pips(t.done, t.doing, t.total, Math.min(PW, t.total), C.purple) +
            fg(C.text, ` ${t.done}/${t.total}`) +
            (t.active ? fg(C.dim, "  ▸ ") + fg(C.text, fit(t.active, Math.max(0, W - 30 - PW))) : ""),
        );
      } else if (c.kind === "agent") {
        out.push(agentRow(c.a, elbow, isStalled(c.a)));
      } else if (c.kind === "more") {
        out.push(fg(C.faint, elbow) + fg(C.dim, `… ${c.n} more agent${c.n === 1 ? "" : "s"} (screen full)`));
      } else if (c.kind === "done") {
        out.push(fg(C.faint, elbow) + fg(C.dim, `✓ ${c.n} agent${c.n === 1 ? "" : "s"} finished in the last ${opt.windowMin}m  (d to list)`));
      } else {
        const wf = c.g.wf!;
        const total = wf.agents.length;
        const finished = wf.agents.filter((a) => a.done).length;
        const live = wf.status === "running";
        const wb = buckets(wf.agents.map((a) => a.tail.tools), now, S);
        const phaseIdx = wf.phases.indexOf(wf.phase);
        const phase = wf.phase ? (phaseIdx >= 0 ? `phase ${phaseIdx + 1}/${wf.phases.length} ${wf.phase}` : `phase ${wf.phase}`) : "";
        const statusC = live ? C.green : wf.status === "completed" ? C.dim : C.red;
        const tail =
          `${fit(live ? "up " + ago(now - wf.started) : wf.status, 10, "r")}` + (wf.tokens !== undefined ? `  ${fit(human(wf.tokens) + " tok", 9, "r")}` : " ".repeat(11));
        // On a narrow screen the phase column gives way before the name does.
        const slack = W - width(elbow) - PW - S - width(tail) - 17;
        const phaseW = slack - 10 < 6 ? 0 : Math.min(28, slack - 10);
        const nameW2 = Math.max(10, slack - phaseW);
        out.push(
          fg(C.faint, elbow) +
            fg(C.purple, "⚙ ") +
            fg(live ? C.white : C.text, fit(wf.name, nameW2)) +
            "  " +
            fg(C.dim, fit(phase, phaseW)) +
            " " +
            pips(finished, live ? total - finished : 0, total, PW, C.purple) +
            " " +
            fg(C.text, fit(`${finished}/${total}`, 7)) +
            " " +
            spark(wb, Math.max(agentMax, ...wb), [90, 70, 140], [200, 165, 255]) +
            " " +
            fg(statusC, tail),
        );
        c.g.rows.forEach((a, ai) => {
          const lastA = ai === c.g.rows.length - 1 && !c.g.hidden;
          out.push(agentRow(a, stem + (lastA ? "└─ " : "├─ "), isStalled(a)));
        });
        if (c.g.hidden) out.push(fg(C.faint, stem + "└─ ") + fg(C.dim, `… ${c.g.hidden} more agent${c.g.hidden === 1 ? "" : "s"} (screen full)`));
      }
    });
    if (gaps && vi < views.length - 1) out.push("");
  });

  if (cut) out.push(fg(C.dim, `   … ${cut} more session${cut === 1 ? "" : "s"} not shown (screen full)`));

  if (hidden.length) {
    while (out.length < rows - 2) out.push("");
    out.length = rows - 2;
    const names = hidden.map((v) => v.s.name).join(", ");
    out.push(
      fg(C.dim, fit(focusSid ? `   focused on one session  ·  esc or click it again to return  ·  ${hidden.length} other${hidden.length === 1 ? "" : "s"} hidden` : `   ○ ${hidden.length} idle or finished session${hidden.length === 1 ? "" : "s"} hidden (a shows): ${names}`, W)),
    );
  }
  while (out.length < rows - 1) out.push("");
  out.length = rows - 1;
  out.push(buttonBar(W, rows, all.filter(isHidden).length));
  return out;
}

/** The bottom row: every control, clickable, with its key. */
export function buttonBar(W: number, row: number, idle = 0): string {
  const build = (short: boolean) => {
    const found: typeof hits = [];
    let x = 2;
    let line = " ";
    const add = (label: string, act: string, on = false) => {
      const text = ` ${label} `;
      found.push({ row, x0: x, x1: x + width(text) - 1, act });
      line += on ? `\x1b[48;2;86;205;214m\x1b[38;2;12;16;20m${bold(text)}\x1b[39m\x1b[49m` : `\x1b[48;2;40;45;54m${fg(C.text, text)}\x1b[49m`;
      line += " ";
      x += width(text) + 1;
    };
    const plain = (text: string) => {
      line += fg(C.dim, text);
      x += width(text);
    };
    add(short ? "1" : "1 Detail", "mode:detail", opt.mode === "detail");
    add(short ? "2" : "2 Compact", "mode:compact", opt.mode === "compact");
    add(short ? "3" : "3 Far", "mode:far", opt.mode === "far");
    plain(" ");
    add("−", "win-");
    plain(`${opt.windowMin}m `);
    add("+", "win+");
    plain(" ");
    add(short ? "a" : idle ? `a All · ${idle} idle` : "a All", "all", opt.showAll);
    add(short ? "d" : "d Finished agents", "done", opt.showDone);
    add(short ? "b" : "b Bell", "bell", opt.bell);
    if (opt.usage && usage.reason) add(short ? "u" : "u Retry usage", "usage");
    add(short ? "space" : newCount() ? `space Seen · ${newCount()} new` : "space Seen", "seen");
    plain(" ");
    add(short ? "q" : "q Quit", "quit");
    return { line, used: x, found };
  };
  let bar = build(false);
  if (bar.used > W) bar = build(true);
  hits.push(...bar.found);
  const hint = "click a session to focus it";
  return bar.line + (W - bar.used > width(hint) + 2 ? fg(C.faint, fit(hint, W - bar.used, "r")) : "");
}

// ───────────────────────── main loop ─────────────────────────

let sessions: Session[] = [];
const needing = new Set<string>();
const stalledNow = new Map<string, number>();
function refresh() {
  const now = clock();
  sessions = scan(now);
  prune(now);
  sampleMachine();
  if (opt.usage && !opt.once) tickUsage(now); // --once has already made its one read
  // Ring once when a session starts waiting on the person, and once for each thing that newly stalls.
  const facts = sessions.map((s) => ({ s, f: factsOf(s) }));
  const rings = newSince(needing, facts.filter((x) => x.f.needs).map((x) => x.s.sid)).length + newStalls(stalledNow, facts.flatMap((x) => stallMarks(x.s, x.f, stallOf(x.s, x.f, now)))).length;
  if (opt.bell && !opt.once) process.stdout.write("\x07".repeat(rings));
  noteScan(sessions, now);
}

if (import.meta.main) {
  const command = parseArgs(process.argv.slice(2));
  if (command) {
    process.stdout.write(command === "help" ? HELP : glyphCard());
    process.exit(0);
  }

  seen.at = Number(process.env.FLEET_SEEN) || clock(); // FLEET_SEEN (test only) starts the mark in the past
  if (opt.once) {
    sampleMachine();
    if (opt.usage) await fetchUsage();
    if (!fixtureMachine()) await new Promise((r) => setTimeout(r, 300)); // a second CPU sample, so the gauge is a rate
    refresh();
    const cols = Number(process.env.COLUMNS) || process.stdout.columns || 140;
    const rows = Number(process.env.LINES) || process.stdout.rows || 45;
    process.stdout.write(render(sessions, cols, rows, clock()).join("\n") + "\n");
    process.exit(0);
  }

  const out = process.stdout;
  const draw = () => {
    const lines = render(sessions, out.columns || 140, out.rows || 45, clock());
    out.write("\x1b[H" + lines.map((l) => l + "\x1b[K").join("\n"));
  };
  /** The tab title follows the fleet's state. It is written only when it changes, and cleared on the way out. */
  const retitle = () => out.write(titleChange(titleFor(fleetCounts(sessions, clock()))));
  const restore = () => {
    out.write(titleSequence("") + (opt.mouse ? "\x1b[?1000l\x1b[?1006l" : "") + "\x1b[?25h\x1b[?1049l");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  };
  const quit = () => {
    restore();
    process.exit(0);
  };

  /** Every control, whether it came from a key or a click. */
  const act = (name: string) => {
    const i = WINDOWS.indexOf(opt.windowMin);
    if (name === "quit") return quit();
    if (name.startsWith("mode:")) opt.mode = name.slice(5) as Mode;
    else if (name === "win+") opt.windowMin = WINDOWS[Math.min(WINDOWS.length - 1, (i < 0 ? 2 : i) + 1)];
    else if (name === "win-") opt.windowMin = WINDOWS[Math.max(0, (i < 0 ? 2 : i) - 1)];
    else if (name === "done") opt.showDone = !opt.showDone;
    else if (name === "all") opt.showAll = !opt.showAll;
    else if (name === "bell") opt.bell = !opt.bell;
    else if (name === "seen") markSeen(clock());
    else if (name === "usage") {
      if (opt.usage) void fetchUsage().then(draw); // retry now, whatever the next try was set to
    } else if (name.startsWith("focus:")) focusSid = focusSid === name.slice(6) ? null : name.slice(6);
    else if (name === "next") {
      const ids = sessions.map((s) => s.sid);
      const at = focusSid ? ids.indexOf(focusSid) : -1;
      focusSid = at + 1 < ids.length ? ids[at + 1] : null;
    } else if (name === "back") {
      if (!focusSid) return quit();
      focusSid = null;
    }
    out.write("\x1b[2J");
    draw();
  };

  out.write("\x1b[?1049h\x1b[?25l\x1b[2J" + (opt.mouse ? "\x1b[?1000h\x1b[?1006h" : ""));
  refresh();
  retitle();
  draw();
  setInterval(() => {
    frame++;
    if (frame % 2 === 0) {
      refresh();
      retitle();
    }
    draw();
  }, 1000);
  out.on("resize", () => {
    out.write("\x1b[2J");
    draw();
  });
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  process.on("SIGHUP", quit);

  const KEYS: Record<string, string> = {
    q: "quit", "\x03": "quit", "\x1b": "back", "\t": "next",
    "1": "mode:detail", "2": "mode:compact", "3": "mode:far",
    "+": "win+", "=": "win+", "-": "win-", _: "win-",
    d: "done", a: "all", b: "bell", u: "usage", " ": "seen",
  };
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (d: Buffer) => {
      const k = d.toString();
      // A left click, as the terminal reports it: ESC [ < button ; column ; row M
      for (const m of k.matchAll(/\x1b\[<(\d+);(\d+);(\d+)M/g)) {
        if (m[1] !== "0") continue;
        const hit = hits.find((h) => h.row === +m[3] && +m[2] >= h.x0 && +m[2] <= h.x1);
        if (hit) return act(hit.act);
      }
      if (KEYS[k]) act(KEYS[k]);
    });
  }
}
