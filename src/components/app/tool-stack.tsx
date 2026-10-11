import { ChevronRightIcon } from "@heroicons/react/24/outline"
import { useState } from "react"
import { Shimmer } from "@/components/shimmer/components/shimmer"
import { collectChanges, totals } from "@/domain/changes"
import { isRunning, outputOf, relativePath, summarize, terminalOf, type ToolItem, verbFor } from "@/domain/timeline"
import { useWorkspaceState } from "@/lib/runtime"
import { cn } from "@/lib/utils"
import { Diffstat, Led } from "./primitives"

const LIVE_TAIL_LINES = 3

const SpineDot = () => (
  <span className="flex size-[13px] shrink-0 items-center justify-center">
    <span className="bg-bg size-[7px] rounded-full shadow-[0_0_0_1.5px_var(--text-3)]" />
  </span>
)

/** Output for a tool: its agent terminal when it ran in one, otherwise its text content. */
const useToolOutput = (tool: ToolItem) => {
  const terminalId = terminalOf(tool)
  const terminal = useWorkspaceState((state) => (terminalId ? state.terminals[terminalId] : undefined))
  return { text: terminal?.text ?? outputOf(tool), exitCode: terminal?.exited ? terminal.exitCode : null }
}

const OutputTail = ({ text, lines, className }: { text: string; lines: number; className?: string }) => {
  const tail = text.trimEnd().split("\n").slice(-lines).filter(Boolean)
  if (tail.length === 0) return null
  return (
    <div
      className={cn(
        "flex flex-col rounded-lg bg-white/[0.025] px-3 py-2.5 shadow-hairline",
        className,
      )}
    >
      {tail.map((line, index) => (
        <span
          key={index}
          className={cn(
            "selectable truncate text-xs leading-[18px] whitespace-pre",
            index === tail.length - 1 ? "text-text-2" : "text-text-3",
          )}
        >
          {line}
        </span>
      ))}
    </div>
  )
}

const ToolRow = ({ tool, cwd }: { tool: ToolItem; cwd: string }) => {
  const change = totals(collectChanges([tool]))
  const path = tool.locations[0]?.path
  const output = useToolOutput(tool)
  const showOutput = tool.kind === "execute" && output.text.trim().length > 0
  return (
    <div className="flex flex-col gap-1.5 pb-1">
      <div className="flex h-7 items-center gap-2.5 pl-[3px]">
        <span className="text-text-2 shrink-0 text-ui">{verbFor(tool, false)}</span>
        <span className="text-text min-w-0 truncate text-xs">
          {path && (tool.kind === "read" || tool.kind === "edit") ? relativePath(path, cwd) : tool.title}
        </span>
        <span className="flex-1" />
        {tool.status === "failed" ? (
          <span className="text-remove shrink-0 text-2xs tabular-nums">
            {output.exitCode !== null ? `exit ${output.exitCode}` : "failed"}
          </span>
        ) : (
          <Diffstat additions={change.additions} deletions={change.deletions} />
        )}
      </div>
      {showOutput && <OutputTail text={output.text} lines={8} className="ml-[3px]" />}
    </div>
  )
}

const Summary = ({
  tools,
  open,
  onToggle,
}: {
  tools: ReadonlyArray<ToolItem>
  open: boolean
  onToggle: () => void
}) => {
  const parts = summarize(tools)
  const failed = tools.filter((tool) => tool.status === "failed").length
  const change = totals(collectChanges(tools))
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="group/summary flex h-[30px] min-w-0 flex-1 items-center gap-1.5 text-left"
    >
      {parts.map((part, index) => (
        <span key={index} className="flex shrink-0 items-center gap-1.5 text-ui">
          <span className={index === 0 ? "text-text-2" : "text-text-3"}>{part.lead}</span>
          {part.object && <span className={index === 0 ? "text-text" : "text-text-3"}>{part.object}</span>}
        </span>
      ))}
      {failed > 0 && <span className="text-remove shrink-0 text-ui">, {failed} failed</span>}
      <ChevronRightIcon
        className={cn(
          "text-text-3 group-hover/summary:text-text-2 size-3.5 shrink-0 transition-transform duration-200",
          open && "rotate-90",
        )}
      />
      <span className="flex-1" />
      <Diffstat additions={change.additions} deletions={change.deletions} />
    </button>
  )
}

const LiveStep = ({ tool, cwd }: { tool: ToolItem; cwd: string }) => {
  const output = useToolOutput(tool)
  const path = tool.locations[0]?.path
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-[30px] items-center gap-3">
        <span className="flex size-[13px] shrink-0 items-center justify-center">
          <Led className="size-[7px]" />
        </span>
        <Shimmer
          className="text-amber shrink-0 text-ui font-medium"
          style={{ "--shimmer-highlight": "#fff3d6" } as React.CSSProperties}
        >
          {verbFor(tool, true)}
        </Shimmer>
        <span className="text-text min-w-0 truncate text-xs">
          {path && tool.kind !== "execute" ? relativePath(path, cwd) : tool.title}
        </span>
      </div>
      <OutputTail text={output.text} lines={LIVE_TAIL_LINES} className="ml-[25px]" />
    </div>
  )
}

/**
 * Consecutive tool calls, collapsed to one line of text by default. While the
 * agent is mid-step, the finished part stays collapsed and a fuse runs from it
 * into the live step.
 */
export const ToolStack = ({ tools, live, cwd }: { tools: ReadonlyArray<ToolItem>; live: boolean; cwd: string }) => {
  const [open, setOpen] = useState(false)
  const running = live ? tools.filter(isRunning) : []
  const current = running.at(-1)
  const done = current ? tools.filter((tool) => tool !== current) : tools

  const details = open && (
    <div className="animate-in fade-in-0 slide-in-from-top-1 flex flex-col duration-200">
      {done.map((tool) => (
        <ToolRow key={tool.id} tool={tool} cwd={cwd} />
      ))}
    </div>
  )

  if (!current) {
    return (
      <div className="flex flex-col">
        <Summary tools={done} open={open} onToggle={() => setOpen(!open)} />
        {details}
      </div>
    )
  }

  if (done.length === 0) return <LiveStep tool={current} cwd={cwd} />

  return (
    <div className="flex flex-col gap-3">
      <div className="relative flex flex-col">
        {/* The fuse: from the finished steps into the live one. */}
        <span
          aria-hidden
          className="absolute top-[21px] -bottom-[23px] left-[6px] w-px bg-linear-to-b from-[var(--line)] from-60% to-[var(--amber)]"
        />
        <div className="flex items-center gap-3">
          <SpineDot />
          <Summary tools={done} open={open} onToggle={() => setOpen(!open)} />
        </div>
        {open && <div className="pl-[25px]">{details}</div>}
      </div>
      <LiveStep tool={current} cwd={cwd} />
    </div>
  )
}
