// Every Claude account's usage on one screen: key u in the fleet, or `bun fleet.ts accounts`.
//
// Each other account is a Claude Code config folder of its own (CLAUDE_CONFIG_DIR=~/.claude-work claude,
// then /login), listed in ~/.config/claude-fleet/accounts.json. The fleet reads each folder's stored login
// the way it reads this Mac's own: held in memory for one request to Anthropic's usage address, never
// refreshed, written, logged or printed by the fleet. A login that has expired, or soon will, is renewed the
// way Claude Code renews its own: the fleet starts Claude Code in that folder, unseen, for a few seconds and
// closes it again (no message is sent), then reads the figures afresh.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  C,
  ICON,
  REASON,
  Row,
  accountView,
  accountViewOf,
  claudeEmail,
  loginEmail,
  machinesByAccount,
  selfHost,
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
  svcLog,
} from "./fleet.ts";

const ACCOUNTS_HELP = `Every Claude account's usage on one screen (key u in the fleet shows the same).

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

/** Renewals: when each account last had one, and whether it is under way. At most one every quarter of an hour. */
const renewals = new Map<string, { at: number; running: boolean }>();
export const RENEW_EVERY_MS = 15 * 60_000;
/**
 * Renew an account's login: Claude Code started in its folder (CLAUDE_CONFIG_DIR) in a tmux of its own, from a
 * scratch folder, unseen, and closed after `holdMs`. Claude Code renews its login as it starts; no message is
 * sent, so no usage is spent. Then the account is read again. False when it is too soon to try again, or tmux
 * is not to be had. FLEET_RENEW_CMD stands in for claude (tests).
 */
export function renewLogin(
  a: AccountConfig,
  now = Date.now(),
  holdMs = 10_000,
): boolean {
  const was = renewals.get(keyOf(a));
  if (was && (was.running || now - was.at < RENEW_EVERY_MS)) return false;
  const server = [
    "-L",
    `fleet-renew-${createHash("sha256").update(a.dir).digest("hex").slice(0, 8)}`,
  ];
  const scratch = path.join(os.tmpdir(), "claude-fleet-renew");
  try {
    fs.mkdirSync(scratch, { recursive: true });
  } catch {}
  spawnSync("tmux", [...server, "kill-server"], { timeout: 3000 });
  const claude = process.env.FLEET_RENEW_CMD || "claude";
  const started = spawnSync(
    "tmux",
    [
      ...server,
      "new-session",
      "-d",
      "-x",
      "120",
      "-y",
      "40",
      "-c",
      scratch,
      "env",
      `CLAUDE_CONFIG_DIR=${a.dir}`,
      claude,
    ],
    { timeout: 5000 },
  );
  if (started.status !== 0) return false;
  renewals.set(keyOf(a), { at: now, running: true });
  svcLog(
    `renewing the ${a.name} login: Claude Code started in ${tilde(a.dir)} for ${Math.round(holdMs / 1000)}s`,
  );
  setTimeout(() => {
    spawn("tmux", [...server, "kill-server"], { stdio: "ignore" }).on(
      "close",
      () => {
        renewals.set(keyOf(a), { at: now, running: false });
        stateOf(a).nextTry = 0; // read it again now
      },
    );
  }, holdMs);
  return true;
}
/** When an account's login was last renewed (tests and the screen). */
export const renewedAt = (a: AccountConfig) => renewals.get(keyOf(a));

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
  // An expired login is renewed (Claude Code started in its folder, unseen); one that expires within half an hour is
  // renewed ahead of time, and read meanwhile. Only when a renewal has not helped is the fix left to you.
  if ("login" in found && found.login.expiresAt) {
    const left = found.login.expiresAt - Date.now();
    if (left < 30 * 60_000) {
      const renewing = renewLogin(a) || !!renewedAt(a)?.running;
      if (left < 0)
        return {
          reason: renewing
            ? "token expired · renewing…"
            : `token expired · run claude in ${tilde(a.dir)}`,
        };
    }
  }
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
/** Read every listed account now, whenever its next read was due (key r on the usage screen). */
export const retryAccounts = (now = clock()) =>
  Promise.all(loadAccounts().accounts.map((a) => fetchAccount(a, now)));
/** Called on every refresh of the fleet: read each listed account that is due. */
export function tickAccounts(now: number) {
  for (const a of loadAccounts().accounts)
    if (now >= stateOf(a).nextTry) void fetchAccount(a, now);
}

/** The email Claude Code shows for a folder's login, from its .claude.json. */
const emailOf = claudeEmail;

/** One account as the screen shows it, with the fleet's machines signed in to it now. */
export interface AccountLine {
  name: string;
  email: string;
  view: AccountView;
  machines: string[];
  unlisted?: boolean; // in use by a machine, but not in your list
}
/**
 * Your listed accounts, always in the list's order, each with the machines of the fleet signed in to it right now (by
 * the email of each machine's Claude login). An account a machine uses that is not in the list follows, so its usage
 * is never out of sight. Only an account in use is spending at today's pace, so only it says when it will be full; the
 * others say when they reset.
 */
export function accountLines(now: number): AccountLine[] {
  if (!opt.usage) return []; // --no-usage: no login is read, this Mac's or any other
  const users = machinesByAccount();
  const out: AccountLine[] = [];
  const listed = new Set<string>();
  for (const a of loadAccounts().accounts) {
    const st = stateOf(a);
    const email = emailOf(path.join(a.dir, ".claude.json"));
    const view = accountViewOf(usageStateOf(st, now), st, now);
    const machines = email ? (users.get(email.toLowerCase()) ?? []) : [];
    if (email) listed.add(email.toLowerCase());
    out.push({
      name: a.name,
      email,
      machines,
      view: machines.length
        ? view
        : {
            ...view,
            limits: view.limits.map((l) => ({ ...l, fullIn: undefined })),
          },
    });
  }
  const mine = loginEmail().toLowerCase();
  for (const [email, machines] of users) {
    if (listed.has(email)) continue;
    // This Mac's own login reads its own figures; another machine's are read there, so here they are only named.
    const view: AccountView =
      email === mine
        ? accountView(now)
        : { kind: "none", limits: [], asOf: 0, nextTry: 0, busy: false };
    out.push({ name: "not in your list", email, machines, view, unlisted: true });
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
export function accountsScreen(
  W: number,
  H: number,
  now: number,
  leave = "closes",
): string[] {
  const out: string[] = [];
  const title = new Row(W);
  title.segs(2, [
    [`${ICON.claude} CLAUDE USAGE`, C.cyan, true],
    ["   every account you use · read only", C.dim],
  ]);
  out.push(title.toString(), "");
  const { problems } = loadAccounts();
  const lines = accountLines(now);
  for (const { name, email, view: a, machines, unlisted } of lines) {
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
    // On the right: the machines signed in to it now; before them, how the reading stands, where it fits.
    const using = machines.length ? `● ${machines.join(" · ")}` : "";
    const usingAt = using ? W - width(using) : W;
    if (using) head.put(usingAt, using, C.green, true);
    // Not in your list: how to add it comes with whatever the reading says, and alone where both do not fit.
    if (unlisted) {
      const now = machines.includes(selfHost()) ? [...status] : [`read on ${machines.join(" · ")}`];
      status.splice(0, status.length, ...now.map((f) => `${f} ${ICON.sep} a adds it here`), "a adds it here");
    }
    const room = usingAt - col - 4;
    const said = status.length && room > 4 ? firstFit(status, room) : "";
    if (said)
      head.putr(usingAt - (using ? 3 : 1), said, a.kind !== "current" && a.reason ? C.red : C.dim);
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
    r.put(
      2,
      fitOrDrop(
        "Usage is off (--no-usage): no account's login is read.",
        W - 3,
      ),
      C.text,
    );
    out.push(r.toString(), "");
  } else if (!loadAccounts().accounts.length) {
    const r = new Row(W);
    r.segs(2, [
      ["No other accounts yet. Press ", C.text],
      ["a", C.white, true],
      [" to add one: fleet opens Claude's sign-in page for it.", C.text],
    ]);
    out.push(r.toString(), "");
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
  const keys: Seg[] = [
    ...(opt.usage
      ? ([
          ["r", C.white, true],
          [" retry now   ", C.dim],
        ] as Seg[])
      : []),
    ["a", C.white, true],
    [" add account   ", C.dim],
    ...(loadAccounts().accounts.length
      ? ([
          ["x", C.white, true],
          [" remove   ", C.dim],
        ] as Seg[])
      : []),
    ["any other key ", C.dim],
    [leave, C.dim],
  ];
  const col = foot.segs(2, keys);
  const where = `list: ${tilde(accountsPath())}`;
  if (col + 3 + width(where) <= W) foot.putr(W - 1, where, C.faint);
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

// ───────────────────────── setting an account up ─────────────────────────
//
// Adding an account is a short conversation in the ordinary terminal (the fleet steps aside for it, as
// it does for key r): a name, a folder, then Claude Code's own sign-in (`claude auth login`, which opens
// the browser) run with CLAUDE_CONFIG_DIR set to that folder, so the login lands there and nowhere else.
// Afterwards it checks that the sign-in was recorded and that the keychain holds it where fleet looks.

/** How a wizard talks: a question answered with a line, a line said, and a pause before something else takes the terminal. */
export interface WizardIO {
  ask(question: string): Promise<string>;
  say(line: string): void;
  pause(): void;
}
/** What a wizard does outside itself; the tests replace each. */
export interface WizardDeps {
  run: (args: string[], dir: string) => number | null; // claude, with CLAUDE_CONFIG_DIR=dir: its exit status, null when it did not start
  has: (service: string) => boolean; // whether a keychain entry exists
  file: string; // the accounts list
}
const claudeIn = (args: string[], dir: string): number | null => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CONFIG_DIR: dir,
  };
  delete env.CLAUDECODE; // fleet may itself have been started from a Claude Code session
  const r = spawnSync(process.env.FLEET_CLAUDE_CMD || "claude", args, {
    stdio: "inherit",
    env,
  });
  return r.error ? null : r.status;
};
const realDeps = (): WizardDeps => ({
  run: claudeIn,
  has: keychainHas,
  file: accountsPath(),
});
const yes = (answer: string) => /^\s*y/i.test(answer);
/** A folder name from an account name: ~/.claude-work for "Work". */
export const suggestedDir = (name: string): string =>
  `~/.claude-${
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "account"
  }`;

/** Ask for an account, sign it in and list it. Returns it, or undefined when nothing was listed. */
export async function addAccountWizard(
  io: WizardIO,
  deps: WizardDeps = realDeps(),
): Promise<AccountConfig | undefined> {
  const { accounts } = loadAccounts(deps.file);
  io.say(
    "Add a Claude account to fleet. It signs in to a folder of its own, so the account you are using now is not touched.",
  );
  io.say("");
  let name = "";
  for (;;) {
    name = safeLine(
      await io.ask("Name for it (work, client, …; enter to stop): "),
    );
    if (!name) return undefined;
    if (width(name) > 24) io.say(`${ICON.failed} at most 24 characters`);
    else if (accounts.some((a) => a.name === name))
      io.say(`${ICON.failed} ${name} is listed already`);
    else break;
  }
  let cfg: AccountConfig | undefined;
  while (!cfg) {
    const suggested = suggestedDir(name);
    const dir =
      (await io.ask(`Folder for its login [${suggested}]: `)).trim() ||
      suggested;
    const parsed = parseAccounts([{ name, dir }]);
    const taken =
      parsed.accounts[0] &&
      accounts.find((a) => a.dir === parsed.accounts[0].dir);
    if (taken) io.say(`${ICON.failed} ${taken.name} uses that folder already`);
    else if (parsed.problems.length)
      io.say(`${ICON.failed} ${parsed.problems[0].replace(`${name}: `, "")}`);
    else cfg = parsed.accounts[0];
  }
  const before = emailOf(path.join(cfg.dir, ".claude.json"));
  let signIn = true;
  if (before)
    signIn = yes(
      await io.ask(
        `That folder is signed in as ${before} already. Sign in again? [y/N] `,
      ),
    );
  if (signIn) {
    const email = (
      await io.ask(
        "Its email, to fill in on the sign-in page (enter to skip): ",
      )
    ).trim();
    io.say("");
    io.say(
      "Opening Claude's sign-in page in your browser (claude auth login). Sign in with that account.",
    );
    io.pause();
    const status = deps.run(
      ["auth", "login", "--claudeai", ...(email ? ["--email", email] : [])],
      cfg.dir,
    );
    io.say("");
    if (status !== 0) {
      io.say(
        `${ICON.failed} the sign-in did not finish (${status === null ? "claude did not start" : `claude exited ${status}`})`,
      );
      if (!yes(await io.ask("List it anyway? [y/N] "))) return undefined;
    }
  }
  const email = emailOf(path.join(cfg.dir, ".claude.json"));
  io.say(
    email
      ? `${ICON.done} signed in as ${email}`
      : `${ICON.failed} no sign-in is recorded in ${tilde(cfg.dir)} yet`,
  );
  if (process.platform === "darwin") {
    const found = keychainServices(cfg).find(deps.has);
    io.say(
      found
        ? `${ICON.done} its login is in the keychain, where fleet looks`
        : `${ICON.failed} fleet cannot find its login in the keychain; bun fleet.ts accounts --check says more`,
    );
  } else if (!exists(path.join(cfg.dir, ".credentials.json")))
    io.say(`${ICON.failed} no login file in ${tilde(cfg.dir)}`);
  saveAccounts([...accounts, cfg], deps.file);
  io.say(
    `${ICON.done} listed ${name}: fleet reads its usage every five minutes`,
  );
  return cfg;
}

/** Take an account off the list, and, if you say so, sign it out of Claude in its folder. Returns its name, or undefined. */
export async function removeAccountWizard(
  io: WizardIO,
  deps: WizardDeps = realDeps(),
): Promise<string | undefined> {
  const { accounts } = loadAccounts(deps.file);
  if (!accounts.length) return void io.say("No accounts are listed.");
  accounts.forEach((a, i) => io.say(`  ${i + 1}  ${a.name}  ${tilde(a.dir)}`));
  const pick = Number(
    (await io.ask("Remove which one? (number; enter to stop) ")).trim(),
  );
  const a = Number.isInteger(pick) ? accounts[pick - 1] : undefined;
  if (!a) return undefined;
  saveAccounts(
    accounts.filter((x) => x !== a),
    deps.file,
  );
  io.say(`${ICON.done} took ${a.name} off the list`);
  if (
    yes(
      await io.ask(
        `Also sign it out of Claude (claude auth logout in ${tilde(a.dir)})? [y/N] `,
      ),
    )
  ) {
    io.pause();
    const status = deps.run(["auth", "logout"], a.dir);
    io.say(
      status === 0
        ? `${ICON.done} signed out`
        : `${ICON.failed} claude ${status === null ? "did not start" : `exited ${status}`}`,
    );
  }
  return a.name;
}

/** Run a wizard in the ordinary terminal (raw mode off), with ctrl-c giving up. `hold` waits for enter at the end, so its last words can be read. */
export async function inTerminal<T>(
  wizard: (io: WizardIO) => Promise<T>,
  hold = false,
): Promise<T | undefined> {
  let rl: ReturnType<typeof createInterface> | undefined;
  const ac = new AbortController();
  const line = () => {
    if (!rl) {
      rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.on("SIGINT", () => ac.abort());
    }
    return rl;
  };
  const io: WizardIO = {
    ask: (q) => line().question(q, { signal: ac.signal }),
    say: (text) => process.stdout.write(text + "\n"),
    pause: () => {
      rl?.close(); // claude gets the terminal to itself
      rl = undefined;
    },
  };
  process.stdout.write("\n");
  try {
    const result = await wizard(io);
    if (hold) await io.ask("\nPress enter to go back. ");
    return result;
  } catch (e: any) {
    if (e?.name !== "AbortError") throw e;
    process.stdout.write("\nstopped\n");
    return undefined;
  } finally {
    io.pause();
  }
}
/** The keys the accounts screen answers itself, for the fleet's key handler: anything else closes it. */
export const accountsKey = (
  key: string,
): "add" | "remove" | "retry" | undefined =>
  key === "a"
    ? "add"
    : key === "x"
      ? "remove"
      : key === "r"
        ? "retry"
        : undefined;
export const accountWizard = (kind: "add" | "remove") =>
  inTerminal(
    (io) => (kind === "add" ? addAccountWizard(io) : removeAccountWizard(io)),
    true,
  );

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
  if (argv[0] === "add" && !argv[1])
    process.exit((await inTerminal((io) => addAccountWizard(io))) ? 0 : 1);
  if (argv[0] === "remove" && !argv[1])
    process.exit((await inTerminal((io) => removeAccountWizard(io))) ? 0 : 1);
  if (argv[0] === "add") {
    const name = safeLine(argv[1] ?? "");
    const dir = argv[2] ?? suggestedDir(name);
    const next = parseAccounts([
      ...accounts.map((a) => ({ ...a })),
      { name, dir },
    ]);
    const added = next.accounts.find((a) => a.name === name);
    if (!added || next.accounts.length !== accounts.length + 1)
      fail(next.problems.at(-1) ?? "could not add that account");
    saveAccounts(next.accounts);
    put(`listed ${name}: ${tilde(added!.dir)}`);
    if (!emailOf(path.join(added!.dir, ".claude.json")))
      put(
        `not signed in there yet: CLAUDE_CONFIG_DIR=${tilde(added!.dir)} claude auth login`,
      );
    process.exit(0);
  }
  if (argv[0] === "remove") {
    if (!accounts.some((a) => a.name === argv[1]))
      fail(`no account called ${argv[1]}`);
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
      put(`  signed in as ${email || "(no sign-in recorded in .claude.json)"}`);
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
    const reads: Promise<unknown>[] = opt.usage
      ? accounts.map((a) => fetchAccount(a, now))
      : [];
    if (opt.usage) reads.push(fetchUsage(now));
    await Promise.all(reads);
    process.stdout.write(
      accountsScreen(
        Number(process.env.COLUMNS) || process.stdout.columns || 100,
        Number(process.env.LINES) || process.stdout.rows || 30,
        clock(),
        "quits",
      ).join("\n") + "\n",
    );
    process.exit(0);
  }
  const out = process.stdout;
  let away = false; // a wizard has the terminal
  const restore = guardTerminal(() => {
    out.write(leaveScreen(false));
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  });
  const draw = () => {
    if (!away)
      out.write(
        "\x1b[H" +
          accountsScreen(
            out.columns || 100,
            out.rows || 30,
            clock(),
            "quits",
          ).join("\n"),
      );
  };
  const tick = () => {
    const t = clock();
    if (opt.usage && t >= usage.nextTry) void fetchUsage(t).then(draw);
    for (const a of opt.usage ? loadAccounts().accounts : [])
      if (t >= stateOf(a).nextTry) void fetchAccount(a, t).then(draw);
    draw();
  };
  const enter = () => {
    out.write(enterScreen(false));
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
    }
  };
  enter();
  tick();
  setInterval(tick, 1000);
  out.on("resize", () => {
    out.write("\x1b[2J");
    draw();
  });
  if (process.stdin.isTTY)
    process.stdin.on("data", async (d: Buffer) => {
      if (away) return;
      const kind = accountsKey(d.toString());
      if (kind === "retry") {
        if (opt.usage) void fetchUsage().then(draw);
        if (opt.usage) void retryAccounts().then(draw);
        return;
      }
      if (!kind) {
        restore();
        process.exit(0);
      }
      away = true;
      restore();
      await accountWizard(kind);
      away = false;
      enter();
      tick();
    });
  return new Promise<never>(() => {});
}
