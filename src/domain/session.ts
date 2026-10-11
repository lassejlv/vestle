import type * as acp from "@agentclientprotocol/sdk"
import type { AgentId } from "./agents"
import type { AskQuestion, Todo } from "./cursor"
import type { Mention } from "./mentions"

export interface ImageAttachment {
  readonly name: string
  readonly mimeType: string
  /** Base64, without a data: prefix (ACP's image block format). */
  readonly data: string
}

export type TimelineItem =
  | {
      readonly _tag: "User"
      readonly id: string
      readonly text: string
      readonly images?: ReadonlyArray<ImageAttachment>
      readonly mentions?: ReadonlyArray<Mention>
      /** How long the agent worked on this message, once its turn is over. */
      readonly durationMs?: number
    }
  | { readonly _tag: "Agent"; readonly id: string; readonly text: string }
  | { readonly _tag: "Thought"; readonly id: string; readonly text: string }
  | {
      readonly _tag: "Tool"
      readonly id: string
      readonly title: string
      readonly kind: acp.ToolKind
      readonly status: acp.ToolCallStatus
      readonly content: ReadonlyArray<acp.ToolCallContent>
      readonly locations: ReadonlyArray<acp.ToolCallLocation>
      readonly rawInput: unknown
    }
  | { readonly _tag: "Plan"; readonly id: string; readonly entries: ReadonlyArray<acp.PlanEntry> }
  | { readonly _tag: "Notice"; readonly id: string; readonly text: string; readonly tone: "info" | "error" }
  | {
      /** Where a forked thread picks up. Everything before it came from the source thread. */
      readonly _tag: "Fork"
      readonly id: string
      readonly fromTitle: string
      readonly fromAgentId: AgentId
      readonly fromAcpSessionId: string | null
      /**
       * How the new agent gets the history: the agent's own `session/fork`, or a
       * transcript sent with the first prompt (other agents, or no fork support).
       */
      readonly handoff: "native" | "transcript"
    }

export type SessionStatus = "starting" | "ready" | "working" | "failed"

/** Something the agent is blocked on until the user answers. */
export type PendingRequest =
  | {
      readonly _tag: "Permission"
      readonly toolCall: acp.ToolCallUpdate
      readonly options: ReadonlyArray<acp.PermissionOption>
    }
  | {
      readonly _tag: "Question"
      readonly title: string | null
      readonly questions: AskQuestion["questions"]
    }
  | {
      readonly _tag: "PlanApproval"
      readonly name: string | null
      readonly overview: string | null
      readonly plan: string
      readonly todos: ReadonlyArray<Todo>
    }

export interface Session {
  readonly id: string
  readonly projectId: string
  readonly cwd: string
  readonly agentId: AgentId
  readonly acpSessionId: string | null
  readonly title: string
  readonly status: SessionStatus
  /** False until the agent process is running for this thread. */
  readonly connected: boolean
  readonly error: string | null
  readonly items: ReadonlyArray<TimelineItem>
  readonly configOptions: ReadonlyArray<acp.SessionConfigOption>
  readonly modes: acp.SessionModeState | null
  readonly usage: {
    readonly used: number
    readonly size: number
    /** Cumulative session cost, when the agent reports it. */
    readonly cost: acp.Cost | null
  } | null
  readonly request: PendingRequest | null
  /** Whether the agent accepts image blocks in prompts. */
  readonly supportsImages: boolean
  readonly authMethods: ReadonlyArray<acp.AuthMethod>
  /** Slash commands the agent advertises. */
  readonly commands: ReadonlyArray<acp.AvailableCommand>
  readonly createdAt: number
  readonly updatedAt: number
  readonly turnStartedAt: number | null
  /** How far into the background daemon's log for this thread's agent `items` go. */
  readonly logSeq: number
}

export const untitled = "New thread"

export const makeSession = (fields: {
  id: string
  projectId: string
  cwd: string
  agentId: AgentId
  now: number
}): Session => ({
  id: fields.id,
  projectId: fields.projectId,
  cwd: fields.cwd,
  agentId: fields.agentId,
  acpSessionId: null,
  title: untitled,
  status: "starting",
  connected: false,
  error: null,
  items: [],
  configOptions: [],
  modes: null,
  usage: null,
  request: null,
  supportsImages: false,
  authMethods: [],
  commands: [],
  createdAt: fields.now,
  updatedAt: fields.now,
  turnStartedAt: null,
  logSeq: 0,
})

const newId = () => crypto.randomUUID()

const chunkText = (block: acp.ContentBlock): string => {
  switch (block.type) {
    case "text":
      return block.text
    case "resource_link":
      return `[${block.name}](${block.uri})`
    case "resource":
      return "text" in block.resource ? block.resource.text : ""
    default:
      return ""
  }
}

/** Appends streamed text to the trailing item of the same kind, or starts a new one. */
const appendText = (
  items: ReadonlyArray<TimelineItem>,
  tag: "User" | "Agent" | "Thought",
  text: string,
): ReadonlyArray<TimelineItem> => {
  if (text === "") return items
  const last = items.at(-1)
  if (last?._tag === tag) {
    return [...items.slice(0, -1), { ...last, text: last.text + text }]
  }
  return [...items, { _tag: tag, id: newId(), text }]
}

const updateTool = (
  items: ReadonlyArray<TimelineItem>,
  update: acp.ToolCallUpdate,
): ReadonlyArray<TimelineItem> =>
  items.map((item) =>
    item._tag === "Tool" && item.id === update.toolCallId
      ? {
          ...item,
          title: update.title ?? item.title,
          kind: update.kind ?? item.kind,
          status: update.status ?? item.status,
          content: update.content ?? item.content,
          locations: update.locations ?? item.locations,
          rawInput: update.rawInput ?? item.rawInput,
        }
      : item,
  )

const setPlan = (items: ReadonlyArray<TimelineItem>, entries: ReadonlyArray<acp.PlanEntry>) => {
  const index = items.findLastIndex((item) => item._tag === "Plan")
  // Keep the plan in place while the turn is still about it; otherwise start fresh at the end.
  const lastUser = items.findLastIndex((item) => item._tag === "User")
  if (index > lastUser) {
    return items.map((item, i) => (i === index ? { ...item, entries } : item))
  }
  return [...items, { _tag: "Plan" as const, id: newId(), entries }]
}

export const applyUpdate = (session: Session, update: acp.SessionUpdate): Session => {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return { ...session, items: appendText(session.items, "User", chunkText(update.content)) }
    case "agent_message_chunk":
      return { ...session, items: appendText(session.items, "Agent", chunkText(update.content)) }
    case "agent_thought_chunk":
      return { ...session, items: appendText(session.items, "Thought", chunkText(update.content)) }
    case "tool_call": {
      if (session.items.some((item) => item._tag === "Tool" && item.id === update.toolCallId)) {
        return { ...session, items: updateTool(session.items, update) }
      }
      const tool: TimelineItem = {
        _tag: "Tool",
        id: update.toolCallId,
        title: update.title,
        kind: update.kind ?? "other",
        status: update.status ?? "pending",
        content: update.content ?? [],
        locations: update.locations ?? [],
        rawInput: update.rawInput,
      }
      return { ...session, items: [...session.items, tool] }
    }
    case "tool_call_update":
      return { ...session, items: updateTool(session.items, update) }
    case "plan":
      return { ...session, items: setPlan(session.items, update.entries) }
    case "current_mode_update":
      return session.modes ? { ...session, modes: { ...session.modes, currentModeId: update.currentModeId } } : session
    case "config_option_update":
      return { ...session, configOptions: update.configOptions }
    case "session_info_update":
      return update.title ? { ...session, title: update.title } : session
    case "available_commands_update":
      return { ...session, commands: update.availableCommands }
    case "usage_update":
      return { ...session, usage: { used: update.used, size: update.size, cost: update.cost ?? null } }
    default:
      return session
  }
}

/** Tool calls that are still running when a turn ends never will finish. */
export const settleTools = (items: ReadonlyArray<TimelineItem>): ReadonlyArray<TimelineItem> =>
  items.map((item) =>
    item._tag === "Tool" && (item.status === "pending" || item.status === "in_progress")
      ? { ...item, status: "failed" as const }
      : item,
  )

/** Records how long the turn for the latest user message took. */
export const timeTurn = (items: ReadonlyArray<TimelineItem>, durationMs: number): ReadonlyArray<TimelineItem> => {
  const index = items.findLastIndex((item) => item._tag === "User")
  return items.map((item, i) => (i === index && item._tag === "User" ? { ...item, durationMs } : item))
}

/** Updates that rebuild the timeline. Session-level updates (commands, modes, usage) aren't history. */
export const isHistory = (update: acp.SessionUpdate) =>
  update.sessionUpdate === "user_message_chunk" ||
  update.sessionUpdate === "agent_message_chunk" ||
  update.sessionUpdate === "agent_thought_chunk" ||
  update.sessionUpdate === "tool_call" ||
  update.sessionUpdate === "tool_call_update" ||
  update.sessionUpdate === "plan"

type ForkItem = Extract<TimelineItem, { _tag: "Fork" }>

/** The fork marker whose history the agent still needs: nothing has been sent since it. */
export const pendingFork = (items: ReadonlyArray<TimelineItem>): ForkItem | null => {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    if (item._tag === "User") return null
    if (item._tag === "Fork") return item
  }
  return null
}

const TRANSCRIPT_LIMIT = 60_000

/**
 * The conversation before a fork, as plain text for another agent. Tool calls
 * shrink to one line each; the oldest part is cut when it runs long.
 */
export const transcript = (items: ReadonlyArray<TimelineItem>, fork: ForkItem, agentName: string) => {
  const end = items.indexOf(fork)
  const lines: Array<string> = []
  for (const item of items.slice(0, end < 0 ? items.length : end)) {
    if (item._tag === "User") lines.push(`## User\n${item.text}`)
    else if (item._tag === "Agent") lines.push(`## ${agentName}\n${item.text}`)
    else if (item._tag === "Tool") lines.push(`- ${item.title} (${item.status})`)
    else if (item._tag === "Plan") lines.push(item.entries.map((entry) => `- [${entry.status}] ${entry.content}`).join("\n"))
  }
  const body = lines.join("\n\n")
  const trimmed = body.length > TRANSCRIPT_LIMIT ? `[Earlier messages cut]\n\n${body.slice(-TRANSCRIPT_LIMIT)}` : body
  return [
    `This thread was handed off to you from ${agentName}. Here is the conversation so far, for context. You don't need to repeat any of it.`,
    `<conversation>\n${trimmed}\n</conversation>`,
    "The user's next message follows.",
  ].join("\n\n")
}

export const titleFrom = (text: string) => {
  const line = text.trim().split("\n")[0] ?? ""
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}...` : line || untitled
}

export const configOption = (session: Session, category: string) =>
  session.configOptions.find((option) => option.category === category && option.type === "select")
