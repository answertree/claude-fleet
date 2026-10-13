#!/usr/bin/env bun
// Runs Claude Fleet against a made-up set of sessions, so you can see every
// part of the screen without having anything running.
//
// Usage: bun demo.ts [any fleet.ts options]

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fleet-demo-"));
const now = Date.now();
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
  { type: "attachment", attachment: { type: "prompt_snapshot", systemPrompt: ["x".repeat(18_000)], tools: [{ name: "Bash", description: "x".repeat(toolChars), schema: {} }, { name: "mcp__db__query", description: "x".repeat(mcpChars), schema: {} }] } },
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

/** A transcript: bursts of tool calls over the last half hour, ending `endAgo` ms ago. */
function transcript(opts: { calls: number; endAgo: number; ask?: string; says: string[]; used: number; pending?: [string, Record<string, unknown>]; final?: string }): unknown[] {
  const rows: unknown[] = [];
  const span = 30 * MIN - opts.endAgo;
  if (opts.ask) rows.push({ type: "user", timestamp: iso(29 * MIN), message: { content: opts.ask } });
  const times = Array.from({ length: opts.calls }, () => opts.endAgo + Math.pow(rnd(), 1.6) * span).sort((a, b) => b - a);
  if (times.length) times[times.length - 1] = opts.endAgo + 1000;
  times.forEach((t, i) => {
    const [name, input] = TOOLS[Math.floor(rnd() * TOOLS.length)];
    rows.push({ type: "assistant", timestamp: iso(t), message: { id: `m${i}`, model: "claude-opus-5-5", content: [{ type: "tool_use", name, input }], usage: { input_tokens: 4, cache_read_input_tokens: opts.used, output_tokens: 80 + Math.floor(rnd() * 400) } } });
    rows.push({ type: "user", timestamp: iso(t - 900), message: { content: [{ type: "tool_result" }] } });
  });
  opts.says.forEach((text, i) =>
    rows.push({ type: "assistant", timestamp: iso(opts.endAgo + (opts.says.length - i) * 40_000), message: { id: `s${i}`, model: "claude-opus-5-5", content: [{ type: "text", text }], usage: { input_tokens: 4, cache_read_input_tokens: opts.used, output_tokens: 300 } } }),
  );
  if (opts.pending) rows.push({ type: "assistant", timestamp: iso(opts.endAgo), message: { id: "p", model: "claude-opus-5-5", content: [{ type: "tool_use", name: opts.pending[0], input: opts.pending[1] }], usage: { input_tokens: 4, cache_read_input_tokens: opts.used, output_tokens: 60 } } });
  if (opts.final) {
    rows.push({ type: "assistant", timestamp: iso(opts.endAgo + 2000), message: { id: "f", model: "claude-opus-5-5", content: [{ type: "tool_use", name: opts.final, input: {} }], usage: { input_tokens: 4, cache_read_input_tokens: opts.used, output_tokens: 60 } } });
    rows.push({ type: "user", timestamp: iso(opts.endAgo), message: { content: [{ type: "tool_result" }] } });
  }
  return rows;
}

function session(n: number, o: { sid: string; name: string; kind: string; status: string; cwd: string; upMin: number; job?: Record<string, string>; main: unknown[]; branch: string }) {
  write(path.join(home, "sessions", `${n}.json`), JSON.stringify({ pid: process.pid, sessionId: o.sid, name: o.name, kind: o.kind, status: o.status, cwd: o.cwd, jobId: o.job ? `job${n}` : undefined, startedAt: now - o.upMin * MIN }));
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

// 2. A busy job running a workflow, with tasks.
const b = "bbbbbbbb-0000-4000-8000-000000000002";
const bDir = session(2, {
  sid: b, name: "flaky test hunt", kind: "bg", status: "busy", cwd: "/work/shop", upMin: 64, branch: "fix/flaky-payments",
  job: { state: "working", detail: "bisecting the three payment tests that fail one run in twenty" },
  main: [...loaded(118_000, 30_000), ...transcript({ calls: 30, endAgo: 2 * MIN, ask: "find out why the payment tests are flaky and fix them", used: 611_000, pending: ["Workflow", { description: "Bisect and fix the flaky payment tests" }],
    says: ["Three tests fail intermittently, all in the payments suite. I'm running each two hundred times under load to find which ones share a cause.", "Two of the three share a cause: both read the clock twice and assume the same second. The third is separate. I've started a workflow with one agent per test, and a reviewer to confirm each fix."] })],
});
["Reproduce each failure", "Find the shared cause", "Fix clock-dependent tests", "Fix retry test"].forEach((subject, i) => write(path.join(home, "tasks", b, `${i + 1}.json`), JSON.stringify({ id: String(i + 1), subject, status: i < 2 ? "completed" : i === 2 ? "in_progress" : "pending", activeForm: "Fixing the clock-dependent tests" })));
["Verify under load", "Open the pull request"].forEach((subject, i) => write(path.join(home, "tasks", b, `${i + 5}.json`), JSON.stringify({ id: String(i + 5), subject, status: "pending" })));
const wf = path.join(bDir, "subagents", "workflows", "wf_demo0001");
write(path.join(bDir, "workflows", "scripts", "bisect-and-fix-wf_demo0001.js"), "");
const wfAgents: [string, string, string, boolean, number][] = [
  ["w1", "reproduce:refund-rounding", "Reproduce", true, 14 * MIN],
  ["w2", "reproduce:retry-backoff", "Reproduce", true, 12 * MIN],
  ["w3", "fix:clock-in-refund", "Fix", false, 8_000],
  ["w4", "fix:retry-backoff", "Fix", false, 20_000],
  ["w5", "review:clock-in-refund", "Fix", false, 4 * MIN],
];
write(path.join(wf, "journal.jsonl"), jsonl([{ type: "launched" }, ...wfAgents.map(([id, label, phase]) => ({ type: "started", agentId: id, key: label, label, phase })), ...wfAgents.filter((x) => x[3]).map(([id]) => ({ type: "result", agentId: id, key: id, result: {} }))]));
for (const [id, , phase, done, endAgo] of wfAgents)
  agent(wf, id, { agentType: "workflow-subagent", model: "opus", workflowPhase: phase }, transcript({ calls: 14 + Math.floor(rnd() * 20), endAgo, says: [], used: 90_000, final: done ? "StructuredOutput" : undefined, pending: !done && id === "w5" ? ["Bash", { description: "Run the refund tests 200 times under load" }] : undefined }));

// 3. An interactive session with two subagents.
const c = "cccccccc-0000-4000-8000-000000000003";
const cDir = session(3, {
  sid: c, name: "docs site search", kind: "interactive", status: "busy", cwd: "/work/docs", upMin: 22, branch: "main",
  main: [...loaded(62_000, 0), ...transcript({ calls: 18, endAgo: 15_000, ask: "why does search miss pages added this week?", used: 96_000, says: ["Search is built from an index that is only regenerated on release, so pages added since the last release are missing. I'm checking whether the build can regenerate it on every deploy."] })],
});
agent(path.join(cDir, "subagents"), "s1", { agentType: "Explore", model: "haiku", description: "Find where the search index is built" }, transcript({ calls: 22, endAgo: 5_000, says: [], used: 40_000 }));
agent(path.join(cDir, "subagents"), "s2", { agentType: "general-purpose", model: "opus", description: "Measure index build time on a full deploy" }, transcript({ calls: 9, endAgo: 3 * MIN, says: [], used: 55_000, pending: ["Bash", { description: "Build the site with the index step enabled" }] }));
agent(path.join(cDir, "subagents"), "s3", { agentType: "Explore", model: "haiku", description: "List pages added since the last release" }, transcript({ calls: 11, endAgo: 9 * MIN, says: [], used: 30_000, final: "SubagentHandback" }));

// 4. A finished job, hidden unless you pass --all.
session(4, { sid: "dddddddd-0000-4000-8000-000000000004", name: "rename billing module", kind: "bg", status: "idle", cwd: "/work/shop", upMin: 400, branch: "main", job: { state: "done", detail: "merged" }, main: transcript({ calls: 3, endAgo: 50 * MIN, says: ["Merged."], used: 40_000 }) });

const fleet = path.join(import.meta.dir, "fleet.ts");
const r = spawnSync("bun", [fleet, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, FLEET_HOME: home, FLEET_HIDE_PROCESSES: "1" } });
fs.rmSync(home, { recursive: true, force: true });
process.exit(r.status ?? 0);
