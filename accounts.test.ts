// Tests for accounts.ts: the list of other Claude accounts, their reads and their screen.
// Nothing here reads a real login, the real keychain or the network.

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as A from "./accounts.ts";
import * as F from "./fleet.ts";

const SCRATCH = fs.mkdtempSync(
  path.join(os.tmpdir(), "claude-fleet-accounts-test-"),
);
process.env.XDG_CONFIG_HOME = path.join(SCRATCH, "config");
process.env.XDG_CACHE_HOME = path.join(SCRATCH, "cache");
process.env.FLEET_HOME = path.join(SCRATCH, "home");
delete process.env.FLEET_USAGE;
delete process.env.FLEET_USAGE_FIXTURE;
delete process.env.FLEET_USAGE_FAIL;
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));
const NOW = Date.UTC(2026, 9, 13, 23, 51, 22);
const MIN = 60_000;
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const HOME = os.homedir();

describe("the accounts list", () => {
  test("takes names and folders, ~ included, and says what is wrong with the rest", () => {
    const { accounts, problems } = A.parseAccounts([
      { name: "work", dir: "~/.claude-work/" },
      {
        name: "side",
        dir: "/tmp/side",
        keychain: "Claude Code-credentials-1a2b3c4d",
      },
      { name: "work", dir: "~/.claude-other" },
      { name: "rel", dir: "relative/dir" },
      { name: "", dir: "/x" },
      { name: "own", dir: "~/.claude" },
      { name: "sneaky", dir: "/y", keychain: "iCloud password" },
    ]);
    expect(accounts).toEqual([
      { name: "work", dir: path.join(HOME, ".claude-work") },
      {
        name: "side",
        dir: "/tmp/side",
        keychain: "Claude Code-credentials-1a2b3c4d",
      },
    ]);
    expect(problems).toEqual([
      "work: listed twice",
      "rel: dir must be a full path or start with ~/",
      "entry 5: needs a name of 1 to 24 characters",
      "own: that is this Mac's own login, which is always shown",
      'sneaky: keychain must be a name beginning "Claude Code"',
    ]);
  });
  test("a file that is not a list is one problem, and no file is none", () => {
    expect(A.parseAccounts({ nope: 1 }).problems).toEqual([
      "accounts.json: not a list of accounts",
    ]);
    expect(A.parseAccounts(undefined)).toEqual({ accounts: [], problems: [] });
    expect(
      A.parseAccounts({ accounts: [{ name: "a", dir: "/a" }] }).accounts,
    ).toEqual([{ name: "a", dir: "/a" }]);
  });
  test("names on screen are made safe", () => {
    expect(
      A.parseAccounts([{ name: "a\x1b[31mb", dir: "/a" }]).accounts[0].name,
    ).not.toContain("\x1b");
  });
});

describe("keychain entries", () => {
  test("Claude Code's naming for a folder, with and without a trailing slash; a named entry first", () => {
    // Worked out apart from the code: printf '%s' /tmp/side | shasum -a 256, and the same with the slash.
    expect(A.keychainServices({ name: "side", dir: "/tmp/side" })).toEqual(["Claude Code-credentials-9ee2f422", "Claude Code-credentials-53a96f1f"]);
    expect(
      A.keychainServices({
        name: "side",
        dir: "/tmp/side",
        keychain: "Claude Code-credentials-x",
      })[0],
    ).toBe("Claude Code-credentials-x");
  });
});

describe("reading an account", () => {
  const acct: A.AccountConfig = {
    name: "work",
    dir: path.join(SCRATCH, "work"),
  };
  test("figures are kept, and only figures", async () => {
    await A.fetchAccount(acct, NOW, async (_a, now) => ({
      figures: {
        five_hour: {
          utilization: 30,
          resets_at: new Date(NOW + 60 * MIN).toISOString(),
        },
        token: "x",
      } as any,
      fetchedAt: now,
    }));
    const st = A.stateOf(acct);
    expect(st.reason).toBe("");
    expect(Object.keys(st.data!)).toEqual(["five_hour"]);
    expect(st.nextTry).toBe(NOW + 5 * MIN);
  });
  test("a failure keeps the old figures, says why, and backs off", async () => {
    await A.fetchAccount(acct, NOW + MIN, async () => ({
      reason: "token expired · run claude in ~/.claude-work",
    }));
    const st = A.stateOf(acct);
    expect(st.reason).toBe("token expired · run claude in ~/.claude-work");
    expect(st.data?.five_hour).toBeDefined();
    expect(st.nextTry).toBe(NOW + 2 * MIN);
  });
  test("while failing, figures Claude Code fetched in that folder stand in when newer", async () => {
    const b: A.AccountConfig = { name: "b", dir: path.join(SCRATCH, "b") };
    fs.mkdirSync(b.dir, { recursive: true });
    fs.writeFileSync(
      path.join(b.dir, ".claude.json"),
      JSON.stringify({
        cachedUsageUtilization: {
          fetchedAtMs: NOW - MIN,
          utilization: { seven_day: { utilization: 55, resets_at: null } },
        },
      }),
    );
    await A.fetchAccount(b, NOW, async () => ({
      reason: "Anthropic answered 401",
    }));
    expect(A.stateOf(b).data?.seven_day).toEqual({
      utilization: 55,
      resets_at: null,
    });
    expect(A.stateOf(b).fetchedAt).toBe(NOW - MIN);
  });
});

describe("renewing a login", () => {
  test("starts Claude Code in the account's folder, unseen, closes it, reads again; not again within a quarter hour", async () => {
    if (Bun.spawnSync(["tmux", "-V"]).exitCode !== 0) return; // needs tmux, as the fleet does
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-renew-"));
    const seen = path.join(dir, "seen");
    const fake = path.join(dir, "claude");
    fs.writeFileSync(fake, `#!/bin/sh\necho "$CLAUDE_CONFIG_DIR" > "${seen}"\nsleep 30\n`, { mode: 0o755 });
    const a = { name: "work", dir: path.join(dir, ".claude-work") };
    process.env.FLEET_RENEW_CMD = fake;
    try {
      A.stateOf(a).nextTry = Date.now() + 3_600_000;
      expect(A.renewLogin(a, Date.now(), 400)).toBe(true);
      expect(A.renewLogin(a, Date.now(), 400)).toBe(false); // under way
      await Bun.sleep(1200);
      expect(fs.readFileSync(seen, "utf8").trim()).toBe(a.dir);
      expect([A.renewedAt(a)?.running, A.stateOf(a).nextTry]).toEqual([false, 0]); // closed, and to be read again
      expect(A.renewLogin(a, Date.now(), 400)).toBe(false); // too soon
      expect(A.renewLogin(a, Date.now() + A.RENEW_EVERY_MS + 1, 400)).toBe(true);
      await Bun.sleep(900);
    } finally {
      delete process.env.FLEET_RENEW_CMD;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the accounts screen", () => {
  test("this Mac first, then each listed account with its email; how to add one when none are listed", async () => {
    const was = F.opt.usage;
    F.opt.usage = true;
    const file = A.accountsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const dir = path.join(SCRATCH, "screen");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "me@work.example" } }),
    );
    fs.writeFileSync(file, JSON.stringify([{ name: "client", dir }]));
    const acct = A.loadAccounts().accounts[0];
    await A.fetchAccount(acct, NOW, async (_a, now) => ({
      figures: {
        five_hour: {
          utilization: 91,
          resets_at: new Date(NOW + 30 * MIN).toISOString(),
        },
        seven_day: {
          utilization: 20,
          resets_at: new Date(NOW + 3 * 86_400_000).toISOString(),
        },
      },
      fetchedAt: now,
    }));
    const lines = A.accountsScreen(100, 20, NOW).map(strip);
    expect(lines).toHaveLength(20);
    expect(lines.every((l) => l.length <= 100)).toBe(true);
    const at = lines.findIndex((l) => l.includes("client"));
    expect(lines.findIndex((l) => l.includes("this Mac"))).toBeLessThan(at);
    expect(lines[at]).toContain("me@work.example");
    expect(lines[at + 1]).toMatch(/5h .* 91%/);
    expect(lines[at + 2]).toMatch(/7d .* 20%/);
    expect(lines.join("\n")).not.toContain("No other accounts");

    fs.writeFileSync(file, "[]");
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000)); // a new mtime, so the list is read again
    expect(A.accountsScreen(100, 20, NOW).map(strip).join("\n")).toContain(
      "No other accounts yet",
    );
    F.opt.usage = was; // the fleet's tests run in this process too
  });
  test("a narrow screen keeps every line inside it", () => {
    for (const W of [50, 70])
      expect(
        A.accountsScreen(W, 16, NOW).every((l) => strip(l).length <= W),
      ).toBe(true);
  });
});

describe("adding and removing an account", () => {
  /** A wizard's side of the terminal: scripted answers, and everything it said. */
  const script = (answers: string[]) => {
    const said: string[] = [];
    const asked: string[] = [];
    return {
      said,
      asked,
      io: {
        ask: async (q: string) => {
          asked.push(q);
          return answers.shift() ?? "";
        },
        say: (line: string) => void said.push(line),
        pause: () => {},
      } as A.WizardIO,
    };
  };
  const list = path.join(SCRATCH, "wizard", "accounts.json");
  const runs: { args: string[]; dir: string }[] = [];
  /** Claude's sign-in, as far as fleet can see it: the email it records in the folder's .claude.json. */
  const signIn = (email: string, status = 0) => (args: string[], dir: string) => {
    runs.push({ args, dir });
    fs.mkdirSync(dir, { recursive: true });
    if (status === 0 && args[1] === "login") fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: email } }));
    return status;
  };

  test("a name and the suggested folder, then Claude's own sign-in there, then the account is listed", async () => {
    const dir = path.join(SCRATCH, "wizard", "client-a");
    const t = script(["Client A", dir, "me@client.example"]);
    const added = await A.addAccountWizard(t.io, { run: signIn("me@client.example"), has: () => true, file: list });
    expect(added).toEqual({ name: "Client A", dir });
    expect(t.asked[1]).toContain("[~/.claude-client-a]");
    expect(runs.at(-1)).toEqual({ args: ["auth", "login", "--claudeai", "--email", "me@client.example"], dir });
    expect(t.said.join("\n")).toContain("signed in as me@client.example");
    if (process.platform === "darwin") expect(t.said.join("\n")).toContain("in the keychain, where fleet looks");
    expect(A.loadAccounts(list).accounts).toEqual([{ name: "Client A", dir }]);
  });
  test("a name or folder already listed is asked again; a folder signed in already is not signed in again unless asked", async () => {
    const dir = path.join(SCRATCH, "wizard", "client-a");
    const other = path.join(SCRATCH, "wizard", "other");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "old@example.com" } }));
    const before = runs.length;
    const t = script(["Client A", "B", dir, other, "n"]);
    const added = await A.addAccountWizard(t.io, { run: signIn("x"), has: () => false, file: list });
    expect(t.said).toContain(`${F.ICON.failed} Client A is listed already`);
    expect(t.said).toContain(`${F.ICON.failed} Client A uses that folder already`);
    expect(t.asked.at(-1)).toContain("signed in as old@example.com already");
    expect(runs.length).toBe(before); // no sign-in
    expect(added?.name).toBe("B");
    if (process.platform === "darwin") expect(t.said.join("\n")).toContain("cannot find its login in the keychain");
  });
  test("a sign-in that does not finish lists nothing unless you say so; enter at the name stops", async () => {
    const t = script(["C", path.join(SCRATCH, "wizard", "c"), "", "n"]);
    expect(await A.addAccountWizard(t.io, { run: signIn("", 1), has: () => false, file: list })).toBeUndefined();
    expect(t.said.join("\n")).toContain("the sign-in did not finish (claude exited 1)");
    expect(A.loadAccounts(list).accounts.map((a) => a.name)).toEqual(["Client A", "B"]);
    expect(await A.addAccountWizard(script([""]).io, { run: signIn(""), has: () => false, file: list })).toBeUndefined();
  });
  test("remove takes one off by number, and signs it out only when asked", async () => {
    const before = runs.length;
    const t = script(["2", "y"]);
    expect(await A.removeAccountWizard(t.io, { run: signIn(""), has: () => false, file: list })).toBe("B");
    expect(A.loadAccounts(list).accounts.map((a) => a.name)).toEqual(["Client A"]);
    expect(runs.slice(before)).toEqual([{ args: ["auth", "logout"], dir: path.join(SCRATCH, "wizard", "other") }]);
    expect(await A.removeAccountWizard(script([""]).io, { run: signIn(""), has: () => false, file: list })).toBeUndefined();
  });
  test("the usage screen's own keys", () => {
    expect(["a", "x", "r", "q", "\x1b"].map(A.accountsKey)).toEqual(["add", "remove", "retry", undefined, undefined]);
    expect(A.suggestedDir("My Work!")).toBe("~/.claude-my-work");
  });
});
