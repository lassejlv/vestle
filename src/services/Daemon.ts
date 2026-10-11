import { Context, Effect, Layer, Schema, type Scope } from "effect"
import { Tauri } from "./Tauri"

export class DaemonError extends Schema.TaggedError<DaemonError>()("DaemonError", {
  method: Schema.String,
  message: Schema.String,
}) {}

const Frame = Schema.Struct({ event: Schema.String, data: Schema.Unknown })
const decodeFrame = Schema.decodeUnknownOption(Frame)

type Handler = (data: unknown) => void

/**
 * The background daemon that owns agents and shells (src-tauri/src/daemon), so
 * they keep running after the window closes. Requests go through the app's
 * socket connection; events fan out to whoever subscribed to their name.
 */
export class Daemon extends Context.Service<
  Daemon,
  {
    request<S extends Schema.Top>(
      method: string,
      params: Record<string, unknown> | null,
      schema: S,
    ): Effect.Effect<S["Type"], DaemonError>
    /** Subscribes to one event for the lifetime of the surrounding scope. */
    on(event: string, handler: Handler): Effect.Effect<void, never, Scope.Scope>
    /** The app lost the daemon (it crashed or was stopped); everything it ran is gone. */
    onDisconnect(handler: () => void): Effect.Effect<void, never, Scope.Scope>
  }
>()("termy/services/Daemon") {
  static readonly layer = Layer.effect(
    Daemon,
    Effect.gen(function* () {
      const tauri = yield* Tauri
      const handlers = new Map<string, Set<Handler>>()
      const disconnects = new Set<() => void>()

      yield* tauri
        .listen<unknown>("daemon://event", (payload) => {
          const frame = decodeFrame(payload)
          if (frame._tag === "None") return
          for (const handler of handlers.get(frame.value.event) ?? []) handler(frame.value.data)
        })
        .pipe(Effect.orDie)
      yield* tauri
        .listen<null>("daemon://disconnected", () => {
          for (const handler of disconnects) handler()
        })
        .pipe(Effect.orDie)

      const subscribe = <A>(set: Set<A>, value: A) =>
        Effect.acquireRelease(
          Effect.sync(() => set.add(value)),
          () => Effect.sync(() => set.delete(value)),
        ).pipe(Effect.asVoid)

      return Daemon.of({
        request: <S extends Schema.Top>(method: string, params: Record<string, unknown> | null, schema: S) =>
          tauri.invoke<unknown>("daemon_request", { method, params }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(schema)),
            Effect.mapError((error) => new DaemonError({ method, message: error.message })),
          ) as Effect.Effect<S["Type"], DaemonError>,
        on: (event, handler) => {
          const set = handlers.get(event) ?? new Set<Handler>()
          handlers.set(event, set)
          return subscribe(set, handler)
        },
        onDisconnect: (handler) => subscribe(disconnects, handler),
      })
    }),
  ).pipe(Layer.provide(Tauri.layer))
}
