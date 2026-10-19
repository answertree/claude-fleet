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

describe("the accounts screen", () => {
  test("this Mac first, then each listed account with its email; how to add one when none are listed", async () => {
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
      "No other accounts listed yet",
    );
  });
  test("a narrow screen keeps every line inside it", () => {
    for (const W of [50, 70])
      expect(
        A.accountsScreen(W, 16, NOW).every((l) => strip(l).length <= W),
      ).toBe(true);
  });
});
