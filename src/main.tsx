import { createRouter, RouterProvider } from "@tanstack/react-router"
import { Effect } from "effect"
import React from "react"
import ReactDOM from "react-dom/client"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { runtime, WorkspaceProvider } from "@/lib/runtime"
import { applySettings, getSettings } from "@/lib/settings"
import { Workspace } from "@/services/Workspace"
import { routeTree } from "./routeTree.gen"
import "./index.css"

const router = createRouter({ routeTree, defaultPreload: false })

/** Reopening the app comes back to the thread, terminal or page it was on. */
const LOCATION_KEY = "termy.location"
try {
  const saved = localStorage.getItem(LOCATION_KEY)
  if (saved && saved !== "/") router.history.replace(saved)
} catch {
  // Starts on the new-thread page.
}
router.subscribe("onResolved", ({ toLocation }) => {
  try {
    localStorage.setItem(LOCATION_KEY, toLocation.href)
  } catch {
    // Starts on the new-thread page next time.
  }
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

window.addEventListener("beforeunload", () => void runtime.dispose())

// Fonts, size and glass apply before the first paint.
applySettings(getSettings())

void runtime
  .runPromise(Effect.gen(function* () {
    return yield* Workspace
  }))
  .then((workspace) =>
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <WorkspaceProvider workspace={workspace}>
          <TooltipProvider delay={300}>
            <RouterProvider router={router} />
            <Toaster position="bottom-right" />
          </TooltipProvider>
        </WorkspaceProvider>
      </React.StrictMode>,
    ),
  )
