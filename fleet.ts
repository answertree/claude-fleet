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

const CLAUDE = process.env.FLEET_HOME || process.env.AGENT_FLEET_HOME || path.join(os.homedir(), ".claude");
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

Keys: 1 2 3 view mode · + - window · a all sessions · d finished agents
      tab focus next session · b bell · esc leave focus · q quit
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
};

/** Read the command line into `opt`. Returns the one-shot command it asked for, if any. */
export function parseArgs(argv: string[]): "help" | undefined {
  if (argv.includes("--help") || argv.includes("-h")) return "help";
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
export const C = {
  dim: [92, 99, 112] as RGB,
  faint: [58, 64, 74] as RGB,
  text: [198, 205, 215] as RGB,
  white: [245, 247, 250] as RGB,
  green: [80, 200, 120] as RGB,
  yellow: [229, 181, 68] as RGB,
  red: [240, 98, 92] as RGB,
  blue: [97, 170, 255] as RGB,
  purple: [190, 148, 255] as RGB,
  cyan: [86, 205, 214] as RGB,
};
export const fg = (c: RGB, s: string) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${s}\x1b[39m`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
export const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as RGB;

export function charWidth(cp: number): number {
  if (cp < 0x1100) return 1;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  )
    return 2;
  return 1;
}
export const width = (s: string) => [...s].reduce((n, ch) => n + charWidth(ch.codePointAt(0)!), 0);

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

export function ingest(t: Tail, line: string) {
  if (ATTACHMENT.test(line.slice(0, 2000)) || (line.length < 400_000 && ATTACHMENT.test(line))) return absorb(t, line);
  if (line.length < 2 || !line.includes('"timestamp"')) {
    if (line.length < 20_000 && (line.includes('"ai-title"') || line.includes('"last-prompt"'))) {
      try {
        const o = JSON.parse(line);
        if (typeof o.aiTitle === "string") t.title = o.aiTitle;
        if (typeof o.lastPrompt === "string") t.lastPrompt = o.lastPrompt;
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
  if (o.type === "system" && o.subtype === "away_summary" && typeof o.content === "string") t.summary = o.content;
  if (o.type !== "assistant" && o.type !== "user") return;
  t.lastT = Math.max(t.lastT, ts);
  if (typeof o.gitBranch === "string" && o.gitBranch) t.branch = o.gitBranch;
  const content = o.message?.content;
  if (o.type === "assistant") {
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item?.type === "tool_use") {
          t.tools.push(ts);
          t.lastTool = { name: String(item.name), hint: hintFor(item.name, item.input), t: ts };
        }
      }
    }
    const u = o.message?.usage;
    const out = u?.output_tokens;
    if (typeof out === "number" && o.message?.id) t.tokens.set(o.message.id, [ts, out]);
    if (!o.isSidechain) {
      if (Array.isArray(content)) for (const item of content) if (item?.type === "text" && typeof item.text === "string" && item.text.trim()) {
          t.say = { text: item.text, t: ts };
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
    if (typed) t.ask = { text: typed, t: ts };
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
}
export interface Workflow {
  id: string;
  name: string;
  status: string;
  phase: string;
  phases: string[];
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

const journalCache = new Map<string, { mtime: number; started: Map<string, any>; results: Set<string> }>();
function journal(file: string) {
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return { mtime: 0, started: new Map<string, any>(), results: new Set<string>() };
  }
  const hit = journalCache.get(file);
  if (hit && hit.mtime === mtime) return hit;
  const started = new Map<string, any>();
  const results = new Set<string>();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (o.type === "started") started.set(o.agentId, o);
      else if (o.type === "result") results.add(o.agentId);
    } catch {}
  }
  const entry = { mtime, started, results };
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

function loadAgent(file: string, wf?: string, started?: any, done = false): Agent | undefined {
  const tail = pump(file);
  if (!tail) return undefined;
  const m = meta(file);
  const finalTool = !!tail.lastTool && FINAL_TOOLS.has(tail.lastTool.name) && tail.lastResultT >= tail.lastTool.t;
  return {
    id: path.basename(file, ".jsonl").replace(/^agent-/, ""),
    label: String(started?.label || m.description || path.basename(file, ".jsonl")),
    type: String(m.agentType ?? ""),
    model: shortModel(m.model),
    tail,
    done: done || finalTool,
    wf,
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
        const script = scripts.find((s) => s.endsWith(`-${wfId}.js`));
        const wfAgents: Agent[] = [];
        for (const name of ls(wfDir)) {
          if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
          const id = name.slice(6, -6);
          const a = loadAgent(path.join(wfDir, name), wfId, j.started.get(id), j.results.has(id) || !!state);
          if (a) wfAgents.push(a);
        }
        const lastT = Math.max(j.mtime, ...wfAgents.map((a) => a.tail.mtime), 0);
        const running = wfAgents.filter((a) => !a.done);
        const latest = [...j.started.values()].pop();
        const phases: string[] = Array.isArray(state?.phases) ? state.phases.map((p: any) => String(p?.title ?? "")) : [];
        workflows.push({
          id: wfId,
          name: String(state?.workflowName || (script ? script.slice(0, -(wfId.length + 4)) : wfId)),
          status: state?.status ? String(state.status) : running.length ? "running" : "stopped",
          phase: String(running[0] ? (j.started.get(running[0].id)?.phase ?? "") : (latest?.phase ?? "")),
          phases,
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
        active: String(current?.activeForm || current?.subject || ""),
      };
    }

    let job: Session["job"];
    if (reg.jobId && /^[\w-]+$/.test(String(reg.jobId))) {
      const st = readJson(path.join(CLAUDE, "jobs", String(reg.jobId), "state.json"));
      if (st) job = { state: String(st.state ?? ""), detail: typeof st.detail === "string" ? st.detail : "", needs: typeof st.needs === "string" ? st.needs : "" };
    }

    const title = mains.map((m) => m.title).find(Boolean);
    const named = reg.name && reg.name !== sid.slice(0, 8) ? String(reg.name) : title || String(reg.name ?? sid.slice(0, 8));
    sessions.push({
      sid,
      pid: reg.pid,
      name: named,
      kind: String(reg.kind ?? ""),
      status: String(reg.status ?? ""),
      cwd: String(reg.cwd ?? ""),
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

export const usage = { at: 0, busy: false, data: undefined as any, err: "" };
function readLogin(): { token: string; expiresAt: number } | undefined {
  const pick = (raw: string) => {
    const o = JSON.parse(raw)?.claudeAiOauth;
    return o?.accessToken ? { token: String(o.accessToken), expiresAt: Number(o.expiresAt ?? 0) } : undefined;
  };
  try {
    if (process.platform === "darwin") {
      const r = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", timeout: 5000 });
      if (r.status === 0 && r.stdout.trim()) return pick(r.stdout);
    }
  } catch {}
  try {
    return pick(fs.readFileSync(path.join(CLAUDE, ".credentials.json"), "utf8"));
  } catch {}
  return undefined;
}
async function fetchUsage() {
  if (usage.busy) return;
  usage.busy = true;
  usage.at = Date.now();
  try {
    const login = readLogin();
    if (!login) throw new Error("no Claude Code login found");
    if (login.expiresAt && login.expiresAt < Date.now()) throw new Error("login expired; any Claude Code session will renew it");
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${login.token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Anthropic answered ${res.status}`);
    usage.data = await res.json();
    usage.err = "";
  } catch (e: any) {
    usage.err = String(e?.message ?? e).slice(0, 80);
  } finally {
    usage.busy = false;
  }
}

function usageRow(W: number, now: number): string {
  const lead = fg(C.dim, " account ");
  if (!usage.data) return lead + fg(C.dim, usage.err ? `usage unavailable: ${usage.err}` : "fetching usage…");
  const resets = (iso: unknown) => {
    const t = Date.parse(String(iso ?? ""));
    if (Number.isNaN(t)) return "";
    if (t - now < 24 * 3600_000) return ` · resets in ${ago(t - now)}`;
    return ` · resets ${new Date(t).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}`;
  };
  const GW = W >= 140 ? 16 : 10;
  const one = (label: string, win: any) => {
    if (!win || typeof win.utilization !== "number") return "";
    const pct = win.utilization;
    return fg(C.dim, `  ${label} `) + gauge(pct, GW, toneFor(pct)) + fg(toneFor(pct), ` ${Math.round(pct)}%`) + fg(C.dim, resets(win.resets_at));
  };
  const d = usage.data;
  let line = lead + one("5-hour", d.five_hour) + " " + one("week", d.seven_day);
  if (W >= 150) line += one("opus wk", d.seven_day_opus) + one("sonnet wk", d.seven_day_sonnet);
  const x = d.extra_usage;
  if (x && W >= 120) {
    const money = (n: number) => `${x.currency === "GBP" ? "£" : x.currency === "EUR" ? "€" : "$"}${(n / 10 ** (x.decimal_places ?? 2)).toFixed(0)}`;
    line += fg(C.dim, "   extra usage ") + (x.is_enabled ? fg(C.text, `${money(x.used_credits ?? 0)} of ${money(x.monthly_limit ?? 0)}`) : fg(C.dim, "off"));
  }
  if (usage.err) line += fg(C.dim, `   (stale: ${usage.err})`);
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
  now: string; // one-line summary of what it is doing
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
  return { main, needs: clean(needs), yourTurn, now: clean(s.job?.detail || main?.summary || "") };
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
        lastT,
      };
    })
    .sort((a, b) => Number(b.showNeeds) - Number(a.showNeeds) || Number(b.s.status === "busy") - Number(a.s.status === "busy") || b.s.startedAt - a.s.startedAt);
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
  const now = Date.now();
  sessions = scan(now);
  prune(now);
  sampleMachine();
  if (opt.usage && now - usage.at > 5 * 60_000) void fetchUsage();
  // Ring once when a session starts waiting on the person.
  const nowNeeding = new Set(sessions.filter((s) => factsOf(s).needs).map((s) => s.sid));
  if (opt.bell && !opt.once) for (const sid of nowNeeding) if (!needing.has(sid)) process.stdout.write("\x07");
  needing.clear();
  for (const sid of nowNeeding) needing.add(sid);
}

if (import.meta.main) {
  if (parseArgs(process.argv.slice(2)) === "help") {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (opt.once) {
    sampleMachine();
    if (opt.usage) await fetchUsage();
    await new Promise((r) => setTimeout(r, 300)); // a second CPU sample, so the gauge is a rate
    refresh();
    const cols = Number(process.env.COLUMNS) || process.stdout.columns || 140;
    const rows = Number(process.env.LINES) || process.stdout.rows || 45;
    process.stdout.write(render(sessions, cols, rows, Date.now()).join("\n") + "\n");
    process.exit(0);
  }

  const out = process.stdout;
  const draw = () => {
    const lines = render(sessions, out.columns || 140, out.rows || 45, Date.now());
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
    else if (name.startsWith("focus:")) focusSid = focusSid === name.slice(6) ? null : name.slice(6);
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
    d: "done", a: "all", b: "bell",
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
