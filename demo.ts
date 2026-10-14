#!/usr/bin/env bun
// Runs Claude Fleet against a made-up set of sessions, so you can see every
// part of the screen without having anything running.
//
// Usage: bun demo.ts [demo options] [any fleet.ts options]
//
//   --six             six sessions sharing the screen: one needs you, five working
//   --all             (also a fleet option) adds a your-turn and an idle session to the finished one
//   --stalled         one agent has sat on a tool call for 14 minutes with its session idle
//   --runway          one session's context grows steadily, so "full in ~40m" shows
//   --ended           adds a completed workflow and a failed one
//   --account <name>  with --usage, a made-up account: current, extra-off, early (the 5-hour
//                     limit runs out before it resets), stale, none, remote
//   --seen <minutes>  as if you last looked that many minutes ago
//   --surprise        --stalled --runway --account early --seen 18
//   --real-machine    this machine's CPU, memory and load instead of made-up ones
//
// Nothing here touches your real sessions, login or usage figures. Set FLEET_NOW
// (milliseconds since 1970) to pin the clock and get the same frame every time.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
/** Take a demo-only option off the command line; what is left goes to fleet.ts. */
const flag = (name: string) => {
  const i = argv.indexOf(name);
  if (i >= 0) argv.splice(i, 1);
  return i >= 0;
};
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv.splice(i, 2)[1] : undefined;
};
const surprise = flag("--surprise");
const six = flag("--six");
const stalled = flag("--stalled") || surprise;
const runway = flag("--runway") || surprise;
const ended = flag("--ended");
const realMachine = flag("--real-machine");
const account = value("--account") ?? (surprise ? "early" : undefined);
const seenMin = value("--seen") ?? (surprise ? "18" : undefined);
const all = argv.includes("--all");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fleet-demo-"));
const now = Number(process.env.FLEET_NOW) || Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const MIN = 60_000;
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const write = (file: string, data: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** What a session loaded at start, sized so the context bar has something to split. */
const loaded = (toolChars: number, mcpChars: number) => [
  { type: "attachment", attachment: { type: "prompt_snapshot", systemPrompt: ["x".repeat(18_000)], tools: [{ name: "Bash", description: "x".repeat(toolChars), schema: {} }, ...(mcpChars ? [{ name: "mcp__db__query", description: "x".repeat(mcpChars), schema: {} }] : [])] } },
  { type: "attachment", attachment: { type: "instructions", files: [{ path: "CLAUDE.md", content: "x".repeat(21_000) }] } },
  { type: "attachment", attachment: { type: "skill_listing", isInitial: true, content: "x".repeat(12_000) } },
  { type: "attachment", attachment: { type: "agent_listing_delta", isInitial: true, addedLines: ["x".repeat(2_500)] } },
];

const TOOLS: [string, Record<string, string>][] = [
  ["Bash", { description: "Run the checkout test suite" }],
  ["Read", { file_path: "src/checkout/cart.ts" }],
  ["Edit", { file_path: "src/checkout/totals.ts" }],
  ["Grep", { pattern: "applyCoupon" }],
  ["Bash", { description: "Type-check the package" }],
];

/** A transcript: bursts of tool calls over the last half hour, ending `endAgo` ms ago. `used` is the context in use, or a function of how long ago. */
function transcript(opts: { calls: number; endAgo: number; ask?: string; says: string[]; used: number | ((msAgo: number) => number); pending?: [string, Record<string, unknown>]; final?: string }): unknown[] {
  const rows: unknown[] = [];
  const span = 30 * MIN - opts.endAgo;
  const used = (msAgo: number) => Math.round(typeof opts.used === "function" ? opts.used(msAgo) : opts.used);
  if (opts.ask) rows.push({ type: "user", timestamp: iso(29 * MIN), message: { content: opts.ask } });
  const times = Array.from({ length: opts.calls }, () => opts.endAgo + Math.pow(rnd(), 1.6) * span).sort((a, b) => b - a);
  if (times.length) times[times.length - 1] = opts.endAgo + 1000;
  times.forEach((t, i) => {
    const [name, input] = TOOLS[Math.floor(rnd() * TOOLS.length)];
    rows.push({ type: "assistant", timestamp: iso(t), message: { id: `m${i}`, model: "claude-opus-5-5", content: [{ type: "tool_use", name, input }], usage: { input_tokens: 4, cache_read_input_tokens: used(t), output_tokens: 80 + Math.floor(rnd() * 400) } } });
    rows.push({ type: "user", timestamp: iso(t - 900), message: { content: [{ type: "tool_result" }] } });
  });
  opts.says.forEach((text, i) => {
    const t = opts.endAgo + (opts.says.length - i) * 40_000;
    rows.push({ type: "assistant", timestamp: iso(t), message: { id: `s${i}`, model: "claude-opus-5-5", content: [{ type: "text", text }], usage: { input_tokens: 4, cache_read_input_tokens: used(t), output_tokens: 300 } } });
  });
  if (opts.pending) rows.push({ type: "assistant", timestamp: iso(opts.endAgo), message: { id: "p", model: "claude-opus-5-5", content: [{ type: "tool_use", name: opts.pending[0], input: opts.pending[1] }], usage: { input_tokens: 4, cache_read_input_tokens: used(opts.endAgo), output_tokens: 60 } } });
  if (opts.final) {
    rows.push({ type: "assistant", timestamp: iso(opts.endAgo + 2000), message: { id: "f", model: "claude-opus-5-5", content: [{ type: "tool_use", name: opts.final, input: {} }], usage: { input_tokens: 4, cache_read_input_tokens: used(opts.endAgo + 2000), output_tokens: 60 } } });
    rows.push({ type: "user", timestamp: iso(opts.endAgo), message: { content: [{ type: "tool_result" }] } });
  }
  return rows;
}

/** The made-up machine's processes: one per session, so each session has its own CPU and memory. */
const procs: { pid: number; ppid: number; cpu: number; rss: number; name: string }[] = [
  { pid: 80001, ppid: 1, cpu: 212, rss: 900_000, name: "bun" },
  { pid: 80002, ppid: 1, cpu: 88, rss: 600_000, name: "node" },
  { pid: 80003, ppid: 1, cpu: 41, rss: 400_000, name: "tsc" },
];
const GB = 1024 * 1024; // in the kilobytes ps reports

function session(n: number, o: { sid: string; name: string; kind: string; status: string; cwd: string; upMin: number; job?: Record<string, string>; main: unknown[]; branch: string; cpu?: number; mem?: number }) {
  // A session must belong to a live process. With the made-up machine each gets its own; otherwise they all borrow this one.
  const pid = realMachine ? process.pid : 90000 + n;
  procs.push({ pid, ppid: 1, cpu: o.cpu ?? 3, rss: Math.round((o.mem ?? 0.1) * GB), name: "claude" });
  write(path.join(home, "sessions", `${n}.json`), JSON.stringify({ pid, sessionId: o.sid, name: o.name, kind: o.kind, status: o.status, cwd: o.cwd, jobId: o.job ? `job${n}` : undefined, startedAt: now - o.upMin * MIN }));
  if (o.job) write(path.join(home, "jobs", `job${n}`, "state.json"), JSON.stringify(o.job));
  write(path.join(home, "projects", "-demo", `${o.sid}.jsonl`), jsonl(o.main.map((r: any) => (r.timestamp ? { ...r, gitBranch: o.branch } : r))));
  age(path.join(home, "projects", "-demo", `${o.sid}.jsonl`), o.main);
  return path.join(home, "projects", "-demo", o.sid);
}
/** Date a transcript by its last event, as a real one would be. */
const age = (file: string, rows: unknown[]) => {
  const last = Math.max(...rows.map((r: any) => Date.parse(r.timestamp ?? "")).filter((t) => !Number.isNaN(t)));
  fs.utimesSync(file, new Date(last), new Date(last));
};
const agent = (dir: string, id: string, meta: Record<string, string>, rows: unknown[]) => {
  write(path.join(dir, `agent-${id}.jsonl`), jsonl(rows));
  age(path.join(dir, `agent-${id}.jsonl`), rows);
  write(path.join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
};

// 1. A background job that is blocked on a question.
const a = "aaaaaaaa-0000-4000-8000-000000000001";
session(1, {
  sid: a, name: "checkout flow redesign", kind: "bg", status: "idle", cwd: "/work/shop", upMin: 190, branch: "feature/checkout-v2",
  job: { state: "blocked", detail: "migration drafted and tested against a copy", needs: "Approve dropping the legacy coupon_code column before I run the migration?" },
  main: [...loaded(70_000, 9_000), ...transcript({ calls: 46, endAgo: 6 * MIN, ask: "move coupons to the new promotions table and remove the old column", used: 372_000,
    says: ["The new promotions table is in place and every read now goes through it. All 212 checkout tests pass.", "The migration that drops coupon_code is written and has run cleanly against a copy of the data.\n- 41,208 rows were copied to promotions\n- 0 rows differ between the old column and the new table\n\nI have not run it for real, because dropping a column cannot be undone."] })],
});

/** A busy job running a workflow, with tasks: three agents fixing, two that have already reported. */
function busyJob(n: number, o: { sid: string; name: string; cwd: string; branch: string; wfId: string; upMin: number; quietReviewer?: boolean; growing?: boolean }) {
  // With --runway the context has grown by about 12k tokens a minute for the last ten minutes: 389k left, so full in about 40.
  const used = o.growing ? (msAgo: number) => 611_000 - 12_200 * Math.max(0, Math.min(msAgo / MIN, 12) - 2) : 611_000;
  const dir = session(n, {
    sid: o.sid, name: o.name, kind: "bg", status: "busy", cwd: o.cwd, upMin: o.upMin, branch: o.branch, mem: 0.4, cpu: o.quietReviewer ? 0.2 : 3,
    job: { state: "working", detail: "bisecting the three payment tests that fail one run in twenty" },
    main: [...loaded(118_000, 30_000), ...transcript({ calls: 30, endAgo: 2 * MIN, ask: "find out why the payment tests are flaky and fix them", used, pending: ["Workflow", { description: "Bisect and fix the flaky payment tests" }],
      says: ["Three tests fail intermittently, all in the payments suite. I'm running each two hundred times under load to find which ones share a cause.", "Two of the three share a cause: both read the clock twice and assume the same second. The third is separate. I've started a workflow with one agent per test, and a reviewer to confirm each fix."] })],
  });
  ["Reproduce each failure", "Find the shared cause", "Fix clock-dependent tests", "Fix retry test"].forEach((subject, i) => write(path.join(home, "tasks", o.sid, `${i + 1}.json`), JSON.stringify({ id: String(i + 1), subject, status: i < 2 ? "completed" : i === 2 ? "in_progress" : "pending", activeForm: "Fixing the clock-dependent tests" })));
  ["Verify under load", "Open the pull request"].forEach((subject, i) => write(path.join(home, "tasks", o.sid, `${i + 5}.json`), JSON.stringify({ id: String(i + 5), subject, status: "pending" })));
  const wf = path.join(dir, "subagents", "workflows", o.wfId);
  write(path.join(dir, "workflows", "scripts", `bisect-and-fix-${o.wfId}.js`), "");
  const wfAgents: [string, string, string, boolean, number][] = [
    ["w1", "reproduce:refund-rounding", "Reproduce", true, 14 * MIN],
    ["w2", "reproduce:retry-backoff", "Reproduce", true, 12 * MIN],
    ["w3", "fix:clock-in-refund", "Fix", false, 8_000],
    ["w4", "fix:retry-backoff", "Fix", false, 20_000],
    // With --stalled the reviewer has been silent on its tool call for 14 minutes, and the session's processes are idle.
    ["w5", "review:clock-in-refund", "Fix", false, (o.quietReviewer ? 14 : 4) * MIN],
  ];
  write(path.join(wf, "journal.jsonl"), jsonl([{ type: "launched" }, ...wfAgents.map(([id, label, phase]) => ({ type: "started", agentId: id, key: label, label, phase })), ...wfAgents.filter((x) => x[3]).map(([id]) => ({ type: "result", agentId: id, key: id, result: {} }))]));
  for (const [id, , phase, done, endAgo] of wfAgents)
    agent(wf, id, { agentType: "workflow-subagent", model: "opus", workflowPhase: phase }, transcript({ calls: 14 + Math.floor(rnd() * 20), endAgo, says: [], used: 90_000, final: done ? "StructuredOutput" : undefined, pending: !done && id === "w5" ? ["Bash", { description: "Run the refund tests 200 times under load" }] : undefined }));
}

// 2. A busy job running a workflow, with tasks.
busyJob(2, { sid: "bbbbbbbb-0000-4000-8000-000000000002", name: "flaky test hunt", cwd: "/work/shop", branch: "fix/flaky-payments", wfId: "wf_demo0001", upMin: 64, quietReviewer: stalled, growing: runway });

if (six) {
  // Five working sessions and the one that needs you: the squeezed layout. Each started a little earlier than the one before, so their order holds.
  const more: [string, string, string, number][] = [
    ["search reindex", "/work/docs", "feature/reindex", 71],
    ["billing export", "/work/shop", "fix/export-rounding", 83],
    ["upgrade tooling", "/work/shop", "chore/toolchain", 96],
    ["onboarding emails", "/work/mail", "feature/onboarding", 112],
  ];
  more.forEach(([name, cwd, branch, upMin], i) => busyJob(10 + i, { sid: `${"cdef"[i].repeat(8)}-0000-4000-8000-00000000001${i}`, name, cwd, branch, upMin, wfId: `wf_demo001${i}` }));
} else {
  // 3. An interactive session with two subagents.
  const c = "cccccccc-0000-4000-8000-000000000003";
  const cDir = session(3, {
    sid: c, name: "docs site search", kind: "interactive", status: "busy", cwd: "/work/docs", upMin: 22, branch: "main",
    main: [...loaded(62_000, 0), ...transcript({ calls: 18, endAgo: 15_000, ask: "why does search miss pages added this week?", used: 96_000, says: ["Search is built from an index that is only regenerated on release, so pages added since the last release are missing. I'm checking whether the build can regenerate it on every deploy."] })],
  });
  agent(path.join(cDir, "subagents"), "s1", { agentType: "Explore", model: "haiku", description: "Find where the search index is built" }, transcript({ calls: 22, endAgo: 5_000, says: [], used: 40_000 }));
  agent(path.join(cDir, "subagents"), "s2", { agentType: "general-purpose", model: "opus", description: "Measure index build time on a full deploy" }, transcript({ calls: 9, endAgo: 3 * MIN, says: [], used: 55_000, pending: ["Bash", { description: "Build the site with the index step enabled" }] }));
  agent(path.join(cDir, "subagents"), "s3", { agentType: "Explore", model: "haiku", description: "List pages added since the last release" }, transcript({ calls: 11, endAgo: 9 * MIN, says: [], used: 30_000, final: "SubagentHandback" }));

  if (ended) {
    // Two workflows that are over: one completed (its state file declares the phases), one failed.
    const over: [string, string, string, number, string[], number | undefined][] = [
      ["wf_demo0002", "link-check", "completed", 4 * MIN, ["Crawl", "Verify"], 412_000],
      ["wf_demo0003", "reindex-preview", "failed", 2 * MIN, ["Build"], undefined],
    ];
    for (const [wfId, name, status, endAgo, phases, tokens] of over) {
      const wf = path.join(cDir, "subagents", "workflows", wfId);
      write(path.join(cDir, "workflows", "scripts", `${name}-${wfId}.js`), "");
      write(path.join(cDir, "workflows", `${wfId}.json`), JSON.stringify({ workflowName: name, status, startTime: now - endAgo - 9 * MIN, durationMs: 9 * MIN, totalTokens: tokens, phases: phases.map((title) => ({ title })) }));
      write(path.join(wf, "journal.jsonl"), jsonl([{ type: "launched" }, ...phases.map((phase, i) => ({ type: "started", agentId: `e${i}`, key: phase, label: `${phase.toLowerCase()}:pages`, phase })), ...phases.map((_, i) => ({ type: "result", agentId: `e${i}`, key: `e${i}`, result: {} }))]));
      fs.utimesSync(path.join(wf, "journal.jsonl"), new Date(now - endAgo), new Date(now - endAgo));
      phases.forEach((phase, i) => agent(wf, `e${i}`, { agentType: "workflow-subagent", model: "sonnet", workflowPhase: phase }, transcript({ calls: 8, endAgo: endAgo + (phases.length - i) * MIN, says: [], used: 60_000, final: "StructuredOutput" })));
    }
  }
}

// 4. A finished job, hidden unless you pass --all.
session(4, { sid: "dddddddd-0000-4000-8000-000000000004", name: "rename billing module", kind: "bg", status: "idle", cwd: "/work/shop", upMin: 400, branch: "main", job: { state: "done", detail: "merged" }, main: transcript({ calls: 3, endAgo: 50 * MIN, says: ["Merged."], used: 40_000 }) });

if (all) {
  // 5 and 6. With --all: a session waiting for your next prompt, and one that is simply idle.
  session(5, { sid: "eeeeeeee-0000-4000-8000-000000000005", name: "release notes draft", kind: "interactive", status: "idle", cwd: "/work/docs", upMin: 95, branch: "docs/release-4.2",
    main: [...loaded(62_000, 0), ...transcript({ calls: 12, endAgo: 12 * MIN, ask: "draft the release notes for 4.2 from the merged pull requests", used: 148_000, says: ["The draft is in `docs/releases/4.2.md`: 14 changes grouped under Features, Fixes and Upgrading. Two pull requests had no description, so I summarised those from their diffs. Shall I open a pull request with it?"] })] });
  session(6, { sid: "ffffffff-0000-4000-8000-000000000006", name: "scratch", kind: "interactive", status: "idle", cwd: "/work/shop", upMin: 300, branch: "main", main: transcript({ calls: 2, endAgo: 48 * MIN, ask: "what does the totals helper round to?", says: [], used: 21_000 }) });
}

const env: Record<string, string | undefined> = { ...process.env, FLEET_HOME: home, XDG_CACHE_HOME: path.join(home, "cache") };
// One frame is drawn at exactly the moment the sessions were made for. A running demo keeps real time, unless FLEET_NOW pins it.
if (argv.includes("--once")) env.FLEET_NOW = String(now);

if (realMachine) env.FLEET_HIDE_PROCESSES = "1"; // leave this machine's process names off the screen
else {
  write(path.join(home, "machine.json"), JSON.stringify({
    cpu: 54, load: 14.6, memTotal: 128 * 1024 ** 3, memUsed: 0.38 * 128 * 1024 ** 3,
    cores: [58, 62, 49, 44, 37, 33, 30, 35, 41, 47, 66, 70, 72, 69, 81, 84],
    hist: [6, 7, 8, 8, 8, 9, 10, 14, 16, 22, 24, 20, 26, 33, 41, 44, 38, 43, 52, 55, 47, 54, 63, 54],
    procs,
  }));
  env.FLEET_MACHINE_FIXTURE = path.join(home, "machine.json");
}

if (account) {
  // A made-up account. Reset times are set from the clock, so the pace ticks land where the design shows them.
  const HOUR = 60 * MIN;
  const win = (pct: number, resetsInMs: number) => ({ utilization: pct, resets_at: new Date(now + resetsInMs).toISOString() });
  const week = win(21, 0.36 * 7 * 24 * HOUR); // 64% of the week gone
  const extra = { is_enabled: true, monthly_limit: 5000, used_credits: 1200, currency: "GBP", decimal_places: 2 };
  const figures: Record<string, { figures?: object; ageMin?: number; fail?: string }> = {
    current: { figures: { five_hour: win(38, 130 * MIN), seven_day: week, extra_usage: extra } },
    "extra-off": { figures: { five_hour: win(38, 130 * MIN), seven_day: week, seven_day_opus: win(12, 0.36 * 7 * 24 * HOUR), seven_day_sonnet: win(4, 0.36 * 7 * 24 * HOUR), extra_usage: { is_enabled: false } } },
    early: { figures: { five_hour: win(86, 85 * MIN), seven_day: week, extra_usage: extra } }, // 86% with 1h25 to go: full in about 35 minutes
    stale: { figures: { five_hour: win(38, 130 * MIN), seven_day: week, extra_usage: extra }, ageMin: 39, fail: "Anthropic answered 429" },
    none: { fail: "keychain: no answer in 5s" },
    remote: { fail: "keychain: closed to remote sessions (ssh/mosh)" },
  };
  const pick = figures[account];
  if (!pick) {
    console.error(`demo: unknown --account "${account}". One of: ${Object.keys(figures).join(", ")}`);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(2);
  }
  if (pick.figures) {
    write(path.join(home, "usage-fixture.json"), JSON.stringify({ ...pick.figures, fetchedAt: now - (pick.ageMin ?? 0) * MIN }));
    env.FLEET_USAGE_FIXTURE = path.join(home, "usage-fixture.json");
  }
  if (pick.fail) env.FLEET_USAGE_FAIL = pick.fail;
  if (!argv.includes("--usage")) argv.push("--usage");
}
if (seenMin) env.FLEET_SEEN = String(now - Number(seenMin) * MIN);

const fleet = path.join(import.meta.dir, "fleet.ts");
const r = spawnSync("bun", [fleet, ...argv], { stdio: "inherit", env });
fs.rmSync(home, { recursive: true, force: true });
process.exit(r.status ?? 0);
