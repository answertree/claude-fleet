#!/usr/bin/env bun
// Claude Fleet: one screen showing every live Claude Code session on this
// machine and the subagents, workflows and tasks under each.
//
// It only reads Claude Code's files: it tails the transcripts under
// ~/.claude/projects and reads the session registry, workflow journals and
// task files. With --usage it also asks Anthropic for your account's usage
// figures, using the Claude Code login already stored on this machine, and
// saves those figures (never the login) for other dashboards: the one file it
// ever writes.
//
// Usage: bun fleet.ts [minutes] [options]     (see --help)

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StringDecoder } from "node:string_decoder";
import { deflateSync, inflateSync } from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { accountWizard, accountsKey, accountsMain, accountsScreen, retryAccounts, tickAccounts } from "./accounts.ts";

/**
 * Where Claude Code keeps its files; the demo and the tests point FLEET_HOME at made-up sessions. Read each
 * time it is used, not once at import: a test sets FLEET_HOME after its import of this file has already run,
 * and must never be left looking at the real sessions.
 */
/** A full folder path, on macOS and Linux ("/Users/…") or on Windows ("C:\\Users\\…", "\\\\server\\share"). */
export const absoluteDir = (p: string): boolean => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
/** A path's folders, whichever slash it uses. */
export const foldersOf = (p: string): string[] => p.split(/[\\/]/).filter(Boolean);
const claudeHome = (): string => process.env.FLEET_HOME || process.env.AGENT_FLEET_HOME || path.join(os.homedir(), ".claude");
/** The time. FLEET_NOW (test only) pins it, in milliseconds since 1970, so a frame can be reproduced exactly. */
export const clock = (): number => Number(process.env.FLEET_NOW) || Date.now();
const HIDE_TOP = process.env.FLEET_HIDE_PROCESSES === "1"; // leave other programs' names off the machine row
export const WINDOWS = [5, 15, 30, 60, 180];
const TAIL_BYTES = 2 * 1024 * 1024;
const ACTIVE_MS = 60_000;
const WF_RESUME_GRACE_MS = 60_000; // an agent's last lines written just after its workflow's state file are still that run's
const WF_TOOL_MS = 60 * 60_000; // a resumed agent waiting on a tool (a long test run) is still going for up to this long; the stall watch speaks up long before
const WF_QUIET_MS = 5 * 60_000; // a workflow with no state file that has written nothing for this long, with no agent running, has stopped
const FINAL_TOOLS = new Set(["SubagentHandback", "StructuredOutput"]);
const CTX_LOG_MS = 15 * 60_000; // how far back a session's context readings are kept, for the runway forecast

// ───────────────────────── options ─────────────────────────

const HELP = `Claude Fleet: every live Claude Code session on one screen.

Usage: bun fleet.ts [minutes] [options]

  minutes        width of the sparkline window (default 30)
  --mode <m>     detail (default), compact, or timeline (big cards with each
                 session's activity and what happened, readable from a distance;
                 "far" also works)
  --all          also show idle and finished sessions
  --no-usage     do not show your Claude account usage limits. By default it
                 reads the stored Claude Code login and asks api.anthropic.com
                 every five minutes (FLEET_USAGE=0 also turns this off). It saves the
                 figures it gets, never the login, to
                 \${XDG_CACHE_HOME:-~/.cache}/claude-fleet/usage.json (the one
                 file it writes), and when its own read fails shows the
                 figures in that file or in Claude Code's ~/.claude.json
  --no-prs       do not ask GitHub (through your gh command, every two minutes
                 per pull request) for the CI state of each session's pull requests
  --bell         ring the terminal bell when a session starts waiting on you,
                 or when something stalls
  --stall <min>  mark a thread "stalled?" after this many minutes sitting on a
                 tool call in silence with the session idle (default 10, 0 = off)
  --no-mouse     do not capture mouse clicks
  --once         print one frame and exit
  --glyphs       print a test card of every glyph the screen uses, to check that
                 your terminal draws each one a single cell wide, and exit
  --plain-glyphs use fallbacks for glyphs some fonts lack (≡ ┿ ╌ ◇)

Keys: 1 2 3 view mode (3: timeline) · r open the session waiting on you (or
      the focused one) to reply · + - window · a all sessions · d finished agents
      tab focus next session · b bell
      u usage: every Claude account's limits (there: r retries, a adds an account)
      m menu (finished agents, bell, phone, Telegram, background)
      space seen it (marks what is new from now on) · esc leave focus (with
      nothing focused, quit) · q quit
      ? what every mark and key means (any key closes it)
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
  airy: true, // blank rows inside detail blocks while there is room (tests of exact layouts turn it off)
  prs: false, // --prs: ask GitHub (through gh) for the state of each session's pull requests
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
  else if (modeArg === "timeline") opt.mode = "far"; // the far view is called the timeline
  const minutes = argv.find((a, i) => /^\d+$/.test(a) && !TAKES_VALUE.includes(argv[i - 1]));
  if (minutes && Number(minutes) > 0) opt.windowMin = Number(minutes);
  opt.once = argv.includes("--once");
  opt.showAll = argv.includes("--all");
  opt.bell = argv.includes("--bell");
  // Usage and pull requests are on unless asked off; --usage and --prs are still accepted.
  opt.usage = !argv.includes("--no-usage") && process.env.FLEET_USAGE !== "0";
  opt.mouse = !argv.includes("--no-mouse");
  opt.prs = !argv.includes("--no-prs");
  const stall = valueOf("--stall");
  if (stall !== undefined && /^\d+(\.\d+)?$/.test(stall)) opt.stallMin = Number(stall);
  return undefined;
}

let focusSid: string | null = null;
let frame = 0;
/** A word on the bottom row for a few seconds: what a key could not do. */
export const notice = { text: "", until: 0 };
/** Key m: the menu of things used now and then, open above the button bar. */
export const menu = { open: false };
export const FPS = 4; // frames a second
/** Once-a-second beats, for what should blink slowly however fast the frames come: a waiting session's rail. */
const beat = () => Math.floor(frame / FPS);
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
  doneTint: [8, 42, 22] as RGB, // background behind a just-finished session's title
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
    else if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0xd800 && cp <= 0xdfff)) continue; // controls, and half of a character (whose other half may be across something removed)
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
/** Text as one line: every run of white space becomes one space. Nothing else is touched. */
export const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
/**
 * At most `n` UTF-16 units of `s`, never half a character, with … when something was left off. Text read
 * from a session is kept only as long as the screen can ever show, so nothing drawn each second grows with it.
 */
export const capText = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n).replace(/[\ud800-\udbff]$/, "") + "…");
const PROMPT_KEEP = 2_000; // your prompt is drawn on two rows at most
const NOTE_KEEP = 8_000; // a question, a now-line or a tool's hint: the whole question can be read in focus

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
  if (typeof n !== "number" || !Number.isFinite(n)) return "?";
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

/** Progress as one glyph per step: ✓ done, ◐ in progress (white, never yellow), ○ not started. Scaled down past `w` steps. */
export function pips(done: number, doing: number, total: number, w: number, c: RGB = C.green): string {
  let n = total;
  let d = done;
  let r = doing;
  if (total > w) {
    n = w;
    d = Math.min(w, Math.round((done / total) * w));
    r = doing > 0 ? Math.min(w - d, Math.max(1, Math.round((doing / total) * w))) : 0;
  }
  r = Math.min(r, n - d);
  return fg(c, ICON.done.repeat(d)) + fg(C.white, ICON.progress.repeat(r)) + fg(C.faint, ICON.idle.repeat(Math.max(0, n - d - r))) + " ".repeat(Math.max(0, w - n));
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
  let curW = 0;
  for (const word of text.split(" ")) {
    let rest = word;
    let restW = width(word);
    if (restW > w) {
      // A word longer than the line is broken into whole lines of it, walked once; what is left carries on as a word.
      if (cur) lines.push(cur), (cur = ""), (curW = 0);
      let piece = "";
      let pieceW = 0;
      for (const ch of word) {
        const cw = charWidth(ch.codePointAt(0)!);
        if (piece && pieceW + cw > w) lines.push(piece), (piece = ""), (pieceW = 0);
        piece += ch;
        pieceW += cw;
      }
      (rest = piece), (restW = pieceW);
    }
    if (!cur) (cur = rest), (curW = restW);
    else if (curW + 1 + restW <= w) (cur += " " + rest), (curW += 1 + restW);
    else lines.push(cur), (cur = rest), (curW = restW);
  }
  if (cur) lines.push(cur);
  return lines;
}

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
  pr: { g: "⇡", is: "the session's pull requests and their CI" },
  star: { g: "✦", is: "a celebration: a pull request merged or gone green, a workflow or a task list done" },
  background: { g: "↻", is: "commands it has running in the background" },
  changes: { g: "±", is: "files it has changed, and the state of its git checkout" },
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

export type SessionState = "needs" | "stalled" | "working" | "justDone" | "yourTurn" | "idle" | "finished";
/** Each session state has its own glyph, word and colour, so the screen still reads without colour. Listed in sort order. */
export const STATE: Record<SessionState, { glyph: string; word: string; color: RGB }> = {
  needs: { glyph: "▲", word: "NEEDS YOU", color: C.amber },
  stalled: { glyph: "◐", word: "STALLED?", color: C.red },
  working: { glyph: "●", word: "WORKING", color: C.green },
  justDone: { glyph: "✓", word: "FINISHED", color: C.green }, // finished while you watched: on show until space
  yourTurn: { glyph: "▸", word: "YOUR TURN", color: C.blue },
  idle: { glyph: "○", word: "IDLE", color: C.dim },
  finished: { glyph: "✓", word: "FINISHED", color: C.done },
};
export const STATE_ORDER = Object.keys(STATE) as SessionState[];
/** Your turn, idle, finished: nothing is running, so the session's title recedes from bold white to text colour in every mode. */
const isReceded = (state: SessionState) => state === "yourTurn" || state === "idle" || state === "finished";
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
  // Labels (agent names, workflow titles) take about half; once the action column has 50 cells, the rest goes to them, to 72.
  const labelEnd = 7 + Math.min(72, Math.max(Math.min(42, Math.floor((actionEnd - 6) * 0.52)), actionEnd - 6 - 50)) - 1;
  // The header's wide blocks run to column 104, which the lane leaves free only from 150 columns up. From 130 to 149 the header keeps the narrow blocks.
  const roomy = textEnd >= 104;
  const account = roomy ? 61 : 42;
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
    gaugeW: roomy ? 12 : 8,
    histW: roomy ? 20 : 12,
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
 * A drawn row cut to `w` cells, its colour codes kept so nothing is left switched on. The last line of
 * defence on a terminal narrower than a row was laid out for (under 76 columns): a row that is cut is
 * still one row, where a row that wraps pushes every row below it down the screen.
 */
export function clipRow(line: string, w: number): string {
  if (cells(line) <= w) return line;
  let out = "";
  let n = 0;
  for (const part of line.split(/(\x1b\[[0-9;?]*[a-zA-Z])/)) {
    if (part.startsWith("\x1b[")) out += part;
    else
      for (const ch of part) {
        const cw = charWidth(ch.codePointAt(0)!);
        if (n + cw > w) n = Infinity; // the row is full: only codes are kept from here on
        else (out += ch), (n += cw);
      }
  }
  return out;
}

/** One piece of a drawn row: text, colour, bold. What Row.segs() takes, and what the header, the replies and the roster are built from. */
export type Seg = [text: string, color?: RGB, bold?: boolean];
const segsWidth = (segs: Seg[]) => segs.reduce((n, s) => n + width(s[0]), 0);
const segsText = (segs: Seg[]) => segs.map((s) => s[0]).join("");

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
  segs(col: number, parts: Seg[]): number {
    for (const [text, color, isBold] of parts) col = this.put(col, text, color, isBold);
    return col;
  }
  /** The same, ending at `end`. */
  segsr(end: number, parts: Seg[]): number {
    const start = end - segsWidth(parts) + 1;
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

/** One task as its transcript tells it: when it was last started and finished, and the latest thing Claude wrote while it was the task in hand. */
export interface TaskTrace {
  started?: number;
  finished?: number;
  say?: { text: string; t: number };
}
const TASK_TRACE_MAX = 400; // tasks remembered per transcript; the oldest is let go first
const TASK_SAY_KEEP = 4_000; // a task's latest message, kept for its first line (a few in focus)

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
  asks?: { text: string; t: number }[]; // the last few things the person typed, oldest first
  say?: { text: string; t: number }; // last thing Claude wrote
  says: { text: string; t: number }[]; // its last few messages, oldest first
  taskLog: Map<string, TaskTrace>; // each task its updates started or finished, by task id
  taskFocus: string[]; // the tasks in progress, in the order they were started: the last is the task in hand
  prs: Map<string, PrLink>; // the pull requests it has linked, by "repo#number", oldest link first
  bg: Map<string, { desc: string; started: number; ended?: number; status?: string }>; // its background commands, by shell id
  bgAsked: Map<string, { desc: string; t: number }>; // background commands asked for, until their result names the shell
  toolNames: Map<string, string>; // recent tool calls' names by id, so a failure can say which tool failed
  fails: { t: number; tool: string; text: string }[]; // its recent failed tool calls, oldest first
  edits: Map<string, number>; // files it has edited or written, by path, with when (last edited last)
  compactions: number; // times its context was compacted
  compactLog: number[]; // when, for the timeline
  askLog: number[]; // when you typed to it, for the timeline
  cwd?: string; // where it is working, from its own lines
  sayTs: number[]; // when each of its replies in the window was written, for "new since you looked"
  summary?: string; // the session's own "while you were away" summary
  summaryT?: number; // when it was written, so it can be compared with the last prompt
  ctx?: { used: number; model: string; req: string };
  ctxLog: [number, number][]; // its context readings over the last 15 minutes: [time, tokens used]
  parts?: Partial<Record<PartKey, number>>; // characters per context category, from the transcript's own attachments
  ino?: number; // the file it is reading: another file at the same path is read afresh
  used: number; // the scan that last asked for it; one no scan has wanted for a while is let go
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
  try {
    absorbParts(t, a);
  } catch {} // a schema nested too deep to measure, say: that attachment is left out
}
function absorbParts(t: Tail, a: any) {
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

export function hintFor(_name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  if (typeof input.questions?.[0]?.question === "string") return input.questions[0].question;
  if (typeof input.description === "string") return input.description;
  if (typeof input.file_path === "string") return path.basename(input.file_path);
  if (typeof input.pattern === "string") return input.pattern;
  if (typeof input.skill === "string") return input.skill;
  return "";
}

/** A count read from a file: the number, or 0 for anything that is not a finite number. */
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Read one transcript line into the tail. Text a session wrote is made safe here, once, so everything drawn later already is. */
/**
 * A task update from the transcript: a task started ("in_progress") becomes the task in hand; one
 * finished or deleted leaves the tasks in progress. Other updates (a new description, a blocker) say
 * nothing about what is in hand.
 */
export function traceTask(t: Tail, input: any, ts: number) {
  const raw = input?.taskId ?? input?.task_id;
  if (typeof raw !== "string" && typeof raw !== "number") return;
  const status = input?.status;
  if (status !== "in_progress" && status !== "completed" && status !== "deleted") return;
  const id = safeLine(capText(String(raw), 100));
  let e = t.taskLog.get(id);
  if (!e) {
    t.taskLog.set(id, (e = {}));
    if (t.taskLog.size > TASK_TRACE_MAX) t.taskLog.delete(t.taskLog.keys().next().value as string);
  }
  t.taskFocus = t.taskFocus.filter((x) => x !== id);
  if (status === "in_progress") {
    e.started = ts;
    e.finished = undefined;
    t.taskFocus.push(id);
  } else e.finished = ts;
}
export interface PrLink {
  repo: string;
  number: number;
  url: string;
  t: number;
}
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
/** Keep a map to `max` entries, letting the oldest go. */
const capMap = <K, V>(m: Map<K, V>, max: number) => {
  while (m.size > max) m.delete(m.keys().next().value as K);
};
/** What a line says beside the conversation: a pull request linked, a compaction, where the session works. */
export function absorbSide(t: Tail, o: any, ts: number) {
  if (typeof o?.cwd === "string" && absoluteDir(o.cwd) && !o.isSidechain) t.cwd = o.cwd;
  if (o?.type === "pr-link") {
    const repo = String(o.prRepository ?? "");
    const number = Number(o.prNumber);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(number) || number <= 0) return;
    const key = `${repo}#${number}`;
    t.prs.delete(key); // a link again moves it to the end, as the latest
    t.prs.set(key, { repo, number, url: typeof o.prUrl === "string" ? safeLine(capText(o.prUrl, 300)) : "", t: ts });
    capMap(t.prs, 50);
  } else if (o?.type === "system" && o.subtype === "compact_boundary" && !o.isSidechain) {
    t.compactions++;
    t.compactLog.push(ts);
    if (t.compactLog.length > 100) t.compactLog.shift();
  }
}
function noteEdit(t: Tail, input: any, ts: number) {
  const file = input?.file_path ?? input?.notebook_path;
  if (typeof file !== "string" || !file) return;
  t.edits.delete(file);
  t.edits.set(file, ts);
  capMap(t.edits, 500);
}
/** A tool result's text, whether it came as a string or as blocks. */
const resultText = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => (x?.type === "text" && typeof x.text === "string" ? x.text : "")).join("\n") : "");
/** A tool call's result: a background command's shell id, or a failure to remember. */
function noteResult(t: Tail, item: any, ts: number) {
  const id = typeof item?.tool_use_id === "string" ? item.tool_use_id : "";
  const asked = id ? t.bgAsked.get(id) : undefined;
  if (asked) {
    const shell = /running in background with ID: ([\w-]+)/.exec(resultText(item.content).slice(0, 2000))?.[1];
    if (shell) {
      t.bg.set(shell, { desc: asked.desc, started: ts });
      capMap(t.bg, 100);
    }
    t.bgAsked.delete(id);
  }
  if (item?.is_error === true) {
    // The line that says what went wrong: past a bare "Exit code 1" when something follows it.
    const lines = resultText(item.content).slice(0, 4000).replace(/<\/?[a-z_]+>/g, "").split("\n").map((x) => x.trim()).filter(Boolean);
    const first = lines.find((x) => !/^exit code \d+$/i.test(x)) ?? lines[0] ?? "";
    t.fails.push({ t: ts, tool: safeLine(capText(t.toolNames.get(id) ?? "", 100)), text: safeLine(capText(first, 300)) });
    if (t.fails.length > 30) t.fails.shift();
  }
}
/** Notices that background commands ended: each names its task id and how it ended. */
function noteNotices(t: Tail, text: string, ts: number) {
  for (const m of text.matchAll(/<task-id>([\w-]+)<\/task-id>[\s\S]*?<status>([a-z]+)<\/status>/g)) {
    const b = t.bg.get(m[1]);
    if (b && !b.ended) Object.assign(b, { ended: ts, status: m[2] });
  }
}

/** A message from Claude belongs to the task in hand when it was written: the one started last of those in progress. */
function noteTaskSay(t: Tail, text: string, ts: number) {
  const id = t.taskFocus[t.taskFocus.length - 1];
  const e = id === undefined ? undefined : t.taskLog.get(id);
  if (e) e.say = { text: capText(text, TASK_SAY_KEEP), t: ts };
}

export function ingest(t: Tail, line: string) {
  if (ATTACHMENT.test(line.slice(0, 2000)) || (line.length < 400_000 && ATTACHMENT.test(line))) return absorb(t, line);
  if (line.length < 2 || !line.includes('"timestamp"')) {
    if (line.length < 20_000 && (line.includes('"ai-title"') || line.includes('"last-prompt"'))) {
      try {
        const o = JSON.parse(line);
        if (typeof o.aiTitle === "string") t.title = safeLine(o.aiTitle);
        if (typeof o.lastPrompt === "string") t.lastPrompt = safeText(capText(o.lastPrompt, PROMPT_KEEP));
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
    t.summary = safeText(capText(o.content, NOTE_KEEP));
    t.summaryT = ts;
  }
  absorbSide(t, o, ts);
  if (o.type !== "assistant" && o.type !== "user") return;
  t.lastT = Math.max(t.lastT, ts);
  if (typeof o.gitBranch === "string" && o.gitBranch) t.branch = safeLine(o.gitBranch);
  const content = o.message?.content;
  if (o.type === "assistant") {
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item?.type === "tool_use") {
          t.tools.push(ts);
          t.lastTool = { name: safeLine(capText(String(item.name ?? ""), 200)), hint: safeLine(capText(hintFor(item.name, item.input), NOTE_KEEP)), t: ts };
          if (!o.isSidechain && item.name === "TaskUpdate") traceTask(t, item.input, ts);
          if (!o.isSidechain) {
            if (typeof item.id === "string") {
              t.toolNames.set(item.id, String(item.name ?? ""));
              capMap(t.toolNames, 300);
            }
            if (EDIT_TOOLS.has(item.name)) noteEdit(t, item.input, ts);
            if (item.name === "Bash" && item.input?.run_in_background === true && typeof item.id === "string") {
              t.bgAsked.set(item.id, { desc: safeLine(capText(hintFor(item.name, item.input) || "a background command", 200)), t: ts });
              capMap(t.bgAsked, 100);
            }
            if (item.name === "TaskStop" || item.name === "KillShell") {
              const b = t.bg.get(String(item.input?.task_id ?? item.input?.shell_id ?? ""));
              if (b && !b.ended) Object.assign(b, { ended: ts, status: "stopped" });
            }
          }
        }
      }
    }
    const u = o.message?.usage;
    const out = u?.output_tokens;
    if (typeof out === "number" && Number.isFinite(out) && o.message?.id) t.tokens.set(o.message.id, [ts, out]);
    if (!o.isSidechain) {
      if (Array.isArray(content)) for (const item of content) if (item?.type === "text" && typeof item.text === "string" && item.text.trim()) {
          t.say = { text: safeText(item.text), t: ts };
          t.says.push(t.say);
          if (t.says.length > 6) t.says.shift();
          t.sayTs.push(ts);
          noteTaskSay(t, t.say.text, ts);
        }
      if (u) {
        const used = count(u.input_tokens) + count(u.cache_read_input_tokens) + count(u.cache_creation_input_tokens);
        if (used > 0) {
          t.ctx = { used, model: String(o.message?.model ?? ""), req: String(o.requestedModel ?? "") };
          t.ctxLog.push([ts, used]);
          while (t.ctxLog[0][0] < ts - CTX_LOG_MS) t.ctxLog.shift();
        }
      }
    }
  } else if (Array.isArray(content) && content.some((i: any) => i?.type === "tool_result")) {
    t.lastResultT = Math.max(t.lastResultT, ts);
    if (!o.isSidechain) for (const item of content) if (item?.type === "tool_result") noteResult(t, item, ts);
  } else if (!o.isMeta && !o.isSidechain) {
    // Something the person typed. Harness-injected turns start with a tag; skip those, though a notice that a background command ended is noted.
    const texts: string[] = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((i: any) => i?.type === "text").map((i: any) => String(i.text ?? "")) : [];
    for (const text of texts) if (text.includes("<task-notification>")) noteNotices(t, text, ts);
    const typed = texts.map((x) => x.trim()).find((x) => x && !x.startsWith("<"));
    if (typed) {
      t.ask = { text: safeText(capText(typed, PROMPT_KEEP)), t: ts };
      (t.asks ??= []).push(t.ask);
      if (t.asks.length > 6) t.asks.shift();
      t.askLog.push(ts);
      if (t.askLog.length > 300) t.askLog.shift();
    }
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
  } catch {
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
    asks: [],
    taskLog: new Map(),
    taskFocus: [],
    prs: new Map(),
    bg: new Map(),
    bgAsked: new Map(),
    toolNames: new Map(),
    fails: [],
    edits: new Map(),
    compactions: 0,
    compactLog: [],
    askLog: [],
    sayTs: [],
    ctxLog: [],
    tokens: new Map(),
    lastResultT: 0,
    lastT: 0,
    mtime: 0,
    birth,
    used: scanSeq,
  };
}

/** When a transcript was last written: its newest row, or the file's own time when that is later. */
const lastWriteOf = (t: Tail) => Math.max(t.lastT, t.mtime);
/** The tool call a thread is waiting on, if it has one outstanding. */
const pendingOf = (t: Tail) => (t.lastTool && t.lastTool.t > t.lastResultT ? t.lastTool : undefined);
const pendingTool = (t: Tail) => !!pendingOf(t);

/** What the search before the tail looks for: task updates, and Claude's messages (a text block). */
const TASK_MARKS = ['"name":"TaskUpdate"', '"type":"text"', '"type":"pr-link"', '"subtype":"compact_boundary"', '"name":"Edit"', '"name":"Write"'].map((m) => Buffer.from(m));
const TASK_LINE_MAX = 256 * 1024; // longer lines are tool results, not messages or task updates
/**
 * The task updates and Claude's messages written before the part pump() tails, read once, so that a
 * task started long ago is known to be in progress (and since when), and has the latest message written
 * while it was in hand, however old. The file is searched as bytes; only the lines that hold one of the
 * marks are parsed, in the order they were written. Lines that start before `upTo` are this scan's; the
 * tail drops its first, partial line.
 */
export function scanTaskUpdates(t: Tail, upTo: number) {
  let fd: number;
  try {
    fd = fs.openSync(t.path, "r");
  } catch {
    return;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const limit = Math.min(size, upTo + TASK_SCAN_OVERLAP);
    const buf = Buffer.allocUnsafe(TASK_SCAN_CHUNK + TASK_SCAN_OVERLAP);
    const read = new Set<number>(); // where each line read starts: the chunks overlap
    for (let pos = 0; pos < upTo; pos += TASK_SCAN_CHUNK) {
      const n = fs.readSync(fd, buf, 0, Math.min(TASK_SCAN_CHUNK + TASK_SCAN_OVERLAP, limit - pos), pos);
      if (n <= 0) break;
      const view = buf.subarray(0, n);
      const lines = new Map<number, [number, number]>(); // where a line starts in the file -> its bounds in this chunk
      for (const mark of TASK_MARKS)
        for (let at = view.indexOf(mark); at !== -1; at = view.indexOf(mark, at + mark.length)) {
          const before = view.lastIndexOf(10, at);
          const end = view.indexOf(10, at);
          if (end === -1 || (before === -1 && pos > 0)) continue; // not whole in this chunk: the overlapping one has it
          const from = pos + before + 1;
          if (from >= upTo || read.has(from) || end - before > TASK_LINE_MAX) continue;
          lines.set(from, [before + 1, end]);
        }
      for (const [from, [a, z]] of [...lines].sort((p, q) => p[0] - q[0])) {
        read.add(from);
        let o: any;
        try {
          o = JSON.parse(view.subarray(a, z).toString("utf8"));
        } catch {
          continue;
        }
        const ts = Date.parse(o?.timestamp);
        if (Number.isNaN(ts)) continue;
        absorbSide(t, o, ts);
        if (o?.type !== "assistant" || o.isSidechain || !Array.isArray(o.message?.content)) continue;
        for (const item of o.message.content) {
          if (item?.type === "tool_use" && item.name === "TaskUpdate") traceTask(t, item.input, ts);
          else if (item?.type === "tool_use" && EDIT_TOOLS.has(item.name)) noteEdit(t, item.input, ts);
          else if (item?.type === "text" && typeof item.text === "string" && item.text.trim()) noteTaskSay(t, safeText(capText(item.text, TASK_SAY_KEEP)), ts);
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}
const TASK_SCAN_CHUNK = 4 << 20;
const TASK_SCAN_OVERLAP = 1 << 20; // longer than any line that holds a task update

const chunk = Buffer.allocUnsafe(1 << 20);
function pump(file: string, isMain = false): Tail | undefined {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    tails.delete(file);
    return undefined;
  }
  if (!st.isFile()) return void tails.delete(file); // a directory or a named pipe with a transcript's name: not one
  let t = tails.get(file);
  // A file that shrank, or another file now at this path, is read afresh.
  if (!t || st.size < t.offset || (t.ino !== undefined && t.ino !== st.ino)) {
    const start = Math.max(0, st.size - TAIL_BYTES);
    t = newTail(file, start, st.birthtimeMs);
    t.ino = st.ino;
    tails.set(file, t);
    if (isMain && start > 0) {
      scanHead(t, start);
      scanTaskUpdates(t, start);
    }
  }
  t.used = scanSeq;
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
  } catch {
    // The file went away or could not be read part way: what was read stands, and the next scan tries again.
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
/** What a workflow says it does: its state file's description, or its script's meta.description (from the state file's
 *  copy of the script, else the script itself). Read once per workflow: scans come twice a second. */
const wfDescs = new Map<string, string>();
const metaDescription = (script: unknown): string => {
  if (typeof script !== "string") return "";
  const m = /export\s+const\s+meta\s*=\s*\{[\s\S]*?\bdescription\s*:\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/.exec(script);
  return m ? m[2].replace(/\\(.)/g, "$1") : "";
};
export function wfDescription(id: string, state: any, scriptPath: () => string | undefined): string {
  const known = wfDescs.get(id);
  if (known !== undefined) return known;
  let d = typeof state?.description === "string" ? state.description : metaDescription(state?.script);
  if (!d) {
    const f = scriptPath();
    if (f) try { d = metaDescription(fs.readFileSync(f, "utf8").slice(0, 20_000)); } catch {}
  }
  d = safeLine(d || "").trim();
  if (d || state) wfDescs.set(id, d); // with no state file yet, look again once the script lands
  return d;
}
/** A workflow's title, from its description: up to its first bracket, comma, semicolon, dash or full stop, capitalised,
 *  cut at a word. "Diagnose every failed CI job on PR #1240 (read-only), then …" is "Diagnose every failed CI job on PR #1240". */
export function wfTitle(description: string): string {
  let t = description.split(/\s\(|,\s|;\s|\s[—–-]\s|\.\s|\.$/)[0].trim();
  if (t.length < 8) t = description.trim();
  if (t.length > 64) t = t.slice(0, 63).replace(/\s+\S*$/, "") + "…";
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}
export interface Workflow {
  id: string;
  name: string; // what it is called on screen: a title from its description, else its name
  slug?: string; // its name as written in its script ("bundle-1240-ci-fix")
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
/** One task from the session's task list. Its text has been through safeLine(). */
export interface TaskItem {
  id: string;
  subject: string;
  activeForm: string; // what it says while it is in progress ("Fixing the tests"); may be empty
  status: "pending" | "in_progress" | "completed";
  blocked: boolean; // it waits on a task that is not completed yet
  description: string; // what it is for, from its file, on one line
  since?: number; // in progress: when it was started, when the transcript says
  say?: { text: string; t: number }; // the latest thing Claude wrote while it was the task in hand
}
const TASK_KEEP = 300; // a task's subject or active form: one row outside focus, a few rows in it
const TASK_DESC_KEEP = 900; // a task's description: up to three rows under it, while there is room
/** Task order: by number when the id is one, then by the id's text. */
const taskOrder = (a: TaskItem, b: TaskItem): number => {
  const n = (id: string) => (/^\d+$/.test(id) ? Number(id) : Infinity);
  return n(a.id) - n(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
};
/** What a session is doing beside the conversation, gathered from its transcripts. */
export interface Side {
  prs: PrLink[]; // newest link first
  bg: { id: string; desc: string; started: number }[]; // background commands still running, oldest first
  fails: { t: number; tool: string; text: string }[]; // tool calls that failed in the last ten minutes, oldest first
  edits: { path: string; t: number }[]; // files it has changed, last changed first
  compactions: number;
  cwd?: string; // where it works, for its git state
}
const FAIL_WINDOW_MS = 10 * 60_000;
const BG_MAX_MS = 24 * 3600_000; // a background command not heard of for a day is taken to have ended unseen
/** A session's git checkout: its branch, files not committed, and commits ahead of and behind its upstream. */
export interface GitState {
  branch: string;
  dirty: number;
  ahead: number;
  behind: number;
}
export function parseGitStatus(text: string): GitState | undefined {
  const lines = text.split("\n");
  if (!lines[0]?.startsWith("## ")) return undefined;
  const head = lines[0].slice(3);
  return {
    branch: safeLine(head.split("...")[0].replace(/^No commits yet on /, "")),
    dirty: lines.slice(1).filter((l) => l.trim()).length,
    ahead: Number(/ahead (\d+)/.exec(head)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(head)?.[1] ?? 0),
  };
}
/** A pull request's state and its checks: passed, failed, still running. */
export interface PrState {
  mergeSha?: string; // the merge commit, once merged
  state: string; // OPEN, MERGED or CLOSED
  draft: boolean;
  title?: string; // without a leading tag such as [FIX] or [FEATURE]
  pass: number;
  fail: number;
  pending: number;
}
const CHECK_PASS = ["SUCCESS", "NEUTRAL", "SKIPPED"];
const CHECK_FAIL = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];
/** A pull request's title as shown: its leading tags ("[FIX] ", "[FEATURE]: ") left off. */
export const prTitle = (t: string): string => safeLine(t.replace(/^(\s*\[[^\]]{1,24}\]\s*:?)+\s*/, "")).trim();
export function summarizePr(j: any): PrState | undefined {
  if (!j || typeof j.state !== "string") return undefined;
  const out: PrState = { state: j.state.toUpperCase(), draft: j.isDraft === true, pass: 0, fail: 0, pending: 0 };
  if (typeof j.title === "string") out.title = prTitle(j.title);
  const sha = j.mergeCommit?.oid;
  if (typeof sha === "string" && /^[0-9a-f]{7,40}$/.test(sha)) out.mergeSha = sha;
  for (const c of Array.isArray(j.statusCheckRollup) ? j.statusCheckRollup : []) {
    const v = String(c?.conclusion || c?.state || c?.status || "").toUpperCase();
    if (CHECK_PASS.includes(v)) out.pass++;
    else if (CHECK_FAIL.includes(v)) out.fail++;
    else out.pending++;
  }
  return out;
}
/** Read in the background and kept: git state by folder, pull request state by "repo#number". */
export const gitState = new Map<string, { at: number; state?: GitState; busy?: boolean }>();
export const prState = new Map<string, { at: number; state?: PrState; busy?: boolean }>();
const GIT_EVERY_MS = 30_000;
const PR_EVERY_MS = 120_000;
const PR_DONE_EVERY_MS = 15 * 60_000; // merged or closed: it will not change much
export const PR_SHOWN = 3;
export const PR_READ = 12; // linked pull requests read, newest first, so the open ones among them are known
/** The pull requests to show for a session: the newest three always, then every other one that is open. */
export const prsShown = (prs: PrLink[]): PrLink[] => [...prs.slice(0, PR_SHOWN), ...prs.slice(PR_SHOWN, PR_READ).filter((p) => prState.get(`${p.repo}#${p.number}`)?.state?.state === "OPEN")];
 // pull requests on a session's row, newest linked first
const fixture = (name: string): Record<string, unknown> | undefined => {
  const file = process.env[name];
  if (!file) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
};
/**
 * Run a command in the background (a fixed program and argument list, never a shell), stopped after `timeoutMs`;
 * `done` gets its exit code (null when it could not run or was stopped) and its output. The program is started by a
 * thread of its own (run.worker.ts): under heavy load starting one can take a second, and this thread must not wait.
 * Without workers, it is started from here.
 */
let runner: Worker | null | undefined;
const running = new Map<number, (code: number | null, out: string) => void>();
let runId = 0;
export function runInBackground(cmd: string, args: string[], timeoutMs: number, done: (code: number | null, out: string) => void) {
  sideCost.started++;
  if (runner === undefined)
    try {
      runner = new Worker(new URL("./run.worker.ts", import.meta.url).href);
      runner.onmessage = (e: MessageEvent) => {
        const f = running.get(e.data.id);
        running.delete(e.data.id);
        f?.(e.data.code, e.data.out);
      };
      runner.unref?.(); // never what keeps fleet running
    } catch {
      runner = null;
    }
  if (runner) {
    const id = ++runId;
    running.set(id, done);
    runner.postMessage({ id, cmd, args, timeoutMs });
    return;
  }
  let out = "";
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return done(null, "");
  }
  const timer = setTimeout(() => child.kill(), timeoutMs);
  child.stdout?.on("data", (d) => {
    if (out.length < 4 << 20) out += d;
  });
  child.on("error", () => (clearTimeout(timer), done(null, "")));
  child.on("close", (code) => (clearTimeout(timer), done(code, out)));
}
/**
 * Run a command with a fixed program and argument list (never a shell), and hand its output to `done`:
 * at once with `sync` (one frame, --once), else in the background, stopped after five seconds.
 */
function runFor(cmd: string, args: string[], sync: boolean, done: (out: string | undefined) => void) {
  if (sync) {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000, maxBuffer: 4 << 20 });
    return done(r.status === 0 ? r.stdout : undefined);
  }
  runInBackground(cmd, args, 5000, (code, out) => done(code === 0 ? out : undefined));
}
/** Ask git for a folder's state, at most every 30 seconds. --no-optional-locks keeps it from taking the index lock a session may need. */
export function pollGit(cwd: string, now: number, sync = false) {
  if (!absoluteDir(cwd)) return;
  const e = gitState.get(cwd);
  if (e && (e.busy || now - e.at < GIT_EVERY_MS)) return;
  const fx = fixture("FLEET_GIT_FIXTURE");
  if (fx) return void gitState.set(cwd, { at: now, state: typeof fx[cwd] === "string" ? parseGitStatus(fx[cwd] as string) : undefined });
  gitState.set(cwd, { at: e?.at ?? 0, state: e?.state, busy: true });
  runFor("git", ["--no-optional-locks", "-C", cwd, "status", "--porcelain=v1", "-b"], sync, (out) => gitState.set(cwd, { at: clock(), state: out === undefined ? undefined : parseGitStatus(out) }));
}
/** Ask GitHub, through gh, for a pull request's state: every two minutes while it is open, every 15 once it is merged or closed. */
export function pollPr(pr: PrLink, now: number, sync = false) {
  const key = `${pr.repo}#${pr.number}`;
  const e = prState.get(key);
  const every = e?.state && e.state.state !== "OPEN" ? PR_DONE_EVERY_MS : PR_EVERY_MS;
  if (e && (e.busy || now - e.at < every)) return;
  const fx = fixture("FLEET_PR_FIXTURE");
  if (fx) return void prState.set(key, { at: now, state: summarizePr(fx[key]) });
  prState.set(key, { at: e?.at ?? 0, state: e?.state, busy: true });
  runFor("gh", ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "state,isDraft,statusCheckRollup,mergeCommit,title"], sync, (out) => {
    let state: PrState | undefined;
    try {
      state = out === undefined ? undefined : summarizePr(JSON.parse(out));
    } catch {}
    prState.set(key, { at: clock(), state: state ?? e?.state });
  });
}
/** Where a repository's merges go live: a URL whose JSON names the revision deployed there. */
export interface Deploy {
  repo: string; // "owner/name", as pull requests name it
  name: string; // what to call it on screen: "staging"
  url: string;
  field: string; // the JSON field holding the revision (default "revision")
}
/** Deploy targets from ${XDG_CONFIG_HOME:-~/.config}/claude-fleet/deploys.json, read once a minute. */
export function deploys(): Deploy[] {
  const file = process.env.FLEET_DEPLOYS_FILE || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "claude-fleet", "deploys.json");
  const at = deployCache.file === file && clock() - deployCache.at < 60_000 ? deployCache.list : undefined;
  if (at) return at;
  let list: Deploy[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    list = (Array.isArray(raw) ? raw : [])
      .filter((d: any) => typeof d?.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(d.repo) && typeof d.url === "string" && /^https?:\/\//.test(d.url))
      .map((d: any) => ({ repo: d.repo, name: safeLine(String(d.name ?? "deploy")).slice(0, 20), url: d.url, field: typeof d.field === "string" ? d.field : "revision" }));
  } catch {}
  Object.assign(deployCache, { file, at: clock(), list });
  return list;
}
const deployCache: { file?: string; at: number; list: Deploy[] } = { at: 0, list: [] };
/** The revision each deploy target reports, read every minute in the background. */
export const deployState = new Map<string, { at: number; revision?: string; busy?: boolean }>();
export function pollDeploys(now: number, sync = false) {
  const fx = fixture("FLEET_DEPLOY_FIXTURE");
  for (const d of deploys()) {
    const e = deployState.get(d.url);
    if (e && (e.busy || now - e.at < 60_000)) continue;
    if (fx) {
      deployState.set(d.url, { at: now, revision: typeof fx[d.url] === "string" ? (fx[d.url] as string) : undefined });
      continue;
    }
    const done = (j: any) => {
      const rev = j?.[d.field];
      deployState.set(d.url, { at: clock(), revision: typeof rev === "string" && /^[0-9a-f]{7,40}$/.test(rev) ? rev : e?.revision });
    };
    if (sync) {
      const r = spawnSync("curl", ["-fsS", "-m", "8", d.url], { encoding: "utf8", timeout: 10_000 });
      try {
        done(JSON.parse(r.stdout));
      } catch {
        done(undefined);
      }
      continue;
    }
    deployState.set(d.url, { at: e?.at ?? 0, revision: e?.revision, busy: true });
    fetch(d.url, { signal: AbortSignal.timeout(8000), redirect: "error" })
      .then((r) => r.json())
      .then(done, () => done(undefined));
  }
}
const ancestry = new Map<string, boolean | undefined>();
/**
 * Whether a merge is live on a deploy target: its commit is the revision deployed, or one of its
 * ancestors (asked of git in the session's checkout, which may not have the deployed commit yet:
 * then it cannot say). Undefined when it cannot tell.
 */
export function mergeLive(mergeSha: string, revision: string | undefined, cwd: string, repo = ""): boolean | undefined {
  if (!revision) return undefined;
  if (revision.startsWith(mergeSha) || mergeSha.startsWith(revision)) return true;
  const key = `${mergeSha} ${revision}`;
  if (ancestry.get(key) !== undefined) return ancestry.get(key);
  if (fixture("FLEET_DEPLOY_FIXTURE")) return undefined;
  // Asked of the checkout in the background (in a big repository it takes a while, and the page and the bot must not
  // wait on it): unknown until it answers. --once asks and waits.
  if (!ancestry.has(key) && absoluteDir(cwd)) {
    const args = ["--no-optional-locks", "-C", cwd, "merge-base", "--is-ancestor", mergeSha, revision];
    const settle = (status: number | null) => {
      ancestry.set(key, status === 0 ? true : status === 1 ? false : undefined);
      if (ancestry.size > 500) ancestry.delete(ancestry.keys().next().value as string);
    };
    if (opt.once) {
      settle(spawnSync("git", args, { timeout: 3000 }).status);
      if (ancestry.get(key) !== undefined) return ancestry.get(key);
    } else {
      if (asking.has(key)) return undefined;
      asking.add(key);
      runInBackground("git", args, 10_000, (code) => (asking.delete(key), settle(code)));
      return undefined;
    }
  }
  // The checkout does not have the deployed commit: ask GitHub to compare the two, once.
  if (repo && /^[\w.-]+\/[\w.-]+$/.test(repo) && /^[0-9a-f]{7,40}$/.test(mergeSha) && /^[0-9a-f]{7,40}$/.test(revision) && !comparing.has(key)) {
    comparing.add(key);
    runFor("gh", ["api", `repos/${repo}/compare/${mergeSha}...${revision}`, "--jq", ".status"], opt.once, (out) => {
      const status = out?.trim();
      ancestry.set(key, status === "ahead" || status === "identical" ? true : status === "behind" || status === "diverged" ? false : undefined);
    });
  }
  return ancestry.get(key);
}
const comparing = new Set<string>();
const asking = new Set<string>(); // merge-base questions under way

/** Each repository's worktrees and the branch each has out, read every 30 seconds when a session's branch is not the one in its folder. */
export const worktreeState = new Map<string, { at: number; list?: { path: string; branch: string }[]; busy?: boolean }>();
export function parseWorktrees(text: string): { path: string; branch: string }[] {
  const out: { path: string; branch: string }[] = [];
  for (const block of text.split("\n\n")) {
    const p = /^worktree (.+)$/m.exec(block)?.[1];
    const b = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (p && b) out.push({ path: p, branch: b });
  }
  return out;
}
function pollWorktrees(cwd: string, now: number, sync = false) {
  const e = worktreeState.get(cwd);
  if (e && (e.busy || now - e.at < GIT_EVERY_MS)) return;
  worktreeState.set(cwd, { at: e?.at ?? 0, list: e?.list, busy: true });
  runFor("git", ["--no-optional-locks", "-C", cwd, "worktree", "list", "--porcelain"], sync, (out) => worktreeState.set(cwd, { at: clock(), list: out === undefined ? undefined : parseWorktrees(out) }));
}
/** The checkout a session is working on. A session that moves between worktrees still records the folder it started in,
 *  with the branch it is on now: when that branch is not the one out in the folder, it is the worktree that has it out,
 *  and when no worktree has it (removed after a merge, say) there is none, rather than another checkout's figures. */
export function gitDirOf(s: Session): string | undefined {
  const base = s.side?.cwd ?? s.cwd;
  const branch = s.mains.map((m) => m.branch).find(Boolean);
  const here = gitState.get(base)?.state;
  if (!branch || branch === "HEAD" || !here || here.branch === branch) return base;
  return worktreeState.get(base)?.list?.find((w) => w.branch === branch)?.path;
}
/** Start the reads a frame will want: each session's git state, and with --prs its newest pull requests. */
/** Where the time in pollSides went, by kind, and how many commands it started (for the service log). */
export const sideCost = { git: 0, worktrees: 0, prs: 0, deploys: 0, started: 0 };
const timed = (k: "git" | "worktrees" | "prs" | "deploys", f: () => void) => {
  const a = performance.now();
  f();
  sideCost[k] += performance.now() - a;
};
export function pollSides(sessions: Session[], now: number, sync = false) {
  Object.assign(sideCost, { git: 0, worktrees: 0, prs: 0, deploys: 0, started: 0 });
  for (const s of sessions) {
    if (!s.side) continue;
    const base = s.side.cwd ?? s.cwd;
    timed("git", () => pollGit(base, now, sync));
    const dir = gitDirOf(s);
    if (dir !== base) timed("worktrees", () => pollWorktrees(base, now, sync));
    if (dir && dir !== base) timed("git", () => pollGit(dir, now, sync));
    if (opt.prs) for (const pr of s.side.prs.slice(0, PR_READ)) timed("prs", () => pollPr(pr, now, sync));
  }
  if (opt.prs) timed("deploys", () => pollDeploys(now, sync));
}
export const gitOf = (s: Session): GitState | undefined => {
  if (s.remote) return s.remote.git;
  const dir = gitDirOf(s);
  return dir ? gitState.get(dir)?.state : undefined;
};

/** The side facts across a session's transcripts. */
export function sideOf(mains: Tail[], now: number): Side {
  const byFresh = [...mains].sort((p, q) => q.mtime - p.mtime);
  const prs = new Map<string, PrLink>();
  for (const m of mains) for (const [k, v] of m.prs) if (!prs.has(k) || prs.get(k)!.t < v.t) prs.set(k, v);
  const edits = new Map<string, number>();
  for (const m of mains) for (const [k, v] of m.edits) edits.set(k, Math.max(v, edits.get(k) ?? 0));
  return {
    prs: [...prs.values()].sort((p, q) => q.t - p.t),
    bg: mains.flatMap((m) => [...m.bg].filter(([, b]) => !b.ended && now - b.started < BG_MAX_MS).map(([id, b]) => ({ id, desc: b.desc, started: b.started }))).sort((p, q) => p.started - q.started),
    fails: mains.flatMap((m) => m.fails.filter((f) => now - f.t < FAIL_WINDOW_MS && f.t <= now)).sort((p, q) => p.t - q.t),
    edits: [...edits].map(([path, t]) => ({ path, t })).sort((p, q) => q.t - p.t),
    compactions: mains.reduce((n, m) => n + m.compactions, 0),
    cwd: byFresh.map((m) => m.cwd).find(Boolean),
  };
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
  tasks?: { done: number; doing: number; total: number; active: string; items: TaskItem[] }; // items: every task not deleted, in task order
  job?: { state: string; detail: string; needs: string; since?: number; tokens?: number }; // since: when a blocked job began waiting; tokens: all it has used
  side?: Side; // what it is doing beside the conversation
  jobId?: string;
  loading?: boolean; // not read yet (fleet starting): shown from its registry entry as "reading…" until a later scan reads it
  remote?: { host: string; ip: string; addr: string; use: { cpu: number; rss: number; known: boolean }; git?: GitState }; // on another machine: which, and what its fleet measured there
}

/**
 * A file's text, only when it is a regular file of a sane size: reading a named pipe would block the
 * dashboard for good, and a device or a huge file would freeze it. A symlink to a regular file is fine.
 */
function readText(f: string, max = 32 << 20): string | undefined {
  try {
    const st = fs.statSync(f);
    return st.isFile() && st.size <= max ? fs.readFileSync(f, "utf8") : undefined;
  } catch {
    return undefined;
  }
}
export const readJson = (f: string, max?: number): any => {
  const text = readText(f, max);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
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
  phases: string[]; // the phases as they were visited, in order: one the workflow comes back to is listed again
  used?: number; // the scan that last asked for it
}
/**
 * Read a workflow journal's text: who started, in which phase, and who has finished. The phases are a
 * history: a phase the workflow returns to (fix, verify, fix again) is listed again, so the current one is
 * always last. Agents of a phase that start while that phase's earlier agents are still running belong to
 * the same visit, so phases running side by side are not listed over and over.
 */
export function readJournal(text: string, mtime = 0): Journal {
  const started = new Map<string, any>();
  const results = new Set<string>();
  const phases: string[] = [];
  const open = new Map<string, Set<string>>(); // each phase's agents that have not reported yet
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (o.type === "started") {
        started.set(o.agentId, o);
        const phase = safeLine(o.phase);
        if (!phase) continue;
        if (phases[phases.length - 1] !== phase && !open.get(phase)?.size) phases.push(phase);
        if (!open.has(phase)) open.set(phase, new Set());
        open.get(phase)!.add(String(o.agentId));
      } else if (o.type === "result") {
        results.add(o.agentId);
        for (const waiting of open.values()) waiting.delete(String(o.agentId));
      }
    } catch {}
  }
  return { mtime, started, results, phases };
}
const journalCache = new Map<string, Journal>();
function journal(file: string): Journal {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return readJournal("");
  }
  if (!st.isFile()) return readJournal("");
  const hit = journalCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return (hit.used = scanSeq), hit;
  const entry = readJournal(readText(file, 256 << 20) ?? "", st.mtimeMs);
  entry.used = scanSeq;
  journalCache.set(file, entry);
  return entry;
}

let projectsRoot = "";
let projectDirs: string[] = [];
let projectDirsAt = 0;
const sessionDirCache = new Map<string, { at: number; dirs: string[]; mains: string[]; used?: number }>();
function locate(sid: string, now: number) {
  const root = path.join(claudeHome(), "projects");
  if (root !== projectsRoot) {
    // The home has moved (a test did it): forget what was found under the old one.
    projectsRoot = root;
    projectDirsAt = 0;
    sessionDirCache.clear();
  }
  const hit = sessionDirCache.get(sid);
  if (hit && now - hit.at < 20_000) return (hit.used = scanSeq), hit;
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
  const entry = { at: now, dirs, mains, used: scanSeq };
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
  const live = running.map((a) => seen.lastIndexOf(a.phase ?? "")).filter((i) => i >= 0);
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
  if (new Set(wf.seen).size < wf.seen.length) {
    // It has come back to a phase: the history as it happened (only a phase's latest visit can be current), then the declared phases not reached yet.
    const now = (name: string, i: number) => live && wf.seen.lastIndexOf(name) === i && (name === wf.phase || busy.has(name));
    return [...wf.seen.map((name, i): PhaseStep => ({ name, state: now(name, i) ? "now" : "done" })), ...wf.phases.filter((p) => !wf.seen.includes(p)).map((name): PhaseStep => ({ name, state: live ? "next" : "done" }))];
  }
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

/** An agent that has handed in its result (its last tool call is a final one, answered). */
const finishedItself = (tail: Tail) => !!tail.lastTool && FINAL_TOOLS.has(tail.lastTool.name) && tail.lastResultT >= tail.lastTool.t;
function loadAgent(file: string, wf?: string, started?: any, done = false): Agent | undefined {
  const tail = pump(file);
  if (!tail) return undefined;
  const m = meta(file);
  const finalTool = finishedItself(tail);
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

/** When each blocked job began waiting, and on which question. */
const waitingSince = new Map<string, { needs: string; since: number; used?: number }>();
let scanSeq = 0; // scans so far
const FORGET_SCANS = 10; // what no scan has asked for in this many scans (20 seconds) is let go

/** What is held in memory for the files the dashboard has read, by path (and by session id): for tests. */
export const cachedKeys = (): string[] => [...tails.keys(), ...metaCache.keys(), ...journalCache.keys(), ...sessionDirCache.keys(), ...waitingSince.keys()];

/** A session id as Claude Code writes them: letters, digits and dashes. Anything else is not drawn, nor used in a path. */
const PLAIN_ID = /^[\w-]{1,64}$/;

/** Older than this, a workflow that has ended or an agent's transcript is not read: twice the longest window any view shows. */
const OLD_MS = 2 * WINDOWS[WINDOWS.length - 1] * 60_000;
const mtimeOf = (f: string): number => {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};
/** A workflow's state file (written once, when it ends; it carries the whole script and logs), parsed once per change. */
const stateFiles = new Map<string, { key: string; value: any }>();
function stateFile(f: string): any {
  let st: fs.Stats;
  try {
    st = fs.statSync(f);
  } catch {
    stateFiles.delete(f);
    return undefined;
  }
  const key = `${st.mtimeMs} ${st.size}`;
  const hit = stateFiles.get(f);
  if (hit?.key === key) return hit.value;
  const value = readJson(f);
  stateFiles.set(f, { key, value });
  if (stateFiles.size > 5000) stateFiles.delete(stateFiles.keys().next().value as string);
  return value;
}
/** How long a scan may spend reading sessions it has not read before; past it they wait, shown as "reading…", for the
 *  next scan. So fleet shows its sessions at once and fills each in as it is read. Infinity (the default) reads all. */
let scanBudgetMs = Infinity;
export const setScanBudget = (ms: number) => (scanBudgetMs = ms);
const readOnce = new Set<string>(); // sessions read at least once
let waited = new Set<string>(); // shown as placeholders by the last scan
let justRead = new Set<string>(); // placeholders last scan, read this one: what they show is not news
/** Whether the last scan left any session unread. */
export let scanPending = false;
/** The sessions that were placeholders and have now been read (once). Not news, like a machine just come into view. */
export const takeJustRead = (): Set<string> => {
  const out = justRead;
  justRead = new Set();
  return out;
};
export function scan(now: number): Session[] {
  scanSeq++;
  const began = performance.now();
  const sessions: Session[] = [];
  const nowWaiting = new Set<string>();
  const CLAUDE = claudeHome();
  const registry = ls(path.join(CLAUDE, "sessions")).filter((f) => f.endsWith(".json"));
  for (const [i, f] of registry.entries()) {
    const reg = readJson(path.join(CLAUDE, "sessions", f));
    if (typeof reg?.sessionId !== "string" || !PLAIN_ID.test(reg.sessionId) || !alive(reg.pid)) continue;
    scanProgress?.(i, registry.length, safeLine(String(reg.name || reg.sessionId).slice(0, 40)));
    const sid: string = reg.sessionId;
    // Past the budget, a session not read before waits: drawn from its registry entry for now.
    if (!readOnce.has(sid) && performance.now() - began > scanBudgetMs) {
      const startedAt = Number(reg.startedAt);
      nowWaiting.add(sid);
      sessions.push({ sid, pid: reg.pid, name: safeLine(String(reg.name || sid.slice(0, 8))), kind: safeLine(reg.kind), status: safeLine(reg.status), cwd: safeLine(reg.cwd), startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : now, mains: [], agents: [], workflows: [], loading: true });
      continue;
    }
    // One entry that cannot be read is left out; the rest of the fleet is still drawn.
    try {
      const loc = locate(sid, now);
      const mains = loc.mains.map((m) => pump(m, true)).filter(Boolean) as Tail[];
      const agents: Agent[] = [];
      const workflows: Workflow[] = [];

      // A workflow's script copy lands under whichever project folder the session's cwd was in at launch, so look in all of them.
      const scripts = loc.dirs.flatMap((d) => ls(path.join(d, "workflows", "scripts")));
      for (const dir of loc.dirs) {
        const sub = path.join(dir, "subagents");
        for (const name of ls(sub)) {
          if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
          if (mtimeOf(path.join(sub, name)) < now - OLD_MS) continue; // not written for hours: no view shows it, so it is not read
          const a = loadAgent(path.join(sub, name));
          if (a) agents.push(a);
        }
        for (const wfId of ls(path.join(sub, "workflows"))) {
          if (!wfId.startsWith("wf_")) continue;
          const wfDir = path.join(sub, "workflows", wfId);
          const state = stateFile(path.join(dir, "workflows", wfId + ".json"));
          const script = scripts.find((x) => x.endsWith(`-${wfId}.js`));
          const slug = safeLine(state?.workflowName || (script ? script.slice(0, -(wfId.length + 4)) : wfId));
          const title = () => wfTitle(wfDescription(wfId, state, () => (script ? loc.dirs.map((d) => path.join(d, "workflows", "scripts", script)).find((f) => fs.existsSync(f)) : undefined))) || slug;
          // Ended hours ago, and none of its agents written since: no view shows it, so only its state file is read, not its
          // agents' transcripts (a long-lived session can have thousands). One picked up again writes, and is read in full.
          if (state && count(state.startTime) + count(state.durationMs) < now - OLD_MS) {
            const files = ls(wfDir).filter((n) => n.startsWith("agent-") && n.endsWith(".jsonl"));
            const newest = Math.max(0, ...files.map((n) => mtimeOf(path.join(wfDir, n))));
            if (newest < now - OLD_MS) {
              const ended = count(state.startTime) + count(state.durationMs);
              workflows.push({ id: wfId, name: title(), slug, status: state.status ? safeLine(state.status) : "stopped", phase: "", phases: Array.isArray(state.phases) ? state.phases.map((p: any) => safeLine(p?.title)).filter(Boolean) : [], seen: [], started: count(state.startTime) || ended, finished: ended, agents: [], lastT: Math.max(newest, ended), tokens: typeof state.totalTokens === "number" ? state.totalTokens : undefined });
              continue;
            }
          }
          const j = journal(path.join(wfDir, "journal.jsonl"));
          const wfAgents: Agent[] = [];
          for (const name of ls(wfDir)) {
            if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
            const id = name.slice(6, -6);
            const a = loadAgent(path.join(wfDir, name), wfId, j.started.get(id), j.results.has(id) || !!state);
            if (a) wfAgents.push(a);
          }
          // Resumed: a workflow that ended (out of usage, say) and was picked up again keeps its old state file until the new run
          // ends, while its agents carry on in the same folder. An agent writing after the recorded end, lately, is that new run.
          const ended = state ? count(state.startTime) + count(state.durationMs) : 0;
          const going = (a: Agent) => now - a.tail.mtime < WF_QUIET_MS || (!!pendingOf(a.tail) && now - a.tail.mtime < WF_TOOL_MS);
          const resumed = state ? wfAgents.filter((a) => !j.results.has(a.id) && a.tail.mtime > ended + WF_RESUME_GRACE_MS && going(a)) : [];
          for (const a of resumed) a.done = finishedItself(a.tail);
          const lastT = Math.max(j.mtime, ...wfAgents.map((a) => a.tail.mtime), 0);
          const running = wfAgents.filter((a) => !a.done);
          const phases: string[] = Array.isArray(state?.phases) ? state.phases.map((p: any) => safeLine(p?.title)).filter(Boolean) : [];
          workflows.push({
            id: wfId,
            name: title(),
            slug,
            // The state file is written when a workflow ends. Without it the workflow is still going, even at a moment when no agent
            // is (just launched, between two agents, the last one just reported), unless it has written nothing for minutes.
            status: resumed.length ? "running" : state?.status ? safeLine(state.status) : running.length || now - lastT < WF_QUIET_MS ? "running" : "stopped",
            phase: currentPhase(j.phases, running),
            phases,
            seen: j.phases,
            started: count(state?.startTime) || Math.min(...wfAgents.map((a) => a.tail.birth), now),
            finished: state && !resumed.length ? ended : 0,
            agents: wfAgents,
            lastT,
            tokens: typeof state?.totalTokens === "number" ? state.totalTokens : undefined,
          });
        }
      }

      let tasks: Session["tasks"];
      const taskFiles = ls(path.join(CLAUDE, "tasks", sid)).filter((n) => n.endsWith(".json"));
      if (taskFiles.length) {
        const all = taskFiles.map((n) => ({ file: n.slice(0, -5), t: readJson(path.join(CLAUDE, "tasks", sid, n)) })).filter((x) => x.t && typeof x.t === "object" && !Array.isArray(x.t)); // a file that is not a JSON object is not a task
        const open = all.filter((x) => x.t.status !== "deleted");
        const text = (v: unknown) => (typeof v === "string" ? safeLine(capText(v, TASK_KEEP)) : "");
        const idOf = (x: { file: string; t: any }) => safeLine(typeof x.t.id === "string" || typeof x.t.id === "number" ? String(x.t.id) : x.file);
        // A task is blocked while something it waits on is still to finish. A blocker that is not on the list (never made, or deleted) holds nothing up.
        const unfinished = new Set(open.filter((x) => x.t.status !== "completed").map(idOf));
        // What the transcript says about each task: the freshest transcript first, should a session have more than one.
        const traced = [...mains].sort((p, q) => q.mtime - p.mtime);
        const items: TaskItem[] = open
          .map((x) => {
            const id = idOf(x);
            const status: TaskItem["status"] = x.t.status === "completed" || x.t.status === "in_progress" ? x.t.status : "pending";
            const trace = traced.map((m) => m.taskLog.get(id)).find(Boolean);
            return {
              id,
              subject: text(x.t.subject),
              activeForm: text(x.t.activeForm),
              status,
              blocked: Array.isArray(x.t.blockedBy) && x.t.blockedBy.some((b: unknown) => (typeof b === "string" || typeof b === "number") && unfinished.has(safeLine(String(b)))),
              description: typeof x.t.description === "string" ? safeLine(capText(x.t.description, TASK_DESC_KEEP)) : "",
              since: status === "in_progress" ? trace?.started : undefined,
              say: trace?.say,
            };
          })
          .sort(taskOrder);
        const current = items.find((t) => t.status === "in_progress"); // the first in task order, as the list shows it
        tasks = {
          done: open.filter((x) => x.t.status === "completed").length,
          doing: open.filter((x) => x.t.status === "in_progress").length,
          total: open.length,
          active: current ? current.activeForm || current.subject : "",
          items,
        };
      }

      let job: Session["job"];
      if (reg.jobId && /^[\w-]+$/.test(String(reg.jobId))) {
        const st = readJson(path.join(CLAUDE, "jobs", String(reg.jobId), "state.json"));
        if (st) job = { state: safeLine(st.state), detail: typeof st.detail === "string" ? safeText(capText(st.detail, NOTE_KEEP)) : "", needs: typeof st.needs === "string" ? safeText(capText(st.needs, NOTE_KEEP)) : "", tokens: typeof st.tokens === "number" && Number.isFinite(st.tokens) && st.tokens >= 0 ? st.tokens : undefined };
      }
      // A blocked job's wait starts when it began waiting on this question, and is not moved by later writes to its transcript (an
      // away summary, a title). Seen to change while the dashboard watched: its state file's time, written when it asked. Already
      // waiting when first seen: the earlier of that and its transcript's last write, as the state file may have been written since.
      const held = waitingSince.get(sid);
      if (job && jobWaiting(job)) {
        if (held?.needs === job.needs) job.since = held.since;
        else {
          let stamped = 0;
          try {
            stamped = fs.statSync(path.join(CLAUDE, "jobs", String(reg.jobId), "state.json")).mtimeMs;
          } catch {}
          const wrote = Math.max(0, ...mains.map(lastWriteOf));
          job.since = (held ? Math.min(stamped || now, now) : Math.min(stamped || Infinity, wrote || Infinity)) || undefined;
          if (job.since === Infinity) job.since = undefined;
        }
      }
      waitingSince.set(sid, { needs: job && jobWaiting(job) ? job.needs : "", since: job?.since ?? 0, used: scanSeq });

      const title = mains.map((m) => m.title).find(Boolean);
      const named = safeLine(reg.name && reg.name !== sid.slice(0, 8) ? reg.name : title || (reg.name ?? sid.slice(0, 8)));
      const startedAt = Number(reg.startedAt);
      sessions.push({
        sid,
        pid: reg.pid,
        name: named,
        kind: safeLine(reg.kind),
        status: safeLine(reg.status),
        cwd: safeLine(reg.cwd),
        startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : now,
        mains,
        agents,
        workflows,
        tasks,
        job,
        jobId: job ? String(reg.jobId) : undefined,
        side: sideOf(mains, now),
      });
      readOnce.add(sid);
      if (waited.has(sid)) justRead.add(sid);
    } catch {}
  }
  waited = nowWaiting;
  scanPending = nowWaiting.size > 0;
  // What was read for sessions and agents that have gone (their transcripts stay on disk, but no scan asks for them) is let go.
  for (const [file, t] of tails) if (scanSeq - t.used > FORGET_SCANS) tails.delete(file);
  for (const file of metaCache.keys()) if (!tails.has(file)) metaCache.delete(file);
  for (const [cache, entries] of [["journal", journalCache], ["dir", sessionDirCache], ["wait", waitingSince]] as const)
    for (const [key, e] of entries as Map<string, { used?: number }>) if (scanSeq - (e.used ?? 0) > FORGET_SCANS) entries.delete(key), void cache;
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

  if (!machine.memUsed) machine.memUsed = os.totalmem() - os.freemem();
  // vm_stat and ps run in the background, at most every two seconds, and their last answers are used: run here and
  // waited for, a slow ps (seconds, now and then) held the whole fleet, the page and the bot with it. --once waits.
  const sync = opt.once;
  if (!sync && (machineBusy || Date.now() - machineAt < 2000)) return;
  machineAt = Date.now();
  try {
    if (process.platform === "darwin") {
      // "free" memory on macOS is mostly cache; count what apps, the kernel and the compressor hold.
      machineBusy = true;
      runFor("vm_stat", [], sync, (vm = "") => {
        const page = Number(/page size of (\d+)/.exec(vm)?.[1] ?? 16384);
        const pages = (label: string) => Number(new RegExp(label + ":\\s+(\\d+)").exec(vm)?.[1] ?? 0);
        const used = (pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) * page;
        machine.memUsed = used > 0 ? used : os.totalmem() - os.freemem();
      });
    } else if (process.platform === "linux") {
      const info = fs.readFileSync("/proc/meminfo", "utf8");
      const kb = (label: string) => Number(new RegExp(label + ":\\s+(\\d+)").exec(info)?.[1] ?? 0);
      if (kb("MemAvailable")) machine.memUsed = (kb("MemTotal") - kb("MemAvailable")) * 1024;
    }
  } catch {}

  machineBusy = true;
  runFor("ps", ["-axo", "pid=,ppid=,pcpu=,rss=,comm="], sync, (ps) => {
    machineBusy = false;
    if (ps === undefined) return; // too slow or failed: the last sample stands
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
  });
}
let machineAt = 0, machineBusy = false;

/** CPU and memory of a process and everything it started. `known` is false when the process was not in the last sample. */
/** A session's process tree usage: measured here, or by the fleet on its own machine. */
export const useOf = (s: Session): { cpu: number; rss: number; known: boolean } => (s.remote ? s.remote.use ?? { cpu: 0, rss: 0, known: false } : treeUsage(s.pid));
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
  const memPct = (machine.memUsed / machine.memTotal) * 100;
  const HW = W >= 150 ? 24 : 12;
  const hist = machine.hist.slice(-HW);
  // CPU is a rate: its gauge, history and cores run the cool ramp and never turn warm. Memory is a limit.
  const coreGlyphs = machine.cores.map((c) => fg(coolTone(0.25 + (c / 100) * 0.75), BARS[Math.min(7, Math.floor((c / 100) * 8))])).join("");
  let line =
    fg(C.dim, " cpu ") + rateGauge(machine.cpu, 10) + fg(C.text, fit(`${Math.round(machine.cpu)}%`, 5, "r")) +
    "  " + spark([...new Array(HW - hist.length).fill(0), ...hist], 100, ...RAMP.machine) +
    (W >= 110 ? fg(C.dim, "  cores ") + coreGlyphs : "") +
    fg(C.dim, "   mem ") + gauge(memPct, 10, limitTone(memPct)) + fg(C.text, ` ${gb(machine.memUsed)} of ${gb(machine.memTotal)}`) +
    fg(C.dim, `   load ${machine.load.toFixed(1)}`);
  const usedW = 5 + 10 + 5 + 2 + HW + (W >= 110 ? 8 + machine.cores.length : 0) + 7 + 10 + width(` ${gb(machine.memUsed)} of ${gb(machine.memTotal)}`) + width(`   load ${machine.load.toFixed(1)}`);
  const topText = topProcs(4).map((p) => `${[...p.name].slice(0, 18).join("")} ${Math.round(p.cpu)}%`).join(" · ");
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
/**
 * What can be done about a reason, for the one dim line under the account block: the fullest wording
 * that fits in `w` cells, so the command itself is never the part that is cut. Standard remedies, not tested here.
 */
export function usageRemedy(reason: string, w = Infinity): string {
  if (reason !== REASON.keychainRemote) return "";
  const wordings = [`${UNLOCK}  ·  or start fleet in a tmux begun on the Mac itself`, `${UNLOCK} · or use a tmux started on the Mac`, UNLOCK, UNLOCK.replace(/^run: /, "")];
  return wordings.find((x) => width(x) <= w) ?? fit(UNLOCK, w, "l", true).trimEnd();
}
const UNLOCK = "run: security unlock-keychain ~/Library/Keychains/login.keychain-db";
/** A reason in its exact wording, then shorter ones that say the same, for a block too narrow for it: never cut mid-word. */
export const reasonForms = (reason: string): string[] => (reason === REASON.keychainRemote ? [reason, "keychain: closed over ssh/mosh", "keychain closed over ssh"] : [reason]);
/**
 * The dim line under the account block while the usage read fails for a reason you can do something
 * about (the line stays as long as the reason does, so the header keeps its height as figures come and
 * go). With somebody else's current figures in the block it says whose they are and why, and no command:
 * that arrangement is working. Otherwise it gives the remedy, led by the reason when the block above has
 * no room to say it; where both do not fit, the reason wins and the line ends "u retries".
 */
export function usageNote(a: AccountView, w: number, reasonShown: boolean): string {
  if (!usageRemedy(a.reason)) return "";
  const forms = reasonForms(a.reason);
  const sep = ` ${ICON.sep} `;
  if (a.kind === "current") return firstFit([...forms.map((f) => `shared figures${sep}${f}${sep}u retries`), ...forms.map((f) => `shared figures${sep}${f}`)], w);
  if (reasonShown) return usageRemedy(a.reason, w);
  return firstFit([`${forms[0]}${sep}${UNLOCK} · or use a tmux started on the Mac`, ...forms.map((f) => `${f}${sep}${UNLOCK}`), ...forms.map((f) => `${f}${sep}${UNLOCK.replace(/^run: /, "")}`), ...forms.map((f) => `${f}${sep}u retries`)], w);
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

export interface Login {
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
/**
 * The stored login, or the exact reason there is none. By default the keychain call is the one the dashboard has always
 * made; another account's folder (key u) passes its own keychain entries, tried in turn while each is "not found", and its own login file.
 */
export function readLogin(services = ["Claude Code-credentials"], loginFile = path.join(claudeHome(), ".credentials.json")): { login: Login } | { reason: string } {
  let k: KeychainOutcome | undefined;
  let fromKeychain: Login | undefined;
  if (process.platform === "darwin") {
    k = { status: 127, stderr: "", timedOut: false, parse: "empty" };
    try {
      for (const service of services) {
        const r = spawnSync("security", ["find-generic-password", "-s", service, "-w"], { encoding: "utf8", timeout: 5000 });
        const parsed: { parse: LoginParse; login?: Login } = r.status === 0 ? parseLogin(r.stdout ?? "") : { parse: "empty" };
        const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || (r.status === null && r.signal === "SIGTERM");
        k = { status: r.error && !timedOut ? 127 : r.status, stderr: String(r.stderr ?? ""), timedOut, parse: parsed.parse };
        fromKeychain = parsed.login;
        if (keychainReason(k, false) !== REASON.keychainMissing) break;
      }
    } catch {}
  }
  let f: FileOutcome = "missing";
  let fromFile: Login | undefined;
  if (!fromKeychain) {
    try {
      const file = loginFile;
      if (!fs.statSync(file).isFile()) throw new Error("not a file"); // a named pipe here would block the dashboard for good
      const parsed = parseLogin(fs.readFileSync(file, "utf8"));
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
/**
 * Whether a path is ours: not a link, owned by this user, and not writable by everyone. The shared file and its
 * folder must be, or another account on the machine could plant figures, or have the write land somewhere else.
 */
function ours(p: string): boolean {
  try {
    const st = fs.lstatSync(p);
    return !st.isSymbolicLink() && (process.getuid === undefined || st.uid === process.getuid()) && (st.mode & 0o002) === 0;
  } catch {
    return false;
  }
}
/**
 * Write it for other dashboards: mode 0600, and atomically, so a reader never sees half a file. The folder is
 * made readable only by you; if it already exists and is not ours (a link, someone else's, open to everyone),
 * nothing is written. The temporary file has an unguessable name and is created only if nothing is there, so a
 * file or a link planted in its place cannot be written through.
 */
export function writeSharedUsage(figures: unknown, fetchedAt: number, file = sharedUsagePath()): boolean {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (!ours(path.dirname(file))) return false;
    fs.writeFileSync(tmp, sharedUsageContent(figures, fetchedAt), { mode: 0o600, flag: "wx" });
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
/** Read figures another dashboard shared: only from a file, and a folder, that are ours. */
export function readSharedUsage(file = sharedUsagePath()): Reading | undefined {
  if (!ours(file) || !ours(path.dirname(file))) return undefined;
  const o = readJson(file);
  if (!o || typeof o.fetchedAt !== "number") return undefined;
  return { figures: figuresOnly(o), fetchedAt: o.fetchedAt };
}
/** Read the figures Claude Code itself last fetched: the cachedUsageUtilization entry of ~/.claude.json, and no other key. */
export function readClaudeUsage(file = path.join(process.env.FLEET_HOME || process.env.AGENT_FLEET_HOME || os.homedir(), ".claude.json")): Reading | undefined {
  const c = readJson(file, 1 << 30)?.cachedUsageUtilization; // Claude Code's own file can grow large: only devices and pipes are refused
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
  return askAnthropic(readLogin(), now);
}
/** Ask Anthropic for the figures with a login just read. The login is used for this one request and goes nowhere else. */
export async function askAnthropic(found: { login: Login } | { reason: string }, now: number): Promise<Reading | { reason: string }> {
  if ("reason" in found) return found;
  if (found.login.expiresAt && found.login.expiresAt < Date.now()) return { reason: REASON.expired };
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${found.login.token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10_000),
      redirect: "error", // the login goes to this address and nowhere else, whatever the runtime does with a redirect
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
  // Figures stamped more than a minute ahead of this clock (a damaged file, a clock that was set back) are not believed: they would count as current for ever.
  const sane = (r: Reading | undefined) => (r && r.fetchedAt <= now + 60_000 ? r : undefined);
  const shared = sane(fixture ?? readSharedUsage());
  const claude = sane(readClaudeUsage());
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
/**
 * After the clock is set back, nothing may wait for the old time to come round: figures and a seen mark
 * stamped more than a minute ahead are brought back to now, and a read due later than the longest back-off is due now.
 */
export function steadyClock(now: number) {
  if (usage.fetchedAt > now + 60_000) usage.fetchedAt = now;
  if (usage.nextTry > now + 31 * 60_000) usage.nextTry = now;
  if (usage.sharedAt > now + 60_000) usage.sharedAt = 0;
  if (seen.at > now + 60_000) seen.at = now;
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

export const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);
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
    const why = a.reason ? firstFit(reasonForms(a.reason).map((f) => `no reading yet: ${f} · next try ${hhmm(a.nextTry)} · u retries`), W - 10) : a.busy || !usage.at ? "fetching usage…" : "no reading yet";
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
    const figure = figureTone(l.pct);
    const pctText = fg(stale ? C.dim : figure.color, ` ${Math.round(l.pct)}%`);
    line += fg(C.dim, `  ${label} `) + gauge(l.pct, GW, stale ? C.dim : limitTone(l.pct)) + (figure.bold && !stale ? bold(pctText) : pctText) + fg(C.dim, resets ? " · " + resets : "");
    used += width(text);
  }
  // While a read is failing, say so before anything else that is optional.
  if (stale || a.reason) {
    const lead = stale ? `as of ${hhmm(a.asOf)}` : "shared figures";
    const why = firstFit([...(a.reason ? reasonForms(a.reason).map((f) => `(${lead} · ${f})`) : []), `(${lead})`], Math.min(W - 1 - used - 3, 70)).trimEnd();
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
/**
 * A far card's chart: `n` bars of `w` cells each in `cells` cells, so that no bar is shorter than the two
 * seconds between data reads. One bar a cell, as everywhere else, unless the window is too short for that;
 * then fewer, wider bars, and the strip steps at most once a read.
 */
export function farBars(cells: number, windowMs: number): { n: number; w: number } {
  let w = 1;
  while (Math.floor(cells / w) > 1 && windowMs / Math.floor(cells / w) < 2000) w++;
  return { n: Math.max(1, Math.floor(cells / w)), w };
}
/** Bars in a compact row's sparkline at a terminal `W` cells wide. */
const stripBars = (W: number) => Math.min(32, Math.max(12, Math.floor(W / 6)));
/**
 * The window a frame counts in: what "in the window" means for every total, masthead tile and "recent"
 * test on the screen, so they agree with the sparklines they sit beside. Detail and far mode count in
 * the lane's window; compact mode in its rows' own, shorter strips.
 */
export const frameWindow = (now: number, W: number, _mode: Mode = opt.mode): Win => laneWindow(now, W); // every mode draws its sessions on the detail view's lane
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

/** A question or a now-line as one line of plain text: paired marks and link syntax go, as in a reply; a lone > # * or _ stays, as written. */
const headText = (s: string): string => flatLines(s, false).join(" ");

export interface Facts {
  main?: Tail;
  needs: string; // non-empty when the session is waiting on the person
  yourTurn: boolean; // finished its turn and is idle
  finished: boolean; // a background job that says it is done
  working: boolean; // busy, or a background job that says it is working
  now: string; // one-line summary of what it is doing: the now-line
}
/**
 * Whether a background job is waiting on you: it records a question (`needs`) and has not finished. The question is
 * recorded while the job may still say "working", and cleared as soon as it is answered. "blocked" alone is not
 * you: a job says it while it waits on its own background tasks (workflows, commands, monitors), with no question.
 */
export const jobWaiting = (job: { state: string; needs: string }): boolean => !!job.needs && !["done", "failed", "stopped", "error", "cancelled"].includes(job.state);
export function factsOf(s: Session): Facts {
  const main = [...s.mains].sort((x, y) => y.mtime - x.mtime)[0];
  const ask = main && pendingOf(main)?.name === "AskUserQuestion" ? pendingOf(main) : undefined;
  const needs = ask
    ? ask.hint || "has a question for you"
    : s.job && jobWaiting(s.job)
      ? s.job.needs
      : "";
  const idle = s.status !== "busy";
  // A background job says so itself; otherwise: idle, and Claude spoke last.
  const yourTurn = !needs && (s.job ? s.job.state === "done" : idle && !!main?.say && (!main.ask || main.say.t >= main.ask.t));
  // The now-line is the job's own detail, or the away summary when that is newer than the last prompt.
  const summary = main?.summary && (main.summaryT ?? 0) >= (main.ask?.t ?? 0) ? main.summary : "";
  return { main, needs: headText(needs), yourTurn, finished: s.job?.state === "done", working: s.status === "busy" || s.job?.state === "working", now: headText(s.job?.detail || summary) };
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
  if (state === "justDone") return heldOpen.get(s.sid) ?? 0;
  const m = f.main;
  const lastWrite = m ? lastWriteOf(m) : 0;
  const ask = m && pendingOf(m);
  if (state === "needs") return ask?.name === "AskUserQuestion" ? ask.t : s.job?.since || lastWrite;
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

/** The first line of a reply as plain text, as an earlier reply is flattened: paired marks and link syntax gone, a table row as its cells, a bullet's mark dropped. */
export function firstLine(text: string): string {
  return (flatLines(text, false)[0] ?? "").replace(new RegExp(`^${ICON.bullet} `), "");
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
  // Your prompt, as you typed it.
  const typed = oneLine(m?.ask?.text || m?.lastPrompt || "");
  const prompt = (): Subheading | undefined => (typed ? { source: "prompt", text: typed, t: m?.ask?.t } : undefined);
  if (s.loading) return { source: "now", text: "reading…" };
  if (state === "needs") return { source: "question", text: f.needs };
  if (state === "working" || state === "stalled") return nowLine() ?? (s.tasks?.active ? { source: "task", text: s.tasks.active } : undefined) ?? prompt() ?? reply() ?? { source: "none", text: "" };
  // A quiet session with no reply and no now-line: better its last prompt than an empty row.
  return reply() ?? nowLine() ?? prompt() ?? { source: "none", text: "" };
}

// ───────────────────────── stall watch ─────────────────────────
//
// The third state worth knowing about: not working, not asking, just stuck. The evidence is
// circumstantial (a tool may be waiting on another machine), so the screen words it as a question.

const STALL_CPU = 1; // percent of one core: a process tree under this is idle
const STALL_HOLD_CPU = 5; // a stall already on show stays until the tree is busier than this, so a tree idling either side of 1% does not make the label blink

/**
 * A thread (the main thread or an agent) is stalled when it has had a tool call outstanding and has
 * written nothing for `stallMs`, while the session's whole process tree is under 1% CPU. `treeCpu` is
 * undefined when the session's process was not in the last sample; then nothing is claimed.
 */
export function threadStalled(th: { pending: boolean; lastWrite: number }, treeCpu: number | undefined, now: number, stallMs: number, cpuLimit = STALL_CPU): boolean {
  return stallMs > 0 && th.pending && treeCpu !== undefined && treeCpu < cpuLimit && th.lastWrite > 0 && now - th.lastWrite >= stallMs;
}
/** A busy session is stalled when no thread at all has written for `stallMs` at under 1% CPU. */
export function sessionStalled(busy: boolean, lastWrite: number, treeCpu: number | undefined, now: number, stallMs: number, cpuLimit = STALL_CPU): boolean {
  return stallMs > 0 && busy && treeCpu !== undefined && treeCpu < cpuLimit && lastWrite > 0 && now - lastWrite >= stallMs;
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
/** What was stalled at the last scan: each thing's name ("sid" for a session, "sid/thread" for a thread) with when it last wrote. holdStalls() keeps it. */
const stallHeld = new Map<string, number>();
/**
 * The stall watch's verdict on one session. Only a working session can be stalled: one that needs you
 * or has finished its turn is waiting on you, not stuck. The main thread waits on its agents, so it
 * counts as stalled only when they have all gone quiet too. Something `held` (stalled at the last scan,
 * and silent since) stays stalled until the tree is properly busy again, not merely over 1%.
 */
export function stallOf(s: Session, f: Facts, now: number, treeCpu: number | undefined = s.remote ? (s.remote.use?.known ? s.remote.use.cpu : undefined) : treeCpuOf(s.pid), stallMs = opt.stallMin * 60_000, held: ReadonlyMap<string, number> = stallHeld): Stall {
  if (stallMs <= 0 || f.needs || !f.working) return NO_STALL;
  const agents = [...s.agents, ...s.workflows.filter((w) => w.status === "running").flatMap((w) => w.agents)];
  const lastWrite = Math.max(0, ...tailsOf(s).map(lastWriteOf));
  const cpuLimit = (key: string, wrote: number) => (held.get(key) === wrote ? STALL_HOLD_CPU : STALL_CPU);
  const session = sessionStalled(true, lastWrite, treeCpu, now, stallMs, cpuLimit(s.sid, lastWrite));
  const threads: string[] = [];
  let since = session ? lastWrite : Infinity;
  if (session && f.main && pendingTool(f.main)) threads.push("main");
  // A transcript left on a tool call (an interrupted agent, one from an earlier run of a resumed session) is not stuck work once the
  // session has moved on since it last wrote: you have typed a new prompt since, or it was written before the session's current
  // process started, so nothing in it can still be running. Anything else silent on a tool call is a candidate, background agents included.
  const movedOn = (_a: Agent, wrote: number) => (f.main?.ask?.t ?? 0) > wrote || wrote < s.startedAt;
  for (const a of agents) {
    const wrote = lastWriteOf(a.tail);
    if (a.done || movedOn(a, wrote) || !threadStalled({ pending: pendingTool(a.tail), lastWrite: wrote }, treeCpu, now, stallMs, cpuLimit(`${s.sid}/${a.id}`, wrote))) continue;
    threads.push(a.id);
    since = Math.min(since, wrote);
  }
  if (!session && !threads.length) return NO_STALL;
  return { session, threads, count: threads.length || 1, since };
}
/** Remember what is stalled as of this scan, for the next one's verdicts. Called once a scan, after the machine has been sampled. */
export function holdStalls(sessions: Session[], now: number, held: Map<string, number> = stallHeld) {
  const next: [string, number][] = [];
  for (const s of sessions) {
    const st = stallOf(s, factsOf(s), now, undefined, undefined, held);
    if (st.session) next.push([s.sid, Math.max(0, ...tailsOf(s).map(lastWriteOf))]);
    for (const a of [...s.agents, ...s.workflows.flatMap((w) => w.agents)]) if (st.threads.includes(a.id)) next.push([`${s.sid}/${a.id}`, lastWriteOf(a.tail)]);
  }
  held.clear();
  for (const [key, wrote] of next) held.set(key, wrote);
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
/** The members of `current` that were not in `known`; `known` is then brought up to date. */
export function newSince(known: Set<string>, current: string[]): string[] {
  const fresh = current.filter((k) => !known.has(k));
  known.clear();
  for (const k of current) known.add(k);
  return fresh;
}
/**
 * The sessions that have started waiting on the person since the last scan, for the bell. `current` is
 * every waiting session with when it asked. A question is known by when it was asked, so a session that
 * is missing from one scan (its registry file caught half-written) and back in the next has not asked again.
 */
export function newAsks(waiting: Set<string>, asked: Map<string, number>, current: [sid: string, since: number][]): string[] {
  const fresh = newSince(waiting, current.map(([sid]) => sid)).filter((sid) => asked.get(sid) !== current.find((c) => c[0] === sid)![1]);
  for (const [sid, since] of current) asked.set(sid, since);
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
  clearedAt: 0, // the last press of space: workflows that ended badly before it are cleared away
  events: [] as FleetEvent[], // everything new since the mark, oldest first
  known: new Map<string, string>(), // what each thing looked like at the last scan
  primed: false, // false until the first scan has set the baseline
};
/** "Seen it": move the mark to now and forget what came before it. */
export function markSeen(now: number) {
  seen.at = now;
  seen.clearedAt = now;
  seen.events = [];
  heldOpen.clear(); // the finished sessions you have now seen go quietly
  for (const sid of quietSince.keys()) wasShown.delete(sid);
  quietSince.clear();
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
    for (const wf of s.workflows) {
      const key = `wf:${s.sid}/${wf.id}`;
      // A stop is only inferred when a workflow goes quiet without a state file; if it carries on or completes after all, it did not fail.
      if (wf.status === "running" || wf.status === "completed") seen.events = seen.events.filter((e) => !(e.kind === "failed" && e.key === key));
      track(key, wf.status, s.sid, wf.status === "running" ? undefined : wf.status === "completed" ? "workflowDone" : "failed", wf.finished || wf.lastT);
    }
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
  if (s.loading) return false; // being read: shown, so the screen fills in where it will stay
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
/** `since` is where the window begins; render() passes its frame's. Left out, it is the start of the wide lane's window, which sits on clock edges, so the counts do not drift from one second to the next. */
export function fleetCounts(sessions: Session[], now: number, since = frameWindow(now, 150, "detail").start): FleetCounts {
  const c: FleetCounts = { sessions: sessions.length, needs: 0, stalled: 0, working: 0, idle: 0, agents: 0, workflows: 0 };
  for (const s of sessions) {
    const f = factsOf(s);
    const state = sessionState(f, stallOf(s, f, now).count > 0);
    if (state === "needs") c.needs++;
    else if (isQuiet(s, f, since)) {
      if (!heldOpen.has(s.sid)) c.idle++; // a finished session still on show is not kept off the screen
    }
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
  if (now - lastWriteOf(a.tail) < ACTIVE_MS) return "active";
  if (pendingTool(a.tail)) return "tool";
  return "quiet";
}
/** The order threads are listed in: live, in a tool, quiet, finished. */
const AGENT_ORDER: Record<AgentState, number> = { active: 0, tool: 1, quiet: 2, done: 3 };

export interface Group {
  wf?: Workflow;
  rows: Agent[];
  hidden: number;
}
export interface View {
  s: Session;
  groups: Group[]; // workflows first, then one group of standalone agents
  doneCount: number; // agents that finished in the window, for the "n agents finished" line
  showTasks: boolean; // it has a task list
  showMain: boolean; // it is busy, so its main thread is a row of the roster
  showNeeds: boolean; // it is waiting on the person
  facts: Facts;
  state: SessionState;
  stall: Stall; // the stall watch's verdict: stall.count things are stalled in this session
  quiet: boolean; // nobody needs to look at it: kept off the screen unless --all
  lastT: number;
}

/** Every session as the screen shows it, in sort order. `since` is where the window begins, as for fleetCounts(). */
export function buildViews(sessions: Session[], now: number, since = frameWindow(now, 150, "detail").start): View[] {
  const recent = (a: Agent) => lastWriteOf(a.tail) >= since;
  const pick = (list: Agent[], stuck: string[]) =>
    list
      .filter((a) => (recent(a) || stuck.includes(a.id)) && (opt.showDone || !a.done)) // a stalled agent has been silent longer than a short window, and is the one to look at
      .sort((a, b) => Number(stuck.includes(b.id)) - Number(stuck.includes(a.id)) || AGENT_ORDER[stateOf(a, now)] - AGENT_ORDER[stateOf(b, now)] || a.tail.birth - b.tail.birth);

  return sessions
    .map((s) => {
      const facts = factsOf(s);
      const stall = stallOf(s, facts, now);
      const groups: Group[] = [];
      for (const wf of s.workflows) {
        const live = wf.status === "running" && (wf.lastT >= since || wf.agents.some((a) => stall.threads.includes(a.id)));
        const justFinished = wf.status !== "running" && Math.max(wf.finished, wf.lastT) >= since;
        // Killed, stopped or failed before your last space: cleared away; one resumed since writes again, and is back.
        const cleared = wfOutcome(wf) === "failed" && Math.max(wf.finished, wf.lastT) <= seen.clearedAt;
        if ((live || justFinished) && !cleared) groups.push({ wf, rows: pick(wf.agents, stall.threads), hidden: 0 }); // a stalled agent is the last to be folded away
      }
      groups.sort((a, b) => a.wf!.started - b.wf!.started);
      const solo = pick(s.agents, stall.threads);
      if (solo.length) groups.push({ rows: solo, hidden: 0 });
      const doneCount = opt.showDone ? 0 : s.agents.filter((a) => a.done && recent(a)).length;
      const lastT = Math.max(0, ...s.mains.map((m) => m.mtime), ...s.agents.map((a) => a.tail.mtime));
      return {
        s,
        groups,
        doneCount,
        showTasks: !!s.tasks && s.tasks.total > 0,
        showMain: s.status === "busy" && s.mains.length > 0,
        showNeeds: !!facts.needs,
        facts,
        state: heldOpen.has(s.sid) && isQuiet(s, facts, since) ? "justDone" : sessionState(facts, stall.count > 0),
        stall,
        quiet: isQuiet(s, facts, since),
        lastT,
      };
    })
    .sort(byState);
}

/** Kept off the screen unless --all: see isQuiet(). */
/**
 * Sessions that finished while you watched: each has its party, and stays on the screen until you press space (seen
 * it), rather than vanishing the moment it goes quiet. Noted on each scan by noteFinished().
 */
export const heldOpen = new Map<string, number>();
const wasShown = new Set<string>();
const quietSince = new Map<string, number>(); // when each shown session went quiet: it has finished once it stays so
export const FINISH_CONFIRM_MS = 8000; // picking a session up can show it as done for a moment: that is not a finish
let finishPrimed = false;
export function noteFinished(sessions: Session[], now: number): string[] {
  const finished: string[] = [];
  const live = new Set(sessions.map((s) => s.sid));
  for (const v of buildViews(sessions, now)) {
    const sid = v.s.sid;
    if (!v.quiet) {
      heldOpen.delete(sid); // busy again: an ordinary session once more
      quietSince.delete(sid);
      wasShown.add(sid);
      continue;
    }
    if (!finishPrimed || !wasShown.has(sid)) continue; // quiet since before fleet looked, or already seen off
    if (heldOpen.has(sid)) continue;
    const quietAt = quietSince.get(sid) ?? now;
    quietSince.set(sid, quietAt);
    if (now - quietAt < FINISH_CONFIRM_MS) continue; // not yet: it may only be between two turns
    heldOpen.set(sid, quietAt);
    parties.set(sid, { text: "finished", at: now });
    finished.push(sid);
  }
  for (const sid of heldOpen.keys()) if (!live.has(sid)) heldOpen.delete(sid);
  for (const m of [wasShown, quietSince]) for (const sid of m.keys()) if (!live.has(sid)) m.delete(sid);
  finishPrimed = true;
  return finished;
}
export const isHidden = (v: View): boolean => v.quiet && !heldOpen.has(v.s.sid) && !quietSince.has(v.s.sid);
/**
 * The session tab moves the focus to from `current` (null: none is focused): the next one down the
 * screen, in the order the screen lists them, so the first press lands on whoever needs you. Sessions
 * kept off the screen are passed over. After the last one the focus is given up.
 */
export function nextFocus(sessions: Session[], now: number, cols: number, current: string | null): string | null {
  const ids = buildViews(sessions, now, frameWindow(now, Math.max(60, cols)).start).filter((v) => opt.showAll || !isHidden(v) || v.s.sid === current).map((v) => v.s.sid);
  return ids[(current ? ids.indexOf(current) : -1) + 1] ?? null;
}

// ───────────────────────── the detail view ─────────────────────────
//
// Detail mode's sessions. Each is a small card (a title row and a subheading row, as far mode draws
// them) and, under it, what was said, the tasks and every thread at work. There are no tree lines and
// no word labels: a thick rail marks the head rows and a thin one the body, an icon names each speaker,
// and every sparkline sits in the one lane. When the screen is short the blocks give rows up in a fixed
// order (the ladder, below) rather than losing whatever happens to be at the bottom.

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
export function inlineSegs(src: string, tone: ReplyTone = BRIGHT, underscores = true): Seg[] {
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
    if (ch === "*" || (ch === "_" && underscores) || ch === "~") {
      const mark = ["***", "**", "__", "~~", "*", "_"].find((m) => src.startsWith(m, i));
      const end = mark ? closeOf(mark, i) : -1;
      if (mark && end > 0) {
        flush();
        const strong = mark.length >= 2 && mark !== "~~";
        for (const [text, color, isBold] of inlineSegs(src.slice(i + mark.length, end), tone, underscores)) out.push(strong ? [text, color === tone.text ? tone.strong : color, true] : [text, color, isBold]);
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
        if (label.trim()) out.push(...inlineSegs(label, tone, underscores));
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
    return wrap(oneLine(text), Math.max(8, w)).map((line): Seg[] => [[line, tone.text]]);
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

/**
 * Markdown as plain lines, one per line of the source that says something: paired marks, fences, rules and
 * table rules gone, a table row as its cells, bullets kept as •. `underscores` false leaves _ and __ as
 * typed, for the one-line head rows, where snake_case and __init__ are likelier than emphasis.
 */
function flatLines(text: string, underscores = true): string[] {
  const out: string[] = [];
  let code = false;
  for (const raw of text.replace(NO_COMMENTS, "").split("\n")) {
    const line = raw.trim();
    if (FENCE.test(line)) code = !code;
    else if (code) out.push(line);
    else if (line && !RULE.test(line) && !(line.includes("|") && TABLE_RULE.test(line)))
      out.push(segsText(inlineSegs((line.startsWith("|") ? line.replace(/^\|\s*|\s*\|$/g, "").replace(/\s*\|\s*/g, ` ${ICON.sep} `) : line).replace(/^#{1,6}\s+/, "").replace(/^>+\s?/, "").replace(/^[-*+]\s+/, ICON.bullet + " "), BRIGHT, underscores)));
  }
  return out.map(oneLine).filter(Boolean);
}
/** A reply as one plain line, for an earlier reply. */
export const flatReply = (text: string): string => flatLines(text).join(" ");

/**
 * The rows of a reply that fit in `cap`, kept from the top. When rows are hidden, a dim "… +N lines" is
 * right-aligned at the end of the measure on the last row before the cut, and that row's text is
 * shortened at a word boundary to make room. With 3 rows or more the reply ends with its closing
 * paragraph, because that is its conclusion or its question: up to 3 rows of it (1 at a cap of 3, 2 at
 * 4), from its start, the last ending in … when there is more; the mark then sits on the row above it.
 */
export function clipReply(rows: Seg[][], cap: number, w: number): { segs: Seg[]; mark?: string }[] {
  if (cap <= 0) return [];
  if (rows.length <= cap) return rows.map((segs) => ({ segs }));
  const shorten = (segs: Seg[], room: number): Seg[] => (segsWidth(segs) <= room ? segs : takeSegs(segs, clipWords(segsText(segs), room).length));
  const hidden = rows.length - cap;
  let last = rows.length - 1; // where the final paragraph starts
  while (last > 0 && runsOn.has(rows[last])) last--;
  const keep = cap >= 3 ? Math.min(rows.length - last, 3, cap - 2) : 0; // rows of it to show
  const closing = keep > 0 && last >= cap - keep; // not when the final paragraph is already on show from its start
  const final = rows.slice(last, last + keep);
  if (closing && last + keep < rows.length) final[keep - 1] = [...shorten(final[keep - 1], w - 2), [` ${ICON.cut}`, C.dim]];
  const shown = closing ? [...rows.slice(0, cap - keep), ...final] : rows.slice(0, cap);
  const markAt = closing ? cap - keep - 1 : shown.length - 1;
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
  tasks: boolean; // the tasks row: the strip and the count
  taskList: number; // entries of the task list under it, the last of them "… n more tasks" when it is cut short; 0: no list. Each is a row while the list is cut short.
  taskScope: "all" | "open" | "doing"; // the tasks it lists: every one (focus), those not done, or only those in progress
  taskWrap: boolean; // each task's text on as many rows as it takes (focus), rather than one row cut with …
  taskDetail: "all" | "doing" | "none"; // the line under each listed task: under every one, under those in progress only, or under none
  taskDetailRows: number; // how many rows each of those lines may take: 3 while there is room, then 1
  airy: boolean; // blank rows between messages, before the tasks and before the threads: the first thing to go
  trouble: boolean; // the row of tool calls that failed in the last ten minutes
  bgRow: boolean; // the row of background commands still running
  prs: boolean; // the row of its pull requests
  changes: boolean; // the row of files changed and the git checkout's state
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
  sideLeft?: Set<SideKey>; // wide screens: the side facts that did not fit in the column beside the conversation, drawn as rows on the left instead
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
  taskRoom: number; // cells for a task's text: the list hangs 2 cells in, and ends where the conversation does
  folded: boolean; // gone into the "… n more" line
}
const EARLIER_TONE = mix(C.cyan, C.faint, 0.5); // ◇: cyan mixed halfway to faint

export function blockOf(v: View, g: Grid, now: number, win: Win, focus = false): Block {
  const { s, facts: f, state } = v;
  const m = f.main;
  const body = focus || !isHidden(v);
  const brief = opt.mode === "compact" && !focus; // compact: no conversation and no lines under tasks (focus shows them all)
  const subW = g.textEnd - g.icon + 1;
  const typed = oneLine(m?.ask?.text || m?.lastPrompt || "");
  const typedAt = m?.ask?.text ? m.ask.t : undefined;
  const sub = subheading(s, f, state);
  // The question wraps to three rows at most, the last cut with …; in focus it is shown whole, as everything else is.
  const question = state === "needs" ? wrap(f.needs, subW) : [];
  if (!focus && question.length > 3) question.splice(2, question.length, cutTo(question.slice(2).join(" "), subW));
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
      now: body && !!nowLine && !brief,
      prompt: prompt && !brief ? (focus ? Math.min(2, prompt.lines.length) : 1) : 0,
      earlier: earlier.map(() => (brief ? 0 : focus ? Infinity : 2)),
      reply: brief ? 0 : focus ? Infinity : 10,
      tasks: body && v.showTasks,
      taskList: Infinity,
      taskScope: focus ? "all" : "open",
      taskWrap: focus,
      taskDetail: brief ? "none" : "all",
      taskDetailRows: 3,
      airy: body && !brief && opt.airy,
      trouble: body,
      bgRow: body,
      prs: body,
      changes: body,
      ctx: body,
      main: body && v.showMain && !!m,
      done: body && v.doneCount > 0,
      agents: Infinity,
      fold: false,
      roster: body,
      question: focus ? Infinity : 3,
    },
    taskRoom: g.text + g.measure - (g.childIcon + 2),
    folded: false,
  };
}

/** A row of the left stack: who spoke, what was said, how long ago. */
interface StackRow {
  icon?: Seg;
  iconAt?: number; // the column its icon is drawn at, when that is not the icon column
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
  rows.push(...sideRows(b, g, now));
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
    // New since you last looked: a bold white ◇ and "new" for its age, as the newest reply gets, so every reply the digest counts can be found.
    const fresh = isNew(e.t);
    said.push({ t: e.t, rows: lines.map((segs, i) => ({ icon: i ? undefined : fresh ? [ICON.earlier, C.white, true] : [ICON.earlier, EARLIER_TONE], segs, age: i ? undefined : fresh ? ["new", C.white, true] : [ago(now - e.t), C.dim] })) });
  });
  if (k.reply > 0 && b.newest) {
    const { rows: all, t } = b.newest;
    // New since you last looked: a bold white ◆, and the word "new" where its age would be.
    const fresh = isNew(t);
    said.push({ t, rows: clipReply(all, k.reply, g.measure).map((row, i) => ({ icon: i ? undefined : [ICON.claude, fresh ? C.white : C.cyan, fresh], segs: row.segs, mark: row.mark, age: i ? undefined : fresh ? ["new", C.white, true] : [ago(now - t), C.dim] })) });
  }
  // With room to spare, a blank row between one message and the next, and before the tasks.
  said.sort((x, y) => x.t - y.t).forEach((item, i) => rows.push(...(k.airy && i ? [{ segs: [] }] : []), ...item.rows));
  const tasks = b.v.s.tasks;
  if (k.tasks && tasks) {
    if (k.airy && rows.length) rows.push({ segs: [] });
    const end = g.wide ? g.textEnd : g.figEnd;
    const list = taskListOf(b);
    // The task in progress is named once on the tasks row: after the count, unless the list has a row for it.
    const named = !!list.lead && list.shown.includes(list.lead);
    const count = `${tasks.done}/${tasks.total}`;
    const segs: Seg[] =
      tasks.done >= tasks.total
        ? [[ICON.done + " ", C.done], [`${count} tasks done`, C.dim]]
        : [...stepStrip(tasks.done, tasks.doing, tasks.total), [`  ${count}`, C.text], ...(tasks.active && !named ? [[`  ${tasks.active}`, C.dim] as Seg] : [])];
    rows.push({ at: g.icon, segs: fitSegs(segs, end - g.icon + 1) });
    // The list hangs 2 cells in under the tasks row, as a workflow's agents do under it, so it does not read as more threads.
    const at = g.childIcon + 2;
    for (const t of list.shown) {
      const [icon, tone]: [Seg, RGB] = t.status === "in_progress" ? [[ICON.progress, C.white, true], C.text] : t.status === "completed" ? [[ICON.done, C.done], C.dim] : [[ICON.idle, C.dim], C.dim];
      // A blocked task keeps its " · blocked" when the subject is cut, on the last of its rows.
      const mark: Seg[] = t.status === "pending" && t.blocked ? [[` ${ICON.sep} blocked`, C.faint]] : [];
      const lines = taskLines(t, b.taskRoom, k.taskWrap);
      // A task in progress says how long it has been, in the ages column, when its transcript knows.
      const since: Seg | undefined = t.status === "in_progress" && t.since ? [ago(now - t.since), C.dim] : undefined;
      lines.forEach((line, i) => rows.push({ icon: i ? undefined : icon, iconAt: g.childIcon, at, segs: [[line, tone], ...(i === lines.length - 1 ? mark : [])], age: i ? undefined : since }));
      // Under it, while there is room: the latest thing Claude wrote about it (◇, with its age), or what it is for.
      const d = taskDetailOf(b, t);
      d?.lines.forEach((line, i) => rows.push({ icon: i || !d.say ? undefined : [ICON.earlier, EARLIER_TONE], iconAt: at, at: at + 2, segs: [[line, C.dim]], age: i || !d.say ? undefined : [ago(now - d.say.t), C.dim] }));
    }
    if (list.more) rows.push({ at: g.childIcon, segs: [[`${ICON.cut} ${list.more} more task${list.more === 1 ? "" : "s"}`, C.dim]] });
  }
  return rows;
}

// ── celebrations ──

/** A session celebrating something it just finished: its title shimmers for a few seconds. */
export const parties = new Map<string, { text: string; at: number }>();
export const PARTY_MS = 8_000;
const partyWas = { pr: new Map<string, string>(), wf: new Map<string, string>(), tasks: new Map<string, boolean>(), ready: false };
/** How a pull request stands, for telling when it has just merged or just gone green. */
const prMood = (st: PrState | undefined) => (!st ? "" : st.state === "MERGED" ? "merged" : st.state === "OPEN" && !st.fail && !st.pending && st.pass > 0 ? "green" : st.state.toLowerCase());
/**
 * Start a celebration for each thing that has just finished since the last scan: a pull request merged
 * or gone green, a workflow completed, a task list all done. The first scan only takes note, so what was
 * already finished at launch is not celebrated.
 */
export function noteParties(sessions: Session[], now: number): string[] {
  const started: string[] = [];
  const party = (sid: string, text: string) => {
    parties.set(sid, { text, at: now });
    started.push(`${sid} ${text}`);
  };
  for (const s of sessions) {
    for (const pr of prsShown(s.side?.prs ?? [])) {
      const key = `${pr.repo}#${pr.number}`;
      const mood = prMood(prState.get(key)?.state);
      const was = partyWas.pr.get(key);
      if (!mood) continue;
      if (partyWas.ready && was !== undefined && was !== mood && (mood === "merged" || mood === "green")) party(s.sid, `#${pr.number} ${mood === "merged" ? "merged" : "CI green"}`);
      partyWas.pr.set(key, mood);
    }
    for (const wf of s.workflows) {
      const was = partyWas.wf.get(wf.id);
      if (partyWas.ready && was === "running" && wf.status === "completed") party(s.sid, `${wf.name} done`);
      partyWas.wf.set(wf.id, wf.status);
    }
    const t = s.tasks;
    const allDone = !!t && t.total > 0 && t.done >= t.total;
    if (partyWas.ready && allDone && partyWas.tasks.get(s.sid) === false) party(s.sid, `all ${t!.total} tasks done`);
    partyWas.tasks.set(s.sid, allDone);
  }
  partyWas.ready = true;
  for (const [sid, p] of parties) if (now - p.at > PARTY_MS) parties.delete(sid);
  return started;
}
export const partyOn = (sid: string, now: number) => {
  const p = parties.get(sid);
  return p && now - p.at <= PARTY_MS ? p : undefined;
};
/** A colour on the rainbow, `h` in degrees. */
export function hue(h: number): RGB {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (0.62 - 0.38 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}
/** The shimmer: each letter a little further round the rainbow, the whole wave moving with the clock. */
export const partyTone = (i: number, now: number): RGB => hue((i * 24 - now * 0.36) % 360 + 360);

// ── what a session is doing beside the conversation ──

const sep = (): Seg => [`  ${ICON.sep}  `, C.faint];
/** "4 failed in 10m · Bash: bun test exited 1": how many tool calls failed lately, and what the last one said. */
export function troubleSegs(fails: Side["fails"]): Seg[] {
  const last = fails[fails.length - 1];
  return [[`${fails.length} failed in 10m`, C.red], sep(), [last.tool ? `${last.tool}: ` : "", C.dim], [last.text || "no message", C.dim]];
}
/** "2 running · Watch CI 6m · Full test suite 2m": background commands still going, oldest first, each with how long. */
export function bgSegs(bg: Side["bg"], now: number): Seg[] {
  return [[`${bg.length} running`, C.text], ...bg.flatMap((x): Seg[] => [sep(), [`${x.desc} `, C.dim], [ago(now - x.started), C.text]])];
}
/** "#1229 ✓ merged · #1231 ◐ CI 14/20 · #1232 ✗ 2 failing": each pull request with what GitHub says of it (with --prs), else its number. */
export function prSegs(prs: PrLink[], cwd = "", titled = false): Seg[] {
  return prs.flatMap((pr, i): Seg[] => {
    const st = prState.get(`${pr.repo}#${pr.number}`)?.state;
    const head: Seg[] = [...(i ? [sep()] : []), [`#${pr.number}`, C.text]];
    if (!st) return head;
    const checks = st.pass + st.fail + st.pending;
    const tail: Seg[] =
      st.state === "MERGED" ? [[` ${ICON.done} merged`, C.green], ...deploySegs(pr, st, cwd)]
      : st.state === "CLOSED" ? [[` ${ICON.failed} closed`, C.dim]]
      : st.fail ? [[` ${ICON.failed} ${st.fail} failing`, C.red]]
      : st.pending ? [[` ${ICON.progress} CI ${st.pass}/${checks}`, C.white]]
      : checks ? [[` ${ICON.done} CI green`, C.green]]
      : [[" open", C.dim]];
    // Its title last, so a row too narrow for it all loses the end of the title, never the state.
    const title: Seg[] = titled && st.title ? [[` ${ICON.sep} `, C.faint], [st.title, C.dim]] : [];
    return [...head, ...(st.draft && st.state === "OPEN" ? ([[" draft", C.dim]] as Seg[]) : []), ...tail, ...title];
  });
}
/** For a merged pull request whose repository has a deploy target: " · ✓ live on staging" or " · ◐ not on staging yet". */
function deploySegs(pr: PrLink, st: PrState, cwd: string): Seg[] {
  const d = deploys().find((x) => x.repo === pr.repo);
  if (!d || !st.mergeSha) return [];
  const live = mergeLive(st.mergeSha, deployState.get(d.url)?.revision, cwd, pr.repo);
  return live === undefined ? [] : live ? [[` ${ICON.sep} ${ICON.done} live on ${d.name}`, C.green]] : [[` ${ICON.sep} ${ICON.progress} not on ${d.name} yet`, C.white]];
}
/** "14 files changed · 3 uncommitted · 2 ahead · fleet.ts demo.ts README.md +11": what it has changed, its checkout, then the newest file names, which are cut first. */
export function changeSegs(edits: Side["edits"], git: GitState | undefined, tight = false): Seg[] {
  const sep = (): Seg => (tight ? [` ${ICON.sep} `, C.faint] : [`  ${ICON.sep}  `, C.faint]);
  const out: Seg[] = [];
  if (edits.length) out.push([`${edits.length} file${edits.length === 1 ? "" : "s"} changed`, C.text]);
  if (git) {
    const parts = [git.dirty ? `${git.dirty} uncommitted` : "", git.ahead ? `${git.ahead} ahead` : "", git.behind ? `${git.behind} behind` : ""].filter(Boolean);
    if (parts.length) out.push(...(out.length ? [sep()] : []), [parts.join(` ${ICON.sep} `), git.behind ? C.amber : C.dim]);
    else if (out.length) out.push(sep(), ["all committed", C.dim]);
  }
  if (edits.length) {
    out.push(sep(), [edits.slice(0, 3).map((e) => safeLine(path.basename(e.path))).join(" "), C.dim]);
    if (edits.length > 3) out.push([` +${edits.length - 3}`, C.dim]);
  }
  return out;
}
type SideKey = "trouble" | "bgRow" | "prs" | "changes";
/** Which of the side rows a block has something for. */
function sideHas(b: Block): Record<SideKey, boolean> {
  const side = b.v.s.side;
  const git = gitOf(b.v.s);
  return {
    trouble: !!side?.fails.length,
    bgRow: !!side?.bg.length,
    prs: !!side?.prs.length,
    changes: !!side && (side.edits.length > 0 || !!(git && (git.dirty || git.ahead || git.behind))),
  };
}
/** The side rows, under the head rows and above the conversation: failures, background commands, pull requests, changes. One row each, as the block keeps them. */
function sideRows(b: Block, g: Grid, now: number): StackRow[] {
  const side = b.v.s.side;
  if (!side || !b.body) return [];
  const k = b.keep;
  const placed = sideHas(b);
  // On a wide screen the facts that fit go to the column beside the conversation; only the rest are rows here.
  const has = Object.fromEntries(Object.entries(placed).map(([key, on]) => [key, on && (!g.wide || !b.sideLeft || b.sideLeft.has(key as SideKey))])) as Record<SideKey, boolean>;
  const fit = (segs: Seg[]) => fitSegs(segs, g.measure);
  const rows: StackRow[] = [];
  if (k.trouble && has.trouble) rows.push({ icon: [ICON.failed, C.red], segs: fit(troubleSegs(side.fails)), age: [ago(now - side.fails[side.fails.length - 1].t), C.dim] });
  if (k.bgRow && has.bgRow) rows.push({ icon: [ICON.background, C.cyan], segs: fit(bgSegs(side.bg, now)) });
  if (k.prs && has.prs) {
    const more = prsShown(side.prs).length - PR_SHOWN; // open ones past the newest three, counted
    rows.push({ icon: [ICON.pr, C.text], segs: fit([...prSegs(side.prs.slice(0, PR_SHOWN), side.cwd ?? b.v.s.cwd), ...(more > 0 ? ([[`  ${ICON.sep}  +${more} more open`, C.dim]] as Seg[]) : [])]) });
  }
  if (k.changes && has.changes) rows.push({ icon: [ICON.changes, C.dim], segs: fit(changeSegs(side.edits, gitOf(b.v.s))), age: side.edits.length ? [ago(now - side.edits[0].t), C.dim] : undefined });
  return rows;
}
/** Take one side row away, when the block is showing it. */
function sideOff(b: Block, key: SideKey, anywhere = false): Change | undefined {
  if (!b.keep[key] || !sideHas(b)[key]) return undefined;
  if (!anywhere && b.sideLeft && !b.sideLeft.has(key) && b.v.s.side) return undefined; // in the column beside the conversation it costs no row
  return change(() => (b.keep[key] = false), () => (b.keep[key] = true), () => !b.keep[key]);
}

/** The replies the block has to show, by when they were written: a task's latest message that is one of them is not repeated under the task. */
const replyTimes = (b: Block): Set<number> => new Set([...b.earlier.map((e) => e.t), ...(b.newest ? [b.newest.t] : [])]);
const detailCut = new WeakMap<TaskItem, Map<string, string[]>>();
/**
 * The line under a listed task, as much as the block keeps (Keep.taskDetail): the latest thing Claude
 * wrote while it was the task in hand, when that is not one of the replies above; else what the task
 * is for. Tasks still to start (and done ones, in focus) lose theirs first, then those in progress.
 * One row cut with …, or up to three in focus.
 */
function taskDetailOf(b: Block, t: TaskItem): { lines: string[]; say?: { text: string; t: number } } | undefined {
  const level = b.keep.taskDetail;
  if (level === "none" || (level === "doing" && t.status !== "in_progress")) return undefined;
  const say = t.say && !replyTimes(b).has(t.say.t) ? t.say : undefined;
  // A message is read as its opening lines, each made plain; a description as it is.
  const text = say ? say.text.split("\n").map((l) => firstLine(l)).filter(Boolean).join(" ").slice(0, 1200) : t.description;
  if (!text) return undefined;
  const room = Math.max(1, b.taskRoom - 2);
  const most = b.keep.taskWrap ? 3 : b.keep.taskDetailRows;
  const key = `${room} ${most} ${say ? say.t : "d"}`;
  let at = detailCut.get(t);
  if (!at) detailCut.set(t, (at = new Map()));
  let lines = at.get(key);
  if (!lines) {
    const all = most > 1 ? wrap(text, room) : [text];
    lines = all.slice(0, most).map((line, i, shown) => (i === shown.length - 1 && all.length > shown.length ? cutTo(`${line} ${ICON.cut}`, room) : cutTo(line, room)));
    at.set(key, lines);
  }
  return { lines, say };
}
/** Rows under the listed tasks, as the block stands. */
const taskDetailRows = (b: Block): number => taskListOf(b).shown.reduce((n, t) => n + (taskDetailOf(b, t)?.lines.length ?? 0), 0);

/** What a task says: what it is doing while in progress, else its subject, else its id. */
const taskText = (t: TaskItem): string => (t.status === "in_progress" && t.activeForm) || t.subject || `Task ${t.id}`;
const taskCut = new WeakMap<TaskItem, Map<string, string[]>>();
/**
 * A task's text in `room` cells, less its " · blocked" when it has one: one row cut with …, or wrapped
 * onto as many rows as it takes. Kept per task, since the ladder lays a block out many times a frame.
 */
function taskLines(t: TaskItem, room: number, wrapped: boolean): string[] {
  const w = room - (t.status === "pending" && t.blocked ? width(` ${ICON.sep} blocked`) : 0);
  let at = taskCut.get(t);
  if (!at) taskCut.set(t, (at = new Map()));
  const key = `${w} ${wrapped}`;
  let lines = at.get(key);
  if (!lines) at.set(key, (lines = wrapped ? wrap(taskText(t), w) : [cutTo(taskText(t), w)]));
  return lines;
}

/**
 * The task list under the tasks row, as the block stands: the tasks it shows, in order (done ones first
 * in focus, then those in progress, then those still to start, each in task order), and how many more
 * there are, which its last row counts when it is cut short. `lead` is the first task in progress, the
 * one the tasks row and the subheading name. Outside focus the list leaves it out when the subheading
 * names it, and it never lists that task alone: the tasks row names it then, at no cost of a row.
 */
function taskListOf(b: Block): { shown: TaskItem[]; more: number; lead?: TaskItem } {
  const k = b.keep;
  const items = b.v.s.tasks?.items ?? [];
  const lead = items.find((t) => t.status === "in_progress");
  if (!k.tasks || k.taskList <= 0 || !items.length) return { shown: [], more: 0, lead };
  const all = k.taskScope === "all";
  const of = (status: TaskItem["status"]) => items.filter((t) => t.status === status && (all || t !== lead || b.sub.source !== "task"));
  const pool = [...(all ? of("completed") : []), ...of("in_progress"), ...(k.taskScope === "doing" ? [] : of("pending"))];
  if (pool.length === 1 && pool[0] === lead) return { shown: [], more: 0, lead };
  if (pool.length <= k.taskList) return { shown: pool, more: 0, lead };
  const shown = pool.slice(0, Math.max(0, k.taskList - 1));
  return { shown, more: pool.length - shown.length, lead };
}
/** Entries in the task list as the block stands: its tasks, and the "… n more tasks" row. Each is one row unless the list is wrapped. */
const taskListRows = (b: Block): number => {
  const list = taskListOf(b);
  return list.shown.length + (list.more ? 1 : 0);
};

/** One fact in the column beside the conversation, under the instruments: a glyph, its words, and an age at the right edge. */
type SideItem = { side: SideKey; icon: Seg; segs: Seg[]; age?: Seg };
type Instrument = "ctx" | "key" | "figs" | SideItem;
/** The side facts as short rows for that column, most wanted first: failures, each background command, each pull request, the changes. */
function sideItems(b: Block, now: number): SideItem[] {
  const side = b.v.s.side;
  if (!side || !b.body) return [];
  const k = b.keep;
  const has = sideHas(b);
  const out: SideItem[] = [];
  if (k.trouble && has.trouble) {
    const last = side.fails[side.fails.length - 1];
    out.push({ side: "trouble", icon: [ICON.failed, C.red], segs: [[`${side.fails.length} failed`, C.red], [` ${ICON.sep} `, C.faint], [`${last.tool ? last.tool + ": " : ""}${last.text}`, C.dim]], age: [ago(now - last.t), C.dim] });
  }
  if (k.bgRow && has.bgRow) for (const x of side.bg) out.push({ side: "bgRow", icon: [ICON.background, C.cyan], segs: [[x.desc, C.dim]], age: [ago(now - x.started), C.text] });
  if (k.prs && has.prs) for (const pr of side.prs.slice(0, PR_SHOWN)) out.push({ side: "prs", icon: [ICON.pr, C.text], segs: prSegs([pr], side.cwd ?? b.v.s.cwd, true) });
  if (k.changes && has.changes) out.push({ side: "changes", icon: [ICON.changes, C.dim], segs: changeSegs(side.edits, gitOf(b.v.s), true), age: side.edits.length ? [ago(now - side.edits[0].t), C.dim] : undefined });
  return out;
}
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
  gap: boolean; // a blank row between the stack and the roster, while the block is airy
}
function partsOf(b: Block, g: Grid, now: number): Parts {
  const head = 1 + Math.max(1, Math.min(b.keep.question, b.question.length));
  if (!g.wide) {
    // Narrow: there is no column beside the conversation; every side fact is a row on the left.
    b.sideLeft = undefined;
    const stack = stackOf(b, g, now);
    return { head, vitals: b.body && b.keep.ctx, stack, inst: instrumentsOf(b, g, stack.length), ...rosterParts(b, stack, now) };
  }
  const items = sideItems(b, now);
  const groups = [...new Set(items.map((x) => x.side))];
  // Put every side fact in the column beside the conversation; while there are more than its free rows, the least wanted group goes back to a row on the left.
  for (let right = groups.length; ; right--) {
    b.sideLeft = new Set(groups.slice(right));
    const stack = stackOf(b, g, now);
    const base = instrumentsOf(b, g, stack.length);
    const mine = items.filter((x) => !b.sideLeft!.has(x.side));
    if (mine.length <= stack.length - base.length || right === 0) return { head, vitals: b.body && !g.wide && b.keep.ctx, stack, inst: withOpenPrs(b, [...base, ...mine], stack.length - base.length - mine.length), ...rosterParts(b, stack, now) };
  }
}
/** Open pull requests past the newest three, after them in the column beside the conversation, in rows it has to spare:
 *  never a row more. Those that do not fit are counted: "+ 6 more open PRs" on the last spare row, or with no row to
 *  spare "+6 more open" on the third one's row, before its title (which a cut takes first). */
function withOpenPrs(b: Block, inst: Instrument[], room: number): Instrument[] {
  const side = b.v.s.side;
  const at = inst.reduce((n, x, i) => (typeof x === "object" && x.side === "prs" ? i : n), -1);
  if (!side || at < 0) return inst;
  const open = prsShown(side.prs).slice(PR_SHOWN);
  if (!open.length) return inst;
  const fits = open.length <= room ? open.length : Math.max(0, room - 1);
  const rows: Instrument[] = open.slice(0, fits).map((pr): SideItem => ({ side: "prs", icon: [ICON.pr, C.text], segs: prSegs([pr], side.cwd ?? b.v.s.cwd, true) }));
  const left = open.length - fits;
  const out = [...inst];
  if (left && room > 0) rows.push({ side: "prs", icon: [ICON.pr, C.dim], segs: [[`+ ${left} more open PR${left === 1 ? "" : "s"}`, C.dim]] });
  else if (left) {
    const last = out[at] as SideItem;
    const t = last.segs.findIndex(([text]) => text === ` ${ICON.sep} `); // where its title starts, if it has one
    const more: Seg = [` ${ICON.sep} +${left} more open`, C.dim];
    out[at] = { ...last, segs: t < 0 ? [...last.segs, more] : [...last.segs.slice(0, t), more, ...last.segs.slice(t)] };
  }
  return [...out.slice(0, at + 1), ...rows, ...out.slice(at + 1)];
}
const rowsOfParts = (p: Parts) => p.head + (p.vitals ? 1 : 0) + Math.max(p.stack.length, p.inst.length) + (p.gap ? 1 : 0) + p.roster.length;
/** The roster, and whether a blank row parts it from the stack above. */
const rosterParts = (b: Block, stack: StackRow[], now: number) => {
  const roster = rosterOf(b, now);
  return { roster, gap: b.keep.airy && stack.length > 0 && roster.length > 0 };
};
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
/** Show the question on at most `rows` rows, the last cut with …. It comes back a row at a time. */
function questionTo(b: Block, rows: number): Change | undefined {
  const from = b.keep.question;
  const whole = Math.min(from, b.question.length);
  if (whole <= rows) return undefined;
  return change(() => (b.keep.question = rows), () => (b.keep.question = from), () => b.keep.question === rows, {
    ease: (fits, spare) => {
      for (let n = Math.min(whole, rows + spare + 1); n > rows; n--) {
        b.keep.question = n === whole ? from : n;
        if (fits()) return true;
      }
      return false;
    },
  });
}

/** Cap the task list at `rows` rows, the last of them "… n more tasks", when it takes more. It comes back a row at a time, never as a count alone. */
function taskListTo(b: Block, rows: number): Change | undefined {
  const from = b.keep.taskList;
  const whole = taskListRows(b);
  if (whole <= rows) return undefined;
  return change(() => (b.keep.taskList = rows), () => (b.keep.taskList = from), () => b.keep.taskList === rows, {
    ease: (fits, spare) => {
      for (let n = Math.min(whole, rows + spare + 1); n > rows; n--) {
        if (n === 1 && whole > 1) break; // one row would be "… n more tasks" with no task above it
        b.keep.taskList = n === whole ? from : n;
        if (fits()) return true;
      }
      return false;
    },
  });
}
/**
 * List fewer kinds of task: the done ones leave a focused list ("open"), then those still to start
 * ("doing"). The strip above still counts them. The done ones come back only to a list that is not cut
 * short: listed first, they would push the open tasks out of it.
 */
function taskScopeTo(b: Block, scope: "open" | "doing"): Change | undefined {
  const from = b.keep.taskScope;
  const before = taskListRows(b);
  b.keep.taskScope = scope;
  const after = taskListRows(b);
  b.keep.taskScope = from;
  if (after >= before) return undefined;
  return change(() => (b.keep.taskScope = scope), () => (b.keep.taskScope = from), () => b.keep.taskScope === scope && (from === "all" ? b.keep.taskList === Infinity : b.keep.taskList > 0));
}
/** The lines under the listed tasks down to one row each, before any of them goes. */
function taskDetailRowsTo(b: Block, rows: number): Change | undefined {
  const from = b.keep.taskDetailRows;
  if (from <= rows) return undefined;
  const before = taskDetailRows(b);
  b.keep.taskDetailRows = rows;
  const after = taskDetailRows(b);
  b.keep.taskDetailRows = from;
  if (after >= before) return undefined;
  return change(() => (b.keep.taskDetailRows = rows), () => (b.keep.taskDetailRows = from), () => b.keep.taskDetailRows === rows);
}
/** Fewer lines under the listed tasks: what the tasks still to start are for ("doing"), then the latest message under each task in progress ("none"). */
function taskDetailTo(b: Block, level: "doing" | "none"): Change | undefined {
  const from = b.keep.taskDetail;
  if (from === level || from === "none") return undefined;
  const before = taskDetailRows(b);
  b.keep.taskDetail = level;
  const after = taskDetailRows(b);
  b.keep.taskDetail = from;
  if (after >= before) return undefined;
  return change(() => (b.keep.taskDetail = level), () => (b.keep.taskDetail = from), () => b.keep.taskDetail === level);
}
/** In focus: each task and the line under it back on one row, cut with …, when one of them takes more. Its rows come back only to a list that is not cut short. */
function taskUnwrap(b: Block): Change | undefined {
  if (!b.keep.taskWrap || !taskListOf(b).shown.some((t) => taskLines(t, b.taskRoom, true).length > 1 || (taskDetailOf(b, t)?.lines.length ?? 0) > 1)) return undefined;
  return change(() => (b.keep.taskWrap = false), () => (b.keep.taskWrap = true), () => !b.keep.taskWrap && b.keep.taskList === Infinity);
}

/**
 * The ladder: what the blocks give up, in this order, when they do not all fit. Each rung is taken from
 * the bottom session upward, one block at a time, and the climb stops the moment everything fits. The
 * whole numbers are the design's; the half steps between them are the task list's, which gives way in
 * four stages (5 rows, 3 rows, the tasks in progress, none) so the tasks row is never the first to go. A
 * session that needs you skips the second half of 4 and all of 8, 9 and 13: its title, its whole
 * question and two lines of the reply always stay. "gaps" is the one rung that is not a block's own.
 */
const LADDER: { step: number; cut: "gaps" | ((b: Block) => Change | undefined) }[] = [
  // In focus every stored reply starts out in full, and every task is listed in full. These four bring them back to what the dashboard shows.
  { step: 0, cut: (b) => (b.keep.airy ? change(() => (b.keep.airy = false), () => (b.keep.airy = true), () => !b.keep.airy) : undefined) }, // the blank rows inside a block
  { step: 0, cut: (b) => (b.focus ? earlierTo(b, 0, b.earlier.length - 2) : undefined) },
  { step: 0, cut: (b) => (b.focus ? earlierTo(b, 2) : undefined) },
  { step: 0, cut: (b) => (b.focus ? taskUnwrap(b) : undefined) }, // each task on one row
  { step: 0, cut: (b) => (b.focus ? taskScopeTo(b, "open") : undefined) }, // the done tasks leave the list; the strip still counts them
  { step: 0.4, cut: (b) => taskDetailRowsTo(b, 1) }, // the lines under the tasks down to one row each
  { step: 0.5, cut: (b) => taskDetailTo(b, "doing") }, // the lines under tasks still to start: what each is for
  { step: 0.7, cut: (b) => taskDetailTo(b, "none") }, // the latest message under each task in progress
  { step: 0.8, cut: (b) => sideOff(b, "changes") }, // the row of files changed and the checkout's state
  { step: 1, cut: (b) => earlierTo(b, 1) }, // earlier replies shrink to one line each
  { step: 2, cut: (b) => earlierTo(b, 0) }, // …and are removed, oldest first
  { step: 2.2, cut: (b) => sideOff(b, "prs") }, // the pull requests row
  { step: 2.3, cut: (b) => sideOff(b, "bgRow") }, // the background commands row
  { step: 2.5, cut: (b) => taskListTo(b, 5) }, // the task list is cut to 5 rows, the last "… n more tasks"
  { step: 3, cut: (b) => turnOff(b, "done") }, // the "n agents finished" line
  { step: 3.5, cut: (b) => taskListTo(b, 3) }, // the task list is cut to 3 rows, before any reply is: a waiting session's reply is the evidence for your answer
  { step: 4, cut: (b) => (b.focus ? replyTo(b, 10) : undefined) },
  { step: 4, cut: (b) => replyTo(b, 4) }, // the newest reply is capped at 4 lines,
  { step: 4, cut: (b) => (needsYou(b) ? undefined : replyTo(b, 2)) }, // then 2
  { step: 5, cut: (b) => agentsTo(b, 3) }, // agent groups longer than 3: the 3 most active and "… n more agents"
  { step: 6, cut: (b) => turnOff(b, "now") }, // the dim now-line under a question
  { step: 7, cut: "gaps" }, // the blank rows between sessions
  { step: 8, cut: (b) => (needsYou(b) ? undefined : promptOff(b)) }, // your prompt
  { step: 9, cut: (b) => (needsYou(b) ? undefined : replyTo(b, 1)) }, // the newest reply shrinks to one line
  { step: 9.5, cut: (b) => taskScopeTo(b, "doing") }, // the task list keeps only the tasks in progress: none when there is one, which the tasks row names
  { step: 9.6, cut: (b) => sideOff(b, "trouble") }, // the failed tool calls row
  { step: 10, cut: (b) => turnOff(b, "main") }, // the main-thread row
  { step: 11, cut: (b) => (b.groups.some((x) => (x.wf ? x.rows.length > 0 : x.rows.length > 1)) ? foldAgents(b) : undefined) }, // agents fold: a workflow's into its own row, standalone ones into one line
  { step: 12, cut: (b) => (needsYou(b) ? promptOff(b) : undefined) }, // sessions that need you: the prompt,
  { step: 12, cut: (b) => (needsYou(b) ? replyTo(b, 2) : undefined) }, // then the reply down to 2 lines, and no further
  { step: 13, cut: (b) => (needsYou(b) ? undefined : replyTo(b, 0)) }, // the newest reply is removed
  { step: 13.5, cut: (b) => taskListTo(b, 0) }, // the task list goes, and the tasks row names the task in progress again
  { step: 14, cut: (b) => turnOff(b, "tasks") }, // the tasks row,
  { step: 14, cut: (b) => turnOff(b, "ctx") }, // then the context row
  { step: 14.6, cut: (b) => sideOff(b, "changes", true) }, // side facts still shown in the column, least wanted first
  { step: 14.7, cut: (b) => sideOff(b, "prs", true) },
  { step: 14.8, cut: (b) => sideOff(b, "bgRow", true) },
  { step: 14.9, cut: (b) => sideOff(b, "trouble", true) },
  { step: 15, cut: (b) => turnOff(b, "roster") }, // workflow rows and the folded agents line: now a small far card
  { step: 16, cut: (b) => (needsYou(b) ? undefined : foldAway(b)) }, // whole sessions, never one that needs you
  // Past the design's ladder, for a screen too small even for that. A question shown whole in focus goes back to three rows, and gets back what fits.
  { step: 17, cut: (b) => (b.focus ? questionTo(b, 3) : undefined) },
  // Then a waiting session's reply, then all but one row of its question, then the session.
  { step: 18, cut: (b) => (needsYou(b) ? replyTo(b, 0) : undefined) },
  { step: 18, cut: (b) => (needsYou(b) ? questionTo(b, 1) : undefined) },
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
  const use = useOf(b.v.s);
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
  const justDone = state === "justDone";
  const receded = isReceded(state);
  const tone = STATE[state].color;
  const dim = needs ? C.warmDim : C.dim;
  const start = () => {
    const r = new Row(g.W, needs ? C.tint : justDone ? C.doneTint : undefined);
    r.put(g.rail, ICON.railThick, railTone(state, true, beat()));
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
  const party = partyOn(s.sid, now);
  if (party) [...title].forEach((ch, i) => r1.put(g.icon + i, ch, ch === " " ? C.white : partyTone(i, now), true));
  else r1.put(g.icon, title, receded ? C.text : C.white, true);
  const folders = foldersOf(s.cwd.replace(os.homedir(), "~"));
  const branch = s.mains.map((m) => m.branch).find(Boolean);
  const at = branch && branch !== "HEAD" ? ` ${ICON.at} ${branch}` : "";
  const where = (machineOf(s) ? `${machineLabel(s)} ${ICON.sep} ` : "") + folders.slice(-2).join("/") + at;
  const kind = `${s.kind || "cli"} ${s.sid.slice(0, 8)}`;
  // 'folder/folder @ branch · kind id' loses the kind and id first, then the parent folder, then goes. Under 100 columns it is not drawn.
  // The session's totals go first when room is short: all the tokens it has used, the agents it has run, how often its context was compacted.
  const agentCount = s.agents.length + s.workflows.reduce((n, w) => n + w.agents.length, 0);
  const totals = [s.job?.tokens ? `${human(s.job.tokens)} tok` : "", agentCount ? `${agentCount} agent${agentCount === 1 ? "" : "s"}` : "", s.side?.compactions ? `compacted ${s.side.compactions}×` : ""].filter(Boolean).join(` ${ICON.sep} `);
  const dot: Seg = [` ${ICON.sep} `, needs ? C.warmDim : C.faint];
  const withTotals = (x: Seg[]): Seg[][] => (totals ? [[...x, dot, [totals, dim]], x] : [x]);
  const places: Seg[][] = where ? [...withTotals([[where, dim], dot, [kind, dim]]), [[where, dim]], [[folders.slice(-1).join("") + at, dim]]] : withTotals([[kind, dim]]);
  const place = g.small ? undefined : places.find((x) => g.icon + width(title) + 3 + segsWidth(x) - 1 <= limit);
  if (party) {
    // While it celebrates, what it finished stands where the place was, in the same colours.
    const text = `${ICON.star} ${party.text} ${ICON.star}`;
    const end = limit;
    const from = end - width(text) + 1;
    if (from > g.icon + width(title) + 2) [...text].forEach((ch, i) => r1.put(from + i, ch, partyTone(i + 7, now), true));
  } else if (place) r1.segsr(limit, place);
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
        // The phase trail: ✓ passed, ◐ current, ○ later. Too long: passed phases go from the left, then later ones from the right, and a dim … says so. A narrow screen shows the current one only.
        const steps = phaseTrail(wf).filter((x) => g.wide || x.state === "now");
        let cutLeft = false;
        let cutRight = false;
        const span = () => (cutLeft ? 2 : 0) + (cutRight ? 3 : 0) + steps.reduce((n, x) => n + 2 + width(x.name), 0) + 2 * Math.max(0, steps.length - 1);
        while (steps.length > 1 && span() > room && steps[0].state === "done") steps.shift(), (cutLeft = true);
        while (steps.length > 1 && span() > room && steps[steps.length - 1].state === "next") steps.pop(), (cutRight = true);
        while (steps.length > 1 && span() > room) steps.shift(), (cutLeft = true);
        trail = [
          ...(cutLeft ? [[ICON.cut + " ", C.dim] as Seg] : []),
          ...steps.flatMap((x, i): Seg[] => [
            ...(i ? [["  "] as Seg] : []),
            ...((x.state === "done" ? [[ICON.done + " ", C.done], [x.name, C.dim]] : x.state === "now" ? [[ICON.progress + " ", C.white], [x.name, C.white, true]] : [[ICON.idle + " ", C.faint], [x.name, C.dim]]) as Seg[]),
          ]),
          ...(cutRight ? [["  " + ICON.cut, C.dim] as Seg] : []),
        ];
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
  const quietFor = now - lastWriteOf(a.tail);
  const receded = st === "quiet" || st === "done";
  if (stalled) r.put(at, ICON.progress, C.red);
  else if (st === "active") r.put(at, SPIN[frame % SPIN.length], C.green);
  else if (st === "tool") r.put(at, ICON.progress, C.white);
  else r.put(at, st === "done" ? ICON.done : ICON.idle, st === "done" ? C.done : C.dim);
  r.put(at + 2, cutTo(a.label, (g.small ? g.textEnd : g.labelEnd) - (at + 2) + 1), receded ? C.dim : C.text);
  if (!g.small) {
    const meta = g.wide ? (t.child ? a.model : [shortType(a.type), a.model].filter(Boolean).join(` ${ICON.sep} `)) : "";
    const room = (meta ? g.actionEnd : g.textEnd) - g.action + 1;
    const pending = pendingOf(a.tail);
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
      if (item.icon) r.segs(item.iconAt ?? g.icon, [item.icon]);
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
    else if (typeof inst === "object") {
      const ageW = inst.age ? width(inst.age[0]) + 1 : 0;
      r.segs(g.lane, [inst.icon]);
      r.segs(g.lane + 2, fitSegs(inst.segs, g.figEnd - g.lane - 1 - ageW));
      if (inst.age) r.segsr(g.figEnd, [inst.age]);
    }
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
  if (parts.gap) body();
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

/** Rows a session takes in compact mode's tree: its own row, the question, each workflow and agent row, the finished tally. */
export const rowsOf = (v: View) => 1 + (v.showNeeds ? 1 : 0) + v.groups.reduce((n, g) => n + (g.wf ? 1 : 0) + g.rows.length + (g.hidden ? 1 : 0), 0) + (v.doneCount ? 1 : 0);

/**
 * Shrink compact mode's tree until it fits in `avail` rows: the blank rows between sessions go first,
 * then the longest agent groups fold, then the finished tallies, then whole sessions from the bottom.
 * Returns the views that are left, whether the blank rows survived, and how many sessions were cut.
 */
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
  for (const v of views) if (total(gaps) > avail) v.doneCount = 0;
  let cut = 0;
  while (views.length > 1 && total(gaps) + (cut ? 1 : 0) > avail) {
    views = views.slice(0, -1); // the line that says so takes a row of its own
    cut++;
  }
  return { views, gaps, cut };
}

// ───────────────────────── header ─────────────────────────
//
// Detail and far mode: five rows when the terminal has 40 rows or more (the masthead; three rows
// holding the machine, the account and the fleet chart; and the rule, which is also the time axis of
// every sparkline below it), three rows under that. Compact mode and terminals under 100 columns keep
// the older header. The height follows the terminal's rows, never the number of sessions, so the
// header does not jump. The one exception is a remedy line, which is there for as long as the usage
// read is failing for a reason you can do something about.

export type HeaderKind = "tall" | "medium" | "old";
export const headerKind = (W: number, rows: number, mode: Mode = opt.mode): HeaderKind => (mode === "compact" || W < 100 ? "old" : rows >= 40 ? "tall" : "medium");

/** `text` when it fits in `w` cells; cut with … when enough of it would be left to mean something; else nothing. */
export const fitOrDrop = (text: string, w: number): string => (width(text) <= w ? text : w >= 8 ? fit(text, w, "l", true).replace(/\s+…$/, "…") : "");
/** The first wording that fits in `w` cells, else the fullest one cut with …. */
export const firstFit = (wordings: string[], w: number): string => wordings.find((x) => width(x) <= w) ?? fitOrDrop(wordings[0], w);

/**
 * A limit's gauge, `w` cells: ━ for the part used, in the limit rule's colour, then a faint track. `tick`
 * (0 to 1) adds the pace tick where the clock stands in the limit's window. With no reading (`pct`
 * undefined) the gauge is ╌ throughout. Stale figures are drawn dim.
 */
export function limitGauge(pct: number | undefined, w: number, tick?: number, stale = false): string {
  if (pct === undefined) return fg(C.faint, ICON.gaugeNone.repeat(w));
  const filled = Math.max(pct > 0 ? 1 : 0, Math.min(w, Math.round((pct / 100) * w)));
  const at = tick === undefined ? undefined : paceCell(tick, pct, w);
  const fill = (from: number, to: number) => (to > from ? fg(stale ? C.dim : limitTone(pct), ICON.gaugeFill.repeat(to - from)) : "");
  const track = (from: number, to: number) => (to > from ? fg(C.faint, ICON.gaugeTrack.repeat(to - from)) : "");
  /** The cells from `from` up to `to`: the filled part, then the track. */
  const part = (from: number, to: number) => fill(from, Math.min(to, filled)) + track(Math.max(from, filled), to);
  return at ? part(0, at.cell) + fg(stale ? C.dim : C.white, at.glyph) + part(at.cell + 1, w) : part(0, w);
}
/** A gauge for a rate (CPU), where 100 is one whole: one cool tone from the machine ramp, whatever the figure. A rate is not a limit, so it never turns warm. */
export function rateGauge(pct: number, w: number): string {
  const filled = Math.max(pct > 0 ? 1 : 0, Math.min(w, Math.round((pct / 100) * w)));
  return fg(coolTone(0.75), ICON.gaugeFill.repeat(filled)) + fg(C.faint, ICON.gaugeTrack.repeat(w - filled));
}

/**
 * The fleet chart: `h` rows, top row first. LINEAR against its own peak, eight levels a row, so a busy
 * minute towers over a quiet one (one-row sparklines of single sessions keep the square-root scale). A
 * bar with anything in it shows at least ▁; an empty one is a faint ▁ on the bottom row. With a single
 * row there are only eight levels, so a bar rounds up, as it does in every other one-row sparkline.
 */
export function fleetChart(counts: number[], h: number): string[] {
  const [lo, hi] = RAMP.fleet;
  const max = Math.max(1, ...counts);
  const out: string[] = [];
  for (let r = h - 1; r >= 0; r--)
    out.push(
      counts
        .map((v) => {
          const t = v / max;
          const eighths = Math.max(v > 0 && r === 0 ? 1 : 0, (h === 1 ? Math.ceil(t * 8) : Math.round(t * h * 8)) - r * 8);
          if (eighths <= 0) return r === 0 ? fg(C.faint, BARS[0]) : " ";
          return fg(mix(lo, hi, t), BARS[Math.min(7, eighths - 1)]);
        })
        .join(""),
    );
  return out;
}

/** "Tue 13 Oct", in this machine's time zone. */
const dateText = (now: number): string => {
  const [day, month, date] = new Date(now).toDateString().split(" ");
  return `${day} ${Number(date)} ${month}`;
};
/** A process's name (already made safe when it was sampled), cut to what the header has room for. */
const shortProc = (p: Proc) => [...p.name].slice(0, 14).join("");
/** "top bun 212% · node 88%": the busiest processes, as many whole ones as fit in `w` cells. */
function topSegs(w: number): Seg[] {
  const parts: Seg[] = [["top ", C.dim]];
  for (const p of topProcs(4)) {
    const next: Seg[] = [...(parts.length > 1 ? [[` ${ICON.sep} `, C.faint] as Seg] : []), [`${shortProc(p)} ${Math.round(p.cpu)}%`, C.text]];
    if (segsWidth(parts) + segsWidth(next) > w) break;
    parts.push(...next);
  }
  return parts.length > 1 ? parts : [];
}

/**
 * Row 1, the masthead. The brand, then one tile per count: a glyph, a bold count and a dim word. Tiles
 * sit in fixed slots, so a count going from 9 to 10 moves nothing, and a zero goes dim rather than
 * leaving. The red stalled tile is added only while something is stalled. On the right, the date and
 * the clock. When it does not all fit, the date goes first, then the idle tile (the a button carries
 * its count too), then workflows, then agents.
 */
function masthead(g: Grid, c: FleetCounts, now: number): Row {
  const r = new Row(g.W);
  r.put(2, `${ICON.claude} CLAUDE FLEET`, C.cyan, true);
  const first = g.wide ? 21 : 19;
  const count = (n: number): Seg => [` ${n}`, n ? C.white : C.dim, n > 0];
  let tiles: { name: string; parts: Seg[]; slot: number }[] = [
    { name: "working", parts: [[ICON.working, c.working ? C.green : C.dim], count(c.working), [" working", C.dim]], slot: 12 },
    { name: "agents", parts: [[c.agents ? SPIN[frame % SPIN.length] : ICON.idle, c.agents ? C.green : C.dim], count(c.agents), [` agent${c.agents === 1 ? "" : "s"}`, C.dim]], slot: 11 },
    { name: "workflows", parts: [[ICON.workflow, c.workflows ? C.purple : C.dim], count(c.workflows), [` workflow${c.workflows === 1 ? "" : "s"}`, C.dim]], slot: 13 },
    { name: "idle", parts: [[ICON.idle, C.dim], [` ${c.idle}`, C.dim], [" idle", C.dim]], slot: 9 },
  ];
  if (c.stalled) tiles.push({ name: "stalled", parts: [[ICON.progress, C.red], [` ${c.stalled}`, C.red, true], [" stalled?", C.red]], slot: 12 });
  const tilesFrom = first + 17; // after the needs-you slot
  /** The column after the last of these tiles, laid out from the first slot. */
  const endOf = (list: typeof tiles) => list.reduce((col, t, i) => col + (i === list.length - 1 ? segsWidth(t.parts) : Math.max(t.slot, segsWidth(t.parts)) + 3), tilesFrom);
  let showDate = g.wide;
  const limit = () => g.W - (showDate ? 24 : 10);
  if (endOf(tiles) > limit()) showDate = false;
  for (const name of ["idle", "workflows", "agents"]) if (endOf(tiles) > limit()) tiles = tiles.filter((t) => t.name !== name);

  if (c.needs) {
    // The one warm thing on the row: bold amber on the amber tint.
    const text = ` ${ICON.needs} ${c.needs} need${c.needs === 1 ? "s" : ""} you `;
    r.put(first - 1, text, C.amber, true);
    r.tint(C.tint, first - 1, first - 2 + width(text));
  } else r.put(first, `${ICON.done} none waiting`, C.done);
  let col = tilesFrom;
  for (const t of tiles) {
    if (col + segsWidth(t.parts) > limit()) break;
    r.segs(col, t.parts);
    col += Math.max(t.slot, segsWidth(t.parts)) + 3;
  }
  const left = r.putr(g.figEnd, new Date(now).toTimeString().slice(0, 8), C.white, true);
  if (showDate) r.putr(left - 2, dateText(now), C.dim);
  return r;
}

/**
 * The header's last row: a faint rule that is also the time axis. Under the lane it names the window
 * at the left edge and "now" at the right, with a tick at each third, and every sparkline below sits in
 * the same columns on the same bars, so this one axis labels them all. A white ▼ marks when you last
 * looked. While things are new since then, the left of the rule lists them: asked, failed, stalled,
 * finished, new replies, as many as fit.
 */
function axisRow(g: Grid, win: Win): Row {
  const r = new Row(g.W);
  r.put(2, ICON.gaugeTrack.repeat(g.lane - 3), C.faint);
  const news = digest();
  if (news.groups.length) {
    const parts: Seg[] = [[`since ${hhmm(news.since)}`, C.dim]];
    for (const group of news.groups) {
      const next: Seg[] = [[`  ${ICON.sep}  `, C.faint], [`${group.glyph} `, group.color, group.kind === "asked"], [group.text, C.text]];
      if (5 + segsWidth(parts) + segsWidth(next) > g.lane - 7) break; // "before column 100" at 150 columns
      parts.push(...next);
    }
    if (parts.length > 1) {
      r.put(4, " ".repeat(segsWidth(parts) + 2));
      r.segs(5, parts);
    }
  }
  const label = `${opt.windowMin}m`;
  r.put(g.lane, ICON.gaugeTrack.repeat(g.laneW), C.faint);
  for (const third of [1, 2]) r.put(g.lane + third * Math.floor(g.laneW / 3), ICON.tick, C.dim);
  r.put(g.lane, `${label} `, C.dim);
  r.put(g.laneEnd - 3, " now", C.dim);
  // The mark gives way to the two labels: at the right end it means "just now", and at the left it is about to leave the window.
  const mark = seenCell(win);
  if (mark !== undefined && mark > width(label) && mark < g.laneW - 4) r.put(g.lane + mark, ICON.seen, C.white, true);
  r.put(g.fig, ICON.gaugeTrack.repeat(g.figW), C.faint);
  return r;
}

/** Rows 2 to 4, left: the machine. Each row is label, gauge, value, detail. CPU is a rate, so it runs the cool ramp and never turns warm; memory is a limit. */
function machineBlock(rows: Row[], g: Grid) {
  const GW = g.gaugeW;
  const valueEnd = 7 + GW + 4;
  const detail = valueEnd + 3;
  const roomy = g.machineEnd >= 57; // 150 columns and up: load sits beside the history, and the busiest processes get the third row
  const load = `load ${machine.load.toFixed(1)}`;

  rows[0].put(2, "cpu", C.dim);
  rows[0].paste(7, rateGauge(machine.cpu, GW), GW);
  rows[0].putr(valueEnd, `${Math.round(machine.cpu)}%`, C.text);
  const hist = machine.hist.slice(-g.histW);
  const history = [...new Array(g.histW - hist.length).fill(0), ...hist].map((v) => (v <= 0 ? fg(C.faint, BARS[0]) : fg(coolTone(v / 100), BARS[Math.min(7, Math.max(0, Math.ceil((v / 100) * 8) - 1))])));
  rows[0].paste(detail, history.join(""), g.histW);
  if (roomy) rows[0].put(detail + g.histW + 2, load, C.dim);

  const memPct = machine.memTotal > 0 ? (machine.memUsed / machine.memTotal) * 100 : 0;
  const memTone = figureTone(memPct);
  rows[1].put(2, "mem", C.dim);
  rows[1].paste(7, limitGauge(memPct, GW), GW);
  rows[1].putr(valueEnd, `${Math.round(memPct)}%`, memTone.color, memTone.bold);
  rows[1].segs(detail, [[gb(machine.memUsed), C.text], [` of ${gb(machine.memTotal)}`, C.dim]]);

  // One glyph per core. Past 18 cores neighbours are averaged, so the strip keeps to its columns.
  const per = Math.max(1, Math.ceil(machine.cores.length / 18));
  const strip: number[] = [];
  for (let i = 0; i < machine.cores.length; i += per) strip.push(sum(machine.cores.slice(i, i + per)) / Math.min(per, machine.cores.length - i));
  rows[2].put(2, "core", C.dim);
  const after = rows[2].paste(7, strip.map((v) => fg(coolTone(0.25 + (v / 100) * 0.75), BARS[Math.min(7, Math.max(0, Math.floor((v / 100) * 8)))])).join(""), strip.length);
  if (!roomy) rows[2].put(after + 2, load, C.dim);
  else {
    // The busiest processes; when the account block is listing them instead (no --usage), the core count.
    const top = opt.usage ? topSegs(g.machineEnd - detail + 1) : [];
    rows[2].segs(detail, top.length ? top : machine.cores.length && !(opt.usage && HIDE_TOP) ? [[`${machine.cores.length} cores`, C.dim]] : []);
  }
}

/**
 * Rows 2 to 4, middle: the account. The block never changes size and never guesses.
 * - current figures: the 5-hour and 7-day limits, each with its pace tick and when it resets (or, in
 *   bold red, when it will be full, if that comes first); then extra usage, or with extra usage off the
 *   Opus and Sonnet weeks when Anthropic returned them.
 * - stale figures (the read worked before): they stay, drawn dim, over the time they date from and the reason.
 * - no figures: ╌ gauges, when the next try is, and the exact reason.
 * - without --usage (`a` undefined): the busiest processes on the same columns, one full core to a full gauge.
 */
function accountBlock(rows: Row[], g: Grid, a: AccountView | undefined, now: number): boolean {
  const GW = g.gaugeW;
  const label = g.account;
  const gaugeAt = label + 6;
  const valueEnd = gaugeAt + GW + 4;
  const detail = valueEnd + 3;
  const room = g.accountEnd - detail + 1; // cells the detail may use
  /** One line that owns the block's whole width: a red ✗, then the first wording that fits. */
  /** Draw the first wording that fits behind a red ✗, and say which it was. */
  const failLine = (r: Row, wordings: string[]): string => {
    const text = firstFit(wordings, g.accountEnd - label - 1);
    r.segs(label, [[`${ICON.failed} `, C.red], [text, C.dim]]);
    return text;
  };
  const whyForms = a ? reasonForms(a.reason) : [];

  if (!a) {
    const top = topProcs(3);
    if (top.length || !HIDE_TOP) rows[0].put(label, "top", C.dim);
    if (!top.length && !HIDE_TOP) rows[0].put(gaugeAt, fitOrDrop("nothing at 5% CPU or more", g.accountEnd - gaugeAt + 1), C.dim);
    top.forEach((p, i) => {
      rows[i].paste(gaugeAt, rateGauge(p.cpu, GW), GW);
      rows[i].putr(valueEnd, `${Math.round(p.cpu)}%`, C.text);
      rows[i].put(detail, fitOrDrop(shortProc(p), room), C.text);
    });
    return false;
  }

  if (a.kind === "none") {
    const notes = ["no reading yet", a.busy ? "reading now" : a.nextTry ? `next try ${hhmm(a.nextTry)}` : ""];
    ["5h", "7d"].forEach((name, i) => {
      rows[i].put(label, name, C.dim);
      rows[i].paste(gaugeAt, limitGauge(undefined, GW), GW);
      rows[i].putr(valueEnd, "--", C.dim);
      rows[i].put(detail, fitOrDrop(notes[i], room), C.dim);
    });
    const wordings = whyForms.flatMap((f) => [`${f} ${ICON.sep} u retries`, f]);
    return !!a.reason && wordings.includes(failLine(rows[2], wordings));
  }

  const stale = a.kind === "stale";
  const limitOf = (key: string) => a.limits.find((l) => l.key === key);
  const five = limitOf("five_hour");
  const week = limitOf("seven_day");
  // Both reset times are worded the same way: the fullest form that fits beside both gauges.
  const forms = ["long", "short", "bare"] as const;
  const form = forms.find((f) => [five, week].every((l) => !l || width(resetText(l.resetsAt, now, f)) <= room)) ?? "bare";
  const resets = (l: LimitView): string => forms.slice(forms.indexOf(form)).map((f) => resetText(l.resetsAt, now, f)).find((text) => width(text) <= room) ?? "";
  const limitRow = (r: Row, name: string, l: LimitView | undefined, extra?: Seg[]) => {
    r.put(label, name, C.dim);
    r.paste(gaugeAt, limitGauge(l?.pct, GW, l?.tick, stale), GW);
    if (!l) return void r.putr(valueEnd, "--", C.dim);
    const tone = figureTone(l.pct);
    r.putr(valueEnd, `${Math.round(l.pct)}%`, stale ? C.dim : tone.color, !stale && tone.bold);
    if (extra) r.segs(detail, segsWidth(extra) <= room ? extra : []);
    else if (l.fullIn) {
      // Runway: at this pace the limit is full before it resets. Say when, instead of the reset time.
      const minutes = l.fullIn / 60_000;
      r.put(detail, firstFit([fullInText(minutes), `~${roughly(minutes)}`], room), C.red, true);
    } else r.put(detail, resets(l), C.dim);
  };
  limitRow(rows[0], "5h", five);
  limitRow(rows[1], "7d", week);
  // Where "as of" does not fit beside the reason, the time alone still says the figures are old.
  const asOf = hhmm(a.asOf);
  if (stale) {
    const withReason = a.reason ? whyForms.flatMap((f) => [`as of ${asOf} ${ICON.sep} ${f}`, `${asOf} ${ICON.sep} ${f}`]) : [];
    return withReason.includes(failLine(rows[2], [...withReason, `as of ${asOf}`, asOf]));
  }

  const x = a.extra;
  const opus = limitOf("seven_day_opus");
  const sonnet = limitOf("seven_day_sonnet");
  // The third row, first of all: how the five-hour limit goes at this pace, as the phone says it. "extra off" is
  // never said: it is the usual case and tells you nothing.
  const f = fiveHourLine(now, a);
  const span = g.accountEnd - label + 1;
  const forecast: Seg[][] =
    f.kind === "out"
      ? [
          [["runs out ", C.red, true], [`~${f.outAt}`, C.red, true], [f.gap ? `, ${f.gap} before the ${f.resetAt} reset` : "", C.dim]],
          [["runs out ", C.red, true], [`~${f.outAt}`, C.red, true], [f.gap ? ` · ${f.gap} early` : "", C.dim]],
          [["out ", C.red, true], [`~${f.outAt}`, C.red, true]],
        ]
      : f.kind === "full"
        ? [[["5h full", C.red, true], [f.resetAt ? ` · back at ${f.resetAt}` : "", C.dim]], [["5h full", C.red, true]]]
        : f.kind === "lasts"
          ? [
              [["lasts", C.green, true], [` to the ${f.resetAt} reset · ~${f.by}% used by then`, C.dim]],
              [["lasts", C.green, true], [` to ${f.resetAt} · ~${f.by}%`, C.dim]],
              [["lasts", C.green, true], [` · ~${f.by}%`, C.dim]],
            ]
          : [];
  const fits = forecast.find((segs) => segsWidth(segs) <= span);
  if (fits) rows[2].segs(label, fits);
  else if (x?.enabled) {
    const spend: Seg[] = [[x.used, C.text], [` of ${x.limit}`, C.dim]];
    limitRow(rows[2], "extra", { key: "extra", label: "extra", pct: x.pct, resetsAt: 0, windowMs: 0 }, segsWidth(spend) <= room ? spend : [spend[0]]);
  } else if (opus && sonnet) {
    const tone = figureTone(sonnet.pct);
    limitRow(rows[2], "opus", opus, [["sonnet ", C.dim], [`${Math.round(sonnet.pct)}%`, tone.color, tone.bold]]);
  } else if (opus || sonnet) {
    const only = (opus ?? sonnet)!;
    limitRow(rows[2], fit(only.label, 5).trimEnd(), only);
  }
  return false;
}

/**
 * The medium header's one row: the same instruments, smaller. cpu and mem, then load and the 5-hour
 * and 7-day limits (or, without --usage, load and the busiest processes). The design gives the columns
 * at 150 and at 110; in between and below, what does not fit beside the lane is left out: load first,
 * then the reset times, and under 109 columns the gauges shorten and close up.
 */
function mediumRow(r: Row, g: Grid, a: AccountView | undefined, now: number, noteLine = false): boolean {
  const end = g.textEnd;
  const tight = end < 76;
  const base = { GW: tight ? 6 : 8, gap: tight ? 2 : 3 };
  const five = a?.limits.find((l) => l.key === "five_hour");
  const week = a?.limits.find((l) => l.key === "seven_day");
  const stale = a?.kind === "stale";
  const load = `load ${machine.load.toFixed(1)}`;
  const loadOn = !!a && a.kind !== "none" && end >= 104; // 150 columns and up
  /** What may follow a limit's gauge: its forecast in two wordings when there is one, else its bare reset time. */
  const timeForms = (l?: LimitView): string[] => (stale || !l ? [] : l.fullIn ? [`full ~${roughly(l.fullIn / 60_000)}`, `~${roughly(l.fullIn / 60_000)}`] : [resetText(l.resetsAt, now, "bare")].filter(Boolean));
  // Stale figures say so (a red ✗ and their time; with no line under the block, the reason too where it fits), and a forecast is shown:
  // neither is ever what is left out. To make room the reset times go, then load, then the gauges shorten. Nothing else ever shrinks them.
  type Plan = { GW: number; gap: number; load: boolean; five: string; week: string; note: string };
  const asOf = a && a.kind !== "none" ? hhmm(a.asOf) : "";
  const notes = !stale ? [""] : [...(a!.reason && !noteLine ? reasonForms(a!.reason).map((f) => `as of ${asOf} ${ICON.sep} ${f}`) : []), `as of ${asOf}`, asOf];
  const fives = [...timeForms(five), ...(five?.fullIn && !stale ? [] : [""])];
  const weeks = [...timeForms(week), ...(week?.fullIn && !stale ? [] : [""])];
  const urgent = stale || !!five?.fullIn || !!week?.fullIn;
  const sizes = urgent ? [base, { GW: 6, gap: 2 }, { GW: 4, gap: 2 }].filter((s) => s.GW <= base.GW) : [base];
  /** The last column a plan uses: cpu, mem, load, 5h and its time (a slot of at least 5 cells), 7d and its time, the stale note. */
  const lastCol = (p: Plan) => {
    const meter = 2 + p.GW + 6;
    let c = 2 + (3 + p.GW + 6) * 2 + p.gap * 2 + (p.load ? 13 : 0) + meter;
    c += p.five ? 1 + Math.max(5, width(p.five) + 1) + 2 : p.gap;
    c += meter + (p.week ? 1 + width(p.week) : 0) + (p.note ? 4 + width(p.note) : 0);
    return c - 1;
  };
  let plan: Plan = { ...sizes[sizes.length - 1], load: false, five: "", week: "", note: "" };
  find: for (const size of sizes)
    for (const note of notes)
      for (const fiveText of fives)
        for (const withLoad of loadOn ? [true, false] : [false])
          for (const weekText of weeks) {
            const p = { ...size, load: withLoad, five: fiveText, week: weekText, note };
            if (lastCol(p) <= end) {
              plan = p;
              break find;
            }
          }
  const GW = a && a.kind !== "none" ? plan.GW : base.GW;
  const gap = a && a.kind !== "none" ? plan.gap : base.gap;
  let col = 2;
  /** A label, a gauge and a value from `col`, which moves on to the column after the value. */
  const meter = (name: string, gaugeText: string, value: string, color: RGB, isBold = false) => {
    r.put(col, name, C.dim);
    r.paste(col + name.length + 1, gaugeText, GW);
    col += name.length + GW + 6;
    r.putr(col - 1, value, color, isBold);
  };
  const memPct = machine.memTotal > 0 ? (machine.memUsed / machine.memTotal) * 100 : 0;
  const memTone = figureTone(memPct);
  meter("cpu", rateGauge(machine.cpu, GW), `${Math.round(machine.cpu)}%`, C.text);
  col += gap;
  meter("mem", limitGauge(memPct, GW), `${Math.round(memPct)}%`, memTone.color, memTone.bold);
  col += gap;

  if (!a) {
    if (col + width(load) - 1 <= end) {
      r.put(col, load, C.dim);
      col += 13;
    }
    r.segs(col, topSegs(end - col + 1));
    return false;
  }
  if (a.kind === "none") {
    if (end >= 104) {
      r.put(col, load, C.dim);
      col += 13;
    }
    const w = end - col + 1;
    const wordings = reasonForms(a.reason).flatMap((f) => [`${f} ${ICON.sep} u retries`, f]);
    const text = a.reason ? firstFit(wordings, w - 2) : "";
    if (a.reason) r.segs(col, [[`${ICON.failed} `, C.red], [text, C.dim]]);
    else r.put(col, fitOrDrop(a.busy ? "reading the usage figures" : "no reading yet", w), C.dim);
    return wordings.includes(text);
  }
  if (plan.load) {
    r.put(col, load, C.dim);
    col += 13;
  }
  /** One limit from `col`, then its time (or its forecast, in bold red) when the plan has one. */
  const limit = (name: string, l: LimitView | undefined, text: string) => {
    const tone = figureTone(l?.pct ?? 0);
    meter(name, limitGauge(l?.pct, GW, l?.tick, stale), l ? `${Math.round(l.pct)}%` : "--", !l || stale ? C.dim : tone.color, !!l && !stale && tone.bold);
    if (l && text) r.put(col + 1, text, l.fullIn ? C.red : C.dim, !!l.fullIn);
  };
  limit("5h", five, plan.five);
  col += plan.five ? 1 + Math.max(5, width(plan.five) + 1) + 2 : gap;
  limit("7d", week, plan.week);
  if (plan.note) r.segs(col + (plan.week ? 1 + width(plan.week) : 0) + 2, [[`${ICON.failed} `, C.red], [plan.note, C.dim]]);
  return !!a.reason && plan.note !== asOf && plan.note !== `as of ${asOf}`;
}

/**
 * The older header, kept by compact mode and by terminals under 100 columns: fleet line, machine line,
 * account line with --usage, rule. Its counts and its tool-call total are taken in `win`, the window the
 * rows below count in, so the total is the sum of the sessions' own figures; its sparkline has more,
 * shorter bars than theirs.
 */
function oldHeader(sessions: Session[], W: number, now: number, win: Win): string[] {
  const HS = Math.min(60, Math.max(stripBars(W), W - 92));
  const calls = sessions.flatMap(tailsOf).map((t) => t.tools);
  const headBuckets = buckets(calls, now, HS);
  const c = fleetCounts(sessions, now, win.start);
  const active = c.sessions - c.idle;
  const waiting = c.needs ? `${ICON.needs} ${c.needs} need${c.needs === 1 ? "s" : ""} you` : "";
  const stats =
    (waiting ? `${waiting}  ·  ` : "") +
    `${active} active session${active === 1 ? "" : "s"}  ·  ${c.agents} agent${c.agents === 1 ? "" : "s"} running  ·  ` +
    `${c.workflows} workflow${c.workflows === 1 ? "" : "s"}  ·  ${human(sum(bucketsIn(calls, win)))} tool calls / ${opt.windowMin}m`;
  const left = ` ${ICON.claude} CLAUDE FLEET   `;
  const clockText = new Date(now).toTimeString().slice(0, 8);
  const shown = fit(stats, Math.max(0, W - width(left) - HS - 2 - clockText.length - 2));
  const out = [
    // Amber is spent on the one thing that needs you; the rest of the line stays in text colour.
    fg(C.cyan, bold(left)) + (waiting ? bold(fg(C.amber, shown.slice(0, waiting.length))) : "") + fg(C.text, shown.slice(waiting.length)) + " " + spark(headBuckets, Math.max(...headBuckets), ...RAMP.fleet) + "  " + fg(C.dim, clockText) + " ",
    machineRow(W),
  ];
  if (opt.usage) {
    out.push(usageRow(W, now));
    const remedy = accountView(now).remedy;
    if (remedy) out.push(fg(C.dim, " " + fit("        " + remedy, W - 2, "l", true))); // what to do about it, when there is something
  }
  out.push(fg(C.faint, " " + "─".repeat(W - 2)));
  return out;
}

/**
 * The header's rows. `frameWin` is the window the rows below count in (frameWindow), which the older
 * header takes its counts and total from. The tall and medium headers are only drawn above rows that
 * count in the lane's window, and read that: their chart, totals and tiles agree with the sparklines underneath.
 */
export function header(sessions: Session[], W: number, rows: number, now: number, frameWin: Win = frameWindow(now, W)): string[] {
  const kind = headerKind(W, rows);
  if (kind === "old") return oldHeader(sessions, W, now, frameWin);
  const g = grid(W);
  const win = laneWindow(now, W);
  const tailsHere = sessions.flatMap(tailsOf);
  const counts = bucketsIn(tailsHere.map((t) => t.tools), win);
  const a = opt.usage ? accountView(now) : undefined;
  // A failing read you can do something about brings its remedy, on one dim line under the blocks. The line is there for as long
  // as the reason is, whether or not somebody else's figures are filling the block, so the header does not change height as those come and go.
  const noteLine = !!a && !!usageRemedy(a.reason);
  const body = Array.from({ length: (kind === "tall" ? 3 : 1) + (noteLine ? 1 : 0) }, () => new Row(W));
  let reasonShown: boolean;
  if (kind === "tall") {
    machineBlock(body, g);
    reasonShown = accountBlock(body, g, a, now);
  } else reasonShown = mediumRow(body[0], g, a, now, noteLine);
  if (noteLine) body[body.length - 1].put(2, usageNote(a!, g.textEnd - 1, reasonShown), C.dim);
  // The fleet: tool calls across the window as a chart in the lane, as tall as the rows beside it, and its figures in the figure field.
  const chart = fleetChart(counts, body.length);
  const figures: [string, string][] = [[human(sum(counts)), " tools"], [human(tokensIn(tailsHere, win)), " out"], [barLabel(win), " a bar"]];
  body.forEach((r, i) => {
    r.paste(g.lane, chart[i], g.laneW);
    if (i >= figures.length) return;
    const left = r.putr(g.figEnd, figures[i][1], C.dim);
    r.putr(left, figures[i][0], C.text);
  });
  return [masthead(g, fleetCounts(sessions, now, win.start), now), ...body, axisRow(g, win)].map(String);
}

/** Terminals with at least this many rows get a blank row under the header; shorter ones need every row for sessions. */
export const HEADER_GAP_MIN_ROWS = 30

export function render(sessions: Session[], cols: number, rows: number, now: number): string[] {
  const W = Math.max(60, cols);
  const S = stripBars(W); // sparkline columns in compact rows
  // One window for the whole frame: the header's totals and tiles, which sessions and agents count as recent, and every figure below read these edges.
  const win = frameWindow(now, W);
  const since = win.start;
  const spin = fg(C.green, SPIN[frame % SPIN.length]);
  const out: string[] = [];

  hits.length = 0;

  const all = buildViews(sessions, now, since);
  if (focusSid && !all.some((v) => v.s.sid === focusSid)) focusSid = null;
  const shown = all.filter((v) => (focusSid ? v.s.sid === focusSid : opt.showAll || !isHidden(v)));
  const hidden = all.filter((v) => !shown.includes(v));

  // The header: tall or medium in detail and far mode, the older lines in compact mode and under 100 columns.
  out.push(...header(sessions, W, rows, now, win));
  // One clear row between the header and the sessions, in every mode, unless the terminal is too short to spare it.
  const gap = rows >= HEADER_GAP_MIN_ROWS;
  if (gap) out.push("");

  if (!shown.length) {
    out.push(...(gap ? [] : [""]), fg(C.dim, all.length ? "   Nothing active and nothing waiting on you." : "   No live Claude Code sessions found in ~/.claude/sessions."));
  }

  // Compact rows share these scales, so they can be compared with each other. Taken before rows are folded away to fit
  // the screen: a row that folds (an agent going quiet changes which ones fold) must not rescale the rows that stay.
  const agentMax = Math.max(1, ...shown.flatMap((v) => v.groups.flatMap((g) => g.rows.map((a) => Math.max(...buckets([a.tail.tools], now, S))))));
  const sessionMax = Math.max(1, ...shown.map((v) => Math.max(...buckets(tailsOf(v.s).map((t) => t.tools), now, S))));

  // Rows for the sessions: all of them but the button bar and, while one session is focused, the hint above it. Detail mode's blocks
  // run down to the buttons, as the design's frames do; compact rows and far cards keep one row clear above them, as they always have.
  const avail = rows - out.length - 1 - (focusSid && hidden.length ? 1 : 0) - (opt.mode === "far" ? 1 : 0);
  const { views, gaps, cut } = { views: [] as View[], gaps: false, cut: 0 };
  // Detail mode draws its sessions with its own renderer (the detail view, above). The tree further down is compact mode's.
  // Detail and compact draw sessions with the detail view; compact leaves out the conversation and the lines under tasks.
  if (opt.mode !== "far") out.push(...detailView(shown, W, avail, now, out.length));

  // Compact rows' columns.
  const ACT = W >= 150 ? 40 : W >= 120 ? 28 : W >= 100 ? 18 : 0; // "what it is doing" column
  const META = W >= 110 ? 18 : 0; // agent type / model column
  const PW = W >= 130 ? 20 : 12; // progress glyph column

  if (opt.mode === "far") {
    // Big cards, readable from across the room: colour and shape carry the state.
    const H = Math.max(4, Math.min(11, Math.floor(avail / Math.max(1, shown.length))));
    // When some cards do not fit, the line that says so needs a row of its own, inside the rows given.
    const fitAll = Math.max(1, Math.floor(avail / H));
    const fitCount = fitAll >= shown.length ? fitAll : Math.max(1, Math.floor((avail - 1) / H));
    const cards = shown.slice(0, fitCount);
    const CW = Math.max(10, W - 40);
    const bars = farBars(CW, opt.windowMin * 60_000);
    const chartAt = 5 + CW - bars.n * bars.w; // a chart of fewer, wider bars keeps to the right edge of its space
    const farBuckets = new Map(cards.map((v) => [v.s.sid, buckets(tailsOf(v.s).map((t) => t.tools), now, bars.n)]));
    const farMax = Math.max(1, ...[...farBuckets.values()].map((b) => Math.max(...b)));
    const sideAt = 5 + CW + 3; // the side column: 32 cells, ending one short of the edge
    for (const v of cards) {
      const s = v.s;
      const f = v.facts;
      const st = STATE[v.state];
      const waiting = v.state === "needs";
      const quietened = isReceded(v.state);
      const dimHere = waiting ? C.warmDim : C.dim; // dim text on the amber tint is a warm dim
      // The thick rail runs the card's full height in the state's colour; a waiting card is tinted across its whole width.
      const railColor = railTone(v.state, true, beat());
      const row = () => {
        const r = new Row(W, waiting ? C.tint : undefined);
        r.put(2, ICON.railThick, railColor);
        return r;
      };
      const top = out.length;
      for (const row of [top + 1, top + 2]) hits.push({ row, x0: 1, x1: W, act: "focus:" + s.sid }); // the title and the subheading, as in detail mode

      // Title: the name in letter-spaced capitals. The state, its glyph first, ends at the right edge and never shrinks.
      const stateText = st.word.split("").join(" ");
      const nameRoom = W - width(stateText) - 9;
      const spaced = [...s.name.toUpperCase()].join(" ");
      const title = row();
      title.put(5, fit(width(spaced) <= nameRoom ? spaced : s.name.toUpperCase(), nameRoom, "l", true).trimEnd(), quietened ? C.text : C.white, true);
      title.segsr(W - 1, [[`${st.glyph} `, st.color, true], [stateText, st.color, true]]);
      out.push(title.toString());

      // Subheading, from the same chain as detail mode: the question, what it is doing, your prompt (▸) or Claude's reply (◆, white while it is new).
      const sub = subheading(s, f, v.state);
      const second = row();
      let x = 5;
      if (sub.source === "prompt") x = second.put(5, ICON.you, C.blue, true) + 1;
      else if (sub.source === "reply") x = (sub.t !== undefined && isNew(sub.t) ? second.put(5, ICON.claude, C.white, true) : second.put(5, ICON.claude, C.cyan)) + 1;
      second.put(x, fit(sub.text, W - x).trimEnd(), quietened ? C.text : C.white, waiting);
      out.push(second.toString());

      const chartH = Math.max(1, H - 3 - (H > 4 ? 1 : 0)); // a row less when the card has room for the marks under its chart
      const cardBuckets = farBuckets.get(s.sid)!;
      const chart = tallSpark(cardBuckets.flatMap((v) => new Array(bars.w).fill(v)), farMax, chartH, ...RAMP.session);
      const agentsLive = [...s.agents, ...s.workflows.flatMap((w) => w.agents)].filter((a) => !a.done && lastWriteOf(a.tail) >= since).length;
      const wfLive = s.workflows.filter((w) => w.status === "running" && w.lastT >= since).length;
      const ctx = f.main?.ctx;
      const use = useOf(s);
      // Side column, one fact a row beside the chart: agents and workflows, context, the process tree, tool calls, tasks.
      const side: ((r: Row) => void)[] = [
        (r) =>
          r.segs(sideAt, [
            [`${agentsLive ? SPIN[frame % SPIN.length] : ICON.idle} `, agentsLive ? C.green : dimHere],
            [`${agentsLive} AGENT${agentsLive === 1 ? "" : "S"}`, agentsLive ? C.text : dimHere, true],
            ...(wfLive ? ([[`   ${ICON.workflow} `, C.purple], [`${wfLive} WORKFLOW${wfLive === 1 ? "" : "S"}`, C.purple]] as Seg[]) : []),
          ]),
      ];
      if (ctx)
        side.push((r) => {
          // The context gauge follows the one rule for limits. Runway: when the window will be full within the hour, that follows the figure.
          const pct = Math.min(100, (ctx.used / ctxMax(ctx)) * 100);
          const runway = sessionRunway(f.main, now);
          const forecast = runway === undefined ? "" : fullInText(runway);
          const figure = ` ${Math.round(pct)}%`;
          const GW = Math.max(4, Math.min(16, W - sideAt - 4 - width(figure) - (forecast ? width(forecast) + 1 : 0)));
          const tone = figureTone(pct);
          let col = r.put(sideAt, "CTX ", dimHere);
          col = r.paste(col, limitGauge(pct, GW), GW);
          col = r.put(col, figure, tone.color, tone.bold);
          if (forecast) r.put(col + 1, forecast, runwayTone(runway!), true);
        });
      // With more than one machine on the screen, the machine leads its CPU row.
      side.push((r) => r.put(sideAt, `${machineOf(s) ? `${machineOf(s)!.toUpperCase()} ${ICON.sep} ` : ""}CPU ${Math.round(use.cpu)}% ${ICON.sep} ${gb(use.rss * 1024)}`, dimHere));
      // Counted on the lane's bars, as the header's total and detail mode's figure are, so the cards add up to the header (the chart beside it has finer bars).
      side.push((r) => r.put(sideAt, `${human(sum(bucketsIn(tailsOf(s).map((t) => t.tools), win)))} tool calls / ${opt.windowMin}m`, dimHere));
      const tasks = s.tasks;
      if (tasks?.total)
        side.push((r) => {
          const n = Math.min(20, tasks.total);
          r.put(r.paste(sideAt, pips(tasks.done, tasks.doing, tasks.total, n), n), `  ${tasks.done}/${tasks.total}`, C.text);
        });
      for (let i = 0; i < chartH; i++) {
        const r = row();
        r.paste(chartAt, chart[i], bars.n * bars.w);
        side[i]?.(r);
        out.push(r.toString());
      }
      if (H > 4) {
        // Under the chart, what happened when: the weightiest mark wins a bar shared by two.
        const marks = row();
        const win = timeWindow(now, opt.windowMin * 60_000, bars.n);
        const at = new Map<number, [number, string, RGB]>();
        for (const [t, weight, glyph, color] of marksOf(s)) {
          if (t < win.start || t >= win.end) continue;
          const i = barOf(t, win);
          if (!at.has(i) || at.get(i)![0] < weight) at.set(i, [weight, glyph, color]);
        }
        for (const [i, [, glyph, color]] of at) marks.put(chartAt + i * bars.w + Math.floor((bars.w - 1) / 2), glyph, color);
        out.push(marks.toString());
        out.push("");
      }
      while (out.length < top + H) out.push("");
      out.length = top + H;
    }
    if (shown.length > cards.length) out.push(fg(C.dim, `   … ${shown.length - cards.length} more session${shown.length - cards.length === 1 ? "" : "s"} not shown (screen full)`));
  }

  const agentRow = (a: Agent, prefix: string, stalled = false): string => {
    const st = stateOf(a, now);
    const quietFor = now - lastWriteOf(a.tail);
    // ◐ is a tool call outstanding: white, red when stalled, never a yellow dot. Amber is kept for what needs you.
    const dot = stalled ? fg(C.red, ICON.progress) : st === "active" ? spin : st === "tool" ? fg(C.white, ICON.progress) : st === "done" ? fg(C.done, ICON.done) : fg(C.dim, ICON.idle);
    const pending = pendingOf(a.tail);
    const labelW = W - width(prefix) - 2 - (META ? META + 2 : 0) - S - 2 - (ACT ? ACT + 2 : 0) - 6 - 1;
    const b = buckets([a.tail.tools], now, S);
    const tone = st === "done" ? C.dim : st === "quiet" ? C.dim : C.text;
    // What it is doing: the pending tool's name in cyan and its hint in text colour, else one dim word.
    let doing = "";
    if (ACT) {
      const lead = stalled ? "stalled? " : "";
      if (st !== "done" && pending) {
        const name = [...pending.name].slice(0, Math.max(0, ACT - lead.length)).join("");
        const hintW = Math.max(0, ACT - lead.length - width(name) - 2);
        doing = fg(C.red, lead) + fg(C.cyan, name) + (hintW ? "  " + fg(C.text, fit(pending.hint, hintW)) : " ".repeat(ACT - lead.length - width(name)));
      } else doing = fg(stalled ? C.red : C.dim, fit(lead + (st === "done" ? "finished" : st === "quiet" ? "no activity" : "thinking"), ACT));
    }
    return (
      fg(C.faint, prefix) +
      dot +
      " " +
      fg(tone, fit(a.label, labelW)) +
      (META ? "  " + fg(C.dim, fit([shortType(a.type), a.model].filter(Boolean).join(" · "), META)) : "") +
      "  " +
      spark(b, agentMax, ...RAMP.agent) +
      (ACT ? "  " + doing : "") +
      " " +
      fg(stalled ? C.red : st === "active" ? C.green : C.dim, fit(st === "active" ? "live" : ago(quietFor), 6, "r"))
    );
  };

  views.forEach((v, vi) => {
    const s = v.s;
    const tailsHere = tailsOf(s);
    const b = buckets(tailsHere.map((t) => t.tools), now, S);
    const branch = s.mains.map((m) => m.branch).find(Boolean);
    const home = os.homedir();
    const where = (machineOf(s) ? `${machineLabel(s)} ${ICON.sep} ` : "") + foldersOf(s.cwd.replace(home, "~")).slice(-2).join("/") + (branch && branch !== "HEAD" ? ` ${ICON.at} ${branch}` : "");
    const stalled = v.state === "stalled";
    // The lead glyph is the state: ▲ needs you, ◐ stalled, ● working, ▸ your turn, ○ idle, ✓ finished.
    const state = STATE[v.state];
    const dot = fg(state.color, state.glyph);
    const quietened = isReceded(v.state);
    const f = v.facts;
    const wide = W >= 120;
    const use = useOf(s);
    const ctxNow = f.main?.ctx;
    const ctxPct = ctxNow ? Math.min(100, (ctxNow.used / ctxMax(ctxNow)) * 100) : -1;
    // Context is a limit, so its figure follows the limit rule; CPU is a rate and stays dim.
    const ctxTone = figureTone(Math.max(0, ctxPct));
    const ctxText = fg(ctxPct >= 0 ? ctxTone.color : C.dim, fit(ctxPct >= 0 ? `ctx ${Math.round(ctxPct)}%` : "", 8, "r"));
    const right =
      fg(C.text, fit(human(sum(b)) + " tools", 10, "r")) +
      "  " +
      fg(C.text, fit(human(tokensIn(tailsHere, win)) + " out", 8, "r")) +
      (wide ? "  " + (ctxTone.bold ? bold(ctxText) : ctxText) + "  " + fg(C.dim, fit(use.cpu >= 1 ? `cpu ${Math.round(use.cpu)}%` : "", 9, "r")) : "");
    const rightW = 10 + 2 + 8 + (wide ? 2 + 8 + 2 + 9 : 0);
    // The status cell is the state's word and its time: "NEEDS YOU · 6m" (the lead ▲ is the only warning glyph), "working · up 1h04", "your turn · 12m".
    const time = stateTime(s, f, v.state, now, v.stall.since);
    const status = (v.state === "needs" ? state.word : state.word.toLowerCase()) + (time ? ` ${ICON.sep} ${time}` : "");
    const statusTone = state.color;
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
        fg(quietened ? C.text : C.white, bold(fit(s.name, nameW))) +
        "  " +
        fg(C.dim, fit(`${s.kind || "cli"} ${s.sid.slice(0, 8)}`, idW)) +
        (whereW ? "  " + fg(C.dim, fit(where, whereW)) : "") +
        "  " +
        (f.needs || stalled ? bold(fg(statusTone, fit(status, statusW))) : fg(statusTone, fit(status, statusW))) +
        "  " +
        spark(b, sessionMax, ...RAMP.session) +
        right +
        " ",
    );

    // Children: the question, workflow groups, standalone agents, finished summary.
    type Child = { kind: "needs" } | { kind: "wf"; g: Group } | { kind: "agent"; a: Agent } | { kind: "more"; n: number } | { kind: "done"; n: number };
    const children: Child[] = [];
    if (v.showNeeds) children.push({ kind: "needs" });
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
        // The question: bold white on the amber tint, led by the one mark that means "look here".
        out.push(fg(C.faint, elbow) + `\x1b[48;2;${C.tint.join(";")}m` + bold(fg(C.amber, ICON.needs)) + bold(fg(C.white, ` ${fit(f.needs, rest - 3).trimEnd()} `)) + "\x1b[49m");
      } else if (c.kind === "agent") {
        out.push(agentRow(c.a, elbow, isStalled(c.a)));
      } else if (c.kind === "more") {
        out.push(fg(C.faint, elbow) + fg(C.dim, `… ${c.n} more agent${c.n === 1 ? "" : "s"} (screen full)`));
      } else if (c.kind === "done") {
        out.push(fg(C.faint, elbow) + fg(C.done, `${ICON.done} `) + fg(C.dim, `${c.n} agent${c.n === 1 ? "" : "s"} finished in the last ${opt.windowMin}m`) + fg(C.faint, `  ${ICON.sep}  d lists them`));
      } else {
        const wf = c.g.wf!;
        const total = wf.agents.length;
        const finished = wf.agents.filter((a) => a.done).length;
        const live = wf.status === "running";
        const wb = buckets(wf.agents.map((a) => a.tail.tools), now, S);
        // ≡ while it runs; when it ends, ✓ or ✗ takes its place and the status says how.
        const outcome = wfOutcome(wf);
        const lead = outcome === "running" ? bold(fg(C.purple, ICON.workflow)) : outcome === "completed" ? fg(C.done, ICON.done) : fg(C.red, ICON.failed);
        const statusC = live ? C.green : wf.status === "completed" ? C.dim : C.red;
        const tail =
          `${fit(live ? "up " + ago(now - wf.started) : wf.status, 10, "r")}` + (wf.tokens !== undefined ? `  ${fit(human(wf.tokens) + " tok", 9, "r")}` : " ".repeat(11));
        // On a narrow screen the phase column gives way before the name does.
        const slack = W - width(elbow) - PW - S - width(tail) - 17;
        const phaseW = slack - 10 < 6 ? 0 : Math.min(28, slack - 10);
        const nameW2 = Math.max(10, slack - phaseW);
        // The current phase, as ◐ and its name in bold white.
        const phase = live && wf.phase && phaseW >= 4 ? fg(C.white, `${ICON.progress} `) + bold(fg(C.white, fit(wf.phase, phaseW - 2))) : " ".repeat(phaseW);
        out.push(
          fg(C.faint, elbow) +
            lead +
            " " +
            fg(live ? C.white : C.text, fit(wf.name, nameW2)) +
            "  " +
            phase +
            " " +
            pips(finished, live ? total - finished : 0, total, PW) +
            " " +
            fg(C.text, fit(`${finished}/${total}`, 7)) +
            " " +
            spark(wb, Math.max(agentMax, ...wb), ...RAMP.workflow) +
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

  // Idle and finished sessions kept off the screen are counted on the masthead and on the a button. Only focus leaves a line here.
  if (focusSid && hidden.length) {
    while (out.length < rows - 2) out.push("");
    out.length = Math.max(0, rows - 2);
    out.push(fg(C.dim, "   " + fit(`focused on one session  ${ICON.sep}  esc or click it again to return  ${ICON.sep}  ${hidden.length} other${hidden.length === 1 ? "" : "s"} not shown`, W - 4, "l", true).trimEnd()));
  }
  while (out.length < rows - 1) out.push("");
  out.length = Math.max(0, rows - 1);
  if (menu.open) {
    const first = rows - 1 - (1 + Math.ceil(menuItems().length / (W >= 90 ? 2 : 1))); // out[first] is screen row first + 1
    for (let i = hits.length - 1; i >= 0; i--) if (hits[i].row > first) hits.splice(i, 1);
    menuPanel(W, first + 1).forEach((line, i) => (out[first + i] = line));
  }
  out.push(buttonBar(W, rows, all.filter(isHidden).length));
  // The layout is made for 80 columns and up, and is not drawn narrower than 60. On anything smaller a row is cut at the edge rather than left to wrap.
  return out.map((line) => clipRow(line, cols));
}

/** One entry in the menu: its key, what it is, how it stands now, and the control it works. */
export interface MenuItem {
  key: string;
  label: string;
  state: string;
  act: string;
}
/** The menu (key m): what is used now and then, each also on its own key. A switch keeps the menu open, so its new state shows; the rest open a screen. */
export function menuItems(): MenuItem[] {
  const svc = svcState();
  return [
    { key: "d", label: "Finished agents", state: opt.showDone ? "shown" : "hidden", act: "done" },
    { key: "b", label: "Bell", state: opt.bell ? "on" : "off", act: "bell" },
    { key: "w", label: "Phone page", state: web.url ? "on" : "", act: "web" },
    { key: "t", label: "Telegram", state: tg.paired ? "paired" : "set up", act: "telegram" },
    { key: "i", label: "In the background", state: !svc.supported ? "" : svc.installed ? "installed" : "off", act: "service" },
  ];
}
/** Controls the menu stays open for. */
export const MENU_SWITCHES = new Set(["done", "bell"]);
/**
 * The open menu: a rule and its entries in two columns (one under 90 columns), drawn over the rows just
 * above the button bar, the first of them screen row `top`. Each entry is clickable; the rows' other
 * targets are taken away, so a click there cannot reach what is under the menu.
 */
export function menuPanel(W: number, top: number): string[] {
  const items = menuItems();
  const cols = W >= 90 ? 2 : 1;
  const colW = cols === 2 ? Math.min(44, Math.floor((W - 6) / 2)) : W - 4;
  const perCol = Math.ceil(items.length / cols);
  const out: string[] = [];
  const rule = new Row(W);
  rule.put(1, "─".repeat(W), C.faint);
  rule.segs(3, [[" MENU ", C.cyan, true], ["m or esc closes ", C.dim]]);
  out.push(rule.toString());
  for (let i = 0; i < perCol; i++) {
    const r = new Row(W);
    for (let c = 0; c < cols; c++) {
      const it = items[c * perCol + i];
      if (!it) continue;
      const x = 3 + c * (colW + 2);
      r.put(x, it.key, C.white, true);
      r.put(x + 3, fitOrDrop(it.label, colW - 16), C.text);
      if (it.state) r.putr(x + colW - 1, it.state, it.state === "on" || it.state === "shown" || it.state === "paired" || it.state === "installed" ? C.cyan : C.dim);
      hits.push({ row: top + 1 + i, x0: x, x1: x + colW - 1, act: it.act });
    }
    out.push(r.toString());
  }
  return out;
}

/**
 * The bottom row: the everyday controls, clickable, with their keys; the rest are in the menu (m). The count of idle and finished sessions kept
 * off the screen rides on the a button, and the count of things new since you looked on the space
 * button. Labels shorten in two steps when the row does not fit: digits for the modes and shorter
 * words, then keys alone.
 */
export function buttonBar(W: number, row: number, idle = 0): string {
  const build = (level: 0 | 1 | 2) => {
    const found: typeof hits = [];
    let x = 2;
    let line = " ";
    const add = (full: string, shorter: string, key: string, act: string, on = false) => {
      const text = ` ${[full, shorter, key][level]} `;
      found.push({ row, x0: x, x1: x + width(text) - 1, act });
      line += on ? `\x1b[48;2;86;205;214m\x1b[38;2;12;16;20m${bold(text)}\x1b[39m\x1b[49m` : `\x1b[48;2;40;45;54m${fg(C.text, text)}\x1b[49m`;
      line += " ";
      x += width(text) + 1;
    };
    const plain = (text: string) => {
      line += fg(C.dim, text);
      x += width(text);
    };
    add("1 Detail", "1 Detail", "1", "mode:detail", opt.mode === "detail");
    add("2 Compact", "2 Compact", "2", "mode:compact", opt.mode === "compact");
    add("3 Timeline", "3 Timeline", "3", "mode:far", opt.mode === "far");
    plain(" ");
    add("−", "−", "−", "win-");
    plain(`${opt.windowMin}m `);
    add("+", "+", "+", "win+");
    plain(" ");
    const all = idle ? `a All · ${idle} idle` : "a All";
    add(all, idle ? `a All·${idle}` : "a All", "a", "all", opt.showAll);
    const seenIt = newCount() ? `space Seen · ${newCount()} new` : "space Seen";
    add(seenIt, newCount() ? `␣ Seen·${newCount()}` : "␣ Seen", "␣", "seen");
    add("r Reply", "r Reply", "r", "reply");
    if (opt.usage) add("u Usage", "u Usage", "u", "accounts", acctOn); // every account's limits; a failing read is retried as it opens
    add("m Menu", "m Menu", "m", "menu", menu.open); // everything used now and then: see menuItems()
    add("? Legend", "?", "?", "legend");
    plain(" ");
    add("q Quit", "q Quit", "q", "quit");
    return { line, used: x, found };
  };
  // Shorter labels when the buttons do not fit, or a notice needs the room.
  const noticeOn = !!notice.text && clock() < notice.until;
  const tight = (b: { used: number }) => b.used > W || (noticeOn && W - b.used - 2 < width(notice.text));
  let bar = build(0);
  if (tight(bar)) bar = build(1);
  if (tight(bar)) bar = build(2);
  hits.push(...bar.found);
  // The hint: a notice, or how to focus a session.
  const room = W - bar.used - 2;
  if (notice.text && clock() < notice.until) return bar.line + " " + fg(C.amber, fit(notice.text, Math.max(0, room), "r"));
  const hint = "click a session to focus it";
  return bar.line + (W - bar.used > width(hint) + 2 ? fg(C.faint, fit(hint, W - bar.used, "r")) : "");
}

/** Whom key r opens: the session in focus, else the one that has waited on you longest. */
export function replyTarget(sessions: Session[], focus: string | null): string | undefined {
  if (focus && sessions.some((s) => s.sid === focus)) return focus;
  const waiting = sessions.map((s) => ({ s, f: factsOf(s) })).filter((x) => x.f.needs);
  return waiting.sort((a, b) => stateSince(a.s, a.f, "needs") - stateSince(b.s, b.f, "needs"))[0]?.s.sid;
}

// ───────────────────────── what happened, for the timeline cards ─────────────────────────

/** A session's marks by time, weightiest last: ▸ you typed to it, ⇡ it linked a pull request, ≡ a workflow started, ✓ a task was finished. */
export function marksOf(s: Session): [t: number, weight: number, glyph: string, color: RGB][] {
  const marks: [number, number, string, RGB][] = [];
  for (const m of s.mains) for (const t of m.askLog) marks.push([t, 1, ICON.you, C.blue]);
  for (const p of s.side?.prs ?? []) marks.push([p.t, 2, ICON.pr, C.text]);
  for (const w of s.workflows) marks.push([w.started, 3, ICON.workflow, C.purple]);
  for (const m of s.mains) for (const tr of m.taskLog.values()) if (tr.finished) marks.push([tr.finished, 4, ICON.done, C.green]);
  return marks;
}

// ───────────────────────── QR codes ─────────────────────────
// Enough of the QR standard to put a link on the screen for a phone to scan: byte mode, error correction
// level L, versions 1 to 10 (up to 271 bytes). After Project Nayuki's reference implementation.

const QR_TOTAL = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346]; // codewords per version
const QR_ECC = [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18]; // error-correction codewords per block, level L
const QR_BLOCKS = [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4];
const QR_ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
function rsDivisor(degree: number): number[] {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < out.length; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < out.length) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return out;
}
function rsRemainder(data: number[], divisor: number[]): number[] {
  const out = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (out.shift() as number);
    out.push(0);
    divisor.forEach((coef, i) => (out[i] ^= gfMul(coef, factor)));
  }
  return out;
}

/** The modules of a QR code for `text` (true = dark), or undefined when it is too long. */
export function qrMatrix(text: string): boolean[][] | undefined {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 1;
  for (; version <= 10; version++) {
    const dataCodewords = QR_TOTAL[version] - QR_ECC[version] * QR_BLOCKS[version];
    if (4 + (version < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords * 8) break;
  }
  if (version > 10) return undefined;
  const size = version * 4 + 17;
  const dataCodewords = QR_TOTAL[version] - QR_ECC[version] * QR_BLOCKS[version];
  // The bit stream: byte mode, the count, the bytes, a terminator, then padding.
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, dataCodewords * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < dataCodewords * 8; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  // Split into blocks, add error correction, and interleave.
  const numBlocks = QR_BLOCKS[version];
  const eccLen = QR_ECC[version];
  const raw = QR_TOTAL[version];
  const shortBlocks = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < shortBlocks) dat.push(0);
    blocks.push([...dat, ...ecc]);
  }
  const codewords: number[] = [];
  for (let i = 0; i < blocks[0].length; i++)
    blocks.forEach((b, j) => {
      if (i !== shortLen - eccLen || j >= shortBlocks) codewords.push(b[i]);
    });

  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark;
    fixed[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]])
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, Math.max(Math.abs(dx), Math.abs(dy)) !== 2 && Math.max(Math.abs(dx), Math.abs(dy)) !== 4);
      }
  const align = QR_ALIGN[version];
  for (const ax of align)
    for (const ay of align) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === align[align.length - 1]) || (ax === align[align.length - 1] && ay === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  const formatBits = (mask: number) => {
    const d = (1 << 3) | mask; // level L is 01
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((d << 10) | rem) ^ 0x5412;
  };
  const drawFormat = (mask: number) => {
    const f = formatBits(mask);
    const bit = (i: number) => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0); // reserves the format areas; redrawn with the chosen mask below
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const v = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((v >>> i) & 1) === 1;
      set(size - 11 + (i % 3), Math.floor(i / 3), bit);
      set(Math.floor(i / 3), size - 11 + (i % 3), bit);
    }
  }
  // The codewords, in the zigzag the standard prescribes.
  let n = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fixed[y][x] && n < codewords.length * 8) {
          modules[y][x] = ((codewords[n >>> 3] >>> (7 - (n & 7))) & 1) === 1;
          n++;
        }
      }
  }
  const MASKS: ((x: number, y: number) => boolean)[] = [
    (x, y) => (x + y) % 2 === 0,
    (_x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = (m: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[m](x, y)) modules[y][x] = !modules[y][x];
  };
  // The mask with the lowest penalty, by the standard's four rules.
  const penalty = () => {
    let p = 0;
    for (const line of [...modules, ...modules[0].map((_, x) => modules.map((r) => r[x]))]) {
      let run = 1;
      for (let i = 1; i <= line.length; i++) {
        if (i < line.length && line[i] === line[i - 1]) run++;
        else {
          if (run >= 5) p += run - 2;
          run = 1;
        }
      }
      const s = line.map((d) => (d ? "1" : "0")).join("");
      p += 40 * ((s.match(/(?=10111010000)/g) ?? []).length + (s.match(/(?=00001011101)/g) ?? []).length);
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) if (modules[y][x] === modules[y][x + 1] && modules[y][x] === modules[y + 1][x] && modules[y][x] === modules[y + 1][x + 1]) p += 3;
    const dark = modules.flat().filter(Boolean).length;
    return p + 10 * Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5);
  };
  let best = 0;
  let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m);
    drawFormat(m);
    const score = penalty();
    if (score < bestScore) [best, bestScore] = [m, score];
    applyMask(m); // undo
  }
  applyMask(best);
  drawFormat(best);
  return modules;
}

/** A QR code in terminal cells, two modules to a cell, light modules drawn in white so phones read it dark-on-light, with a quiet margin. */
export function qrRows(text: string, margin = 2): string[] | undefined {
  const m = qrMatrix(text);
  if (!m) return undefined;
  const size = m.length + margin * 2;
  const dark = (x: number, y: number) => x >= margin && y >= margin && x < size - margin && y < size - margin && m[y - margin][x - margin];
  const rows: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let line = "";
    for (let x = 0; x < size; x++) {
      const top = !dark(x, y);
      const bottom = y + 1 < size ? !dark(x, y + 1) : false;
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    rows.push(fg([255, 255, 255], line));
  }
  return rows;
}

// ───────────────────────── the web dashboard ─────────────────────────
// Key w serves a page for your phone: the same sessions, as cards, each with a box to type a message into it.
// It answers only a link that carries a secret kept in ~/.config/claude-fleet/web-token, and it listens on this Mac's Tailscale
// address when it has one (reachable from your own devices, encrypted), else on this Mac alone.

const hexOf = (c: RGB) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
/** Coloured text as the page draws it: [text, colour] pairs. */
const segsJson = (segs: Seg[]) => segs.filter(([t]) => t).map(([t, c, bold]) => ({ t, c: c ? hexOf(c) : undefined, b: bold || undefined }));

/**
 * A session's roster as the detail view lists it, for the phone page and the glasses: the main thread while it is
 * busy, each workflow (its phases, how many agents have finished, tokens, activity) with its agents under it, the
 * standalone agents, and how many agents finished in the window. The same choice of rows as the terminal.
 */
export function rosterOfView(v: View, now: number, win: Win) {
  const agent = (a: Agent) => {
    const st = stateOf(a, now);
    const stalled = v.stall.threads.includes(a.id);
    const p = pendingOf(a.tail);
    return {
      label: a.label,
      state: stalled ? "stalled" : st, // active (writing), tool (waiting on a tool), quiet, done, or stalled
      tool: st !== "done" && p ? p.name : undefined,
      doing: st === "done" ? "finished" : p ? p.hint || "" : st === "quiet" ? "no activity" : "thinking",
      model: a.model || undefined,
      spark: bucketsIn([a.tail.tools], win),
      ago: ago(now - lastWriteOf(a.tail)),
    };
  };
  const main = v.facts.main;
  return {
    main: v.showMain && main ? agent({ id: "main", label: "main thread", type: "", model: "", tail: main, done: false }) : undefined,
    workflows: v.groups
      .filter((g) => g.wf)
      .map((g) => {
        const wf = g.wf!;
        const outcome = wfOutcome(wf);
        const done = wf.agents.filter((a) => a.done).length;
        return {
          name: wf.name,
          outcome, // running, completed or failed
          status: outcome === "failed" ? wf.status || "failed" : undefined,
          phases: outcome === "running" ? phaseTrail(wf) : [],
          done,
          doing: outcome === "running" ? wf.agents.length - done : 0,
          total: wf.agents.length,
          tokens: wf.tokens !== undefined ? human(wf.tokens) : undefined,
          spark: bucketsIn(wf.agents.map((a) => a.tail.tools), win),
          age: outcome === "running" ? `up ${ago(now - wf.started)}` : ago(now - Math.max(wf.finished, wf.lastT)),
          agents: g.rows.map(agent),
          more: Math.max(0, g.rows.length > 12 ? g.rows.length - 12 : 0),
        };
      })
      .map((w) => ({ ...w, agents: w.agents.slice(0, 12) })),
    agents: v.groups
      .filter((g) => !g.wf)
      .flatMap((g) => g.rows)
      .slice(0, 12)
      .map(agent),
    finished: v.doneCount,
  };
}

/** Everything the page shows, from the same views the terminal draws. */
export function webState(sessions: Session[], now: number) {
  const all = buildViews(sessions, now);
  const shown = all.filter((v) => !isHidden(v));
  const win = laneWindow(now, 150);
  const counts = fleetCounts(sessions, now);
  const acct = opt.usage ? accountView(now) : undefined;
  return {
    now,
    counts,
    five: fiveHourLine(now), // the five-hour limit's forecast, always said
    pairing: pairsPending(), // the glasses app asking to connect, waiting on you
    voice: !!openAIKey(), // an OpenAI key is set: the page offers voice
    voices: openAIKey() ? { list: LIVE_VOICES.map((id) => ({ id, about: voiceBlurb(id) })), default: VOICE.voice(), model: VOICE.model() } : undefined,
    secure: secureLink("")?.replace(/\/\?t=$/, "") ?? null, // the page over HTTPS (the microphone needs it), without the secret
    hidden: all.length - shown.length,
    machine: { cpu: Math.round(machine.cpu), mem: Math.round((machine.memUsed / machine.memTotal) * 100), memText: `${gb(machine.memUsed)} of ${gb(machine.memTotal)}`, load: Number(machine.load.toFixed(1)) },
    account: acct ? { limits: acct.limits.map((l) => ({ label: l.label, pct: Math.round(l.pct), resetsAt: l.resetsAt, resets: l.resetsAt ? (l.resetsAt - now < 24 * 3600_000 ? `resets in ${ago(l.resetsAt - now)}` : `resets ${new Date(l.resetsAt).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}`) : "" })), reason: acct.reason || undefined } : undefined,
    sessions: shown.map((v) => {
      const s = v.s;
      const f = v.facts;
      const main = f.main;
      const ctx = main?.ctx;
      const runway = sessionRunway(main, now);
      const branch = s.mains.map((m) => m.branch).find(Boolean);
      const sub = subheading(s, f, v.state);
      const spark = bucketsIn(tailsOf(s).map((t) => t.tools), win);
      const threads = [...s.agents, ...s.workflows.flatMap((w) => w.agents)].filter((a) => !a.done && lastWriteOf(a.tail) >= win.start);
      return {
        sid: s.sid,
        name: s.name,
        place: [machineOf(s) ? `${machineLabel(s)} ·` : "", foldersOf(s.cwd.replace(os.homedir(), "~")).slice(-2).join("/"), branch && branch !== "HEAD" ? `@ ${branch}` : ""].filter(Boolean).join(" "),
        state: v.state,
        word: STATE[v.state].word,
        color: hexOf(STATE[v.state].color),
        time: stateTime(s, f, v.state, now, v.stall.since),
        sub: { source: sub.source, text: sub.text },
        needs: f.needs || undefined,
        party: partyOn(s.sid, now)?.text,
        ctx: ctx ? { pct: Math.round(Math.min(100, (ctx.used / ctxMax(ctx)) * 100)), used: human(ctx.used), max: human(ctxMax(ctx)), split: main ? contextSplit(main).filter((p) => p.tokens > 0).map((p) => ({ name: p.short, tokens: p.tokens, color: hexOf(p.color) })) : [], runway: runway === undefined ? undefined : fullInText(runway) } : undefined,
        spark,
        tools: sum(spark),
        fails: s.side?.fails.length ? { n: s.side.fails.length, last: `${s.side.fails.at(-1)!.tool ? s.side.fails.at(-1)!.tool + ": " : ""}${s.side.fails.at(-1)!.text}`, ago: ago(now - s.side.fails.at(-1)!.t) } : undefined,
        bg: (s.side?.bg ?? []).map((b) => ({ desc: b.desc, ago: ago(now - b.started) })),
        prs: prsShown(s.side?.prs ?? []).map((p) => segsJson(prSegs([p], s.side?.cwd ?? s.cwd, true))),
        changes: s.side && (s.side.edits.length || gitOf(s)) ? segsJson(changeSegs(s.side.edits, gitOf(s), true)) : undefined,
        tasks: s.tasks ? { done: s.tasks.done, total: s.tasks.total, open: s.tasks.items.filter((t) => t.status !== "completed").map((t) => ({ status: t.status, text: taskText(t), since: t.since ? ago(now - t.since) : undefined, blocked: t.blocked || undefined })) } : undefined,
        roster: rosterOfView(v, now, win),
        workflows: s.workflows.filter((w) => w.status === "running" && w.lastT >= win.start).map((w) => ({ name: w.name, phase: w.phase, done: w.agents.filter((a) => a.done).length, total: w.agents.length })),
        agents: threads.map((a) => {
          const p = pendingOf(a.tail);
          const st = stateOf(a, now);
          return { label: a.label, state: st, doing: p ? `${p.name}${p.hint ? " · " + p.hint : ""}` : st === "active" ? "thinking" : "quiet", ago: ago(now - lastWriteOf(a.tail)) };
        }),
        // Each message cropped, with the whole of it (to a limit) when cropping cut it, for a tap to show.
        // The recent conversation, both sides, oldest first: each message whole, to a limit (the page scrolls).
        talk: [
          ...(main?.asks?.length ? main.asks : main?.ask ? [main.ask] : []).map((x) => ({ who: "you", text: x.text, t: x.t })),
          ...(main?.says ?? []).map((x) => ({ who: "claude", text: flatLines(x.text).join("\n"), t: x.t })),
        ]
          .sort((a, b) => a.t - b.t)
          .slice(-12)
          .map((x) => ({ who: x.who, text: capText(x.text, 4000), t: x.t, ago: ago(now - x.t) })),
      };
    }),
  };
}

export const WEB_PAGE = `<!doctype html>
<html lang="en" style="background:#0d1117"><head>
<meta charset="utf-8">
<style>html,body{background:#0d1117}
#splash{position:fixed;inset:0;z-index:50;background:radial-gradient(120% 80% at 50% 38%,#18212d 0%,var(--bg) 62%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;perspective:800px;transition:opacity .24s ease-out,transform .24s ease-out}
#splash.gone{opacity:0;transform:scale(1.04);pointer-events:none}
#splash .tilt{position:relative;will-change:transform}
#splash .logo{position:relative;width:192px;height:192px;border-radius:48px;overflow:hidden;will-change:transform;box-shadow:0 1px 2px #0009,0px 6px 12px #0007,0px 18px 36px #0008,0px 40px 80px #000b,0px 26px 90px #3a5bff33,0 0 0 1px #ffffff14}
#splash .logo img{width:100%;height:100%;display:block}
#splash .logo b i.s{background:linear-gradient(115deg,transparent 36%,#ffffff30 43%,#fffffff0 50%,#ffffff30 57%,transparent 64%)}
#splash .logo i.d{background:radial-gradient(circle at 50% 50%,#ffffff3a 0,#ffffff14 18%,transparent 34%);opacity:0}
#splash .logo b i.d{background:radial-gradient(circle at 50% 50%,#ffffff80 0,#ffffff2a 18%,transparent 34%)}
#splash .logo b{position:absolute;inset:0;overflow:hidden;-webkit-mask:url(__LOGO_MASK__) center/100% 100% no-repeat;mask:url(__LOGO_MASK__) center/100% 100% no-repeat}
#splash .logo i{position:absolute;inset:-40%;will-change:transform,opacity}#splash .logo i.s{background:linear-gradient(115deg,transparent 38%,#ffffff10 44%,#ffffffb0 50%,#ffffff10 56%,transparent 62%);transform:translateX(-211px)}
#splash .title{margin-top:28px;font-size:22px;font-weight:700;letter-spacing:-.01em;background:linear-gradient(100deg,#8a95a5 30%,#fff 50%,#8a95a5 70%);background-size:250% 100%;background-position:120% 0;-webkit-background-clip:text;background-clip:text;color:transparent}
#splash .what{color:var(--dim);font-size:13px;min-height:1.4em}</style>
__STARTUP__
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0d1117">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="mobile-web-app-capable" content="yes">
<meta name="color-scheme" content="dark">
<link rel="manifest" href="/manifest.webmanifest?t=__TOKEN__">
<meta name="referrer" content="no-referrer">
<meta name="apple-mobile-web-app-title" content="Fleet">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon.ico">
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
<title>Claude Fleet</title>
<style>
:root{--bg:#0d1117;--card:#151b23;--line:#262d37;--text:#c6cdd7;--dim:#6b7380;--faint:#3a404a;--white:#f5f7fa;--amber:#e5b544;--green:#50c878;--red:#f0625c;--cyan:#56cdd6;--purple:#be94ff;--blue:#61aaff}
*{box-sizing:border-box;min-width:0}html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;font-variant-numeric:tabular-nums;-webkit-text-size-adjust:100%;overflow-x:hidden;overflow-wrap:anywhere}
main,header,.gauges,#quip{max-width:720px;margin-left:auto;margin-right:auto}
body{padding:calc(env(safe-area-inset-top) + 18px) max(12px,env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left))}
header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
h1{display:flex;align-items:center;gap:9px;font-size:21px;font-weight:700;margin:0;color:var(--white);letter-spacing:-.01em}h1 img{width:30px;height:30px;border-radius:8px}
#clock{color:var(--white);font-size:21px;font-weight:600}
.top-right{display:flex;align-items:center;gap:12px}
#mic{width:42px;height:42px;border-radius:50%;border:0;padding:0;display:grid;place-items:center;cursor:pointer;color:#fff;background:radial-gradient(circle at 30% 28%,#7ee8f0 0,#4aa3ff 38%,#8a5cff 78%);box-shadow:0 0 0 1px #ffffff22,0 4px 18px #4aa3ff66,0 0 28px #8a5cff44;animation:micglow 3.2s ease-in-out infinite}
#mic svg{width:20px;height:20px}#mic[hidden]{display:none}
@keyframes micglow{50%{box-shadow:0 0 0 1px #ffffff33,0 4px 24px #4aa3ff99,0 0 40px #8a5cff77}}
/* Voice: a full screen with the fleet (seven orbs in the logo's colours), in the manner of ChatGPT's voice mode. Every
   part keeps its own room, so a card never slides under the buttons. */
#voice{position:fixed;inset:0;z-index:40;display:flex;flex-direction:column;align-items:center;gap:14px;background:radial-gradient(120% 90% at 50% 40%,#0f1830 0%,#05070c 70%);padding:calc(env(safe-area-inset-top) + 18px) 20px calc(env(safe-area-inset-bottom) + 26px);opacity:0;pointer-events:none;transition:opacity .25s ease}
#voice.on{opacity:1;pointer-events:auto}
#voice .vtop{width:100%;display:flex;align-items:center;justify-content:space-between;color:#8a95a5;font-size:13px;flex:none}#voice .vtop b{color:#e8eef6;font-weight:650;font-size:15px;display:flex;align-items:center;gap:8px}#voice .vtop img{width:22px;height:22px;border-radius:6px}
/* The voice picker, top right: each voice with a button to hear it. */
#voice .vpick{position:relative}
#vpick{width:40px;height:40px;display:grid;place-items:center;padding:0;border-radius:50%;border:1px solid #2a3a58;background:#111a2acc;color:#c9d6ea;cursor:pointer}#vpick svg{width:20px;height:20px}#vpick[aria-expanded="true"]{color:#fff;background:linear-gradient(135deg,#25d8fc55,#0075fc55 55%,#6c28fa55);border-color:#3f63a8}
.vlist{position:absolute;right:0;top:calc(100% + 8px);z-index:5;width:262px;max-height:min(62vh,520px);overflow-y:auto;background:#0f1726f2;border:1px solid #22314d;border-radius:16px;padding:6px;box-shadow:0 18px 50px #000c;-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}
.vlist[hidden]{display:none}.vlist .vhead{padding:6px 10px 8px;color:#6b7380;font-size:12px}
.vrow{display:flex;align-items:center;gap:8px;border-radius:11px;padding:2px 4px 2px 10px}.vrow:hover{background:#18233a}.vrow[aria-selected="true"]{background:linear-gradient(90deg,#0075fc33,#6c28fa22)}
.vrow .vn{flex:1;display:flex;flex-direction:column;align-items:flex-start;gap:1px;text-align:left;border:0;background:none;color:#e8eef6;font:inherit;font-size:15px;padding:7px 0;cursor:pointer}.vrow .vn small{font-size:12px;color:#8a95a5;font-weight:400}.vrow[aria-selected="true"] .vn b{font-weight:650}.vrow[aria-selected="true"] .vn b::after{content:" ✓";color:#25d8fc}.vrow .vn b{font-weight:500}
.vrow .vp{width:34px;height:34px;flex:none;border-radius:50%;border:0;display:grid;place-items:center;cursor:pointer;color:#fff;background:#1c2a44}.vrow .vp svg{width:14px;height:14px}.vrow .vp.on{background:linear-gradient(135deg,#25d8fc,#0075fc 55%,#6c28fa)}.vrow .vp.wait{opacity:.6;animation:vwait 1s ease-in-out infinite}
@keyframes vwait{50%{opacity:.25}}
#voice .stage{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;width:100%}
#voice .orbs{width:min(82vw,40vh,340px);aspect-ratio:1;flex:none}
#voice .vstate{color:#e8eef6;font-size:17px;font-weight:600;min-height:1.4em;text-align:center}
#voice .vtool{color:#56cdd6;font-size:13px;min-height:1.3em;text-align:center}
#voice .secure{text-align:center;color:#c6cdd7;max-width:320px}#voice .secure a{color:#61aaff}
#voice .vcards{flex:0 1 auto;width:100%;max-width:560px;max-height:34vh;overflow-y:auto;display:flex;flex-direction:column;gap:10px}
.vcard{background:#111a2a;border:1px solid #22314d;border-radius:16px;padding:12px 14px;box-shadow:0 6px 24px #0008}
.vcard .to{font-size:12px;color:#8a95a5;letter-spacing:.02em;margin-bottom:4px}
.vcard .msg{color:#eef3f9;font-size:15px;line-height:1.4;white-space:pre-wrap;max-height:7.2em;overflow-y:auto}
.vcard .acts{display:flex;gap:10px;margin-top:10px}.vcard .acts button{flex:1;height:40px;border:0;border-radius:12px;font:inherit;font-weight:650;cursor:pointer}
.vcard .go{color:#fff;background:linear-gradient(135deg,#25d8fc,#0075fc 55%,#6c28fa)}.vcard .no{color:#c6cdd7;background:#1c2431}
.vcard .note{margin-top:8px;font-size:13px;color:#8a95a5}.vcard.done .note{color:#50c878}.vcard.queued .note{color:#e5b544}.vcard.failed .note{color:#f0625c}
.vcard.cancelled{opacity:.55}.vcard.cancelled .msg{text-decoration:line-through}
#voice .controls{display:flex;gap:28px;align-items:center;flex:none}
#voice .controls button{width:66px;height:66px;border-radius:50%;border:0;display:grid;place-items:center;cursor:pointer;color:#fff;background:#1c2431}
#voice .controls button svg{width:26px;height:26px}#voice .controls .end{background:#3a1c1f;color:#ff8f8a}#voice .controls .muted{background:#e8eef6;color:#0d1117}
#voice .secure{max-width:420px;text-align:center;color:#c6cdd7;font-size:15px}#voice .secure a{display:inline-block;margin-top:14px;padding:12px 18px;border-radius:12px;background:#56cdd6;color:#0d1117;font-weight:700;text-decoration:none}
#quip{color:var(--text);font-size:15px;margin:2px 0 12px}
#quip .needs{color:var(--amber)}
.gauges{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:0 0 16px}
.gt{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:9px 6px 8px;text-align:center}.gt svg{display:block;margin:0 auto}
.gt b{display:block;color:var(--text);font-size:12px;font-weight:600;margin-top:4px}.gt small{display:block;color:var(--dim);font-size:10.5px;line-height:1.25;margin-top:1px}.gt.hot small{color:var(--red);font-weight:600}
.five{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:11px 14px 12px;margin:-6px 0 16px}.five:empty{display:none}
.five .hl{display:flex;justify-content:space-between;align-items:baseline;gap:10px}.five .big{color:var(--white);font-size:17px;font-weight:650}.five .big em{font-style:normal;color:var(--k)}.five .in{color:var(--k);font-size:15px;font-weight:650;white-space:nowrap}
.five .tl{position:relative;height:8px;margin:11px 0 5px;border-radius:4px;background:#262d37}.five .tl i{position:absolute;top:0;bottom:0;border-radius:4px}.five .tl b{position:absolute;top:-4px;bottom:-4px;width:2px;border-radius:1px;background:var(--white)}
.five .ends{position:relative;display:flex;justify-content:space-between;color:var(--dim);font-size:11px}.five .ends .now{position:absolute;transform:translateX(-50%);color:var(--white)}.five .note{color:var(--dim);font-size:12.5px;margin-top:5px}
.wfg .count{color:var(--dim);font-size:11px;padding-left:23px;margin:-2px 0 2px}.wfg[open] .count{display:none}
.card{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--c);border-radius:16px;padding:12px 14px 14px;margin-bottom:12px;position:relative;overflow:hidden}
.card.needs{background:#2a2108;border-color:#5a4512;box-shadow:0 0 0 1px #5a4512,0 0 24px #e5b54433;animation:glow 2s ease-in-out infinite}
@keyframes glow{50%{box-shadow:0 0 0 1px #8a6a1a,0 0 34px #e5b54466}}
.top{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center}
.head{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center}
.name{color:var(--white);font-weight:650;font-size:17px;letter-spacing:-.01em;word-break:break-word}
.state{color:var(--c);font-weight:700;letter-spacing:.03em;font-size:11px;white-space:nowrap;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--c) 16%,transparent)}
.place{color:var(--dim);font-size:12px;margin-top:2px}
.sub{color:var(--white);margin:8px 0 2px;font-size:15px}.card.needs .sub{font-weight:600}
.ctxring{text-align:center;color:var(--dim);font-size:10.5px;line-height:1.2}.ctxring svg{display:block;margin:0 auto 2px}
.spark{display:block;width:100%;height:36px;margin:8px 0 4px}
.row{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:var(--dim);margin-top:3px}.row .lead{flex:none;width:1.2em;text-align:center}.row>span:last-child{flex:1}
.ctx{display:flex;height:6px;margin-top:6px;border-radius:3px;overflow:hidden;background:var(--faint);flex:1}.ctx i{display:block;height:100%}
details{margin-top:8px}summary{cursor:pointer;color:var(--dim);font-size:12px;list-style:none}summary::-webkit-details-marker{display:none}summary::before{content:"▸ ";color:var(--faint)}details[open] summary::before{content:"▾ "}

.r{display:grid;grid-template-columns:1.1em minmax(0,1fr) auto;column-gap:7px;align-items:baseline;font-size:12px;padding:4px 0}
.r.child{padding-left:16px}.r .g{text-align:center}.r .nm{color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.r.wf .nm{color:var(--text)}.r.wf.live .nm{color:var(--white);font-weight:700}.r .right{color:var(--dim);white-space:nowrap;font-size:11px}
.r .sub{grid-column:2/4;display:flex;gap:8px;align-items:center;min-width:0;color:var(--dim);font-size:11px;margin-top:1px}
.r .what{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.r .tool{color:var(--cyan)}.r .steps{letter-spacing:1px}
.r.more,.r.done-line{display:block;color:var(--dim);font-size:11px}.mini{display:block;width:64px;height:14px;flex:none}
.pulse{animation:pulse 1.2s ease-in-out infinite}@keyframes pulse{50%{opacity:.3}}
.tbar{display:flex;gap:2px;width:96px;height:8px;flex:none}.tbar i{flex:1;border-radius:2px;background:#2a313b}.tbar i.d{background:var(--green)}.tbar i.n{background:var(--white)}
.r.task .nm{font-weight:400;white-space:normal}.r.task.pending .nm{color:var(--dim)}.blk{color:var(--red);font-size:10.5px;font-weight:700;border:1px solid #5a2a28;border-radius:999px;padding:0 6px;margin-left:6px}
.foot{color:var(--faint);font-size:11px;text-align:center;margin-top:16px}.stale{color:var(--red)}
.confetti{position:absolute;inset:0;pointer-events:none;overflow:hidden}.confetti i{position:absolute;top:-10px;width:6px;height:10px;opacity:.9;animation:fall 2.6s linear infinite}
@keyframes fall{to{transform:translateY(260px) rotate(540deg)}}
.party{color:var(--amber);font-weight:700;margin-top:4px}
.empty{color:var(--dim);text-align:center;margin:40px 0}
#pair .ask{background:#14263d;border:1px solid #2c4f7a;border-radius:14px;padding:11px 14px;margin:0 0 14px;color:var(--white);font-size:14.5px}#pair .ask b{letter-spacing:.12em;color:var(--cyan)}
#pair .ask div{display:flex;gap:8px;margin-top:9px}#pair button{flex:1;border:0;border-radius:10px;padding:9px;font:600 14px -apple-system,system-ui,sans-serif}#pair .yes{background:var(--cyan);color:#0d1117}#pair .no{background:#262d37;color:var(--text)}
.card.done{touch-action:pan-y;user-select:none;-webkit-user-select:none}.swipe-hint{color:var(--dim);font-size:11.5px;margin-top:8px;text-align:right}
.shelf{display:block;margin:6px auto 12px;background:transparent;color:var(--text);border:1px solid var(--line);border-radius:999px;padding:9px 16px;font:600 13.5px -apple-system,system-ui,sans-serif}
.card.gone{opacity:.62}.putback{display:block;margin-left:auto !important;background:transparent;color:var(--cyan);border:1px solid #2f3946;border-radius:999px;padding:4px 11px;font:600 12.5px -apple-system,system-ui,sans-serif;margin:-2px 0 6px 8px}
.send{display:flex;gap:6px;margin-top:6px;align-items:flex-end}.send textarea{flex:1;height:38px;max-height:40vh;resize:none;overflow-y:hidden;background:var(--bg);color:var(--white);border:1px solid var(--line);border-radius:10px;padding:9px 10px;font:15px/1.3 -apple-system,system-ui,sans-serif}.send textarea:focus{outline:none;border-color:var(--cyan)}
.send button{background:var(--cyan);color:#0d1117;border:0;border-radius:10px;padding:10px 16px;font:700 15px -apple-system,system-ui,sans-serif}.send button:disabled{opacity:.5}
.picks{display:flex;flex-direction:column;gap:7px;margin:8px 0 10px}.pick{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:#1d2530;color:var(--white);border:1px solid #2f3946;border-radius:12px;padding:11px 12px;font:600 15px -apple-system,system-ui,sans-serif}
.pick .k{flex:none;width:26px;height:26px;border-radius:8px;background:#2a3442;color:var(--cyan);display:grid;place-items:center;font-size:14px;font-weight:700}
.pick.armed{background:var(--amber);color:#1a1405;border-color:var(--amber)}.pick.armed .k{background:#00000022;color:#1a1405}
.chips{display:flex;flex-wrap:nowrap;gap:6px;margin:6px -14px 8px;padding:0 14px;overflow-x:auto;scroll-snap-type:x proximity;-webkit-overflow-scrolling:touch;scrollbar-width:none;-webkit-mask-image:linear-gradient(90deg,transparent 0,#000 14px,#000 calc(100% - 28px),transparent);mask-image:linear-gradient(90deg,transparent 0,#000 14px,#000 calc(100% - 28px),transparent)}.chips::-webkit-scrollbar{display:none}.chips .chip{flex:none;white-space:nowrap;scroll-snap-align:start}.chip{background:transparent;color:var(--text);border:1px solid #2f3946;border-radius:999px;padding:7px 12px;font:500 13.5px -apple-system,system-ui,sans-serif}
.chip.key{color:var(--dim)}.chip.armed{background:var(--amber);color:#1a1405;border-color:var(--amber)}.picks-note{color:var(--dim);font-size:12px;margin:6px 0 2px}
/* The sections of a card (tasks, agents and workflows, chat): a rule above each, the same room, the same head. */
.roster,details.tasks,details.chat{margin-top:10px;padding-top:6px;border-top:1px solid var(--line)}
details.tasks>summary,details.chat>summary,details.wfg>summary{list-style:none;display:block;cursor:pointer}
details.tasks>summary::before,details.chat>summary::before,details.wfg>summary::before{content:none;display:none}
details.tasks .nm,details.chat .nm{color:var(--white);font-weight:700}
details.tasks>summary .nm::after,details.chat>summary .nm::after,details.wfg>summary .nm::after{content:" ▸";color:var(--dim);font-weight:400}
details.tasks[open]>summary .nm::after,details.chat[open]>summary .nm::after,details.wfg[open]>summary .nm::after{content:" ▾"}
details.tasks[open]>summary .sub,details.chat[open]>summary .sub{display:none}
.log{display:flex;flex-direction:column;gap:6px;max-height:min(42vh,340px);overflow-y:auto;overscroll-behavior:contain;margin:8px -2px 4px;padding:26px 2px 2px;-webkit-mask-image:linear-gradient(transparent 0,#000 30px);mask-image:linear-gradient(transparent 0,#000 30px)}
.log p{margin:0;max-width:86%;padding:7px 11px;border-radius:15px;font-size:14px;line-height:1.38;white-space:pre-wrap;word-break:break-word}
.log p.you{align-self:flex-end;background:#1f3d63;color:#e3eeff;border-bottom-right-radius:5px}.log p.claude{align-self:flex-start;background:#1d2530;color:var(--text);border-bottom-left-radius:5px}
.log p .ago{color:#ffffff55;font-size:10.5px;margin-left:7px}.log .none{color:var(--dim);font-size:13px;text-align:center;padding:6px}
.chat > .st{color:var(--dim);font-size:12.5px;margin:2px 2px 4px}
.row.pr>span:last-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sent{font-size:12px;margin-top:4px;color:var(--dim)}.sent.ok{color:var(--green)}.sent.err{color:var(--red)}
</style></head><body>
<div id="splash"><div class="tilt"><div class="logo"><img src="__ICON__" alt=""><i class="d"></i><i class="s"></i><b><i class="d"></i><i class="s"></i></b></div></div><div class="title">Claude Fleet</div><div class="what" id="splash-what">Reaching your Mac…</div></div>
<script>
// The splash's motion, from one thing: how far the logo has turned. Two lights reflect off it, a sharp one and a
// diffuse one from another side, so where each shows follows the turn; the shadows and the title's sheen too. The
// lights go one way, left to right: they follow the furthest the logo has turned this time round, so as it swings
// back they are already gone (the sharp one off the right edge, the diffuse one fading), and each turn starts afresh.
(() => {
  const sp = document.getElementById("splash"), tilt = sp.querySelector(".tilt"), logo = sp.querySelector(".logo"), title = sp.querySelector(".title");
  const sharp = sp.querySelectorAll(".logo i.s"), soft = sp.querySelectorAll(".logo i.d");
  const DELAY = 0, CYCLE = 3120, L = 192;
  const YAW = [[0, 0], [0.15, -5], [0.55, 14], [0.9, 0], [1, 0]], PITCH = [[0, 0], [0.15, 2], [0.55, -4], [0.9, 0], [1, 0]];
  const along = (pts, p) => { for (let k = 1; k < pts.length; k++) if (p <= pts[k][0]) { const [p0, v0] = pts[k - 1], [p1, v1] = pts[k], u = (p - p0) / (p1 - p0); return v0 + (v1 - v0) * u * u * (3 - 2 * u); } return 0; };
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clamp = (v) => Math.max(0, Math.min(1, v));
  function pose(ms) {
    const t = ms - DELAY, p = t < 0 ? 0 : (t % CYCLE) / CYCLE;
    const yaw = still ? 0 : along(YAW, p), pitch = still ? 0 : along(PITCH, p), lift = clamp(yaw / 14), x = -yaw * 1.4;
    tilt.style.transform = "rotateY(" + yaw + "deg) rotateX(" + pitch + "deg) translateY(" + -3 * lift + "px)";
    logo.style.boxShadow = "0 1px 2px #0009," + x * 0.3 + "px " + (6 + 2 * lift) + "px 12px #0007," + x * 0.6 + "px " + (18 + 4 * lift) + "px 36px #0008," + x + "px " + (40 + 8 * lift) + "px 80px #000b," + x * 0.5 + "px 26px 90px #3a5bff33,0 0 0 1px #ffffff14";
    const furthest = p <= 0.55 ? Math.max(0, yaw) : 14; // the turn grows to its peak at 0.55 of the way round, then eases back
    const xs = -0.6 + furthest * (2.1 / 14); // the sharp light: off the left edge at rest, clear off the right at the peak
    for (const e of sharp) e.style.transform = "translateX(" + (xs - 0.5) * L + "px)";
    const xd = 0.2 + furthest * 0.03, yd = 0.32 - pitch * 0.05, od = clamp(yaw / 10); // the diffuse one, as the face turns to it
    for (const e of soft) { e.style.transform = "translate(" + (xd - 0.5) * L + "px," + (yd - 0.5) * L + "px)"; e.style.opacity = od; }
    title.style.backgroundPosition = 120 - 250 * clamp((xs + 0.1) / 1.25) + "% 0";
  }
  const t0 = performance.now();
  let stopAt = Infinity, held = false;
  const frame = () => { if (held) return; const ms = performance.now() - t0; if (ms >= stopAt) return pose(0); pose(ms); requestAnimationFrame(frame); };
  pose(0); requestAnimationFrame(frame);
  window.splashMotion = {
    // How long until the logo is back at rest at the end of a turn; it stays at rest from then.
    untilRest() { if (still) return 0; const t = performance.now() - t0 - DELAY, left = t < 0 ? CYCLE - t : CYCLE - (t % CYCLE); stopAt = performance.now() - t0 + left; return left; },
    hold(ms) { held = true; pose(ms); }, // to look at one moment
  };
})();
</script>
<header><h1><img src="/icon-192.png" alt="">Claude Fleet</h1><span class="top-right"><button id="mic" hidden aria-label="Talk to Fleet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5"/></svg></button><span id="clock"></span></span></header>
<div id="voice" aria-hidden="true"><div class="vtop"><b><img src="/icon-192.png" alt="">Fleet</b><div class="vpick"><button id="vpick" aria-haspopup="listbox" aria-expanded="false" aria-label="Choose Fleet's voice"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6.5h16M4 12h16M4 17.5h16"/><g fill="currentColor" stroke="none"><circle cx="9" cy="6.5" r="2.4"/><circle cx="15.5" cy="12" r="2.4"/><circle cx="7" cy="17.5" r="2.4"/></g></svg></button><div class="vlist" id="vlist" role="listbox" hidden></div></div></div>
<template id="vicons"><svg class="play" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg><svg class="stop" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></template>
<div class="stage"><canvas class="orbs" id="orbs" aria-hidden="true"></canvas><div class="vstate" id="vstate"></div><div class="vtool" id="vtool"></div></div>
<div class="vcards" id="vcards"></div>
<div class="controls"><button id="vmute" aria-label="Mute"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5"/></svg></button><button id="vend" class="end" aria-label="End"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div></div>
<div id="quip">Waking the fleet…</div>
<div id="pair"></div>
<div class="gauges" id="gauges"></div>
<div class="five" id="five"></div>
<main id="cards"></main>
<div class="foot" id="foot"></div>
<script>
const token = new URLSearchParams(location.search).get("t") || "";
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const segs = (list) => { const s = el("span"); for (const x of list) { const p = el("span", "", x.t); if (x.c) p.style.color = x.c; if (x.b) p.style.fontWeight = "700"; s.append(p); } return s; };
const row = (lead, color, content) => { const r = el("div", "row"); const l = el("span", "lead", lead); l.style.color = color; r.append(l, typeof content === "string" ? el("span", "", content) : content); return r; };
const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
// A ring: a faint track, then each part as an arc in its colour, and the figure in the middle.
function ring(size, width, parts, label) {
  const r = (size - width) / 2, c = 2 * Math.PI * r;
  const svg = svgEl("svg", { width: size, height: size, viewBox: "0 0 " + size + " " + size });
  svg.append(svgEl("circle", { cx: size / 2, cy: size / 2, r, fill: "none", stroke: "#262d37", "stroke-width": width }));
  let at = 0;
  for (const p of parts) {
    const len = Math.max(0, Math.min(1, p.frac)) * c;
    if (len < 0.5) continue;
    svg.append(svgEl("circle", { cx: size / 2, cy: size / 2, r, fill: "none", stroke: p.color, "stroke-width": width, "stroke-dasharray": len + " " + (c - len), "stroke-dashoffset": -at, transform: "rotate(-90 " + size / 2 + " " + size / 2 + ")", "stroke-linecap": parts.length === 1 ? "round" : "butt" }));
    at += len;
  }
  const t = svgEl("text", { x: size / 2, y: size / 2 + 4, "text-anchor": "middle", fill: "#f5f7fa", "font-size": Math.round(size * 0.24), "font-weight": "650", "font-family": "-apple-system,system-ui,sans-serif" });
  t.textContent = label;
  svg.append(t);
  return svg;
}
const tone = (pct) => (pct >= 80 ? "#f0625c" : pct >= 60 ? "#f5f7fa" : "#56cdd6");
function gaugeTile(label, pct, sub, hot) {
  const g = el("div", "gt" + (hot ? " hot" : ""));
  g.append(ring(50, 6, pct === undefined ? [] : [{ frac: pct / 100, color: tone(pct) }], pct === undefined ? "–" : pct + "%"), el("b", "", label), el("small", "", sub || ""));
  return g;
}
// Activity as a smooth area, in the card's colour.
function sparkSvg(values, colour) {
  const n = values.length || 1, w = 300, h = 36, max = Math.max(1, ...values);
  const pts = values.map((v, i) => [(i / Math.max(1, n - 1)) * w, h - 2 - Math.sqrt(v / max) * (h - 4)]);
  const svg = svgEl("svg", { class: "spark", viewBox: "0 0 " + w + " " + h, preserveAspectRatio: "none" });
  if (!pts.length) return svg;
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  svg.append(svgEl("path", { d: line + " L" + w + " " + h + " L0 " + h + " Z", fill: colour, "fill-opacity": "0.18" }));
  svg.append(svgEl("path", { d: line, fill: "none", stroke: colour, "stroke-width": "1.6", "vector-effect": "non-scaling-stroke", "stroke-linejoin": "round" }));
  return svg;
}
// When the five-hour limit runs out: the one thing the rings above don't say. A headline, a timeline of the
// window (now, when it runs out, the reset), and what that means.
function fivePanel(f) {
  const box = document.getElementById("five"); box.replaceChildren();
  if (!f || !f.kind) return;
  const k = f.kind === "full" ? "#f0625c" : f.kind === "out" ? "#e5b544" : "#50c878";
  box.style.setProperty("--k", k);
  const hl = el("div", "hl"), big = el("div", "big");
  const em = (t) => el("em", "", t);
  if (f.kind === "full") big.append("Out of tokens until ", em(f.resetAt || "the reset"));
  else if (f.kind === "out") big.append("Runs out ", em("~" + f.outAt));
  else if (f.kind === "lasts") big.append("Lasts to the ", em(f.resetAt + " reset"));
  else big.append("Too early to forecast");
  hl.append(big);
  if ((f.kind === "full" || f.kind === "out") && f.inText) hl.append(el("span", "in", "in " + f.inText));
  box.append(hl);
  if (f.start && f.resets && f.resets > f.start) {
    const span = f.resets - f.start, at = (t) => Math.max(0, Math.min(100, ((t - f.start) / span) * 100));
    const tl = el("div", "tl"), past = el("i"), now = el("b");
    past.style.cssText = "left:0;width:" + at(f.now) + "%;background:#3b4452";
    tl.append(past);
    if (f.kind === "out" && f.out) { const gap = el("i"); gap.style.cssText = "left:" + at(f.out) + "%;right:0;background:" + k + ";opacity:.55"; tl.append(gap); }
    if (f.kind === "full") { const gap = el("i"); gap.style.cssText = "left:" + at(f.now) + "%;right:0;background:" + k + ";opacity:.55"; tl.append(gap); }
    now.style.left = "calc(" + at(f.now) + "% - 1px)"; tl.append(now);
    const ends = el("div", "ends"), hm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const nowLabel = el("span", "now", "now"); nowLabel.style.left = Math.max(14, Math.min(72, at(f.now))) + "%";
    ends.append(el("span", "", hm(f.start)), nowLabel, el("span", "", "reset " + (f.resetAt || hm(f.resets))));
    box.append(tl, ends);
  }
  const note = f.kind === "out" ? (f.gap ? f.gap + " without tokens before the reset at this pace" : "just before the reset at this pace") : f.kind === "lasts" ? "~" + f.by + "% used by then at this pace" : f.kind === "full" ? "a fresh five hours starts then" : "";
  if (note) box.append(el("div", "note", note));
}
function quip(d) {
  const c = d.counts, n = d.sessions.length;
  const parts = [];
  if (c.needs) parts.push([c.needs === 1 ? "1 session wants you" : c.needs + " sessions want you", "needs"]);
  if (c.stalled) parts.push(c.stalled + " looking a bit stuck");
  if (c.working) parts.push(c.working + (c.working === 1 ? " grinding away" : " grinding away"));
  if (c.agents) parts.push(c.agents + (c.agents === 1 ? " agent hustling" : " agents hustling"));
  if (!n) return [["All quiet. Go and make a cup of tea."]];
  if (!c.needs && !c.stalled) parts.push(["nothing needs you, carry on", "all under control, apparently", "you could probably go outside"][Math.floor(d.now / 60000) % 3]);
  return parts.map((p) => (typeof p === "string" ? [p] : p));
}
// The roster, as the detail view lists it: the main thread, each workflow with its agents under it, other agents.
const GLYPH = { active: ["●", "#50c878", "pulse"], tool: ["◐", "#f5f7fa"], quiet: ["○", "#6b7380"], done: ["✓", "#50c878"], stalled: ["◐", "#f0625c"] };
function mini(values, color) {
  // A small activity line, like the card's own, in the agent's colour.
  const n = (values || []).length || 1, w = 64, h = 14, max = Math.max(1, ...(values || [0]));
  const svg = svgEl("svg", { width: w, height: h, viewBox: "0 0 " + w + " " + h, class: "mini" });
  const pts = (values || []).map((v, i) => [(i / Math.max(1, n - 1)) * w, h - 1 - Math.sqrt(v / max) * (h - 2)]);
  if (!pts.length) return svg;
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  svg.append(svgEl("path", { d: line + " L" + w + " " + h + " L0 " + h + " Z", fill: color, "fill-opacity": "0.2" }));
  svg.append(svgEl("path", { d: line, fill: "none", stroke: color, "stroke-width": "1.3", "stroke-linejoin": "round" }));
  return svg;
}
function rrow(cls, glyph, name, right, what, spark, color) {
  const r = el("div", "r " + cls);
  const g = el("span", "g" + (glyph[2] ? " " + glyph[2] : ""), glyph[0]); g.style.color = glyph[1];
  const rt = el("span", "right"); if (right) rt.append(right);
  const sub = el("div", "sub"); sub.append(what, mini(spark || [], color));
  r.append(g, el("span", "nm", name), rt, sub);
  return r;
}
function agentRow(a, child) {
  const w = el("span", "what");
  if (a.tool) w.append(el("span", "tool", a.tool), " " + (a.doing || "")); else w.append(a.doing || "");
  return rrow(child ? "child" : "", GLYPH[a.state] || GLYPH.quiet, a.label, (a.model ? a.model + " · " : "") + a.ago, w, a.spark, a.label === "main thread" ? "#5b7fbf" : "#4fb8c4");
}
function wfRow(w) {
  const right = el("span");
  // A tick per step while there are few; past five, a count, so the name and the progress keep their room.
  const st = el("span", "steps");
  if (w.done) { const x = el("span", "", w.done > 5 ? "✓ " + w.done : "✓".repeat(w.done)); x.style.color = "#50c878"; st.append(x); }
  if (w.doing) st.append(el("span", "", (w.done ? " " : "") + (w.doing > 4 ? "◐ " + w.doing : "◐".repeat(w.doing))));
  if (st.childNodes.length) right.append(st, " ");
  right.append(w.done + "/" + w.total + " · " + w.age);
  const what = el("span", "what");
  if (w.outcome === "running") w.phases.forEach((p, i) => {
    const x = el("span", "", (p.state === "done" ? "✓ " : p.state === "now" ? "◐ " : "○ ") + p.name);
    x.style.color = p.state === "done" ? "#6b7380" : p.state === "now" ? "#f5f7fa" : "#4a515c";
    if (p.state === "now") x.style.fontWeight = "700";
    if (i) what.append("  ");
    what.append(x);
  });
  else { what.append(w.outcome === "completed" ? "completed" + (w.tokens ? " · " + w.tokens + " tok" : "") : w.status || "failed"); if (w.outcome !== "completed") what.style.color = "#f0625c"; }
  const glyph = w.outcome === "running" ? ["≡", "#be94ff"] : w.outcome === "completed" ? ["✓", "#50c878"] : ["✗", "#f0625c"];
  return rrow("wf" + (w.outcome === "running" ? " live" : ""), glyph, w.name, right, what, w.spark, "#9b7bd9");
}
function roster(R) {
  const box = el("div", "roster");
  if (R.main) box.append(agentRow(R.main, false));
  // Each workflow folds to its own row (name, steps, phases) and a count of its agents; a tap opens the agents.
  for (const w of R.workflows) {
    if (!w.agents.length && !w.more) { box.append(wfRow(w)); continue; }
    const g = el("details", "wfg wf-" + w.name.replace(/[^\w-]/g, "_")), sm = el("summary");
    const n = w.agents.length + (w.more || 0), busy = w.agents.filter((a) => a.state === "active" || a.state === "tool").length;
    sm.append(wfRow(w), el("div", "count", n + (n === 1 ? " agent" : " agents") + (busy ? " · " + busy + " working" : "")));
    g.append(sm);
    for (const a of w.agents) g.append(agentRow(a, true));
    if (w.more) g.append(el("div", "r child more", "+ " + w.more + " more agents"));
    box.append(g);
  }
  for (const a of R.agents) box.append(agentRow(a, false));
  if (R.finished) box.append(el("div", "r done-line", "✓ " + R.finished + " agent" + (R.finished === 1 ? "" : "s") + " finished in the window"));
  return box;
}
// A message in the chat, whole: the chat scrolls.
function talkLine(sid, m) {
  const p = el("p", m.who, m.text); p.dataset.k = sid + ":" + m.t;
  p.append(el("span", "ago", m.ago));
  return p;
}
// Answer buttons: the numbered choices on the session's own screen (read every few seconds while it waits),
// then Esc and Enter, then quick replies. A button arms on the first tap and sends on the second.
const QUICK = ["yes, go ahead", "continue", "looks good, carry on", "do what you think is best", "stop and tell me where you are", "what's left?", "summarise what you've done", "run the tests", "fix the failing tests", "commit and open a PR", "merge it once CI is green", "show me the diff", "keep it simpler", "try a different approach", "explain that simply", "wait, I'll check and come back"];
const screens = new Map(); // sid → { at, options, error, loading }
const chipScroll = new Map(); // sid → how far its quick replies are scrolled
let armed = { id: "", until: 0 };
async function post(path, body) {
  try {
    const r = await fetch(path + "?t=" + encodeURIComponent(token), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return await r.json().catch(() => ({ ok: false, error: "fleet said " + r.status }));
  } catch { return { ok: false, error: "can't reach fleet" }; }
}
async function readScreen(sid) {
  const was = screens.get(sid) || {};
  screens.set(sid, { ...was, loading: true, at: Date.now() });
  const r = await post("api/choices", { sid });
  screens.set(sid, { at: Date.now(), options: r.options || [], error: r.ok ? "" : r.error || "can't see its screen" });
  tick();
}
function answerButtons(s) {
  const box = el("div");
  const waiting = s.state === "needs";
  if (waiting) {
    const sc = screens.get(s.sid);
    if (!sc || (!sc.loading && Date.now() - sc.at > 8000)) void readScreen(s.sid);
    const picks = el("div", "picks");
    for (const o of (sc && sc.options) || []) picks.append(armable(s, "k" + o.key, "pick", [el("span", "k", o.key), el("span", "", o.label)], o.key + ". " + o.label, { key: o.key }));
    if (picks.childNodes.length) box.append(picks);
    else box.append(el("div", "picks-note", !sc || sc.loading && !sc.options ? "reading its screen…" : sc.error ? sc.error : "no numbered choice on its screen"));
  }
  const chips = el("div", "chips");
  const at = chipScroll.get(s.sid); if (at) requestAnimationFrame(() => (chips.scrollLeft = at));
  chips.addEventListener("scroll", () => chipScroll.set(s.sid, chips.scrollLeft), { passive: true });
  if (waiting) chips.append(armable(s, "esc", "chip key", ["Esc"], "Esc", { key: "X" }), armable(s, "enter", "chip key", ["Enter"], "Enter", { key: "E" }));
  QUICK.forEach((q, i) => chips.append(armable(s, "q" + i, "chip", [q], "“" + q + "”", { text: q })));
  if (!waiting) chips.prepend(armable(s, "esc", "chip key", ["Esc"], "Esc", { key: "X" }));
  box.append(chips);
  return box;
}
function armable(s, id, cls, content, what, act) {
  const full = s.sid + ":" + id, on = armed.id === full && Date.now() < armed.until;
  const b = el("button", cls + (on ? " armed" : "")); b.type = "button"; b.dataset.k = full;
  if (on) b.append(cls.startsWith("pick") ? el("span", "k", "↵") : "", "Tap again: " + what); else b.append(...content);
  b.addEventListener("click", async () => {
    if (!(armed.id === full && Date.now() < armed.until)) { armed = { id: full, until: Date.now() + 3000 }; setTimeout(tick, 3100); return tick(); }
    armed = { id: "", until: 0 };
    notes.set(s.sid, { cls: "", text: "sending…" }); tick();
    const r = act.key ? await post("api/keys", { sid: s.sid, key: act.key }) : await post("api/send", { sid: s.sid, text: act.text });
    const at = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    notes.set(s.sid, r.ok ? { cls: "ok", text: (act.key ? "pressed " + what : (r.queued ? "queued " : "sent ") + what) + (r.queued ? " ⏳ " : " ✓ ") + at } : { cls: "err", text: "not done: " + (r.error || "unknown") });
    screens.delete(s.sid); tick();
  });
  return b;
}
// The task list, as a workflow is shown: folded to a row with its progress and the task in hand; open, a row per task still to finish.
function taskList(T) {
  const d = el("details", "tasks"), sm = el("summary");
  const doing = T.open.filter((t) => t.status === "in_progress"), todo = T.open.filter((t) => t.status !== "in_progress");
  const bar = el("span", "tbar"); const n = Math.min(T.total, 24);
  for (let i = 0; i < n; i++) { const at = (i / n) * T.total; bar.append(el("i", at < T.done ? "d" : at < T.done + doing.length ? "n" : "")); }
  const right = el("span", ""); right.style.cssText = "display:inline-flex;gap:8px;align-items:center"; right.append(bar, T.done + "/" + T.total);
  const what = el("span", "what");
  if (doing.length) what.append(el("span", "", "◐ " + doing[0].text + (doing.length > 1 ? " +" + (doing.length - 1) : "")));
  else if (todo.length) what.append("next: " + todo[0].text); else what.append("all done");
  if (doing.length) what.firstChild.style.color = "#f5f7fa";
  const r = el("div", "r"); const g = el("span", "g", "☰"); g.style.color = "#56cdd6";
  const sub = el("div", "sub"); sub.append(what);
  r.append(g, el("span", "nm", "Tasks"), el("span", "right", ""), sub); r.querySelector(".right").append(right);
  sm.append(r); d.append(sm);
  for (const t of [...doing, ...todo]) {
    const row = el("div", "r child task " + (t.status === "in_progress" ? "now" : "pending"));
    const gl = el("span", "g", t.status === "in_progress" ? "◐" : "○"); gl.style.color = t.status === "in_progress" ? "#f5f7fa" : "#6b7380";
    const nm = el("span", "nm", t.text); if (t.blocked) nm.append(el("span", "blk", "blocked"));
    row.append(gl, nm, el("span", "right", t.since || ""));
    d.append(row);
  }
  if (T.done) d.append(el("div", "r child done-line", "✓ " + T.done + " done"));
  return d;
}
function card(s) {
  const c = el("section", "card" + (s.state === "needs" ? " needs" : "") + (isDone(s) ? " done" : "")); c.style.setProperty("--c", s.color);
  if (isDone(s) && !putAway()[s.sid]) swipeAway(c, s.sid);
  // The head: name and state, where it is; its context as a ring, split by what fills it, on the right.
  const top = el("div", "top"), left = el("div");
  const head = el("div", "head"); head.append(el("div", "name", s.name), el("div", "state", s.word + (s.time ? " · " + s.time : ""))); left.append(head);
  if (s.place) left.append(el("div", "place", s.place));
  top.append(left);
  if (s.ctx) {
    const total = s.ctx.split.reduce((n, p) => n + p.tokens, 0) || 1;
    const parts = s.ctx.split.map((p) => ({ frac: (p.tokens / total) * (s.ctx.pct / 100), color: p.color }));
    const box = el("div", "ctxring"); box.append(ring(52, 6, parts.length ? parts : [{ frac: s.ctx.pct / 100, color: tone(s.ctx.pct) }], s.ctx.pct + "%"), el("div", "", "of " + s.ctx.max));
    top.append(box);
  }
  c.append(top);

  c.append(el("div", "sub", (s.sub.source === "prompt" ? "▸ " : s.sub.source === "reply" ? "◆ " : "") + (s.sub.text || "")));
  if (s.party) { c.append(el("div", "party", "✦ " + s.party + " ✦")); const f = el("div", "confetti"); const cols = ["#e5b544", "#50c878", "#56cdd6", "#be94ff", "#f0625c", "#61aaff"]; for (let i = 0; i < 28; i++) { const p = el("i"); p.style.left = (i * 37 % 100) + "%"; p.style.background = cols[i % cols.length]; p.style.animationDelay = (i % 9) * 0.25 + "s"; f.append(p); } c.append(f); }
  c.append(sparkSvg(s.spark, s.state === "needs" ? "#e5b544" : s.state === "stalled" ? "#f0625c" : "#6b9bff"));
  if (s.ctx && s.ctx.runway) c.append(row("◷", "#6b7380", s.ctx.runway));
  if (s.fails) c.append(row("✗", "#f0625c", s.fails.n + " failed · " + s.fails.last + " · " + s.fails.ago));
  for (const b of s.bg) c.append(row("↻", "#56cdd6", b.desc + " · " + b.ago));
  for (const p of s.prs) { const r = row("⇡", "#c6cdd7", segs(p)); r.classList.add("pr"); c.append(r); } // one line each, the title cut
  if (s.changes) c.append(row("±", "#6b7380", segs(s.changes)));
  const R = s.roster;
  if (s.tasks && s.tasks.total) c.append(taskList(s.tasks));
  if (R && (R.main || R.workflows.length || R.agents.length || R.finished)) c.append(roster(R));
  const m = chatHead(s);
  const f = el("form", "send"); const ta = el("textarea"); ta.rows = 1; ta.placeholder = s.state === "needs" ? "your answer…" : "type to " + s.name + "…"; ta.value = drafts.get(s.sid) || ""; ta.dataset.sid = s.sid;
  ta.addEventListener("input", () => { drafts.set(s.sid, ta.value); grow(ta); });
  if (ta.value) requestAnimationFrame(() => grow(ta));
  m.append(answerButtons(s));
  const go = el("button", "", "Send"); go.type = "submit"; f.append(ta, go); m.append(f);
  const note = el("div", "sent" + (notes.get(s.sid)?.cls ? " " + notes.get(s.sid).cls : ""), notes.get(s.sid)?.text || ""); m.append(note);

  f.addEventListener("submit", async (e) => {
    e.preventDefault(); const text = ta.value.trim(); if (!text) return;
    go.disabled = true; note.className = "sent"; note.textContent = "sending…";
    try {
      const r = await fetch("api/send?t=" + encodeURIComponent(token), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sid: s.sid, text }) });
      const d = await r.json().catch(() => ({ ok: false, error: "fleet said " + r.status }));
      if (d.ok) { following.set(s.sid, { text, at: Date.now() }); open.set(s.sid + "chat", true); stick.set(s.sid, true); const ch = f.closest("details.chat"); if (ch) ch.open = true; drafts.delete(s.sid); ta.value = ""; grow(ta); notes.set(s.sid, d.queued ? { cls: "ok", text: "queued ⏳ it's busy: delivers as soon as it can" } : { cls: "ok", text: "sent ✓ " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }); }
      else notes.set(s.sid, { cls: "err", text: "not sent: " + (d.error || "unknown") });
    } catch { notes.set(s.sid, { cls: "err", text: "not sent: can't reach fleet" }); }
    const n = notes.get(s.sid); note.className = "sent " + n.cls; note.textContent = n.text; go.disabled = false; ta.blur(); tick();
  });
  c.append(m);
  if (isDone(s) && !putAway()[s.sid]) c.append(el("div", "swipe-hint", "⟷ swipe to put away"));
  return c;
}
let last = 0, open = new Map();
// The message box: one line, taller as the words need it (to 40% of the screen, then it scrolls).
function grow(ta) {
  ta.style.height = "auto";
  const max = innerHeight * 0.4, h = Math.min(ta.scrollHeight + 2, max);
  ta.style.height = h + "px";
  ta.style.overflowY = ta.scrollHeight + 2 > max ? "auto" : "hidden";
}
// A node's layout: its tags, classes and what each message or button is for, not its words or figures.
const shapeOf = (n) => n.nodeType === 3 ? "#" : n.nodeType !== 1 ? "?" : n.tagName + "." + (n.getAttribute("class") || "") + "|" + (n.dataset ? n.dataset.k || "" : "") + "(" + [...n.childNodes].map(shapeOf).join(",") + ")";
// Bring a node up to date from one laid out the same, in place: its words and attributes; a text box keeps what you typed.
function patch(a, b) {
  if (a.nodeType === 3) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
  if (a.nodeType !== 1) return;
  const own = (name) => a.tagName === "TEXTAREA" && name === "style"; // its height is its own, from what you typed
  for (const { name, value } of [...b.attributes]) if (!own(name) && a.getAttribute(name) !== value) a.setAttribute(name, value);
  for (const { name } of [...a.attributes]) if (!own(name) && !b.hasAttribute(name)) a.removeAttribute(name);
  for (let i = 0; i < a.childNodes.length; i++) patch(a.childNodes[i], b.childNodes[i]);
}
// The splash finishes its turn (the logo back at rest), holds 400 ms on the logo, then the app fades in quickly.
let leaving = false;
function leaveSplash() {
  const sp = document.getElementById("splash");
  if (!sp || leaving) return;
  leaving = true;
  const wait = window.splashMotion ? splashMotion.untilRest() : 0;
  setTimeout(() => { sp.classList.add("gone"); setTimeout(() => sp.remove(), 300); }, wait + 400);
}
// Finished cards a swipe has put away, by session, kept on this phone.
const isDone = (s) => s.state === "justDone" || s.state === "finished";
let showGone = false, swiping = false, touchedUntil = 0, touching = false;
addEventListener("pointerdown", () => { touching = true; touchedUntil = Infinity; }, { passive: true });
addEventListener("pointerup", () => { touching = false; touchedUntil = Date.now() + 700; }, { passive: true });
addEventListener("pointercancel", () => { touching = false; touchedUntil = Date.now() + 700; }, { passive: true });
addEventListener("scroll", () => { if (!touching) touchedUntil = Math.max(touchedUntil, Date.now() + 250); }, { passive: true, capture: true });
function putAway() { try { return JSON.parse(localStorage.getItem("fleet-put-away") || "{}") || {}; } catch { return {}; } }
function savePutAway(a) { try { localStorage.setItem("fleet-put-away", JSON.stringify(a)); } catch {} }
// A finished card follows a sideways swipe; far enough and it slides off and is put away. Up and down still scrolls.
function swipeAway(c, sid) {
  let x0 = null, y0 = 0, dx = 0, locked = false;
  const reset = () => { x0 = null; locked = false; swiping = false; };
  c.addEventListener("pointerdown", (e) => { if (e.target.closest("button,textarea,summary,a,input,.log,.chips")) return; x0 = e.clientX; y0 = e.clientY; dx = 0; locked = false; });
  c.addEventListener("pointermove", (e) => {
    if (x0 === null) return;
    dx = e.clientX - x0; const dy = e.clientY - y0;
    if (!locked) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) return reset();
      if (Math.abs(dx) < 10) return;
      locked = true; swiping = true; try { c.setPointerCapture(e.pointerId); } catch {}
    }
    c.style.transition = "none"; c.style.transform = "translateX(" + dx + "px)"; c.style.opacity = String(1 - Math.min(0.7, Math.abs(dx) / c.offsetWidth));
  });
  const end = () => {
    if (!locked) return reset();
    c.style.transition = "transform .22s ease, opacity .22s ease";
    if (Math.abs(dx) > c.offsetWidth * 0.33) {
      c.style.transform = "translateX(" + Math.sign(dx) * c.offsetWidth * 1.2 + "px)"; c.style.opacity = "0";
      setTimeout(() => { const a = putAway(); a[sid] = Date.now(); savePutAway(a); reset(); tick(); }, 220);
    } else { c.style.transform = ""; c.style.opacity = ""; reset(); }
  };
  c.addEventListener("pointerup", end); c.addEventListener("pointercancel", end);
}
const drafts = new Map(), notes = new Map();
// The conversation and the box to write in are one: folded, a line with the latest message; open, the recent
// messages in a short scroller that fades out at the top and stays at the newest unless you scroll back, what the
// session is doing, then the answers and the box. It opens when the session asks you something, and when you send.
const following = new Map(); // sid → { text, at }: what you just sent, shown until the transcript has it
const stick = new Map(); // sid → false while you have scrolled back through its messages
function chatHead(s) {
  const f = following.get(s.sid);
  if (f && Date.now() - f.at > 15 * 60_000) following.delete(s.sid);
  const live = following.get(s.sid);
  const d = el("details", "chat"); if (s.state === "needs" || live) d.open = true;
  // Its head is a row like Tasks and the workflows: the latest message beneath, while folded.
  const sm = el("summary"), last = s.talk[s.talk.length - 1];
  const r = el("div", "r"), g = el("span", "g", "❯"); g.style.color = "#61aaff";
  const sub = el("div", "sub"); sub.append(el("span", "what", last ? (last.who === "you" ? "You: " : "") + last.text.replace(/\\s+/g, " ") : "Write to " + s.name));
  r.append(g, el("span", "nm", "Chat"), el("span", "right", last ? last.ago : ""), sub);
  sm.append(r); d.append(sm);
  const log = el("div", "log"); log.dataset.k = "log"; log.dataset.of = s.sid;
  for (const m of s.talk) log.append(talkLine(s.sid, m));
  if (live && !s.talk.some((m) => m.who === "you" && m.t >= live.at - 5000)) { const p = el("p", "you", live.text); p.dataset.k = "sent"; log.append(p); }
  if (!log.childNodes.length) log.append(el("div", "none", "Nothing said yet."));
  log.addEventListener("scroll", () => stick.set(s.sid, log.scrollHeight - log.scrollTop - log.clientHeight < 24), { passive: true });
  d.append(log);
  const busy = s.state === "working" || s.state === "stalled";
  if (busy) d.append(el("div", "st pulse", "◐ " + (s.sub && s.sub.source !== "reply" && s.sub.text ? s.sub.text : "thinking…")));
  // Opened by your tap (not by a redraw): straight to the newest message.
  sm.addEventListener("click", () => { if (!d.open) { stick.set(s.sid, true); requestAnimationFrame(settleLogs); } });
  return d;
}
// Each open conversation at its newest message, unless you have scrolled back.
function settleLogs() {
  for (const log of document.querySelectorAll("#cards .log")) if (stick.get(log.dataset.of) !== false) log.scrollTop = log.scrollHeight;
}
// Fleet pushes what it says over a live link (a WebSocket) whenever it changes; the page draws it, skipping what has
// not changed. The link comes back by itself if it drops (quickly, then every few seconds), and meanwhile the page
// asks now and then, so it never goes blank. tick() asks at once: after you have done something.
let lastText = "", latestText = "", linkDown = false;
async function tick(force = true) {
  try {
    const r = await fetch("api/state?t=" + encodeURIComponent(token), { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    apply(await r.text(), force);
  } catch (e) { document.getElementById("foot").replaceChildren(el("span", "stale", "can't reach fleet — is it still running?")); const w = document.getElementById("splash-what"); if (w) w.textContent = "Can't reach fleet yet: is your Mac awake, and on Tailscale?"; }
}
function apply(text, force) {
  last = Date.now(); latestText = text;
  if (!force && text === lastText) return;
  // Nothing re-renders under a voice call: the phone's attention stays on the audio. Closing the call catches up.
  if (V.pc) return void (lastText = "");
  lastText = text;
  const d = JSON.parse(text);
  const q = document.getElementById("quip"); q.replaceChildren(); quip(d).forEach(([text, cls], i) => { if (i) q.append(" · "); q.append(el("span", cls || "", text)); });
  // The gauges as rings: the five-hour and weekly limits (with when each resets), this machine's CPU and memory.
  const g = document.getElementById("gauges");
  const lim = (re) => (d.account ? d.account.limits.find((l) => re.test(l.label)) : undefined);
  const five = lim(/5/), week = lim(/7|week/i);
  g.replaceChildren(gaugeTile("5 hours", five ? five.pct : undefined, five ? five.resets : "no figures", !!(d.five && d.five.urgent)), gaugeTile("week", week ? week.pct : undefined, week ? week.resets : ""), gaugeTile("cpu", d.machine.cpu, "load " + d.machine.load), gaugeTile("memory", d.machine.mem, d.machine.memText));
  // The five-hour forecast, always.
  fivePanel(d.five);
  // The glasses app asking to connect: allow it if your glasses show the same code.
  const pb = document.getElementById("pair");
  pb.replaceChildren(...(d.pairing || []).map((r) => {
    const box = el("div", "ask"); box.append("👓 Your glasses want to connect · code ", el("b", "", r.code));
    const row = el("div"); const yes = el("button", "yes", "Allow"), no = el("button", "no", "Deny");
    const decide = async (allow) => { yes.disabled = no.disabled = true; await fetch("api/pair/decide?t=" + encodeURIComponent(token), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: r.id, allow }) }).catch(() => {}); box.remove(); };
    yes.addEventListener("click", () => decide(true)); no.addEventListener("click", () => decide(false));
    row.append(yes, no); box.append(row); return box;
  }));
  const cards = document.getElementById("cards");
  for (const det of cards.querySelectorAll("details")) open.set(det.closest(".card")?.dataset.sid + det.className, det.open);
  if (swiping || (!force && Date.now() < touchedUntil)) return void (lastText = ""); // nor under a card being swiped, or a finger scrolling
  const build = (s) => { const c = card(s); c.dataset.sid = s.sid; for (const det of c.querySelectorAll("details")) { const k = s.sid + det.className; if (open.has(k)) det.open = open.get(k); } return c; };
  // Finished sessions swiped away stay away (on this phone) until they start again; a button at the bottom shows them.
  const away = putAway();
  for (const sid of Object.keys(away)) { const s = d.sessions.find((x) => x.sid === sid); if (!s || !isDone(s)) delete away[sid]; }
  savePutAway(away);
  const shown = d.sessions.filter((s) => !away[s.sid]), gone = d.sessions.filter((s) => away[s.sid]);
  const list = shown.map(build);
  if (!shown.length) list.push(el("div", "empty", gone.length ? "Nothing else here: everything left has finished." : "No sessions working and nothing waiting on you."));
  if (gone.length) {
    const b = el("button", "shelf", showGone ? "Hide completed" : "Show " + gone.length + " completed"); b.type = "button";
    b.addEventListener("click", () => { showGone = !showGone; tick(); });
    list.push(b);
    if (showGone) for (const s of gone) { const c = build(s); c.classList.add("gone"); const pb = el("button", "putback", "Put back"); pb.type = "button"; pb.addEventListener("click", () => { const a = putAway(); delete a[s.sid]; savePutAway(a); tick(); }); c.prepend(pb); list.push(c); }
  }
  // Cards are updated in place, so nothing flickers and animations run on: a card laid out as before has only its
  // words and figures changed; one laid out differently is replaced, except the one you are typing in, where only
  // its conversation is.
  const typing = document.activeElement && document.activeElement.tagName === "TEXTAREA" && cards.contains(document.activeElement) ? document.activeElement.closest(".card") : null;
  const keyOf = (n) => (n.dataset && n.dataset.sid ? "s:" + n.dataset.sid + (n.classList.contains("gone") ? ":gone" : "") : "x:" + n.className);
  const was = new Map([...cards.children].map((n) => [keyOf(n), n]));
  const next = list.map((n) => {
    const o = was.get(keyOf(n));
    if (!o) return n;
    if (shapeOf(o) === shapeOf(n)) return patch(o, n), o;
    if (o !== typing) return n;
    const ol = o.querySelector(".chat .log"), nl = n.querySelector(".chat .log");
    if (ol && nl) shapeOf(ol) === shapeOf(nl) ? patch(ol, nl) : ol.replaceWith(nl);
    const os = o.querySelector(".chat > .st"), ns = n.querySelector(".chat > .st");
    if (os && ns) patch(os, ns); else if (os) os.remove(); else if (ns && o.querySelector(".chat .log")) o.querySelector(".chat .log").after(ns);
    return o;
  });
  // Only what changed is touched: moving a card would take the focus from its text box.
  const keep = new Set(next);
  for (const n of [...cards.children]) if (!keep.has(n)) n.remove();
  next.forEach((n, i) => { if (cards.children[i] !== n) cards.insertBefore(n, cards.children[i] || null); });
  settleLogs();
  document.getElementById("clock").textContent = new Date(d.now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  document.getElementById("foot").textContent = (d.hidden ? d.hidden + " idle or finished not shown · " : "") + (linkDown ? "reconnecting…" : "live");
  document.getElementById("mic").hidden = !d.voice;
  document.title = (d.counts.needs ? "▲" + d.counts.needs + " " : "") + "Claude Fleet";
  leaveSplash();
}
// What came while the page held still (a finger on it, or typing) is drawn once it can be.
setInterval(() => { if (latestText && latestText !== lastText) apply(latestText, false); }, 700);
let ws, tries = 0, polling = 0;
function live() {
  const u = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + location.pathname.replace(/[^/]*$/, "") + "api/live?t=" + encodeURIComponent(token);
  try { ws = new WebSocket(u); } catch { return again(); }
  ws.onopen = () => { tries = 0; linkDown = false; clearInterval(polling); polling = 0; if (latestText) apply(latestText, true); }; // "live" again at once
  ws.onmessage = (e) => { if (typeof e.data === "string") apply(e.data, false); };
  ws.onclose = () => { ws = undefined; again(); };
}
function again() {
  tries++; linkDown = true;
  const f = document.getElementById("foot"); if (f && !f.querySelector(".stale")) f.textContent = "reconnecting…";
  if (!polling && tries >= 2) polling = setInterval(() => tick(false), 3000); // until the link is back
  setTimeout(live, Math.min(5000, 250 * 2 ** Math.min(tries, 5)));
}
// Back from the background (a phone locks its screen): straight back on the link.
document.addEventListener("visibilitychange", () => { if (!document.hidden && (!ws || ws.readyState > 1)) { tries = 0; live(); } });
// ── voice: talk to Fleet about your sessions ──
// The phone sends its WebRTC offer to fleet, which starts a GPT-Live conversation with its own key; the audio then flows
// between the phone and OpenAI. GPT-Live hands thinking and tools to a reasoning model, whose tool calls arrive here and
// are answered from what fleet sends the page and through fleet's own actions. Nothing is typed or pressed in a session
// until PB has seen the exact line on screen and said yes (or tapped Send).
const V = { pc: null, dc: null, mic: null, raf: 0, poll: 0, energy: {}, lv: { out: 0, mic: 0 }, lvAt: {}, ease: { out: 0, mic: 0 }, saidAt: 0, pbAt: 0, health: {}, startedAt: 0, muted: false, busy: 0, deleg: false, heardAt: 0, err: 0, calls: new Map(), n: 0, seen: new Set(), log: [] };
const $ = (id) => document.getElementById(id);
const vstate = (t) => ($("vstate").textContent = t);
const vtool = (t) => ($("vtool").textContent = t || "");
const fleetData = () => { try { return JSON.parse(latestText || lastText); } catch { return { sessions: [] }; } };
const segText = (list) => (list || []).map((x) => x.t).join("");
// A session by what PB called it: the closest name.
function sessionNamed(name) {
  const list = fleetData().sessions || [], n = String(name || "").toLowerCase().trim();
  if (!n) return undefined;
  const words = n.split(/\\s+/);
  let best, score = 0;
  for (const s of list) {
    const m = s.name.toLowerCase();
    const k = m === n ? 100 : m.includes(n) || n.includes(m) ? 50 : words.filter((w) => w.length > 2 && m.includes(w)).length * 10;
    if (k > score) { score = k; best = s; }
  }
  return best;
}
const brief = (s) => ({
  name: s.name, state: s.word, for: s.time || undefined, where: s.place || undefined, now: s.sub && s.sub.text || undefined,
  question: s.state === "needs" ? s.sub && s.sub.text : undefined, context: s.ctx ? s.ctx.pct + "% of " + s.ctx.max : undefined,
  tasks: s.tasks && s.tasks.total ? s.tasks.done + " of " + s.tasks.total + " done" : undefined,
  workflows: (s.roster && s.roster.workflows || []).map((w) => ({ name: w.name, outcome: w.outcome, progress: w.done + " of " + w.total, phase: (w.phases || []).filter((p) => p.state === "now").map((p) => p.name).join(", ") || undefined })),
  agents: s.roster ? s.roster.agents.length + (s.roster.workflows || []).reduce((n, w) => n + (w.agents || []).length, 0) : 0,
  pullRequests: (s.prs || []).map(segText), failures: s.fails ? s.fails.n + " failed, last: " + s.fails.last : undefined,
});
const fleetPost = async (path, body) => { try { const r = await fetch(path + "?t=" + encodeURIComponent(token), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return await r.json(); } catch { return { ok: false, error: "can't reach fleet" }; } };
function vsend(o) { if (V.dc && V.dc.readyState === "open") V.dc.send(JSON.stringify(o)); }
// Tell Fleet something PB did on screen, for it to acknowledge in a word or two.
const vtell = (content) => vsend({ type: "session.commentary.append", event_id: "tell_" + (++V.n), delegation_id: null, content });

// What Fleet means to type or press: a card on screen until PB says yes, taps Send, or it is withdrawn. The only text
// shown in a call is these, so PB reads exactly what would go into a session.
const proposals = new Map();
const hhmm = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function drawCards() {
  const box = $("vcards"); box.replaceChildren();
  for (const p of [...proposals.values()].slice(-3)) {
    const c = el("div", "vcard " + p.state);
    c.append(el("div", "to", p.kind === "send" ? "To " + p.s.name : "Press " + (p.key === "E" ? "Enter" : p.key === "X" ? "Esc" : p.key) + " in " + p.s.name));
    c.append(el("div", "msg", p.kind === "send" ? p.text : p.meaning || ""));
    if (p.state === "pending") {
      const acts = el("div", "acts"), go = el("button", "go", p.kind === "send" ? "Send" : "Press"), no = el("button", "no", "Cancel");
      go.addEventListener("click", async () => { const r = await carryOut(p); vtell("PB tapped " + go.textContent + ": " + (r.ok ? (r.queued ? "it is queued for " : "it is done in ") + p.s.name : "it failed: " + r.error) + ". Acknowledge in two or three words."); });
      no.addEventListener("click", () => { p.state = "cancelled"; p.note = "Cancelled"; drawCards(); vtell("PB cancelled the proposal for " + p.s.name + ". Acknowledge in two or three words."); });
      acts.append(go, no); c.append(acts);
    } else c.append(el("div", "note", p.note || ""));
    box.append(c);
  }
}
async function carryOut(p) {
  if (p.state !== "pending") return { ok: false, error: "already " + p.state };
  p.state = "working"; p.note = p.kind === "send" ? "Sending…" : "Pressing…"; drawCards();
  const r = p.kind === "send" ? await fleetPost("api/send", { sid: p.s.sid, text: p.text }) : await fleetPost("api/keys", { sid: p.s.sid, key: p.key });
  p.state = r.ok ? (r.queued ? "queued" : "done") : "failed";
  p.note = r.ok ? (r.queued ? "Queued: " + p.s.name + " is busy, it goes in as soon as it can" : (p.kind === "send" ? "Sent ✓ " : "Pressed ✓ ") + hhmm()) : "Not done: " + (r.error || "unknown");
  drawCards();
  return r;
}
async function runTool(name, args) {
  const d = fleetData();
  if (name === "fleet_overview") return { time: new Date(d.now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), counts: d.counts, hiddenIdleOrFinished: d.hidden, sessions: (d.sessions || []).map(brief) };
  if (name === "usage") return { fiveHour: d.five && d.five.text, limits: d.account && d.account.limits, cpu: d.machine && d.machine.cpu + "%", memory: d.machine && d.machine.memText };
  if (name === "confirm" || name === "cancel") {
    const p = proposals.get(String(args.proposal || ""));
    if (!p) return { error: "no such proposal" };
    if (name === "cancel") { if (p.state === "pending") { p.state = "cancelled"; p.note = "Cancelled"; drawCards(); } return { cancelled: p.id }; }
    const r = await carryOut(p);
    return r.ok ? (r.queued ? { queued: true, to: p.s.name, note: "the session is busy; it goes in as soon as the session can take it" } : { done: true, in: p.s.name }) : { error: r.error };
  }
  const s = sessionNamed(args.name);
  if (!s) return { error: "No session called that. Sessions: " + (d.sessions || []).map((x) => x.name).join(", ") };
  if (name === "propose_message" || name === "propose_press") {
    const p = { id: "p" + (++V.n), kind: name === "propose_message" ? "send" : "press", s, text: String(args.text || "").trim(), key: String(args.key || ""), meaning: String(args.meaning || ""), state: "pending" };
    if (p.kind === "send" && !p.text) return { error: "nothing to send" };
    proposals.set(p.id, p); drawCards();
    return { proposal: p.id, showing: "on PB's screen with " + (p.kind === "send" ? "Send" : "Press") + " and Cancel", next: "read the gist back in a few words and ask; confirm only after a clear yes" };
  }
  vtool((name === "session_detail" ? "Looking at " : "Reading ") + s.name + "…");
  if (name === "session_detail") return { ...brief(s), conversation: (s.talk || []).map((m) => ({ who: m.who === "you" ? "PB" : "Claude", text: m.text, ago: m.ago })), openTasks: s.tasks ? s.tasks.open : [], threads: s.roster ? [...(s.roster.main ? [s.roster.main] : []), ...(s.roster.workflows || []).flatMap((w) => w.agents || []), ...(s.roster.agents || [])].map((a) => ({ name: a.label, doing: (a.tool ? a.tool + " " : "") + (a.doing || ""), ago: a.ago })) : [], changes: segText(s.changes) };
  if (name === "read_choices") { const r = await fleetPost("api/choices", { sid: s.sid }); return r.ok ? { options: r.options } : { error: r.error }; }
  return { error: "no such tool" };
}
async function onVoiceEvent(e) {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  const t = m.type || "";
  V.seen.add(t === "response.event" && m.event ? "response.event/" + m.event.type : t);
  if (t === "session.started") vtell("Greet PB as Fleet in a few words, then the one-line headline from what you know: what, if anything, is waiting on PB, and how many sessions are working. Then stop and listen.");
  else if (t === "session.delegation.created") { V.deleg = true; V.busy = Date.now(); vtool("Looking into it…"); }
  // Fleet talking with nothing handed off is not thinking (the start of a call, or between sentences). Its words are
  // not shown (only the cards are), but the last few are kept for a look from the console.
  else if (t === "session.input_transcript.delta") V.pbAt = Date.now();
  else if (t === "session.output_transcript.delta") { V.saidAt = Date.now(); if (!V.deleg) V.busy = 0; V.log.push("Fleet: " + (m.delta || "")); V.log = V.log.slice(-400); }
  else if (t === "response.event" && m.event) {
    const ev = m.event;
    V.busy = Date.now();
    if (ev.type === "response.output_item.done" && ev.item && ev.item.type === "function_call") {
      const it = ev.item;
      if (V.calls.has(it.call_id)) return;
      let args = {}; try { args = JSON.parse(it.arguments || "{}"); } catch {}
      V.log.push("tool: " + it.name + " " + (it.arguments || ""));
      V.calls.set(it.call_id, runTool(it.name, args).catch((x) => ({ error: String(x) })));
    } else if (/^response\\.(completed|done|failed|incomplete)$/.test(ev.type)) {
      // Every call this turn answered, then the backend carries on with the results.
      if (!V.calls.size) { V.deleg = false; V.busy = 0; vtool(""); return; }
      const calls = [...V.calls]; V.calls.clear();
      for (const [id, p] of calls) vsend({ type: "response.item.create", event_id: "out_" + id, item: { type: "function_call_output", call_id: id, output: JSON.stringify(await p).slice(0, 60000) } });
      vsend({ type: "response.create", event_id: "go_" + (++V.n) });
    }
  }
  else if (t === "session.closed") { const why = m.reason && m.reason !== "close_requested" ? " (" + String(m.reason).replace(/_/g, " ") + ")" : ""; closeVoice(false); V.err = 1; vstate("Call ended" + why); }
  else if (t === "error") { vtool(""); V.err = 1; vstate((m.error && m.error.message) || "Something went wrong"); setTimeout(() => (V.err = 0), 5000); }
}

// The fleet: seven orbs in the logo's colours, joined, turning with whoever speaks (Fleet one way, PB the other) and
// swelling with the voice; while Fleet thinks a pulse runs round them.
const ORBS = ["#0075fc", "#25d8fc", "#01abfd", "#01e6b3", "#63fa9b", "#3147fc", "#6c28fa"];
const orbView = { spin: 0, lv: 0, dir: 1, last: 0, w: 0 };
// The orbs' levels come from the call's own statistics (the energy each way over the last 50 ms), never an AudioContext:
// on an iPhone, tapping the call's audio with Web Audio is heard as clicks. A phone that leaves a figure out still has
// the timing of the words, from GPT-Live's transcripts.
async function pollLevels() {
  const pc = V.pc; if (!pc) return;
  try {
    const got = { out: -1, mic: -1 };
    (await pc.getStats()).forEach((r) => {
      if (r.type === "candidate-pair" && r.nominated) V.health.pair = r;
      const k = r.type === "inbound-rtp" && r.kind === "audio" ? "out" : r.type === "media-source" && r.kind === "audio" ? "mic" : "";
      if (!k) return;
      if (r.totalAudioEnergy !== undefined && r.totalSamplesDuration) {
        const was = V.energy[k]; V.energy[k] = [r.totalAudioEnergy, r.totalSamplesDuration];
        if (was && r.totalSamplesDuration > was[1]) got[k] = Math.sqrt((r.totalAudioEnergy - was[0]) / (r.totalSamplesDuration - was[1]));
      } else if (typeof r.audioLevel === "number") got[k] = r.audioLevel;
      if (k === "out") V.health.inbound = r;
    });
    for (const k of ["out", "mic"]) if (got[k] >= 0) { V.lv[k] = got[k]; V.lvAt[k] = Date.now(); }
  } catch {}
}
// From the words when the figures are missing: a lively flutter while words are arriving.
const flutter = (at, now) => (now - at < 450 ? 0.07 + 0.05 * Math.abs(Math.sin(now / 83)) + 0.03 * Math.abs(Math.sin(now / 37)) : 0);
function levelsNow() {
  const now = Date.now(), fresh = (k) => now - (V.lvAt[k] || 0) < 1500;
  const out = fresh("out") ? V.lv.out : flutter(V.saidAt, now);
  const mic = V.muted ? 0 : fresh("mic") ? V.lv.mic : flutter(V.pbAt, now);
  // Eased each frame between the 50 ms readings, so the orbs glide rather than step.
  V.ease.out += (out - V.ease.out) * 0.35; V.ease.mic += (mic - V.ease.mic) * 0.35;
  return { out: V.ease.out, mic: V.ease.mic, raw: out };
}
// How the call's audio held up, for the service log when it ends: lost packets and concealed audio mean the network,
// none means the clicks were made on the phone.
function callHealth() {
  const i = V.health.inbound || {}, p = V.health.pair || {}, num = (x) => (typeof x === "number" && isFinite(x) ? x : undefined);
  return { seconds: Math.round((Date.now() - V.startedAt) / 1000), received: num(i.packetsReceived), lost: num(i.packetsLost), jitterMs: num(i.jitter) !== undefined ? Math.round(i.jitter * 1000) : undefined,
    samples: num(i.totalSamplesReceived), concealed: num(i.concealedSamples), silentConcealed: num(i.silentConcealedSamples), concealments: num(i.concealmentEvents),
    stretched: num(i.insertedSamplesForDeceleration), squeezed: num(i.removedSamplesForAcceleration),
    bufferMs: num(i.jitterBufferDelay) !== undefined && i.jitterBufferEmittedCount ? Math.round((i.jitterBufferDelay / i.jitterBufferEmittedCount) * 1000) : undefined,
    rttMs: num(p.currentRoundTripTime) !== undefined ? Math.round(p.currentRoundTripTime * 1000) : undefined,
    phone: /iPhone|iPad/.test(navigator.userAgent) ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android" : "other" };
}
function drawOrbs(now, out, mic, mode) {
  const cv = $("orbs"), g = cv.getContext("2d");
  const w = cv.clientWidth, dpr = Math.min(2, window.devicePixelRatio || 1);
  if (orbView.w !== w) { orbView.w = w; cv.width = cv.height = Math.round(w * dpr); }
  const dt = Math.min(0.05, (now - (orbView.last || now)) / 1000); orbView.last = now;
  const voice = Math.min(1, Math.max(out, mic) * 3);
  if (out > 0.015 || mic > 0.03) orbView.dir = out >= mic ? 1 : -1;
  orbView.lv += (voice - orbView.lv) * 0.25;
  orbView.spin += dt * orbView.dir * (0.12 + 2.4 * orbView.lv) + (mode === "Thinking" ? dt * 0.8 : 0);
  const t = now / 1000, c = w / 2, R = w * 0.31;
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, w);
  const pts = ORBS.map((col, i) => {
    if (!i) return { x: c, y: c, r: w * (0.085 + 0.03 * orbView.lv), col };
    const a = orbView.spin + ((i - 1) / (ORBS.length - 1)) * Math.PI * 2;
    const wave = 0.5 + 0.5 * Math.sin(t * 7 - i * 1.1);
    const chase = mode === "Thinking" ? Math.max(0, Math.cos(a - t * 4)) ** 6 : 0;
    const rr = R * (1 + 0.05 * Math.sin(t * 0.8 + i * 1.7) + 0.1 * orbView.lv * wave);
    return { x: c + Math.cos(a) * rr, y: c + Math.sin(a) * rr, r: w * (0.052 + 0.045 * orbView.lv * wave + 0.025 * chase + (mode === "Speaking" || mode === "Listening" ? 0 : 0.004 * Math.sin(t * 2 + i))), col };
  });
  // The links: each orb to its neighbours and to the one at the heart.
  g.lineWidth = 1.2;
  for (let i = 1; i < pts.length; i++) for (const j of [0, i === pts.length - 1 ? 1 : i + 1]) {
    const p = pts[i], q = pts[j], lg = g.createLinearGradient(p.x, p.y, q.x, q.y);
    lg.addColorStop(0, p.col + "66"); lg.addColorStop(1, q.col + "66");
    g.strokeStyle = lg; g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
  }
  for (const p of pts) {
    const glow = g.createRadialGradient(p.x, p.y, p.r * 0.4, p.x, p.y, p.r * 2.6);
    glow.addColorStop(0, p.col + "55"); glow.addColorStop(1, p.col + "00");
    g.fillStyle = glow; g.beginPath(); g.arc(p.x, p.y, p.r * 2.6, 0, Math.PI * 2); g.fill();
    const body = g.createRadialGradient(p.x - p.r * 0.35, p.y - p.r * 0.4, p.r * 0.1, p.x, p.y, p.r);
    body.addColorStop(0, "#ffffffee"); body.addColorStop(0.35, p.col); body.addColorStop(1, p.col + "cc");
    g.fillStyle = body; g.beginPath(); g.arc(p.x, p.y, p.r, 0, Math.PI * 2); g.fill();
  }
}
function animate() {
  let shown = "";
  const step = (now) => {
    if (!V.pc) return;
    const { out, mic, raw } = levelsNow(), at = Date.now();
    if (raw > 0.015) V.heardAt = at;
    if (V.busy && at - V.busy > 45000) V.busy = 0; // a backend that never came back
    const mode = at - V.heardAt < 600 ? "Speaking" : V.busy ? "Thinking" : V.muted ? "Muted" : "Listening";
    if (mode !== shown && !V.err) { shown = mode; vstate(mode); }
    drawOrbs(now, out, mic, mode);
    V.raf = requestAnimationFrame(step);
  };
  V.raf = requestAnimationFrame(step);
}
// One microphone for as long as the app is open: an iPhone asks again at every getUserMedia from a home-screen app, so
// it is asked for once, switched off between calls (which stops the capture) and switched back on for the next. A
// stream iOS has ended (the app was put away for long) is asked for again.
let heldMic = null;
async function microphone() {
  if (heldMic && heldMic.getAudioTracks().some((t) => t.readyState === "live")) {
    for (const t of heldMic.getAudioTracks()) t.enabled = true;
    return heldMic;
  }
  // A permission sheet left unanswered never settles: say what's needed rather than spin.
  heldMic = await Promise.race([navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }), new Promise((_, no) => setTimeout(() => no(new Error("allow the microphone for this page, then tap the mic again")), 15000))]);
  return heldMic;
}
addEventListener("pagehide", (e) => { if (!e.persisted && heldMic) { for (const t of heldMic.getTracks()) t.stop(); heldMic = null; } });
async function openVoice() {
  const box = $("voice"); box.classList.add("on"); box.setAttribute("aria-hidden", "false");
  vtool(""); V.err = 0; proposals.clear(); drawCards();
  const st = $("orbs").parentElement;
  st.querySelector(".secure")?.remove();
  if (!window.isSecureContext || !navigator.mediaDevices) {
    // The microphone needs HTTPS: offer the page's secure link, with the same secret.
    const d = fleetData(), msg = el("div", "secure", d.secure ? "Voice needs the secure link, so your phone lets Fleet hear you." : "Voice needs HTTPS: turn HTTPS on for your tailnet (Tailscale admin → DNS), and fleet serves the page securely.");
    if (d.secure) { const a = el("a", "", "Open the secure link"); a.href = d.secure + "/?t=" + encodeURIComponent(token); msg.append(el("br"), a); }
    st.append(msg); vstate(""); return;
  }
  vstate("Connecting…");
  try {
    V.mic = await microphone();
    const pc = (V.pc = new RTCPeerConnection());
    const audio = new Audio(); audio.autoplay = true; audio.playsInline = true;
    pc.ontrack = (e) => { audio.srcObject = e.streams[0]; audio.play().catch(() => {}); };
    pc.addTrack(V.mic.getTracks()[0], V.mic);
    V.dc = pc.createDataChannel("oai-events");
    V.dc.onmessage = onVoiceEvent;
    await pc.setLocalDescription(await pc.createOffer());
    // The whole offer, candidates and all, goes in the one request.
    await new Promise((ok) => { if (pc.iceGatheringState === "complete") return ok(); const done = () => pc.iceGatheringState === "complete" && ok(); pc.addEventListener("icegatheringstatechange", done); setTimeout(ok, 2500); });
    const r = await fleetPost("api/voice/session", { sdp: pc.localDescription.sdp, voice: chosenVoice() });
    if (!r.ok) throw new Error(r.error || "no answer");
    $("vpick").setAttribute("aria-label", "Fleet's voice: " + cap(r.voice) + ". Choose another");
    await pc.setRemoteDescription({ type: "answer", sdp: r.sdp });
    V.startedAt = Date.now(); V.poll = setInterval(pollLevels, 50);
    V.busy = Date.now();
    animate();
  } catch (x) { closeVoice(false); V.err = 1; vstate("Couldn't start: " + (x && x.message || x)); }
}
function closeVoice(hide = true) {
  cancelAnimationFrame(V.raf);
  if (V.dc && V.dc.readyState === "open") vsend({ type: "session.close", event_id: "bye" });
  try { V.dc && V.dc.close(); } catch {} try { V.pc && V.pc.close(); } catch {}
  if (V.mic) for (const t of V.mic.getTracks()) t.enabled = false; // kept, switched off, for the next call
  clearInterval(V.poll);
  if (V.pc && V.startedAt) void fleetPost("api/voice/health", callHealth());
  Object.assign(V, { pc: null, dc: null, mic: null, energy: {}, lvAt: {}, health: {}, startedAt: 0, muted: false, busy: 0, deleg: false, heardAt: 0, err: 0 });
  V.calls.clear();
  $("vmute").className = "";
  if (hide) { $("voice").classList.remove("on"); $("voice").setAttribute("aria-hidden", "true"); showVoices(false); }
  if (latestText) apply(latestText, true);
}
// The voice: chosen in the picker and kept on this phone; fleet's default until then. A voice is set when a call starts,
// so choosing another mid-call starts a fresh call in it.
const cap = (v) => (v ? v[0].toUpperCase() + v.slice(1) : "");
const voices = () => fleetData().voices || { list: [], default: "stone", model: "" };
const hasVoice = (v) => voices().list.some((x) => x.id === v);
function chosenVoice() { let v = ""; try { v = localStorage.getItem("fleet-voice") || ""; } catch {} return hasVoice(v) ? v : voices().default; }
const icon = (name) => $("vicons").content.querySelector("." + name).cloneNode(true); // from the page's own markup
const sampleUrl = (v) => "api/voice/sample?v=" + encodeURIComponent(v) + "&t=" + encodeURIComponent(token);
// One player for every preview: starting one replaces whatever was playing, so two never sound at once.
const player = new Audio(); player.preload = "auto";
let sample = null;
function stopSample() { player.pause(); if (sample) { sample.btn.className = "vp"; sample.btn.replaceChildren(icon("play")); sample.btn.setAttribute("aria-label", "Hear " + cap(sample.v)); sample = null; } }
function playSample(v, btn) {
  const same = sample && sample.v === v; stopSample(); if (same) return;
  sample = { v, btn };
  btn.className = "vp wait"; btn.replaceChildren(icon("stop")); btn.setAttribute("aria-label", "Stop " + cap(v));
  player.src = sampleUrl(v); player.currentTime = 0;
  player.play().catch(() => {});
}
player.addEventListener("playing", () => sample && (sample.btn.className = "vp on"));
player.addEventListener("ended", stopSample);
player.addEventListener("error", () => { if (sample && player.src) { const v = sample.v; stopSample(); vtool("Couldn't play " + cap(v)); } });
// The previews are small: fetched once when the menu first opens, so each plays the moment it is tapped.
let warmed = false;
const warmSamples = () => { if (warmed) return; warmed = true; for (const x of voices().list) fetch(sampleUrl(x.id), { priority: "low" }).catch(() => {}); };
function drawVoices() {
  const box = $("vlist"), d = voices(), now = chosenVoice();
  box.replaceChildren(el("div", "vhead", d.model + " · " + d.list.length + " voices"));
  for (const x of d.list) {
    const v = x.id, row = el("div", "vrow"); row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(v === now));
    const pick = el("button", "vn"); pick.append(el("b", "", cap(v)), el("small", "", x.about || ""));
    const play = el("button", "vp"); play.append(icon("play")); play.setAttribute("aria-label", "Hear " + cap(v));
    if (sample && sample.v === v) { sample.btn = play; play.className = player.paused ? "vp wait" : "vp on"; play.replaceChildren(icon("stop")); }
    pick.addEventListener("click", () => chooseVoice(v));
    play.addEventListener("click", (e) => { e.stopPropagation(); playSample(v, play); });
    row.append(pick, play); box.append(row);
  }
}
function showVoices(open) {
  $("vlist").hidden = !open; $("vpick").setAttribute("aria-expanded", String(open));
  if (open) { warmSamples(); drawVoices(); const on = $("vlist").querySelector('[aria-selected="true"]'); if (on) on.scrollIntoView({ block: "nearest" }); } else stopSample();
}
function chooseVoice(v) {
  const was = chosenVoice();
  try { localStorage.setItem("fleet-voice", v); } catch {}
  showVoices(false);
  if (v !== was && V.pc) { vtool("Switching to " + cap(v) + "…"); closeVoice(false); openVoice(); }
}
$("vpick").addEventListener("click", (e) => { e.stopPropagation(); showVoices($("vlist").hidden); });
$("vlist").addEventListener("click", (e) => e.stopPropagation());
$("voice").addEventListener("click", () => !$("vlist").hidden && showVoices(false));
$("mic").addEventListener("click", openVoice);
$("vend").addEventListener("click", () => closeVoice());
$("vmute").addEventListener("click", () => {
  V.muted = !V.muted;
  if (V.mic) for (const t of V.mic.getAudioTracks()) t.enabled = !V.muted;
  vsend({ type: V.muted ? "session.input_audio.mute" : "session.input_audio.unmute", event_id: "mute_" + (++V.n) });
  $("vmute").className = V.muted ? "muted" : "";
});

tick(); live();
</script></body></html>`;

/** The web server, once key w has started it: where it listens and the link to open. */
export const web: { watchedAt: number; links: number; push?: () => void; secure?: { stop: (closeActive?: boolean) => void; publish: (topic: string, data: string) => void }; url?: string; host?: string; onTailnet?: boolean; server?: { stop: (closeActive?: boolean) => void }; error?: string; send?: typeof sendToSession; keys?: typeof keysToSession; peek?: typeof peekSession; start?: typeof startSession; shared?: boolean; retake?: () => void; yieldPort?: () => void; older?: boolean } = { watchedAt: 0, links: 0 };
const sameToken = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual ? (() => { try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; } })() : a === b;
/** This Mac's Tailscale IPv4 address, when it has one. */
/**
 * The tailscale command: the one on the PATH (Homebrew, Linux, Windows), else the one inside the Mac app, which is how
 * Tailscale's Mac app (App Store or standalone) ships it, with nothing on the PATH. Without it fleet cannot find its
 * tailnet address, and would serve this Mac only.
 */
export const TAILSCALE_MAC_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
export const pickTailscale = (onPath: boolean, platform: string, macApp: boolean) => (!onPath && platform === "darwin" && macApp ? TAILSCALE_MAC_APP : "tailscale");
let tailscaleFound: string | undefined;
export function tailscaleCmd(): string {
  tailscaleFound ??= pickTailscale(spawnSync(process.platform === "win32" ? "where" : "which", ["tailscale"], { timeout: 3000 }).status === 0, process.platform, fs.existsSync(TAILSCALE_MAC_APP));
  return tailscaleFound;
}
function tailnetAddress(): string | undefined {
  if (process.env.FLEET_WEB_HOST) return process.env.FLEET_WEB_HOST;
  try {
    const r = spawnSync(tailscaleCmd(), ["ip", "-4"], { encoding: "utf8", timeout: 10_000 });
    const ip = r.stdout?.split("\n")[0]?.trim();
    return r.status === 0 && ip && /^100\.\d+\.\d+\.\d+$/.test(ip) ? ip : undefined;
  } catch {
    return undefined;
  }
}
/** Where the page's secret is kept: made once, readable only by you, so the link (and a home-screen icon) stays the same. Delete it to change the link. */
export const webTokenPath = () => process.env.FLEET_WEB_TOKEN_FILE || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "claude-fleet", "web-token");
export function webToken(): string {
  const file = webTokenPath();
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (/^[A-Za-z0-9_-]{24,}$/.test(t)) {
      fs.chmodSync(file, 0o600);
      return t;
    }
  } catch {}
  const t = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, t + "\n", { mode: 0o600 });
  return t;
}
/** The home-screen icon at `n` pixels: the fleet diamond, a cyan ring around a white core on the page's dark ground, as a PNG. Kept well inside the middle 80% so a maskable crop never clips it. */
const iconPngs = new Map<number, Buffer>();
export function webIcon(n: number): Buffer {
  const hit = iconPngs.get(n);
  if (hit) return hit;
  const bg = [13, 17, 23];
  const colourAt = (x: number, y: number) => {
    const d = (Math.abs(x - n / 2) + Math.abs(y - n / 2)) / n; // diamond distance, as a share of the size
    return d < 0.1 ? [245, 247, 250] : d < 0.16 ? bg : d < 0.3 ? [86, 205, 214] : bg;
  };
  const raw = Buffer.alloc((n * 3 + 1) * n);
  const S = 4; // samples per side, so the diagonal edges are smooth
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const sum = [0, 0, 0];
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const c = colourAt(x + (sx + 0.5) / S, y + (sy + 0.5) / S);
          for (let i = 0; i < 3; i++) sum[i] += c[i];
        }
      raw.set(sum.map((v) => Math.round(v / (S * S))), y * (n * 3 + 1) + 1 + x * 3);
    }
  const table = Array.from({ length: 256 }, (_, k) => {
    let c = k;
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
  iconPngs.set(n, png);
  return png;
}
const ICON_SIZES: Record<string, number> = { "/apple-touch-icon.png": 180, "/apple-touch-icon-precomposed.png": 180, "/favicon.ico": 32, "/icon-192.png": 192, "/icon-512.png": 512, "/icon-maskable-512.png": 512 };
/** The app icon: the files in icons/ beside fleet.ts (the F), or the drawn diamond if they are missing. */
const iconFiles = new Map<string, Buffer | null>();
/** How big the splash draws the icon, in points, and how much of the splash stands below it (gaps, title, status line). */
export const SPLASH_LOGO = 192;
export const SPLASH_BELOW = 16 + 28 + 32 + 16 + 19;
/** The phones whose home-screen launch picture fleet draws: width and height in points, and pixels to a point. */
export const STARTUP_SIZES: [number, number, number][] = [[440, 956, 3], [402, 874, 3], [430, 932, 3], [393, 852, 3], [390, 844, 3], [428, 926, 3], [375, 812, 3], [414, 896, 3], [414, 896, 2], [375, 667, 2], [320, 568, 2]];
/** An 8-bit RGB PNG's pixels (the icons are such). */
export function rgbOfPng(png: Buffer): { w: number; h: number; rgb: Uint8Array } | undefined {
  if (png.readUInt32BE(12) !== 0x49484452 || png[24] !== 8 || png[25] !== 2 || png[28] !== 0) return undefined;
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  const parts: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const len = png.readUInt32BE(at), type = png.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") parts.push(png.subarray(at + 8, at + 8 + len));
    at += len + 12;
  }
  const raw = inflateSync(Buffer.concat(parts)), row = w * 3, rgb = new Uint8Array(row * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (row + 1)], src = raw.subarray(y * (row + 1) + 1, (y + 1) * (row + 1));
    for (let x = 0; x < row; x++) {
      const a = x >= 3 ? rgb[y * row + x - 3] : 0, b = y ? rgb[(y - 1) * row + x] : 0, c = x >= 3 && y ? rgb[(y - 1) * row + x - 3] : 0;
      const pr = () => { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
      rgb[y * row + x] = (src[x] + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? pr() : 0)) & 255;
    }
  }
  return { w, h, rgb };
}
/** The splash as a still, for the phone to show while the home-screen app starts: its background, and the icon where the splash puts it. */
const startupPngs = new Map<string, Buffer>();
export function startupPng(cw: number, ch: number, d: number): Buffer {
  const key = `${cw}x${ch}@${d}`;
  const done = startupPngs.get(key);
  if (done) return done;
  const W = cw * d, H = ch * d, out = new Uint8Array(W * H * 3);
  const bg = [0x0d, 0x11, 0x17], glow = [0x18, 0x21, 0x2d];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const t = Math.min(1, Math.hypot((x - W / 2) / (1.2 * W), (y - 0.38 * H) / (0.8 * H)) / 0.62);
      for (let k = 0; k < 3; k++) out[(y * W + x) * 3 + k] = Math.round(glow[k] + (bg[k] - glow[k]) * t);
    }
  // The icon: 192 points, its corners rounded by a quarter, centred above the title as the splash lays it out
  // (the icon, 16 and the title's 28 more, the title's 32, 16 and the status line's 19 points, centred together).
  const icon = rgbOfPng(appIcon("/icon-512.png"));
  if (icon) {
    const S = SPLASH_LOGO * d, r = S / 4, left = Math.round(W / 2 - S / 2), top = Math.round(H / 2 - ((SPLASH_LOGO + SPLASH_BELOW) / 2) * d);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const cx = Math.min(Math.max(x + 0.5, r), S - r), cy = Math.min(Math.max(y + 0.5, r), S - r);
        const cover = Math.max(0, Math.min(1, r - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + 0.5));
        if (!cover) continue;
        const sx = ((x + 0.5) / S) * icon.w - 0.5, sy = ((y + 0.5) / S) * icon.h - 0.5;
        const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy)), x1 = Math.min(icon.w - 1, x0 + 1), y1 = Math.min(icon.h - 1, y0 + 1), fx = sx - x0, fy = sy - y0;
        const o = ((top + y) * W + left + x) * 3;
        for (let k = 0; k < 3; k++) {
          const v = (icon.rgb[(y0 * icon.w + x0) * 3 + k] * (1 - fx) + icon.rgb[(y0 * icon.w + x1) * 3 + k] * fx) * (1 - fy) + (icon.rgb[(y1 * icon.w + x0) * 3 + k] * (1 - fx) + icon.rgb[(y1 * icon.w + x1) * 3 + k] * fx) * fy;
          out[o + k] = Math.round(out[o + k] * (1 - cover) + v * cover);
        }
      }
  }
  const png = pngOf(W, H, out);
  startupPngs.set(key, png);
  return png;
}
const STARTUP_LINKS = STARTUP_SIZES.map(([w, h, d]) => `<link rel="apple-touch-startup-image" media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${d}) and (orientation: portrait)" href="/startup-${w}x${h}@${d}.png">`).join("\n");
/** The logo's own shape (the icon less its black), white on clear, so the splash's shine lights the logo and nothing else. */
let logoMaskUrl = "";
export function logoMask(): string {
  if (logoMaskUrl) return logoMaskUrl;
  const icon = rgbOfPng(appIcon("/icon-512.png"));
  if (!icon) return "";
  const n = 256, out = new Uint8Array(n * n * 4), k = icon.w / n;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let a = 0;
      for (let dy = 0; dy < k; dy++)
        for (let dx = 0; dx < k; dx++) {
          const o = (Math.floor(y * k + dy) * icon.w + Math.floor(x * k + dx)) * 3;
          a += Math.min(255, Math.max(icon.rgb[o], icon.rgb[o + 1], icon.rgb[o + 2]) * 4);
        }
      out.set([255, 255, 255, Math.round(a / (k * k))], (y * n + x) * 4);
    }
  return (logoMaskUrl = "data:image/png;base64," + pngOf(n, n, out, 4).toString("base64"));
}
/** The icon, inline, so the splash shows it before anything else has loaded. */
let splashIconUrl = "";
const splashIcon = () => splashIconUrl || (splashIconUrl = "data:image/png;base64," + appIcon("/icon-512.png").toString("base64"));
export function appIcon(route: string): Buffer {
  const name = route === "/icon-maskable-512.png" ? "icon-maskable-512.png" : `icon-${ICON_SIZES[route]}.png`;
  if (!iconFiles.has(name))
    try {
      iconFiles.set(name, fs.readFileSync(path.join(import.meta.dir, "icons", name)));
    } catch {
      iconFiles.set(name, null);
    }
  return iconFiles.get(name) ?? webIcon(ICON_SIZES[route]);
}
/** The web app manifest. It carries the secret in its start address, so it is served only to a request that has the link. */
export const webManifest = (token: string) => ({
  name: "Claude Fleet",
  short_name: "Fleet",
  description: "Every Claude Code session on your Mac, at a glance.",
  start_url: `/?t=${token}`,
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  background_color: "#000000", // the icon's own black, for the splash screen
  theme_color: "#0d1117",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
});

/** A message from the page made safe to paste into a terminal: no control characters but newlines and tabs, so it cannot carry escape codes; at most 4000 characters. */
export const cleanMessage = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "")
    .trim()
    .slice(0, 4000);
const tmuxCmd = () => "tmux";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The tmux pane a session's process runs in, on your usual tmux server, if it runs in one. */
function paneOf(pid: number): string | undefined {
  const tty = spawnSync("ps", ["-o", "tty=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 }).stdout?.trim();
  if (!tty || tty.startsWith("?")) return undefined;
  const panes = spawnSync(tmuxCmd(), ["list-panes", "-a", "-F", "#{pane_tty} #{pane_id}"], { encoding: "utf8", timeout: 3000 }).stdout ?? "";
  return panes.split("\n").map((l) => l.split(" ")).find(([t]) => t === `/dev/${tty}` || t === tty)?.[1];
}
/** Paste `text` into a tmux pane as one bracketed paste (so its lines stay one message), then press Enter. */
function pasteInto(server: string[], pane: string, text: string): boolean {
  const load = spawnSync(tmuxCmd(), [...server, "load-buffer", "-b", "fleet-message", "-"], { input: text, timeout: 3000 });
  const paste = load.status === 0 && spawnSync(tmuxCmd(), [...server, "paste-buffer", "-p", "-d", "-b", "fleet-message", "-t", pane], { timeout: 3000 }).status === 0;
  return paste && spawnSync(tmuxCmd(), [...server, "send-keys", "-t", pane, "Enter"], { timeout: 3000 }).status === 0;
}
let sendChain: Promise<unknown> = Promise.resolve();
type Reach = { ok: boolean; via?: string; error?: string; screen?: string; id?: string; later?: boolean; queued?: boolean };
/**
 * Run `fn` with a session's terminal within reach, one session at a time. A background session is opened with
 * `claude attach` in a hidden tmux (and closed after; the session keeps running); a session running in a tmux pane
 * is reached in that pane. Anything else cannot be reached.
 */
function withSession(s: Session, fn: (server: string[], pane: string, via: string) => Promise<Reach> | Reach): Promise<Reach> {
  const run = async (): Promise<Reach> => {
    if (process.platform === "win32") return { ok: false, error: "reaching a session needs tmux, so it does not work on Windows" };
    if (spawnSync(tmuxCmd(), ["-V"], { timeout: 3000 }).status !== 0) return { ok: false, error: "reaching a session needs tmux, which is not installed" };
    if (s.jobId) {
      // Twice if need be: an attach that does not open is tried once more, a moment later, in a fresh tmux.
      let r = await attachAnd(s, fn);
      if (!r.ok && r.retry) {
        svcLog(`could not open ${s.name || s.sid.slice(0, 8)} (${r.error}); trying again${r.screen ? `. Its screen: ${safeLine(r.screen.trim().split("\n").slice(-3).join(" ⏎ ")).slice(0, 300)}` : ""}`);
        await pause(1500);
        r = await attachAnd(s, fn);
        if (!r.ok && r.retry) svcLog(`could not open ${s.name || s.sid.slice(0, 8)} again (${r.error})${r.screen ? `. Its screen: ${safeLine(r.screen.trim().split("\n").slice(-3).join(" ⏎ ")).slice(0, 300)}` : ""}`);
      }
      // Out of reach for now (claude attach would not open it): worth another go later, which is the sender's call.
      const { retry, ...out } = r;
      return retry && !out.ok ? { ...out, later: true } : out;
    }
    const pane = paneOf(s.pid);
    if (!pane) return { ok: false, error: "this session is not a background session or in tmux, so it cannot be reached from here" };
    return fn([], pane, "pane");
  };
  const next = sendChain.then(run, run);
  sendChain = next.catch(() => {});
  return next;
}
let attachN = 0;
/** Open a background session with `claude attach` in a hidden tmux of its own, run `fn` once it is ready, close it. */
async function attachAnd(s: Session, fn: (server: string[], pane: string, via: string) => Promise<Reach> | Reach): Promise<Reach & { retry?: boolean }> {
  const server = ["-L", `fleet-send-${process.pid}-${++attachN}`];
  const attach = process.env.FLEET_ATTACH_CMD || "claude";
  // The pane outlives claude attach for a moment, so when it will not open, what it said is on the screen for the log.
  const run = ["sh", "-c", 'exec 2>&1; "$0" attach "$1"; echo "fleet: attach ended ($?)"; sleep 5', attach, s.jobId!];
  if (spawnSync(tmuxCmd(), [...server, "new-session", "-d", "-x", "120", "-y", "40", ...run], { timeout: 5000 }).status !== 0) return { ok: false, error: "could not open the session", retry: true };
  try {
    // Ready once its prompt (the input line, or a choice) is drawn and either the screen has settled or the prompt
    // has stood for a second: a session that is thinking keeps its spinner turning, and takes a message all the same.
    let last = "", promptSince = 0, screen = "";
    for (let i = 0; i < 60; i++) {
      await pause(250);
      // claude attach has already exited (no such session, or it could not attach): no point waiting.
      if (spawnSync(tmuxCmd(), [...server, "has-session"], { timeout: 3000 }).status !== 0) return { ok: false, error: "could not open the session", retry: true, screen };
      screen = spawnSync(tmuxCmd(), [...server, "capture-pane", "-p"], { encoding: "utf8", timeout: 3000 }).stdout ?? "";
      if (screen.includes("fleet: attach ended")) return { ok: false, error: "could not open the session", retry: true, screen };
      if (!screen.includes("❯")) promptSince = 0;
      else if (!promptSince) promptSince = i;
      if (promptSince && (screen === last || i - promptSince >= 4)) return await fn(server, "0", "attach");
      last = screen;
    }
    return { ok: false, error: "the session did not open in time", retry: true, screen };
  } finally {
    spawnSync(tmuxCmd(), [...server, "kill-server"], { timeout: 3000 });
  }
}
const typeInto = (s: Session, text: string) =>
  withSession(s, async (server, pane, via) => {
    if (!pasteInto(server, pane, text)) return { ok: false, error: "could not type into the session" };
    if (via === "attach") await pause(1000); // let it take the message before the attach closes
    return { ok: true, via };
  });
/** Messages for sessions that would not open, delivered in order when they will: tried again, less often, for ten minutes. */
const sendQueue = new Map<string, { s: Session; items: { text: string; done?: (r: Reach) => void }[]; since: number }>();
const SEND_QUEUE_MS = 10 * 60_000;
async function drainQueue(sid: string) {
  const q = sendQueue.get(sid)!;
  const step = Number(process.env.FLEET_SEND_RETRY_MS) || 10_000;
  const name = q.s.name || sid.slice(0, 8);
  for (let i = 1; q.items.length; i++) {
    await pause(Math.min(6 * step, step * i));
    const r = await typeInto(q.s, q.items[0].text);
    if (r.ok) {
      svcLog(`delivered a queued message to ${name}`);
      q.items.shift()!.done?.({ ok: true, via: r.via });
      continue;
    }
    if (r.later && Date.now() - q.since < SEND_QUEUE_MS) continue;
    svcLog(`gave up on ${q.items.length} queued message${q.items.length === 1 ? "" : "s"} for ${name}: ${r.error}`);
    for (const it of q.items) it.done?.({ ok: false, error: r.error });
    break;
  }
  sendQueue.delete(sid);
}
/**
 * Type a message into a session, as if you had typed it there, on whichever machine it is on. A session that will
 * not open just now (busy, mid-turn, briefly out of reach) gets it queued, not refused: `queued` says so, and `done`
 * hears when it is delivered or given up on.
 */
export async function sendToSession(s: Session, raw: string, done?: (r: Reach) => void): Promise<Reach> {
  const text = cleanMessage(raw);
  if (!text) return { ok: false, error: "nothing to send" };
  if (s.remote) return peerCall(s, "/peer/send", { sid: s.sid, text }); // its own machine's fleet types it in
  const waiting = sendQueue.get(s.sid);
  if (waiting) return waiting.items.push({ text, done }), { ok: true, via: "queued", queued: true }; // after those before it
  const r = await typeInto(s, text);
  if (r.ok || !r.later) return r;
  sendQueue.set(s.sid, { s, items: [{ text, done }], since: Date.now() });
  void drainQueue(s.sid);
  return { ok: true, via: "queued", queued: true };
}
/** The keys a button can press in a session: a numbered choice, Enter, or Esc (which stops what it is doing). */
export const SESSION_KEYS: Record<string, string> = { "1": "1", "2": "2", "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9", E: "Enter", X: "Escape" };
export function keysToSession(s: Session, key: string): Promise<Reach> {
  const k = SESSION_KEYS[key];
  if (!k) return Promise.resolve({ ok: false, error: "not a key fleet presses" });
  if (s.remote) return peerCall(s, "/peer/keys", { sid: s.sid, key });
  return withSession(s, async (server, pane, via) => {
    const ok = spawnSync(tmuxCmd(), [...server, "send-keys", "-t", pane, k], { timeout: 3000 }).status === 0;
    if (via === "attach") await pause(800);
    return ok ? { ok, via } : { ok, error: "could not press the key" };
  });
}
/** What a session's own terminal shows right now, colours and all. */
export function peekSession(s: Session): Promise<Reach> {
  if (s.remote) return peerCall(s, "/peer/peek", { sid: s.sid });
  return withSession(s, (server, pane, via) => {
    const screen = spawnSync(tmuxCmd(), [...server, "capture-pane", "-p", "-e", "-t", pane], { encoding: "utf8", timeout: 3000 }).stdout ?? "";
    return { ok: !!screen.trim(), via, screen: screen.slice(-60_000), error: screen.trim() ? undefined : "its screen was empty" };
  });
}
/** The numbered choices a prompt on the screen offers ("1. Yes", "❯ 2. No"), for buttons. */
export function screenOptions(screen: string): { key: string; label: string }[] {
  const lines = screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n").slice(-30);
  const out: { key: string; label: string }[] = [];
  for (const line of lines) {
    const m = /^[\s│┃|]*(?:[❯>›▶]\s*)?([1-9])[.)]\s+(\S.{0,58}?)\s*[│┃|]?\s*$/.exec(line);
    if (m && !out.some((o) => o.key === m[1])) out.push({ key: m[1], label: safeLine(m[2]).trim() });
  }
  return out;
}
/** Start a background Claude session in `cwd`, as `claude --bg` does; its id, when it started. */
export async function startSession(cwd: string, prompt: string): Promise<Reach> {
  const text = cleanMessage(prompt);
  if (!text) return { ok: false, error: "nothing to ask" };
  try {
    const p = Bun.spawn([process.env.FLEET_ATTACH_CMD || "claude", "--bg", text], { cwd, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), 30_000);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    clearTimeout(timer);
    const id = /claude attach (\S+)/.exec(out)?.[1];
    if ((await p.exited) === 0 && id) return { ok: true, id };
    return { ok: false, error: safeLine((err || out).trim().split("\n")[0] || "claude --bg did not start").slice(0, 160) };
  } catch {
    return { ok: false, error: "could not run claude" };
  }
}

/** What every page is told, made once a scan and shared: by /api/state, and pushed over the live link when it changes. */
let stateCache: { seq: number; body: string; gz?: Uint8Array } | undefined;
let glassesCache: { seq: number; body: string } | undefined;
let pushed = "";
/** Something that held the thread over 300 ms, for the service log (at most every 30 s). */
let slowSaidAt = 0;
export function noteSlow(what: string, ms: number) {
  if (ms < 300 || Date.now() - slowSaidAt < 30_000 || !isServiceWorker) return;
  slowSaidAt = Date.now();
  svcLog(`${what} took ${Math.round(ms)} ms`);
}
/** The page's request handler, timed: a slow one names itself in the log (the path, never the secret). */
const timedRequest = (handle: (req: Request, srv: any) => Promise<Response>) => async (req: Request, srv: any): Promise<Response> => {
  const a = performance.now();
  try {
    // The installed glasses app: its origin is answered on the paths it uses, and asked first when it sends JSON.
    const origin = req.headers.get("origin");
    const at = new URL(req.url).pathname;
    const forApp = !!origin && APP_PATHS.test(at) && appOrigin(origin);
    if (req.method === "OPTIONS") {
      if (!forApp) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": origin!, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400", vary: "origin" } });
    }
    const res = await handle(req, srv);
    if (forApp && res) {
      res.headers.set("access-control-allow-origin", origin!);
      res.headers.set("vary", "origin");
    }
    return res;
  } finally {
    noteSlow(`a request for ${new URL(req.url).pathname}`, performance.now() - a);
  }
};
// ── the installed glasses app ──
// Installed from Even Hub, the glasses app runs from its own package in the Even app on your phone: its requests come from
// that package's origin, not fleet's, and it carries no secret (the package is uploaded to Even). It pairs instead: the
// glasses show a code, you approve it on Telegram or the Fleet page, and the app keeps the secret in its own storage.

/** Origins the installed app may call from: the device's own loopback, on any port (the Even app serves an installed app
 *  from a small server on the phone itself, http://127.0.0.1:<port>), an app's own scheme, file: or "null" (as an app's
 *  own pages have), or one named in FLEET_APP_ORIGINS (comma-separated). Web sites stay refused, as before. */
export function appOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (origin === "null" || !/^https?:\/\//i.test(origin)) return true;
  if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) return true; // only what runs on that device has this origin
  return (process.env.FLEET_APP_ORIGINS ?? "").split(",").map((x) => x.trim()).filter(Boolean).includes(origin);
}
/** The paths the installed app uses: answered to its origin, and asked of first (a preflight) when it sends JSON. */
const APP_PATHS = /^\/api\/(glasses|keys|send|choices|pair\/start|pair\/poll)$/;
let refusedSaid = 0;
const noteRefused = (origin: string, path: string) => {
  if (Date.now() - refusedSaid < 60_000 || !isServiceWorker) return;
  refusedSaid = Date.now();
  svcLog(`refused a request for ${path} from ${origin.slice(0, 80)}: if that is your glasses app, set FLEET_APP_ORIGINS=${origin.slice(0, 80)}`);
};
export interface Pairing {
  id: string;
  code: string; // shown on the glasses and where you approve it, to compare
  at: number;
  status: "pending" | "approved" | "denied";
  taken?: boolean; // the secret has been handed over (once)
}
const pairings = new Map<string, Pairing>();
const PAIR_MS = 10 * 60_000;
const PAIR_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // nothing to misread: no 0/O, 1/I/L
/** The glasses ask to pair: a code to show, and the request put to you (Telegram, the Fleet page). At most three at a time. */
export function pairStart(now = Date.now(), yours = false): Pairing | undefined {
  for (const [id, p] of pairings) if (now - p.at > PAIR_MS) pairings.delete(id);
  if ([...pairings.values()].filter((p) => p.status === "pending").length >= 3) return undefined;
  const code = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => PAIR_LETTERS[b % PAIR_LETTERS.length]).join("");
  const p: Pairing = { id: crypto.randomUUID(), code, at: now, status: yours ? "approved" : "pending" };
  pairings.set(p.id, p);
  if (!yours) void tgPairAsk(p);
  return p;
}
/** Your answer to a pairing request. */
export function pairDecide(id: string, allow: boolean, now = Date.now()): boolean {
  const p = pairings.get(id);
  if (!p || p.status !== "pending" || now - p.at > PAIR_MS) return false;
  p.status = allow ? "approved" : "denied";
  return true;
}
/** What the glasses learn when they ask: still waiting, refused, gone, or approved with the secret (handed over once). */
export function pairPoll(id: string, token: string, now = Date.now()): { status: string; token?: string } {
  const p = pairings.get(id);
  if (!p || now - p.at > PAIR_MS) return { status: "expired" };
  if (p.status === "approved" && !p.taken) {
    p.taken = true;
    return { status: "approved", token };
  }
  return { status: p.status === "approved" ? "expired" : p.status };
}
/** The requests waiting on you, for the Fleet page. */
export const pairsPending = (now = Date.now()) => [...pairings.values()].filter((p) => p.status === "pending" && now - p.at <= PAIR_MS).map((p) => ({ id: p.id, code: p.code }));
async function tgPairAsk(p: Pairing) {
  const c = readTg();
  if (!tg.on || !c.token || !c.chat) return;
  await tgCall(c.token, "sendMessage", { chat_id: c.chat, text: `👓 Your glasses want to connect to Claude Fleet.\n\nCode: ${p.code}\n\nAllow it only if your glasses show this code.`, reply_markup: { inline_keyboard: [[{ text: `✅ Allow · ${p.code}`, callback_data: `pair:${p.id}:y` }, { text: "Deny", callback_data: `pair:${p.id}:n` }]] } });
}

// ── the page over HTTPS ──
// A phone lets a page use its microphone only over HTTPS, so for voice the page is served a second time, on fleet's port
// plus one, with the certificate Tailscale issues for this Mac's name (https://<name>.<tailnet>.ts.net:4778). Kept in
// ~/.config/claude-fleet/tls (the key readable only by you), fetched in the background and renewed daily.
const tlsDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "claude-fleet", "tls");
export const securePort = () => (Number(process.env.FLEET_WEB_PORT) || 4777) + 1;
let tsName = "";
/** This Mac's Tailscale name, once known (tailscale status). */
function tailnetName(): string {
  if (tsName || process.env.FLEET_HOME) return tsName;
  try {
    tsName = String(JSON.parse(spawnSync(tailscaleCmd(), ["status", "--json"], { encoding: "utf8", timeout: 5000 }).stdout).Self?.DNSName ?? "").replace(/\.$/, "");
  } catch {}
  return tsName;
}
/** The page's secure link, when there is a certificate for it (the background service may be the one serving it). */
export function secureLink(token: string): string | undefined {
  if (process.env.FLEET_HOME || process.env.FLEET_WEB_TLS === "0") return undefined;
  const name = tailnetName();
  if (!name || !fs.existsSync(path.join(tlsDir(), "cert.pem"))) return undefined;
  return `https://${name}:${securePort()}/?t=${token}`;
}
let tlsRenew: ReturnType<typeof setInterval> | undefined;
function serveSecure(options: any, host: string, token: string) {
  if (process.env.FLEET_HOME || process.env.FLEET_WEB_TLS === "0") return; // made-up sessions (demo, tests), or turned off
  const name = tailnetName();
  if (!name) return;
  const dir = tlsDir();
  const cert = path.join(dir, "cert.pem"), key = path.join(dir, "key.pem");
  const start = () => {
    try {
      web.secure?.stop(true);
      web.secure = Bun.serve({ ...options, hostname: host, port: securePort(), tls: { cert: fs.readFileSync(cert, "utf8"), key: fs.readFileSync(key, "utf8") } } as any);
    } catch (e) {
      if (isServiceWorker) svcLog(`could not serve the page over HTTPS: ${String((e as Error).message ?? e).slice(0, 120)}`);
    }
  };
  const fetchCert = () => {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {}
    runInBackground(tailscaleCmd(), ["cert", "--cert-file", cert, "--key-file", key, name], 60_000, (code) => {
      if (code === 0) start();
      else if (fs.existsSync(cert)) start(); // the one we have, while it lasts
      else if (isServiceWorker) svcLog("no HTTPS for the page: tailscale cert failed (is HTTPS on for your tailnet?)");
    });
  };
  if (fs.existsSync(cert) && fs.existsSync(key)) start();
  fetchCert();
  if (tlsRenew) clearInterval(tlsRenew);
  tlsRenew = setInterval(fetchCert, 24 * 3600_000);
  tlsRenew.unref?.();
  void token;
}

// ── voice ──
// With an OpenAI key (OPENAI_API_KEY, in the environment or a .env beside fleet.ts), the phone page can talk: you speak
// with Fleet about your sessions, on OpenAI's GPT-Live. The phone's WebRTC offer comes to /api/voice/session and fleet
// starts the session with its own key, so the key never leaves this Mac; the audio then flows between phone and OpenAI.
// GPT-Live hands thinking and tools to a reasoning model (Responses delegation); the page answers its tool calls from the
// fleet's data and through fleet's own actions. The key is never sent, logged or shown.
let openAIKeyCache: { at: number; key: string } | undefined;
export function openAIKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  if (openAIKeyCache && Date.now() - openAIKeyCache.at < 60_000) return openAIKeyCache.key;
  let key = "";
  try {
    key = (/^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*["']?([^"'\n#]+)["']?/m.exec(fs.readFileSync(path.join(import.meta.dir, ".env"), "utf8"))?.[1] ?? "").trim();
  } catch {}
  openAIKeyCache = { at: Date.now(), key };
  return key;
}
export const VOICE = {
  model: () => process.env.FLEET_VOICE_MODEL || "gpt-live-1",
  voice: () => process.env.FLEET_VOICE || "stone",
  think: () => process.env.FLEET_THINK_MODEL || "gpt-6-luna",
  effort: () => process.env.FLEET_THINK_EFFORT || "medium",
};
const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = Object.keys(properties)) => ({ type: "function", name, description, parameters: { type: "object", properties, required, additionalProperties: false } });
const named = { name: { type: "string", description: "The session's name, or words from it" } };
/** What the reasoning model behind Fleet can do; the page carries each one out. Typing and pressing go through a proposal PB sees first. */
export const VOICE_TOOLS = [
  fn("fleet_overview", "Every Claude Code session right now: name, state (needs you, working, stalled, finished…), what it is doing, its question if it is waiting, context use, tasks, workflows, agents, pull requests, failures. Use before answering anything about the sessions."),
  fn("session_detail", "One session in full: its recent conversation (PB's prompts and Claude's replies), open tasks, workflows and what each agent is doing, pull requests, failures, changes.", named),
  fn("usage", "The Claude usage limits (five-hour and weekly, when they reset, when the five-hour limit runs out at this pace) and this Mac's CPU and memory."),
  fn("read_choices", "The numbered choices on a waiting session's own screen (its question's options).", named),
  fn("propose_message", "Put a message for a session on PB's screen, exactly as it would be typed into that session's terminal, with Send and Cancel. Nothing is sent yet. Write it as PB would: short and direct.", { ...named, text: { type: "string" } }),
  fn("propose_press", "Put a key press for a waiting session on PB's screen: a numbered choice (1-9), Enter (E) or Esc (X, which stops what it is doing), with its meaning. Nothing is pressed yet.", { ...named, key: { type: "string", enum: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "E", "X"] }, meaning: { type: "string", description: "What pressing it does, in a few words, e.g. 'Yes, proceed'" } }),
  fn("confirm", "Carry out a proposal (send its message or press its key) ONLY after PB has clearly said yes to that proposal.", { proposal: { type: "string" } }),
  fn("cancel", "Withdraw a proposal PB said no to, or changed.", { proposal: { type: "string" } }),
];
/** A few words on each session for the voice to open with: what it is called, its state, what it is on. */
function voiceSnapshot(stateBody: string) {
  try {
    const d = JSON.parse(stateBody);
    return JSON.stringify({ counts: d.counts, sessions: (d.sessions ?? []).map((s: any) => ({ name: s.name, state: s.word, now: s.sub?.text })) }).slice(0, 12_000);
  } catch {
    return "{}";
  }
}
export function voiceSessionBody(sdp: string, stateBody: string, voice?: string) {
  return {
    session: {
      model: VOICE.model(),
      instructions:
        "You are Fleet: the voice of PB's fleet of Claude Code sessions, running on PB's Macs. Call yourself Fleet, and call the person PB. Speak British English: warm, quick, a little dry, never gushing. "
        + "Keep it short: one to three sentences, then stop and listen. Say session names naturally; never read out ids, hashes or file paths. If something is waiting on PB, say that first. "
        + "Anything about the sessions as they are now, or any action, goes to your backend, which has the tools. To type into a session or press a choice, the backend first puts it on PB's screen; read the gist back in a few words and ask, and only on a clear yes have it confirmed. "
        + "When the conversation starts, PB's sessions were: " + voiceSnapshot(stateBody),
      audio: { output: { voice: pickVoice(voice) } },
      delegation: {
        type: "responses",
        responses: {
          model: VOICE.think(),
          reasoning: { effort: VOICE.effort() },
          instructions:
            "You are the mind behind Fleet, a voice assistant for PB's fleet of Claude Code sessions. Use the tools for anything about the sessions: they change every second. Answers are spoken aloud: plain sentences, no markdown, no lists over four things, no ids or paths, under 80 words unless asked for more. "
            + "Never type into a session or press a key without PB's yes: propose_message or propose_press first (PB sees it on screen), then confirm only after PB has clearly said yes to that proposal; cancel it if PB says no. Messages are typed into Claude Code as if PB typed them, so write them as PB would.",
          tools: VOICE_TOOLS,
          tool_choice: "auto",
          parallel_tool_calls: true,
        },
      },
    },
    transport: { type: "webrtc", sdp },
  };
}
/** GPT-Live's voices, as its guide describes them (it has no call that lists them): language, accent, presentation, and
 * whether the voice is a recorded one ("natural") or made. */
export const VOICE_INFO: Record<string, { lang: string; accent?: string; gender: "male" | "female"; natural: boolean }> = {
  quartz: { lang: "English", accent: "Australian", gender: "female", natural: false },
  ripple: { lang: "English", accent: "Australian", gender: "male", natural: true },
  vesper: { lang: "English", accent: "British", gender: "male", natural: true },
  willow: { lang: "English", accent: "Irish", gender: "female", natural: true },
  stone: { lang: "English", accent: "Irish", gender: "male", natural: true },
  gleam: { lang: "English", accent: "North American", gender: "female", natural: true },
  meridian: { lang: "English", accent: "North American", gender: "male", natural: true },
  bossa: { lang: "Portuguese", accent: "Brazilian", gender: "female", natural: true },
  tempo: { lang: "Portuguese", accent: "Brazilian", gender: "male", natural: true },
  beacon: { lang: "English", accent: "Filipino", gender: "male", natural: false },
  delta: { lang: "English", accent: "Southern US", gender: "female", natural: false },
  cinder: { lang: "English", accent: "Southern US", gender: "male", natural: false },
  nuri: { lang: "German", gender: "female", natural: true },
  juni: { lang: "German", gender: "female", natural: true },
  flitz: { lang: "German", gender: "male", natural: true },
  brise: { lang: "French", gender: "female", natural: true },
  sillage: { lang: "French", gender: "male", natural: true },
  nira: { lang: "Hindi", gender: "female", natural: true },
  harema: { lang: "Japanese", gender: "female", natural: true },
  shida: { lang: "Japanese", gender: "male", natural: true },
  noeul: { lang: "Korean", gender: "female", natural: true },
};
export const LIVE_VOICES = Object.keys(VOICE_INFO);
/** What the picker shows under a voice's name: "Irish English · male", "German · female". */
export const voiceBlurb = (v: string) => {
  const i = VOICE_INFO[v];
  return i ? `${i.accent ? `${i.accent} ${i.lang === "English" ? "English" : i.lang}` : i.lang} · ${i.gender}` : "";
};
/** The hello each voice's preview says, in its own language. */
export function voiceHello(v: string): string {
  const name = v[0].toUpperCase() + v.slice(1);
  const lines: Record<string, string> = {
    English: `Hi PB, I'm Fleet, in the ${name} voice. Shall we see what the fleet's up to?`,
    Portuguese: `Olá PB, eu sou o Fleet, com a voz ${name}. Vamos ver o que a frota anda fazendo?`,
    German: `Hallo PB, ich bin Fleet, mit der Stimme ${name}. Sollen wir schauen, was die Flotte macht?`,
    French: `Bonjour PB, je suis Fleet, avec la voix ${name}. On regarde ce que fait la flotte ?`,
    Hindi: `नमस्ते PB, मैं Fleet हूँ, ${name} आवाज़ में। चलिए देखते हैं, फ़्लीट क्या कर रहा है?`,
    Japanese: `こんにちは、PBさん。${name}の声のFleetです。フリートの様子を見てみましょうか？`,
    Korean: `안녕하세요, PB님. ${name} 목소리의 Fleet입니다. 플릿이 뭘 하고 있는지 볼까요?`,
  };
  return lines[VOICE_INFO[v]?.lang ?? "English"] ?? lines.English;
}
const pickVoice = (v: unknown) => (typeof v === "string" && LIVE_VOICES.includes(v) ? v : VOICE.voice());
/** Raw 24 kHz mono PCM16 as a WAV file. */
export function pcmToWav(pcm: Uint8Array, rate = 24_000): Uint8Array {
  const out = new Uint8Array(44 + pcm.length), v = new DataView(out.buffer);
  const text = (at: number, t: string) => [...t].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); text(8, "WAVE"); text(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, "data"); v.setUint32(40, pcm.length, true); out.set(pcm, 44);
  return out;
}
/** The speech in a stretch of PCM16, without the quiet before and after it (a quarter second kept each side). */
export function trimSilence(pcm: Uint8Array, rate = 24_000): Uint8Array {
  const n = Math.floor(pcm.length / 2), v = new DataView(pcm.buffer, pcm.byteOffset, n * 2), win = rate / 20;
  const loud = (i: number) => { let e = 0; const end = Math.min(n, i + win); for (let j = i; j < end; j++) e += v.getInt16(j * 2, true) ** 2; return Math.sqrt(e / Math.max(1, end - i)) > 200; };
  let a = 0, b = n;
  while (a < n && !loud(a)) a += win;
  while (b > a && !loud(Math.max(a, b - win))) b -= win;
  if (a >= b) return new Uint8Array(0);
  const pad = rate / 4;
  return pcm.slice(Math.max(0, a - pad) * 2, Math.min(n, b + pad) * 2);
}
/**
 * A voice saying `text`, as trimmed 24 kHz PCM16: a short GPT-Live session over its WebSocket, with quiet sent as the
 * microphone, since it speaks only in a live conversation. Used to make the previews (tools/make-voice-previews.ts),
 * and for a voice that has none yet.
 */
export function recordVoice(voice: string, text: string, key = openAIKey(), heard?: (said: string) => void): Promise<Uint8Array | undefined> {
  return new Promise<Uint8Array | undefined>((done) => {
    if (!key || !LIVE_VOICES.includes(voice)) return done(undefined);
    const parts: Uint8Array[] = [];
    let saidAt = 0, said = "", quiet: ReturnType<typeof setInterval> | undefined;
    const ws = new WebSocket("wss://api.openai.com/v1/live/sessions", { headers: { authorization: `Bearer ${key}` } } as any);
    const finish = () => {
      clearInterval(quiet); clearInterval(watch); clearTimeout(cap);
      try { ws.send(JSON.stringify({ type: "session.close" })); ws.close(); } catch {}
      const speech = trimSilence(Buffer.concat(parts));
      heard?.(said.trim());
      done(speech.length ? speech : undefined);
    };
    // Done once the words have stopped for a second and a half; never more than twenty seconds.
    const watch = setInterval(() => saidAt && Date.now() - saidAt > 1500 && finish(), 250);
    const cap = setTimeout(finish, 20_000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "session.start", session: { model: VOICE.model(), instructions: "You are Fleet. When told what to say, say exactly that, warmly and naturally, in its language, and nothing else.", audio: { output: { voice } } } }));
    ws.onmessage = (m) => {
      let e: any;
      try { e = JSON.parse(String(m.data)); } catch { return; }
      if (e.type === "session.started") {
        const silence = Buffer.alloc(4800).toString("base64"); // a tenth of a second of quiet, as a microphone would send
        quiet = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: "session.input_audio.append", audio: silence })), 100);
        ws.send(JSON.stringify({ type: "session.commentary.append", event_id: "sample", delegation_id: null, content: `Say exactly this, and nothing else: ${text}` }));
      } else if (e.type === "session.output_audio.delta" && typeof e.delta === "string") parts.push(Buffer.from(e.delta, "base64"));
      else if (e.type === "session.output_transcript.delta") { saidAt = Date.now(); said += e.delta ?? ""; }
      else if (e.type === "error" && !parts.length) finish();
    };
    ws.onerror = () => finish();
  });
}
/** Where the previews that come with fleet live (made once by tools/make-voice-previews.ts, AAC in .m4a). */
export const voicePreviewFile = (v: string) => path.join(import.meta.dir, "voices", `${v}.m4a`);
const sampleMaking = new Map<string, Promise<Uint8Array | undefined>>();
/** A voice's preview, for the picker: the one that comes with fleet; else one made now (once) and kept in the cache. */
export function voiceSample(voice: string): Promise<{ bytes: Uint8Array; type: string } | undefined> {
  if (!LIVE_VOICES.includes(voice)) return Promise.resolve(undefined);
  try {
    return Promise.resolve({ bytes: new Uint8Array(fs.readFileSync(voicePreviewFile(voice))), type: "audio/mp4" });
  } catch {}
  const file = path.join(svcDir(), "voices", `${voice}.wav`);
  try {
    return Promise.resolve({ bytes: new Uint8Array(fs.readFileSync(file)), type: "audio/wav" });
  } catch {}
  if (!openAIKey()) return Promise.resolve(undefined);
  let making = sampleMaking.get(voice);
  if (!making) {
    making = recordVoice(voice, voiceHello(voice)).then((pcm) => {
      if (!pcm) return undefined;
      const wav = pcmToWav(pcm);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, wav);
      } catch {}
      return wav;
    }).finally(() => sampleMaking.delete(voice));
    sampleMaking.set(voice, making);
  }
  return making.then((wav) => (wav ? { bytes: wav, type: "audio/wav" } : undefined));
}
/**
 * How a voice call's audio held up, from the phone's WebRTC statistics, as one line for the service log: packets lost
 * and audio concealed point at the network; stretching and squeezing at the jitter buffer; neither, at the phone itself.
 */
export function voiceHealthLine(b: Record<string, unknown>): string | undefined {
  const n = (k: string) => (typeof b[k] === "number" && Number.isFinite(b[k]) && (b[k] as number) >= 0 ? Math.round(b[k] as number) : undefined);
  const seconds = n("seconds");
  if (seconds === undefined) return undefined;
  const pct = (a?: number, of?: number) => (a !== undefined && of ? `${((100 * a) / of).toFixed(2)}%` : "?");
  const received = n("received"), lost = n("lost"), samples = n("samples"), rate = samples && seconds ? samples / seconds : 48_000;
  const ms = (k: string) => (n(k) !== undefined ? `${Math.round((1000 * n(k)!) / rate)} ms` : "?");
  const phone = ["iPhone", "Android", "other"].includes(String(b.phone)) ? String(b.phone) : "other";
  return `voice call, ${seconds}s on ${phone}: packets lost ${lost ?? "?"} of ${received ?? "?"} (${pct(lost, (received ?? 0) + (lost ?? 0))}), audio concealed ${pct(n("concealed"), samples)} in ${n("concealments") ?? "?"} events (${pct(n("silentConcealed"), samples)} silent), stretched ${ms("stretched")}, squeezed ${ms("squeezed")}, jitter ${n("jitterMs") ?? "?"} ms, buffer ${n("bufferMs") ?? "?"} ms, round trip ${n("rttMs") ?? "?"} ms`;
}
/** Start a GPT-Live conversation for the phone's WebRTC offer, with this Mac's key: the answer for the phone. */
async function voiceSession(sdp: string, stateBody: string, voice?: string): Promise<{ ok: boolean; sdp?: string; id?: string; model?: string; voice?: string; error?: string }> {
  const key = openAIKey();
  if (!key) return { ok: false, error: "no OpenAI key: put OPENAI_API_KEY in fleet's .env" };
  if (!sdp.startsWith("v=0") || sdp.length > 30_000) return { ok: false, error: "no WebRTC offer" };
  try {
    const r = await fetch("https://api.openai.com/v1/live/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(voiceSessionBody(sdp, stateBody, voice)),
      signal: AbortSignal.timeout(20_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || typeof j?.transport?.sdp !== "string") return { ok: false, error: `OpenAI said ${r.status}${j?.error?.message ? `: ${safeLine(String(j.error.message)).slice(0, 200)}` : ""}` };
    return { ok: true, sdp: j.transport.sdp, id: j.session?.id, model: VOICE.model(), voice: pickVoice(voice) };
  } catch {
    return { ok: false, error: "could not reach OpenAI" };
  }
}

/** The pages' data for this scan, made once and kept until the next. */
let pageSessions: () => Session[] = () => [];
let pageNow: () => number = clock;
function pageState() {
  if (!stateCache || stateCache.seq !== scanSeq) stateCache = { seq: scanSeq, body: JSON.stringify(webState(pageSessions(), pageNow())) };
  return stateCache;
}
/** Start serving the page (once). Every request must carry the secret; anything but the page and its data is a 404. */
export function startWeb(getSessions: () => Session[], now: () => number = clock): typeof web {
  if (web.server || web.error || web.shared) return web;
  pageSessions = getSessions;
  pageNow = now;
  let token: string;
  try {
    token = webToken();
  } catch (e) {
    web.error = `could not keep the page's secret in ${webTokenPath()}: ${(e as Error).message}`;
    return web;
  }
  const tail = tailnetAddress();
  const host = tail ?? "127.0.0.1";
  if (!tail && isServiceWorker) svcLog(`no Tailscale address (${tailscaleCmd()} ip -4 gave none: is Tailscale running and signed in?), so the page is on this Mac only and your other machines cannot see this one`);
  const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob: mediastream:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };
  const base = Number(process.env.FLEET_WEB_PORT) || 4777;
  const serveOn = (port: number) => {
    try {
      web.server?.stop(true); // one page per fleet: never two servers with one forgotten
      web.secure?.stop(true);
      const options = {
        websocket: {
          perMessageDeflate: true, // compressed on the wire
          open(ws) {
            web.links++;
            ws.subscribe("state");
            // This page gets what is current; if that is newer than the last push, the other linked pages get it too.
            const body = pageState().body;
            if (body !== pushed) {
              pushed = body;
              ws.publish("state", body); // to every other subscriber
            }
            ws.send(body);
          },
          close() {
            web.links = Math.max(0, web.links - 1);
          },
          message() {},
        },
        fetch: timedRequest(async (req: Request, srv: any): Promise<Response> => {
          const url = new URL(req.url);
          // Another of your machines: allowed when Tailscale says the request comes from your own Tailscale user.
          if (url.pathname.startsWith("/peer/")) {
            const ip = (srv.requestIP(req)?.address ?? "").replace(/^::ffff:/, "");
            if (!ip || !(await peerNet.trust(ip))) return new Response("not one of your machines", { status: 403, headers });
            const local = getSessions().filter((x) => !x.remote);
            if (url.pathname === "/peer/state") {
              // What the asking machine pushed of its own (when it changed), or only that it is unchanged.
              let pushed: any;
              if (req.method === "POST") {
                try {
                  const raw = new Uint8Array(await req.arrayBuffer());
                  if (raw.length > 8_000_000) return new Response("too big", { status: 413, headers });
                  pushed = JSON.parse(new TextDecoder().decode(req.headers.get("x-fleet-gzip") ? Bun.gunzipSync(raw) : raw));
                } catch {
                  return new Response("not a fleet's state", { status: 400, headers });
                }
              }
              const from = Number(req.headers.get("x-fleet-port")) || 4777;
              const itself = (ip === tailnet.ip || /^127\./.test(ip)) && from === srv.port; // this fleet asking itself is no other machine
              const have = itself ? undefined : takePushedPeer(ip, from, req.headers.get("x-fleet-tag") ?? "", pushed);
              const ph = have ? { ...headers, "x-fleet-have": have } : headers; // this answer's own, never the shared headers
              const st = peerState(local, now());
              // Nothing changed since that machine last asked: say so in a few bytes.
              if (req.headers.get("if-none-match") === st.tag) return new Response(null, { status: 304, headers: { ...ph, etag: st.tag } });
              return new Response(st.body, { headers: { ...ph, "content-type": "application/json", "content-encoding": "gzip", etag: st.tag } });
            }
            if (req.method === "POST") {
              const body: any = await req.json().catch(() => ({}));
              // A new session, only in a folder where one already runs here: never anywhere a request names.
              if (url.pathname === "/peer/new") {
                if (typeof body?.cwd !== "string" || typeof body?.prompt !== "string" || !local.some((x) => x.cwd === body.cwd)) return Response.json({ ok: false, error: "not a folder fleet knows here" }, { status: 404, headers });
                return Response.json(await (web.start ?? startSession)(body.cwd, body.prompt), { headers });
              }
              const target = local.find((x) => x.sid === body?.sid);
              if (!target) return Response.json({ ok: false, error: "no such session" }, { status: 404, headers });
              if (url.pathname === "/peer/send" && typeof body.text === "string") return Response.json(await (web.send ?? sendToSession)(target, body.text), { headers });
              if (url.pathname === "/peer/keys" && typeof body.key === "string") return Response.json(await (web.keys ?? keysToSession)(target, body.key), { headers });
              if (url.pathname === "/peer/peek") return Response.json(await (web.peek ?? peekSession)(target), { headers });
            }
            return new Response("not allowed", { status: 405, headers });
          }
          // Pairing the installed glasses app. Asking needs no secret (that is what it is for); the answer is yours to give.
          if (req.method === "POST" && (url.pathname === "/api/pair/start" || url.pathname === "/api/pair/poll")) {
            const origin = req.headers.get("origin");
            if (origin && !appOrigin(origin) && origin !== `${url.protocol}//${url.host}`) return noteRefused(origin, url.pathname), new Response("not from here", { status: 403, headers });
            if (url.pathname === "/api/pair/start") {
              // From one of your own devices (Tailscale says so): no code to approve. Anything else waits for your Allow.
              const ip = (srv.requestIP(req)?.address ?? "").replace(/^::ffff:/, "");
              const yours = !!ip && !/^(127\.|::1$)/.test(ip) && (await peerNet.trust(ip));
              const p = pairStart(Date.now(), yours);
              return p ? Response.json({ id: p.id, code: p.code }, { headers }) : Response.json({ error: "too many requests waiting" }, { status: 429, headers });
            }
            let body: { id?: unknown } = {};
            try {
              body = await req.json();
            } catch {}
            return Response.json(pairPoll(String(body.id ?? ""), token), { headers });
          }
          if (req.method === "POST" && url.pathname === "/api/voice/health") {
            const origin = req.headers.get("origin");
            if (!sameToken(url.searchParams.get("t") ?? "", token) || (origin && origin !== `${url.protocol}//${url.host}`) || !req.headers.get("content-type")?.startsWith("application/json")) return new Response("not from here", { status: 403, headers });
            let body: Record<string, unknown> = {};
            try {
              body = await req.json();
            } catch {}
            const line = voiceHealthLine(body);
            if (line) svcLog(line);
            return Response.json({ ok: !!line }, { headers });
          }
          if (req.method === "POST" && url.pathname === "/api/voice/session") {
            const origin = req.headers.get("origin");
            if (!sameToken(url.searchParams.get("t") ?? "", token) || (origin && origin !== `${url.protocol}//${url.host}`) || !req.headers.get("content-type")?.startsWith("application/json")) return new Response("not from here", { status: 403, headers });
            let body: { sdp?: unknown; voice?: unknown } = {};
            try {
              body = await req.json();
            } catch {}
            return Response.json(await voiceSession(String(body.sdp ?? ""), pageState().body, typeof body.voice === "string" ? body.voice : undefined), { headers });
          }
          if (req.method === "POST" && url.pathname === "/api/pair/decide") {
            const origin = req.headers.get("origin");
            if (!sameToken(url.searchParams.get("t") ?? "", token) || (origin && origin !== `${url.protocol}//${url.host}`) || !req.headers.get("content-type")?.startsWith("application/json")) return new Response("not from here", { status: 403, headers });
            let body: { id?: unknown; allow?: unknown } = {};
            try {
              body = await req.json();
            } catch {}
            return Response.json({ ok: pairDecide(String(body.id ?? ""), body.allow === true) }, { headers });
          }
          if (req.method === "POST" && (url.pathname === "/api/send" || url.pathname === "/api/keys" || url.pathname === "/api/choices")) {
            if (!sameToken(url.searchParams.get("t") ?? "", token)) return new Response("not without the link fleet showed you", { status: 403, headers });
            // Only the page itself may send: another site's form or script carries its own origin, or the wrong type.
            const origin = req.headers.get("origin");
            if (origin && origin !== `${url.protocol}//${url.host}` && !appOrigin(origin)) noteRefused(origin, url.pathname);
            if ((origin && origin !== `${url.protocol}//${url.host}` && !appOrigin(origin)) || !req.headers.get("content-type")?.startsWith("application/json")) return new Response("not from here", { status: 403, headers });
            let body: { sid?: unknown; text?: unknown; key?: unknown };
            try {
              body = await req.json();
            } catch {
              return new Response("bad message", { status: 400, headers });
            }
            const target = getSessions().find((x) => x.sid === body.sid);
            if (!target) return Response.json({ ok: false, error: "no such session" }, { status: 404, headers });
            // The glasses: a key pressed in the session (a numbered choice, Enter, Esc), or the choices on its screen.
            if (url.pathname === "/api/keys") {
              if (typeof body.key !== "string") return Response.json({ ok: false, error: "no key" }, { status: 400, headers });
              const r = await (web.keys ?? keysToSession)(target, body.key);
              return Response.json(r, { status: r.ok ? 200 : 409, headers });
            }
            if (url.pathname === "/api/choices") {
              const r = await (web.peek ?? peekSession)(target);
              return Response.json({ ok: r.ok, error: r.error, options: r.screen ? screenOptions(r.screen).map((o) => ({ key: o.key, label: glassesSafe(o.label) })) : [] }, { headers });
            }
            if (typeof body.text !== "string") return Response.json({ ok: false, error: "no message" }, { status: 400, headers });
            const r = await (web.send ?? sendToSession)(target, body.text);
            return Response.json(r, { status: r.ok ? 200 : 409, headers });
          }
          if (req.method !== "GET") return new Response("not allowed", { status: 405, headers });
          // The live link: the page's own origin only, and the secret, as for everything else.
          if (url.pathname === "/api/live") {
            const origin = req.headers.get("origin");
            if (!sameToken(url.searchParams.get("t") ?? "", token) || (origin && origin !== `${url.protocol}//${url.host}`)) return new Response("not without the link fleet showed you", { status: 403, headers });
            if (srv.upgrade(req)) return undefined as unknown as Response;
            return new Response("a live link needs a WebSocket", { status: 400, headers });
          }
          // The icon is the only thing served without the secret: phones fetch it without the link's query.
          // Even's SDK for the glasses page: public code (MIT), so it needs no secret.
          if (url.pathname === "/glasses/sdk.js") {
            const sdk = glassesSdkFile();
            return sdk ? new Response(sdk, { headers: { ...headers, "content-type": "text/javascript; charset=utf-8", "cache-control": "max-age=3600" } }) : new Response("not found", { status: 404, headers });
          }
          const startup = /^\/startup-(\d+)x(\d+)@(\d)\.png$/.exec(url.pathname);
          if (startup && STARTUP_SIZES.some(([w, h, d]) => `${w}x${h}@${d}` === `${startup[1]}x${startup[2]}@${startup[3]}`)) return new Response(startupPng(+startup[1], +startup[2], +startup[3]), { headers: { ...headers, "content-type": "image/png", "cache-control": "max-age=86400" } });
          if (ICON_SIZES[url.pathname]) return new Response(appIcon(url.pathname), { headers: { ...headers, "content-type": "image/png", "cache-control": "max-age=86400" } });
          if (!sameToken(url.searchParams.get("t") ?? "", token)) return new Response("not without the link fleet showed you", { status: 403, headers });
          if (url.pathname === "/manifest.webmanifest") return Response.json(webManifest(token), { headers: { ...headers, "content-type": "application/manifest+json" } });
          if (url.pathname === "/") return new Response(WEB_PAGE.replace("__TOKEN__", token).replace("__ICON__", splashIcon()).replaceAll("__LOGO_MASK__", logoMask()).replace("__STARTUP__", STARTUP_LINKS), { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
          // A voice saying hello, for the picker: the preview that comes with fleet, kept by the phone for a week.
          if (url.pathname === "/api/voice/sample") {
            const v = url.searchParams.get("v") ?? "";
            if (!LIVE_VOICES.includes(v)) return new Response("no such voice", { status: 404, headers });
            const got = await voiceSample(v);
            return got ? new Response(got.bytes, { headers: { ...headers, "content-type": got.type, "cache-control": "private, max-age=604800" } }) : new Response(openAIKey() ? "could not make a sample" : "no OpenAI key", { status: openAIKey() ? 502 : 503, headers });
          }
          if (url.pathname === "/api/state") {
            web.watchedAt = Date.now();
            const stateCache = pageState(); // made once a scan, for every page and every poll
            if (!/\bgzip\b/.test(req.headers.get("accept-encoding") ?? "")) return new Response(stateCache.body, { headers: { ...headers, "content-type": "application/json" } });
            stateCache.gz ??= Bun.gzipSync(new TextEncoder().encode(stateCache.body));
            return new Response(stateCache.gz, { headers: { ...headers, "content-type": "application/json", "content-encoding": "gzip", vary: "accept-encoding" } });
          }
          if (url.pathname === "/glasses") return new Response(GLASSES_PAGE, { headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } });
          if (url.pathname === "/api/glasses") {
            web.watchedAt = Date.now();
            if (!glassesCache || glassesCache.seq !== scanSeq) glassesCache = { seq: scanSeq, body: JSON.stringify(glassesState(getSessions(), now())) };
            return new Response(glassesCache.body, { headers: { ...headers, "content-type": "application/json" } });
          }
          return new Response("not found", { status: 404, headers });
        }),
      };
      const server = Bun.serve({ hostname: host, port, ...options } as any);
      if (tail) serveSecure(options, host, token);
      Object.assign(web, {
        server,
        host,
        onTailnet: !!tail,
        url: `http://${host}:${port}/?t=${token}`,
        shared: false,
        // After each read: what the pages are told, pushed to those linked when it has changed.
        push: () => {
          if (!web.links) return;
          const body = pageState().body;
          if (body === pushed) return;
          pushed = body;
          server.publish("state", body);
          web.secure?.publish("state", body);
        },
      });
      return true;
    } catch {
      return false;
    }
  };
  // The background service, when it runs, always serves: it runs the code on disk, where a window may be days old.
  web.yieldPort = () => {
    if (web.server && !web.shared) {
      web.secure?.stop(true);
      web.secure = undefined;
      web.server.stop(true); // open connections too: a phone holding one moves to the service at once
      Object.assign(web, { server: undefined, shared: true });
    }
  };
  web.retake = () => {
    if (!web.shared || serviceRunning()) return;
    if (serveOn(base)) {
      web.older = false;
      notice.until = 0;
    } else if (web.older) Object.assign(notice, { text: `old fleet holds :${base}, quit it`, until: clock() + 12_000 });
  };
  if (!serviceRunning() && serveOn(base)) return web;
  // The port is taken, most likely by another fleet, which keeps the same secret and so answers the same link: use
  // that, so the link (and a home-screen icon) is the same whichever fleet serves it. Check it really is a fleet; if
  // not, serve on the next free port. And take the page over when the other fleet quits.
  Object.assign(web, { host, onTailnet: !!tail, url: `http://${host}:${base}/?t=${token}`, shared: true });
  const fallBack = () => {
    if (serviceRunning()) return; // the service serves the page (or is starting to): never a second page on another port
    for (let port = base + 1; port < base + 20; port++) if (serveOn(port)) return;
    Object.assign(web, { url: undefined, shared: false, error: `could not find a free port from ${base}` });
  };
  fetch(`http://${host}:${base}/manifest.webmanifest?t=${token}`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.json())
    .then(async (m) => {
      if (m?.name !== "Claude Fleet") return fallBack();
      // A fleet, but is it this version? An older one cannot answer your other machines, so they would not see this one.
      const r = await fetch(`http://${host}:${base}/peer/state`, { signal: AbortSignal.timeout(4000) }).catch(() => undefined);
      const j: any = r?.ok ? await r.json().catch(() => undefined) : undefined;
      // Different code (a fleet started before an update) serves pages this one may not have, such as the glasses'.
      web.older = j?.proto !== PEER_PROTO || j?.build !== FLEET_BUILD;
      if (web.older && isServiceWorker) svcLog(`an older fleet holds port ${base}: quit it, and this one takes over`);
    })
    .catch(fallBack);
  return web;
}

let webOn = false; // key w: the screen with the page's QR code is showing
/** Key w: the QR code to scan, the link, and where it is reachable from. Any key returns. */
export function webScreen(cols: number, rows: number): string[] {
  const W = Math.max(40, cols);
  const out: string[] = ["", fg(C.cyan, bold("  ◆ CLAUDE FLEET")) + fg(C.white, " on your phone"), ""];
  if (!web.url) out.push(fg(C.red, `  ${web.error ?? "the web page did not start"}`));
  else if (webGlasses) {
    // The Even app scans this to open fleet on G2 glasses (in its developer settings: scan a QR code).
    const link = web.url.replace("/?t=", "/glasses?t=");
    for (const line of qrRows(link) ?? []) out.push("  " + line);
    out.push("", fg(C.text, "  " + link));
    out.push(fg(C.white, "  On your Even Realities G2 glasses: scan this in the Even app."), fg(C.dim, "  The phone needs Tailscale on, as for the phone page. g shows the phone's code again."));
  } else {
    // The secure link when there is one: the phone's microphone (voice) needs it. The plain one works for the rest.
    const token = new URL(web.url).searchParams.get("t") ?? "";
    const link = secureLink(token) ?? web.url;
    const qr = qrRows(link) ?? [];
    for (const line of qr) out.push("  " + line);
    out.push("", fg(C.text, "  " + link));
    if (link !== web.url) out.push(fg(C.dim, "  Or without HTTPS (no voice): " + web.url));
    out.push(
      ...(web.shared ? [fg(C.dim, "  Another fleet on this Mac is serving it (same link); this one takes over if that one quits.")] : []),
      fg(C.dim, svcState().running ? "  Fleet runs in the background here, so the page stays up with every window closed." : "  Press i to keep fleet running in the background, so the page stays up when you close this."),
      fg(C.dim, web.onTailnet ? "  On your tailnet: any of your Tailscale devices can open it, nothing else can." : "  No Tailscale here (is it running and signed in?), so it is open on this Mac only (127.0.0.1): your other machines and phone cannot reach it."),
      fg(C.dim, "  The link is the key and stays the same, so add it to your home screen. It can type messages into your"),
      fg(C.dim, "  sessions, so keep it to yourself. Delete ~/.config/claude-fleet/web-token to change it."),
    );
  }
  while (out.length < rows - 1) out.push("");
  out.length = Math.max(0, rows - 1);
  out.push(fg(C.dim, fit(webGlasses ? "  g: the phone's code · any other key returns" : "  g: the code for G2 glasses · any other key returns", W)));
  return out.map((l) => clipRow(l, W));
}

// ───────────────────────── Telegram ─────────────────────────
// Key t pairs fleet with a Telegram bot of your own, so it can message you on every device: when a session needs
// you (reply to that message to answer it), when one looks stuck, and when a pull request fails, goes green, merges
// or goes live. Messages go through Telegram's servers. The bot answers only the one chat it was paired with.

export interface TgConfig {
  token?: string; // the bot's token from @BotFather: never drawn, logged or put in an error
  bot?: string; // the bot's username
  chat?: number; // the paired chat and the person in it; nothing else is listened to
  user?: number;
  pairCode?: string; // the one-time code in the pairing link, until a chat uses it
  at?: number; // when it last changed: the newest wins across your machines
  muted?: Record<string, number>; // sessions you silenced, until when
  quiet?: { from: string; to: string }; // quiet hours: only "needs you" comes through
  digest?: { at: string; last?: number }; // the digest's time ("08:00", or "off") and when it was last sent
  live?: { id: number; text?: boolean }; // the pinned view that keeps itself up to date: a picture, or the overview as text
}
const fleetConfigDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "claude-fleet");
export const tgConfigPath = () => process.env.FLEET_TELEGRAM_FILE || path.join(fleetConfigDir(), "telegram.json");
const tgApiBase = () => process.env.FLEET_TELEGRAM_API || "https://api.telegram.org";
export function readTg(): TgConfig {
  try {
    const c = JSON.parse(fs.readFileSync(tgConfigPath(), "utf8"));
    return c && typeof c === "object" ? c : {};
  } catch {
    return {};
  }
}
export function writeTg(c: TgConfig, changed = true) {
  if (changed) c = { ...c, at: Date.now() };
  const file = tgConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export const TG_TOKEN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
/** One call to the bot API. Failures say what went wrong in words, never with the address, which holds the token. */
export async function tgCall(token: string, method: string, params: Record<string, unknown> | FormData = {}, timeoutMs = 15_000): Promise<{ ok: boolean; result?: any; error?: string }> {
  try {
    const form = params instanceof FormData;
    const r = await fetch(`${tgApiBase()}/bot${token}/${method}`, { method: "POST", headers: form ? {} : { "content-type": "application/json" }, body: form ? params : JSON.stringify(params), signal: AbortSignal.timeout(timeoutMs) });
    const j: any = await r.json().catch(() => ({}));
    if (j?.ok) return { ok: true, result: j.result };
    return { ok: false, error: r.status === 401 || r.status === 404 ? "Telegram does not know that token" : r.status === 409 ? "another program is reading this bot" : `Telegram said ${typeof j?.description === "string" ? safeLine(j.description).slice(0, 80) : r.status}` };
  } catch {
    return { ok: false, error: "could not reach Telegram" };
  }
}

/** Which session each message we sent is about, so a reply to it reaches that session. Kept on disk so a reply works after a restart, or from the fleet that takes over. */
const tgSentPath = () => path.join(path.dirname(tgConfigPath()), "telegram-sent.json");
const tgSent = new Map<number, string>();
function loadTgSent() {
  try {
    for (const [id, sid] of JSON.parse(fs.readFileSync(tgSentPath(), "utf8"))) tgSent.set(Number(id), String(sid));
  } catch {}
}
function rememberTg(id: number, sid: string) {
  tgSent.set(id, sid);
  while (tgSent.size > 500) tgSent.delete(tgSent.keys().next().value!);
  try {
    fs.writeFileSync(tgSentPath(), JSON.stringify([...tgSent]), { mode: 0o600 });
  } catch {}
}

export const tg = {
  on: false, // this fleet is the one talking to the bot
  status: "", // the latest problem, in words, for the t screen
  entry: undefined as string | undefined, // the token being typed or pasted on the t screen
  getSessions: (() => []) as () => Session[],
  paired: false, // read from the file on each scan, for the button
  was: { ready: false, pr: new Map<string, string>() },
};
/** Send `text` to the paired chat; when it is about a session, a reply to it goes to that session. */
export async function tgSay(text: string, sid?: string, asking = false, kind?: "ask" | "stall"): Promise<boolean> {
  const c = readTg();
  if (!c.token || !c.chat) return false;
  // A question carries a Reply button; it is taken off again once the session stops waiting.
  const markup = sid ? { reply_markup: { inline_keyboard: [[...(asking ? [{ text: "↩ Reply", callback_data: "reply" }, { text: "📺 Screen", callback_data: `w:${sid}` }] : []), { text: "ℹ️ Details", callback_data: `d:${sid}` }, { text: "🔕 Mute", callback_data: `z:${sid}` }]] } } : {};
  const r = await tgCall(c.token, "sendMessage", { chat_id: c.chat, text: text.slice(0, 4000), disable_web_page_preview: true, ...markup });
  if (!r.ok) tg.status = r.error ?? "";
  if (r.ok && sid && typeof r.result?.message_id === "number") {
    rememberTg(r.result.message_id, sid);
    if (kind) tgNoteStatus(sid, kind, r.result.message_id);
  }
  return r.ok;
}
// "Needs you" and "looks stuck" are states, not news: each message is deleted once its session is no longer
// in that state, and a new question replaces the last. Kept on disk so a restart still tidies them.
type TgStatus = { sid: string; kind: "ask" | "stall"; id: number };
const tgStatusPath = () => path.join(path.dirname(tgConfigPath()), "telegram-status.json");
function tgStatusRead(): TgStatus[] {
  try {
    const j = JSON.parse(fs.readFileSync(tgStatusPath(), "utf8"));
    return Array.isArray(j) ? j.filter((x) => typeof x?.sid === "string" && typeof x?.id === "number" && (x.kind === "ask" || x.kind === "stall")) : [];
  } catch {
    return [];
  }
}
function tgStatusWrite(list: TgStatus[]) {
  try {
    fs.mkdirSync(path.dirname(tgStatusPath()), { recursive: true });
    fs.writeFileSync(tgStatusPath(), JSON.stringify(list.slice(-200)), { mode: 0o600 });
  } catch {}
}
function tgNoteStatus(sid: string, kind: TgStatus["kind"], id: number) {
  const c = readTg();
  const list = tgStatusRead();
  // The session's earlier message of the same kind is out of date now.
  for (const old of list.filter((x) => x.sid === sid && x.kind === kind)) if (c.token && c.chat) void tgCall(c.token, "deleteMessage", { chat_id: c.chat, message_id: old.id });
  tgStatusWrite([...list.filter((x) => !(x.sid === sid && x.kind === kind)), { sid, kind, id }]);
}
/** Delete the "needs you" and "looks stuck" messages that are no longer so. */
export function tgSettle(waiting: Set<string>, stuck: Set<string> = new Set()) {
  const c = readTg();
  if (!c.token || !c.chat) return;
  const list = tgStatusRead();
  const keep = list.filter((x) => (x.kind === "ask" ? waiting : stuck).has(x.sid));
  if (keep.length === list.length) return;
  for (const x of list) if (!keep.includes(x)) void tgCall(c.token, "deleteMessage", { chat_id: c.chat, message_id: x.id });
  tgStatusWrite(keep);
}
const tgName = (s: Session) => (s.name || path.basename(s.cwd)) + (machineOf(s) ? ` (${machineOf(s)})` : "");
/** The session you last wrote to from Telegram, and when: plain words follow it for half an hour. */
let tgLastTo: { sid: string; at: number } | undefined;
const TG_TALK_MS = 30 * 60_000;
/** What fleet does with a message from Telegram: pairing, a reply to a session, or a short status. */
export async function tgHandle(update: any): Promise<void> {
  const q = update?.callback_query;
  if (q && typeof q.id === "string") {
    const c = readTg();
    if (!c.token || !c.chat || q.message?.chat?.id !== c.chat || (c.user && q.from?.id !== c.user)) return;
    await tgButton(c, q);
    return;
  }
  const m = update?.message;
  if (!m || typeof m.text !== "string" || typeof m.chat?.id !== "number") return;
  const c = readTg();
  if (!c.token) return;
  const say = (text: string) => tgCall(c.token!, "sendMessage", { chat_id: m.chat.id, text, reply_to_message_id: m.message_id });
  if (!c.chat) {
    // Only the chat that opens the pairing link (which carries the one-time code) is paired; anyone else is ignored.
    if (c.pairCode && m.chat.type === "private" && m.text.trim() === `/start ${c.pairCode}`) {
      writeTg({ ...c, chat: m.chat.id, user: m.from?.id, pairCode: undefined });
      await say("Paired with Claude Fleet ✓\n\nI'll message you when a session needs you, looks stuck, or a pull request changes. Reply to one of my messages to answer that session.\n\n/status shows everything, with a button for each session.");
    }
    return;
  }
  if (m.chat.id !== c.chat || (c.user && m.from?.id !== c.user)) return;
  const text = m.text.trim();
  // Where it goes: the session of the message it replies to; or, for plain words (not a /command) with no reply,
  // the session you last wrote to, within half an hour, so a second message needs no reply to find.
  const replied = typeof m.reply_to_message?.message_id === "number" ? tgSent.get(m.reply_to_message.message_id) : undefined;
  const target = replied ?? (!text.startsWith("/") && tgLastTo && Date.now() - tgLastTo.at < TG_TALK_MS ? tgLastTo.sid : undefined);
  if (target) {
    const s = tg.getSessions().find((x) => x.sid === target);
    if (!s) return void (await say("That session has finished, so I can't send to it."));
    const r = await (web.send ?? sendToSession)(s, text, (late) => void say(late.ok ? `✓ delivered to ${tgName(s)}` : `✗ could not deliver to ${tgName(s)}: ${late.error}`));
    const ack = await say(r.queued ? `⏳ ${tgName(s)} can't take it this second: queued, and I'll say when it's delivered` : r.ok ? `✓ sent to ${tgName(s)}` : `✗ not sent: ${r.error}`);
    // Your message and the receipt belong to the session too, so a reply to either reaches it.
    rememberTg(m.message_id, s.sid);
    if (typeof ack.result?.message_id === "number") rememberTg(ack.result.message_id, s.sid);
    if (r.ok) {
      tgLastTo = { sid: s.sid, at: Date.now() };
      tgExpire(ack.result?.message_id);
    }
    return;
  }
  const cmd = text.split(/[\s@]/)[0].toLowerCase().replace(/^\//, "");
  const arg = text.replace(/^\S+\s*/, "").trim();
  tgExpire(m.message_id); // the command goes with what it asked for
  if (cmd === "status" || cmd === "start") return void (await tgSend(c, tgOverview(), undefined, true));
  if (cmd === "menu") return void (await tgSend(c, { text: "◆ <b>Claude Fleet</b> — what would you like to see?", markup: tgMenuMarkup() }, undefined, true));
  if (sectionKeys.has(cmd)) return void (await tgSend(c, tgSection(cmd, arg), undefined, true));
  if (cmd === "usage") return void (await tgUsage(c));
  if (cmd === "live") return void (await tgLive(c, arg));
  if (cmd === "new") return void (await tgSend(c, tgNew(c, arg), undefined, true));
  if (cmd === "digest") {
    if (!arg) return void (await tgSend(c, { text: tgDigest(Math.min(readTg().digest?.last || Infinity, clock() - 16 * 3600_000)) }, undefined, true));
    const at = arg.toLowerCase() === "off" ? "off" : minutesOf(arg) !== undefined ? arg.padStart(5, "0") : undefined;
    if (!at) return void (await tgSend(c, { text: "Say a time, like <code>/digest 7:30</code>, or <code>/digest off</code>." }));
    writeTg({ ...readTg(), digest: { at, last: readTg().digest?.last } });
    return void (await tgSend(c, { text: at === "off" ? "No morning digest." : `The digest comes at ${at} each day.` }));
  }
  if (cmd === "quiet") {
    if (!arg) return void (await tgSend(c, { text: readTg().quiet ? `Quiet hours ${readTg().quiet!.from}–${readTg().quiet!.to}: only “needs you” comes through; the rest waits for the digest. <code>/quiet off</code> to end them.` : "No quiet hours. <code>/quiet 23:00-07:00</code> holds everything but “needs you” overnight." }));
    if (arg.toLowerCase() === "off") {
      writeTg({ ...readTg(), quiet: undefined });
      return void (await tgSend(c, { text: "Quiet hours off." }));
    }
    const m = /^(\d{1,2}:?\d{2})\s*[-–to ]+\s*(\d{1,2}:?\d{2})$/.exec(arg);
    if (!m || minutesOf(m[1]) === undefined || minutesOf(m[2]) === undefined) return void (await tgSend(c, { text: "Say it like <code>/quiet 23:00-07:00</code>." }));
    writeTg({ ...readTg(), quiet: { from: m[1], to: m[2] } });
    return void (await tgSend(c, { text: `Quiet from ${m[1]} to ${m[2]}: only “needs you” comes through; the rest waits for the digest.` }));
  }
  if (cmd === "screen") {
    const s = arg ? tg.getSessions().find((x) => x.name.toLowerCase().includes(arg.toLowerCase())) : undefined;
    return void (await tgPicture(c, s?.sid));
  }
  if (cmd === "session" && arg) {
    const s = tg.getSessions().find((x) => x.name.toLowerCase().includes(arg.toLowerCase()));
    return void (await tgSend(c, (s && tgCard(s.sid)) || { text: `No session called “${esc(arg)}”.` }, s?.sid, true));
  }
  await tgSend(c, { text: TG_HELP }, undefined, true);
}
export const TG_COMMANDS = [
  { command: "status", description: "every machine and session, a button for each" },
  { command: "menu", description: "everything, a section at a time" },
  ...[
    { key: "needs", about: "what is waiting on you" },
    { key: "tasks", about: "task lists (add a session name to narrow it)" },
    { key: "agents", about: "the agents at work" },
    { key: "workflows", about: "workflows and their phases" },
    { key: "prs", about: "pull requests, CI and deploys" },
    { key: "fails", about: "tool calls that failed" },
    { key: "bg", about: "background commands running" },
    { key: "changes", about: "files changed and git state" },
    { key: "context", about: "context used and when it fills" },
    { key: "activity", about: "tool calls over the window" },
    { key: "machines", about: "each machine's load" },
  ].map((x) => ({ command: x.key, description: x.about })),
  { command: "session", description: "everything about one session: /session <name>" },
  { command: "new", description: "start a session: /new <what to do>, then pick where" },
  { command: "live", description: "pin a picture of the fleet that redraws itself (/live text for words)" },
  { command: "digest", description: "what happened lately; /digest 7:30 sets the morning time" },
  { command: "quiet", description: "quiet hours: /quiet 23:00-07:00, or off" },
  { command: "usage", description: "your Claude usage on each machine" },
  { command: "screen", description: "a picture of the fleet, or /screen <session>" },
  { command: "help", description: "what I can do" },
];
const TG_HELP = TG_COMMANDS.map((x) => `/${x.command} — ${x.description}`).join("\n") + "\n\nReply to any of my messages to send your reply to that session; after that, just type, and it goes to the same session for half an hour. Menus and pictures tidy themselves away after ten minutes.";

type TgView = { text: string; markup?: unknown };
// Everything the detail view shows, a section at a time: as commands, and as a menu that changes in place.
export const TG_SECTIONS: { key: string; label: string; about: string }[] = [
  { key: "needs", label: "🟡 Needs you", about: "what is waiting on you" },
  { key: "tasks", label: "📋 Tasks", about: "every session's task list" },
  { key: "agents", label: "🤖 Agents", about: "the agents at work" },
  { key: "workflows", label: "≡ Workflows", about: "workflows and their phases" },
  { key: "prs", label: "⇡ PRs", about: "pull requests, CI and deploys" },
  { key: "fails", label: "✗ Failures", about: "tool calls that failed" },
  { key: "bg", label: "↻ Background", about: "background commands running" },
  { key: "changes", label: "± Changes", about: "files changed and git state" },
  { key: "context", label: "🧠 Context", about: "context used and when it fills" },
  { key: "activity", label: "🔧 Activity", about: "tool calls over the window" },
  { key: "machines", label: "💻 Machines", about: "each machine's load" },
];
const sectionKeys = new Set(TG_SECTIONS.map((x) => x.key));
/** The menu: a button for each section, the sessions, a picture and usage. */
function tgMenuMarkup(current?: string) {
  const btn = (x: { key: string; label: string }) => ({ text: (x.key === current ? "• " : "") + x.label, callback_data: `v:${x.key}` });
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < TG_SECTIONS.length; i += 3) rows.push(TG_SECTIONS.slice(i, i + 3).map(btn));
  rows.push([{ text: "◆ Sessions", callback_data: "L" }, { text: "🖼 Picture", callback_data: "P" }, { text: "📊 Usage", callback_data: "U" }]);
  return { inline_keyboard: rows };
}
/** One section across every session (or those whose name has `filter` in it). */
export function tgSection(key: string, filter = "", now = clock()): TgView {
  const st = webState(tg.getSessions(), now);
  const f = filter.toLowerCase();
  const list = st.sessions.filter((s) => !f || s.name.toLowerCase().includes(f) || s.place.toLowerCase().includes(f));
  const head = (s: WebSession) => `${STATE_EMOJI[s.state] ?? "•"} <b>${esc(s.name)}</b>${s.place ? ` <i>${esc(s.place)}</i>` : ""}`;
  const sec = TG_SECTIONS.find((x) => x.key === key)!;
  const out: string[] = [`<b>${esc(sec.label)}</b>${f ? ` · “${esc(filter)}”` : ""}`];
  const block = (s: WebSession, rows: string[]) => rows.length && out.push("", head(s), ...rows);
  for (const s of list) {
    if (key === "needs" && s.needs) block(s, [`❓ ${esc(capText(flatReply(s.needs), 900))}`]);
    if (key === "tasks" && s.tasks?.total) block(s, [`${s.tasks.done}/${s.tasks.total} done`, ...s.tasks.open.slice(0, 12).map((t) => `${t.status === "in_progress" ? "◐" : "○"} ${esc(capText(t.text, 110))}${t.since ? " · " + t.since : ""}${t.blocked ? " · blocked" : ""}`)]);
    if (key === "agents" && s.agents.length) block(s, s.agents.slice(0, 12).map((a) => `• ${esc(capText(a.label, 60))} — ${esc(capText(a.doing, 80))} · ${a.ago}`));
    if (key === "workflows" && s.workflows.length) block(s, s.workflows.map((w) => `≡ ${esc(w.name)} · ${esc(w.phase)} · ${w.done}/${w.total} agents`));
    if (key === "prs" && s.prs.length) block(s, s.prs.map((p) => `⇡ ${esc(segText(p))}`));
    if (key === "fails" && s.fails) block(s, [`✗ ${s.fails.n} failed · ${esc(capText(s.fails.last, 300))} · ${s.fails.ago}`]);
    if (key === "bg" && s.bg.length) block(s, s.bg.map((b) => `↻ ${esc(capText(b.desc, 140))} · ${b.ago}`));
    if (key === "changes" && s.changes) block(s, [`± ${esc(segText(s.changes))}`]);
    if (key === "context" && s.ctx) block(s, [`${bar10(s.ctx.pct)} ${s.ctx.pct}% of ${s.ctx.max}${s.ctx.runway ? " · " + esc(s.ctx.runway) : ""}`, ...(s.ctx.split.length ? [s.ctx.split.map((p) => `${esc(p.name)} ${human(p.tokens)}`).join(" · ")] : [])]);
    if (key === "activity") block(s, [`<code>${esc(sparkText(s.spark, 30)) || " "}</code> ${s.tools} tool calls / ${opt.windowMin}m`]);
  }
  if (key === "machines") {
    out.push("", `💻 <b>${esc(selfHost())}</b>${peers.size ? " (this one)" : ""} · cpu ${st.machine.cpu}% · mem ${st.machine.mem}% (${esc(st.machine.memText)}) · load ${st.machine.load}`);
    for (const p of peers.values()) if (p.at && now - p.at <= PEER_GONE_MS) out.push(`💻 <b>${esc(p.host)}</b> · ${p.sessions.length} session${p.sessions.length === 1 ? "" : "s"}${p.machine ? ` · cpu ${p.machine.cpu}% · mem ${p.machine.mem}%` : ""}`);
  }
  if (out.length === 1) out.push("", "Nothing here right now.");
  let text = out.join("\n");
  if (text.length > 4000) text = text.slice(0, 3990) + "…";
  return { text, markup: tgMenuMarkup(key) };
}

// Menus, views and pictures tidy themselves away: each is deleted ten minutes after it was last used, with the
// command that asked for it; a confirmation goes after a minute. Notifications stay.
const TG_KEEP_MS = 10 * 60_000;
const tgTemp = new Map<number, number>(); // message id → when to delete it
export const tgExpire = (id: unknown, ms = TG_KEEP_MS) => typeof id === "number" && tgTemp.set(id, Date.now() + ms);
/** Delete the messages whose time is up; called on every scan by the fleet talking to the bot. */
export function tgSweep(now = Date.now()) {
  const c = readTg();
  if (!c.token || !c.chat) return;
  for (const [id, at] of tgTemp)
    if (at <= now) {
      tgTemp.delete(id);
      void tgCall(c.token, "deleteMessage", { chat_id: c.chat, message_id: id });
    }
}


const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const STATE_EMOJI: Record<string, string> = { needs: "🟡", stalled: "⏳", working: "🟢", justDone: "✅", yourTurn: "🔵", idle: "⚪", finished: "✅" };
const BLOCKS = "▁▂▃▄▅▆▇█";
/** A sparkline in text, `n` wide. */
export function sparkText(values: number[], n = 24): string {
  if (!values.length) return "";
  const step = values.length / n;
  const cols = Array.from({ length: n }, (_, i) => sum(values.slice(Math.floor(i * step), Math.floor((i + 1) * step))));
  const max = Math.max(1, ...cols);
  return cols.map((v) => (v ? BLOCKS[Math.min(7, Math.floor((v / max) * 7.999))] : " ")).join("").replace(/\s+$/, "");
}
const bar10 = (pct: number) => "▰".repeat(Math.round(Math.min(100, pct) / 10)) + "▱".repeat(10 - Math.round(Math.min(100, pct) / 10));
const segText = (segs: { t: string }[]) => segs.map((x) => x.t).join("");
type WebSession = ReturnType<typeof webState>["sessions"][number];

/** /status: every machine, the counts, usage at a glance, and a button for each session. */
export function tgOverview(now = clock()): TgView {
  const st = webState(tg.getSessions(), now);
  const c = st.counts;
  const lines = [`◆ <b>Claude Fleet</b> · ${new Date(now).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`, ""];
  const machines = [{ host: selfHost(), here: true, cpu: st.machine.cpu, mem: st.machine.mem, n: tg.getSessions().filter((s) => !s.remote).length }, ...[...peers.values()].filter((p) => p.at && now - p.at <= PEER_GONE_MS).map((p) => ({ host: p.host, here: false, cpu: p.machine?.cpu, mem: p.machine?.mem, n: p.sessions.length }))];
  for (const m of machines) lines.push(`💻 <b>${esc(m.host)}</b>${m.here && machines.length > 1 ? " (this one)" : ""} · ${m.n} session${m.n === 1 ? "" : "s"}${m.cpu !== undefined ? ` · cpu ${m.cpu}% · mem ${m.mem}%` : ""}`);
  lines.push("");
  const counts = [c.needs && `🟡 ${c.needs} need${c.needs === 1 ? "s" : ""} you`, c.stalled && `⏳ ${c.stalled} stuck`, c.working && `🟢 ${c.working} working`, c.agents && `🤖 ${c.agents} agent${c.agents === 1 ? "" : "s"}`, c.workflows && `≡ ${c.workflows} workflow${c.workflows === 1 ? "" : "s"}`].filter(Boolean);
  lines.push(counts.length ? counts.join(" · ") : "Nothing working and nothing waiting on you.");
  const usage = [...(st.account?.limits.length ? [{ host: selfHost(), limits: st.account.limits }] : []), ...[...peers.values()].filter((p) => p.usage?.length).map((p) => ({ host: p.host, limits: p.usage! }))];
  if (usage.length) lines.push("", ...usage.map((u) => `📊 ${machines.length > 1 ? esc(u.host) + ": " : ""}${u.limits.map((l) => `${esc(l.label)} ${l.pct}%`).join(" · ")}`));
  if (st.hidden) lines.push("", `<i>${st.hidden} idle or finished not shown</i>`);
  const order = ["needs", "stalled", "working", "justDone", "yourTurn", "idle", "finished"];
  const rows = [...st.sessions]
    .sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state))
    .slice(0, 24)
    .map((s) => [{ text: `${STATE_EMOJI[s.state] ?? "•"} ${s.name}${machines.length > 1 ? ` · ${tg.getSessions().find((x) => x.sid === s.sid)?.remote?.host ?? selfHost()}` : ""}`.slice(0, 60), callback_data: `s:${s.sid}` }]);
  rows.push([{ text: "☰ Menu", callback_data: "v:needs" }, { text: "🖼 Picture", callback_data: "P" }, { text: "📊 Usage", callback_data: "U" }, { text: "🔄", callback_data: "L" }]);
  return { text: lines.join("\n"), markup: { inline_keyboard: rows } };
}

/** Everything about one session, with what you can do about it. */
export function tgCard(sid: string, now = clock()): TgView | undefined {
  const s = webState(tg.getSessions(), now).sessions.find((x) => x.sid === sid);
  if (!s) return undefined;
  const lines = [`${STATE_EMOJI[s.state] ?? "•"} <b>${esc(s.name)}</b> — ${esc(s.word)}${s.time ? " · " + esc(s.time) : ""}`];
  if (s.place) lines.push(`📁 ${esc(s.place)}`);
  lines.push("");
  if (s.needs) lines.push(`❓ <b>${esc(capText(flatReply(s.needs), 900))}</b>`, "");
  else if (s.sub.text) lines.push(`${s.sub.source === "prompt" ? "▸" : "◆"} ${esc(capText(s.sub.text, 400))}`, "");
  if (s.party) lines.push(`🎉 ${esc(s.party)}`);
  if (s.ctx) lines.push(`🧠 context ${s.ctx.pct}% of ${s.ctx.max} ${bar10(s.ctx.pct)}${s.ctx.runway ? " · " + esc(s.ctx.runway) : ""}`);
  if (s.tools) lines.push(`🔧 ${s.tools} tool calls / ${opt.windowMin}m <code>${esc(sparkText(s.spark))}</code>`);
  for (const w of s.workflows) lines.push(`≡ ${esc(w.name)} · ${esc(w.phase)} · ${w.done}/${w.total} agents`);
  for (const p of s.prs) lines.push(`⇡ ${esc(segText(p))}`);
  if (s.fails) lines.push(`✗ ${s.fails.n} failed · ${esc(capText(s.fails.last, 160))} · ${s.fails.ago}`);
  for (const b of s.bg) lines.push(`↻ ${esc(capText(b.desc, 120))} · ${b.ago}`);
  if (s.changes) lines.push(`± ${esc(segText(s.changes))}`);
  if (s.tasks?.total) {
    lines.push("", `📋 <b>tasks ${s.tasks.done}/${s.tasks.total}</b>`);
    for (const t of s.tasks.open.slice(0, 8)) lines.push(`${t.status === "in_progress" ? "◐" : "○"} ${esc(capText(t.text, 120))}${t.since ? " · " + t.since : ""}${t.blocked ? " · blocked" : ""}`);
    if (s.tasks.open.length > 8) lines.push(`… and ${s.tasks.open.length - 8} more`);
  }
  if (s.agents.length) {
    lines.push("", `🤖 <b>${s.agents.length} agent${s.agents.length === 1 ? "" : "s"}</b>`);
    for (const a of s.agents.slice(0, 6)) lines.push(`• ${esc(capText(a.label, 60))} — ${esc(capText(a.doing, 80))} · ${a.ago}`);
    if (s.agents.length > 6) lines.push(`… and ${s.agents.length - 6} more`);
  }
  const said = s.talk.filter((t) => t.who === "claude").at(-1);
  if (said && !s.needs) lines.push("", `💬 ${esc(capText(said.text, 700))} <i>${said.ago}</i>`);
  const muted = (readTg().muted?.[sid] ?? 0) > Date.now();
  const markup = {
    inline_keyboard: [
      [{ text: s.state === "needs" ? "↩ Answer" : "✍️ Message", callback_data: `r:${sid}` }, { text: "🖼 Picture", callback_data: `p:${sid}` }, { text: "💬 Chat", callback_data: `m:${sid}` }],
      [{ text: "📺 Screen", callback_data: `w:${sid}` }, { text: "⎋ Interrupt", callback_data: `i:${sid}` }, { text: muted ? "🔔 Unmute" : "🔕 Mute 24h", callback_data: `z:${sid}` }],
      [{ text: "🔄 Refresh", callback_data: `x:${sid}` }, { text: "⬅ All", callback_data: "L" }],
    ],
  };
  let text = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  if (text.length > 4000) text = text.slice(0, 3990) + "…";
  return { text, markup };
}

/** Send a view as a new message. */
async function tgSend(c: TgConfig, v: TgView, sid?: string, temporary = true) {
  const r = await tgCall(c.token!, "sendMessage", { chat_id: c.chat, text: v.text, parse_mode: "HTML", disable_web_page_preview: true, ...(v.markup ? { reply_markup: v.markup } : {}) });
  if (r.ok && sid && typeof r.result?.message_id === "number") rememberTg(r.result.message_id, sid);
  if (r.ok && temporary) tgExpire(r.result?.message_id);
  return r;
}
/** Show a view in place of the message a button was on, so the chat does not fill up with menus. */
async function tgEdit(c: TgConfig, messageId: number, v: TgView) {
  if (messageId === readTg().live?.id) return void (await tgSend(c, v)); // the pinned overview stays an overview
  const r = await tgCall(c.token!, "editMessageText", { chat_id: c.chat, message_id: messageId, text: v.text, parse_mode: "HTML", disable_web_page_preview: true, ...(v.markup ? { reply_markup: v.markup } : {}) });
  // A notification's text cannot always be edited into a menu (or nothing changed): then send it new.
  if (!r.ok && !/not modified/i.test(r.error ?? "")) await tgSend(c, v);
  else if (tgTemp.has(messageId)) tgExpire(messageId); // in use: its ten minutes start again
}
/** /usage: each machine's Claude account, as bars, and this machine's gauges as a picture. */
async function tgUsage(c: TgConfig) {
  const now = clock();
  const st = webState(tg.getSessions(), now);
  const blocks = [...(st.account ? [{ host: selfHost(), limits: st.account.limits, reason: st.account.reason }] : []), ...[...peers.values()].filter((p) => p.at && p.usage).map((p) => ({ host: p.host, limits: p.usage!, reason: undefined }))];
  const lines = ["📊 <b>Claude usage</b>"];
  for (const b of blocks) {
    lines.push("", `<b>${esc(b.host)}</b>`);
    if (!b.limits.length) lines.push(`<i>${esc(b.reason || "no figures")}</i>`);
    for (const l of b.limits) lines.push(`<code>${esc(l.label.padEnd(8))} ${bar10(l.pct)} ${String(l.pct).padStart(3)}%</code>${l.resets ? " · " + esc(l.resets) : ""}`);
  }
  if (!blocks.length) lines.push("", "No usage figures: fleet reads them only where usage is on.");
  await tgSend(c, { text: lines.join("\n") });
  await tgPhotoSend(c, headerPicture(now), `${selfHost()}: machine, usage and activity`);
}
/** A picture of the fleet, or of one session. */
async function tgPicture(c: TgConfig, sid?: string) {
  const sessions = tg.getSessions();
  const s = sid ? sessions.find((x) => x.sid === sid) : undefined;
  if (sid && !s) return void (await tgSend(c, { text: "That session has finished." }));
  await tgPhotoSend(c, fleetPicture(sessions, clock(), sid), s ? tgName(s) : "Claude Fleet", sid);
}
async function tgPhotoSend(c: TgConfig, png: Buffer, caption: string, sid?: string, markup?: unknown) {
  const form = new FormData();
  form.append("chat_id", String(c.chat));
  form.append("caption", caption.slice(0, 1000));
  if (markup) form.append("reply_markup", JSON.stringify(markup));
  form.append("photo", new Blob([png], { type: "image/png" }), "fleet.png");
  const r = await tgCall(c.token!, "sendPhoto", form, 60_000);
  if (r.ok && sid && typeof r.result?.message_id === "number") rememberTg(r.result.message_id, sid);
  if (r.ok) tgExpire(r.result?.message_id);
  if (!r.ok) tg.status = r.error ?? "";
}
/** A button was tapped. */
async function tgButton(c: TgConfig, q: any) {
  const data = typeof q.data === "string" ? q.data : "";
  const msgId = q.message?.message_id;
  const [act, sid = typeof msgId === "number" ? tgSent.get(msgId) ?? "" : "", extra = ""] = data === "reply" ? ["r"] : data.split(":");
  if (act === "n") {
    await tgCall(c.token!, "answerCallbackQuery", { callback_query_id: q.id });
    return tgNewPick(c, msgId, sid, extra);
  }
  if (act === "pair") {
    // A pairing request from the glasses app: here sid is the request's id, and extra y or n.
    const ok = pairDecide(sid, extra === "y");
    await tgCall(c.token!, "answerCallbackQuery", { callback_query_id: q.id, text: ok ? (extra === "y" ? "✓ Glasses connected" : "Refused") : "That request has gone" });
    if (typeof msgId === "number") await tgCall(c.token!, "editMessageText", { chat_id: c.chat, message_id: msgId, text: ok ? (extra === "y" ? "👓 Glasses connected to Claude Fleet." : "👓 Glasses refused.") : "👓 That pairing request had gone." });
    return;
  }
  const session = sid ? tg.getSessions().find((x) => x.sid === sid) : undefined;
  const gone = !!sid && !session && act !== "L" && act !== "v";
  if (act === "k" && session) {
    // A key pressed in the session, as you would at its terminal: a numbered choice, Enter or Esc.
    const r = await (web.keys ?? keysToSession)(session, extra);
    await tgCall(c.token!, "answerCallbackQuery", { callback_query_id: q.id, text: r.ok ? `✓ pressed ${extra === "X" ? "Esc" : extra === "E" ? "Enter" : extra} in ${tgName(session)}` : `✗ ${r.error}`.slice(0, 190) });
    return;
  }
  if (act === "I" && session) {
    const r = await (web.keys ?? keysToSession)(session, "X");
    await tgCall(c.token!, "answerCallbackQuery", { callback_query_id: q.id, text: r.ok ? `⎋ interrupted ${tgName(session)}` : `✗ ${r.error}`.slice(0, 190) });
    return tgEdit(c, msgId, tgCard(sid) ?? { text: "That session has finished." });
  }
  await tgCall(c.token!, "answerCallbackQuery", { callback_query_id: q.id, text: gone ? "That session has finished." : act === "p" || act === "P" ? "Drawing…" : undefined });
  if (gone) return;
  if (act === "L") return tgEdit(c, msgId, tgOverview());
  if (act === "v" && sectionKeys.has(sid)) return tgEdit(c, msgId, tgSection(sid));
  if (act === "s" || act === "x") return tgEdit(c, msgId, tgCard(sid) ?? { text: "That session has finished." });
  if (act === "d") return void (await tgSend(c, tgCard(sid) ?? { text: "That session has finished." }));
  if (act === "P") return tgPicture(c);
  if (act === "p") return tgPicture(c, sid);
  if (act === "U") return tgUsage(c);
  if (act === "w") return tgPeek(c, session!);
  if (act === "i") {
    // Esc stops what it is doing: asked once more, on the same message.
    return void (await tgCall(c.token!, "editMessageReplyMarkup", { chat_id: c.chat, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: `⎋ Yes, interrupt ${tgName(session!)}`.slice(0, 60), callback_data: `I:${sid}` }, { text: "Cancel", callback_data: `x:${sid}` }]] } }));
  }
  if (act === "m") {
    const s = webState(tg.getSessions(), clock()).sessions.find((x) => x.sid === sid);
    const talk = s?.talk ?? [];
    const text = talk.length ? talk.map((t) => `${t.who === "you" ? "▸ <b>you</b>" : "◆ <b>claude</b>"} <i>${t.ago}</i>\n${esc(capText(t.text, 1200))}`).join("\n\n") : "Nothing said yet.";
    return void (await tgSend(c, { text: `💬 <b>${esc(tgName(session!))}</b>\n\n${text}`.slice(0, 4000) }, sid));
  }
  if (act === "z") {
    const now = Date.now();
    const muted = { ...(readTg().muted ?? {}) };
    for (const [k, until] of Object.entries(muted)) if (until <= now) delete muted[k];
    if ((muted[sid] ?? 0) > now) delete muted[sid];
    else muted[sid] = now + 24 * 3600_000;
    writeTg({ ...readTg(), muted });
    return tgEdit(c, msgId, tgCard(sid) ?? { text: "That session has finished." });
  }
  if (act === "r") {
    // Telegram's own reply box, opened on whichever device was tapped; the answer is a reply to this prompt.
    const r = await tgCall(c.token!, "sendMessage", { chat_id: c.chat, text: `✍️ Your ${factsOf(session!).needs ? "answer" : "message"} to ${tgName(session!)}:`, reply_markup: { force_reply: true, input_field_placeholder: `to ${tgName(session!)}…`.slice(0, 64) } });
    if (r.ok && typeof r.result?.message_id === "number") rememberTg(r.result.message_id, session!.sid);
    tgExpire(r.result?.message_id);
  }
}

let tgPolling = false;
/** Read the bot's messages for as long as this fleet is the one talking to it. */
async function tgPoll() {
  if (tgPolling) return;
  tgPolling = true;
  let offset = 0;
  const first = readTg();
  if (first.token) void tgCall(first.token, "setMyCommands", { commands: TG_COMMANDS }); // the menu Telegram shows by the message box
  try {
    while (tg.on) {
      const c = readTg();
      if (!c.token) break;
      const r = await tgCall(c.token, "getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, 35_000);
      if (!r.ok) {
        tg.status = r.error ?? "";
        await new Promise((res) => setTimeout(res, 10_000));
        continue;
      }
      tg.status = "";
      for (const u of r.result ?? []) {
        offset = Math.max(offset, u.update_id + 1);
        const a = performance.now();
        await tgHandle(u).catch(() => {});
        noteSlow(`a Telegram ${u.callback_query ? "button" : "message"} (${String(u.message?.text ?? u.callback_query?.data ?? "").split(/\s/)[0].slice(0, 20)})`, performance.now() - a);
      }
    }
  } finally {
    tgPolling = false;
  }
}
/** Only one fleet talks to the bot (Telegram allows one reader): the one holding the lock, taken over when it quits. */
const tgLockPath = () => path.join(path.dirname(tgConfigPath()), "telegram.lock");
export function tgClaim(): boolean {
  if (serviceRunning()) {
    // The background service talks to the bot; a window that had it lets go.
    if (tg.on) tgRelease();
    return (tg.on = false);
  }
  if (!readTg().token) return (tg.on = false);
  if (!tgLeader(tailnet.ip, [...peers.values()])) return (tg.on = false); // another machine's fleet talks to the bot
  const file = tgLockPath();
  try {
    const pid = Number(fs.readFileSync(file, "utf8"));
    if (pid && pid !== process.pid && alive(pid)) return (tg.on = false);
  } catch {}
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(process.pid));
    if (!tg.on) {
      tg.on = true;
      loadTgSent();
      void tgPoll();
    }
  } catch {
    tg.on = false;
  }
  return tg.on;
}
export function tgRelease() {
  try {
    if (Number(fs.readFileSync(tgLockPath(), "utf8")) === process.pid) fs.unlinkSync(tgLockPath());
  } catch {}
}
/**
 * A pull request's state, in the few words a message needs: "failing", "green", "merged", "live on staging", or ""
 * when it is not known yet (GitHub or the deploy check has not answered since launch), which is never news.
 */
function prWord(pr: PrLink, cwd: string): string {
  const st = prState.get(`${pr.repo}#${pr.number}`)?.state;
  if (!st) return "";
  if (st.state === "MERGED") {
    const d = deploys().find((x) => x.repo === pr.repo);
    if (!d || !st.mergeSha) return "merged";
    const live = mergeLive(st.mergeSha, deployState.get(d.url)?.revision, cwd, pr.repo);
    return live === undefined ? "" : live ? `live on ${d.name}` : "merged";
  }
  return st.state !== "OPEN" ? "" : st.fail ? "failing" : !st.pending && st.pass ? "green" : "";
}
/** The messages for what changed in this scan. Called with what the bell rang for, so both agree on what is new. */
export function tgEvents(sessions: Session[], asked: string[], stalled: string[], now = Date.now()): [text: string, sid: string, asking: boolean, key: string][] {
  const out: [string, string, boolean, string][] = [];
  const bySid = new Map(sessions.map((s) => [s.sid, s]));
  for (const sid of asked) {
    const s = bySid.get(sid);
    const q = s && factsOf(s).needs;
    if (s) out.push([`🟡 ${tgName(s)} needs you${q ? `\n\n${capText(flatReply(q), 1500)}` : ""}`, sid, true, `ask:${sid}:${Bun.hash(q || "").toString(36)}`]);
  }
  for (const sid of new Set(stalled.map((k) => k.split("/")[0]))) {
    const s = bySid.get(sid);
    if (s) out.push([`⏳ ${tgName(s)} looks stuck: nothing new for a while.\n\n↩ Reply to nudge it.`, sid, false, `stall:${sid}:${Math.floor(now / 3600_000)}`]);
  }
  // A pull request is news when it moves from one known state to another. The states are kept on disk, so after a
  // restart fleet starts from what it knew: what changed while it was off is news, and nothing else is.
  loadPrWas();
  let changed = false;
  for (const s of sessions)
    for (const pr of prsShown(s.side?.prs ?? [])) {
      const key = `${pr.repo}#${pr.number}`;
      const word = prWord(pr, s.side?.cwd ?? s.cwd);
      if (!word) continue; // not known yet: neither news nor a state to compare with
      const was = tg.was.pr.get(key);
      if (was === word) continue;
      if (was !== undefined) out.push([`${word === "failing" ? "❌" : word.startsWith("live") ? "🚀" : "✅"} ${tgName(s)}: #${pr.number} ${word === "green" ? "CI green" : word === "failing" ? "CI failing" : word}`, s.sid, false, `pr:${key}:${word}`]);
      tg.was.pr.set(key, word);
      changed = true;
    }
  if (changed) savePrWas();
  tg.was.ready = true;
  return out;
}
// The pull request states told about, and what the bot has said lately, kept beside the Telegram pairing.
const tgPrWasPath = () => path.join(path.dirname(tgConfigPath()), "telegram-prs.json");
const tgToldPath = () => path.join(path.dirname(tgConfigPath()), "telegram-told.json");
let prWasLoaded = "";
/** Forget what this run has seen, as a restart does (tests). */
export function tgForgetRun() {
  prWasLoaded = "";
  tgLastTo = undefined;
  tg.was.pr.clear();
  tg.was.ready = false;
}
function loadPrWas() {
  if (prWasLoaded === tgPrWasPath()) return;
  prWasLoaded = tgPrWasPath();
  tg.was.pr.clear();
  try {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(tgPrWasPath(), "utf8")))) if (typeof v === "string") tg.was.pr.set(k, v);
  } catch {}
}
function savePrWas() {
  try {
    fs.mkdirSync(path.dirname(tgPrWasPath()), { recursive: true });
    fs.writeFileSync(tgPrWasPath(), JSON.stringify(Object.fromEntries([...tg.was.pr].slice(-500))), { mode: 0o600 });
  } catch {}
}
/** Whether the bot has said this lately (two days), so nothing is said twice, a restart or a change of machine included. Records it if not. */
export function tgToldBefore(key: string, now = Date.now()): boolean {
  let told: Record<string, number> = {};
  try {
    told = JSON.parse(fs.readFileSync(tgToldPath(), "utf8"));
  } catch {}
  if ((told[key] ?? 0) > now - 48 * 3600_000) return true;
  told[key] = now;
  for (const [k, t] of Object.entries(told)) if (t < now - 48 * 3600_000) delete told[k];
  try {
    fs.mkdirSync(path.dirname(tgToldPath()), { recursive: true });
    fs.writeFileSync(tgToldPath(), JSON.stringify(told), { mode: 0o600 });
  } catch {}
  return false;
}

let tgOn = false; // key t: the Telegram screen is showing
let tgCheck = { at: 0, text: "" }; // the bot's name, checked when the screen opens
/** Key t: pair with your own Telegram bot, or see that it is paired. */
export function tgScreen(cols: number, rows: number): string[] {
  const W = Math.max(40, cols);
  const c = readTg();
  const out: string[] = ["", fg(C.cyan, bold("  ◆ CLAUDE FLEET")) + fg(C.white, " on Telegram"), ""];
  const say = (text: string, color: RGB = C.text) => out.push(fg(color, "  " + text));
  if (tg.entry !== undefined || !c.token) {
    say("Fleet can message you on Telegram, on every device, and you can reply to answer a session.");
    say("Messages go through Telegram's servers.", C.dim);
    out.push("");
    say("1. In Telegram, open @BotFather and send /newbot. Pick any name; it gives you a token.");
    say("2. Paste the token here and press Enter. It is kept in ~/.config/claude-fleet/telegram.json, readable only by you.");
    out.push("");
    out.push("  " + fg(C.white, "token: ") + fg(C.cyan, tg.entry === undefined ? "press Enter, then paste" : "•".repeat(Math.min(48, tg.entry.length)) + "▏"));
    if (tg.status) out.push("", fg(C.red, "  " + tg.status));
  } else if (!c.chat) {
    const link = c.bot && c.pairCode ? `https://t.me/${c.bot}?start=${c.pairCode}` : undefined;
    if (!link) say(tgCheck.text || "checking the token with Telegram…", C.dim);
    else {
      say("Scan this with your phone (or open the link) and tap Start to pair your chat:");
      out.push("");
      for (const line of qrRows(link) ?? []) out.push("  " + line);
      out.push("", fg(C.text, "  " + link));
    }
    if (tg.status) out.push("", fg(C.red, "  " + tg.status));
    out.push("", fg(C.dim, "  x forgets the token"));
  } else {
    say(`Paired with @${c.bot ?? "your bot"} ✓`, C.green);
    out.push("");
    say("You'll get a message when a session needs you or looks stuck, and when a pull request fails, goes green,");
    say("merges or goes live. Tap ↩ Reply on a question, or reply to any message, to answer that session.");
    say("/status lists what's waiting.");
    out.push("", fg(C.dim, tg.on ? "  This fleet is talking to the bot." : "  Another fleet on this Mac is talking to the bot; this one takes over if it quits."));
    if (tg.status) out.push("", fg(C.red, "  " + tg.status));
    out.push("", fg(C.dim, "  s sends a test message · x unpairs and forgets the token"));
  }
  while (out.length < rows - 1) out.push("");
  out.length = Math.max(0, rows - 1);
  out.push(fg(C.dim, fit(tg.entry !== undefined ? "  Enter saves · Esc cancels" : "  any other key or click returns to the fleet", W)));
  return out.map((l) => clipRow(l, W));
}
/** When the t screen opens, or a token was just saved: check the token, learn the bot's name, and make a pairing code. */
export async function tgPrepare(): Promise<void> {
  const c = readTg();
  if (!c.token || c.chat) return;
  tgCheck = { at: Date.now(), text: "checking the token with Telegram…" };
  const me = await tgCall(c.token, "getMe");
  if (!me.ok || typeof me.result?.username !== "string") {
    tg.status = me.error ?? "Telegram did not accept the token";
    tgCheck.text = "";
    return;
  }
  tg.status = "";
  writeTg({ ...readTg(), bot: me.result.username, pairCode: readTg().pairCode || Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64url") });
  if (tgWanted) tgClaim(); // never for the demo's made-up sessions
}
/** A key on the t screen. Returns false when the screen should close. */
export function tgKey(key: string): boolean {
  if (tg.entry !== undefined) {
    if (key === "\x1b") tg.entry = undefined;
    else if (key === "\r" || key === "\n") {
      const token = tg.entry.trim();
      tg.entry = undefined;
      if (!TG_TOKEN.test(token)) tg.status = "That doesn't look like a bot token (digits, a colon, then letters).";
      else {
        writeTg({ token });
        tg.status = "";
        void tgPrepare();
      }
    } else if (key === "\x7f" || key === "\b") tg.entry = tg.entry.slice(0, -1);
    else if (/^[\x20-\x7e]+$/.test(key)) tg.entry = (tg.entry + key).slice(0, 200);
    return true;
  }
  const c = readTg();
  if (!c.token && (key === "\r" || key === "\n")) {
    tg.entry = "";
    return true;
  }
  if (key === "x" && c.token) {
    if (c.chat) void tgCall(c.token, "sendMessage", { chat_id: c.chat, text: "Unpaired from Claude Fleet. Bye 👋" });
    writeTg({});
    tg.on = false;
    tg.status = "";
    tgRelease();
    return true;
  }
  if (key === "s" && c.chat) {
    void tgSay("👋 Test from Claude Fleet. Notifications are working.");
    return true;
  }
  return false;
}

// ───────────────────────── every machine ─────────────────────────
// Fleet shows the sessions on all your machines. Each fleet finds your other machines through Tailscale, asks
// each one's fleet for its sessions every couple of seconds, and draws them with its own; a machine that is off,
// asleep or not running fleet simply is not there. A fleet answers another machine only after Tailscale confirms
// the request comes from a device of the same Tailscale user, so there is no secret to copy between machines.

export const PEER_PROTO = 1;
/** This fleet's code, as a fingerprint of fleet.ts when it started: two fleets with different ones are different versions. */
export const FLEET_BUILD = (() => {
  try {
    return Bun.hash(fs.readFileSync(import.meta.path)).toString(36);
  } catch {
    return "";
  }
})(); // what /peer/state speaks; a fleet speaking another is left out until it is updated
const PEER_EVERY_MS = 2000;
const PEER_GONE_MS = 15_000; // a machine that has not answered for this long is dropped
const PEER_KEEP_MS = 3.5 * 3600_000; // what is older than this is not sent: the widest window is three hours
const DISCOVER_EVERY_MS = 15_000;

export interface Peer {
  host: string;
  ip: string;
  addr: string; // ip:port of its fleet
  sessions: Session[];
  at: number; // when it last answered
  fresh: boolean; // it answered for the first time in this scan: what it already had waiting is not news
  busy: boolean;
  tg?: TgConfig;
  tgReady?: boolean; // it can talk to the bot
  tag?: string; // what it last sent, so it can answer "unchanged"
  sentTag?: string; // our state as that machine last confirmed having it, so ours goes again only when it changed
  pushedTag?: string; // its state as it last pushed it here
  noPush?: boolean; // an older fleet that only answers reads
  machine?: { cpu: number; mem: number }; // its CPU and memory, for Telegram's overview
  usage?: { label: string; pct: number; resets: string; resetsAt?: number }[]; // its Claude account's limits
}
export const peers = new Map<string, Peer>(); // by address
/** This machine on the tailnet: its name, address and Tailscale user. */
export const tailnet: { host?: string; ip?: string; user?: string; found: { host: string; ip: string }[]; at: number; busy: boolean } = { found: [], at: 0, busy: false };
let peersWanted = false; // set at launch for real sessions
export const wantPeers = (on: boolean) => (peersWanted = on);

function run(cmd: string[], timeoutMs = 4000): Promise<string | undefined> {
  return new Promise((done) => runInBackground(cmd[0], cmd.slice(1), timeoutMs, (code, out) => done(code === 0 ? out : undefined)));
}
/** How fleet finds machines and decides whom to trust. Tests replace these. */
export const peerNet = {
  /** Your other machines that could be running fleet: online, yours, and not a phone or tablet. */
  async discover(): Promise<void> {
    const text = await run([tailscaleCmd(), "status", "--json"]);
    if (!text) return;
    try {
      const j = JSON.parse(text);
      const v4 = (ips: unknown) => (Array.isArray(ips) ? ips.find((x) => typeof x === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(x)) : undefined);
      tailnet.host = typeof j.Self?.HostName === "string" ? j.Self.HostName : undefined;
      tailnet.ip = v4(j.Self?.TailscaleIPs);
      tailnet.user = j.Self?.UserID !== undefined ? String(j.Self.UserID) : undefined;
      tailnet.found = Object.values(j.Peer ?? {})
        .filter((p: any) => p?.Online && String(p.UserID) === tailnet.user && ["macOS", "linux", "windows"].includes(p.OS) && v4(p.TailscaleIPs))
        .map((p: any) => ({ host: safeLine(String(p.HostName || p.DNSName || "")).slice(0, 40) || v4(p.TailscaleIPs)!, ip: v4(p.TailscaleIPs)! }));
    } catch {}
  },
  /** Whether a request from `ip` comes from one of your own devices, by asking Tailscale who is there. */
  async trust(ip: string): Promise<boolean> {
    const hit = whoisSeen.get(ip);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.ok;
    if (!tailnet.user) await peerNet.discover();
    const text = await run([tailscaleCmd(), "whois", "--json", ip]);
    let ok = false;
    try {
      ok = !!text && !!tailnet.user && String(JSON.parse(text)?.UserProfile?.ID) === tailnet.user;
    } catch {}
    whoisSeen.set(ip, { ok, at: Date.now() });
    return ok;
  },
};
const whoisSeen = new Map<string, { ok: boolean; at: number }>();

/** This machine's name, as the other machines know it. */
export const selfHost = () => tailnet.host || os.hostname().split(".")[0];
/** Whether any other machine's fleet is on the screen: only then does each session say which machine it is on. */
export const manyMachines = () => [...peers.values()].some((p) => p.sessions.length || p.at);
/** The machine a session is on, when there is more than one to tell apart. */
export const machineOf = (s: Session): string | undefined => (manyMachines() ? (s.remote?.host ?? selfHost()) : undefined);
/**
 * The machine a session is on, with how busy that machine is when it is another one ("Tom's Mac Mini (cpu 6%)"):
 * this Mac's own load is in the header, another machine's only here, as its fleet last measured it.
 */
export function machineLabel(s: Session): string | undefined {
  const m = machineOf(s);
  const cpu = s.remote?.addr ? peers.get(s.remote.addr)?.machine?.cpu : undefined;
  return m && typeof cpu === "number" ? `${m} (cpu ${Math.round(cpu)}%)` : m;
}

/** This machine's sessions as another machine reads them: Maps written out, the reader's own state left behind, old timestamps trimmed. */
export function encodeSessions(list: Session[], now: number, stamp = true): string {
  const cut = now - PEER_KEEP_MS;
  // Agents that finished before the widest window can show anything of them are left behind.
  const live = (a: Agent) => !a.done || lastWriteOf(a.tail) >= cut;
  const body = list.map((s) => ({ ...s, agents: s.agents.filter(live), workflows: s.workflows.map((w) => ({ ...w, agents: w.agents.filter(live) })), remote: stamp ? { host: selfHost(), ip: "", addr: "", use: treeUsage(s.pid), git: gitOf(s) } : undefined }));
  // How this machine reads its files, of no use elsewhere; the path stays for this machine's own thread (events are keyed by it).
  const TAIL_ONLY = new Set(["decoder", "carry", ...(stamp ? ["path"] : []), "offset", "ino", "used"]);
  return JSON.stringify(body, function (this: any, k, v) {
    if (TAIL_ONLY.has(k) && this && Array.isArray(this.tools)) return undefined;
    if (v instanceof Map) {
      let entries = [...v];
      if (k === "tokens") {
        // Only ever summed over time, so ten-second buckets say the same in a fraction of the bytes.
        const buckets = new Map<string, [number, number]>();
        for (const [, x] of entries as [string, [number, number]][]) {
          if (!Array.isArray(x) || x[0] < cut) continue;
          const key = String(Math.floor(x[0] / 10_000));
          const b = buckets.get(key);
          if (b) b[1] += x[1];
          else buckets.set(key, [x[0], x[1]]);
        }
        entries = [...buckets];
      }
      if (k === "toolNames") entries = entries.slice(-50);
      return { __map: entries };
    }
    if (v instanceof Set) return { __set: [...v] };
    if (Array.isArray(v) && (k === "tools" || k === "sayTs" || k === "askLog" || k === "compactLog")) return v.filter((t) => typeof t !== "number" || t >= cut);
    return v;
  });
}
export function decodeSessions(text: string): Session[] {
  const list = JSON.parse(text, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? (Array.isArray(v.__map) ? new Map(v.__map) : Array.isArray(v.__set) ? new Set(v.__set) : v) : v));
  if (!Array.isArray(list)) return [];
  for (const s of list) for (const t of tailsOf(s)) t.decoder = new StringDecoder("utf8");
  return list.filter((s) => s && typeof s.sid === "string" && PLAIN_ID.test(s.sid) && Array.isArray(s.mains));
}
/** What /peer/state answers: this machine's own sessions (never the ones it got from others), their pull requests, and the Telegram pairing. */
let peerPayload = { at: 0, body: new Uint8Array(), tag: "" };
export function peerState(local: Session[], now: number): { body: Uint8Array; tag: string } {
  if (now - peerPayload.at < 1000) return peerPayload;
  const prs: Record<string, PrState> = {};
  for (const s of local) for (const pr of s.side?.prs ?? []) {
    const st = prState.get(`${pr.repo}#${pr.number}`)?.state;
    if (st) prs[`${pr.repo}#${pr.number}`] = st;
  }
  const tgc = readTg();
  const ws = webState([], now);
  const text = `{"proto":${PEER_PROTO},"build":${JSON.stringify(FLEET_BUILD)},"host":${JSON.stringify(selfHost())},"machine":${JSON.stringify({ cpu: ws.machine.cpu, mem: ws.machine.mem })},"usage":${JSON.stringify(ws.account?.limits ?? null)},"tgReady":${!!tgc.token && tgWanted},"tg":${JSON.stringify(tgc.at ? tgc : null)},"prs":${JSON.stringify(prs)},"sessions":${encodeSessions(local, now)}}`;
  peerPayload = { at: now, body: Bun.gzipSync(new TextEncoder().encode(text)), tag: `"${Bun.hash(text).toString(36)}"` };
  return peerPayload;
}

/** Ask each machine's fleet for its sessions; called on every scan, it starts what is due and returns at once. */
export function pollPeers(now: number, local: Session[] = []) {
  if (!peersWanted) return;
  if (!tailnet.busy && now - tailnet.at >= DISCOVER_EVERY_MS) {
    tailnet.busy = true;
    tailnet.at = now;
    void peerNet.discover().finally(() => (tailnet.busy = false));
  }
  const port = Number(process.env.FLEET_WEB_PORT) || 4777;
  const wanted = new Set<string>();
  for (const m of tailnet.found) {
    if (m.ip === tailnet.ip) continue;
    const addr = `${m.ip}:${port}`;
    wanted.add(addr);
    const p = peers.get(addr) ?? { host: m.host, ip: m.ip, addr, sessions: [], at: 0, fresh: false, busy: false };
    p.host = m.host;
    peers.set(addr, p);
    if (!p.busy && now - p.at >= PEER_EVERY_MS) void fetchPeer(p, local);
  }
  for (const [addr, p] of peers) if (!wanted.has(addr) && !p.busy) peers.delete(addr);
}
let peerTries = new Map<string, number>(); // when each machine was last asked, so one that is not running fleet is asked only now and then
/** Take a machine's state, read from it or pushed by it, as its sessions and figures. */
function absorbPeer(p: Peer, j: any) {
  if (j?.proto !== PEER_PROTO) throw new Error("another version");
  const sessions = decodeSessions(JSON.stringify(j.sessions ?? []));
  for (const s of sessions) s.remote = { ...(s.remote as any), host: p.host, ip: p.ip, addr: p.addr }; // named as Tailscale names it, the same on every machine
  p.fresh = !p.at;
  p.at = Date.now();
  p.sessions = sessions;
  p.tg = j.tg && typeof j.tg === "object" ? j.tg : undefined;
  p.tgReady = j.tgReady === true;
  p.machine = j.machine && typeof j.machine.cpu === "number" ? { cpu: j.machine.cpu, mem: Number(j.machine.mem) || 0 } : undefined;
  p.usage = Array.isArray(j.usage) ? j.usage.filter((l: any) => typeof l?.label === "string" && typeof l?.pct === "number").map((l: any) => ({ label: safeLine(l.label).slice(0, 20), pct: l.pct, resets: typeof l.resets === "string" ? safeLine(l.resets).slice(0, 40) : "", resetsAt: typeof l.resetsAt === "number" ? l.resetsAt : undefined })) : undefined;
  // Their pull requests' states, for the rows; this machine's own reads win for a PR both have.
  for (const [key, st] of Object.entries(j.prs ?? {})) if (!prState.get(key)?.state || prState.get(key)!.at < Date.now() - 60_000) prState.set(key, { at: Date.now() - 30_000, state: st as PrState });
  // The newest Telegram pairing wins, so pairing (or unpairing) on any machine reaches all of them.
  if (p.tg?.at && p.tg.at > (readTg().at ?? 0)) writeTg(p.tg, false);
}
/**
 * Read a machine's state, and give it ours in the same request (only when it has changed since it last said it had
 * it): a machine this one cannot reach, behind its firewall or serving only itself, still sees this one's sessions,
 * and this one sees its, as long as either can reach the other.
 */
async function fetchPeer(p: Peer, local: Session[]) {
  const now = Date.now();
  if (!p.at && now - (peerTries.get(p.addr) ?? 0) < 10_000) return;
  peerTries.set(p.addr, now);
  p.busy = true;
  try {
    const ours = peerState(local, now);
    const send = !p.noPush && p.sentTag !== ours.tag;
    const port = String(Number(process.env.FLEET_WEB_PORT) || 4777);
    const head: Record<string, string> = { "x-fleet-tag": ours.tag, "x-fleet-port": port, ...(p.tag ? { "if-none-match": p.tag } : {}) };
    let r = await fetch(`http://${p.addr}/peer/state`, send ? { method: "POST", headers: { ...head, "content-type": "application/json", "x-fleet-gzip": "1" }, body: ours.body, signal: AbortSignal.timeout(4000) } : { headers: head, signal: AbortSignal.timeout(4000) });
    if (send && (r.status === 404 || r.status === 405)) {
      p.noPush = true; // an older fleet: read it the old way
      r = await fetch(`http://${p.addr}/peer/state`, { headers: p.tag ? { "if-none-match": p.tag } : {}, signal: AbortSignal.timeout(4000) });
    }
    if (r.headers.get("x-fleet-have")) p.sentTag = r.headers.get("x-fleet-have")!;
    if (r.status === 304) {
      p.at = Date.now();
      return;
    }
    if (!r.ok) throw new Error(String(r.status));
    p.tag = r.headers.get("etag") ?? undefined;
    absorbPeer(p, await r.json());
  } catch {
    if (p.at && Date.now() - p.at > PEER_GONE_MS) {
      p.at = 0;
      p.sessions = [];
    }
  } finally {
    p.busy = false;
  }
}
/** A machine's state pushed with its read of ours: kept as if read from it. Its address is its tailnet address and fleet port. */
export function takePushedPeer(ip: string, port: number, tag: string, j: any | undefined, now = Date.now()): string | undefined {
  const addr = `${ip}:${port}`;
  const known = tailnet.found.find((m) => m.ip === ip);
  const p = peers.get(addr) ?? { host: known?.host ?? (typeof j?.host === "string" ? safeLine(j.host).slice(0, 40) : ip), ip, addr, sessions: [], at: 0, fresh: false, busy: false };
  peers.set(addr, p);
  if (j) {
    try {
      absorbPeer(p, j);
      p.pushedTag = tag;
    } catch {
      return p.pushedTag;
    }
  } else if (tag && tag === p.pushedTag) p.at = now; // unchanged, and still there
  return p.pushedTag;
}
/** Every other machine's sessions, as last read. */
export function peerSessions(): Session[] {
  const out: Session[] = [];
  for (const p of peers.values()) if (p.at && Date.now() - p.at <= PEER_GONE_MS) out.push(...p.sessions);
  return out;
}
/** Sessions whose machine answered for the first time in this scan: what was already waiting there is not news. Clears the flags. */
export function takeFreshPeers(): Set<string> {
  const sids = new Set<string>();
  for (const p of peers.values())
    if (p.fresh) {
      for (const s of p.sessions) sids.add(s.sid);
      p.fresh = false;
    }
  return sids;
}
const ipValue = (ip: string) => ip.split(".").reduce((n, x) => n * 256 + Number(x), 0);
/** One fleet on the whole network talks to the Telegram bot: of those that can, the one with the lowest Tailscale address. */
export function tgLeader(selfIp: string | undefined, others: { ip: string; tgReady?: boolean; at: number }[], now = Date.now()): boolean {
  if (!selfIp) return true;
  return !others.some((p) => p.tgReady && p.at && now - p.at <= PEER_GONE_MS && ipValue(p.ip) < ipValue(selfIp));
}
/** Ask the fleet on a session's own machine to do something with it: send, press a key, look at its screen. */
async function peerCall(s: Session, route: string, body: Record<string, unknown>): Promise<Reach> {
  try {
    const r = await fetch(`http://${s.remote!.addr}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const j: any = await r.json().catch(() => ({}));
    return { ok: j?.ok === true, via: `${s.remote!.host}${j?.via ? " " + j.via : ""}`, screen: typeof j?.screen === "string" ? j.screen : undefined, id: typeof j?.id === "string" ? j.id : undefined, error: j?.ok ? undefined : typeof j?.error === "string" ? `${s.remote!.host}: ${j.error}` : `${s.remote!.host} did not answer` };
  } catch {
    return { ok: false, error: `could not reach fleet on ${s.remote!.host}` };
  }
}

// ── what happened, for the digest ──
// Everything the bot told you (or held, or you muted), every celebration and every session that finished is kept
// for two days, so the morning digest can say what happened while you were away.
const tgLogPath = () => path.join(path.dirname(tgConfigPath()), "telegram-log.json");
let tgLogCache: { t: number; text: string }[] | undefined;
export function tgLog(text: string, t = Date.now()) {
  const log = tgLogRead();
  log.push({ t, text: text.split("\n")[0].slice(0, 200) });
  while (log.length && log[0].t < t - 48 * 3600_000) log.shift();
  if (log.length > 600) log.splice(0, log.length - 600);
  try {
    fs.writeFileSync(tgLogPath(), JSON.stringify(log), { mode: 0o600 });
  } catch {}
}
export function tgLogRead(): { t: number; text: string }[] {
  if (!tgLogCache)
    try {
      const j = JSON.parse(fs.readFileSync(tgLogPath(), "utf8"));
      tgLogCache = Array.isArray(j) ? j.filter((x) => typeof x?.t === "number" && typeof x?.text === "string") : [];
    } catch {
      tgLogCache = [];
    }
  return tgLogCache!;
}

// ── quiet hours ──
const minutesOf = (hhmm: string) => {
  const m = /^(\d{1,2}):?(\d{2})$/.exec(hhmm.trim());
  return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : undefined;
};
/** Whether `now` falls in your quiet hours ("23:00" to "07:00" wraps past midnight). */
export function inQuiet(q: TgConfig["quiet"], now = Date.now()): boolean {
  if (!q) return false;
  const from = minutesOf(q.from);
  const to = minutesOf(q.to);
  if (from === undefined || to === undefined || from === to) return false;
  const d = new Date(now);
  const m = d.getHours() * 60 + d.getMinutes();
  return from < to ? m >= from && m < to : m >= from || m < to;
}

// ── the morning digest ──
const DIGEST_DEFAULT = "08:00";
/** The digest: what happened since `since`, what is waiting now, and usage. */
export function tgDigest(since: number, now = clock()): string {
  const st = webState(tg.getSessions(), now);
  const fmt = (t: number) => new Date(t).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const lines = [`☀️ <b>Digest</b> · since ${fmt(since)}`];
  const happened = tgLogRead().filter((x) => x.t >= since);
  const kinds = (re: RegExp) => happened.filter((x) => re.test(x.text)).length;
  const tally = [kinds(/merged/) && `🎉 ${kinds(/merged/)} merged`, kinds(/live on/) && `🚀 ${kinds(/live on/)} live`, kinds(/finished/) && `✓ ${kinds(/finished/)} finished`, kinds(/CI failing/) && `❌ ${kinds(/CI failing/)} CI failures`, kinds(/stuck/) && `⏳ ${kinds(/stuck/)} stuck`, kinds(/needs you/) && `🟡 ${kinds(/needs you/)} questions`].filter(Boolean);
  lines.push("", tally.length ? tally.join(" · ") : "A quiet stretch: nothing to report.");
  if (happened.length) {
    lines.push("", "<b>What happened</b>");
    for (const x of happened.slice(-25)) lines.push(`<code>${new Date(x.t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</code> ${esc(x.text)}`);
    if (happened.length > 25) lines.push(`… and ${happened.length - 25} earlier`);
  }
  const waiting = st.sessions.filter((s) => s.state === "needs" || s.state === "stalled");
  lines.push("", `<b>Now</b> · ${st.counts.working} working${waiting.length ? `, ${waiting.length} waiting on you` : ""}`);
  for (const s of waiting) lines.push(`${STATE_EMOJI[s.state]} ${esc(s.name)}${s.needs ? `: ${esc(capText(flatReply(s.needs), 120))}` : ""}`);
  const usage = [...(st.account?.limits.length ? [{ host: selfHost(), limits: st.account.limits }] : []), ...[...peers.values()].filter((p) => p.usage?.length).map((p) => ({ host: p.host, limits: p.usage! }))];
  if (usage.length) lines.push("", ...usage.map((u) => `📊 ${esc(u.host)}: ${u.limits.map((l) => `${esc(l.label)} ${l.pct}%`).join(" · ")}`));
  let text = lines.join("\n");
  if (text.length > 4000) text = text.slice(0, 3990) + "…";
  return text;
}
/** Today's digest time as a timestamp, or undefined when the digest is off. */
function digestDue(c: TgConfig, now: number): number | undefined {
  const at = c.digest?.at ?? DIGEST_DEFAULT;
  if (at === "off") return undefined;
  const m = minutesOf(at) ?? minutesOf(DIGEST_DEFAULT)!;
  const d = new Date(now);
  d.setHours(Math.floor(m / 60), m % 60, 0, 0);
  return d.getTime();
}

// ── usage alerts ──
const USAGE_ALERTS = [80, 95];
const usageAlerted = new Set<string>();
const usageSeen = new Set<string>(); // machines whose figures have been seen once: what was already high at launch is not news
/** The usage alerts due now: a limit crossing 80% or 95%, once per limit window, per machine. */
export function usageAlerts(now = clock()): string[] {
  const st = webState([], now);
  const blocks = [...(st.account?.limits.length ? [{ host: selfHost(), limits: st.account.limits }] : []), ...[...peers.values()].filter((p) => p.usage?.length).map((p) => ({ host: p.host, limits: p.usage! }))];
  const out: string[] = [];
  for (const b of blocks) {
    const first = !usageSeen.has(b.host);
    usageSeen.add(b.host);
    for (const l of b.limits)
      for (const at of USAGE_ALERTS) {
        const key = `${b.host}|${l.label}|${at}|${Math.round((l.resetsAt || 0) / 3600_000)}`;
        if (l.pct < at || usageAlerted.has(key)) continue;
        usageAlerted.add(key);
        if (!first) out.push(`${at >= 95 ? "🔴" : "🟠"} ${b.host}: ${l.label} usage at ${l.pct}%${l.resets ? ` · ${l.resets}` : ""}`);
      }
  }
  return out;
}

// ── the live message ──
// /live pins a picture of the fleet that redraws itself: Telegram lets a bot swap the photo in a message it sent.
// It is looked at every minute and redrawn when anything about the sessions has changed, or every five minutes
// regardless, so the clock and graphs move without uploading a picture a minute. /live text pins the overview as
// text instead.
const LIVE_EVERY_MS = 60_000;
const LIVE_REDRAW_MS = 5 * 60_000;
let liveAt = 0;
let liveDrawn = { at: 0, key: "" };
const liveText = (text: string) => `${text}\n\n<i>📌 live · updated ${hhmm(Date.now())} · /live to stop</i>`;
/** The picture's caption: the counts, and when it was drawn. */
function liveCaption(now = clock()): string {
  const c = webState(tg.getSessions(), now).counts;
  const counts = [c.needs && `🟡 ${c.needs} need${c.needs === 1 ? "s" : ""} you`, c.stalled && `⏳ ${c.stalled} stuck`, c.working && `🟢 ${c.working} working`, c.agents && `🤖 ${c.agents} agent${c.agents === 1 ? "" : "s"}`].filter(Boolean);
  return `${counts.length ? counts.join(" · ") : "All quiet"}\n<i>📌 live · updated ${hhmm(Date.now())} · /live to stop</i>`;
}
/** What the picture shows, in a few words per session: when this changes, it is redrawn. */
function liveKey(now = clock()): string {
  return JSON.stringify(webState(tg.getSessions(), now).sessions.map((s) => [s.sid, s.state, s.sub.text, s.tasks?.done, s.ctx?.pct, s.agents.length, s.fails?.n, s.prs.map(segText)]));
}
/** The photo upload for sending or swapping: the picture, its caption and the session buttons. */
function livePhoto(c: TgConfig, extra: Record<string, string>, now = clock()): FormData {
  const form = new FormData();
  form.append("chat_id", String(c.chat));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  form.append("reply_markup", JSON.stringify(tgOverview(now).markup));
  form.append("pic", new Blob([fleetPicture(tg.getSessions(), now)], { type: "image/png" }), "fleet.png");
  return form;
}
/** Turn the pinned live view on or off. */
async function tgLive(c: TgConfig, arg = "") {
  if (c.live?.id) {
    await tgCall(c.token!, "unpinChatMessage", { chat_id: c.chat, message_id: c.live.id });
    await tgCall(c.token!, "deleteMessage", { chat_id: c.chat, message_id: c.live.id });
    writeTg({ ...readTg(), live: undefined });
    return void (await tgSend(c, { text: "Live view off." }));
  }
  const asText = /^text$/i.test(arg.trim());
  const now = clock();
  let r;
  if (asText) {
    const v = tgOverview(now);
    r = await tgCall(c.token!, "sendMessage", { chat_id: c.chat, text: liveText(v.text), parse_mode: "HTML", reply_markup: v.markup });
  } else {
    const form = livePhoto(c, { caption: liveCaption(now), parse_mode: "HTML" }, now);
    form.append("photo", form.get("pic") as Blob, "fleet.png");
    form.delete("pic");
    r = await tgCall(c.token!, "sendPhoto", form, 60_000);
  }
  if (!r.ok || typeof r.result?.message_id !== "number") return void (await tgSend(c, { text: `Could not start it: ${esc(r.error ?? "")}` }));
  await tgCall(c.token!, "pinChatMessage", { chat_id: c.chat, message_id: r.result.message_id, disable_notification: true });
  writeTg({ ...readTg(), live: { id: r.result.message_id, text: asText || undefined } });
  liveAt = Date.now();
  liveDrawn = { at: Date.now(), key: liveKey(now) };
}
export async function tgLiveTick(c: TgConfig, now: number) {
  if (!c.live?.id || now - liveAt < LIVE_EVERY_MS) return;
  liveAt = now;
  let r;
  if (c.live.text) {
    const v = tgOverview(now);
    r = await tgCall(c.token!, "editMessageText", { chat_id: c.chat, message_id: c.live.id, text: liveText(v.text), parse_mode: "HTML", reply_markup: v.markup });
  } else {
    const key = liveKey(now);
    if (key === liveDrawn.key && now - liveDrawn.at < LIVE_REDRAW_MS) return; // nothing new to draw yet
    liveDrawn = { at: now, key };
    r = await tgCall(c.token!, "editMessageMedia", livePhoto(c, { message_id: String(c.live.id), media: JSON.stringify({ type: "photo", media: "attach://pic", caption: liveCaption(now), parse_mode: "HTML" }) }, now), 60_000);
  }
  if (!r.ok && /not found|can't be edited|message to edit/i.test(r.error ?? "")) writeTg({ ...readTg(), live: undefined }); // you deleted it: it stops
}

// ── new sessions ──
const newPicks = new Map<string, { prompt: string; at: number; choices: { host: string; addr?: string; cwd: string; place: string }[] }>();
/** /new <prompt>: where to start it, from the folders your sessions run in on each machine. */
function tgNew(c: TgConfig, prompt: string): TgView {
  if (!prompt) return { text: "Say what to ask: <code>/new fix the flaky refund test</code>, then pick where." };
  const seen = new Set<string>();
  const choices = [...tg.getSessions()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((s) => ({ host: s.remote?.host ?? selfHost(), addr: s.remote?.addr, cwd: s.cwd, place: foldersOf(s.cwd.replace(os.homedir(), "~")).slice(-2).join("/") }))
    .filter((x) => absoluteDir(x.cwd) && !seen.has(x.host + x.cwd) && seen.add(x.host + x.cwd))
    .slice(0, 8);
  if (!choices.length) return { text: "There are no folders to start in: fleet offers the folders your sessions run in." };
  const id = Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString("base64url");
  newPicks.set(id, { prompt, at: Date.now(), choices });
  for (const [k, v] of newPicks) if (Date.now() - v.at > TG_KEEP_MS) newPicks.delete(k);
  const many = new Set(choices.map((x) => x.host)).size > 1 || manyMachines();
  return { text: `▶ <b>New session</b>\n\n${esc(capText(prompt, 600))}\n\nWhere should it run?`, markup: { inline_keyboard: [...choices.map((x, i) => [{ text: `${many ? `💻 ${x.host} · ` : "📁 "}${x.place}`.slice(0, 60), callback_data: `n:${id}:${i}` }]), [{ text: "✕ Cancel", callback_data: `n:${id}:x` }]] } };
}
async function tgNewPick(c: TgConfig, msgId: number, id: string, pick: string) {
  const p = newPicks.get(id);
  if (!p) return tgEdit(c, msgId, { text: "That has expired: send /new again." });
  newPicks.delete(id);
  if (pick === "x") return tgEdit(c, msgId, { text: "Not started." });
  const ch = p.choices[Number(pick)];
  if (!ch) return;
  await tgEdit(c, msgId, { text: `▶ Starting on ${esc(ch.host)} in ${esc(ch.place)}…` });
  const r = ch.addr
    ? await peerCall({ remote: { host: ch.host, addr: ch.addr } } as Session, "/peer/new", { cwd: ch.cwd, prompt: p.prompt })
    : await (web.start ?? startSession)(ch.cwd, p.prompt);
  await tgEdit(c, msgId, { text: r.ok ? `▶ Started <code>${esc(r.id ?? "")}</code> on ${esc(ch.host)} in ${esc(ch.place)}.\n\n${esc(capText(p.prompt, 300))}\n\nIt will show in /status in a moment.` : `✗ Not started: ${esc(r.error ?? "")}` });
}

// ── the session's own screen ──
/** A picture of what the session's terminal shows, with a button for each choice it offers. */
async function tgPeek(c: TgConfig, s: Session) {
  const r = await (web.peek ?? peekSession)(s);
  if (!r.ok || !r.screen) return void (await tgSend(c, { text: `📺 Can't see ${esc(tgName(s))}: ${esc(r.error ?? "")}` }));
  const lines = r.screen.split("\n");
  while (lines.length && !lines[lines.length - 1].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim()) lines.pop();
  const options = screenOptions(r.screen);
  const markup = {
    inline_keyboard: [
      ...(options.length ? [options.slice(0, 4).map((o) => ({ text: `${o.key}. ${o.label}`.slice(0, 40), callback_data: `k:${s.sid}:${o.key}` }))] : []),
      ...(options.length > 4 ? [options.slice(4, 8).map((o) => ({ text: `${o.key}. ${o.label}`.slice(0, 40), callback_data: `k:${s.sid}:${o.key}` }))] : []),
      [{ text: "⏎ Enter", callback_data: `k:${s.sid}:E` }, { text: "⎋ Esc", callback_data: `k:${s.sid}:X` }, { text: "🔄 Look again", callback_data: `w:${s.sid}` }],
    ],
  };
  await tgPhotoSend(c, pictureOf(lines.slice(-40), 120), `📺 ${tgName(s)}${options.length ? " · tap a choice to press it" : ""}`, s.sid, markup);
}
/** Everything the bot does on each scan, beyond notifications: the log, usage alerts, the digest and the live message. */
export async function tgTick(sessions: Session[], now: number, partied: string[]) {
  const c = readTg();
  if (!c.token || !c.chat) return;
  for (const p of partied) {
    const [sid, ...rest] = p.split(" ");
    const s = sessions.find((x) => x.sid === sid);
    if (s) tgLog(`🎉 ${tgName(s)}: ${rest.join(" ")}`);
  }
  // A session that has finished its turn, for the digest.
  const states = new Map(buildViews(sessions, now).map((v) => [v.s.sid, v.state as string]));
  for (const s of sessions) {
    const done = ["yours", "done"].includes(states.get(s.sid) ?? "idle");
    if (done && tgWasWorking.get(s.sid)) tgLog(`✓ ${tgName(s)} finished${factsOf(s).main?.say ? `: ${capText(flatReply(factsOf(s).main!.say!.text), 120)}` : ""}`);
    tgWasWorking.set(s.sid, !done);
  }
  for (const text of usageAlerts(now)) {
    tgLog(text);
    if (!inQuiet(c.quiet, now)) void tgSay(text);
  }
  const due = digestDue(c, now);
  if (due !== undefined && now >= due && now - due < 4 * 3600_000 && (c.digest?.last ?? 0) < due) {
    writeTg({ ...readTg(), digest: { at: c.digest?.at ?? DIGEST_DEFAULT, last: now } });
    void tgSend(c, { text: tgDigest(c.digest?.last || now - 16 * 3600_000, now) }, undefined, false);
  }
  await tgLiveTick(c, now);
}
const tgWasWorking = new Map<string, boolean>();

// ───────────────────────── pictures ─────────────────────────
// Fleet can draw its own screen as a PNG, for Telegram: the frame it would show, in the unscii-16 bitmap font
// (8 by 16 pixels, by viznut, public domain: http://viznut.fi/unscii/), each pixel doubled so it stays sharp.

const FONT_B64 = "eNplmwl800UWxwcKhd3NtkVAow30/IdIPaIIRomAGBVvVPDAK1KNV7bUq6LGltZdl/UWz67gjWLxwhNQtFoNqJF6gVWuKgoeiFUUUbrJzps3b+b98x8+adNvZt68ef+Z31xBiHLhSRXCr5MQ8JKpUiQSCXeuKiGSyWRWvxSqltmjiXjY7ytMRLGkI0RhOpPx+8PhRCLdDigoRCSZjISvWZ/JZBpUwRFQY9hlPiR8UEglv98HaE8B7zDp7CPhRyIRzUWNezXwQ5pr9GvfhdjLmo3IgnH5e2/9d6P9aB/7loruW1BQWKgqC8fj7cr7MHifTq9cvSmdTkZUrv1kgchMHTI0uL8Q0iNZVtYWRzRKo0BhoXRYoQOE8AWiyUwmC01SaLR0KR6PpwptrjFCBKSVVAISogNlrkL0jFyNKPOJhmidyXUQosQ4yIquHmwbRwXH2vcUHCiuXIcniRE5xETLRGycfKkcPiwl03jVRB/vOROESKXT6fXr169tb08pdKj8EBxrVC1SaKLMJd8nZyblT8x1mPI+DokaFBNCZUiorAodjvGKp+AHunaEDqEqio4dqW3VqXAoNAn6jduJo2RB6vn6OR4tA6ETOXGMEGnZo7t6ujKZdFqhY2UgTMKCx8lcW7dmV69OQ1LoeCi4adP27PqVKzU6QT8h9mgnYyQSKev9ia5c6omcRLmSxvuTsY1q8GlbU3iD8HFM1c1mNZ5iUFQPWnEquCrT6tXZrVvR1dOE6OiAUS0fXUeHQqcrpBiZn6Y6puyXYdPvzxDRsE2qyjPb2+NxNax9hYUFBYDOElGfTSrX2aJE6oSOFKZz8pQqJwMvOxp1Up3OxV/RwnHmaU/HJ4RjCPtXrc4FXUxH4jx82uMStpucT7kSsk9hLhnu4bIljdgghS7QIyKhh5us4UJeIz6hi3BQoFIMV+hiqQA+eOkkO/UlWFAPBpUrSYVswX9gjRnZw2QfU+/rEPEaZxjvzdOu57lSqotdmue9jOZlJpfphZfrXDIMqoEyXQF6SJFAv67EXAkWwgaGothNrkIEHWx1CueOmYSSEXrmV7tsFRbKBlyjVVtpDvava0WRikuP+lmk3Pa7EqDrRDd6qX52o5hdtnquuz895J0MHxYoZqyTPyLUKIBuQ+hRNafF4z3w4HoVekx6DoGP2nlzPg2YRpidFHrcTrRk/wnok+FIMjEmAPMooAX5k68QT8rHOrF53qJFi+Y1T8RH2ya7PHTecVajF+LUk8gkRhF6Cn9lC9WDVulp/TtqzT+jzC+Zv2T+fDL/bKMnOM9B14q60CI+/WKJ52Vs4HmlbK4XAEV8egJV6UWcZ7mtl3gHkH1VTsAvyx54jUwH7wFJffwKTdq24GKXS77CgBBLRLjeDliVluqhEbXxehVHVUJGjNBrYkL6iGOPBd+mJ97r7CvRMouS099eAX3uddEeTOyV4bnewJ4DSkhBag/72dSn0Js+D3rLn8hHHQ1r89HbCU+ud6KyHmAWyZE0PtUrVxhyrZXpVGi5a2JVwVkh/Wp0z6Lv+jzoPelXHno/4UEZsOWeRT/wedBKsOVGnQkP+lBP+NvthP+RjIScRrevX2km1o9ljVH3nPaJz4M+lTXmoVXSVh5anfDk+gx+tChdatF9ogvUsq6urrGhoUFPJ59LJ/Im1i98HrRGOpGH1iY8aJ0uGLWas152nvZeNSn34kJUbJDBkQ+1KwMQu6vUNemGa+b7Uvb/PPQV9BE32ihleq0bfQ0Dz42+gZ4TdaFNWpBLS5u6ulDWN7smVtW/vtV+sVn0O+0XQ99rvxj6QTvB0Ba0FVGxQfQj2uJoK9ri6Ce0xVGPGBMIjNETPqKfMRJ8Fv3FeG9ybTPeG/Sr8d6g33RUGdpuGmTQ76iYUoTMhmWHXnQnZA9LvKbe/4FO8In1T3SCo53oBEe9WCNH/3MVVBNrVqhlB18W5FwFIVd5iWeiKB/kRbvoN1bvywfrN1mLhtg1HKGh3ly7Jl0J0G55S8CcKPeH/XkzU/nuPg8KZPJn0fJhVucJlZvpiwZfeYVBtKksr8SHFo2aNXN5tWf/WO5YpHtTeZDVNWeOyhXGHYXfH4+vkQnQfhatkgnQ/p75sVzO6WOSXS7v5ZZy5JQFLjQaV9ocyS1lckypK5fcUk4ZOdSF7KYjgV1BlB8iUi+PGRONgB/oS3kMFs2uPXL5kZkMFIIpR84HEOHySZs2jZEpkQDNVrpdftTatUq5Ml2yCfASFberikvCTU1h3dUq7vBHG92ruQoVNTHQl836Bupcd7qyNMplZsVdeCSRyOUS+slU3O2ypXLd09PT3d3Ts3hxIFBU1K8f5Lq3uHjAgOLiYcMikfp66A6i4j7oF/X1kciwYfihqGgVol+/oqJAYPFiNCEq5ue5mhMVCziSFUr0PCy8gsFEIpuNx9G8HOElJWHZ6qYmOoJZhr8BhcMlEIyK1/2B4XmReMOeOxCSD2DgQJ+MTZZGUcWbelTJ5PMNhJBVvOUqNTwgC3a40MyIRJv8/khkxow3ZZoxIxIB85uhzyfkDnDz5mqZolFR8a3fHwhs3369TNu3BwKQ67toFD7dvFktd2GEVPaX1RYUNq5Zs60xjvNX5S6eM5jKwfg3G2mVQ1AdORrq6XKV6oNoFHexaGsPAac3MmUyyQgWLBW1g4O7JjgKiKrax7cHgwzhTqZBDsU68qvMs2iu3FOwbTmiSfATNhVmY1F5rm5go2lm5XlqTYqnKwgr1S5TH6Vo9I7WEatiVX1QnyZPnj27f/++sMSskp/G2tpSoVAo1dYWU7lkjyoqLS1lfaKqwrzv6upSG8Cq+9nxGi6Lq+aG85Komsf+wkO4qgfYIZxKoupBX14SVQ+xv/Coruph1zmAMv+It8ZHXX/Dk6x6zHU0oMzP99b4uOtvVfAJvTNkkViAb8Ld3WFCT7qywFq+qs3vzy+4UNTno6fwjW/AAB+hp11ZINJVz3htPUtTl5n6qp7PZtvb+amIqHqBd3GVteqVApXgLEruDVXBxe15SVQtKchLomqprYpqfNXtAaDX2KyKH1Qtc021yokPvQ36Aj9rbIQhqEarIzxtdPoQMczp67HlFETzknD66ezr1hlb/YkY5hSiSNiXcAbI0lH+Eo6eMERbm7H1FyKGOX/V55fmJZy/RbFx5iUcmlLLyoz3fydCTDhFOtf48aZBxUSICYdWVjt2GFuDiBATDilmb6+xNZgIMeEM0SbKykwbhxIxzNlVmxg/3uTajYhhDj2YHTtMrt2JGObsoW319ppcpUQMcwLGL9PGYdYvQsPJL5urjHLZeJUb700kKohYW5VUo81VZdtIqNq00dTo2DYSClIbba4RlMvGPmQiYWrck4i1NZJqtLlqbLwI7WXGkKlRX1v05HLGlr62KM7lTLP3tSONUNjYMjXuZ2yZGvc3tkxwRllbhA6g9Y0d26N1e3K5HkJjdOhzuWJCB1I5qwAR7Q6zdZCOBLN1sH5ozNZYKmdtRY1fJl6HGL9MvMYZv0y8xlu/CE0wfhlbhxrzJoQTTS6DDjPemxpjxntT4+HGLxP7I4xfJvZH2jZSwUnWVcp1lKnR2Dra1GhsHWNtETpWB6611cT+OCKGOceb6yL9Wzgn4BJLWVG/hTPZ7sao4InJvCSck7Q8+u3YPlnQStfkmqJJfIZBU7UW+u3gO8Voocl1qia+LQadpqPqt1p4uv7QLLaFMw3JjLhFZ+gn5LfCd6YuyFTuLCRbfBadbWo0rp6jC86wDYpTjRada2o0BafrD7fYBtVSjRadZ2JvCp5vhrvJlaBcPxl0Ae1T7EO7UH/IxuNFSH5iuS7WBf22xktMQWM+SQVtjfraQgwoDlBBWmN390QIzcA3kZ5uU6NefQWKBxh0qftydtYs4Vzmvljq00c4l9MWBLctzc3CuUJb6Okxtq50HfArpK8tRHGxQVex/b12dSaZMsacq83KxRS8hkwZY8619KFd56SM+ppc11FNNlejkW1TYxN9av2aldPJOtGcd3eWE06LGwC63g0A/dMNAP3LDQDd4AaA/u0GgGbncvnoP9m8JJwbe/OScG7akZeEc3NPXhLOLd15STi3elbIzm2z8pJwbi/OS8K5o3K2+59w5rRNdf8Tzp3rrnL/E85dntW2c3efvCSce4SwfQe9v1cI21HQifvMp8ZWKyEbwv8SsgXvp0+t+bmEbK555q0x/wAhW/BBQrbGh2C5bxMUfBgQbYgRPZJKpU1KQf92Hs1mW1qWqtTSos4onMdywv1POPPb8pJwHo/lYjH+Es4Ts2fHYpWVgwbRb+EsGDSosjIWmz2bfgvnSbkzlpvkQYPot3DUQj+iEjV7IaJQyKKnKCa2jU9bRG18Jm+7ItGzePyBCdFzwmwDGhvVBOIssiiRQPQ8DXWoDwP9AiKIaYdMgF6E46KSEvA+lcKovgRIOp+MxdIyrIBentXe3bOjN5vLZXt39HS3y07+CqCuTLojnelSRDhwUzYhXj8zNbM+PgGbvUShyZNikyYTWqour3p6c7097To4ryJau3ytQa+Bx+A5SZFwluVy4DV9uQDQ60KA1+A9tAIKviGE7BTpWCwpw4+ovU/BgOKy8U25XNP4suIBBXLAvAmodFRtR+2oUkWE85bM2s8XiKaiAR/uEp0OhYZUx6qHEHobfhYUj8+NLy7Qrr6DaOzGsQalIcwYdWgBuLqcZg1zjOWs8Purq6dNWybTtGnV1YDexTxwdIv5hPMePB347kI6nUxCO4XzPh5PTZRJH1E5mZIS2YtFi1ThWAyb/QH0wWQSejwUBLQyEonF5sxpa5szJxZD1Am2aOihrQ+j0YaGbTo1NIATH0WjdXWdOtXVAfqYmkOtFM4n1GhqpXA+pYIWrSJkC66W8YMdGaSyMgij85nsELAZgrRjB/QLpwsKwDkgnBhij/4c6mpthRC2tmKP/oKQlaE19M7mWhuJwESvr79UrnWBAEz0BQUWrad3eFQSCAhnAyE8Y5FBdLopErbgl/TONvurPn0KCuC8Fxra1ARObJw1q70dznuhodksoK/lEMuqFvd0d+NC5BvZb5tUXIoHDMCFyCZcOIAk6GWGIwOyjSWw9W0u18kSoO9Qc3fu3LZt40aMxPcQr+XLOzs3bCBB/iGXW8MSoC0w4KqrJ06cNq21tbkZ0I+oJg0N2FkAbUVUV0cPWDg/UXBsJHrI/M6dJEM/Y5/p6Ni5k2r8hdCGDYS2UcENG6jgr9DlyBaa/w1rREvYv7YjQkuIfqeCYAsLyh0UXiHY2P+Ry9XWjhpVWmpj/yc9tC71pS1wYieuvYxCy8fR61qOKZSjDlBaOmpUba0sGOwbjU6cuHDhqlWgXkOGDBwogv2V+kayWRi7MJxFsBBROm0RnjNF5dPQX6gQwaLGRhAOlHc1nQTVQZBUwxaUcUDqICh7w41tcwzaBXO1zWkzyFFftEtGsmZaC4bUFRVdZim0r3LhluYXcp2N6EUwjJcD9iWC++FXcTjan3IRFsFRlMuiA7gtdc0THM1tIRrDbSE6kNtCdJCcZZub5zc3t8qXWvUGDya0rJXQWIlkF5MdT44mRBNc33qSrRfBifLv4UV7wH15JqPW7EH4VlNJJJWFp4Yr7yAc1iezKNp4IBecrnJFkmmQcUS1iKZks1NKcK0QPE8hqfdbja3zlS2Z5FSnCyawYCqbMrYuwHWILBgK6YIXCfo+WDSlzV8MyhEYXur3z9yB398KXgIb5FpIF2zehF+rTSrUxNH1uZwMl4wX/oTueyPF3qTgTRR7i27mzxHRLfw5IrqVP0dEt/HniOiBWe3qqkNmhFsPuewIPtinQF11yC043HrIuTz4FAQilUomYWmABVfQ0Qdu8mQPHjEwHI5E5qqF7Ny5EbiGHDG4b1/YBpICwLeJD5gzZ8oUHI9TpqhL1hGj4bYV4NatGo5Q2+aEms789J1jTwr1cS2+Feqbt+OTqMCzTA/14+t7RP3prUWFrh2AQgNcWxqFBrqW6Ar9xbW5U+ivtGq36G+0A7DIR7as+b+TLYuKXDsAhYpduwmFSvJ2tRINom2IRbvkHftLNJj2LxYNIVvW/FCyZdGuZMui3ciWRX7Ptia0O218LNqDtjQWlXq2zaEA3w8hGka2LBpOtiwq4zswROV8g4eogj61qJIehUVVfIOHqNq1b1fIIVsWBcmWRSP4/hFRiMxa83vSpxaNpCZbVEPts2gvemvN701vLdqHbFm0L9myKOzaDCu0n2ubq9D+ZNqiUWTHogPIljU/mmxZNMZ1zqHQga69tkIR10mBQge5NtYKHUymLRrLt+CIonxzjegQymHRONf2W6HxrmMUhSZwPVCdIXQoH/2IJvKhjugwPq4RxTznE6HDeQ5ER/A/ER3pOZYJTeIDD9FRfJQhOpoPKUTH8PGD6FiuX4iO4/qF6HiuX4hO4PqFaDLv4IhO5L0Z0Um86yI6mfdTRFO4fiGayvUL0SlcvxCdyvUL0Wm8IyE6nfcaRNN4F0F0Bu8PiM70nOeEzuL6hehsrl+IzvGcIIXiXL8Qncv1C9F0rl+Iarl+ITqP6xei87l+IUpw/UJ0AdcvRBdy/UJ0EdcvRBdz/UJ0CdcvREmuX4j+wfULUR3XL0QzuH4hquf6hehSrl+ILuP6hehyrl+IruD6hehKrl+IGrh+IbqK6xeimVy/EF3N9QvRNVy/EF3L9QtRiusXouu4fiFq5PqFqInrF6JZXL/Ucwg1c/1C1ML1C9H1XL8Q/ZOLC6J/cSVBdAOXDUT/5hqBaDbXL0T/4fqF6EauX4hu4vqF6GY+iBHdwkcsolv58ER0Gx+LiG7n+oXoDq5fiOZw/UJ0J9cvRHfxwYLobj4yEN3DhwGie3mfR3Qf1y9ErVy/EP2X6xei+7l+IZrLOyWiebwHInqAdzdED/K+heghzwF76GH+dBA9wh8Fokc9B+yhx7h+IZrP9QvR41y/ED3B9QvRAh4YRE/yKCBq401GtJC3D9FTXL8QPc31C9EzXL8QPcv1C9Fz3AFEi3htiJ7nphG9wO0gepHrF6KXuH4hepnrF6JXuH4hWuy5rQkt4bUhWspNI3rVcwUSeo3rF6JlXL8Qvc71C9EbXL8QtXvu00Jvcv1C9BbXL0QdXL8Qvc31C9E7XL8Qpbl+IVrO9QvRCq5fiN7l+oXoPa5fiN7n+oUow/UL0QdcvxCt5PqFqJPrF6IPuX4h+ojrF6KPuX4h+oTrF6JPuX4hWsX1C9Fqrl+IPuP6haiL6xeiz7l+IfqC6xeiNVy/EK3l+oVoHdcvROu5fiHawPULUTfXL0Rfcv1C9BXXL0QbuX4h+tpzqxv6hj9pRJv4Y0W02XP/GPqW6xei77h+Ifqe6xeiH7h+IdrCg4zoRx5RRFt5+BD9xGOFyCXsiH7m+oXoF65fiLZx/UL0K28Mot+454i2e27BQ79znxDt4EKF6A+uSoj+5BKEaCfXG0S9nsvZ0P94DkRZ/ieinOcqvmYXeoun+IAG2z8o1xB8s2FDZ+fy5ZhrKOTauHHbtp07KdeueNFA91F+v6jZDS8a6D4KkJ9u3cwVW83udOtmLuJqhtmvXdD/8q+meytzI1WjvnRaAnei+nhV1AQRJc2BrqgZoU9hU+YUtgbO/UpCoVgsFgpptKfQxqicqBmpUcSiGo1CFu2Fd3PGK4n2xqs/c5ki0T7YbLrBgzbuS9e85n9i15yGtvByAAtejre+6k5RqLvfmrmiT0Fh0fDozOjwIjhKlWievR+GW8iWFlHzgJjVHq+XeaIz6+EMVuZ6sKUFjrrZXWzN0rKyQYOuu27q1HPOicXQfLvnpr/mHX79rL6xUZPGo25ua7nQd7j6AlcWXCH0pbS+kZboPfsfaXQFNe9TWOj/1vwfK5y7Ag==";
let font: Map<number, Uint8Array> | undefined;
// Characters the screen uses that unscii has no glyph for, drawn as the nearest one it has.
const FONT_STANDINS: Record<string, string> = { "↻": "o", "⇡": "↑", "⏳": "◐", "✗": "×", "✦": "◆", "❯": ">", "␣": "_", "⎇": "Y", "↩": "<", "⏺": "●", "⎿": "└", "✻": "*", "✢": "*", "✳": "*", "✶": "*", "✽": "*", "⏸": "‖", "⏵": "▸" };
/** The state marks drawn as true shapes: the font's circles and diamonds are too narrow at this size to tell from a 0. */
const SHAPES: Record<string, (dx: number, dy: number, d: number) => boolean> = {
  "●": (_x, _y, d) => d <= 3.7,
  "○": (_x, _y, d) => d <= 3.7 && d >= 2.4,
  "◐": (dx, _y, d) => d <= 3.7 && (d >= 2.4 || dx < 0),
  "◑": (dx, _y, d) => d <= 3.7 && (d >= 2.4 || dx > 0),
  "◆": (dx, dy) => Math.abs(dx) + Math.abs(dy) <= 4,
  "◇": (dx, dy) => Math.abs(dx) + Math.abs(dy) <= 4 && Math.abs(dx) + Math.abs(dy) >= 2.6,
  "▲": (dx, dy) => dy >= -3.5 && dy <= 3.5 && Math.abs(dx) <= (dy + 3.5) / 2 + 0.3,
};
const shapeGlyphs = new Map<string, Uint8Array>();
function shapeOf(ch: string): Uint8Array | undefined {
  const test = SHAPES[ch];
  if (!test) return undefined;
  let g = shapeGlyphs.get(ch);
  if (!g) {
    g = new Uint8Array(16);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 8; x++) {
        const dx = x + 0.5 - 4;
        const dy = y + 0.5 - 8.5;
        if (test(dx, dy, Math.hypot(dx, dy))) g[y] |= 0x80 >> x;
      }
    shapeGlyphs.set(ch, g);
  }
  return g;
}
function glyphOf(ch: string): Uint8Array | undefined {
  ch = FONT_STANDINS[ch] ?? ch;
  const shape = shapeOf(ch);
  if (shape) return shape;
  if (!font) {
    font = new Map();
    const raw = inflateSync(Buffer.from(FONT_B64, "base64"));
    for (let i = 0; i + 19 <= raw.length; i += 19) font.set((raw[i] << 16) | (raw[i + 1] << 8) | raw[i + 2], raw.subarray(i + 3, i + 19));
  }
  return font.get(ch.codePointAt(0)!) ?? font.get(0x3f);
}
/** A PNG of `w` by `h` pixels from RGB bytes, row by row. */
export function pngOf(w: number, h: number, rgb: Uint8Array, channels: 3 | 4 = 3): Buffer {
  const row = w * channels;
  const raw = Buffer.alloc((row + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * row, (y + 1) * row), y * (row + 1) + 1);
  const table = Array.from({ length: 256 }, (_, k) => {
    let c = k;
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}
const BASIC16: RGB[] = [[0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16], [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229], [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67], [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255]];
/** An xterm 256-colour number as RGB. */
export function x256(n: number): RGB {
  if (n < 16) return BASIC16[n] ?? C.text;
  if (n < 232) {
    const steps = [0, 95, 135, 175, 215, 255];
    const i = n - 16;
    return [steps[Math.floor(i / 36) % 6], steps[Math.floor(i / 6) % 6], steps[i % 6]];
  }
  const g = 8 + (n - 232) * 10;
  return [g, g, g];
}
export interface Cell {
  ch: string;
  fg: RGB;
  bg?: RGB;
  bold: boolean;
}
const PICTURE_BG: RGB = [13, 17, 23];
/** One screen row's characters with their colours, from the escape codes fleet writes. */
export function cellsOf(line: string): Cell[] {
  const cells: Cell[] = [];
  const cps = [...line];
  let fgc: RGB = C.text;
  let bgc: RGB | undefined;
  let b = false;
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i];
    if (ch !== "\x1b") {
      cells.push({ ch, fg: fgc, bg: bgc, bold: b });
      continue;
    }
    if (cps[i + 1] === "]") {
      // A link or a title: skipped to its end (BEL, or ESC \).
      let j = i + 2;
      while (j < cps.length && cps[j] !== "\x07" && !(cps[j] === "\x1b" && cps[j + 1] === "\\")) j++;
      i = cps[j] === "\x07" ? j : j + 1;
      continue;
    }
    if (cps[i + 1] !== "[") {
      i++;
      continue;
    }
    let j = i + 2;
    while (j < cps.length && !/[A-Za-z]/.test(cps[j])) j++;
    if (cps[j] === "m") {
      const p = cps.slice(i + 2, j).join("").split(";").map((x) => Number(x) || 0);
      for (let k = 0; k < p.length; k++) {
        const v = p[k];
        if (v === 0) [fgc, bgc, b] = [C.text, undefined, false];
        else if (v === 1) b = true;
        else if (v === 22) b = false;
        else if (v === 39) fgc = C.text;
        else if (v === 49) bgc = undefined;
        else if ((v === 38 || v === 48) && p[k + 1] === 2) {
          const c: RGB = [p[k + 2], p[k + 3], p[k + 4]];
          if (v === 38) fgc = c;
          else bgc = c;
          k += 4;
        } else if ((v === 38 || v === 48) && p[k + 1] === 5) {
          // Claude's own screen uses the 256-colour palette too.
          const c = x256(p[k + 2]);
          if (v === 38) fgc = c;
          else bgc = c;
          k += 2;
        } else if ((v >= 30 && v <= 37) || (v >= 90 && v <= 97)) fgc = x256(v >= 90 ? v - 82 : v - 30);
        else if ((v >= 40 && v <= 47) || (v >= 100 && v <= 107)) bgc = x256(v >= 100 ? v - 92 : v - 40);
      }
    }
    i = j;
  }
  return cells;
}
/** Screen rows drawn as a PNG, `cols` characters wide. */
export function pictureOf(lines: string[], cols: number, scale = 2): Buffer {
  const r = rasterOf(lines, cols, scale);
  return pngOf(r.W, r.H, r.px);
}
/** Screen rows drawn as RGB pixels, on `bg`. */
export function rasterOf(lines: string[], cols: number, scale = 2, bg: RGB = PICTURE_BG): { px: Uint8Array; W: number; H: number } {
  const CW = 8 * scale;
  const CH = 16 * scale;
  const W = cols * CW;
  const H = Math.max(1, lines.length) * CH;
  const px = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) px.set(bg, i * 3);
  const fill = (x0: number, y0: number, w: number, h: number, c: RGB) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px.set(c, (y * W + x) * 3);
  };
  lines.forEach((line, row) => {
    cellsOf(line)
      .slice(0, cols)
      .forEach((cell, col) => {
        const x0 = col * CW;
        const y0 = row * CH;
        if (cell.bg) fill(x0, y0, CW, CH, cell.bg);
        if (cell.ch === " ") return;
        const g = glyphOf(cell.ch);
        if (!g) return;
        for (let y = 0; y < 16; y++)
          for (let x = 0; x < 8; x++) {
            const on = (g[y] & (0x80 >> x)) !== 0 || (cell.bold && x > 0 && (g[y] & (0x80 >> (x - 1))) !== 0);
            if (on) fill(x0 + x * scale, y0 + y * scale, scale, scale, cell.fg);
          }
      });
  });
  return { px, W, H };
}
/** The fleet as a picture: every session, or one focused as a click on it would, in the detail view. */
export function fleetPicture(sessions: Session[], now: number, focus?: string, cols = 110, rows = 44): Buffer {
  const was = { focusSid, mode: opt.mode };
  focusSid = focus ?? null;
  opt.mode = "detail";
  try {
    const lines = render(sessions, cols, rows, now);
    while (lines.length > 1 && !lines[lines.length - 2]?.replace(/\x1b\[[0-9;]*m/g, "").trim()) lines.splice(lines.length - 2, 1); // no empty rows above the buttons
    return pictureOf(lines.slice(0, -1), cols); // and no buttons
  } finally {
    focusSid = was.focusSid;
    opt.mode = was.mode;
  }
}
/** Just the top of the screen: this machine, its usage and the fleet's activity, as a picture. */
export function headerPicture(now: number, cols = 110): Buffer {
  const lines = render([], cols, 14, now);
  const end = lines.findIndex((l, i) => i > 2 && /─{6}/.test(l.replace(/\x1b\[[0-9;]*m/g, "")));
  return pictureOf(lines.slice(0, end > 0 ? end + 1 : 8), cols);
}

// ───────────────────────── in the background ─────────────────────────
// Fleet can run with no screen, as a service started when you log in: it scans, serves the phone page and the
// other machines, and runs the Telegram bot, with every fleet window closed. `--serve` is a small supervisor that
// runs the screenless fleet (`--serve-worker`) and starts it again whenever it stops: after a crash, and after
// fleet.ts changes (a git pull), which the worker notices and stops for, so it always runs the code on disk.
// Key i installs it the way each system starts things at login: a launchd agent on macOS, a systemd user service
// on Linux, a hidden script in the Startup folder on Windows. Always as you, never as an administrator.

const svcDir = () => path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "claude-fleet");
export const svcLogPath = () => path.join(svcDir(), "service.log");
const svcPidPath = (which: "service" | "worker") => path.join(svcDir(), `${which}.pid`);
const SVC_LOG_MAX = 1_000_000;
/** A line in the service log, which is kept under a megabyte (the one before is kept as service.log.1). */
export function svcLog(text: string) {
  try {
    fs.mkdirSync(svcDir(), { recursive: true });
    const file = svcLogPath();
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > SVC_LOG_MAX) fs.renameSync(file, file + ".1");
    fs.appendFileSync(file, `${new Date().toISOString().slice(0, 19).replace("T", " ")}  ${safeLine(text).slice(0, 500)}\n`);
  } catch {}
}
const readPid = (which: "service" | "worker") => {
  try {
    const pid = Number(fs.readFileSync(svcPidPath(which), "utf8"));
    return pid > 0 && alive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
};
const writePid = (which: "service" | "worker", pid: number) => {
  try {
    fs.mkdirSync(svcDir(), { recursive: true });
    fs.writeFileSync(svcPidPath(which), String(pid));
  } catch {}
};

let isServiceWorker = false; // this process is the background service's fleet
/** Whether fleet runs in the background on this machine (and this is not it): then it serves the page and the bot. */
export const serviceRunning = (): boolean => !isServiceWorker && !!readPid("service");
/** A fleet window whose fleet.ts has changed since it started is out of date: it says so, until it is restarted. */
const startedMtime = (() => {
  try {
    return fs.statSync(import.meta.path).mtimeMs;
  } catch {
    return 0;
  }
})();
export let staleSince = 0;
export function staleCheck(now = clock()) {
  if (isServiceWorker || !startedMtime) return; // the service restarts itself onto new code
  try {
    if (!staleSince && fs.statSync(import.meta.path).mtimeMs !== startedMtime) staleSince = now;
  } catch {}
  if (staleSince) Object.assign(notice, { text: "fleet updated: q, then fleet, to restart", until: now + 12_000 });
}
/** --serve: keep the screenless fleet running, starting it again whenever it stops. */
export async function serveSupervisor(): Promise<never> {
  svcLog(`service started (pid ${process.pid}, ${process.platform})`);
  writePid("service", process.pid);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const stop = () => {
    svcLog("service stopping");
    try {
      child?.kill();
    } catch {}
    process.exit(0);
  };
  for (const sig of process.platform === "win32" ? (["SIGINT", "SIGBREAK"] as const) : (["SIGINT", "SIGTERM", "SIGHUP"] as const))
    try {
      process.on(sig, stop);
    } catch {}
  let quick = 0;
  for (;;) {
    const t0 = Date.now();
    child = Bun.spawn([process.execPath, import.meta.path, "--serve-worker"], { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: process.env, windowsHide: true } as any);
    writePid("worker", child.pid);
    const err = new Response(child.stderr as ReadableStream).text();
    const code = await child.exited;
    const tail = (await err).trim().split("\n").slice(-4).join(" | ");
    svcLog(`fleet stopped (exit ${code})${tail ? `: ${tail}` : ""}`);
    // Five quick failures in a row: something is wrong that a restart will not fix, so wait a minute between tries.
    quick = Date.now() - t0 < 10_000 && code !== 0 ? quick + 1 : 0;
    await pause(quick >= 5 ? 60_000 : code === 0 ? 300 : 3000);
  }
}

/** --serve-worker: fleet with no screen. */
export async function serveWorker(): Promise<never> {
  setScanBudget(300); // the page and the bot answer from the first moment, the sessions filling in as they are read
  useScanThread(); // and the reading is done on a thread of its own
  isServiceWorker = true;
  opt.bell = false;
  svcLog(`fleet running with no screen (pid ${process.pid})`);
  process.on("uncaughtException", (e: any) => {
    svcLog(`crashed: ${String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ")}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (e: any) => svcLog(`unhandled: ${String(e?.message ?? e)}`));
  if (process.env.FLEET_WEB !== "0") startWeb(() => sessions);
  peersWanted = true;
  tgWanted = true;
  tg.getSessions = () => sessions;
  tgClaim();
  if (opt.usage) {
    await fetchUsage().catch(() => {});
    const u = accountView(clock());
    svcLog(u.kind === "current" ? "usage figures read" : `usage figures not read: ${u.reason || u.kind}`);
  }
  refresh();
  // Every two seconds, as the terminal does; twice a second while the phone page or the glasses are looking. Never
  // back to back: after a scan the thread rests at least half as long again, so with huge sessions the page and the
  // bot still get their turn. A scan over a second is logged (at most every five minutes) with what took the time.
  let slowSaid = 0, scanning = false, lastScanMs = 0;
  const pace = async () => {
    scanning = true;
    await refresh(true);
    scanning = false;
    const took = (lastScanMs = refreshLaps.reduce((n, [, ms]) => n + ms, 0)); // its own time, not the answers given between its steps
    if (took > 400 && Date.now() - slowSaid > 30_000) {
      slowSaid = Date.now();
      svcLog(`a scan took ${Math.round(took)} ms: ${refreshLaps.filter(([, ms]) => ms >= 20).map(([n, ms]) => `${n} ${Math.round(ms)} ms`).join(", ") || "no one step"}`);
    }
    if (scanPending) return void setTimeout(pace, 50); // sessions still to read: on with them
    setTimeout(pace, Math.max(web.links > 0 || Date.now() - web.watchedAt < 10_000 ? 500 : 2000, took * 1.5));
  };
  setTimeout(pace, 500);
  // A watchdog: a timer that should fire every 100 ms. When it fires late the thread was held, by a scan or by
  // something else (a reply to the bot, a request), and the log says which, at most every 30 s.
  let tickAt = performance.now(), heldSaid = 0;
  setInterval(() => {
    const late = performance.now() - tickAt - 100;
    tickAt = performance.now();
    if (late > 300 && Date.now() - heldSaid > 30_000) {
      heldSaid = Date.now();
      svcLog(`the thread was held ${Math.round(late)} ms${Math.max(0, ...refreshLaps.map(([, ms]) => ms)) > late * 0.6 ? ` by a scan (${Math.round(lastScanMs)} ms: ${refreshLaps.filter(([, ms]) => ms >= 20).map(([n, ms]) => `${n} ${Math.round(ms)}`).join(", ")})` : " by something other than a scan"}`);
    }
  }, 100);
  // Back to the code on disk when any of it changes (fleet.ts, accounts.ts…): stop, and the supervisor starts the new one.
  const code = () => fs.readdirSync(import.meta.dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "demo.ts");
  const stamp = () => code().map((f) => `${f}:${fs.statSync(path.join(import.meta.dir, f)).mtimeMs}`).join(" ");
  const born = stamp();
  setInterval(() => {
    try {
      const now = stamp();
      if (now !== born) {
        const changed = code().filter((f) => !born.includes(`${f}:${fs.statSync(path.join(import.meta.dir, f)).mtimeMs}`));
        svcLog(`${changed.join(", ") || "the code"} changed: restarting onto the new code`);
        tgRelease();
        process.exit(0);
      }
    } catch {}
  }, 10_000);
  // A line in the log whenever what it is doing changes.
  let said = "";
  const report = () => {
    const now = [web.server && !web.shared ? `serving ${web.url?.replace(/\?t=.*/, "")}` : web.shared ? "another fleet serves the page" : web.error ?? "no page", tg.on ? "talking to the Telegram bot" : readTg().token ? "another fleet talks to the bot" : "no Telegram bot", `${peers.size ? [...peers.values()].filter((p) => p.at).length : 0} other machines`, `${sessions.filter((s) => !s.remote).length} sessions here`].join(" · ");
    if (now !== said) svcLog((said = now));
  };
  setTimeout(report, 5000);
  setInterval(report, 30_000);
  // Started while Tailscale was down or updating, the page is on this Mac only: move it onto the tailnet once it is back.
  setInterval(() => {
    if (!web.server || web.shared || web.onTailnet || process.env.FLEET_WEB_HOST || !tailnetAddress()) return;
    svcLog("Tailscale is up: moving the page onto it");
    web.server.stop(true);
    for (const k of ["server", "url", "host", "onTailnet", "error"] as const) delete web[k];
    startWeb(() => sessions);
    report();
  }, 30_000);
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    try {
      process.on(sig, () => {
        tgRelease();
        process.exit(0);
      });
    } catch {}
  return new Promise<never>(() => {});
}

// ── installing it ──
export const SVC_LABEL = "com.answertree.claude-fleet";
type SvcPlace = { kind: "launchd" | "systemd" | "startup"; file: string };
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Where this system starts things at login, for fleet. */
export function svcPlace(label = SVC_LABEL, platform = process.platform): SvcPlace | undefined {
  if (platform === "darwin") return { kind: "launchd", file: path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`) };
  if (platform === "linux") return { kind: "systemd", file: path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user", `${label === SVC_LABEL ? "claude-fleet" : label}.service`) };
  if (platform === "win32") return { kind: "startup", file: path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${label === SVC_LABEL ? "Claude Fleet" : label}.vbs`) };
  return undefined;
}
/** The file that starts fleet at login, for each system. */
export function svcFile(kind: SvcPlace["kind"], label: string, bun: string, fleet: string, env: Record<string, string>): string {
  if (kind === "launchd")
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(bun)}</string><string>${xml(fleet)}</string><string>--serve</string></array>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(env)
    .map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join("")}</dict>
  <key>WorkingDirectory</key><string>${xml(os.homedir())}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${xml(svcLogPath())}</string>
</dict>
</plist>
`;
  const q = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`;
  if (kind === "systemd")
    return `[Unit]
Description=Claude Fleet, with no screen
After=network-online.target

[Service]
ExecStart=${q(bun)} ${q(fleet)} --serve
Restart=always
RestartSec=5
${Object.entries(env)
  .map(([k, v]) => `Environment=${q(`${k}=${v}`)}`)
  .join("\n")}

[Install]
WantedBy=default.target
`;
  // A VBScript run at logon from the Startup folder: window style 0 keeps it out of sight. Quotes inside are doubled.
  const vb = (s: string) => s.replace(/"/g, '""');
  return `' Claude Fleet, with no screen: started when you log in. Remove it with key i in fleet.\r\nCreateObject("WScript.Shell").Run """${vb(bun)}"" ""${vb(fleet)}"" --serve", 0, False\r\n`;
}
export interface SvcState {
  supported: boolean;
  installed: boolean;
  running?: number; // the service's pid
  file?: string;
}
export function svcState(label = SVC_LABEL): SvcState {
  const place = svcPlace(label);
  if (!place) return { supported: false, installed: false };
  return { supported: true, installed: fs.existsSync(place.file), running: readPid("service"), file: place.file };
}
const run1 = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000 });
/** Install the service and start it now. `env` and `label` are for tests. */
export function svcInstall(o: { label?: string; env?: Record<string, string> } = {}): { ok: boolean; text: string } {
  const label = o.label ?? SVC_LABEL;
  const place = svcPlace(label);
  if (!place) return { ok: false, text: `fleet does not know how to start things at login on ${process.platform}` };
  const bun = process.execPath;
  const fleet = import.meta.path;
  const env = { PATH: process.env.PATH ?? "", HOME: os.homedir(), ...(o.env ?? {}) };
  try {
    fs.mkdirSync(path.dirname(place.file), { recursive: true });
    fs.mkdirSync(svcDir(), { recursive: true });
    fs.writeFileSync(place.file, svcFile(place.kind, label, bun, fleet, env));
  } catch (e: any) {
    return { ok: false, text: `could not write ${place.file}: ${e?.message ?? e}` };
  }
  if (place.kind === "launchd") {
    const uid = process.getuid?.() ?? 0;
    run1("launchctl", ["bootout", `gui/${uid}/${label}`]);
    const r = run1("launchctl", ["bootstrap", `gui/${uid}`, place.file]);
    if (r.status !== 0) return { ok: false, text: `launchctl would not start it: ${safeLine(r.stderr || r.stdout || "").slice(0, 160)}` };
  } else if (place.kind === "systemd") {
    const unit = path.basename(place.file);
    run1("systemctl", ["--user", "daemon-reload"]);
    const r = run1("systemctl", ["--user", "enable", "--now", unit]);
    if (r.status !== 0) return { ok: false, text: `systemctl would not start it: ${safeLine(r.stderr || "").slice(0, 160)}` };
    // So it keeps running while you are logged out (allowed for your own user on most systems).
    const linger = run1("loginctl", ["enable-linger", os.userInfo().username]);
    if (linger.status !== 0) svcLog("loginctl enable-linger failed: it runs while you are logged in");
  } else {
    try {
      const p = spawn("wscript.exe", [place.file], { detached: true, stdio: "ignore" });
      p.unref();
    } catch (e: any) {
      return { ok: false, text: `installed, but could not start it now: ${e?.message ?? e}` };
    }
  }
  svcLog(`installed (${place.kind}: ${place.file})`);
  return { ok: true, text: `installed: it starts when you log in, and is starting now` };
}
/** Stop the service and remove it. */
export function svcUninstall(o: { label?: string } = {}): { ok: boolean; text: string } {
  const label = o.label ?? SVC_LABEL;
  const place = svcPlace(label);
  if (!place) return { ok: false, text: "nothing to remove here" };
  if (place.kind === "launchd") run1("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${label}`]);
  else if (place.kind === "systemd") run1("systemctl", ["--user", "disable", "--now", path.basename(place.file)]);
  // The supervisor and its fleet, wherever they were started from.
  for (const which of ["service", "worker"] as const) {
    const pid = readPid(which);
    if (pid && pid !== process.pid)
      try {
        process.kill(pid);
      } catch {}
  }
  try {
    fs.rmSync(place.file, { force: true });
  } catch {}
  svcLog("removed");
  return { ok: true, text: "removed: it is stopped and will not start at login" };
}

let svcOn = false; // key i: the background service screen is showing
let svcSaid = ""; // what the last y did, for the screen
/** Key i: whether fleet runs in the background, its log, and y to install or remove it. */
export function svcScreen(cols: number, rows: number): string[] {
  const W = Math.max(40, cols);
  const st = svcState();
  const out: string[] = ["", fg(C.cyan, bold("  ◆ CLAUDE FLEET")) + fg(C.white, " in the background"), ""];
  const say = (t: string, c: RGB = C.text) => out.push(fg(c, "  " + t));
  if (!st.supported) say(`Not available on ${process.platform}.`, C.red);
  else {
    say(st.running ? `● Running (pid ${st.running}).` : st.installed ? "◐ Installed, but not running right now." : "○ Not installed.", st.running ? C.green : st.installed ? C.amber : C.dim);
    out.push("");
    say("With it, fleet keeps working with every window closed: it serves the phone page and your other machines,");
    say("and the Telegram bot keeps you posted. It starts when you log in, and restarts itself after a crash or a");
    say("git pull. Any fleet window you open just shows the screen.");
    if (st.file) say(`Started from ${st.file.replace(os.homedir(), "~")}`, C.dim);
    say(`Log: ${svcLogPath().replace(os.homedir(), "~")}`, C.dim);
    out.push("");
    try {
      const log = fs.readFileSync(svcLogPath(), "utf8").trimEnd().split("\n").slice(-8);
      for (const l of log) say(l, C.dim);
    } catch {}
    if (svcSaid) out.push("", fg(C.white, "  " + svcSaid));
  }
  while (out.length < rows - 1) out.push("");
  out.length = Math.max(0, rows - 1);
  out.push(fg(C.dim, fit(st.supported ? (st.installed ? "  y removes it · any other key returns" : "  y installs it · any other key returns") : "  any key returns", W)));
  return out.map((l) => clipRow(l, W));
}
/** A key on the i screen. Returns false when the screen should close. */
export function svcKey(key: string): boolean {
  if (key !== "y") return false;
  const st = svcState();
  if (!st.supported) return false;
  const r = st.installed ? svcUninstall() : svcInstall();
  svcSaid = (r.ok ? "✓ " : "✗ ") + r.text;
  return true;
}

// ───────────────────────── the splash ─────────────────────────
// While fleet starts (its first read of every transcript can take a while on a busy machine) it shows its logo and
// what it is doing. The first read blocks, so the splash is written straight to the terminal, between sessions.

/** The fleet F in cells: # is the letter, the prompts sit in its arms, / is a slanted end. */
const LOGO_MASK = [
  "####################/",
  "###..>_..#########/",
  "###",
  "##############/",
  "###..>_..####/",
  "###",
  "###",
  "###",
];
const LOGO_W = Math.max(...LOGO_MASK.map((r) => r.length));
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
/** The icon's gradient: blue to cyan along the top arm, cyan to green along the middle one, blue to violet down the stem. */
function logoColour(r: number, c: number): RGB {
  if (r <= 1) return mix([30, 107, 255], [95, 243, 255], clamp01(c / (LOGO_W - 1)));
  if (r === 3 || r === 4) return c < 3 ? [31, 138, 235] : mix([24, 168, 224], [60, 240, 138], clamp01((c - 3) / 12));
  return mix([31, 123, 255], [123, 60, 255], clamp01((r - 2) / (LOGO_MASK.length - 2)));
}
/** The logo; with `shine` (0 to 1 through a sweep), a slanted streak of light crosses the F, the letter only. */
export function logoRows(shine?: number): string[] {
  const SLANT = 1.4, HALF = 2.2; // the streak leans like the web splash's (cells are twice as tall as wide), and is this wide
  const from = -SLANT * LOGO_MASK.length - HALF, to = LOGO_W + HALF;
  const at = shine === undefined ? undefined : from + (to - from) * shine;
  return LOGO_MASK.map((row, r) => {
    let out = "";
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      const glow = at === undefined ? 0 : clamp01(1 - Math.abs(c + r * SLANT - at) / HALF) ** 1.5 * 0.85;
      const [cr, cg, cb] = glow ? mix(logoColour(r, c), [255, 255, 255], glow) : logoColour(r, c);
      if (ch === "/") out += fg([cr, cg, cb], "◤");
      else if (ch === ">" || ch === "_") out += `\x1b[48;2;${cr};${cg};${cb}m\x1b[1m${fg([255, 255, 255], ch)}\x1b[22m\x1b[49m`;
      else out += `\x1b[48;2;${cr};${cg};${cb}m \x1b[49m`;
    }
    return out + " ".repeat(LOGO_W - row.length);
  });
}
/** The splash: the logo, the name, what fleet is doing, and how far through the sessions it is. */
export function splashScreen(cols: number, rows: number, doing: string, done = 0, total = 0, shine?: number): string[] {
  const W = Math.max(30, cols);
  const centre = (s: string, w: number) => " ".repeat(Math.max(0, Math.floor((W - w) / 2))) + s;
  const BAR = 30;
  const filled = total ? Math.round((done / total) * BAR) : 0;
  const body = [
    ...logoRows(shine).map((l) => centre(l, LOGO_W)),
    "",
    centre(fg(C.white, bold("C L A U D E   F L E E T")), 23),
    "",
    centre(fg(C.dim, cutTo(doing, Math.min(60, W - 4))), width(cutTo(doing, Math.min(60, W - 4)))),
    total ? centre(fg(C.cyan, "━".repeat(filled)) + fg(C.faint, "─".repeat(BAR - filled)) + fg(C.dim, ` ${done}/${total}`), BAR + 1 + `${done}/${total}`.length) : "",
  ];
  const top = Math.max(0, Math.floor((rows - body.length) / 2));
  const out = [...Array(top).fill(""), ...body];
  while (out.length < rows) out.push("");
  return out.slice(0, rows).map((l) => clipRow(l, W));
}
/** The splash's streak: a quick sweep, again every 1.6 s while fleet is still starting; undefined between sweeps. */
export const SHINE_MS = 650;
export const shineAt = (ms: number): number | undefined => (ms % 1600 < SHINE_MS ? (ms % 1600) / SHINE_MS : undefined);
/** Called by the scan as it reads each session, while the splash is up. */
export let scanProgress: ((done: number, total: number, name: string) => void) | undefined;
export const setScanProgress = (f: typeof scanProgress) => (scanProgress = f);

// ───────────────────────── on your glasses ─────────────────────────
// Even Realities G2 glasses run apps as web pages: the Even app on your phone opens the page and draws what it
// asks for on the glasses (576 by 288, sixteen shades of green), and passes back taps, double taps and ring
// scrolls. Fleet serves that page at /glasses, with the same secret and over the same tailnet as the phone page;
// key w, then g, shows its QR code for the Even app to scan. The page uses Even's SDK (MIT, vendor/).

const GLASSES_SDK = path.join(import.meta.dir, "vendor", "even_hub_sdk.js");
let glassesSdk: Buffer | null | undefined;
const glassesSdkFile = () => {
  if (glassesSdk === undefined)
    try {
      glassesSdk = fs.readFileSync(GLASSES_SDK);
    } catch {
      glassesSdk = null;
    }
  return glassesSdk;
};
/** Text the glasses can draw: their font has no ✓ ✗ ⇡ ↻ ≡ ⏳ or spinner, and silently drops what it lacks. */
export const glassesSafe = (s: string) =>
  s
    .replace(/[✓✔]\s*/g, "") // no tick in their font: the word beside it says it
    .replace(/✗|✘/g, "x")
    .replace(/[⇡↗]/g, "↑")
    .replace(/↻/g, "~")
    .replace(/≡/g, "=")
    .replace(/[⏳⌛]/g, "◐")
    .replace(/[⠀-⣿]/g, "●")
    .replace(/[^\x20-\x7e -ÿ‐-‧←-↙─-◿☀-⛿]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
/** A session's numbers for the glasses' graphs: activity, context over time, tasks, workflows, agents, pull requests. */
function chartOf(s: ReturnType<typeof webState>["sessions"][number], full: Session | undefined, now: number, win: Win) {
  const main = full ? factsOf(full).main : undefined;
  const top = main?.ctx ? ctxMax(main.ctx) : 0;
  return {
    spark: s.spark,
    out: full ? human(tokensIn(tailsOf(full), win)) : "",
    tools: s.tools,
    // Context over the last quarter hour, as [how far along (0 to 1), how full (0 to 1)].
    ctx: top && main ? main.ctxLog.map(([t, used]) => [Math.round(Math.max(0, 1 - (now - t) / CTX_LOG_MS) * 1000) / 1000, Math.round(Math.min(1, used / top) * 1000) / 1000]) : [],
    tasks: s.tasks ? { done: s.tasks.done, doing: s.tasks.open.filter((t) => t.status === "in_progress").length, total: s.tasks.total } : undefined,
    workflows: s.roster.workflows.filter((w) => w.outcome === "running").slice(0, 3).map((w) => ({ name: glassesSafe(w.name), phase: glassesSafe(w.phases.find((p) => p.state === "now")?.name ?? ""), done: w.done, doing: w.doing, total: w.total })),
    agents: [...s.roster.workflows.filter((w) => w.outcome === "running").flatMap((w) => w.agents), ...s.roster.agents].filter((a) => a.state !== "done").slice(0, 6).map((a) => ({ label: glassesSafe(a.label), state: a.state, spark: a.spark })),
    prs: (full?.side?.prs ?? []).slice(0, 3).map((pr) => {
      const st = prState.get(`${pr.repo}#${pr.number}`)?.state;
      return { n: pr.number, state: st?.state ?? "", pass: st?.pass ?? 0, fail: st?.fail ?? 0, pending: st?.pending ?? 0 };
    }),
  };
}
/** The roster in lines the glasses can draw: each workflow with up to four of its agents, then other agents. */
function glassesRoster(r: ReturnType<typeof rosterOfView>): string[] {
  const mark = (st: string) => (st === "active" ? "●" : st === "tool" ? "◐" : st === "stalled" ? "◐!" : st === "done" ? "■" : "○");
  const agent = (a: ReturnType<typeof rosterOfView>["agents"][number], indent = "") => indent + glassesSafe(`${mark(a.state)} ${a.label}: ${a.tool ? `${a.tool} ${a.doing}` : a.doing}`).slice(0, 90);
  const out: string[] = [];
  for (const w of r.workflows) {
    const now = w.phases.find((p) => p.state === "now")?.name;
    out.push(glassesSafe(`${w.outcome === "running" ? "=" : w.outcome === "completed" ? "■" : "x"} ${w.name}${now ? ` · ${now}` : w.outcome === "completed" ? " · done" : ` · ${w.status ?? "failed"}`} · ${w.done}/${w.total}${w.tokens ? ` · ${w.tokens} tok` : ""}`));
    for (const a of w.agents.slice(0, 4)) out.push(agent(a, "  "));
    if (w.agents.length > 4) out.push(`  + ${w.agents.length - 4} more`);
  }
  for (const a of r.agents.slice(0, 4)) out.push(agent(a));
  if (r.agents.length > 4) out.push(`+ ${r.agents.length - 4} more agents`);
  return out;
}
const GLASSES_MARK: Record<string, string> = { needs: "▲", stalled: "◐", working: "●", justDone: "■", yourTurn: "▶", idle: "○", finished: "○" };
/** Everything the glasses page shows, in plain, short, drawable text. */
export function glassesState(sessions: Session[], now: number) {
  const st = webState(sessions, now);
  const order = ["needs", "stalled", "working", "justDone", "yourTurn", "idle", "finished"];
  const five = fiveHourLine(now);
  const week = st.account?.limits.find((l) => /7|week/i.test(l.label));
  const win = laneWindow(now, 150);
  return {
    clock: new Date(now).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
    counts: st.counts,
    // For the glasses' header: the five-hour forecast, always; the week; this machine; how many machines.
    header: { five: glassesSafe(five.text), urgent: five.urgent, week: week ? week.pct : undefined, cpu: st.machine.cpu, mem: st.machine.mem, machines: manyMachines() ? peers.size + 1 : 1, window: opt.windowMin },
    sessions: [...st.sessions]
      .sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state))
      .map((s) => {
        const full = sessions.find((x) => x.sid === s.sid);
        const said = s.talk.filter((t) => t.who === "claude").at(-1);
        return {
          sid: s.sid,
          name: glassesSafe(s.name),
          host: full ? machineOf(full) : undefined,
          state: s.state,
          mark: GLASSES_MARK[s.state] ?? "○",
          word: glassesSafe(s.word),
          time: glassesSafe(s.time ?? ""),
          needs: s.needs ? glassesSafe(capText(flatReply(s.needs), 400)) : undefined,
          now: glassesSafe(capText(s.sub.text || "", 300)),
          ctx: s.ctx ? { pct: s.ctx.pct, max: s.ctx.max, runway: s.ctx.runway ? glassesSafe(s.ctx.runway) : undefined } : undefined,
          tasks: s.tasks?.total ? `${s.tasks.done}/${s.tasks.total}` : undefined,
          doing: s.tasks?.open.find((t) => t.status === "in_progress")?.text,
          agents: s.agents.length,
          fails: s.fails?.n,
          prs: s.prs.map((p) => glassesSafe(segText(p))),
          said: said ? glassesSafe(capText(said.text, 500)) : undefined,
          roster: glassesRoster(s.roster),
          // What the phone draws the graphs from.
          chart: chartOf(s, full, now, win),
        };
      }),
  };
}

/**
 * The five-hour limit in one line, whatever is known: when it fills at this pace ("full ~16:40, in ~2h"), or where
 * it will be at the reset ("~64% by 18:00"), or that it is full, or that there are no figures.
 */
/** When the five-hour limit runs out, said in a line, with the parts for the phone page to lay out:
 *  `kind` is "full" (out now), "out" (runs out before the reset), "lasts" (lasts to the reset) or "steady" (too early to tell);
 *  the times are on this Mac's clock, `inText` is how long until it runs out (or, when full, until the reset),
 *  `gap` how long without tokens before the reset, `by` where it will be at the reset, and `start`/`out`/`resets` the timeline in ms. */
export type FiveHour = { text: string; urgent: boolean; kind?: "full" | "out" | "lasts" | "steady"; outAt?: string; resetAt?: string; inText?: string; gap?: string; by?: number; start?: number; out?: number; resets?: number; now?: number };
export function fiveHourLine(now = clock(), acct: AccountView | undefined = opt.usage ? accountView(now) : undefined): FiveHour {
  const l = acct?.limits.find((x) => x.windowMs === 5 * 3600_000) ?? acct?.limits[0];
  if (!l) return { text: `5h: no usage figures${acct?.reason ? ` (${glassesSafe(acct.reason).slice(0, 30)})` : ""}`, urgent: false };
  const pct = Math.round(l.pct);
  const at = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const line = { now, resets: l.resetsAt, start: l.resetsAt ? l.resetsAt - l.windowMs : undefined, resetAt: l.resetsAt ? at(l.resetsAt) : undefined };
  const out = (t: number, text: string): FiveHour => ({ text, urgent: true, kind: "out", ...line, out: t, outAt: at(t), inText: roughly((t - now) / 60_000), gap: l.resetsAt && l.resetsAt > t ? roughly((l.resetsAt - t) / 60_000) : undefined });
  if (pct >= 100) return { text: `5h full · resets ${l.resetsAt ? at(l.resetsAt) : "soon"}`, urgent: true, kind: "full", ...line, inText: l.resetsAt ? roughly((l.resetsAt - now) / 60_000) : undefined };
  if (l.fullIn) return out(now + l.fullIn, `5h ${pct}% · full ~${at(now + l.fullIn)}, in ~${roughly(l.fullIn / 60_000)}`);
  const tick = l.tick ?? 0;
  if (tick > 0.03 && pct > 0 && l.resetsAt) {
    const toFull = ((100 - pct) / pct) * tick * l.windowMs;
    if (now + toFull < l.resetsAt) return out(now + toFull, `5h ${pct}% · on pace to fill ~${at(now + toFull)}`);
    const by = Math.min(99, Math.round(pct / tick));
    return { text: `5h ${pct}% · ~${by}% by ${at(l.resetsAt)} reset`, urgent: false, kind: "lasts", by, ...line };
  }
  return { text: `5h ${pct}%${l.resetsAt ? ` · resets ${at(l.resetsAt)}` : ""}`, urgent: false, kind: "steady", ...line };
}

export const GLASSES_PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Claude Fleet</title>
<style>body{margin:0;padding:24px;background:#000;color:#4be37a;font:16px/1.5 -apple-system,system-ui,sans-serif}h1{font-size:17px;margin:0 0 12px}p{margin:6px 0;color:#9adbb0}
#setup{margin-top:22px;padding:14px;border:1px solid #1f4d2e;border-radius:12px}#setup h2{font-size:15px;margin:0 0 10px;color:#4be37a}#setup label{display:block;font-size:13px;color:#9adbb0;margin-bottom:4px}
#setup select{width:100%;font:15px -apple-system,system-ui,sans-serif;padding:8px;border-radius:8px;background:#0b1a10;color:#d8f5e1;border:1px solid #1f4d2e}#setup .row{display:flex;gap:8px;margin-top:12px}
#setup button{flex:1;font:600 14px -apple-system,system-ui,sans-serif;padding:9px;border-radius:9px;border:0;background:#4be37a;color:#03140a}#setup button.quiet{background:#13301d;color:#9adbb0}#conn{font-size:13px}</style>
</head><body>
<h1>◆ Claude Fleet on your glasses</h1>
<p id="s">Waiting for the Even app…</p>
<p>The ring moves between sessions, a tap opens one, a double tap goes back.</p>
<div id="setup" hidden>
<h2>Setup</h2>
<label for="base">Fleet on your Mac (its Tailscale address)</label>
<select id="base"></select>
<p id="conn"></p>
<div class="row"><button id="save">Save and reconnect</button><button id="forget" class="quiet">Forget pairing</button></div>
</div>
<script type="module">
import { waitForEvenAppBridge, TextContainerProperty, ListContainerProperty, ListItemContainerProperty, ImageContainerProperty, ImageRawDataUpdate, CreateStartUpPageContainer, RebuildPageContainer, TextContainerUpgrade, OsEventTypeList as E } from "/glasses/sdk.js";
// Opened from fleet (the QR code) the secret is in the address and fleet is where the page came from. Installed from
// Even Hub, fleet's address is written in when it is packed, and the secret comes from pairing (below), never the package.
// The addresses it may reach are fixed when it is packed (Even allows only those listed in app.json); the setup on
// the phone picks one of them, kept in the app's own storage.
const PACKED = !"__FLEET_BASE__".startsWith("__");
const ORIGINS = PACKED ? JSON.parse('__FLEET_ORIGINS__') : [];
let BASE = PACKED ? "__FLEET_BASE__" : "";
let token = new URLSearchParams(location.search).get("t") || "";
const q = (path, extra) => BASE + path + "?t=" + encodeURIComponent(token) + (extra || "");
const say = (t) => (document.getElementById("s").textContent = t);
const W = 576, H = 288;
const QUICK = ["yes, go ahead", "continue", "looks good, carry on", "stop and tell me where you are"];
const cut = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const bar = (pct, n) => "━".repeat(Math.round((pct / 100) * n)) + "─".repeat(n - Math.round((pct / 100) * n));
let data = { sessions: [], counts: {}, clock: "" }, view = "slide", sel = 0, pickAt = 0, sid = null, page = 0, pages = [""], choices = [], started = false, busy = false, sending = false;

const bridge = await waitForEvenAppBridge();
say("Connected: Claude Fleet is on your glasses.");

const text0 = (id, name, x, y, w, h, content, capture, z) => new TextContainerProperty({ xPosition: x, yPosition: y, width: w, height: h, borderWidth: 0, borderColor: 0, paddingLength: 4, containerID: id, containerName: name, content: cut(content, 1000), isEventCapture: capture ? 1 : 0, ...(z !== undefined ? { zOrderIndex: z } : {}) });
// A list sits directly under what is above it: the glasses centre a list's items in its height, so it is only as tall as they are.
const list = (id, name, y, h, items) => new ListContainerProperty({ xPosition: 0, yPosition: y, width: W, height: Math.min(h, items.length * 40 + 8), borderWidth: 0, borderColor: 0, paddingLength: 4, containerID: id, containerName: name, isEventCapture: 1, itemContainer: new ListItemContainerProperty({ itemCount: items.length, itemWidth: 0, isItemSelectBorderEn: 1, itemName: items.map((i) => cut(i, 64)) }) });
// Input is ignored for a moment after a screen appears: a new list sends an event of its own (it reads as a tap), and
// a tap arrives twice (from the container, then from the system), so the second half would act on the new screen.
let settleUntil = 0;
async function show(p) {
  settleUntil = Date.now() + 1200;
  if (!started) {
    started = true;
    const r = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(p));
    if (r !== 0) say("The glasses would not take the page (" + r + ").");
  } else await bridge.rebuildPageContainer(new RebuildPageContainer(p));
}
const upgrade = (id, name, content) => bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: id, containerName: name, content: cut(content, 1000) }));
const current = () => data.sessions.find((s) => s.sid === sid);

// ── drawn on the phone: the slide and a session's dashboard, on a canvas in the system font, sent as four tiles ──
const FONT = '-apple-system, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif';
// Greys come out brighter on the glasses than on a screen: the low tones are kept low, so what matters stands out.
const COL = { hi: "#ffffff", mid: "#b0b0b0", lo: "#686868", faint: "#2c2c2c", fill: "#0e0e0e" };
const canvas = document.createElement("canvas");
canvas.width = W;
canvas.height = H;
const g = canvas.getContext("2d");
const tileCanvases = [0, 1, 2, 3].map(() => Object.assign(document.createElement("canvas"), { width: 288, height: 144 }));
let sentTiles = ["", "", "", ""];
const setFont = (px, weight) => (g.font = (weight || 400) + " " + px + "px " + FONT);
function fitText(s, maxW) {
  s = s || "";
  if (!maxW || g.measureText(s).width <= maxW) return s;
  while (s.length && g.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}
function text(s, x, y, px, colour, weight, maxW) {
  setFont(px, weight);
  g.fillStyle = colour;
  const t = fitText(s, maxW);
  g.fillText(t, x, y);
  return g.measureText(t).width;
}
function textR(s, right, y, px, colour, weight, maxW) {
  setFont(px, weight);
  const t = fitText(s, maxW);
  const w = g.measureText(t).width;
  g.fillStyle = colour;
  g.fillText(t, right - w, y);
  return w;
}
function wrapText(s, maxW, px, lines) {
  setFont(px);
  const out = [];
  let line = "";
  for (const word of (s || "").split(" ")) {
    const next = line ? line + " " + word : word;
    if (g.measureText(next).width > maxW && line) {
      out.push(line);
      line = word;
      if (out.length === lines) break;
    } else line = next;
  }
  if (out.length < lines && line) out.push(line);
  if (out.length === lines && (s || "").length > out.join(" ").length) out[lines - 1] = fitText(out[lines - 1] + " …", maxW);
  return out;
}
function rrect(x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
function pill(x, y, w, h, frac, colour) {
  rrect(x, y, w, h, h / 2);
  g.fillStyle = COL.faint;
  g.fill();
  if (frac > 0) {
    rrect(x, y, Math.max(h, w * Math.min(1, frac)), h, h / 2);
    g.fillStyle = colour;
    g.fill();
  }
}
// The state, drawn: ▲ needs you, ● working, half a circle stalled, a tick just finished, ▶ your turn, ○ quiet.
function stateIcon(state, x, cy, r, colour) {
  g.fillStyle = g.strokeStyle = colour;
  g.lineWidth = 2;
  g.beginPath();
  if (state === "needs") { g.moveTo(x + r, cy - r); g.lineTo(x + 2 * r, cy + r * 0.8); g.lineTo(x, cy + r * 0.8); g.closePath(); g.fill(); }
  else if (state === "working") { g.arc(x + r, cy, r * 0.8, 0, Math.PI * 2); g.fill(); }
  else if (state === "stalled") { g.arc(x + r, cy, r * 0.8, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(x + r, cy, r * 0.8, Math.PI / 2, Math.PI * 1.5); g.fill(); }
  else if (state === "justDone") { g.moveTo(x, cy); g.lineTo(x + r * 0.7, cy + r * 0.7); g.lineTo(x + r * 2, cy - r * 0.8); g.stroke(); }
  else if (state === "yourTurn") { g.moveTo(x + r * 0.3, cy - r * 0.8); g.lineTo(x + r * 1.8, cy); g.lineTo(x + r * 0.3, cy + r * 0.8); g.closePath(); g.fill(); }
  else { g.arc(x + r, cy, r * 0.75, 0, Math.PI * 2); g.stroke(); }
}
function resample(values, n) {
  if (!values || !values.length) return [];
  const step = values.length / n;
  return Array.from({ length: n }, (_, i) => { let v = 0; for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) v += values[j] || 0; return v; });
}
// Activity as rounded bars, scaled to the busiest.
function bars(values, x, y, w, h, colour, gap) {
  const n = Math.max(1, Math.min(values.length || 1, Math.floor(w / 4)));
  const cols = resample(values, n);
  const max = Math.max(1, ...cols);
  const bw = w / n;
  g.fillStyle = COL.faint;
  g.fillRect(x, y + h - 1, w, 1);
  g.fillStyle = colour;
  cols.forEach((v, i) => {
    if (!v) return;
    const bh = Math.max(2, Math.sqrt(v / max) * (h - 2));
    rrect(x + i * bw, y + h - 1 - bh, Math.max(1.5, bw - (gap ?? 1.5)), bh, Math.min(2, bw / 2));
    g.fill();
  });
}
// A sparkline: a smooth line with a soft fill under it.
function spark(values, x, y, w, h, colour) {
  const n = Math.max(2, Math.min(40, (values || []).length));
  const cols = resample(values || [], n);
  const max = Math.max(1, ...cols);
  const pts = cols.map((v, i) => [x + (i / (n - 1)) * w, y + h - (Math.sqrt(v / max) * (h - 2) + 1)]);
  g.beginPath();
  g.moveTo(pts[0][0], y + h);
  for (const [px, py] of pts) g.lineTo(px, py);
  g.lineTo(x + w, y + h);
  g.closePath();
  g.fillStyle = COL.fill;
  g.fill();
  g.beginPath();
  pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
  g.strokeStyle = colour;
  g.lineWidth = 1.5;
  g.stroke();
}
// Context over the last quarter hour, filled, against the window's size.
function area(points, x, y, w, h) {
  g.fillStyle = COL.faint;
  g.fillRect(x, y, w, 1);
  g.fillRect(x, y + h - 1, w, 1);
  if (!points || !points.length) return;
  const pts = points.map(([fx, fy]) => [x + fx * w, y + h - 1 - fy * (h - 2)]);
  pts.push([x + w, pts[pts.length - 1][1]]);
  g.beginPath();
  g.moveTo(pts[0][0], y + h - 1);
  for (const [px, py] of pts) g.lineTo(px, py);
  g.lineTo(pts[pts.length - 1][0], y + h - 1);
  g.closePath();
  g.fillStyle = "#121212";
  g.fill();
  g.beginPath();
  pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
  g.strokeStyle = COL.hi;
  g.lineWidth = 2;
  g.stroke();
}
function ring(frac, cx, cy, r, colour) {
  g.lineWidth = 3;
  g.strokeStyle = COL.faint;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = colour;
  g.beginPath();
  g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, frac));
  g.stroke();
}
// Done bright, going mid, still to come an outline.
function segments(done, doing, total, x, y, w, h) {
  if (!total) return;
  const n = Math.min(total, Math.floor(w / 6));
  const sw = w / n;
  for (let i = 0; i < n; i++) {
    const k = ((i + 0.5) * total) / n;
    rrect(x + i * sw, y, sw - 2, h, 2);
    if (k <= done) { g.fillStyle = COL.hi; g.fill(); }
    else if (k <= done + doing) { g.fillStyle = COL.lo; g.fill(); }
    else { g.strokeStyle = COL.faint; g.lineWidth = 1; g.stroke(); }
  }
}
const prWord = (p) => (p.state === "MERGED" ? "merged" : p.state === "CLOSED" ? "closed" : p.fail ? p.fail + " failing" : p.pending ? "CI " + p.pass + "/" + (p.pass + p.fail + p.pending) : p.state ? "CI green" : "");
const loud = (s) => s.state === "needs" || s.state === "stalled" || s.state === "justDone";

function drawSlide() {
  g.fillStyle = "#000";
  g.fillRect(0, 0, W, H);
  g.textBaseline = "alphabetic";
  const h = data.header || {};
  const c = data.counts || {};
  text("Claude Fleet", 10, 24, 19, COL.hi, 600);
  textR(data.clock || "", W - 10, 24, 19, COL.hi, 600);
  // Counts, each with its shape.
  let x = 10;
  const count = (state, n, label, colour) => {
    if (!n) return;
    stateIcon(state, x, 39, 5, colour);
    x += 16 + text(n + " " + label, x + 14, 44, 13, colour, 500) + 8;
  };
  count("needs", c.needs, c.needs === 1 ? "needs you" : "need you", COL.hi);
  count("stalled", c.stalled, "stuck", COL.hi);
  count("working", c.working, "working", COL.mid);
  if (c.agents) x += text(c.agents + (c.agents === 1 ? " agent" : " agents"), x, 44, 13, COL.lo) + 14;
  if (c.workflows) text("≡ " + c.workflows + (c.workflows === 1 ? " workflow" : " workflows"), x, 44, 13, COL.lo);
  if (!c.needs && !c.stalled && !c.working) text("all quiet", 10, 44, 13, COL.mid);
  // The five-hour limit, always, with its forecast.
  const pct = (h.five || "").match(/(\\d+)%/);
  text("5h", 10, 63, 12, COL.lo, 600);
  if (pct) {
    pill(30, 55, 110, 6, Number(pct[1]) / 100, h.urgent ? COL.hi : COL.mid);
    text((h.five || "").replace(/^5h\\s*/, ""), 148, 63, 12, h.urgent ? COL.hi : COL.mid, h.urgent ? 600 : 400, 250);
  } else text((h.five || "").replace(/^5h:?\\s*/, ""), 30, 63, 12, COL.lo, 400, 300);
  textR([h.week !== undefined ? "7d " + h.week + "%" : "", "cpu " + (h.cpu ?? 0) + "%", "mem " + (h.mem ?? 0) + "%", h.machines > 1 ? h.machines + " machines" : ""].filter(Boolean).join("  ·  "), W - 10, 63, 12, COL.lo);
  g.fillStyle = COL.faint;
  g.fillRect(10, 71, W - 20, 1);
  // The sessions, as many lines each as there is room for.
  const list = data.sessions || [];
  // Five or more: one row each, so all of them are on the screen at once. Fewer: richer cards.
  if (list.length >= 5) return drawRows(list);
  const lines = list.length <= 2 ? 4 : 3;
  const cardH = 8 + lines * 19;
  const top = 77, bottom = 270;
  const fit = Math.max(1, Math.floor((bottom - top + 4) / (cardH + 4)));
  const first = Math.max(0, Math.min(sel - Math.floor(fit / 2), list.length - fit));
  list.slice(first, first + fit).forEach((s, i) => {
    const y = top + i * (cardH + 4);
    if (first + i === sel) {
      rrect(4, y, W - 8, cardH, 8);
      g.strokeStyle = COL.hi;
      g.lineWidth = 2;
      g.stroke();
      rrect(4, y + 6, 4, cardH - 12, 2);
      g.fillStyle = COL.hi;
      g.fill();
    }
    const ch = s.chart || {};
    stateIcon(s.state, 14, y + 15, 6, loud(s) ? COL.hi : COL.mid);
    const stateText = s.word.toLowerCase() + (s.time ? " " + s.time : "");
    const sw = textR(stateText, W - 14, y + 20, 13, loud(s) ? COL.hi : COL.mid, loud(s) ? 600 : 400);
    const nw = text(s.name, 32, y + 20, 16, COL.hi, 600, W - 60 - sw - 60);
    if (s.host) text(s.host, 40 + nw, y + 20, 12, COL.lo, 400, 120);
    // Line two: the question or what it is doing; activity and context to the right.
    text(s.needs ? "? " + s.needs : s.now, 32, y + 39, 13, s.needs ? COL.hi : COL.mid, s.needs ? 500 : 400, W - 32 - 170);
    spark(ch.spark, W - 160, y + 28, 90, 14, COL.mid);
    if (s.ctx) {
      ring(s.ctx.pct / 100, W - 52, y + 34, 7, s.ctx.pct >= 80 ? COL.hi : COL.mid);
      text(s.ctx.pct + "%", W - 41, y + 39, 11, COL.lo);
    }
    if (lines >= 3) {
      const wf = (ch.workflows || [])[0];
      let x3 = 32;
      if (wf) {
        x3 += text("≡ " + wf.name + (wf.phase ? " · " + wf.phase : ""), x3, y + 58, 12, COL.lo, 400, 220) + 8;
        segments(wf.done, wf.doing, wf.total, x3, y + 50, Math.min(110, wf.total * 10), 7);
        x3 += Math.min(110, wf.total * 10) + 8;
        x3 += text(wf.done + "/" + wf.total, x3, y + 58, 12, COL.lo) + 12;
      } else if (s.doing) x3 += text("◐ " + s.doing, x3, y + 58, 12, COL.lo, 400, 260) + 12;
      const extra = [s.agents ? s.agents + " agents" : "", ...(ch.prs || []).map((p) => "#" + p.n + " " + prWord(p)), s.fails ? s.fails + " failed" : ""].filter(Boolean).join("  ·  ");
      if (extra) text(extra, x3, y + 58, 12, COL.lo, 400, W - 14 - x3);
    }
    if (lines >= 4 && s.said && !s.needs) text("Claude: " + s.said, 32, y + 77, 12, COL.lo, 400, W - 46);
  });
  if (!list.length) text("Nothing working, nothing waiting on you.", 32, 120, 15, COL.mid);
  text("ring: choose   ·   tap: open   ·   double tap: exit", 10, 284, 11, COL.lo);
  if (list.length > fit) textR(sel + 1 + " of " + list.length, W - 10, 284, 11, COL.lo);
}

// Five or more sessions: one row each: state, name and machine, what it needs or does, activity, context, state and time.
function drawRows(list) {
  const top = 77, rowH = 31;
  const fit = Math.floor((272 - top) / rowH);
  const first = Math.max(0, Math.min(sel - Math.floor(fit / 2), list.length - fit));
  list.slice(first, first + fit).forEach((s, i) => {
    const y = top + i * rowH;
    if (first + i === sel) {
      rrect(4, y, W - 8, rowH - 3, 7);
      g.strokeStyle = COL.hi;
      g.lineWidth = 2;
      g.stroke();
      rrect(4, y + 5, 4, rowH - 13, 2);
      g.fillStyle = COL.hi;
      g.fill();
    }
    const ch = s.chart || {};
    const base = y + 19;
    stateIcon(s.state, 14, base - 5, 5, loud(s) ? COL.hi : COL.mid);
    const stateText = s.word.toLowerCase() + (s.time ? " " + s.time : "");
    textR(stateText, W - 12, base, 12, loud(s) ? COL.hi : COL.lo, loud(s) ? 600 : 400, 112);
    const nw = text(s.name, 30, base, 14, COL.hi, 600, 150);
    const right = W - 12 - 112 - 14 - 92; // fixed columns, so the graphs line up row to row
    text(s.needs ? "? " + s.needs : s.now, 38 + nw, base, 12, s.needs ? COL.hi : COL.lo, s.needs ? 500 : 400, right - 38 - nw - 6);
    spark(ch.spark, right, base - 12, 60, 13, COL.mid);
    if (s.ctx) ring(s.ctx.pct / 100, right + 80, base - 5, 6, s.ctx.pct >= 80 ? COL.hi : COL.mid);
  });
  text("ring: choose   ·   tap: open   ·   double tap: exit", 10, 284, 11, COL.lo);
  if (list.length > fit) textR(sel + 1 + " of " + list.length, W - 10, 284, 11, COL.lo);
}

function drawDetail() {
  g.fillStyle = "#000";
  g.fillRect(0, 0, W, H);
  const s = current();
  if (!s) { text("That session has finished.", 20, 140, 18, COL.hi, 600); return; }
  const ch = s.chart || {};
  const h = data.header || {};
  stateIcon(s.state, 10, 17, 7, loud(s) ? COL.hi : COL.mid);
  const stateText = s.word.toLowerCase() + (s.time ? " " + s.time : "");
  const sw = textR(stateText, W - 10, 22, 14, loud(s) ? COL.hi : COL.mid, 600);
  text(s.name, 30, 23, 19, COL.hi, 600, W - 50 - sw);
  textR(h.five || "", W - 10, 40, 11, h.urgent ? COL.hi : COL.lo, h.urgent ? 600 : 400, 280);
  text(s.host ? s.host : "", 10, 40, 11, COL.lo, 400, 260);
  wrapText(s.needs ? "? " + s.needs : s.now, W - 20, 14, 2).forEach((l, i) => text(l, 10, 59 + i * 17, 14, s.needs ? COL.hi : COL.mid, s.needs ? 500 : 400));
  g.fillStyle = COL.faint;
  g.fillRect(10, 84, W - 20, 1);
  // Left: activity, context, tasks.
  const L = 10, LW = 268;
  text("Activity", L, 101, 12, COL.lo, 600);
  textR((ch.tools || 0) + " tools · " + (ch.out || "0") + " out · " + (h.window || 30) + "m", L + LW, 101, 12, COL.mid);
  bars(ch.spark || [], L, 107, LW, 46, COL.mid);
  text("Context", L, 170, 12, COL.lo, 600);
  if (s.ctx) textR(s.ctx.pct + "% of " + (s.ctx.max || "?") + (s.ctx.runway ? " · " + s.ctx.runway : ""), L + LW, 170, 12, s.ctx.pct >= 80 ? COL.hi : COL.mid);
  area(ch.ctx || [], L, 176, LW, 40);
  if (ch.tasks && ch.tasks.total) {
    text("Tasks", L, 235, 12, COL.lo, 600);
    textR(ch.tasks.done + " of " + ch.tasks.total + " done", L + LW, 235, 12, COL.mid);
    segments(ch.tasks.done, ch.tasks.doing, ch.tasks.total, L, 241, LW, 8);
    if (s.doing) text("◐ " + s.doing, L, 266, 12, COL.mid, 400, LW);
  }
  // Right: workflows, agents, pull requests, failures, then what Claude said, as room allows.
  const R = 298, RW = 268;
  let y = 101;
  for (const wf of (ch.workflows || []).slice(0, 2)) {
    const tw = textR((wf.phase ? wf.phase + " · " : "") + wf.done + "/" + wf.total, R + RW, y, 12, COL.mid);
    text("≡ " + wf.name, R, y, 13, COL.hi, 600, RW - tw - 8);
    segments(wf.done, wf.doing, wf.total, R, y + 6, RW, 8);
    y += 30;
  }
  if ((ch.agents || []).length) {
    text("Agents " + ch.agents.length, R, y, 12, COL.lo, 600);
    y += 17;
    for (const a of ch.agents.slice(0, Math.max(0, Math.floor((246 - y) / 17) + 1))) {
      if (y > 246) break;
      stateIcon(a.state === "active" ? "working" : a.state === "stalled" ? "stalled" : a.state === "tool" ? "stalled" : "idle", R, y - 4, 4, a.state === "stalled" ? COL.hi : COL.mid);
      text(a.label, R + 13, y, 12, COL.mid, 400, RW - 100);
      spark(a.spark, R + RW - 80, y - 11, 80, 12, COL.lo);
      y += 17;
    }
  }
  for (const p of (ch.prs || []).slice(0, 2)) {
    if (y > 262) break;
    const word = prWord(p);
    text("#" + p.n + "  " + word, R, y + 4, 12, p.fail ? COL.hi : COL.mid, p.fail ? 600 : 400, 150);
    const total = p.pass + p.fail + p.pending;
    if (p.state === "OPEN" && total) {
      g.fillStyle = COL.faint; g.fillRect(R + RW - 100, y - 3, 100, 6);
      g.fillStyle = COL.mid; g.fillRect(R + RW - 100, y - 3, (100 * p.pass) / total, 6);
      g.fillStyle = COL.hi; g.fillRect(R + RW - 100 + (100 * p.pass) / total, y - 3, (100 * p.fail) / total, 6);
    }
    y += 18;
  }
  if (s.fails && y <= 262) { text("✕ " + s.fails + " failed", R, y + 4, 12, COL.hi, 600); y += 18; }
  if (s.said && !s.needs && y <= 252) {
    text("Claude", R, y + 4, 12, COL.lo, 600);
    y += 19;
    for (const l of wrapText(s.said, RW, 12, Math.floor((270 - y) / 15) + 1)) { text(l, R, y, 12, COL.mid); y += 15; }
  }
  text("scroll: read   ·   tap: answer   ·   double tap: back", 10, 284, 11, COL.lo);
}

// The canvas, in four tiles; only those that changed go to the glasses, one at a time.
async function sendCanvas() {
  for (let i = 0; i < 4; i++) {
    const t = tileCanvases[i];
    const tg = t.getContext("2d");
    tg.fillStyle = "#000";
    tg.fillRect(0, 0, 288, 144);
    tg.drawImage(canvas, (i % 2) * 288, Math.floor(i / 2) * 144, 288, 144, 0, 0, 288, 144);
    const url = t.toDataURL("image/png");
    if (url === sentTiles[i] || (view !== "slide" && view !== "detail")) continue;
    const bytes = Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0));
    await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 10 + i, containerName: "tile" + i, imageData: bytes }));
    sentTiles[i] = url;
  }
}

// ── a session: a fixed head, a paged body, a fixed foot ──
const HEAD = 62, FOOT = 32;
const LINE = 58; // characters to a line, near enough, in the glasses' font
function wrapLines(t) {
  const out = [];
  for (const para of t.split("\\n")) {
    if (!para) { out.push(""); continue; }
    let line = "";
    for (const word of para.split(" ")) {
      if ((line + " " + word).trim().length > LINE && line) { out.push(line); line = "  " + word; }
      else line = line ? line + " " + word : word;
    }
    out.push(line);
  }
  return out;
}
function bodyLines(s) {
  const lines = [];
  if (s.needs) lines.push("? " + s.needs, "");
  else if (s.now) lines.push(s.now, "");
  if (s.ctx) lines.push("context  " + bar(s.ctx.pct, 12) + "  " + s.ctx.pct + "%" + (s.ctx.runway ? " · " + s.ctx.runway : ""));
  const facts = [s.tasks && "tasks " + s.tasks, s.agents && s.agents + " agents", s.fails && s.fails + " failed"].filter(Boolean);
  if (facts.length) lines.push(facts.join("   ·   "));
  if (s.doing) lines.push("now: " + s.doing);
  for (const p of s.prs) lines.push("PR " + p);
  if (s.roster && s.roster.length) lines.push("", ...s.roster);
  if (s.said && !s.needs) lines.push("", "Claude: " + s.said);
  return wrapLines(lines.join("\\n"));
}
const PER_PAGE = 7;
function paginate(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += PER_PAGE) out.push(lines.slice(i, i + PER_PAGE).join("\\n"));
  return out.length ? out : [""];
}
const headText = (s) => s.mark + " " + s.name.toUpperCase() + "\\n" + [s.host, s.word + (s.time ? " " + s.time : "")].filter(Boolean).join("  ·  ");
const footText = () => "tap: answer    2× tap: back" + (pages.length > 1 ? "    page " + (page + 1) + "/" + pages.length + " (scroll)" : "");
async function session(id) {
  sid = id;
  view = "session";
  const s = current();
  if (!s) return slide();
  pages = paginate(bodyLines(s));
  page = Math.min(page, pages.length - 1);
  await show({ containerTotalNum: 3, textObject: [text0(1, "head", 0, 0, W, HEAD, headText(s), false), text0(2, "body", 0, HEAD, W, H - HEAD - FOOT, pages[page], true), text0(3, "foot", 0, H - FOOT, W, FOOT, footText(), false)] });
}

// ── answering: the choices on its own screen, Esc, Enter and quick replies ──
const BASIC = () => [{ label: "Esc · stop or cancel", key: "X" }, { label: "Enter", key: "E" }, ...QUICK.map((x) => ({ label: "“" + x + "”", text: x }))];
const answerPage = (note) => ({ containerTotalNum: 2, textObject: [text0(1, "head", 0, 0, W, 36, cut(note, 52) + "   ·   2× tap: back", false)], listObject: [list(2, "choices", 36, H - 36, choices.map((c) => c.label))] });
async function answer() {
  const s = current();
  if (!s) return slide();
  view = "answer";
  const asked = sid;
  choices = BASIC();
  pickAt = 0;
  await show(answerPage("Answer " + s.name + ": reading its screen…"));
  const r = await post("/api/choices", { sid });
  if (view !== "answer" || sid !== asked) return; // gone back meanwhile
  const options = (r.options || []).map((o) => ({ label: o.key + ". " + o.label, key: o.key }));
  if (options.length) {
    choices = [...options, ...BASIC()];
    pickAt = 0;
    await show(answerPage("Answer " + s.name + ": tap a choice"));
  } else await upgrade(1, "head", cut(r.ok ? "No numbered choice on its screen" : r.error || "Can't see its screen", 52) + "   ·   2× tap: back");
}
async function pick(i) {
  const c = choices[i];
  const s = current();
  if (!c || !s) return;
  busy = true;
  const r = c.key ? await post("/api/keys", { sid, key: c.key }) : await post("/api/send", { sid, text: c.text });
  await show({ containerTotalNum: 1, textObject: [text0(1, "done", 0, 0, W, H, (r.ok ? "■ " + (c.key ? "Pressed " + (c.key === "X" ? "Esc" : c.key === "E" ? "Enter" : c.key) : r.queued ? "Queued (busy)" : "Sent") + " in " + s.name : "x Not done: " + (r.error || "fleet did not answer")), true)] });
  setTimeout(async () => {
    busy = false;
    await refresh();
    await detail(sid);
  }, 1600);
}

async function post(path, body) {
  try {
    const r = await fetch(q(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return await r.json();
  } catch {
    return { ok: false, error: "can't reach fleet" };
  }
}
async function refresh() {
  try {
    const r = await fetch(q("/api/glasses"), { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
    say("Connected · " + data.sessions.length + " sessions · " + data.clock);
  } catch {
    say("Can't reach fleet: is it running?");
  }
}

// The slide and a session's dashboard: four image tiles over an empty text layer that takes the ring and taps.
const tileContainers = () => [0, 1, 2, 3].map((i) => new ImageContainerProperty({ xPosition: (i % 2) * 288, yPosition: Math.floor(i / 2) * 144, width: 288, height: 144, containerID: 10 + i, containerName: "tile" + i, zOrderIndex: i + 2 }));
async function showCanvasView(name) {
  view = name;
  sentTiles = ["", "", "", ""];
  await show({ containerTotalNum: 5, textObject: [text0(1, "input", 0, 0, W, H, " ", true, 1)], imageObject: tileContainers() });
  await redraw();
}
async function redraw() {
  if (sending) return;
  sending = true;
  try {
    if (view === "slide") drawSlide();
    else if (view === "detail") drawDetail();
    else return;
    await sendCanvas();
  } finally {
    sending = false;
  }
}
const slide = () => showCanvasView("slide");
const detail = (id) => { sid = id; page = 0; return showCanvasView("detail"); };

// Every few seconds: the slide or dashboard redrawn (only changed tiles go), or the open text page in place.
async function tick() {
  if (busy) return;
  await refresh();
  sel = Math.min(sel, Math.max(0, data.sessions.length - 1));
  if (view === "slide" || view === "detail") {
    if (view === "detail" && !current()) return slide();
    await redraw();
  } else if (view === "session") {
    const s = current();
    if (!s) return slide();
    const next = paginate(bodyLines(s));
    if (next.join() !== pages.join()) {
      pages = next;
      page = Math.min(page, pages.length - 1);
      await upgrade(2, "body", pages[page]);
      await upgrade(3, "foot", footText());
    }
  }
}

const typeOf = (env) => (env ? (env.eventType ?? E.CLICK_EVENT) : null);
bridge.onEvenHubEvent(async (e) => {
  if (busy) return;
  const types = [typeOf(e.listEvent), typeOf(e.textEvent), typeOf(e.sysEvent)];
  if (types.includes(E.SYSTEM_EXIT_EVENT) || types.includes(E.ABNORMAL_EXIT_EVENT)) return;
  if (Date.now() < settleUntil) return;
  if (e.listEvent) pickAt = e.listEvent.currentSelectItemIndex ?? 0;
  if (types.includes(E.DOUBLE_CLICK_EVENT)) {
    if (view === "answer" || view === "session") return detail(sid);
    if (view === "detail") return slide();
    return bridge.shutDownPageContainer(1);
  }
  const down = types.includes(E.SCROLL_BOTTOM_EVENT), up = types.includes(E.SCROLL_TOP_EVENT);
  if (down || up) {
    if (view === "slide") {
      sel = Math.max(0, Math.min(data.sessions.length - 1, sel + (down ? 1 : -1)));
      return redraw();
    }
    if (view === "detail") { page = 0; return session(sid); } // the text, to read in full
    if (view === "session") {
      if (up && page === 0) return detail(sid);
      page = Math.max(0, Math.min(pages.length - 1, page + (down ? 1 : -1)));
      await upgrade(2, "body", pages[page]);
      return upgrade(3, "foot", footText());
    }
    return;
  }
  if (types.includes(E.CLICK_EVENT)) {
    settleUntil = Date.now() + 800; // the other half of this tap
    if (view === "slide" && data.sessions[sel]) return detail(data.sessions[sel].sid);
    if (view === "detail" || view === "session") return answer();
    if (view === "answer") return pick(pickAt);
  }
});
// Installed: the secret kept from pairing, if it still opens fleet; else pair. The glasses show a code; you approve it on
// Telegram or the Fleet page; the app keeps the secret in its own storage on the phone.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Kept in the app's own storage (the SDK's, which the Even app keeps per app), and in the WebView's as well, in case.
const keep = async (k, v) => { try { await bridge.setLocalStorage(k, v); } catch {} try { localStorage.setItem(k, v); } catch {} };
const kept = async (k) => { let v = ""; try { v = (await bridge.getLocalStorage(k)) || ""; } catch {} if (!v) try { v = localStorage.getItem(k) || ""; } catch {} return v; };
const notice = (lines) => show({ containerTotalNum: 1, textObject: [text0(1, "pair", 0, 0, W, H, lines, true)] });
async function pair() {
  for (;;) {
    let start = null;
    try { start = await (await fetch(BASE + "/api/pair/start", { method: "POST" })).json(); } catch {}
    if (!start || !start.id) {
      say("Can't reach fleet at " + BASE + ". Is your Mac awake, and your phone on Tailscale?");
      conn("Can't reach fleet at " + BASE.replace("http://", "").replace("https://", "") + ". Is your Mac awake, and your phone on Tailscale? Or pick another address above.");
      await notice("Claude Fleet\\n\\nCan't reach fleet at " + BASE.replace("http://", "").replace("https://", "") + ".\\nIs your Mac awake, and your phone on Tailscale?\\n\\nTrying again…");
      await wait(5000);
      continue;
    }
    say("Pair with Claude Fleet: code " + start.code + ". Approve it on Telegram or the Fleet page.");
    conn("Waiting for you to approve code " + start.code + " (Telegram, or the Fleet page).");
    await notice("Pair with Claude Fleet\\n\\nCode   " + start.code + "\\n\\nApprove it on Telegram or the Fleet page on your phone.");
    for (let i = 0; i < 300; i++) {
      await wait(2000);
      let r = null;
      try { r = await (await fetch(BASE + "/api/pair/poll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: start.id }) })).json(); } catch {}
      if (r && r.status === "approved" && r.token) {
        await keep("fleet-token", r.token);
        return r.token;
      }
      if (r && (r.status === "denied" || r.status === "expired")) break;
    }
  }
}
// The setup, on the phone: which of the packed addresses to use, whether it is paired, and a way to pair again.
const conn = (t) => (document.getElementById("conn").textContent = t);
if (PACKED) {
  const chosen = await kept("fleet-base"); if (chosen && ORIGINS.includes(chosen)) BASE = chosen;
  const pick = document.getElementById("base");
  for (const o of ORIGINS) { const opt = document.createElement("option"); opt.value = o; opt.textContent = o.replace("http://", "").replace("https://", ""); pick.append(opt); }
  pick.value = BASE;
  document.getElementById("setup").hidden = false;
  conn("Connecting to " + BASE.replace("http://", "").replace("https://", "") + "…");
  document.getElementById("save").onclick = async () => { await keep("fleet-base", pick.value); location.reload(); };
  document.getElementById("forget").onclick = async () => { await keep("fleet-token", ""); location.reload(); };
}
if (!token && PACKED) {
  token = await kept("fleet-token");
  if (token) {
    const fine = await fetch(q("/api/glasses"), { cache: "no-store" }).then((r) => r.status !== 403, () => true);
    if (!fine) token = ""; // fleet's secret has changed since: pair again
  }
  if (!token) token = await pair();
}
if (PACKED) conn("Paired · connected to " + BASE.replace("http://", "").replace("https://", ""));
await refresh();
await slide();
setInterval(tick, 3000);
</script></body></html>`;

let webGlasses = false; // on the w screen, key g: the glasses QR code instead of the phone's

// ───────────────────────── legend ─────────────────────────

let legendOn = false; // key ?: the legend is showing instead of the fleet
let acctOn = false; // key u: every Claude account's usage is showing instead of the fleet

/**
 * Key ?: one screen that says what every mark and key means, since the screen itself carries no word
 * labels. Any key or click returns to the fleet. Two columns from 78 cells wide, one below that.
 */
export function legend(cols: number, rows: number): string[] {
  const W = Math.max(60, cols);
  type Line = Seg[];
  const head = (text: string): Line => [[text, C.white, true]];
  /** A mark in its own colour, its name, and what it means. */
  const mark = (glyph: string, color: RGB, name: string, note: Line | string, isBold = false): Line => [[glyph, color, isBold], [" " + fit(name, 12), C.text], ...(typeof note === "string" ? ([[note, C.dim]] as Line) : note)];
  /** A graph or gauge sample, or a key, and what it is. */
  const sample = (parts: Line, w: number, note: string): Line => [...parts, [" ".repeat(Math.max(1, w - segsWidth(parts))), C.dim], [note, C.dim]];
  const key = (name: string, note: string): Line => sample([[name, C.text, true]], 6, note);
  const spin = SPIN[frame % SPIN.length];
  const left: Line[] = [
    head("SESSIONS"),
    mark(STATE.needs.glyph, C.amber, "needs you", "waiting on your answer", true),
    mark(STATE.stalled.glyph, C.red, "stalled?", "silent on a tool call"),
    mark(STATE.working.glyph, C.green, "working", "alive and busy"),
    mark(STATE.yourTurn.glyph, C.blue, "your turn", "it replied; your move", true),
    mark(STATE.idle.glyph, C.dim, "idle", "nothing running"),
    mark(STATE.finished.glyph, C.green, "finished", "just now (space clears), or its job is done", true),
    [],
    head("CONVERSATION"),
    mark(ICON.you, C.blue, "you", "something you typed", true),
    mark(ICON.claude, C.cyan, "Claude", "newest; white when new"),
    mark(ICON.earlier, EARLIER_TONE, "earlier", "an earlier reply"),
    mark(ICON.bullet, C.cyan, "bullet", `in a reply; ${ICON.nested} nested`),
    mark(ICON.cut, C.dim, "cut", `left out: ${ICON.cut} +5 lines`),
    [],
    head("THREADS, TASKS, WORKFLOWS"),
    mark(spin, C.green, "live", "wrote in the last minute"),
    mark(ICON.progress, C.white, "in progress", "or a tool call is out"),
    mark(ICON.idle, C.dim, "not started", "or quiet"),
    mark(ICON.done, C.green, "done", [[ICON.failed, C.red], [" failed or stopped", C.dim]]),
    mark(ICON.workflow, C.purple, "workflow", "agents run in phases", true),
  ];
  const right: Line[] = [
    head("GRAPHS AND GAUGES"),
    sample([1, 3, 5, 8].map((level): Seg => [BARS[level - 1], mix(...RAMP.session, level / 8)]), 5, "tool calls per bar, oldest left"),
    sample([[ICON.gaugeFill.repeat(2), C.calm], [ICON.gaugeTrack, C.faint]], 5, "limit: white from 60%, red 80%"),
    sample([[ICON.gaugeFill, C.calm], [ICON.paceFilled, C.white], [ICON.gaugeTrack, C.faint], [ICON.pace, C.white]], 5, "pace: time gone in that window"),
    sample([[ICON.gaugeNone.repeat(3), C.faint]], 5, "no reading"),
    sample([[ICON.ctxFull, PARTS[6].color], [ICON.ctxHalf, PARTS[6].color], [ICON.ctxFree, C.faint], [" "], [ICON.swatch, PARTS[6].color]], 5, `context by category; ${ICON.swatch} its key`),
    sample([[ICON.tick, C.dim], [" ", C.dim], [ICON.seen, C.white, true]], 5, "thirds of the window; last looked"),
    sample([[ICON.railThick, C.green], [" ", C.dim], [ICON.railThin, mix(C.green, C.faint, 0.45)]], 5, "rail: the session's state colour"),
    [],
    head("KEYS"),
    key("1 2 3", "detail, compact, timeline"),
    key("+ -", "window: 5 15 30 60 180 minutes"),
    key("a", "idle and finished sessions too"),
    key("d", "list finished agents"),
    key("tab", "focus the next session"),
    key("esc", "leave focus; with none, quit"),
    key("r", "open the session waiting on you"),
    key("b u m", "bell; usage, every account; menu"),
    key("space", "seen it: clears the new marks"),
    key("?", "this legend"),
    key("q", "quit"),
  ];
  const two = W >= 78;
  const colW = two ? Math.min(44, Math.floor((W - 4) / 2)) : W - 2; // on a wide screen the two columns stay together
  const body: [Line, Line][] = two ? Array.from({ length: Math.max(left.length, right.length) }, (_, i) => [left[i] ?? [], right[i] ?? []]) : [...left, [], ...right].map((line) => [line, []]);
  const out: string[] = [];
  const title = new Row(W);
  title.segs(2, [[`${ICON.claude} CLAUDE FLEET`, C.cyan, true], ["   what the marks and keys mean", C.dim]]);
  out.push(title.toString(), "");
  /** Put a line's pieces from `col`; the piece that would pass `end` is cut there. */
  const put = (r: Row, col: number, line: Line, end: number) => {
    for (const [text, color, isBold] of line) {
      if (col + width(text) - 1 > end) return void r.put(col, fit(text, end - col + 1, "l", true), color, isBold);
      col = r.put(col, text, color, isBold);
    }
  };
  for (const [a, b] of body.slice(0, Math.max(0, rows - 3))) {
    const r = new Row(W);
    put(r, 2, a, 1 + colW);
    put(r, 4 + colW, b, W - 1);
    out.push(r.toString());
  }
  while (out.length < rows - 1) out.push("");
  out.length = Math.max(0, rows - 1);
  out.push(fg(C.dim, "  any key or click returns to the fleet"));
  hits.length = 0;
  return out.map((line) => clipRow(line, cols));
}

// ───────────────────────── keys and clicks ─────────────────────────

/** One thing read from the keyboard or mouse. */
export type InputEvent =
  | { kind: "key"; key: string } // one character, or "\x1b" for Esc
  | { kind: "press"; col: number; row: number } // the left button going down, in 1-based cells
  | { kind: "other" }; // a release, another button, the wheel, or a key sequence the dashboard has no use for
/**
 * One read from the terminal, as the events it holds, in order. Keys that arrive together (key repeat, a
 * laggy link) are each a key. Mouse reports are SGR (ESC [ < button ; column ; row, then M for a press or m
 * for a release); only a left-button press is a click. An escape sequence cut off at the end of the read is
 * returned as `rest`, to be joined to the next read: a lone ESC is Esc only if nothing follows it soon.
 */
export function inputEvents(chunk: string): { events: InputEvent[]; rest: string } {
  const events: InputEvent[] = [];
  for (let i = 0; i < chunk.length; ) {
    if (chunk[i] !== "\x1b") {
      events.push({ kind: "key", key: chunk[i++] });
      continue;
    }
    const at = chunk.slice(i);
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(at);
    const seq = mouse ?? /^\x1b\[[0-?]*[ -\/]*[@-~]/.exec(at) ?? /^\x1bO[\s\S]/.exec(at);
    if (seq) {
      events.push(mouse && mouse[4] === "M" && mouse[1] === "0" ? { kind: "press", col: +mouse[2], row: +mouse[3] } : { kind: "other" });
      i += seq[0].length;
    } else if (/^\x1b(\[[0-?]*[ -\/]*|O)?$/.test(at)) return { events, rest: at }; // cut off: the rest is in the next read
    else if (at[1] === "\x1b") (events.push({ kind: "key", key: "\x1b" }), i++); // Esc, and the next one may begin a sequence
    else (events.push({ kind: "other" }), (i += 2)); // alt and a key
  }
  return { events, rest: "" };
}
/** Keys that arrive together beyond this many are a paste, not commands: a pasted word must not quit or toggle anything. */
const PASTE_KEYS = 8;

/** Key + and -: the next window in WINDOWS above or below `min`, which need not be one of them (a window given on the command line). */
export function stepWindow(min: number, dir: 1 | -1): number {
  return (dir > 0 ? WINDOWS.find((w) => w > min) : [...WINDOWS].reverse().find((w) => w < min)) ?? min;
}

// ───────────────────────── the terminal ─────────────────────────

/** What is written to take over the terminal: the alternate screen, no cursor, mouse reports, and the tab title saved on the terminal's title stack. */
export const enterScreen = (mouse: boolean): string => "\x1b[22;0t\x1b[?1049h\x1b[?25l\x1b[2J" + (mouse ? "\x1b[?1000h\x1b[?1006h" : "");
/** …and to give it back: the title cleared, then popped (which puts the old one back where the terminal keeps a stack), mouse reports off, the cursor and the main screen back. */
export const leaveScreen = (mouse: boolean): string => titleSequence("") + "\x1b[23;0t" + (mouse ? "\x1b[?1000l\x1b[?1006l" : "") + "\x1b[?25h\x1b[?1049l";
/**
 * Put the terminal back however the program ends: a normal exit, an uncaught error or a rejected promise
 * (which are then printed, after the terminal is back, and end it with status 1). Returns the restore, run once at most.
 */
export function guardTerminal(restore: () => void): () => void {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    restore();
  };
  process.on("exit", once);
  const fail = (e: unknown) => {
    once();
    process.stderr.write(`${(e as Error)?.stack ?? String(e)}\n`);
    process.exit(1);
  };
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  return once;
}

/**
 * What to write to turn the screen from `prev` into `next` (both whole frames, a row each): only the rows
 * that changed, each from its first column and erased to its end, and rows `next` no longer has cleared.
 * With no `prev` (a cleared screen) every row is written. Most seconds only the clock, the spinners and a
 * waiting session's rail change, so this is a few rows, where writing every row was 30 to 90 KB a second.
 */
export function frameDiff(prev: string[] | undefined, next: string[]): string {
  let out = "";
  for (let i = 0; i < next.length; i++) if (!prev || prev[i] !== next[i]) out += `\x1b[${i + 1};1H${next[i]}\x1b[K`;
  if (prev) for (let i = next.length; i < prev.length; i++) out += `\x1b[${i + 1};1H\x1b[K`;
  return out;
}

// ───────────────────────── main loop ─────────────────────────

let sessions: Session[] = [];
const needing = new Set<string>(); // sessions that were waiting on the person at the last scan
const askedAt = new Map<string, number>(); // …and when each one's question was asked, the last time the bell rang for it
const stalledNow = new Map<string, number>();
let retakeAt = 0;
let tgWanted = false; // set at launch for real sessions: talk to the Telegram bot when this fleet holds it
/**
 * The background service scans on a thread of its own (scan.worker.ts): each refresh asks for a new scan when the last is
 * in, and uses the newest sessions it has. This thread then never reads a transcript, so the page and the bot are never
 * held by one. Elsewhere (the terminal, --once, tests) scan() runs here, as before.
 */
let scanThread: Worker | undefined;
let threadSessions: Session[] = [];
let threadBusy = false;
let threadJustRead = new Set<string>();
export function useScanThread(): boolean {
  if (scanThread) return true;
  try {
    scanThread = new Worker(new URL("./scan.worker.ts", import.meta.url).href);
  } catch {
    return false;
  }
  scanThread.onmessage = (e: MessageEvent) => {
    threadBusy = false;
    for (const f of threadWaiters.splice(0)) setTimeout(f, 0);
    threadSessions = decodeSessions(e.data.text);
    scanPending = e.data.pending;
    for (const sid of e.data.justRead as string[]) threadJustRead.add(sid);
    scanSeq++; // what the pages are told is made afresh from these
  };
  scanThread.onerror = () => (threadBusy = false);
  return true;
}
const threadWaiters: (() => void)[] = [];
/** One scan on the thread, waited for (tests). */
export function scanOnThread(now: number): Promise<Session[]> {
  useScanThread();
  return new Promise((done) => {
    threadWaiters.push(() => done(threadSessions));
    threadBusy = true;
    scanThread!.postMessage({ now, budget: scanBudgetMs, options: { ...opt }, env: { ...process.env } }); // a worker sees the environment as it was at launch, not as it is
  });
}
/** Stop the scan thread (tests). */
export function stopScanThread() {
  scanThread?.terminate();
  scanThread = undefined;
  threadBusy = false;
}
function fromScanThread(now: number): Session[] {
  if (!threadBusy) {
    threadBusy = true;
    scanThread!.postMessage({ now, budget: scanBudgetMs, options: { ...opt }, env: { ...process.env } }); // a worker sees the environment as it was at launch, not as it is
  }
  for (const sid of threadJustRead) justRead.add(sid);
  threadJustRead = new Set();
  return threadSessions;
}
/** How long each step of the last refresh took, for the service log when one is slow. */
export let refreshLaps: [string, number][] = [];
let lapAt = 0;
const lap = (name: string) => {
  const t = performance.now();
  refreshLaps.push([name, t - lapAt]);
  lapAt = t;
};
/** One read of everything. The service passes `yields`: it then pauses between steps, so the page and the bot are
 *  answered between them and the longest wait is one step, not the whole read. Elsewhere it runs straight through. */
async function refresh(yields = false) {
  refreshLaps = [];
  lapAt = performance.now();
  // Only the service waits between steps: elsewhere there is no await at all, so the read is done when refresh() returns.
  const breathe = () => new Promise<void>((r) => setImmediate(r)).then(() => void (lapAt = performance.now())); // time answering others is not this read's
  if (Date.now() >= retakeAt) {
    retakeAt = Date.now() + 10_000; // when the fleet serving the page or talking to the bot quits, this one takes over
    if (serviceRunning()) web.yieldPort?.();
    else web.retake?.();
    if (tgWanted) tgClaim();
    staleCheck();
  }
  lap("claims");
  if (yields) await breathe();
  const now = clock();
  const local = scanThread ? fromScanThread(now) : scan(now);
  lap("scan");
  if (yields) await breathe();
  prune(now);
  lap("prune");
  sampleMachine();
  lap("machine");
  if (yields) await breathe();
  pollSides(local, now, opt.once);
  lap(`git and PRs (git ${Math.round(sideCost.git)}, worktrees ${Math.round(sideCost.worktrees)}, prs ${Math.round(sideCost.prs)}, deploys ${Math.round(sideCost.deploys)} ms; ${sideCost.started} started)`);
  if (yields) await breathe();
  // Your other machines' sessions join this one's; their git and pull requests were read by their own fleets.
  pollPeers(now, local);
  sessions = [...local, ...peerSessions()];
  const fresh = takeFreshPeers();
  for (const sid of takeJustRead()) fresh.add(sid); // read at last: what it shows was already so, not news
  lap("other machines");
  if (yields) await breathe();
  holdStalls(sessions, now);
  steadyClock(now);
  if (opt.usage && !opt.once) tickUsage(now); // --once has already made its one read
  if (opt.usage && !opt.once) tickAccounts(now); // the other accounts in accounts.json, if any
  lap("usage");
  if (yields) await breathe();
  // Ring once when a session starts waiting on the person, and once for each thing that newly stalls.
  const facts = sessions.map((s) => ({ s, f: factsOf(s) }));
  const asks = facts.filter((x) => x.f.needs).map((x): [string, number] => [x.s.sid, stateSince(x.s, x.f, "needs")]);
  // A machine that has just come into view brings what was already waiting there: noted, but not news.
  const asked = newAsks(needing, askedAt, asks).filter((sid) => !fresh.has(sid));
  const marks = facts.flatMap((x) => stallMarks(x.s, x.f, stallOf(x.s, x.f, now)));
  const stuckNow = new Set(marks.map(([k]) => k.split("/")[0]));
  const stalled = newStalls(stalledNow, marks).filter((k) => !fresh.has(k.split("/")[0]));
  const rings = asked.length + stalled.length;
  lap("stalls");
  if (yields) await breathe();
  const told = tgWanted ? tgEvents(sessions, asked, stalled) : []; // always, so what changed while another fleet held the bot is not news later
  const botHere = tgWanted && tg.on && (tg.paired = !!readTg().chat);
  if (botHere) {
    const c = readTg();
    const muted = c.muted ?? {};
    const quiet = inQuiet(c.quiet);
    for (const [text, sid, asking, key] of told) {
      if (tgToldBefore(key)) continue; // said already: before a restart, or by this fleet a moment ago
      // Muted, or quiet hours and not a question: kept for the digest, not sent.
      const held = (muted[sid] ?? 0) > Date.now() || (quiet && !asking);
      tgLog(text + (held ? " (held)" : ""));
      if (!held) void tgSay(text, sid, asking, key.startsWith("ask:") ? "ask" : key.startsWith("stall:") ? "stall" : undefined);
    }
    tgSettle(new Set(asks.map(([sid]) => sid)), stuckNow);
    tgSweep();
  }
  lap("telegram");
  if (yields) await breathe();
  if (opt.bell && !opt.once) process.stdout.write("\x07".repeat(rings));
  noteScan(sessions, now);
  const partied = [...noteParties(sessions, now), ...noteFinished(sessions, now).map((sid) => `${sid} finished`)];
  lap("events");
  if (yields) await breathe();
  if (botHere) void tgTick(sessions, now, partied);
  lap("telegram tick");
  web.push?.();
  lap("pages");
  if (opt.bell && !opt.once && partied.length) process.stdout.write("\x07");
}

if (import.meta.main) {
  if (process.argv[2] === "accounts") await accountsMain(process.argv.slice(3)); // never returns
  const command = parseArgs(process.argv.slice(2));
  if (command) {
    process.stdout.write(command === "help" ? HELP : glyphCard());
    process.exit(0);
  }

  seen.at = Number(process.env.FLEET_SEEN) || clock(); // FLEET_SEEN (test only) starts the mark in the past
  const party = /^([\w-]+)=(.{1,60})$/.exec(process.env.FLEET_PARTY ?? ""); // FLEET_PARTY (demo only): "session id=text" celebrates from launch
  if (party) parties.set(party[1], { text: safeLine(party[2]), at: clock() });
  focusSid = process.env.FLEET_FOCUS || null; // FLEET_FOCUS (demo only): start focused on this session, as a click on it would
  // In the background (key i installs it): the supervisor, or the screenless fleet it runs. Neither returns.
  if (process.argv.includes("--serve")) await serveSupervisor();
  if (process.argv.includes("--serve-worker")) await serveWorker();
  if (!process.stdout.isTTY) opt.once = true; // output to a file or a pipe: one frame, not screen codes for ever
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

  // The splash, up at once: the steps below, and the first read, block the main thread for a while (for seconds, with
  // huge sessions), so after its first frame it is drawn by a thread of its own (splash.worker.ts) at a steady pace,
  // and this thread only says what it is doing. Without workers, it is drawn from here as things happen.
  const splashFrom = Date.now();
  let splashAt = 0, painter: Worker | undefined;
  const paint = (doing: string, done = 0, total = 0) => {
    try {
      fs.writeSync(1, "\x1b[H" + splashScreen(process.stdout.columns || 140, process.stdout.rows || 45, doing, done, total, shineAt(Date.now() - splashFrom)).map((l) => l + "\x1b[K").join("\r\n"));
    } catch {}
  };
  const splash = (doing: string, done = 0, total = 0, force = true) => {
    if (painter) return void painter.postMessage({ type: "state", doing, done, total });
    if (!force && Date.now() - splashAt < 33) return;
    splashAt = Date.now();
    paint(doing, done, total);
  };
  // Done: the streak runs to the end of its sweep (at most a second's wait), then the screen is this thread's again.
  const finishShine = async () => {
    const p = painter;
    if (!p) return;
    painter = undefined;
    await new Promise<void>((done) => {
      const stop = setTimeout(done, 1000);
      p.onmessage = (e) => e.data === "done" && (clearTimeout(stop), done());
      p.postMessage({ type: "finish" });
    });
    p.terminate();
  };
  const leaveSplash = () => {
    painter?.terminate();
    try {
      fs.writeSync(1, leaveScreen(false));
    } catch {}
    process.exit(130);
  };
  process.on("SIGINT", leaveSplash); // Ctrl-C before the screen is set up: the terminal back as it was
  fs.writeSync(1, enterScreen(opt.mouse));
  splash("starting");
  try {
    painter = new Worker(new URL("./splash.worker.ts", import.meta.url).href);
    painter.postMessage({ type: "start", from: splashFrom, cols: process.stdout.columns || 140, rows: process.stdout.rows || 45 });
  } catch {
    painter = undefined;
  }
  // The phone page is always on (key w shows its link), except for made-up sessions (the demo and tests) or FLEET_WEB=0.
  if (!process.env.FLEET_HOME && process.env.FLEET_WEB !== "0") {
    splash("opening the page for your phone");
    startWeb(() => sessions);
  }
  // Telegram, once key t has paired a bot; likewise only for real sessions.
  if (!process.env.FLEET_HOME) {
    splash("looking for your other machines and the Telegram bot");
    peersWanted = true;
    tgWanted = true;
    tg.getSessions = () => sessions;
    tgClaim();
  }
  splash("reading your sessions");
  setScanProgress((done, total, name) => splash(`reading ${name}`, done, total, false));

  const out = process.stdout;
  let onScreen: string[] | undefined; // the frame the terminal shows, so the next writes only the rows that differ
  let away = false; // a wizard has the terminal (key a or x on the accounts screen)
  const draw = () => {
    if (away) return;
    const lines = legendOn ? legend(out.columns || 140, out.rows || 45) : acctOn ? accountsScreen(out.columns || 140, out.rows || 45, clock()) : webOn ? webScreen(out.columns || 140, out.rows || 45) : tgOn ? tgScreen(out.columns || 140, out.rows || 45) : svcOn ? svcScreen(out.columns || 140, out.rows || 45) : render(sessions, out.columns || 140, out.rows || 45, clock());
    out.write(frameDiff(onScreen, lines));
    onScreen = lines;
  };
  /** Clear the screen, so the next draw writes every row: on a change of view, a resize, and once a minute in case anything else wrote to the terminal. */
  const clear = () => {
    out.write("\x1b[2J");
    onScreen = undefined;
  };
  /** The tab title follows the fleet's state. It is written only when it changes, and put back (or cleared) on the way out. */
  const retitle = () => out.write(titleChange(titleFor(fleetCounts(sessions, clock(), frameWindow(clock(), Math.max(60, out.columns || 140)).start)))); // the same window the screen's own counts use
  const restore = guardTerminal(() => {
    out.write(leaveScreen(opt.mouse));
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  });
  const quit = () => {
    tgRelease();
    restore();
    process.exit(0);
  };

  /** Every control, whether it came from a key or a click. */
  const act = (name: string) => {
    if (name === "quit") return quit();
    if (name === "back" && menu.open) name = "menu"; // esc closes the menu first
    if (name === "menu") menu.open = !menu.open;
    else if (!MENU_SWITCHES.has(name)) menu.open = false;
    if (name === "menu") {
    } else if (name.startsWith("mode:")) opt.mode = name.slice(5) as Mode;
    else if (name === "win+") opt.windowMin = stepWindow(opt.windowMin, 1);
    else if (name === "win-") opt.windowMin = stepWindow(opt.windowMin, -1);
    else if (name === "reply") return reply();
    else if (name === "service") {
      svcOn = true;
      svcSaid = "";
    } else if (name === "telegram") {
      tgOn = true;
      tg.status = "";
      if (!readTg().token) tg.entry = "";
      else void tgPrepare();
    } else if (name === "web") {
      startWeb(() => sessions);
      webOn = true;
    }
    else if (name === "done") opt.showDone = !opt.showDone;
    else if (name === "all") opt.showAll = !opt.showAll;
    else if (name === "bell") opt.bell = !opt.bell;
    else if (name === "seen") markSeen(clock());
    else if (name === "legend") legendOn = true;
    else if (name === "accounts") {
      acctOn = true;
      if (opt.usage && usage.reason) void fetchUsage().then(draw); // u has always retried a failing read
      if (opt.usage) tickAccounts(clock());
    }
    else if (name === "usage") {
      if (opt.usage) void fetchUsage().then(draw); // retry now, whatever the next try was set to
      if (opt.usage) void retryAccounts().then(draw);
    } else if (name.startsWith("focus:")) focusSid = focusSid === name.slice(6) ? null : name.slice(6);
    else if (name === "next") focusSid = nextFocus(sessions, clock(), out.columns || 140, focusSid);
    else if (name === "back") {
      if (!focusSid) return quit();
      else focusSid = null;
    }
    clear();
    draw();
  };

  /**
   * Key r: open the session that is waiting on you (or the one in focus) to answer it. Claude Code has no
   * way to put a line into a running session from outside, so this steps aside for `claude attach`, and
   * comes back when you leave it (← or Ctrl+Z).
   */
  const reply = () => {
    const sid = replyTarget(sessions, focusSid);
    const s = sessions.find((x) => x.sid === sid);
    if (!s) return say("nothing is waiting on you: focus a session (tab or click) to open it");
    if (s.remote) return say(`${s.name} is on ${s.remote.host}: answer it from the phone page or Telegram`);
    if (!s.jobId) return say(`${s.name} is not a background session: switch to its own terminal to answer it`);
    restore();
    const r = spawnSync(process.env.FLEET_ATTACH_CMD || "claude", ["attach", s.jobId], { stdio: "inherit" });
    out.write(enterScreen(opt.mouse));
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    if (r.status !== 0) say(`could not open ${s.name}: claude attach ${r.error ? "did not start" : `exited ${r.status}`}`);
    refresh();
    clear();
    draw();
  };
  const say = (text: string) => {
    Object.assign(notice, { text, until: clock() + 5000 });
    draw();
  };
  /** Step aside for a conversation in the ordinary terminal, then come back to the same screen. */
  const stepOut = (job: () => Promise<unknown>) => {
    away = true;
    out.write(leaveScreen(opt.mouse));
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    void job().finally(() => {
      away = false;
      out.write(enterScreen(opt.mouse));
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
      }
      refresh();
      clear();
      draw();
    });
  };

  setScanBudget(300); // the screen comes up with every session listed; those not read yet fill in over the next frames
  refresh(); // the first read, under the splash
  setScanProgress(undefined);
  await finishShine();
  process.off("SIGINT", leaveSplash);
  clear();
  retitle();
  draw();
  // Four frames a second, so spinners and celebrations move smoothly; the data is read every two seconds,
  // and only the rows that change are written (a frame takes a couple of milliseconds to lay out).
  setInterval(() => {
    if (away) return;
    frame++;
    if (frame % (FPS * 2) === 0 || scanPending) { // every two seconds, or every frame while sessions are still being read
      refresh();
      retitle();
    }
    if (frame % (FPS * 60) === 0) onScreen = undefined; // a full repaint once a minute (without clearing, so nothing flickers)
    draw();
  }, 1000 / FPS);
  out.on("resize", () => {
    clear();
    draw();
  });
  // Windows has no SIGTERM or SIGQUIT to listen for; Ctrl-Break and closing the window are its signals.
  for (const signal of process.platform === "win32" ? (["SIGINT", "SIGBREAK", "SIGHUP"] as const) : (["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const))
    try {
      process.on(signal, quit);
    } catch {}

  const KEYS: Record<string, string> = {
    q: "quit", "\x03": "quit", "\x1b": "back", "\t": "next", w: "web", t: "telegram", i: "service",
    "1": "mode:detail", "2": "mode:compact", "3": "mode:far", r: "reply",
    "+": "win+", "=": "win+", "-": "win-", _: "win-",
    d: "done", a: "all", b: "bell", u: "accounts", m: "menu", " ": "seen", "?": "legend",
  };
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const handle = (events: InputEvent[]) => {
      if (away) return; // the wizard reads the terminal itself
      const keys = events.filter((e) => e.kind === "key");
      if (keys.some((e) => e.kind === "key" && e.key === "\x03")) return quit(); // Ctrl-C quits from anywhere in a read
      // The background service screen: y installs or removes it, anything else closes it.
      if (svcOn) {
        for (const e of events)
          if ((e.kind === "key" && !svcKey(e.key)) || e.kind === "press") {
            svcOn = false;
            clear();
            break;
          }
        draw();
        return;
      }
      // The Telegram screen takes every key, a pasted token included; a click or a key it has no use for closes it.
      if (tgOn) {
        for (const e of events)
          if ((e.kind === "key" && !tgKey(e.key)) || e.kind === "press") {
            tgOn = false;
            tg.entry = undefined;
            clear();
            break;
          }
        draw();
        return;
      }
      for (const e of events) {
        if (e.kind === "other" || (e.kind === "key" && keys.length > PASTE_KEYS)) continue;
        // The legend is closed by a key or a click, which then does nothing else. A button's release is not a click, so the click that opened it does not close it.
        // The usage screen answers r (retry every read now), a (add an account) and x (remove one) itself.
        const wizard = acctOn && e.kind === "key" ? accountsKey(e.key) : undefined;
        if (wizard === "retry") {
          act("usage");
          continue;
        }
        if (wizard) return stepOut(() => accountWizard(wizard));
        // On the w screen, g switches between the phone's code and the glasses'.
        if (webOn && e.kind === "key" && e.key === "g") {
          webGlasses = !webGlasses;
          clear();
          draw();
          continue;
        }
        if (legendOn || webOn || acctOn) {
          legendOn = false;
          acctOn = false;
          webOn = false;
          webGlasses = false;
          clear();
          draw();
          continue;
        }
        if (e.kind === "press") {
          const hit = hits.find((h) => h.row === e.row && e.col >= h.x0 && e.col <= h.x1);
          if (hit) act(hit.act);
        } else if (KEYS[e.key]) act(KEYS[e.key]);
      }
    };
    let held = ""; // an escape sequence cut off at the end of the last read
    let heldTimer: ReturnType<typeof setTimeout> | undefined;
    process.stdin.on("data", (d: Buffer) => {
      clearTimeout(heldTimer);
      const { events, rest } = inputEvents(held + d.toString());
      held = rest;
      // Nothing more came: a lone ESC was the Esc key after all, and anything else cut off is dropped.
      if (rest)
        heldTimer = setTimeout(() => {
          const was = held;
          held = "";
          if (was === "\x1b") handle([{ kind: "key", key: "\x1b" }]);
        }, 60);
      handle(events);
    });
  }
}
