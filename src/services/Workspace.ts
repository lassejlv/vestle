import type * as acp from "@agentclientprotocol/sdk"
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  type Option,
  Predicate,
  Schema,
  Scope,
  SubscriptionRef,
} from "effect"
import { type AgentId, agents } from "@/domain/agents"
import type { Mention, Skill } from "@/domain/mentions"
import {
  AskQuestion,
  CreatePlan,
  GenerateImage,
  mergeTodos,
  methodName,
  Task,
  type Todo,
  toPlanEntries,
  UpdateTodos,
} from "@/domain/cursor"
import {
  applyUpdate,
  configOption,
  type ImageAttachment,
  isHistory,
  makeSession,
  type PendingRequest,
  pendingFork,
  type Session,
  settleTools,
  type TimelineItem,
  timeTurn,
  titleFrom,
  transcript,
  untitled,
} from "@/domain/session"
import { type AcpConnection, AcpClient, AcpError, type Prompt, type TurnEnd } from "./AcpClient"
import { AgentHost, type AgentProcess, type AgentSummary } from "./AgentHost"
import { Daemon } from "./Daemon"
import { Database, Project, type SearchHit, type ThreadSummary } from "./Database"
import { Tauri } from "./Tauri"
import { TerminalHost } from "./TerminalHost"

/** Live output of a command an agent runs through the client (ACP terminal). */
export interface TerminalOutput {
  readonly text: string
  /** Cursor position within the last line, for carriage-return overwrites. */
  readonly column: number
  readonly exitCode: number | null
  readonly signal: string | null
  readonly exited: boolean
}

export interface WorkspaceState {
  readonly loaded: boolean
  readonly projects: ReadonlyArray<Project>
  readonly threads: ReadonlyArray<ThreadSummary>
  /** Threads that are open in this window, keyed by thread id. */
  readonly sessions: Readonly<Record<string, Session>>
  /** Agent terminals, keyed by terminal id. */
  readonly terminals: Readonly<Record<string, TerminalOutput>>
  /** Open tabs, in order. */
  readonly tabs: ReadonlyArray<Tab>
}

/** A tab is a thread, or a full-size shell in a folder. */
export const Tab = Schema.Union([
  Schema.TaggedStruct("Thread", { id: Schema.String }),
  Schema.TaggedStruct("Terminal", { id: Schema.String, cwd: Schema.String, title: Schema.String }),
])
export type Tab = typeof Tab.Type

const decodeTabs = Schema.decodeUnknownOption(Schema.Array(Tab))

const TABS_KEY = "termy.tabs.v2"

/** The permission mode last picked for each agent, so new and reopened threads start in it. */
const modeKey = (agentId: AgentId) => `termy.mode.${agentId}`

const rememberMode = (agentId: AgentId, modeId: string) =>
  Effect.sync(() => {
    try {
      localStorage.setItem(modeKey(agentId), modeId)
    } catch {
      // Threads just start in the agent's default mode.
    }
  })

const rememberedMode = (agentId: AgentId) =>
  Effect.sync(() => {
    try {
      return localStorage.getItem(modeKey(agentId))
    } catch {
      return null
    }
  })

export interface QuestionAnswer {
  readonly questionId: string
  readonly selectedOptionIds: ReadonlyArray<string>
}

/** Enough of a running command's output for the live step. */
const TERMINAL_TAIL_CHARS = 16_000

/**
 * Appends PTY text the way a terminal shows it: `\r` returns to the start of
 * the line and later characters overwrite it, so progress bars collapse.
 */
const appendTerminalText = (terminal: TerminalOutput, chunk: string): TerminalOutput => {
  const lineStart = terminal.text.lastIndexOf("\n") + 1
  let committed = terminal.text.slice(0, lineStart)
  let line = [...terminal.text.slice(lineStart)]
  let column = terminal.column
  for (const character of chunk) {
    if (character === "\r") column = 0
    else if (character === "\n") {
      committed += `${line.join("")}\n`
      line = []
      column = 0
    } else {
      line[column] = character
      column += 1
    }
  }
  const text = committed + line.join("")
  return { ...terminal, column, text: text.length > TERMINAL_TAIL_CHARS ? text.slice(-TERMINAL_TAIL_CHARS) : text }
}

export const BackgroundStatus = Schema.Struct({
  pid: Schema.NullOr(Schema.Number),
  agents: Schema.Number,
  shells: Schema.Number,
  /** Kept from an older build because work was running when this one started. */
  stale: Schema.Boolean,
})
export type BackgroundStatus = typeof BackgroundStatus.Type

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  message: Schema.String,
}) {}

/** Process-side state for a session that isn't serialisable into the store. */
interface Live {
  readonly scope: Scope.Closeable
  readonly ready: Deferred.Deferred<AcpConnection, WorkspaceError>
  /** Resolves the request the agent is blocked on (permission, question, plan). */
  request: Deferred.Deferred<unknown> | null
  /** Cursor's running todo list, so `merge` updates have something to merge into. */
  todos: ReadonlyArray<Todo>
  /** True while `session/load` replays history we already have on disk. */
  replaying: boolean
  /** The last daemon log entry the session has seen; saved with the thread. */
  lastSeq: () => number
}

/** Permission, question and plan requests all share this cancelled shape. */
const cancelled = { outcome: { outcome: "cancelled" } } as const

const describe = (error: unknown): string =>
  Predicate.hasProperty(error, "message") && Predicate.isString(error.message) ? error.message : String(error)

export class Workspace extends Context.Service<
  Workspace,
  {
    readonly state: SubscriptionRef.SubscriptionRef<WorkspaceState>
    addProject(): Effect.Effect<Project | null, WorkspaceError>
    removeProject(id: string): Effect.Effect<void, WorkspaceError>
    /** Starts an unsaved thread and warms up its agent so models and modes are known. */
    createDraft(projectId: string, agentId: AgentId): Effect.Effect<string, WorkspaceError>
    discard(id: string): Effect.Effect<void>
    /** Loads a saved thread into the window and reconnects its agent. */
    open(id: string): Effect.Effect<void, WorkspaceError>
    send(
      id: string,
      text: string,
      images?: ReadonlyArray<ImageAttachment>,
      mentions?: ReadonlyArray<Mention>,
    ): Effect.Effect<void, WorkspaceError>
    cancel(id: string): Effect.Effect<void>
    retry(id: string): Effect.Effect<void>
    setConfigOption(id: string, configId: string, value: string): Effect.Effect<void, WorkspaceError>
    setMode(id: string, modeId: string): Effect.Effect<void, WorkspaceError>
    respondPermission(id: string, optionId: string | null): Effect.Effect<void>
    /** `null` skips the questions. */
    answerQuestions(id: string, answers: ReadonlyArray<QuestionAnswer> | null): Effect.Effect<void>
    decidePlan(id: string, accepted: boolean): Effect.Effect<void>
    searchThreads(query: string): Effect.Effect<ReadonlyArray<SearchHit>, WorkspaceError>
    /** Reads image files for a prompt; with no paths, asks the user to pick them. */
    loadImages(paths?: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<ImageAttachment>, WorkspaceError>
    deleteThread(id: string): Effect.Effect<void, WorkspaceError>
    /** Copies a thread (up to `upTo`, an item id) into a new one for `agentId`. Returns the new thread's id. */
    fork(id: string, agentId: AgentId, upTo?: string): Effect.Effect<string, WorkspaceError>
    /** Removes a tab. An idle thread also lets go of its agent; a working one keeps going. */
    closeTab(id: string): Effect.Effect<void>
    /** Opens a shell in `cwd` as a tab. Returns the tab's id. */
    openTerminal(cwd: string, title: string): Effect.Effect<string>
    /** Follows the shell's own title, e.g. the running command. */
    setTerminalTitle(id: string, title: string): Effect.Effect<void>
    /** Ends a background shell for good, e.g. one closed in a thread's panel. */
    closeShell(key: string): Effect.Effect<void>
    /** What the background daemon is running, and whether it's from an older build of the app. */
    backgroundStatus(): Effect.Effect<BackgroundStatus, WorkspaceError>
    /** Stops every background agent and shell, and starts a fresh daemon from this build. */
    restartBackground(): Effect.Effect<void, WorkspaceError>
    readFile(path: string): Effect.Effect<string, WorkspaceError>
    gitBranch(cwd: string): Effect.Effect<string | null>
    /** Project files relative to `cwd`, for `@` mentions. */
    listFiles(cwd: string): Effect.Effect<ReadonlyArray<string>, WorkspaceError>
    /** Skills the agent can use in `cwd`, for `$` mentions. */
    listSkills(agentId: AgentId, cwd: string): Effect.Effect<ReadonlyArray<Skill>, WorkspaceError>
  }
>()("termy/services/Workspace") {
  static readonly layer = Layer.effect(
    Workspace,
    Effect.gen(function* () {
      const tauri = yield* Tauri
      const db = yield* Database
      const host = yield* AgentHost
      const acpClient = yield* AcpClient
      const daemon = yield* Daemon
      const shells = yield* TerminalHost
      const state = yield* SubscriptionRef.make<WorkspaceState>({
        loaded: false,
        projects: [],
        threads: [],
        sessions: {},
        terminals: {},
        tabs: [],
      })
      const live = new Map<string, Live>()

      const toWorkspaceError = (error: unknown) => new WorkspaceError({ message: describe(error) })

      const update = (f: (state: WorkspaceState) => WorkspaceState) => SubscriptionRef.update(state, f)

      const updateSession = (id: string, f: (session: Session) => Session) =>
        update((current) => {
          const session = current.sessions[id]
          if (!session) return current
          return { ...current, sessions: { ...current.sessions, [id]: f(session) } }
        })

      const getSession = Effect.fnUntraced(function* (id: string) {
        const session = (yield* SubscriptionRef.get(state)).sessions[id]
        if (!session) return yield* new WorkspaceError({ message: "This thread is no longer open." })
        return session
      })

      // ── persistence ────────────────────────────────────────────────────

      /** Writes a sent thread to disk and refreshes the sidebar summary. */
      const persist = Effect.fnUntraced(function* (id: string) {
        const session = (yield* SubscriptionRef.get(state)).sessions[id]
        if (!session || !session.items.some((item) => item._tag === "User")) return
        const now = yield* Clock.currentTimeMillis
        const handle = live.get(id)
        const logSeq = handle ? handle.lastSeq() : session.logSeq
        const record = {
          id: session.id,
          projectId: session.projectId,
          agentId: session.agentId,
          acpSessionId: session.acpSessionId,
          title: session.title,
          items: session.items,
          createdAt: session.createdAt,
          updatedAt: now,
          logSeq,
        }
        yield* db.saveThread(record)
        yield* update((current) => ({
          ...current,
          threads: [record, ...current.threads.filter((thread) => thread.id !== id)],
          sessions: current.sessions[id]
            ? { ...current.sessions, [id]: { ...current.sessions[id], logSeq } }
            : current.sessions,
        }))
        // Saved, so the daemon can forget what led here.
        if (handle && logSeq > 0) yield* host.ack(id, logSeq)
      }, Effect.catch((error) => Effect.logWarning("Couldn't save thread", error.message)))

      // ── agent connection ──────────────────────────────────────────────

      /** Shows a request in the composer and waits for the user's answer. */
      const ask = <A>(id: string, request: PendingRequest) =>
        Effect.gen(function* () {
          const handle = live.get(id)
          if (!handle) return cancelled as A
          const answer = yield* Deferred.make<unknown>()
          handle.request = answer
          yield* updateSession(id, (session) => ({ ...session, request }))
          const response = yield* Deferred.await(answer)
          handle.request = null
          yield* updateSession(id, (session) => ({ ...session, request: null }))
          return response as A
        })

      const resolveRequest = Effect.fnUntraced(function* (id: string, response: unknown) {
        const handle = live.get(id)
        if (handle?.request) yield* Deferred.succeed(handle.request, response)
      })

      const addNotice = (id: string, text: string) =>
        updateSession(id, (session) => ({
          ...session,
          items: [...session.items, { _tag: "Notice", id: crypto.randomUUID(), text, tone: "info" }],
        }))

      /** Cursor's todo list is shown as the thread's plan. */
      const applyTodos = (id: string, todos: ReadonlyArray<Todo>, merge: boolean) =>
        Effect.gen(function* () {
          const handle = live.get(id)
          const next = mergeTodos(handle?.todos ?? [], todos, merge)
          if (handle) handle.todos = next
          yield* updateSession(id, (session) =>
            applyUpdate(session, { sessionUpdate: "plan", entries: toPlanEntries(next) }),
          )
          return next
        })

      const decode = <S extends Schema.Top>(schema: S, params: unknown) =>
        Schema.decodeUnknownEffect(schema)(params).pipe(
          Effect.tapError((error) => Effect.logWarning("Unexpected extension params", error.message)),
          Effect.option,
        ) as Effect.Effect<Option.Option<S["Type"]>>

      /** Cursor's ACP extensions. Anything else is reported as unsupported. */
      const onExtension = (id: string) => (method: string, params: Record<string, unknown>) =>
        Effect.gen(function* (): Effect.fn.Return<Record<string, unknown> | null> {
          switch (methodName(method)) {
            case "cursor/ask_question": {
              const request = yield* decode(AskQuestion, params)
              if (request._tag === "None") return null
              return yield* ask<Record<string, unknown>>(id, {
                _tag: "Question",
                title: request.value.title ?? null,
                questions: request.value.questions,
              })
            }
            case "cursor/create_plan": {
              const request = yield* decode(CreatePlan, params)
              if (request._tag === "None") return null
              yield* applyTodos(id, request.value.todos, false)
              return yield* ask<Record<string, unknown>>(id, {
                _tag: "PlanApproval",
                name: request.value.name ?? null,
                overview: request.value.overview ?? null,
                plan: request.value.plan,
                todos: request.value.todos,
              })
            }
            case "cursor/update_todos": {
              const request = yield* decode(UpdateTodos, params)
              if (request._tag === "None") return null
              const todos = yield* applyTodos(id, request.value.todos, request.value.merge ?? false)
              return { outcome: { outcome: "accepted", todos } }
            }
            case "cursor/task": {
              const request = yield* decode(Task, params)
              if (request._tag === "Some") yield* addNotice(id, `Subagent finished: ${request.value.description}`)
              return { outcome: { outcome: "completed" } }
            }
            case "cursor/generate_image":
              return { outcome: { outcome: "rejected", reason: "Termy Code can't show generated images yet." } }
            default:
              return null
          }
        })

      const onExtensionNotification = (id: string) => (method: string, params: Record<string, unknown>) =>
        Effect.gen(function* () {
          switch (methodName(method)) {
            case "cursor/update_todos": {
              const request = yield* decode(UpdateTodos, params)
              if (request._tag === "Some") yield* applyTodos(id, request.value.todos, request.value.merge ?? false)
              return
            }
            case "cursor/task": {
              const request = yield* decode(Task, params)
              if (request._tag === "Some") yield* addNotice(id, `Subagent finished: ${request.value.description}`)
              return
            }
            case "cursor/generate_image": {
              const request = yield* decode(GenerateImage, params)
              if (request._tag === "Some") yield* addNotice(id, `Generated an image: ${request.value.description}`)
              return
            }
          }
        })

      /** A prompt finished (maybe while no window watched): settle its steps, say why it stopped, time it, save. */
      const endTurn = (id: string) => (end: TurnEnd) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const notice = (text: string, tone: "info" | "error"): TimelineItem => ({
            _tag: "Notice",
            id: crypto.randomUUID(),
            text,
            tone,
          })
          yield* updateSession(id, (session) => {
            const extra = end.error
              ? [notice(end.error.message, "error")]
              : end.stopReason === "refusal"
                ? [notice("The agent declined this request.", "error")]
                : end.stopReason === "max_tokens" || end.stopReason === "max_turn_requests"
                  ? [notice("The agent stopped at its turn limit. Send a follow-up to continue.", "info")]
                  : []
            const items = [...settleTools(session.items), ...extra]
            return {
              ...session,
              status: end.error && !session.connected ? "failed" : "ready",
              turnStartedAt: null,
              items: session.turnStartedAt === null ? items : timeTurn(items, now - session.turnStartedAt),
            }
          })
          yield* persist(id)
        })

      const handlers = (id: string) => ({
        // A replay rebuilds history we already have; session-level updates (commands, modes) still apply.
        onUpdate: (notification: acp.SessionNotification) =>
          live.get(id)?.replaying && isHistory(notification.update)
            ? Effect.void
            : updateSession(id, (session) => applyUpdate(session, notification.update)),
        onPermission: (request: acp.RequestPermissionRequest) =>
          ask<acp.RequestPermissionResponse>(id, {
            _tag: "Permission",
            toolCall: request.toolCall,
            options: request.options,
          }),
        onExtension: onExtension(id),
        onExtensionNotification: onExtensionNotification(id),
        onTurnEnd: endTurn(id),
      })

      /**
       * Agents start in their default mode; switch to the one last picked for this agent if it
       * offers it. A failure here leaves the default rather than failing the connection.
       */
      const restoreMode = (id: string, connection: AcpConnection, acpSessionId: string) =>
        Effect.gen(function* () {
          const session = yield* getSession(id)
          const wanted = yield* rememberedMode(session.agentId)
          if (!wanted) return
          const option = configOption(session, "mode")
          if (option?.type === "select") {
            const offered = option.options.flatMap((entry) => ("group" in entry ? entry.options : [entry]))
            if (option.currentValue === wanted || !offered.some((choice) => choice.value === wanted)) return
            const configOptions = yield* connection.setConfigOption(acpSessionId, option.id, wanted)
            yield* updateSession(id, (current) => ({ ...current, configOptions }))
          } else if (session.modes) {
            const { currentModeId, availableModes } = session.modes
            if (currentModeId === wanted || !availableModes.some((mode) => mode.id === wanted)) return
            yield* connection.setMode(acpSessionId, wanted)
            yield* updateSession(id, (current) =>
              current.modes ? { ...current, modes: { ...current.modes, currentModeId: wanted } } : current,
            )
          }
        }).pipe(Effect.ignore)

      /** Marks the session failed when the agent process dies underneath it. */
      const watchExit = (id: string, handle: Live, process: AgentProcess, name: string) =>
        Deferred.await(process.exited).pipe(
          Effect.flatMap((code) =>
            updateSession(id, (current) => ({
              ...current,
              connected: false,
              status: "failed",
              turnStartedAt: null,
              error: [`${name} exited${code === null ? "" : ` with code ${code}`}.`, process.stderrTail()]
                .filter(Boolean)
                .join("\n"),
              items: settleTools(current.items),
            })),
          ),
          Effect.andThen(persist(id)),
          Effect.ensuring(Effect.sync(() => live.get(id) === handle && live.delete(id))),
          Effect.forkIn(handle.scope),
        )

      /**
       * Attaches to an agent the daemon kept running for this thread, picking the session up
       * where it is: its log since the last save, any prompt waiting for an answer, a turn in flight.
       */
      const reattach = (id: string, handle: Live, running: AgentSummary) =>
        Effect.gen(function* () {
          const session = yield* getSession(id)
          const spec = agents[session.agentId]
          const process = yield* host.attach(id, session.logSeq)
          handle.lastSeq = process.lastSeq
          const connection = yield* acpClient.connect(process, handlers(id))
          yield* watchExit(id, handle, process, spec.name)
          const resumed = (running.session ?? {}) as Partial<acp.NewSessionResponse>
          yield* updateSession(id, (current) => ({
            ...current,
            acpSessionId: running.sessionId ?? current.acpSessionId,
            connected: true,
            status: running.turn || current.status === "working" ? "working" : "ready",
            turnStartedAt: running.turn ? running.turn.startedAt : current.turnStartedAt,
            error: null,
            authMethods: connection.info.authMethods ?? [],
            supportsImages: Boolean(connection.info.agentCapabilities?.promptCapabilities?.image),
            configOptions: resumed.configOptions ?? current.configOptions,
            modes: resumed.modes ?? current.modes,
          }))
          return connection
        })

      /** A logged notification from the daemon, applied the way the live connection would. */
      const applyLogged = (id: string, message: unknown) => {
        const { method, params } = message as { method?: string; params?: Record<string, unknown> }
        const on = handlers(id)
        if (!method || !params) return Effect.void
        if (method === "session/update") return on.onUpdate(params as unknown as acp.SessionNotification)
        if (method === "_termy/turn_end") {
          return on.onTurnEnd({
            stopReason: (params.stopReason as acp.StopReason | null | undefined) ?? null,
            error: (params.error as TurnEnd["error"] | undefined) ?? null,
          })
        }
        return on.onExtensionNotification(method, params)
      }

      /**
       * An agent that stopped while no window watched (or whose daemon restarted) may have
       * reported things the thread hasn't saved yet: apply them, save, then let the agent go.
       */
      const collect = (id: string, handle: Live) =>
        Effect.gen(function* () {
          const { messages, lastSeq } = yield* host.backlog(id, (yield* getSession(id)).logSeq)
          for (const message of messages) yield* applyLogged(id, message)
          handle.lastSeq = () => lastSeq
          yield* persist(id)
          yield* host.kill(id)
        })

      /** Spawns the agent, then resumes, replays or starts the ACP session. */
      const establish = (id: string, handle: Live) =>
        Effect.gen(function* () {
          const running = (yield* host.list()).find((agent) => agent.key === id)
          if (running?.alive) return yield* reattach(id, handle, running)
          if (running) yield* collect(id, handle)

          const session = yield* getSession(id)
          const spec = agents[session.agentId]
          // A new process starts a new log.
          yield* updateSession(id, (current) => ({ ...current, logSeq: 0 }))
          handle.lastSeq = () => 0
          const process = yield* host.spawn(id, spec, session.cwd)
          handle.lastSeq = process.lastSeq
          const connection = yield* acpClient.connect(process, handlers(id))

          let resumed: acp.ResumeSessionResponse | acp.NewSessionResponse | acp.ForkSessionResponse
          let acpSessionId = session.acpSessionId
          let notice: string | null = null
          const fork = acpSessionId ? null : pendingFork(session.items)

          if (acpSessionId && connection.canResume) {
            resumed = yield* connection.resumeSession(acpSessionId, session.cwd)
          } else if (acpSessionId && connection.canLoad) {
            handle.replaying = true
            resumed = yield* connection
              .loadSession(acpSessionId, session.cwd)
              .pipe(Effect.ensuring(Effect.sync(() => (handle.replaying = false))))
          } else if (fork?.handoff === "native" && fork.fromAcpSessionId && connection.canFork) {
            const forked = yield* connection.forkSession(fork.fromAcpSessionId, session.cwd)
            acpSessionId = forked.sessionId
            resumed = forked
          } else {
            // A fork the agent can't do natively falls back to a transcript.
            if (fork?.handoff === "native") {
              yield* updateSession(id, (current) => ({
                ...current,
                items: current.items.map((item) =>
                  item.id === fork.id && item._tag === "Fork" ? { ...item, handoff: "transcript" as const } : item,
                ),
              }))
            }
            const created = yield* connection.newSession(session.cwd)
            if (acpSessionId) {
              notice = `${spec.name} started a fresh session. It can see this project but not the earlier messages.`
            }
            acpSessionId = created.sessionId
            resumed = created
          }

          yield* watchExit(id, handle, process, spec.name)

          yield* updateSession(id, (current) => ({
            ...current,
            acpSessionId,
            connected: true,
            status: current.status === "working" ? "working" : "ready",
            error: null,
            authMethods: connection.info.authMethods ?? [],
            supportsImages: Boolean(connection.info.agentCapabilities?.promptCapabilities?.image),
            configOptions: resumed.configOptions ?? current.configOptions,
            modes: resumed.modes ?? current.modes,
            items: notice
              ? [...current.items, { _tag: "Notice", id: crypto.randomUUID(), text: notice, tone: "info" }]
              : current.items,
          }))
          yield* restoreMode(id, connection, acpSessionId)
          return connection
        }).pipe(
          Scope.provide(handle.scope),
          Effect.catch((error) =>
            Effect.gen(function* () {
              const session = yield* getSession(id)
              const message =
                error instanceof AcpError && error.needsAuth ? agents[session.agentId].loginHint : describe(error)
              yield* updateSession(id, (current) => ({
                ...current,
                connected: false,
                status: "failed",
                error: message,
              }))
              return yield* new WorkspaceError({ message })
            }),
          ),
        )

      /** Returns the live connection, starting the agent on first use. Concurrent callers share one start. */
      const ensureConnected = Effect.fnUntraced(function* (id: string) {
        const existing = live.get(id)
        if (existing) return yield* Deferred.await(existing.ready)

        const handle: Live = {
          scope: yield* Scope.make(),
          ready: yield* Deferred.make<AcpConnection, WorkspaceError>(),
          request: null,
          todos: [],
          replaying: false,
          lastSeq: () => 0,
        }
        live.set(id, handle)
        yield* updateSession(id, (session) => ({ ...session, status: "starting", error: null }))

        const exit = yield* Effect.exit(establish(id, handle))
        yield* Deferred.done(handle.ready, exit)
        if (Exit.isFailure(exit)) {
          live.delete(id)
          yield* Scope.close(handle.scope, Exit.void)
        }
        return yield* exit
      })

      /**
       * Lets go of the thread's agent. `stop` ends it (and any prompt it's waiting on); without it
       * the agent keeps running in the daemon, e.g. when the window closes.
       */
      const disconnect = Effect.fnUntraced(function* (id: string, stop: boolean) {
        const handle = live.get(id)
        if (handle) {
          live.delete(id)
          if (stop && handle.request) yield* Deferred.succeed(handle.request, cancelled)
          yield* Scope.close(handle.scope, Exit.void)
        }
        if (stop) yield* host.kill(id)
      })

      // ── projects ──────────────────────────────────────────────────────

      const addProject = Effect.fn("Workspace.addProject")(
        function* () {
          const path = yield* tauri.pickDirectory()
          if (!path) return null
          const now = yield* Clock.currentTimeMillis
          const project = yield* db.saveProject(
            new Project({
              id: crypto.randomUUID(),
              path,
              name: path.split("/").filter(Boolean).at(-1) ?? path,
              createdAt: now,
              lastOpenedAt: now,
            }),
          )
          yield* update((current) => ({
            ...current,
            projects: [project, ...current.projects.filter((existing) => existing.id !== project.id)],
          }))
          return project
        },
        Effect.mapError(toWorkspaceError),
      )

      const removeProject = Effect.fn("Workspace.removeProject")(
        function* (id: string) {
          const current = yield* SubscriptionRef.get(state)
          for (const session of Object.values(current.sessions)) {
            if (session.projectId === id) yield* disconnect(session.id, true)
          }
          yield* db.deleteProject(id)
          yield* update((current) => ({
            ...current,
            projects: current.projects.filter((project) => project.id !== id),
            tabs: current.tabs.filter(
              (tab) => tab._tag !== "Thread" || current.threads.find((thread) => thread.id === tab.id)?.projectId !== id,
            ),
            threads: current.threads.filter((thread) => thread.projectId !== id),
            sessions: Object.fromEntries(
              Object.entries(current.sessions).filter(([, session]) => session.projectId !== id),
            ),
          }))
        },
        Effect.mapError(toWorkspaceError),
      )

      // ── threads ───────────────────────────────────────────────────────

      const createDraft = Effect.fn("Workspace.createDraft")(function* (projectId: string, agentId: AgentId) {
        const project = (yield* SubscriptionRef.get(state)).projects.find((p) => p.id === projectId)
        if (!project) return yield* new WorkspaceError({ message: "Pick a project first." })
        const now = yield* Clock.currentTimeMillis
        const session = makeSession({ id: crypto.randomUUID(), projectId, cwd: project.path, agentId, now })
        yield* update((current) => ({ ...current, sessions: { ...current.sessions, [session.id]: session } }))
        // Warm the agent in the background; failures land on the session.
        yield* ensureConnected(session.id).pipe(Effect.ignore, Effect.forkDetach)
        return session.id
      })

      const discard = Effect.fn("Workspace.discard")(function* (id: string) {
        yield* disconnect(id, true)
        yield* update((current) => {
          const { [id]: _removed, ...sessions } = current.sessions
          return { ...current, sessions }
        })
      })

      /** Brings a saved thread into the window (without a tab) and connects its agent. */
      const load = Effect.fnUntraced(function* (id: string) {
          const current = yield* SubscriptionRef.get(state)
          if (!current.sessions[id]) {
            const record = yield* db.getThread(id)
            if (!record) return yield* new WorkspaceError({ message: "This thread no longer exists." })
            const project = current.projects.find((p) => p.id === record.projectId)
            if (!project) return yield* new WorkspaceError({ message: "This thread's project was removed." })
            const session: Session = {
              ...makeSession({
                id: record.id,
                projectId: record.projectId,
                cwd: project.path,
                agentId: record.agentId,
                now: record.createdAt,
              }),
              acpSessionId: record.acpSessionId,
              title: record.title,
              items: settleTools(record.items),
              status: "ready",
              updatedAt: record.updatedAt,
              logSeq: record.logSeq,
            }
            yield* update((s) => ({ ...s, sessions: { ...s.sessions, [id]: session } }))
          }
          if (!live.has(id)) yield* ensureConnected(id).pipe(Effect.ignore, Effect.forkDetach)
      })

      const open = Effect.fn("Workspace.open")(
        function* (id: string) {
          yield* load(id)
          yield* setTabs((tabs) => (tabs.some((tab) => tab.id === id) ? tabs : [...tabs, { _tag: "Thread", id }]))
        },
        Effect.mapError(toWorkspaceError),
      )

      /**
       * Sends the prompt. How it ends arrives as the daemon's `_termy/turn_end` (see `endTurn`), in
       * order with the agent's updates and even if the window closed meanwhile. Only a prompt the
       * daemon couldn't deliver at all ends here.
       */
      const runTurn = (id: string, connection: AcpConnection, acpSessionId: string, prompt: Prompt) =>
        connection.prompt(acpSessionId, prompt).pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            error.code === -1 ? endTurn(id)({ stopReason: null, error: { message: error.message } }) : Effect.void,
          ),
        )

      const send = Effect.fn("Workspace.send")(function* (
        id: string,
        text: string,
        images: ReadonlyArray<ImageAttachment> = [],
        mentions: ReadonlyArray<Mention> = [],
      ) {
        const trimmed = text.trim()
        if (!trimmed && images.length === 0) return
        const now = yield* Clock.currentTimeMillis
        yield* updateSession(id, (session) => ({
          ...session,
          title: session.title === untitled ? titleFrom(trimmed || images[0]?.name || "Image") : session.title,
          status: "working",
          turnStartedAt: now,
          items: [
            ...session.items,
            {
              _tag: "User",
              id: crypto.randomUUID(),
              text: trimmed,
              ...(images.length > 0 ? { images } : {}),
              ...(mentions.length > 0 ? { mentions } : {}),
            },
          ],
        }))
        yield* persist(id)

        const connection = yield* ensureConnected(id).pipe(
          Effect.tapError(() =>
            updateSession(id, (session) => ({ ...session, turnStartedAt: null })),
          ),
        )
        const session = yield* getSession(id)
        const handle = live.get(id)
        if (!session.acpSessionId || !handle) {
          return yield* new WorkspaceError({ message: "The agent session isn't ready yet." })
        }
        if (images.length > 0 && !session.supportsImages) {
          return yield* new WorkspaceError({ message: `${agents[session.agentId].name} doesn't accept images.` })
        }
        // The first prompt after a handoff carries the conversation it came from.
        const items = session.items.slice(0, -1)
        const fork = pendingFork(items)
        const context =
          fork?.handoff === "transcript" ? transcript(items, fork, agents[fork.fromAgentId].name) : undefined
        yield* Effect.forkIn(
          runTurn(id, connection, session.acpSessionId, { text: trimmed, images, mentions, context }),
          handle.scope,
        )
      })

      const cancel = Effect.fn("Workspace.cancel")(function* (id: string) {
        const handle = live.get(id)
        const session = (yield* SubscriptionRef.get(state)).sessions[id]
        if (!handle || !session?.acpSessionId) return
        if (handle.request) yield* Deferred.succeed(handle.request, cancelled)
        const connection = yield* Deferred.await(handle.ready).pipe(Effect.option)
        if (connection._tag === "Some") yield* connection.value.cancel(session.acpSessionId).pipe(Effect.ignore)
      })

      const retry = Effect.fn("Workspace.retry")(function* (id: string) {
        yield* disconnect(id, true)
        yield* ensureConnected(id).pipe(Effect.ignore, Effect.forkDetach)
      })

      const withConnection = Effect.fnUntraced(function* (id: string) {
        const session = yield* getSession(id)
        const handle = live.get(id)
        if (!handle || !session.acpSessionId) {
          return yield* new WorkspaceError({ message: "The agent isn't connected." })
        }
        const connection = yield* Deferred.await(handle.ready)
        return { connection, acpSessionId: session.acpSessionId }
      })

      const setConfigOption = Effect.fn("Workspace.setConfigOption")(
        function* (id: string, configId: string, value: string) {
          const session = yield* getSession(id)
          if (configOption(session, "mode")?.id === configId) yield* rememberMode(session.agentId, value)
          // Optimistic, so the slider and menus respond instantly.
          yield* updateSession(id, (session) => ({
            ...session,
            configOptions: session.configOptions.map((option) =>
              option.id === configId && option.type === "select" ? { ...option, currentValue: value } : option,
            ),
          }))
          const { connection, acpSessionId } = yield* withConnection(id)
          const configOptions = yield* connection.setConfigOption(acpSessionId, configId, value)
          yield* updateSession(id, (session) => ({ ...session, configOptions }))
        },
        Effect.mapError(toWorkspaceError),
      )

      const setMode = Effect.fn("Workspace.setMode")(
        function* (id: string, modeId: string) {
          yield* rememberMode((yield* getSession(id)).agentId, modeId)
          yield* updateSession(id, (session) =>
            session.modes ? { ...session, modes: { ...session.modes, currentModeId: modeId } } : session,
          )
          const { connection, acpSessionId } = yield* withConnection(id)
          yield* connection.setMode(acpSessionId, modeId)
        },
        Effect.mapError(toWorkspaceError),
      )

      const respondPermission = Effect.fn("Workspace.respondPermission")(function* (
        id: string,
        optionId: string | null,
      ) {
        const response: acp.RequestPermissionResponse = optionId
          ? { outcome: { outcome: "selected", optionId } }
          : cancelled
        yield* resolveRequest(id, response)
      })

      const answerQuestions = Effect.fn("Workspace.answerQuestions")(function* (
        id: string,
        answers: ReadonlyArray<QuestionAnswer> | null,
      ) {
        yield* resolveRequest(
          id,
          answers ? { outcome: { outcome: "answered", answers } } : { outcome: { outcome: "skipped" } },
        )
      })

      const decidePlan = Effect.fn("Workspace.decidePlan")(function* (id: string, accepted: boolean) {
        yield* resolveRequest(id, { outcome: { outcome: accepted ? "accepted" : "rejected" } })
      })

      const deleteThread = Effect.fn("Workspace.deleteThread")(
        function* (id: string) {
          yield* discard(id)
          yield* closeThreadShells(id)
          yield* db.deleteThread(id)
          yield* update((current) => ({
            ...current,
            threads: current.threads.filter((thread) => thread.id !== id),
            tabs: current.tabs.filter((tab) => tab.id !== id),
          }))
        },
        Effect.mapError(toWorkspaceError),
      )

      const fork = Effect.fn("Workspace.fork")(function* (id: string, agentId: AgentId, upTo?: string) {
        const source = yield* getSession(id)
        const cut = upTo ? source.items.findIndex((item) => item.id === upTo) : -1
        const whole = cut < 0 || cut === source.items.length - 1
        const items = settleTools(whole ? source.items : source.items.slice(0, cut + 1))
        const now = yield* Clock.currentTimeMillis
        const forkId = crypto.randomUUID()
        const session: Session = {
          ...makeSession({ id: forkId, projectId: source.projectId, cwd: source.cwd, agentId, now }),
          title: source.title,
          status: "starting",
          items: [
            ...items,
            {
              _tag: "Fork",
              id: crypto.randomUUID(),
              fromTitle: source.title,
              fromAgentId: source.agentId,
              fromAcpSessionId: source.acpSessionId,
              // The agent's own fork copies the whole session, so a partial fork needs the transcript.
              handoff: agentId === source.agentId && source.acpSessionId && whole ? "native" : "transcript",
            },
          ],
        }
        yield* update((current) => ({ ...current, sessions: { ...current.sessions, [forkId]: session } }))
        yield* persist(forkId)
        yield* ensureConnected(forkId).pipe(Effect.ignore, Effect.forkDetach)
        return forkId
      })

      const writeTabs = (tabs: ReadonlyArray<Tab>) =>
        Effect.sync(() => {
          try {
            localStorage.setItem(TABS_KEY, JSON.stringify(tabs))
          } catch {
            // Tabs just won't come back after a restart.
          }
        })

      const setTabs = (f: (tabs: ReadonlyArray<Tab>) => ReadonlyArray<Tab>) =>
        SubscriptionRef.modify(state, (current) => {
          const tabs = f(current.tabs)
          return [tabs, { ...current, tabs }] as const
        }).pipe(Effect.flatMap(writeTabs))

      const closeTab = Effect.fn("Workspace.closeTab")(function* (id: string) {
        const tab = (yield* SubscriptionRef.get(state)).tabs.find((candidate) => candidate.id === id)
        yield* setTabs((tabs) => tabs.filter((candidate) => candidate.id !== id))
        // A terminal tab's shell runs in the daemon until its tab closes.
        if (tab?._tag === "Terminal") yield* shells.close(id)
        const session = (yield* SubscriptionRef.get(state)).sessions[id]
        if (session && session.status !== "working") yield* discard(id)
      })

      /** Ends the shells in a thread's side panel, which are keyed `<thread id>:panel:<n>`. */
      const closeThreadShells = (threadId: string) =>
        daemon.request("shell.list", null, Schema.Array(Schema.Struct({ key: Schema.String }))).pipe(
          Effect.flatMap((list) =>
            Effect.forEach(
              list.filter((shell) => shell.key.startsWith(`${threadId}:panel:`)),
              (shell) => shells.close(shell.key),
              { discard: true },
            ),
          ),
          Effect.ignore,
        )

      const openTerminal = Effect.fn("Workspace.openTerminal")(function* (cwd: string, title: string) {
        const id = crypto.randomUUID()
        yield* setTabs((tabs) => [...tabs, { _tag: "Terminal", id, cwd, title }])
        return id
      })

      const setTerminalTitle = Effect.fn("Workspace.setTerminalTitle")(function* (id: string, title: string) {
        yield* setTabs((tabs) =>
          tabs.map((tab) => (tab.id === id && tab._tag === "Terminal" && tab.title !== title ? { ...tab, title } : tab)),
        )
      })

      // ── agent terminals ───────────────────────────────────────────────

      const emptyTerminal: TerminalOutput = { text: "", column: 0, exitCode: null, signal: null, exited: false }
      const updateTerminal = (id: string, f: (terminal: TerminalOutput) => TerminalOutput) =>
        Effect.runSync(
          update((current) => ({
            ...current,
            terminals: { ...current.terminals, [id]: f(current.terminals[id] ?? emptyTerminal) },
          })),
        )

      const ExitStatus = Schema.Struct({ exitCode: Schema.NullOr(Schema.Number), signal: Schema.NullOr(Schema.String) })
      const TerminalOutputEvent = Schema.Struct({ id: Schema.String, text: Schema.String })
      const TerminalExitEvent = Schema.Struct({ id: Schema.String, exitStatus: ExitStatus })
      const TerminalSnapshot = Schema.Struct({ id: Schema.String, text: Schema.String, exitStatus: Schema.NullOr(ExitStatus) })
      const decodeTerminalOutput = Schema.decodeUnknownOption(TerminalOutputEvent)
      const decodeTerminalExit = Schema.decodeUnknownOption(TerminalExitEvent)

      yield* daemon.on("acpTerminal.output", (data) => {
        const event = decodeTerminalOutput(data)
        if (event._tag === "Some") {
          updateTerminal(event.value.id, (terminal) => appendTerminalText(terminal, event.value.text))
        }
      })
      yield* daemon.on("acpTerminal.exit", (data) => {
        const event = decodeTerminalExit(data)
        if (event._tag === "Some") {
          const { exitCode, signal } = event.value.exitStatus
          updateTerminal(event.value.id, (terminal) => ({ ...terminal, exited: true, exitCode, signal }))
        }
      })

      // The daemon stopped (crashed, or restarted from Settings): every agent it ran is gone.
      yield* daemon.onDisconnect(() =>
        Effect.runFork(
          Effect.forEach(
            [...live.keys()],
            (id) =>
              disconnect(id, false).pipe(
                Effect.andThen(
                  updateSession(id, (session) => ({
                    ...session,
                    connected: false,
                    status: "failed",
                    turnStartedAt: null,
                    request: null,
                    error: "Termy Code's background service stopped. Retry to start the agent again.",
                    items: settleTools(session.items),
                  })),
                ),
              ),
            { discard: true },
          ),
        ),
      )

      // ── boot ──────────────────────────────────────────────────────────

      yield* Effect.gen(function* () {
        const [projects, threads] = yield* Effect.all([db.listProjects(), db.listThreads()])
        const saved = yield* Effect.sync((): ReadonlyArray<Tab> => {
          try {
            const parsed = decodeTabs(JSON.parse(localStorage.getItem(TABS_KEY) ?? "[]"))
            return parsed._tag === "Some" ? parsed.value : []
          } catch {
            return []
          }
        })
        // Terminal tabs reattach to their shells in the daemon (or start fresh ones in the same folder).
        const tabs = saved.filter((tab) => tab._tag === "Terminal" || threads.some((thread) => thread.id === tab.id))
        yield* update((current) => ({ ...current, loaded: true, projects, threads, tabs }))

        // Commands agents were running when the window closed, for their live steps.
        const running = yield* daemon
          .request("terminals.snapshot", null, Schema.Array(TerminalSnapshot))
          .pipe(Effect.orElseSucceed(() => []))
        for (const terminal of running) {
          updateTerminal(terminal.id, () => ({
            ...appendTerminalText(emptyTerminal, terminal.text),
            exited: terminal.exitStatus !== null,
            exitCode: terminal.exitStatus?.exitCode ?? null,
            signal: terminal.exitStatus?.signal ?? null,
          }))
        }

        // Agents that kept working while no window was open come back into their threads.
        // The daemon's agents for threads that don't exist (unsent drafts, deleted threads) go.
        for (const agent of yield* host.list()) {
          const saved = threads.some((thread) => thread.id === agent.key)
          if (!saved) yield* host.kill(agent.key)
          else if (agent.alive) yield* load(agent.key).pipe(Effect.ignore)
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Couldn't load workspace", Cause.pretty(cause)).pipe(
            Effect.andThen(update((current) => ({ ...current, loaded: true }))),
          ),
        ),
      )

      // Closing the window detaches: agents keep working in the daemon until the next one attaches.
      yield* Effect.addFinalizer(() =>
        Effect.forEach([...live.keys()], (id) => disconnect(id, false), { discard: true }),
      )

      return Workspace.of({
        state,
        addProject,
        removeProject,
        createDraft,
        discard,
        open,
        send,
        cancel,
        retry,
        setConfigOption,
        setMode,
        respondPermission,
        deleteThread,
        fork,
        closeTab,
        openTerminal,
        setTerminalTitle,
        closeShell: (key) => shells.close(key),
        backgroundStatus: () =>
          tauri.invoke<unknown>("daemon_info").pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(BackgroundStatus)),
            Effect.mapError(toWorkspaceError),
          ),
        restartBackground: () => tauri.invoke<void>("daemon_restart").pipe(Effect.mapError(toWorkspaceError)),
        readFile: (path) =>
          tauri
            .invoke<string>("fs_read_text", { path, line: null, limit: null })
            .pipe(Effect.mapError(toWorkspaceError)),
        answerQuestions,
        decidePlan,
        searchThreads: (query) => db.searchThreads(query).pipe(Effect.mapError(toWorkspaceError)),
        loadImages: Effect.fn("Workspace.loadImages")(
          function* (paths?: ReadonlyArray<string>) {
            const chosen = paths ?? (yield* tauri.pickImages())
            return yield* Effect.forEach(chosen, (path) => tauri.invoke<ImageAttachment>("fs_read_image", { path }), {
              concurrency: 4,
            })
          },
          Effect.mapError(toWorkspaceError),
        ),
        gitBranch: (cwd) =>
          tauri.invoke<string | null>("git_branch", { cwd }).pipe(Effect.orElseSucceed(() => null)),
        listFiles: (cwd) =>
          tauri.invoke<ReadonlyArray<string>>("project_files", { cwd }).pipe(Effect.mapError(toWorkspaceError)),
        listSkills: (agentId, cwd) =>
          tauri
            .invoke<ReadonlyArray<Skill>>("skills_list", { agent: agentId, cwd })
            .pipe(Effect.mapError(toWorkspaceError)),
      })
    }),
  ).pipe(
    Layer.provide([Database.layer, AgentHost.layer, AcpClient.layer, Daemon.layer, TerminalHost.layer, Tauri.layer]),
  )
}
