# Termy Code

Termy Code is a desktop app for working with AI coding agents. Instead of running Claude Code, Codex and Cursor each in its own terminal tab, you open a project once and talk to any of them from the same window. Each conversation is saved as a thread you can search and return to later.

When an agent edits files, the changes show up as diffs you can review before moving on. When it runs commands, they run in a real terminal built on [Alacritty](https://github.com/alacritty/alacritty)'s PTY, and you can see the output as it happens. A terminal panel is also there for your own commands.

Termy Code talks to the agents over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), the open protocol these CLIs use to work with editors. The agents keep their own models, tools and logins. Termy Code gives them a better interface.

## Features

- **Multiple agents.** Claude Code, Codex and Cursor connect over ACP.
- **Projects and threads.** Conversations are saved per project in a local SQLite database, and you can search them.
- **Tool calls in the timeline.** Agent tool calls are grouped into stacks. You can review file diffs in a side pane.
- **Built-in terminal.** The terminal panel uses xterm.js on top of Alacritty's native PTY. Commands that agents run through ACP `terminal/*` use the same PTY layer.
- **Permission prompts.** Agent requests for permission or input appear inline.
- **Composer.** You can attach images, switch models and set reasoning effort. Type `@` to mention a file or `$` to use one of the agent's skills.
- **Command palette.** Jump between projects and threads from the keyboard.
- **Tabs.** Keep several threads open at once. ⌘1–9 jumps to a tab and ⌃Tab cycles through them.
- **Fork and hand off.** Fork a thread, or part of one, to the same agent or hand it off to another. The same agent forks its own session; a different agent gets a transcript of the conversation.
- **Slash commands.** Type `/` to run the commands the agent advertises over ACP.
- **File tree.** Browse and preview project files next to the thread. Files changed in the thread are highlighted.

## Agents

| Agent       | Launched with                                  | Sign in                                         |
| ----------- | ---------------------------------------------- | ----------------------------------------------- |
| Claude Code | `npx -y @agentclientprotocol/claude-agent-acp` | `claude`, or set `ANTHROPIC_API_KEY`            |
| Codex       | `npx -y @agentclientprotocol/codex-acp`        | `codex login`, or set `OPENAI_API_KEY`          |
| Cursor      | `agent acp`                                    | `agent login`, or set `CURSOR_API_KEY`          |

macOS starts GUI apps with a minimal `PATH`. Termy Code reads `PATH` from your login shell so that `npx` and `agent` can be found.

## Development

### Prerequisites

- [Rust](https://rustup.rs) (stable)
- [Bun](https://bun.sh)
- The [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform

### Setup

The Rust terminal backend uses `alacritty_terminal` from crates.io. No sibling checkout is needed.

```sh
git clone https://github.com/termylabs/code termycode
cd termycode
bun install
```

### Run

```sh
bun tauri dev       # run the app with hot reload
bun tauri build     # build a release bundle
```

### Signed macOS releases

The [macOS release workflow](.github/workflows/release-macos.yml) builds signed,
Apple-notarized DMG and ZIP downloads for Apple Silicon and Intel. Manual runs
produce test artifacts; pushing a matching `v*` version tag publishes a release
after both architectures pass. See [release setup and verification](docs/macos-releases.md).

## Architecture

```
src-tauri/          Rust backend (Tauri v2)
├── daemon/             persistent agents and interactive shells
├── daemon_client.rs    connects the app to the background daemon
├── pty.rs              raw Alacritty PTY transport and process lifecycle
├── agent_terminal.rs   ACP terminal/* commands with sanitized output
├── workspace.rs        ACP fs/* requests, git branch and image attachments
├── mentions.rs         project files and agent skills for @ and $ mentions
├── db.rs               SQLite storage and search for projects and threads
└── shell_env.rs        resolves the login-shell PATH for spawned agents

src/                React frontend
├── services/           Effect services
│   ├── Workspace.ts        app state (SubscriptionRef) and agent session lifecycles
│   ├── AcpClient.ts        wraps the ACP SDK
│   ├── AgentHost.ts        turns daemon events into an ACP stream
│   ├── Database.ts         fronts the db_* commands
│   └── TerminalHost.ts     opens and reattaches daemon shells
├── domain/             pure types and reducers (timeline, tool stacks, diffs, cursor/* extensions)
├── routes/             TanStack Router file routes
└── components/         app UI, shadcn on Base UI, Notra registry components
```

## Stack

[Tauri 2](https://v2.tauri.app) · [React 19](https://react.dev) · [Effect](https://effect.website) · [TanStack Router](https://tanstack.com/router) · [Tailwind CSS 4](https://tailwindcss.com) · [Base UI](https://base-ui.com) · [xterm.js](https://xtermjs.org) · [SQLite](https://sqlite.org)
