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

const CLAUDE = process.env.FLEET_HOME || process.env.AGENT_FLEET_HOME || path.join(os.homedir(), ".claude"); // the demo points this at made-up sessions
/** The time. FLEET_NOW (test only) pins it, in milliseconds since 1970, so a frame can be reproduced exactly. */
export const clock = (): number => Number(process.env.FLEET_NOW) || Date.now();
const HIDE_TOP = process.env.FLEET_HIDE_PROCESSES === "1"; // leave other programs' names off the machine row
const PROJECTS = path.join(CLAUDE, "projects");
export const WINDOWS = [5, 15, 30, 60, 180];
const TAIL_BYTES = 2 * 1024 * 1024;
const ACTIVE_MS = 60_000;
const FINAL_TOOLS = new Set(["SubagentHandback", "StructuredOutput"]);

// ───────────────────────── options ─────────────────────────

const HELP = `Claude Fleet: every live Claude Code session on one screen.

Usage: bun fleet.ts [minutes] [options]

  minutes        width of the sparkline window (default 30)
  --mode <m>     detail (default), compact, or far (big, readable from a distance)
  --all          also show idle and finished sessions
  --usage        show your Claude account usage limits (reads the stored Claude
                 Code login and asks api.anthropic.com every five minutes)
  --bell         ring the terminal bell when a session starts waiting on you
  --no-mouse     do not capture mouse clicks
  --once         print one frame and exit
  --glyphs       print a test card of every glyph the screen uses, to check that
                 your terminal draws each one a single cell wide, and exit
  --plain-glyphs use fallbacks for glyphs some fonts lack (≡ ┿ ╌ ◇)

Keys: 1 2 3 view mode · + - window · a all sessions · d finished agents
      tab focus next session · b bell · u retry the usage read
      esc leave focus · q quit
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
};

/** Read the command line into `opt`. Returns the one-shot command it asked for, if any. */
export function parseArgs(argv: string[]): "help" | "glyphs" | undefined {
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  setPlainGlyphs(argv.includes("--plain-glyphs"));
  if (argv.includes("--glyphs")) return "glyphs";
  const TAKES_VALUE = ["--mode"];
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
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
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
 * full-width Latin becomes plain Latin; any other double-width character becomes "?". Line breaks stay.
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
    else if (hasEmojiForm(cp) || ZERO_WIDTH.test(ch)) continue;
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

/** Word-wrap plain text to `w` display columns. */
export function wrap(text: string, w: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (let word of text.split(" ")) {
    while (width(word) > w) {
      if (cur) lines.push(cur), (cur = "");
      let head = "";
      for (const ch of word) {
        if (width(head + ch) > w) break;
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
  railThin: { g: "▌", is: "state rail on body rows; half a cell of context" },
  gaugeFill: { g: "━", is: "gauge: filled" },
  gaugeTrack: { g: "─", is: "gauge: remaining; rules" },
  gaugeNone: { g: "╌", plain: "─", is: "gauge: no reading" },
  pace: { g: "┼", is: "pace tick on the empty track" },
  paceFilled: { g: "┿", plain: "┼", is: "pace tick inside the filled part" },
  ctxFull: { g: "█", is: "context window: a full cell" },
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

/**
 * One screen row as cells, so text can be put at the columns grid() gives instead of being padded into
 * place. Columns count from 1. Later text overwrites earlier text; anything past the last column is dropped.
 */
export class Row {
  private cell: { ch: string; color?: RGB; bold?: boolean; raw?: boolean }[];
  private bg: (RGB | undefined)[];
  constructor(public W: number, bg?: RGB) {
    this.cell = Array.from({ length: W }, () => ({ ch: " " }));
    this.bg = new Array(W).fill(bg);
  }
  /** Put plain text starting at `col`. Returns the column after it. */
  put(col: number, text: string, color: RGB = C.text, isBold = false): number {
    for (const ch of text) {
      const w = charWidth(ch.codePointAt(0)!);
      if (w === 0) continue;
      if (col >= 1 && col + w - 1 <= this.W) {
        this.cell[col - 1] = { ch, color, bold: isBold };
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
      this.cell[col - 1] = { ch: ansi, raw: true };
      for (let i = 1; i < w; i++) this.cell[col - 1 + i] = { ch: "" };
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
    let out = "";
    let last = this.W;
    while (last > 0 && this.cell[last - 1].ch === " " && !this.bg[last - 1]) last--; // nothing to draw past here
    let bg: RGB | undefined;
    for (let i = 0; i < last; ) {
      const c = this.cell[i];
      if (this.bg[i] !== bg) {
        bg = this.bg[i];
        out += bg ? `\x1b[48;2;${bg[0]};${bg[1]};${bg[2]}m` : "\x1b[49m";
      }
      if (c.raw || c.ch === "") {
        out += c.ch;
        i++;
        continue;
      }
      // Gather the run of cells that share a style and a background.
      let run = "";
      let j = i;
      for (; j < last; j++) {
        const d = this.cell[j];
        if (d.raw || d.ch === "" || d.color !== c.color || !!d.bold !== !!c.bold || this.bg[j] !== bg) break;
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
  summary?: string; // the session's own "while you were away" summary
  summaryT?: number; // when it was written, so it can be compared with the last prompt
  ctx?: { used: number; model: string; req: string };
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
        }
      if (u) {
        const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        if (used > 0) t.ctx = { used, model: String(o.message?.model ?? ""), req: String(o.requestedModel ?? "") };
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
const alive = (pid: number) => {
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

let projectDirs: string[] = [];
let projectDirsAt = 0;
const sessionDirCache = new Map<string, { at: number; dirs: string[]; mains: string[] }>();
function locate(sid: string, now: number) {
  const hit = sessionDirCache.get(sid);
  if (hit && now - hit.at < 20_000) return hit;
  if (now - projectDirsAt > 20_000) {
    projectDirs = ls(PROJECTS).map((d) => path.join(PROJECTS, d));
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

export function sampleMachine() {
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
      const proc = { pid: +m[1], ppid: +m[2], cpu: +m[3], rss: +m[4], name: path.basename(m[5].trim()) };
      procs.push(proc);
      if (!kids.has(proc.ppid)) kids.set(proc.ppid, []);
      kids.get(proc.ppid)!.push(proc);
    }
    machine.procs = procs;
    machine.kids = kids;
  } catch {}
}

/** CPU and memory of a process and everything it started. */
export function treeUsage(pid: number): { cpu: number; rss: number } {
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
  return { cpu, rss };
}

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
  const top = [...machine.procs].sort((a, b) => b.cpu - a.cpu).slice(0, 4).filter((p) => p.cpu >= 5);
  const topText = top.map((p) => `${p.name.slice(0, 18)} ${Math.round(p.cpu)}%`).join(" · ");
  if (!HIDE_TOP && topText && W - usedW - 9 > 16) line += fg(C.dim, "   top ") + fg(C.text, fit(topText, W - usedW - 8));
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
  if (reason === REASON.keychainRemote) return "run: security unlock-keychain ~/Library/Keychains/login.keychain-db   (or start fleet in a tmux begun on the Mac itself)";
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
  if (Object.keys(env).some((k) => k.startsWith("MOSH_"))) return true;
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
      const parsed = r.status === 0 ? parseLogin(r.stdout ?? "") : { parse: "empty" as LoginParse };
      const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || (r.status === null && r.signal === "SIGTERM");
      k = { status: r.error && !timedOut ? 127 : r.status, stderr: String(r.stderr ?? ""), timedOut, parse: parsed.parse };
      fromKeychain = parsed.login;
    } catch {}
  }
  let f: FileOutcome = "missing";
  let fromFile: Login | undefined;
  if (!fromKeychain) {
    try {
      const parsed = parseLogin(fs.readFileSync(path.join(CLAUDE, ".credentials.json"), "utf8"));
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
  if (reason === REASON.keychainSilent) return USAGE_EVERY_MS; // each try freezes the screen for five seconds, so do not hurry
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
  const day = `${new Date(resetsAt).toLocaleDateString("en-GB", { weekday: "short" })} ${hhmm(resetsAt)}`;
  return form === "long" ? `resets ${day}` : day;
}

/** One limit window, ready to draw: its label, how full it is, and when it resets. */
export interface LimitView {
  key: string; // Anthropic's name: five_hour, seven_day, seven_day_opus, seven_day_sonnet
  label: string; // "5h", "7d", "opus", "sonnet"
  pct: number;
  resetsAt: number; // 0 when unknown
  windowMs: number;
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
export function accountViewOf(state: UsageState, u: { nextTry: number; busy: boolean }): AccountView {
  const reason = state.kind === "current" ? state.failing : state.reason;
  const view: AccountView = { kind: state.kind, limits: [], asOf: state.kind === "none" ? 0 : state.asOf, reason, remedy: usageRemedy(reason), nextTry: u.nextTry, busy: u.busy };
  if (state.kind === "none") return view;
  for (const [key, label, windowMs] of LIMITS) {
    const w = state.data[key] as UsageWindow | undefined;
    if (!w || typeof w.utilization !== "number") continue;
    view.limits.push({ key, label, pct: w.utilization, resetsAt: w.resets_at ? Date.parse(w.resets_at) || 0 : 0, windowMs });
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
export const accountView = (now: number): AccountView => accountViewOf(usageState(now), usage);

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
  const tail: [string, RGB][] = [];
  if (a.extra && W >= 120) tail.push(["   extra usage ", C.dim], a.extra.enabled ? [`${a.extra.used} of ${a.extra.limit}`, stale ? C.dim : C.text] : ["off", C.dim]);
  if (stale || a.reason) tail.push([`   (${stale ? `as of ${hhmm(a.asOf)}` : "shared figures"}${a.reason ? " · " + a.reason : ""})`, C.dim]);
  for (const [text, color] of tail) {
    if (used + width(text) > W - 1) break;
    line += fg(color, text);
    used += width(text);
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
const PARTS: { key: PartKey | "messages"; name: string; color: RGB }[] = [
  { key: "system", name: "System prompt", color: [120, 120, 120] },
  { key: "tools", name: "System tools", color: [168, 168, 168] },
  { key: "mcp", name: "MCP tools", color: [0, 204, 204] },
  { key: "agents", name: "Agents", color: [78, 186, 101] },
  { key: "memory", name: "Memory files", color: [215, 119, 87] },
  { key: "skills", name: "Skills", color: [255, 193, 7] },
  { key: "messages", name: "Messages", color: [177, 185, 249] },
];
const CHARS_PER_TOKEN = 3.8;
/** Split the window's fill by category. Everything but Messages is sized from text length, so it is approximate. */
export function contextSplit(t: Tail): { name: string; tokens: number; color: RGB }[] {
  if (!t.ctx) return [];
  if (!t.parts) return [{ name: "Used", tokens: t.ctx.used, color: PARTS[6].color }];
  let fixed = 0;
  const out = PARTS.filter((p) => p.key !== "messages").map((p) => {
    const tokens = Math.round((t.parts![p.key as PartKey] ?? 0) / CHARS_PER_TOKEN);
    fixed += tokens;
    return { name: p.name, tokens, color: p.color };
  });
  if (fixed > t.ctx.used) {
    const k = t.ctx.used / fixed;
    for (const o of out) o.tokens = Math.round(o.tokens * k);
    fixed = t.ctx.used;
  }
  out.push({ name: "Messages", tokens: t.ctx.used - fixed, color: PARTS[6].color });
  return out;
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
  lastT: number;
}

export function buildViews(sessions: Session[], now: number, sayWidth: number, since = now - opt.windowMin * 60_000): View[] {
  const recent = (a: Agent) => Math.max(a.tail.lastT, a.tail.mtime) >= since;
  const order: Record<AgentState, number> = { active: 0, tool: 1, quiet: 2, done: 3 };
  const pick = (list: Agent[]) =>
    list
      .filter((a) => recent(a) && (opt.showDone || !a.done))
      .sort((a, b) => order[stateOf(a, now)] - order[stateOf(b, now)] || a.tail.birth - b.tail.birth);

  return sessions
    .map((s) => {
      const groups: Group[] = [];
      for (const wf of s.workflows) {
        const live = wf.status === "running" && wf.lastT >= since;
        const justFinished = wf.status !== "running" && Math.max(wf.finished, wf.lastT) >= since;
        if (live || justFinished) groups.push({ wf, rows: pick(wf.agents), hidden: 0 });
      }
      groups.sort((a, b) => a.wf!.started - b.wf!.started);
      const solo = pick(s.agents);
      if (solo.length) groups.push({ rows: solo, hidden: 0 });
      const doneCount = opt.showDone ? 0 : s.agents.filter((a) => a.done && recent(a)).length;
      const lastT = Math.max(0, ...s.mains.map((m) => m.mtime), ...s.agents.map((a) => a.tail.mtime));
      const facts = factsOf(s);
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
        state: sessionState(facts),
        lastT,
      };
    })
    .sort(byState);
}

/** Sessions nobody needs to look at: finished background jobs, and idle sessions with nothing running under them. */
export function isHidden(v: View): boolean {
  if (v.facts.needs) return false;
  if (v.s.job) return v.s.job.state === "done";
  const liveChildren = v.groups.some((g) => (g.wf && g.wf.status === "running") || g.rows.some((a) => !a.done));
  return v.s.status !== "busy" && !liveChildren;
}

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
  if (opt.usage) out.push(usageRow(W, now));
  out.push(fg(C.faint, " " + "─".repeat(W - 2)));

  if (!shown.length) {
    out.push("", fg(C.dim, all.length ? "   Nothing active and nothing waiting on you." : "   No live Claude Code sessions found in ~/.claude/sessions."));
  }

  const avail = rows - out.length - 2 - (hidden.length ? 1 : 0);
  const { views, gaps, cut } = opt.mode === "far" ? { views: [] as View[], gaps: false, cut: 0 } : fitViews(shown, avail);

  // Shared scales so rows are comparable with each other.
  const agentMax = Math.max(1, ...views.flatMap((v) => v.groups.flatMap((g) => g.rows.map((a) => Math.max(...buckets([a.tail.tools], now, S))))));
  const sessionTails = (s: Session) => [...s.mains, ...s.agents.map((a) => a.tail), ...s.workflows.flatMap((w) => w.agents.map((a) => a.tail))];
  const sessionMax = Math.max(1, ...views.map((v) => Math.max(...buckets(sessionTails(v.s).map((t) => t.tools), now, S))));

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
      const tone = f.needs ? C.yellow : f.yourTurn ? C.purple : busyNow ? C.green : C.dim;
      const bandTone = f.needs && frame % 2 ? mix(C.yellow, C.faint, 0.6) : tone;
      const band = " " + fg(bandTone, "██") + " ";
      const tint = (line: string, w: number) => (f.needs ? `\x1b[48;2;52;38;0m${line}${" ".repeat(Math.max(0, w))}\x1b[49m` : line);
      const state = f.needs ? "NEEDS YOU" : f.yourTurn ? "YOUR TURN" : s.job?.state === "working" || busyNow ? "WORKING" : "IDLE";
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

  const agentRow = (a: Agent, prefix: string): string => {
    const st = stateOf(a, now);
    const quietFor = now - Math.max(a.tail.lastT, a.tail.mtime);
    const dot = st === "active" ? spin : st === "tool" ? fg(C.yellow, "●") : st === "done" ? fg(C.dim, "✓") : fg(C.dim, "○");
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
      (ACT ? "  " + fg(st === "tool" ? C.yellow : C.dim, fit(doing, ACT)) : "") +
      " " +
      fg(st === "active" ? C.green : C.dim, fit(st === "active" ? "live" : ago(quietFor), 6, "r"))
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
    const dot = v.facts.needs ? fg(C.yellow, "▲") : busyNow ? fg(C.green, "●") : fg(C.dim, "○");
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
    const status = f.needs ? `⚠ NEEDS YOU${f.main ? " · " + ago(quiet) : ""}` : f.yourTurn ? `your turn · ${ago(now - (f.main?.say?.t ?? now))}` : `${s.job?.state === "working" ? "working" : s.status || "?"} · up ${ago(now - s.startedAt)}`;
    const statusTone = f.needs ? C.yellow : f.yourTurn ? C.purple : busyNow ? C.green : C.dim;
    const idW = 13;
    const whereW = W >= 160 ? 34 : W >= 125 ? 22 : 0;
    const statusW = 19;
    const nameW = W - 3 - idW - 2 - (whereW ? whereW + 2 : 0) - statusW - 2 - S - 2 - rightW - 1;
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
        (f.needs ? bold(fg(statusTone, fit(status, statusW))) : fg(statusTone, fit(status, statusW))) +
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
        let room = rest - 8 - BW - 1 - 19 - 1;
        const approx = f.main!.parts ? "≈" : "";
        for (const part of [...split].filter((x) => x.tokens > 0).sort((x, y) => y.tokens - x.tokens)) {
          const item = `${part.name} ${approx}${human(part.tokens)}`;
          if (width(item) + 4 > room) break;
          legend += " " + fg(part.color, "●") + " " + fg(C.dim, item) + " ";
          room -= width(item) + 4;
        }
        out.push(fg(C.faint, elbow) + fg(C.dim, "context ") + stacked(split, max, BW) + " " + fg(tone, label) + legend);
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
        out.push(agentRow(c.a, elbow));
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
          out.push(agentRow(a, stem + (lastA ? "└─ " : "├─ ")));
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
  out.push(buttonBar(W, rows));
  return out;
}

/** The bottom row: every control, clickable, with its key. */
export function buttonBar(W: number, row: number): string {
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
    add(short ? "a" : "a All sessions", "all", opt.showAll);
    add(short ? "d" : "d Finished agents", "done", opt.showDone);
    add(short ? "b" : "b Bell", "bell", opt.bell);
    if (opt.usage && usage.reason) add(short ? "u" : "u Retry usage", "usage");
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
function refresh() {
  const now = clock();
  sessions = scan(now);
  prune(now);
  sampleMachine();
  if (opt.usage && !opt.once) tickUsage(now); // --once has already made its one read
  // Ring once when a session starts waiting on the person.
  const nowNeeding = new Set(sessions.filter((s) => factsOf(s).needs).map((s) => s.sid));
  if (opt.bell && !opt.once) for (const sid of nowNeeding) if (!needing.has(sid)) process.stdout.write("\x07");
  needing.clear();
  for (const sid of nowNeeding) needing.add(sid);
}

if (import.meta.main) {
  const command = parseArgs(process.argv.slice(2));
  if (command) {
    process.stdout.write(command === "help" ? HELP : glyphCard());
    process.exit(0);
  }

  if (opt.once) {
    sampleMachine();
    if (opt.usage) await fetchUsage();
    await new Promise((r) => setTimeout(r, 300)); // a second CPU sample, so the gauge is a rate
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
  const restore = () => {
    out.write((opt.mouse ? "\x1b[?1000l\x1b[?1006l" : "") + "\x1b[?25h\x1b[?1049l");
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
  draw();
  setInterval(() => {
    frame++;
    if (frame % 2 === 0) refresh();
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
    d: "done", a: "all", b: "bell", u: "usage",
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
