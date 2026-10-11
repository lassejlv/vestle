import { Schema } from "effect"

export const AgentId = Schema.Literals(["claude", "codex", "cursor", "grok", "antigravity", "opencode"])
export type AgentId = typeof AgentId.Type

export interface AgentSpec {
  readonly id: AgentId
  readonly name: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  /** Shown when the agent reports that it needs a login. */
  readonly loginHint: string
}

export const agents: Record<AgentId, AgentSpec> = {
  claude: {
    id: "claude",
    name: "Claude Code",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    loginHint: "Run `claude` in a terminal and sign in, or set ANTHROPIC_API_KEY.",
  },
  codex: {
    id: "codex",
    name: "Codex",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
    loginHint: "Run `codex login` in a terminal, or set OPENAI_API_KEY.",
  },
  cursor: {
    id: "cursor",
    name: "Cursor",
    command: "agent",
    args: ["acp"],
    loginHint: "Run `agent login` in a terminal, or set CURSOR_API_KEY.",
  },
  grok: {
    id: "grok",
    name: "Grok Build",
    command: "grok",
    // Update checks would write to stdout, which is the ACP channel.
    args: ["--no-auto-update", "agent", "stdio"],
    loginHint: "Run `grok` in a terminal and sign in, or set XAI_API_KEY.",
  },
  // The Antigravity CLI (`agy`) has no ACP mode yet, so this runs Gemini CLI's.
  antigravity: {
    id: "antigravity",
    name: "Antigravity",
    command: "npx",
    args: ["-y", "@google/gemini-cli", "--acp"],
    loginHint: "Run `npx @google/gemini-cli` in a terminal and sign in with Google, or set GEMINI_API_KEY.",
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    args: ["acp"],
    loginHint: "Run `opencode auth login` in a terminal.",
  },
}

export const agentList = Object.values(agents)
