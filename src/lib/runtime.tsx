import { Cause, Effect, Exit, Layer, ManagedRuntime, Stream, SubscriptionRef } from "effect"
import { createContext, type ReactNode, useCallback, useContext, useSyncExternalStore } from "react"
import { toast } from "sonner"
import { TerminalHost } from "@/services/TerminalHost"
import { Workspace, type WorkspaceState } from "@/services/Workspace"

export const runtime = ManagedRuntime.make(Layer.mergeAll(Workspace.layer, TerminalHost.layer))

type WorkspaceService = Workspace["Service"]

const WorkspaceContext = createContext<WorkspaceService | null>(null)

export const WorkspaceProvider = ({ workspace, children }: { workspace: WorkspaceService; children: ReactNode }) => (
  <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>
)

export const useWorkspace = () => {
  const workspace = useContext(WorkspaceContext)
  if (!workspace) throw new Error("useWorkspace must be used inside <WorkspaceProvider>")
  return workspace
}

/** Subscribes to a slice of workspace state. Return stable references from `select`. */
export const useWorkspaceState = <A,>(select: (state: WorkspaceState) => A): A => {
  const { state } = useWorkspace()
  const subscribe = useCallback(
    (onChange: () => void) =>
      runtime.runCallback(
        Stream.runForEach(SubscriptionRef.changes(state), () => Effect.sync(onChange)),
      ),
    [state],
  )
  return useSyncExternalStore(subscribe, () => select(state.value))
}

/**
 * Runs a workspace effect from an event handler. Failures surface as a toast,
 * since every error in the workspace carries a user-facing message.
 */
export const useRun = () =>
  useCallback(
    <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E, Workspace | TerminalHost>) =>
      runtime.runPromiseExit(effect).then((exit) => {
        if (Exit.isSuccess(exit)) return exit.value
        const error = Cause.findErrorOption(exit.cause)
        if (error._tag === "Some") toast.error(error.value.message)
        else if (!Cause.hasInterruptsOnly(exit.cause)) toast.error("Something went wrong.")
        return undefined
      }),
    [],
  )
