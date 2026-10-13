# Claude Fleet

Every live Claude Code session on one terminal screen: what each one is doing, which ones are waiting on you, and what their agents, workflows and tasks are up to.

![Claude Fleet in detail mode](docs/screenshot.svg)

It is one TypeScript file with no dependencies. It reads the files Claude Code already keeps under `~/.claude` and writes nothing.

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
| `esc` | Leave focus (or quit) |
| `q` | Quit |

Options: `--mode detail|compact|far`, `--all`, `--usage`, `--bell`, `--no-mouse`, `--once` (print one frame and exit), and a number for the window in minutes. `bun fleet.ts --help` lists them.

Capturing clicks means a plain drag no longer selects text. Hold Shift (Option in iTerm2 and Terminal.app) while dragging, or start with `--no-mouse`.

## Account usage and your login

Usage figures are off unless you pass `--usage`. With it, Claude Fleet reads the Claude Code login already stored on your machine (the macOS keychain item `Claude Code-credentials`, or `~/.claude/.credentials.json`) and asks `api.anthropic.com/api/oauth/usage` for your figures every five minutes. The token is sent only to that address, is never written anywhere, and is never refreshed or changed. That endpoint is the one Claude Code's own `/usage` screen relies on, and it is not a documented public interface.

Without `--usage`, Claude Fleet makes no network requests at all.

## Things to know

- **It reads Claude Code's on-disk files, which are not a documented interface.** It was written against Claude Code 2.1.296 on macOS. Another version may move things, and parts of the screen will then come up empty. Linux should work but has not been tried.
- **Agent status is inferred.** A spinner means the agent wrote to its transcript in the last minute. A yellow dot means a tool call has been outstanding longer than that. A grey circle means quiet with nothing outstanding.
- **Context categories are estimates (marked `≈`).** They are sized from the length of the prompt, tool definitions, memory files and skill listing recorded in the transcript, with the rest counted as messages. They will not match `/context` exactly, and small categories are drawn slightly larger than scale so they stay visible.
- **The window size is assumed:** 1M tokens for Opus, Sonnet and Fable 5 models, or anything already past 200k; otherwise 200k.
- **The summary and the question are not generated here.** They come from the status a background session records about itself, or from a pending question in the transcript. Sessions that record neither show no summary.
- **Only the last 2 MB of each transcript is read,** so a long window on a very busy session can undercount early activity.
- **Your screen shows prompt and reply text from every session.** Mind who can see it.

## Development

`bun demo.ts` builds a throwaway set of fake sessions and runs the dashboard against it; it accepts the same options. `bun run screenshots` regenerates the images above from that demo.

## Licence

MIT
