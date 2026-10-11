import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { CheckIcon, ChevronDownIcon, FolderOpenIcon, FolderPlusIcon } from "@heroicons/react/24/outline"
import { useEffect, useRef, useState } from "react"
import { AgentIcon } from "@/components/app/agent-icon"
import { Composer } from "@/components/app/composer"
import { useGitBranch } from "@/components/app/thread-header"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AgentId, agentList } from "@/domain/agents"
import type { Mention } from "@/domain/mentions"
import type { ImageAttachment } from "@/domain/session"
import { useRun, useWorkspace, useWorkspaceState } from "@/lib/runtime"
import { cn } from "@/lib/utils"

const Search = Schema.Struct({
  project: Schema.optional(Schema.String),
  agent: Schema.optional(AgentId),
})

const LAST_AGENT_KEY = "termy.lastAgent"

const agentNames = new Intl.ListFormat("en", { type: "conjunction" }).format(agentList.map((agent) => agent.name))

const lastAgent = (): AgentId => {
  try {
    const stored = localStorage.getItem(LAST_AGENT_KEY)
    return Schema.is(AgentId)(stored) ? stored : "claude"
  } catch {
    return "claude"
  }
}

const AgentSwitch = ({ value, onChange }: { value: AgentId; onChange: (agent: AgentId) => void }) => (
  <div className="bg-panel flex items-center gap-0.5 rounded-[10px] p-0.5 shadow-hairline">
    {agentList.map((agent) => {
      const chosen = agent.id === value
      return (
        // Only the chosen agent is named, so all six fit beside the project picker; the rest name themselves on hover.
        <Tooltip key={agent.id} disabled={chosen}>
          <TooltipTrigger
            onClick={() => onChange(agent.id)}
            aria-pressed={chosen}
            aria-label={agent.name}
            className={cn(
              "flex h-7 items-center gap-2 rounded-lg transition-[background-color,color] duration-150",
              chosen ? "bg-hover text-text px-3 shadow-segment" : "text-text-2 hover:text-text px-2",
            )}
          >
            {/* Brand color only on the chosen agent, so one colorful logo doesn't pull the eye. */}
            <AgentIcon agent={agent.id} mono={!chosen} className="size-3.5" />
            {chosen && <span className="text-xs font-medium">{agent.name}</span>}
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6} className="rounded-md px-2 py-1 text-2xs font-medium">
            {agent.name}
          </TooltipContent>
        </Tooltip>
      )
    })}
  </div>
)

const NewThread = () => {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const workspace = useWorkspace()
  const run = useRun()
  const loaded = useWorkspaceState((state) => state.loaded)
  const projects = useWorkspaceState((state) => state.projects)
  const sessions = useWorkspaceState((state) => state.sessions)

  const project = projects.find((p) => p.id === search.project) ?? projects[0]
  const [agentId, setAgentId] = useState<AgentId>(() => search.agent ?? lastAgent())
  const [draftId, setDraftId] = useState<string | null>(null)
  const sent = useRef(false)
  const branch = useGitBranch(project?.path)
  const running = Object.values(sessions).filter((session) => session.status === "working").length

  // Keep one warm draft for the chosen project and agent, so models and modes are ready before you type.
  useEffect(() => {
    if (!project) return
    let id: string | null = null
    let cancelled = false
    sent.current = false
    void run(workspace.createDraft(project.id, agentId)).then((created) => {
      if (!created) return
      if (cancelled) void run(workspace.discard(created))
      else {
        id = created
        setDraftId(created)
      }
    })
    return () => {
      cancelled = true
      setDraftId(null)
      if (id && !sent.current) void run(workspace.discard(id))
    }
  }, [project?.id, agentId, run, workspace])

  const chooseAgent = (agent: AgentId) => {
    setAgentId(agent)
    try {
      localStorage.setItem(LAST_AGENT_KEY, agent)
    } catch {
      // Only a convenience; the default is fine.
    }
  }

  const addProject = async () => {
    const added = await run(workspace.addProject())
    if (added) await navigate({ to: "/", search: { project: added.id } })
  }

  const send = (text: string, images: ReadonlyArray<ImageAttachment>, mentions: ReadonlyArray<Mention>) => {
    if (!draftId) return
    sent.current = true
    void run(workspace.send(draftId, text, images, mentions))
    void navigate({ to: "/thread/$threadId", params: { threadId: draftId } })
  }

  if (!loaded) return <section className="surface flex-1 rounded-xl" />

  if (!project) {
    return (
      <section className="surface flex flex-1 flex-col items-center justify-center gap-5 rounded-xl px-10 pb-16">
        <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-12" />
        <div className="flex flex-col items-center gap-2.5">
          <h1 className="text-text text-display leading-9 font-semibold tracking-[-0.03em]">Open a project to start</h1>
          <p className="text-text-2 text-ui">Pick a folder. {agentNames} work right inside it.</p>
        </div>
        <button
          type="button"
          onClick={() => void addProject()}
          className="bg-amber text-amber-ink flex h-9 items-center gap-2 rounded-lg px-4 text-ui font-semibold shadow-amber transition-transform active:scale-[0.98]"
        >
          <FolderPlusIcon className="size-4" />
          Add project
        </button>
      </section>
    )
  }

  const draft = draftId ? sessions[draftId] : undefined

  return (
    <section className="surface relative flex flex-1 flex-col rounded-xl">
      {/* The tab strip names this screen; the header only keeps the window draggable. */}
      <header data-tauri-drag-region className="h-12 shrink-0" />

      <div className="flex flex-1 flex-col items-center justify-center gap-7 px-10 pb-[72px]">
        <div className="flex w-full max-w-[632px] flex-col items-center gap-2.5 text-center">
          <h1 className="text-text text-display leading-9 font-semibold tracking-[-0.03em]">
            What are we building in {project.name}?
          </h1>
          <p className="text-text-2 text-ui leading-5">
            {[
              branch && `Working on ${branch}.`,
              running > 0 && `${running === 1 ? "One thread is" : `${running} threads are`} still running in the background.`,
            ]
              .filter(Boolean)
              .join(" ") || " "}
          </p>
        </div>

        <div className="flex w-full max-w-[632px] flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <DropdownMenu>
              <DropdownMenuTrigger className="text-text-2 hover:text-text aria-expanded:text-text flex h-8 items-center gap-2 rounded-lg px-2 text-xs transition-colors hover:bg-white/5">
                <FolderOpenIcon className="size-3.5" />
                <span className="font-medium">{project.name}</span>
                <ChevronDownIcon className="text-text-3 size-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-auto min-w-44 rounded-xl p-1">
                {projects.map((option) => (
                  <DropdownMenuItem
                    key={option.id}
                    title={option.path}
                    onClick={() => void navigate({ to: "/", search: { project: option.id, agent: agentId } })}
                    className="h-8 gap-2.5 rounded-lg"
                  >
                    <span className="text-text flex-1 truncate text-xs">{option.name}</span>
                    <span className="flex size-4 shrink-0 items-center">
                      {option.id === project.id && <CheckIcon className="text-amber size-3.5" />}
                    </span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void addProject()} className="h-8 gap-2.5 rounded-lg text-xs">
                  <FolderPlusIcon />
                  Add project
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <AgentSwitch value={agentId} onChange={chooseAgent} />
          </div>

          <Composer
            session={draft}
            onSend={send}
            placeholder="Describe a change, paste an error, or ask a question"
            autoFocus
          />
        </div>
      </div>
    </section>
  )
}

export const Route = createFileRoute("/")({
  validateSearch: Schema.toStandardSchemaV1(Search),
  component: NewThread,
})
