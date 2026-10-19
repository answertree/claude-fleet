// Every Claude account's usage on one screen: key c in the fleet, or `bun fleet.ts accounts`.
//
// Each other account is a Claude Code config folder of its own (CLAUDE_CONFIG_DIR=~/.claude-work claude,
// then /login), listed in ~/.config/claude-fleet/accounts.json. The fleet reads each folder's stored login
// the way it reads this Mac's own: held in memory for one request to Anthropic's usage address, never
// refreshed, written, logged or printed. So the login you are working in is never touched, and an
// expired login says so and waits for a Claude Code session in that folder to renew it.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  C,
  ICON,
  REASON,
  Row,
  accountView,
  accountViewOf,
  askAnthropic,
  clock,
  enterScreen,
  fetchUsage,
  figureTone,
  figuresOnly,
  firstFit,
  fitOrDrop,
  fullInText,
  guardTerminal,
  hhmm,
  leaveScreen,
  limitGauge,
  opt,
  readClaudeUsage,
  readJson,
  readLogin,
  reasonForms,
  resetText,
  retryDelay,
  roughly,
  safeLine,
  usage,
  usageStateOf,
  width,
  type AccountView,
  type LimitView,
  type Reading,
  type Seg,
  type UsageFigures,
} from "./fleet.ts";

const ACCOUNTS_HELP = `Every Claude account's usage on one screen (key c in the fleet shows the same).

Usage: bun fleet.ts accounts [command]

  (none)            the live screen: this Mac's login, then each account below
  --once            print it once and exit
  add <name> <dir>  list an account: <dir> is the Claude Code config folder it
                    is logged in to (default ~/.claude-<name>)
  remove <name>     take it off the list (the login itself is left alone)
  --check           for each account, say whether its folder, login file and
                    keychain entry are there (never what is in them)

To add an account:
  1  CLAUDE_CONFIG_DIR=~/.claude-work claude     then /login with that account, /exit
  2  bun fleet.ts accounts add work ~/.claude-work

The list is ${"${XDG_CONFIG_HOME:-~/.config}"}/claude-fleet/accounts.json:
  [{ "name": "work", "dir": "~/.claude-work" }]
An entry may name its keychain entry ("keychain": "Claude Code-credentials-1a2b3c4d")
if --check cannot find it; only entries whose name begins "Claude Code" are read.
`;

/** One account on the list: a name to show, the Claude Code config folder it is logged in to, and optionally its keychain entry. */
export interface AccountConfig {
  name: string;
  dir: string; // absolute
  keychain?: string;
}
export const accountsPath = () =>
  path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "claude-fleet",
    "accounts.json",
  );
const home = () => os.homedir();
/** This Mac's own Claude Code folder. Listing it as another account would read the same login twice. */
const ownDir = () =>
  path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(home(), ".claude"));
export const expandHome = (p: string): string =>
  p === "~" ? home() : p.startsWith("~/") ? path.join(home(), p.slice(2)) : p;
/** The way a folder is written in the list: under your home folder it starts with ~. */
const tilde = (p: string): string =>
  p.startsWith(home() + "/") ? "~" + p.slice(home().length) : p;
const KEYCHAIN_NAME = /^Claude Code[\w .-]{0,60}$/; // nothing but a Claude Code login is ever asked of the keychain

/** Read the list: every good entry, and a line for each one that is not, saying why. */
export function parseAccounts(raw: unknown): {
  accounts: AccountConfig[];
  problems: string[];
} {
  const accounts: AccountConfig[] = [];
  const problems: string[] = [];
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as any)?.accounts)
      ? (raw as any).accounts
      : undefined;
  if (!list)
    return {
      accounts,
      problems:
        raw === undefined ? [] : ["accounts.json: not a list of accounts"],
    };
  list.forEach((e: any, i: number) => {
    const at = `entry ${i + 1}`;
    const name = typeof e?.name === "string" ? safeLine(e.name) : "";
    if (!name || width(name) > 24)
      return void problems.push(`${at}: needs a name of 1 to 24 characters`);
    if (accounts.some((a) => a.name === name))
      return void problems.push(`${name}: listed twice`);
    const given = typeof e?.dir === "string" ? expandHome(e.dir.trim()) : "";
    if (!path.isAbsolute(given))
      return void problems.push(
        `${name}: dir must be a full path or start with ~/`,
      );
    const dir = path.resolve(given);
    if (dir === ownDir())
      return void problems.push(
        `${name}: that is this Mac's own login, which is always shown`,
      );
    if (
      e.keychain !== undefined &&
      (typeof e.keychain !== "string" || !KEYCHAIN_NAME.test(e.keychain))
    )
      return void problems.push(
        `${name}: keychain must be a name beginning "Claude Code"`,
      );
    accounts.push({
      name,
      dir,
      ...(e.keychain ? { keychain: e.keychain } : {}),
    });
  });
  return { accounts, problems };
}

/**
 * Where Claude Code keeps the login of a folder other than ~/.claude: a keychain entry named after the first
 * eight hex digits of the SHA-256 of CLAUDE_CONFIG_DIR as it was set. That may have been written with a
 * trailing slash, so both spellings are tried; an entry named in the list comes first.
 */
export function keychainServices(a: AccountConfig): string[] {
  const named = (dir: string) =>
    `Claude Code-credentials-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
  return [
    ...new Set([
      ...(a.keychain ? [a.keychain] : []),
      named(a.dir),
      named(a.dir + "/"),
    ]),
  ];
}

/** The list as it is on disk, read again when the file changes. */
let listed: { mtime: number; accounts: AccountConfig[]; problems: string[] } = {
  mtime: -1,
  accounts: [],
  problems: [],
};
export function loadAccounts(file = accountsPath()): {
  accounts: AccountConfig[];
  problems: string[];
} {
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {}
  if (mtime !== listed.mtime) {
    const raw = mtime ? readJson(file) : undefined;
    listed = {
      mtime,
      ...(mtime && raw === undefined
        ? { accounts: [], problems: ["accounts.json: not JSON"] }
        : parseAccounts(raw)),
    };
  }
  return listed;
}
function saveAccounts(accounts: AccountConfig[], file = accountsPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = accounts.map((a) => ({
    name: a.name,
    dir: tilde(a.dir),
    ...(a.keychain ? { keychain: a.keychain } : {}),
  }));
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
}

/** One account's reads, kept the way the fleet keeps its own (`usage` in fleet.ts). */
export interface AccountState {
  at: number;
  nextTry: number;
  busy: boolean;
  failures: number;
  reason: string;
  data?: UsageFigures;
  fetchedAt: number;
}
const states = new Map<string, AccountState>();
const keyOf = (a: AccountConfig) => `${a.name}\0${a.dir}`;
export const stateOf = (a: AccountConfig): AccountState => {
  let st = states.get(keyOf(a));
  if (!st)
    states.set(
      keyOf(a),
      (st = {
        at: 0,
        nextTry: 0,
        busy: false,
        failures: 0,
        reason: "",
        fetchedAt: 0,
      }),
    );
  return st;
};

/** One read for an account: its own keychain entries and login file, then Anthropic. FLEET_USAGE_FAIL and FLEET_USAGE_FIXTURE stand in, as for the fleet's own read. */
async function readAccount(
  a: AccountConfig,
  now: number,
): Promise<Reading | { reason: string }> {
  if (process.env.FLEET_USAGE_FAIL)
    return { reason: process.env.FLEET_USAGE_FAIL };
  if (process.env.FLEET_USAGE_FIXTURE) {
    const o = readJson(process.env.FLEET_USAGE_FIXTURE);
    return o
      ? { figures: figuresOnly(o), fetchedAt: now }
      : { reason: REASON.network("fixture not found") };
  }
  const found = readLogin(
    keychainServices(a),
    path.join(a.dir, ".credentials.json"),
  );
  // The fleet's wording says any Claude Code session renews an expired login; here it has to be one in this account's folder.
  if (
    "login" in found &&
    found.login.expiresAt &&
    found.login.expiresAt < Date.now()
  )
    return { reason: `token expired · run claude in ${tilde(a.dir)}` };
  return askAnthropic(found, now);
}

/** Read an account now. While its own read fails, the figures Claude Code last fetched in that folder stand in. `read` is replaced only by tests. */
export async function fetchAccount(
  a: AccountConfig,
  now = clock(),
  read: (
    a: AccountConfig,
    now: number,
  ) => Promise<Reading | { reason: string }> = readAccount,
) {
  const st = stateOf(a);
  if (st.busy) return;
  st.busy = true;
  st.at = now;
  try {
    const r = await read(a, now);
    if ("reason" in r) {
      st.reason = r.reason.slice(0, 80);
      st.failures++;
      const cached = readClaudeUsage(path.join(a.dir, ".claude.json"));
      if (
        cached &&
        cached.fetchedAt > st.fetchedAt &&
        cached.fetchedAt <= now + 60_000 &&
        Object.keys(cached.figures).length
      ) {
        st.data = cached.figures;
        st.fetchedAt = cached.fetchedAt;
      }
    } else {
      st.data = figuresOnly(r.figures);
      st.fetchedAt = r.fetchedAt;
      st.reason = "";
      st.failures = 0;
    }
  } finally {
    st.busy = false;
    st.nextTry = now + retryDelay(st.reason, st.failures);
  }
}
/** Called on every refresh of the fleet: read each listed account that is due. */
export function tickAccounts(now: number) {
  for (const a of loadAccounts().accounts)
    if (now >= stateOf(a).nextTry) void fetchAccount(a, now);
}

/** The email Claude Code shows for a folder's login, from its .claude.json: that one key and no other. */
function emailOf(file: string): string {
  const e = readJson(file, 1 << 30)?.oauthAccount?.emailAddress;
  return typeof e === "string" ? safeLine(e).slice(0, 60) : "";
}

/** One account as the screen shows it. */
export interface AccountLine {
  name: string;
  email: string;
  view: AccountView;
}
/** This Mac's own login first (when the fleet reads usage at all), then each listed account. */
export function accountLines(now: number): AccountLine[] {
  const out: AccountLine[] = [];
  if (opt.usage)
    out.push({
      name: "this Mac",
      email: emailOf(
        path.join(
          process.env.FLEET_HOME || process.env.AGENT_FLEET_HOME || home(),
          ".claude.json",
        ),
      ),
      view: accountView(now),
    });
  if (!opt.usage) return out; // --no-usage: no login is read, this Mac's or any other
  for (const a of loadAccounts().accounts) {
    const st = stateOf(a);
    out.push({
      name: a.name,
      email: emailOf(path.join(a.dir, ".claude.json")),
      view: accountViewOf(usageStateOf(st, now), st, now),
    });
  }
  return out;
}

/** A limit's row: label, gauge with its pace tick, the figure, then when it fills (in red, at this pace) or resets. `more` follows on the right where it fits. */
function limitRow(
  W: number,
  label: string,
  l: LimitView | undefined,
  stale: boolean,
  now: number,
  more: Seg[] = [],
): string {
  const r = new Row(W);
  const GW = W >= 120 ? 32 : W >= 90 ? 24 : 12;
  const gaugeAt = 6 + 7;
  const valueEnd = gaugeAt + GW + 4;
  r.put(6, label, C.dim);
  r.paste(gaugeAt, limitGauge(l?.pct, GW, l?.tick, stale), GW);
  if (!l) {
    r.putr(valueEnd, "--", C.dim);
    return r.toString();
  }
  const tone = figureTone(l.pct);
  r.putr(
    valueEnd,
    `${Math.round(l.pct)}%`,
    stale ? C.dim : tone.color,
    !stale && tone.bold,
  );
  const detail = valueEnd + 3;
  const room = W - detail;
  let end = detail;
  if (l.fullIn && !stale)
    end = r.put(
      detail,
      firstFit(
        [fullInText(l.fullIn / 60_000), `~${roughly(l.fullIn / 60_000)}`],
        room,
      ),
      C.red,
      true,
    );
  else
    end = r.put(
      detail,
      firstFit(
        [
          resetText(l.resetsAt, now),
          resetText(l.resetsAt, now, "short"),
          resetText(l.resetsAt, now, "bare"),
        ],
        room,
      ),
      C.dim,
    );
  const moreW = more.reduce((n, [t]) => n + width(t), 0);
  if (more.length && end + 4 + moreW <= W) r.segs(end + 4, more);
  return r.toString();
}

/** The accounts screen, `W` by `H`: a block of two limits for each account, and how to add one. */
export function accountsScreen(W: number, H: number, now: number): string[] {
  const out: string[] = [];
  const title = new Row(W);
  title.segs(2, [
    [`${ICON.claude} CLAUDE ACCOUNTS`, C.cyan, true],
    ["   usage on every login · read only", C.dim],
  ]);
  out.push(title.toString(), "");
  const { problems } = loadAccounts();
  const lines = accountLines(now);
  for (const { name, email, view: a } of lines) {
    const head = new Row(W);
    let col = head.put(2, name, C.white, true);
    if (email)
      col = head.put(
        Math.max(col + 2, 14),
        fitOrDrop(email, W - col - 4),
        C.dim,
      );
    const stale = a.kind === "stale";
    const why = a.reason ? reasonForms(a.reason) : [];
    const status: string[] =
      a.kind === "none"
        ? a.busy || !a.nextTry
          ? ["reading…"]
          : [
              ...why.map((f) => `no reading yet ${ICON.sep} ${f}`),
              "no reading yet",
            ]
        : stale
          ? [
              ...why.map((f) => `as of ${hhmm(a.asOf)} ${ICON.sep} ${f}`),
              `as of ${hhmm(a.asOf)}`,
            ]
          : a.reason
            ? [
                ...why.map((f) => `cached figures ${ICON.sep} ${f}`),
                "cached figures",
              ]
            : [];
    const room = W - col - 3;
    const said = status.length ? firstFit(status, room) : "";
    if (said)
      head.putr(W - 1, said, a.kind !== "current" && a.reason ? C.red : C.dim);
    out.push(head.toString());
    const lim = (k: string) => a.limits.find((l) => l.key === k);
    const opus = lim("seven_day_opus");
    const sonnet = lim("seven_day_sonnet");
    const weekMore: Seg[] = [];
    for (const l of [opus, sonnet])
      if (l)
        weekMore.push(
          [`${l.label} `, C.dim],
          [`${Math.round(l.pct)}%  `, stale ? C.dim : figureTone(l.pct).color],
        );
    if (a.extra?.enabled)
      weekMore.push(
        ["extra ", C.dim],
        [a.extra.used, C.text],
        [` of ${a.extra.limit}`, C.dim],
      );
    out.push(limitRow(W, "5h", lim("five_hour"), stale, now));
    out.push(limitRow(W, "7d", lim("seven_day"), stale, now, weekMore));
    out.push("");
  }
  if (!opt.usage) {
    const r = new Row(W);
    r.put(2, fitOrDrop("Usage is off (--no-usage): no account's login is read.", W - 3), C.text);
    out.push(r.toString(), "");
  } else if (!loadAccounts().accounts.length) {
    const say = (text: string, color = C.dim) => {
      const r = new Row(W);
      r.put(2, fitOrDrop(text, W - 3), color);
      out.push(r.toString());
    };
    say("No other accounts listed yet. For each one:", C.text);
    say(
      "1  CLAUDE_CONFIG_DIR=~/.claude-work claude     then /login with that account, /exit",
    );
    say("2  bun fleet.ts accounts add work ~/.claude-work");
    out.push("");
  }
  for (const p of problems) {
    const r = new Row(W);
    r.segs(2, [
      [`${ICON.failed} `, C.red],
      [fitOrDrop(p, W - 5), C.dim],
    ]);
    out.push(r.toString());
  }
  while (out.length < H - 1) out.push("");
  const foot = new Row(W);
  foot.put(
    2,
    fitOrDrop(
      `any key closes ${ICON.sep} list: ${tilde(accountsPath())} ${ICON.sep} bun fleet.ts accounts --help`,
      W - 3,
    ),
    C.dim,
  );
  return [...out.slice(0, H - 1), foot.toString()];
}

/** Whether a keychain entry exists, from the exit status alone: what it prints (even without -w) is thrown away unread. */
function keychainHas(service: string): boolean {
  if (process.platform !== "darwin") return false;
  const r = spawnSync("security", ["find-generic-password", "-s", service], {
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 5000,
  });
  return r.status === 0;
}
const exists = (p: string) => {
  try {
    return fs.statSync(p).isFile() || fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** `bun fleet.ts accounts …`. It never returns. */
export async function accountsMain(argv: string[]): Promise<never> {
  const put = (s: string) => process.stdout.write(s + "\n");
  const fail = (s: string): never => {
    process.stderr.write(s + "\n");
    process.exit(1);
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(ACCOUNTS_HELP);
    process.exit(0);
  }
  const { accounts, problems } = loadAccounts();
  if (argv[0] === "add") {
    const name = safeLine(argv[1] ?? "");
    const dir = argv[2] ?? `~/.claude-${name}`;
    const next = parseAccounts([
      ...accounts.map((a) => ({ ...a })),
      { name, dir },
    ]);
    const added = next.accounts.find((a) => a.name === name);
    if (!added || next.accounts.length !== accounts.length + 1)
      fail(next.problems.at(-1) ?? "could not add that account");
    saveAccounts(next.accounts);
    put(`listed ${name}: ${tilde(added!.dir)}`);
    if (!exists(path.join(added!.dir, ".claude.json")))
      put(
        `not logged in there yet: CLAUDE_CONFIG_DIR=${tilde(added!.dir)} claude, then /login and /exit`,
      );
    process.exit(0);
  }
  if (argv[0] === "remove") {
    if (!accounts.some((a) => a.name === argv[1]))
      fail(`no account called ${argv[1] ?? "(none given)"}`);
    saveAccounts(accounts.filter((a) => a.name !== argv[1]));
    put(`took ${argv[1]} off the list`);
    process.exit(0);
  }
  if (argv.includes("--check")) {
    for (const p of problems) put(`${ICON.failed} ${p}`);
    if (!accounts.length) put(`no accounts listed in ${tilde(accountsPath())}`);
    for (const a of accounts) {
      put(`${a.name}  ${tilde(a.dir)}`);
      put(`  folder       ${exists(a.dir) ? "there" : "MISSING"}`);
      const email = emailOf(path.join(a.dir, ".claude.json"));
      put(`  logged in as ${email || "(no login recorded in .claude.json)"}`);
      put(
        `  login file   ${exists(path.join(a.dir, ".credentials.json")) ? "there" : "none (normal on a Mac)"}`,
      );
      if (process.platform === "darwin") {
        const found = keychainServices(a).find(keychainHas);
        put(
          `  keychain     ${found ? `found: ${found}` : `none of ${keychainServices(a).join(", ")}`}`,
        );
      }
    }
    process.exit(0);
  }

  opt.usage = !argv.includes("--no-usage") && process.env.FLEET_USAGE !== "0"; // this Mac's own login, as parseArgs would set it
  const now = clock();
  if (argv.includes("--once") || !process.stdout.isTTY) {
    const reads: Promise<unknown>[] = opt.usage ? accounts.map((a) => fetchAccount(a, now)) : [];
    if (opt.usage) reads.push(fetchUsage(now));
    await Promise.all(reads);
    process.stdout.write(
      accountsScreen(
        Number(process.env.COLUMNS) || process.stdout.columns || 100,
        Number(process.env.LINES) || process.stdout.rows || 30,
        clock(),
      ).join("\n") + "\n",
    );
    process.exit(0);
  }
  const out = process.stdout;
  const restore = guardTerminal(() => {
    out.write(leaveScreen(false));
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  });
  const draw = () =>
    out.write(
      "\x1b[H" +
        accountsScreen(out.columns || 100, out.rows || 30, clock()).join("\n"),
    );
  const tick = () => {
    const t = clock();
    if (opt.usage && t >= usage.nextTry) void fetchUsage(t).then(draw);
    for (const a of opt.usage ? loadAccounts().accounts : [])
      if (t >= stateOf(a).nextTry) void fetchAccount(a, t).then(draw);
    draw();
  };
  out.write(enterScreen(false));
  tick();
  setInterval(tick, 1000);
  out.on("resize", () => {
    out.write("\x1b[2J");
    draw();
  });
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", () => {
      restore();
      process.exit(0);
    });
  }
  return new Promise<never>(() => {});
}
