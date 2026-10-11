import { ShareIcon } from "@heroicons/react/24/outline"
import { useEffect, useState } from "react"
import { useRun, useWorkspace } from "@/lib/runtime"
import { AgentIcon } from "./agent-icon"
import { agents, type AgentId } from "@/domain/agents"

export const useGitBranch = (cwd: string | undefined) => {
  const workspace = useWorkspace()
  const run = useRun()
  const [branch, setBranch] = useState<string | null>(null)
  useEffect(() => {
    if (!cwd) return
    let current = true
    void run(workspace.gitBranch(cwd)).then((value) => current && setBranch(value ?? null))
    return () => {
      current = false
    }
  }, [cwd, run, workspace])
  return branch
}

export const BranchPill = ({ branch }: { branch: string | null }) =>
  branch ? (
    <span className="bg-raised flex h-[22px] shrink-0 items-center gap-1.5 rounded-md px-2">
      <ShareIcon className="text-text-2 size-3" />
      <span className="text-text-2 text-2xs">{branch}</span>
    </span>
  ) : null

export const ThreadHeader = ({
  title,
  cwd,
  agentId,
  children,
}: {
  title: string
  cwd: string
  agentId: AgentId
  children?: React.ReactNode
}) => {
  const branch = useGitBranch(cwd)
  return (
    <header data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-3 pr-3 pl-5">
      <span className="text-text truncate text-ui font-semibold tracking-[-0.01em]">{title}</span>
      <BranchPill branch={branch} />
      <span className="flex-1" />
      <span className="flex h-[26px] items-center gap-1.5 rounded-[7px] px-2.5 shadow-[0_0_0_1px_var(--line)]">
        <AgentIcon agent={agentId} className="text-text size-3.5" />
        <span className="text-text-2 text-xs">{agents[agentId].name}</span>
      </span>
      {children}
    </header>
  )
}
