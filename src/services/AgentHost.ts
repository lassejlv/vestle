import type * as acp from "@agentclientprotocol/sdk"
import { Context, Deferred, Effect, Layer, Schema, type Scope } from "effect"
import type { AgentSpec } from "@/domain/agents"
import { isHistory } from "@/domain/session"
import { Daemon } from "./Daemon"

export class SpawnError extends Schema.TaggedError<SpawnError>()("SpawnError", {
  agent: Schema.String,
  message: Schema.String,
}) {}

/** A prompt the agent is still working on: `startedAt` is when it was sent. */
const Turn = Schema.Struct({ sessionId: Schema.NullOr(Schema.String), startedAt: Schema.Number })

/** What the daemon knows about an agent it runs, keyed by thread id. */
export const AgentSummary = Schema.Struct({
  key: Schema.String,
  alive: Schema.Boolean,
  exitCode: Schema.NullOr(Schema.Number),
  stderr: Schema.String,
  turn: Schema.NullOr(Turn),
  /** The agent's `initialize` result, so a new window can skip the handshake. */
  initialize: Schema.NullOr(Schema.Unknown),
  /** The result of the last `session/new`, `load`, `resume` or `fork`. */
  session: Schema.NullOr(Schema.Unknown),
  sessionId: Schema.NullOr(Schema.String),
  lastSeq: Schema.Number,
})
export type AgentSummary = typeof AgentSummary.Type

const Entry = Schema.Struct({ seq: Schema.Number, replay: Schema.Boolean, message: Schema.Unknown })
type Entry = typeof Entry.Type

const Snapshot = Schema.Struct({
  ...AgentSummary.fields,
  entries: Schema.Array(Entry),
  pending: Schema.Array(Schema.Unknown),
  /** The newest commands, mode, config, usage and title updates, which the log may have trimmed. */
  latest: Schema.Array(Schema.Unknown),
})

const EntryEvent = Schema.Struct({ key: Schema.String, entry: Entry })
const MessageEvent = Schema.Struct({ key: Schema.String, message: Schema.Unknown })
const ExitEvent = Schema.Struct({ key: Schema.String, code: Schema.NullOr(Schema.Number), stderr: Schema.String })

const decodeEntry = Schema.decodeUnknownOption(EntryEvent)
const decodeMessage = Schema.decodeUnknownOption(MessageEvent)
const decodeExit = Schema.decodeUnknownOption(ExitEvent)

/** A running agent process with its stdio exposed as an ACP message stream. */
export interface AgentProcess {
  readonly stream: acp.Stream
  /** Resolves with the exit code once the process ends. */
  readonly exited: Deferred.Deferred<number | null>
  /** The last lines the agent wrote to stderr, for error messages. */
  readonly stderrTail: () => string
  /** The highest log entry handed to the stream; what's saved up to it needn't be replayed. */
  readonly lastSeq: () => number
  /** How the agent stood when attached: its handshake, session and any turn in flight. */
  readonly summary: AgentSummary
}

type Route = {
  readonly entry: (entry: Entry) => void
  readonly message: (message: unknown) => void
  readonly exit: (code: number | null, stderr: string) => void
}

/** Notifications from `session/load` repeat history the thread already has. */
const isReplayedHistory = (entry: Entry) => {
  if (!entry.replay) return false
  const message = entry.message as { method?: string; params?: { update?: acp.SessionUpdate } }
  return message.method === "session/update" && message.params?.update !== undefined && isHistory(message.params.update)
}

export class AgentHost extends Context.Service<
  AgentHost,
  {
    /** Starts the agent in the daemon and attaches to it. Closing the scope detaches; the agent keeps running. */
    spawn(key: string, spec: AgentSpec, cwd: string): Effect.Effect<AgentProcess, SpawnError, Scope.Scope>
    /** Attaches to an agent the daemon already runs, replaying its log after `after`. */
    attach(key: string, after: number): Effect.Effect<AgentProcess, SpawnError, Scope.Scope>
    /**
     * What a stopped agent logged after `after`, without connecting: the messages to apply
     * (replayed history left out) and the number of the last entry.
     */
    backlog(key: string, after: number): Effect.Effect<{ readonly messages: ReadonlyArray<unknown>; readonly lastSeq: number }>
    /** Stops the agent for good. */
    kill(key: string): Effect.Effect<void>
    /** Everything up to `seq` is saved, so the daemon can drop it. */
    ack(key: string, seq: number): Effect.Effect<void>
    list(): Effect.Effect<ReadonlyArray<AgentSummary>>
  }
>()("termy/services/AgentHost") {
  static readonly layer = Layer.effect(
    AgentHost,
    Effect.gen(function* () {
      const daemon = yield* Daemon
      const routes = new Map<string, Route>()

      yield* daemon.on("agent.entry", (data) => {
        const event = decodeEntry(data)
        if (event._tag === "Some") routes.get(event.value.key)?.entry(event.value.entry)
      })
      yield* daemon.on("agent.message", (data) => {
        const event = decodeMessage(data)
        if (event._tag === "Some") routes.get(event.value.key)?.message(event.value.message)
      })
      yield* daemon.on("agent.exit", (data) => {
        const event = decodeExit(data)
        if (event._tag === "Some") routes.get(event.value.key)?.exit(event.value.code, event.value.stderr)
      })

      const attach = Effect.fn("AgentHost.attach")(function* (key: string, after: number, agent: string) {
        const exited = yield* Deferred.make<number | null>()
        let lastSeq = after
        let stderr = ""
        let detached = false
        let push: (message: acp.AnyMessage) => void = () => {}
        let close: () => void = () => {}
        const readable = new ReadableStream<acp.AnyMessage>({
          start(controller) {
            push = (message) => controller.enqueue(message)
            close = () => {
              try {
                controller.close()
              } catch {
                // Already closed.
              }
            }
          },
        })

        const deliver = (entry: Entry) => {
          if (entry.seq <= lastSeq) return
          lastSeq = entry.seq
          if (!isReplayedHistory(entry)) push(entry.message as acp.AnyMessage)
        }
        const end = (code: number | null, tail: string) => {
          stderr = tail
          close()
          Deferred.doneUnsafe(exited, Effect.succeed(code))
        }

        // Events can beat the attach reply, so hold them until the backlog is in.
        const early: Array<(route: Route) => void> = []
        routes.set(key, {
          entry: (entry) => early.push((route) => route.entry(entry)),
          message: (message) => early.push((route) => route.message(message)),
          exit: (code, tail) => early.push((route) => route.exit(code, tail)),
        })

        const snapshot = yield* daemon.request("agent.attach", { key, after }, Snapshot).pipe(
          Effect.tapError(() => Effect.sync(() => routes.delete(key))),
          Effect.mapError((error) => new SpawnError({ agent, message: error.message })),
        )
        stderr = snapshot.stderr
        for (const update of snapshot.latest) push(update as acp.AnyMessage)
        for (const entry of snapshot.entries) deliver(entry)
        for (const request of snapshot.pending) push(request as acp.AnyMessage)
        const route: Route = {
          entry: deliver,
          message: (message) => push(message as acp.AnyMessage),
          exit: end,
        }
        routes.set(key, route)
        for (const replay of early) replay(route)
        if (!snapshot.alive) end(snapshot.exitCode, snapshot.stderr)
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            // Detached for good: nothing this window does from here may reach the agent.
            detached = true
            if (routes.get(key) === route) routes.delete(key)
            yield* daemon.request("agent.detach", { key }, Schema.Unknown).pipe(Effect.ignore)
          }),
        )

        const writable = new WritableStream<acp.AnyMessage>({
          write: (message) =>
            detached
              ? Promise.resolve()
              : Effect.runPromise(
                  daemon.request("agent.send", { key, message }, Schema.Unknown).pipe(Effect.asVoid),
                ),
        })

        return {
          stream: { readable, writable },
          exited,
          stderrTail: () => stderr,
          lastSeq: () => lastSeq,
          summary: snapshot,
        } satisfies AgentProcess
      })

      const spawn = Effect.fn("AgentHost.spawn")(function* (key: string, spec: AgentSpec, cwd: string) {
        yield* daemon
          .request("agent.spawn", { key, command: spec.command, args: spec.args, cwd, env: {} }, Schema.Unknown)
          .pipe(Effect.mapError((error) => new SpawnError({ agent: spec.name, message: error.message })))
        return yield* attach(key, 0, spec.name)
      })

      const backlog = Effect.fn("AgentHost.backlog")(function* (key: string, after: number) {
        const snapshot = yield* daemon.request("agent.attach", { key, after }, Snapshot).pipe(Effect.option)
        yield* daemon.request("agent.detach", { key }, Schema.Unknown).pipe(Effect.ignore)
        if (snapshot._tag === "None") return { messages: [], lastSeq: after }
        const entries = snapshot.value.entries.filter((entry) => entry.seq > after)
        return {
          messages: [
            ...snapshot.value.latest,
            ...entries.filter((entry) => !isReplayedHistory(entry)).map((entry) => entry.message),
          ],
          lastSeq: Math.max(after, ...entries.map((entry) => entry.seq)),
        }
      })

      return AgentHost.of({
        spawn,
        backlog,
        attach: (key, after) => attach(key, after, "agent"),
        kill: (key) => daemon.request("agent.kill", { key }, Schema.Unknown).pipe(Effect.ignore),
        ack: (key, seq) => daemon.request("agent.ack", { key, seq }, Schema.Unknown).pipe(Effect.ignore),
        list: () =>
          daemon.request("agent.list", null, Schema.Array(AgentSummary)).pipe(
            Effect.orElseSucceed(() => []),
          ),
      })
    }),
  ).pipe(Layer.provide(Daemon.layer))
}
