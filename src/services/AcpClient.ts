import * as acp from "@agentclientprotocol/sdk"
import { Context, Effect, Layer, Schema, type Scope } from "effect"
import type { Mention } from "@/domain/mentions"
import type { ImageAttachment } from "@/domain/session"
import type { AgentProcess } from "./AgentHost"

export class AcpError extends Schema.TaggedError<AcpError>()("AcpError", {
  method: Schema.String,
  code: Schema.Number,
  message: Schema.String,
}) {
  /** ACP's `auth_required` error code. */
  get needsAuth() {
    return this.code === -32000
  }
}

const toAcpError = (method: string) => (cause: unknown) =>
  cause instanceof acp.RequestError
    ? new AcpError({ method, code: cause.code, message: cause.message })
    : new AcpError({ method, code: -1, message: cause instanceof Error ? cause.message : String(cause) })

/** What the client does when the agent talks to it. */
export interface ClientHandlers {
  readonly onUpdate: (notification: acp.SessionNotification) => Effect.Effect<void>
  readonly onPermission: (request: acp.RequestPermissionRequest) => Effect.Effect<acp.RequestPermissionResponse>
  /** Vendor extension requests. `null` means the method isn't supported. */
  readonly onExtension: (method: string, params: Record<string, unknown>) => Effect.Effect<Record<string, unknown> | null>
  readonly onExtensionNotification: (method: string, params: Record<string, unknown>) => Effect.Effect<void>
  /** The daemon's record that a prompt finished, sent in order with the agent's updates. */
  readonly onTurnEnd: (end: TurnEnd) => Effect.Effect<void>
}

/** `_termy/turn_end`: how a `session/prompt` ended, whether or not a window was watching. */
export interface TurnEnd {
  readonly stopReason: acp.StopReason | null
  readonly error: { readonly message: string } | null
}

const TURN_END = "_termy/turn_end"

export interface Prompt {
  readonly text: string
  readonly images: ReadonlyArray<ImageAttachment>
  readonly mentions: ReadonlyArray<Mention>
  /** Sent ahead of the text, e.g. the history of a handed-off thread. */
  readonly context?: string
}

const toContentBlocks = (prompt: Prompt): Array<acp.ContentBlock> => [
  ...(prompt.context ? [{ type: "text" as const, text: prompt.context }] : []),
  ...(prompt.text ? [{ type: "text" as const, text: prompt.text }] : []),
  ...prompt.images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
  // Every ACP agent accepts resource links; they arrive as file links the model can open.
  ...prompt.mentions.map((mention) => ({
    type: "resource_link" as const,
    name: mention.name,
    uri: `file://${encodeURI(mention.path)}`,
  })),
]

export interface AcpConnection {
  readonly info: acp.InitializeResponse
  readonly canResume: boolean
  readonly canLoad: boolean
  readonly canFork: boolean
  newSession(cwd: string): Effect.Effect<acp.NewSessionResponse, AcpError>
  resumeSession(sessionId: string, cwd: string): Effect.Effect<acp.ResumeSessionResponse, AcpError>
  loadSession(sessionId: string, cwd: string): Effect.Effect<acp.LoadSessionResponse, AcpError>
  forkSession(sessionId: string, cwd: string): Effect.Effect<acp.ForkSessionResponse, AcpError>
  authenticate(methodId: string): Effect.Effect<void, AcpError>
  prompt(sessionId: string, prompt: Prompt): Effect.Effect<acp.PromptResponse, AcpError>
  cancel(sessionId: string): Effect.Effect<void, AcpError>
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Effect.Effect<ReadonlyArray<acp.SessionConfigOption>, AcpError>
  setMode(sessionId: string, modeId: string): Effect.Effect<void, AcpError>
}

export class AcpClient extends Context.Service<
  AcpClient,
  {
    /**
     * Speaks ACP over the agent's stream. An agent that was already running (attached
     * from the daemon) has done its handshake, so its saved `initialize` result is reused.
     * File and terminal requests never get here: the daemon answers them.
     */
    connect(process: AgentProcess, handlers: ClientHandlers): Effect.Effect<AcpConnection, AcpError, Scope.Scope>
  }
>()("termy/services/AcpClient") {
  static readonly layer = Layer.effect(
    AcpClient,
    Effect.gen(function* () {
      const connect = Effect.fn("AcpClient.connect")(function* (process: AgentProcess, handlers: ClientHandlers) {
        const context = yield* Effect.context<never>()
        const run = Effect.runPromiseWith(context)

        const client: acp.Client = {
          sessionUpdate: (params) => run(handlers.onUpdate(params)),
          requestPermission: (params) => run(handlers.onPermission(params)),
          extMethod: (method, params) =>
            run(handlers.onExtension(method, params)).then((result) => {
              if (result === null) throw acp.RequestError.methodNotFound(method)
              return result
            }),
          extNotification: (method, params) =>
            run(
              method === TURN_END
                ? handlers.onTurnEnd({
                    stopReason: (params.stopReason as acp.StopReason | null | undefined) ?? null,
                    error: (params.error as TurnEnd["error"] | undefined) ?? null,
                  })
                : handlers.onExtensionNotification(method, params),
            ),
        }

        const connection = new acp.ClientSideConnection(() => client, process.stream)
        const call = <A>(method: string, request: () => Promise<A>) =>
          Effect.tryPromise({ try: request, catch: toAcpError(method) })

        const handshake = process.summary.initialize as acp.InitializeResponse | null
        const info =
          handshake ??
          (yield* call("initialize", () =>
            connection.initialize({
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
              clientInfo: { name: "termy-code", title: "Termy Code", version: "0.1.0" },
            }),
          ))

        return {
          info,
          canResume: Boolean(info.agentCapabilities?.sessionCapabilities?.resume),
          canLoad: Boolean(info.agentCapabilities?.loadSession),
          canFork: Boolean(info.agentCapabilities?.sessionCapabilities?.fork),
          newSession: (cwd) => call("session/new", () => connection.newSession({ cwd, mcpServers: [] })),
          resumeSession: (sessionId, cwd) =>
            call("session/resume", () => connection.resumeSession({ sessionId, cwd, mcpServers: [] })),
          loadSession: (sessionId, cwd) =>
            call("session/load", () => connection.loadSession({ sessionId, cwd, mcpServers: [] })),
          forkSession: (sessionId, cwd) =>
            call("session/fork", () => connection.unstable_forkSession({ sessionId, cwd, mcpServers: [] })),
          authenticate: (methodId) => call("authenticate", () => connection.authenticate({ methodId })).pipe(Effect.asVoid),
          prompt: (sessionId, prompt) =>
            call("session/prompt", () => connection.prompt({ sessionId, prompt: toContentBlocks(prompt) })),
          cancel: (sessionId) => call("session/cancel", () => connection.cancel({ sessionId })),
          setConfigOption: (sessionId, configId, value) =>
            call("session/set_config_option", () =>
              connection.setSessionConfigOption({ sessionId, configId, value }),
            ).pipe(Effect.map((response) => response.configOptions)),
          setMode: (sessionId, modeId) =>
            call("session/set_mode", () => connection.setSessionMode({ sessionId, modeId })).pipe(Effect.asVoid),
        } satisfies AcpConnection
      })

      return AcpClient.of({ connect })
    }),
  )
}
