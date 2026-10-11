import { useNavigate } from "@tanstack/react-router"
import { Square2StackIcon } from "@heroicons/react/24/outline"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { type AgentId, agentList } from "@/domain/agents"
import { useRun, useWorkspace } from "@/lib/runtime"
import { cn } from "@/lib/utils"
import { AgentIcon } from "./agent-icon"

/**
 * Forks a thread into a new one, with the same agent or handed off to another.
 * `upTo` forks only the conversation up to that item.
 */
export const ForkMenu = ({
  threadId,
  agentId,
  upTo,
  compact,
  disabled,
}: {
  threadId: string
  agentId: AgentId
  upTo?: string
  /** An icon button, for message actions. */
  compact?: boolean
  disabled?: boolean
}) => {
  const workspace = useWorkspace()
  const run = useRun()
  const navigate = useNavigate()

  const fork = async (target: AgentId) => {
    const id = await run(workspace.fork(threadId, target, upTo))
    if (id) await navigate({ to: "/thread/$threadId", params: { threadId: id } })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={upTo ? "Fork from here" : "Fork thread"}
        title={upTo ? "Fork from here" : undefined}
        className={cn(
          "text-text-2 hover:text-text aria-expanded:text-text flex items-center transition-colors disabled:pointer-events-none disabled:opacity-40",
          compact
            ? "text-text-3 hover:bg-hover size-7 justify-center rounded-lg [&_svg]:size-3.5"
            : "h-[26px] gap-1.5 rounded-[7px] px-2.5 text-xs hover:bg-white/5 aria-expanded:bg-white/5",
        )}
      >
        <Square2StackIcon className="size-3.5" />
        {!compact && "Fork"}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={compact ? "start" : "end"} className="w-auto min-w-48 rounded-xl p-1">
        {agentList.map((agent) => (
          <DropdownMenuItem key={agent.id} onClick={() => void fork(agent.id)} className="h-8 gap-2.5 rounded-lg text-xs">
            <AgentIcon agent={agent.id} className="text-text size-3.5" />
            {agent.id === agentId ? `Fork with ${agent.name}` : `Hand off to ${agent.name}`}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
