import { Context, Effect, Layer, Schema, type Scope } from "effect"
import { Daemon, type DaemonError } from "./Daemon"

export interface TerminalSession {
  write(data: string): Effect.Effect<void, DaemonError>
  resize(cols: number, rows: number): Effect.Effect<void, DaemonError>
}

const Opened = Schema.Struct({ created: Schema.Boolean, scrollback: Schema.String, exited: Schema.Boolean })
const OutputEvent = Schema.Struct({ key: Schema.String, data: Schema.String })
const ExitEvent = Schema.Struct({ key: Schema.String })
const decodeOutput = Schema.decodeUnknownOption(OutputEvent)
const decodeExit = Schema.decodeUnknownOption(ExitEvent)

/** Shell output travels base64-encoded; xterm.js wants the raw bytes. */
const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))

interface Route {
  readonly output: (bytes: Uint8Array) => void
  readonly exit: () => void
}

/**
 * Shells run by the background daemon on Alacritty's PTY, so they outlive the window.
 * Output arrives as raw bytes for xterm.js.
 */
export class TerminalHost extends Context.Service<
  TerminalHost,
  {
    /**
     * Attaches to the shell under `key`, replaying its recent output, or starts one in `cwd`.
     * Closing the scope detaches; the shell keeps running until `close`.
     */
    open(options: {
      key: string
      cwd: string
      cols: number
      rows: number
      onOutput: (bytes: Uint8Array) => void
      onExit: () => void
    }): Effect.Effect<TerminalSession, DaemonError, Scope.Scope>
    /** Ends the shell for good. */
    close(key: string): Effect.Effect<void>
  }
>()("termy/services/TerminalHost") {
  static readonly layer = Layer.effect(
    TerminalHost,
    Effect.gen(function* () {
      const daemon = yield* Daemon
      const routes = new Map<string, Route>()

      yield* daemon.on("shell.output", (data) => {
        const event = decodeOutput(data)
        if (event._tag === "Some") routes.get(event.value.key)?.output(bytesOf(event.value.data))
      })
      yield* daemon.on("shell.exit", (data) => {
        const event = decodeExit(data)
        if (event._tag === "Some") routes.get(event.value.key)?.exit()
      })

      const open = Effect.fn("TerminalHost.open")(function* (options: {
        key: string
        cwd: string
        cols: number
        rows: number
        onOutput: (bytes: Uint8Array) => void
        onExit: () => void
      }) {
        const { key } = options
        // Live output can beat the reply, so hold it until the scrollback is written.
        const early: Array<(route: Route) => void> = []
        routes.set(key, {
          output: (bytes) => early.push((route) => route.output(bytes)),
          exit: () => early.push((route) => route.exit()),
        })
        const opened = yield* daemon
          .request("shell.open", { key, cwd: options.cwd, cols: options.cols, rows: options.rows }, Opened)
          .pipe(Effect.tapError(() => Effect.sync(() => routes.delete(key))))

        const route: Route = { output: options.onOutput, exit: options.onExit }
        if (opened.scrollback) route.output(bytesOf(opened.scrollback))
        routes.set(key, route)
        for (const replay of early) replay(route)
        if (opened.exited) route.exit()
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (routes.get(key) === route) routes.delete(key)
            yield* daemon.request("shell.detach", { key }, Schema.Unknown).pipe(Effect.ignore)
          }),
        )

        return {
          write: (data) => daemon.request("shell.write", { key, data }, Schema.Unknown).pipe(Effect.asVoid),
          resize: (cols, rows) =>
            daemon.request("shell.resize", { key, cols, rows }, Schema.Unknown).pipe(Effect.asVoid),
        } satisfies TerminalSession
      })

      return TerminalHost.of({
        open,
        close: (key) => daemon.request("shell.close", { key }, Schema.Unknown).pipe(Effect.ignore),
      })
    }),
  ).pipe(Layer.provide(Daemon.layer))
}
