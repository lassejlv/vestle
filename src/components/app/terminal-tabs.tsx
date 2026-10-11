import { useParams } from "@tanstack/react-router"
import { useState } from "react"
import { useRun, useWorkspace, useWorkspaceState } from "@/lib/runtime"
import { cn } from "@/lib/utils"
import { TerminalView } from "./terminal-view"

/**
 * Every terminal tab, kept mounted so switching away doesn't kill its shell.
 * Only the one on the current route shows. A tab's shell starts the first time it's shown.
 */
export const TerminalTabs = () => {
  const workspace = useWorkspace()
  const run = useRun()
  const tabs = useWorkspaceState((state) => state.tabs)
  const { terminalId } = useParams({ strict: false })
  const [started, setStarted] = useState<ReadonlySet<string>>(() => new Set())

  if (terminalId && !started.has(terminalId) && tabs.some((tab) => tab.id === terminalId)) {
    setStarted(new Set([...started, terminalId]))
  }

  return tabs.map((tab) => {
    if (tab._tag !== "Terminal" || !started.has(tab.id)) return null
    const active = tab.id === terminalId
    return (
      <section
        key={tab.id}
        className={cn("surface min-w-0 flex-1 flex-col overflow-hidden rounded-xl", active ? "flex" : "hidden")}
      >
        {/* No header: the tab already names the terminal, so the shell gets the whole panel. */}
        <TerminalView
          className="p-3"
          shellKey={tab.id}
          cwd={tab.cwd}
          active={active}
          onTitleChange={(title) => title && void run(workspace.setTerminalTitle(tab.id, title))}
        />
      </section>
    )
  })
}
