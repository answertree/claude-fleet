# Claude Fleet

Every live Claude Code session on one terminal screen: what each one is doing, which ones are waiting on you, and what their agents, workflows and tasks are up to.

![Claude Fleet in detail mode](docs/screenshot.svg)

It is one TypeScript file with no dependencies. It reads the files Claude Code already keeps under `~/.claude`. The only thing it ever writes is one small file of usage figures, and only with `--usage` (see [Account usage and your login](#account-usage-and-your-login)).

## Try it

```bash
git clone https://github.com/pdaddyo/claude-fleet
cd claude-fleet
bun demo.ts        # made-up sessions, so you can see everything straight away
bun fleet.ts       # your real sessions
```

You need [Bun](https://bun.sh) and a terminal with 24-bit colour. A wide pane (140 columns or more) shows the most; narrower panes drop columns.

To run it from anywhere, add an alias to your shell profile:

```bash
alias fleet='bun ~/path/to/claude-fleet/fleet.ts --usage'
```

## What is on the screen

**At the top**

- Fleet totals: active sessions, running agents, workflows, tool calls in the window, and how many sessions need you.
- The machine: CPU with a short history and one glyph per core, memory, load, and the busiest processes.
- Your account (with `--usage`): how much of the 5-hour and weekly limits you have used, and when each resets.

**For each session**

- **Header:** name, folder and branch, status, a sparkline of tool calls, output tokens, how full the context window is, and the CPU its processes are using.
- **Needs you:** a highlighted row with the actual question when the session is blocked on you. These sort to the top.
- **Context:** the window split by category (system prompt, tools, MCP tools, agents, memory files, skills, messages).
- **Now:** a one-line summary of what it is doing.
- **Conversation:** your last prompt and Claude's most recent messages, using whatever rows are spare.
- **Tasks and workflows:** one glyph per step (`●` done, `◐` in progress, `○` not started), the current phase, and each running agent with what it is doing right now.

Only sessions that are working or waiting on you are shown. Idle and finished ones collapse into one line at the bottom; press `a` to bring them back.

## View modes

| Key | Mode | For |
| --- | --- | --- |
| `1` | Detail | Sitting at the screen. Everything above. |
| `2` | Compact | Many sessions. One line per session and per agent. |
| `3` | Far | A spare monitor across the room. Big cards where colour carries the state. |

![Far mode](docs/screenshot-far.svg)

Click a session, or press `tab`, to focus on it alone; it then gets the whole screen for its conversation and agents. `esc` goes back.

## Controls

Every control is a button on the bottom row, and each has a key.

| Key | Does |
| --- | --- |
| `1` `2` `3` | View mode |
| `+` `-` | Sparkline window: 5, 15, 30, 60 or 180 minutes |
| `a` | Show idle and finished sessions too |
| `d` | List finished agents instead of counting them |
| `tab` | Focus the next session |
| `b` | Ring the terminal bell when a session starts waiting on you |
| `u` | Retry the usage read now (the button appears only while it is failing) |
| `space` | Seen it. The button counts what is new since you last pressed it: sessions that started waiting on you, things that failed, stalled or finished, and new replies |
| `esc` | Leave focus (or quit) |
| `q` | Quit |

Options: `--mode detail|compact|far`, `--all`, `--usage`, `--bell`, `--stall <minutes>`, `--no-mouse`, `--once` (print one frame and exit), and a number for the window in minutes. `bun fleet.ts --help` lists them. Setting `FLEET_HIDE_PROCESSES=1` in the environment leaves other programs' names off the machine row.

`bun fleet.ts --glyphs` prints a test card of every glyph the screen uses, each between two bars, so you can check that your terminal (an iPad over mosh, say) draws each one a single cell wide. If one is out of line, `--plain-glyphs` swaps in fallbacks for the four that fonts most often lack.

While it runs, Claude Fleet sets the terminal's title to the fleet's state in the screen's own glyphs (`▲1 ●2 ≡1 Claude Fleet`: one waiting on you, two working, one workflow), so a tab or window switcher shows whether anything needs you. The title is cleared when you quit.

Capturing clicks means a plain drag no longer selects text. Hold Shift (Option in iTerm2 and Terminal.app) while dragging, or start with `--no-mouse`.

## Account usage and your login

Usage figures are off unless you pass `--usage` (or set `FLEET_USAGE=1` in the environment, which means the same). With it, Claude Fleet reads the Claude Code login already stored on your machine (the macOS keychain item `Claude Code-credentials`, or `~/.claude/.credentials.json`) and asks `api.anthropic.com/api/oauth/usage` for your figures every five minutes. The token is sent only to that address and is held in memory for that one request. It is never written, logged or printed, and never refreshed or changed. That endpoint is the one Claude Code's own `/usage` screen relies on, and it is not a documented public interface.

Without `--usage` or `FLEET_USAGE=1`, Claude Fleet makes no network requests at all and does not ask the keychain for anything.

**When the read fails, the screen says exactly why:** `keychain: item not found`, `keychain: no answer in 5s`, `keychain: exit N`, `keychain: entry is not JSON`, `keychain: no claude.ai login in entry`, `keychain: closed to remote sessions (ssh/mosh)`, `login file: not found`, `login file: no claude.ai login in it`, `token expired · any Claude Code session renews it`, `Anthropic answered 401` (or whatever status it gave), `network: timed out`. It says `no Claude Code login found` only when the keychain and the login file both answered "not found". It tries again by itself, a minute after a failure and then less often, and `u` retries at once.

**Over ssh or mosh on a Mac** the read fails with `keychain: closed to remote sessions (ssh/mosh)`: macOS finds the keychain item but will not hand its content to a remote login. There are two standard remedies, and neither has been tested here:

- run `security unlock-keychain ~/Library/Keychains/login.keychain-db` in the remote session, or
- run Claude Fleet inside a tmux that was started on the Mac itself.

**Shared figures.** So that a dashboard in a remote terminal can still show usage, a dashboard that reads the figures successfully saves them to `${XDG_CACHE_HOME:-~/.cache}/claude-fleet/usage.json` (readable only by you). It holds Anthropic's figures and the time they were fetched, and never the login. This is the one file Claude Fleet ever writes. A dashboard whose own read fails shows the figures from that file, or failing that the ones Claude Code itself last cached (the `cachedUsageUtilization` entry of `~/.claude.json`; no other key is read). Figures under ten minutes old are shown as current. Older ones are shown dim with the time they date from and the reason the read is failing. Figures more than a day old are not shown.

## Things to know

- **It reads Claude Code's on-disk files, which are not a documented interface.** It was written against Claude Code 2.1.296 on macOS. Another version may move things, and parts of the screen will then come up empty. Linux should work but has not been tried.
- **"Stalled?" is a question, not a finding.** A thread is marked when it has had a tool call outstanding and written nothing for ten minutes (`--stall <minutes>`; 0 turns it off) while the session's whole process tree is under 1% CPU. A tool that is waiting on another machine looks exactly the same. Only a session that is working can be marked.
- **Agent status is inferred.** A spinner means the agent wrote to its transcript in the last minute. A yellow dot means a tool call has been outstanding longer than that. A grey circle means quiet with nothing outstanding.
- **Context categories are estimates (marked `≈`).** They are sized from the length of the prompt, tool definitions, memory files and skill listing recorded in the transcript, with the rest counted as messages. They will not match `/context` exactly, and small categories are drawn slightly larger than scale so they stay visible.
- **The window size is assumed:** 1M tokens for Opus, Sonnet and Fable 5 models, or anything already past 200k; otherwise 200k.
- **The summary and the question are not generated here.** They come from the status a background session records about itself, or from a pending question in the transcript. Sessions that record neither show no summary.
- **Only the last 2 MB of each transcript is read,** so a long window on a very busy session can undercount early activity.
- **Your screen shows prompt and reply text from every session.** Mind who can see it.

## Development

`bun demo.ts` builds a throwaway set of fake sessions and runs the dashboard against it; it accepts the same options. `bun run screenshots` regenerates the images above from that demo.

The demo has options of its own, so every state can be seen without waiting for it to happen:

| Option | Shows |
| --- | --- |
| `--six` | Six sessions sharing the screen: one waiting on you, five working. |
| `--all` | As well as the finished job, a session waiting for your next prompt and an idle one. |
| `--stalled` | An agent that has sat on a tool call for 14 minutes while its session is idle. |
| `--runway` | A session whose context is growing steadily, so its forecast appears. |
| `--ended` | A completed workflow and a failed one. |
| `--account <state>` | A made-up account (it turns `--usage` on): `current`, `extra-off`, `early` (the 5-hour limit runs out before it resets), `stale`, `none`, `remote`. |
| `--seen <minutes>` | The screen as if you last looked that many minutes ago. |
| `--surprise` | `--stalled --runway --account early --seen 18` together. |
| `--real-machine` | This machine's CPU, memory and load instead of the made-up ones. |

`bun test` runs the tests in `fleet.test.ts` (Bun's built-in runner, no packages). `tools/check-frames` renders the demo at seven terminal sizes in all three modes and fails if a frame has the wrong number of rows, a line wider than the terminal, or the text "undefined" or "NaN" on it. `bun run check` runs both.

These environment variables exist for tests and screenshots only:

| Variable | Does |
| --- | --- |
| `FLEET_HOME` | Look here instead of `~/.claude` (the demo uses it). |
| `FLEET_NOW` | Pin the clock, in milliseconds since 1970, so `--once` prints the same frame every time. |
| `FLEET_MACHINE_FIXTURE` | Take CPU, memory, load and the process list from this JSON file instead of sampling the machine. Processes listed in it count as alive. |
| `FLEET_USAGE_FIXTURE` | Take the usage figures from this JSON file instead of reading the login and asking Anthropic. A `fetchedAt` in the file sets their age. Figures from a fixture are never saved to the shared file. |
| `FLEET_SEEN` | Start the "seen" mark at this time (milliseconds since 1970) instead of at launch, so a single frame can show things as new. |
| `FLEET_USAGE_FAIL` | Make the usage read fail with this reason. With `FLEET_USAGE_FIXTURE` also set, the fixture stands in for the shared file, which shows the "as of" state. |

## Licence

MIT
