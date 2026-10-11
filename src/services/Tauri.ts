import { invoke as tauriInvoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { open } from "@tauri-apps/plugin-dialog"
import { Context, Effect, Layer, Schema, type Scope } from "effect"

export class TauriError extends Schema.TaggedError<TauriError>()("TauriError", {
  command: Schema.String,
  message: Schema.String,
}) {}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** Thin Effect boundary over the Tauri IPC bridge. */
export class Tauri extends Context.Service<
  Tauri,
  {
    invoke<A>(command: string, args?: Record<string, unknown>): Effect.Effect<A, TauriError>
    /** Subscribes for the lifetime of the surrounding scope. */
    listen<A>(event: string, handler: (payload: A) => void): Effect.Effect<void, TauriError, Scope.Scope>
    pickDirectory(): Effect.Effect<string | null, TauriError>
    pickImages(): Effect.Effect<ReadonlyArray<string>, TauriError>
  }
>()("termy/services/Tauri") {
  static readonly layer = Layer.succeed(
    Tauri,
    Tauri.of({
      invoke: <A>(command: string, args?: Record<string, unknown>) =>
        Effect.tryPromise({
          try: () => tauriInvoke<A>(command, args),
          catch: (cause) => new TauriError({ command, message: messageOf(cause) }),
        }),
      listen: <A>(event: string, handler: (payload: A) => void) =>
        Effect.acquireRelease(
          Effect.tryPromise({
            try: () => listen<A>(event, (message) => handler(message.payload)),
            catch: (cause) => new TauriError({ command: `listen:${event}`, message: messageOf(cause) }),
          }),
          (unlisten: UnlistenFn) => Effect.sync(unlisten),
        ).pipe(Effect.asVoid),
      pickImages: () =>
        Effect.tryPromise({
          try: () =>
            open({
              multiple: true,
              title: "Attach images",
              filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
            }),
          catch: (cause) => new TauriError({ command: "dialog:open", message: messageOf(cause) }),
        }).pipe(Effect.map((paths) => paths ?? [])),
      pickDirectory: () =>
        Effect.tryPromise({
          try: () => open({ directory: true, multiple: false, title: "Open project" }),
          catch: (cause) => new TauriError({ command: "dialog:open", message: messageOf(cause) }),
        }),
    }),
  )
}
