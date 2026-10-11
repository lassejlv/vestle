import { isTauri, invoke } from "@tauri-apps/api/core"
import { relaunch } from "@tauri-apps/plugin-process"
import { check } from "@tauri-apps/plugin-updater"
import { useEffect, useSyncExternalStore } from "react"
import { toast } from "sonner"
import { UpdateController } from "./update-controller"

export const updates = new UpdateController({ check: () => check({ timeout: 30_000 }), relaunch })
export const useUpdateState = () => useSyncExternalStore(updates.subscribe, updates.getSnapshot)

/** Mounted once at the root; development builds never download or replace the app. */
export const useAutomaticUpdates = () => {
  useEffect(() => {
    let cancelled = false
    let cleanup = () => {}
    if (!isTauri()) return
    void invoke<boolean>("updater_enabled").then((enabled) => {
      if (cancelled || !enabled) return
      updates.enable()
      const refresh = () => { void updates.check(true) }
      let notifiedVersion: string | undefined
      const unsubscribe = updates.subscribe(() => {
        const state = updates.getSnapshot()
        if (state.phase === "ready" && state.version !== notifiedVersion) {
          notifiedVersion = state.version
          toast("An update is ready", {
            id: "app-update",
            description: `Termy Code ${state.version} is downloaded and verified.`,
            duration: Infinity,
            action: { label: "Restart to update", onClick: () => { void updates.restart() } },
          })
        }
        if (state.message && ["ready", "restart"].includes(state.phase)) {
          toast.error(state.message, { id: "app-update" })
        }
      })
      refresh()
      const timer = window.setInterval(refresh, 4 * 60 * 60 * 1000)
      window.addEventListener("focus", refresh)
      cleanup = () => {
        unsubscribe()
        window.clearInterval(timer)
        window.removeEventListener("focus", refresh)
      }
    }).catch(() => { /* A missing native updater leaves development previews usable. */ })
    return () => { cancelled = true; cleanup() }
  }, [])
}
