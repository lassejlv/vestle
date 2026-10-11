import type { DownloadEvent } from "@tauri-apps/plugin-updater"

export interface UpdateHandle {
  version: string
  download(onEvent: (event: DownloadEvent) => void, options: { timeout: number }): Promise<void>
  install(): Promise<void>
  close(): Promise<void>
}

export type UpdateState = {
  phase: "disabled" | "idle" | "checking" | "downloading" | "ready" | "installing" | "restart" | "error"
  version?: string
  progress?: number
  message?: string
  checkedAt?: number
}

const CHECK_INTERVAL = 4 * 60 * 60 * 1000

/** One update operation at a time, shared by the background check and Settings. */
export class UpdateController {
  private state: UpdateState = { phase: "disabled" }
  private listeners = new Set<() => void>()
  private update: UpdateHandle | null = null
  private lastAttempt = 0

  constructor(private readonly adapter: {
    check(): Promise<UpdateHandle | null>
    relaunch(): Promise<void>
  }) {}

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private set(state: UpdateState) {
    this.state = state
    this.listeners.forEach((listener) => listener())
  }

  enable() {
    if (this.state.phase === "disabled") this.set({ phase: "idle" })
  }

  check = async (automatic = false) => {
    if (!["idle", "error"].includes(this.state.phase)) return
    if (automatic && Date.now() - this.lastAttempt < CHECK_INTERVAL) return
    this.lastAttempt = Date.now()
    this.set({ phase: "checking" })
    let candidate: UpdateHandle | null = null
    try {
      candidate = await this.adapter.check()
      if (!candidate) {
        this.set({ phase: "idle", checkedAt: Date.now() })
        return
      }
      const version = candidate.version
      this.set({ phase: "downloading", version })
      let received = 0
      let total: number | undefined
      await candidate.download((event) => {
        if (event.event === "Started") total = event.data.contentLength
        if (event.event === "Progress") received += event.data.chunkLength
        this.set({ phase: "downloading", version, progress: total ? Math.min(100, Math.round(received / total * 100)) : undefined })
      }, { timeout: 10 * 60 * 1000 })
      // Finished means the network transfer ended; only the resolved promise proves
      // the updater verified the signature and the signed version.
      this.update = candidate
      this.set({ phase: "ready", version })
    } catch {
      await candidate?.close().catch(() => {})
      this.set({
        phase: "error",
        message: candidate
          ? "The update could not be downloaded or verified. Try again."
          : "Could not check for updates. Check your connection or try again later.",
      })
    }
  }

  restart = async () => {
    const { phase, version } = this.state
    if (phase !== "ready" && phase !== "restart") return
    this.set({ phase: "installing", version })
    if (phase === "ready") {
      try {
        await this.update!.install()
      } catch {
        this.set({ phase: "ready", version, message: "Could not install the update. Move the app to Applications if it is on a disk image, then try again." })
        return
      }
      await this.update?.close().catch(() => {})
      this.update = null
    }
    try {
      await this.adapter.relaunch()
    } catch {
      // The package is already installed. Retrying must only restart, never reinstall.
      this.set({ phase: "restart", version, message: "The update is installed. Quit and reopen Termy Code, or try restarting again." })
    }
  }
}
