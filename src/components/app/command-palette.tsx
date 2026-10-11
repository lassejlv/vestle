import { useNavigate } from "@tanstack/react-router"
import { FolderPlusIcon, MagnifyingGlassIcon, PencilSquareIcon } from "@heroicons/react/24/outline"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import type { AgentId } from "@/domain/agents"
import { useRun, useWorkspace, useWorkspaceState } from "@/lib/runtime"
import { cn } from "@/lib/utils"
import type { SearchHit } from "@/services/Database"
import { AgentIcon } from "./agent-icon"
import { Kbd, relativeTime } from "./primitives"

const SEARCH_DEBOUNCE_MS = 120
const RECENT_LIMIT = 8

interface Entry {
  readonly key: string
  readonly icon: ReactNode
  readonly title: string
  readonly detail?: string | null
  readonly meta?: string
  readonly run: () => void
}

/** Wraps case-insensitive matches of `query` in the accent colour. */
const Highlight = ({ text, query }: { text: string; query: string }) => {
  const needle = query.trim().toLowerCase()
  if (!needle) return <>{text}</>
  const parts: Array<ReactNode> = []
  const haystack = text.toLowerCase()
  let from = 0
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, from)) {
    parts.push(
      text.slice(from, index),
      <mark key={index} className="text-amber bg-transparent">
        {text.slice(index, index + needle.length)}
      </mark>,
    )
    from = index + needle.length
  }
  parts.push(text.slice(from))
  return <>{parts}</>
}

export const CommandPalette = ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
  const workspace = useWorkspace()
  const run = useRun()
  const navigate = useNavigate()
  const threads = useWorkspaceState((state) => state.threads)
  const projects = useWorkspaceState((state) => state.projects)
  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<ReadonlyArray<SearchHit>>([])
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      setQuery("")
      setHits([])
    }
  }, [open])

  useEffect(() => {
    const text = query.trim()
    if (!text) return setHits([])
    let current = true
    const timer = window.setTimeout(() => {
      void run(workspace.searchThreads(text)).then((found) => current && setHits(found ?? []))
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [query, run, workspace])

  const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? ""
  const close = () => onOpenChange(false)
  const openThread = (id: string) => {
    close()
    void navigate({ to: "/thread/$threadId", params: { threadId: id } })
  }
  const threadEntry = (
    thread: { id: string; title: string; projectId: string; agentId: AgentId; updatedAt: number },
    detail?: string | null,
  ): Entry => ({
    key: thread.id,
    icon: <AgentIcon agent={thread.agentId} className="text-text-2 size-3.5" />,
    title: thread.title,
    detail: detail ?? projectName(thread.projectId),
    meta: relativeTime(thread.updatedAt),
    run: () => openThread(thread.id),
  })

  const sections: ReadonlyArray<{ label: string; entries: ReadonlyArray<Entry> }> = query.trim()
    ? [
        {
          label: hits.length > 0 ? "Threads" : "No threads match",
          entries: hits.map((hit) => threadEntry(hit, hit.snippet)),
        },
      ]
    : [
        { label: "Recent", entries: threads.slice(0, RECENT_LIMIT).map((thread) => threadEntry(thread)) },
        {
          label: "Actions",
          entries: [
            {
              key: "new-thread",
              icon: <PencilSquareIcon className="text-text-2 size-3.5" />,
              title: "New thread",
              meta: "⌘N",
              run: () => {
                close()
                void navigate({ to: "/" })
              },
            },
            {
              key: "add-project",
              icon: <FolderPlusIcon className="text-text-2 size-3.5" />,
              title: "Add project",
              run: () => {
                close()
                void run(workspace.addProject()).then(
                  (project) => project && void navigate({ to: "/", search: { project: project.id } }),
                )
              },
            },
          ],
        },
      ]

  const entries = sections.flatMap((section) => section.entries)

  useEffect(() => setActive(0), [query, hits])
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  let index = -1
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[18%] max-w-[560px] translate-y-0 gap-0 overflow-hidden rounded-2xl bg-popover p-0 shadow-dialog ring-0 sm:max-w-[560px]"
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <div className="flex h-12 items-center gap-2.5 border-b border-white/6 px-4">
          <MagnifyingGlassIcon className="text-text-3 size-4 shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault()
                setActive((current) => Math.min(current + 1, entries.length - 1))
              } else if (event.key === "ArrowUp") {
                event.preventDefault()
                setActive((current) => Math.max(current - 1, 0))
              } else if (event.key === "Enter") {
                event.preventDefault()
                entries[active]?.run()
              }
            }}
            placeholder="Search threads"
            className="text-text placeholder:text-text-3 flex-1 bg-transparent text-sm outline-none"
          />
          <Kbd>esc</Kbd>
        </div>
        <div ref={list} className="flex max-h-[min(420px,60vh)] flex-col overflow-y-auto p-1.5">
          {sections.map((section) => (
            <div key={section.label} className="flex flex-col pb-1">
              <span className="text-text-3 px-2.5 pt-2 pb-1.5 text-2xs font-medium">{section.label}</span>
              {section.entries.map((entry) => {
                index += 1
                const position = index
                return (
                  <button
                    key={entry.key}
                    type="button"
                    data-index={position}
                    onMouseMove={() => setActive(position)}
                    onClick={entry.run}
                    className={cn(
                      "flex min-h-9 items-center gap-3 rounded-lg px-2.5 py-1.5 text-left",
                      position === active && "bg-hover",
                    )}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center">{entry.icon}</span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-text truncate text-ui">
                        <Highlight text={entry.title} query={query} />
                      </span>
                      {entry.detail && (
                        <span className="text-text-3 truncate text-xs">
                          <Highlight text={entry.detail} query={query} />
                        </span>
                      )}
                    </span>
                    {entry.meta && <span className="text-text-3 shrink-0 text-2xs tabular-nums">{entry.meta}</span>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
