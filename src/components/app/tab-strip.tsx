import { useNavigate, useParams, useRouterState } from "@tanstack/react-router"
import { Cog6ToothIcon, CommandLineIcon, PencilSquareIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline"
import { useEffect } from "react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useRun, useWorkspace, useWorkspaceState } from "@/lib/runtime"
import { cn } from "@/lib/utils"
import type { Tab } from "@/services/Workspace"
import { Kbd } from "./primitives"
import { AgentSlot } from "./sidebar"

/** Open threads and terminals as tabs above the main area. ⌘1–9 jumps to a tab, ⌃Tab cycles. */
export const TabStrip = () => {
  const workspace = useWorkspace()
  const run = useRun()
  const navigate = useNavigate()
  const tabs = useWorkspaceState((state) => state.tabs)
  const threads = useWorkspaceState((state) => state.threads)
  const sessions = useWorkspaceState((state) => state.sessions)
  const projects = useWorkspaceState((state) => state.projects)
  const { threadId, terminalId } = useParams({ strict: false })
  const activeId = threadId ?? terminalId
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  // Screens that aren't tabs still get a marker in the strip, so it shows where you are.
  const screen =
    pathname === "/"
      ? { icon: PencilSquareIcon, title: "New thread" }
      : pathname === "/settings"
        ? { icon: Cog6ToothIcon, title: "Settings" }
        : null

  const go = (tab: Tab | undefined) =>
    void (tab?._tag === "Thread"
      ? navigate({ to: "/thread/$threadId", params: { threadId: tab.id } })
      : tab?._tag === "Terminal"
        ? navigate({
            to: "/terminal/$terminalId",
            params: { terminalId: tab.id },
          })
        : navigate({ to: "/" }))

  const close = async (tab: Tab) => {
    if (tab.id === activeId) {
      const index = tabs.indexOf(tab)
      go(tabs[index + 1] ?? tabs[index - 1])
    }
    await run(workspace.closeTab(tab.id))
  }

  const openTerminal = async (cwd: string, title: string) => {
    const id = await run(workspace.openTerminal(cwd, title))
    if (id)
      await navigate({
        to: "/terminal/$terminalId",
        params: { terminalId: id },
      })
  }

  // New terminals open in the folder you're looking at, listed first.
  const activeTab = tabs.find((tab) => tab.id === activeId)
  const currentCwd = activeTab?._tag === "Terminal" ? activeTab.cwd : threadId ? sessions[threadId]?.cwd : undefined
  const terminalProjects = [...projects].sort((a, b) => Number(b.path === currentCwd) - Number(a.path === currentCwd))

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && !event.shiftKey && !event.altKey && /^[1-9]$/.test(event.key)) {
        const tab = event.key === "9" ? tabs.at(-1) : tabs[Number(event.key) - 1]
        if (!tab) return
        event.preventDefault()
        go(tab)
      } else if (event.ctrlKey && event.key === "Tab" && tabs.length > 1) {
        event.preventDefault()
        const index = tabs.findIndex((tab) => tab.id === activeId)
        const step = event.shiftKey ? -1 : 1
        go(tabs[(index + step + tabs.length) % tabs.length])
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  return (
    <div data-tauri-drag-region className="flex h-10 shrink-0 items-center gap-1 pb-2">
      {tabs.map((tab) => {
        const active = tab.id === activeId
        const session = tab._tag === "Thread" ? sessions[tab.id] : undefined
        const thread = tab._tag === "Thread" ? threads.find((candidate) => candidate.id === tab.id) : undefined
        const agentId = session?.agentId ?? thread?.agentId
        if (tab._tag === "Thread" && !agentId) return null
        return (
          <div
            key={tab.id}
            className={cn(
              "group/thread flex h-[30px] max-w-[200px] min-w-[96px] flex-1 basis-0 items-center rounded-lg transition-colors",
              active
                ? "bg-raised shadow-raised"
                : "hover:bg-hover/60",
            )}
          >
            <button
              type="button"
              onClick={() => go(tab)}
              onAuxClick={(event) => event.button === 1 && void close(tab)}
              className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2.5"
            >
              {tab._tag === "Terminal" ? (
                <CommandLineIcon
                  className={cn("size-3.5 shrink-0", active ? "text-text" : "text-text-3")}
                  strokeWidth={1.6}
                />
              ) : (
                <AgentSlot agent={agentId!} status={session?.status} dim={!active && session?.status !== "working"} />
              )}
              <span className={cn("min-w-0 truncate text-xs", active ? "text-text font-medium" : "text-text-2")}>
                {tab._tag === "Terminal" ? tab.title : (session?.title ?? thread?.title)}
              </span>
            </button>
            <button
              type="button"
              aria-label="Close tab"
              onClick={() => void close(tab)}
              className={cn(
                "text-text-3 hover:text-text hover:bg-hover mr-1 flex size-5 shrink-0 items-center justify-center rounded-md",
                !active && "opacity-0 group-hover/thread:opacity-100",
              )}
            >
              <XMarkIcon className="size-3" />
            </button>
          </div>
        )
      })}
      {screen && (
        <div className="bg-raised shadow-raised flex h-[30px] max-w-[200px] min-w-[96px] flex-1 basis-0 items-center gap-2 rounded-lg px-2.5">
          <screen.icon className="text-text size-3.5 shrink-0" strokeWidth={1.6} />
          <span className="text-text min-w-0 truncate text-xs font-medium">{screen.title}</span>
        </div>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="New tab"
          className="text-text-3 hover:text-text hover:bg-hover/60 aria-expanded:bg-hover/60 flex size-[30px] shrink-0 items-center justify-center rounded-lg"
        >
          <PlusIcon className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-auto min-w-52 rounded-xl p-1">
          <DropdownMenuItem onClick={() => go(undefined)} className="h-8 gap-2.5 rounded-lg text-xs">
            <PencilSquareIcon />
            <span className="flex-1">New thread</span>
            <Kbd>⌘N</Kbd>
          </DropdownMenuItem>
          {terminalProjects.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-text-3 px-2 py-1 text-2xs font-normal">
                  New terminal
                </DropdownMenuLabel>
                {terminalProjects.map((project) => (
                  <DropdownMenuItem
                    key={project.id}
                    title={project.path}
                    onClick={() => void openTerminal(project.path, project.name)}
                    className="h-8 gap-2.5 rounded-lg text-xs"
                  >
                    <CommandLineIcon />
                    <span className="truncate">{project.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
