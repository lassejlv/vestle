import { CheckIcon, ChevronRightIcon } from "@heroicons/react/24/outline"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Shimmer } from "@/components/shimmer/components/shimmer"
import type { Mention } from "@/domain/mentions"
import type { ImageAttachment, Session } from "@/domain/session"
import { type Block, type Entry, toBlocks, toEntries } from "@/domain/timeline"
import { useSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"
import { Markdown } from "./markdown"
import { MessageActions } from "./message-actions"
import { agents } from "@/domain/agents"
import { AgentIcon } from "./agent-icon"
import { ForkMenu } from "./fork-menu"
import { formatElapsed, Led } from "./primitives"
import { ToolStack } from "./tool-stack"

/** Scrolling down to within this of the bottom re-attaches to new output. */
const STICK_THRESHOLD_PX = 64
/** Each frame reveals this fraction of the unrevealed text, so a big chunk eases in and a trickle keeps up. */
const REVEAL_FRACTION = 1 / 10

/**
 * Reveals streamed text at a steady pace instead of in network-sized chunks.
 * Text that was already complete on mount (history) shows at once.
 */
const useSmoothText = (text: string, live: boolean) => {
  const [shown, setShown] = useState(() => (live ? 0 : text.length))
  const caughtUp = shown >= text.length

  useEffect(() => {
    if (caughtUp) return
    let frame = requestAnimationFrame(function tick() {
      setShown((count) => {
        const backlog = text.length - count
        return backlog <= 0 ? count : count + Math.max(1, Math.ceil(backlog * REVEAL_FRACTION))
      })
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [caughtUp, text.length])

  return caughtUp ? text : text.slice(0, shown)
}

const AnswerText = ({ text, live }: { text: string; live: boolean }) => {
  // Reduce motion shows streamed text as it arrives.
  const { reduceMotion } = useSettings()
  const smooth = useSmoothText(text, live)
  return <Markdown text={reduceMotion ? text : smooth} />
}

const Thought = ({ text, live }: { text: string; live: boolean }) => {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="group/thought flex h-[30px] items-center gap-1.5 self-start text-ui"
      >
        {live ? <Shimmer className="text-text-2">Thinking</Shimmer> : <span className="text-text-3">Thought</span>}
        <ChevronRightIcon
          className={cn(
            "text-text-3 group-hover/thought:text-text-2 size-3.5 transition-transform duration-200",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <p className="selectable text-text-3 animate-in fade-in-0 border-line border-l pl-3 text-ui leading-[21px] whitespace-pre-wrap duration-200">
          {text}
        </p>
      )}
    </div>
  )
}

const Plan = ({ entries }: { entries: Extract<Block, { _tag: "Plan" }>["entries"] }) => (
  <div className="flex flex-col gap-1.5 rounded-xl bg-white/[0.02] px-3.5 py-3 shadow-hairline">
    {entries.map((entry, index) => (
      <div key={index} className="flex items-start gap-2.5">
        <span className="mt-[5px] flex size-3 shrink-0 items-center justify-center">
          {entry.status === "completed" ? (
            <CheckIcon className="text-text-3 size-3" />
          ) : entry.status === "in_progress" ? (
            <Led />
          ) : (
            <span className="border-text-3 size-2 rounded-full border" />
          )}
        </span>
        <span
          className={cn(
            "text-ui leading-[21px]",
            entry.status === "completed" ? "text-text-3" : entry.status === "in_progress" ? "text-text" : "text-text-2",
          )}
        >
          {entry.content}
        </span>
      </div>
    ))}
  </div>
)

type Kind = Block["_tag"] | "Worked"

/** Thoughts, tool stacks and folded turns render as single 30px rows. */
const isStep = (kind: Kind) => kind === "Thought" || kind === "Stack" || kind === "Worked"

/**
 * Space above a block: wide between turns, tight between consecutive steps so
 * they read as one list. The answer's 28px action row counts toward a turn gap.
 */
const spaceAbove = (previous: Kind | undefined, kind: Kind, previousHasActions: boolean) => {
  if (!previous) return undefined
  if (kind === "User") return previousHasActions ? "mt-3" : "mt-10"
  if (previous === "User") return "mt-6"
  if (isStep(previous) && isStep(kind)) return "mt-1"
  return "mt-3"
}

const kindOf = (entry: Entry): Kind => (entry._tag === "Worked" ? "Worked" : entry.block._tag)

/** A finished turn's steps, folded behind one row until opened. */
const Worked = ({
  durationMs,
  children,
}: {
  durationMs: number | null
  children: React.ReactNode
}) => {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="group/worked flex h-[30px] items-center gap-1.5 self-start text-ui"
      >
        <span className="text-text-3 group-hover/worked:text-text-2 transition-colors">
          {durationMs === null ? "Worked" : `Worked for ${formatElapsed(Math.max(durationMs, 1000))}`}
        </span>
        <ChevronRightIcon
          className={cn(
            "text-text-3 group-hover/worked:text-text-2 size-3.5 transition-transform duration-200",
            open && "rotate-90",
          )}
        />
      </button>
      {open && <div className="animate-in fade-in-0 flex flex-col duration-200">{children}</div>}
    </div>
  )
}

interface TimelineProps {
  readonly session: Session
  readonly onRetry: (text: string, images: ReadonlyArray<ImageAttachment>, mentions: ReadonlyArray<Mention>) => void
}

export const Timeline = ({ session, onRetry }: TimelineProps) => {
  const blocks = useMemo(() => toBlocks(session.items), [session.items])
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  const lastScrollTop = useRef(0)
  const working = session.status === "working"

  useLayoutEffect(() => {
    const element = scroller.current
    if (element && stuck.current) element.scrollTop = element.scrollHeight
  }, [blocks, session.request, working])

  // Streamed text grows between state updates, and the composer can shrink the view, so follow both sizes.
  useEffect(() => {
    const element = scroller.current
    const inner = content.current
    if (!element || !inner) return
    const observer = new ResizeObserver(() => {
      if (stuck.current) element.scrollTop = element.scrollHeight
    })
    observer.observe(inner)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /** The last user message before each block, so an answer can be retried. */
  const promptBefore = (index: number) => {
    for (let i = index; i >= 0; i--) {
      const block = blocks[i]
      if (block?._tag === "User") return block
    }
    return null
  }

  const isTurnEnd = (index: number) => {
    const next = blocks.slice(index + 1).find((block) => block._tag !== "Notice")
    return next === undefined ? !working : next._tag === "User"
  }

  const hasActions = (index: number) => blocks[index]?._tag === "Agent" && isTurnEnd(index)

  const entries = useMemo(() => toEntries(blocks, working), [blocks, working])

  const renderBlock = (block: Block, index: number) => {
    const last = index === blocks.length - 1
    switch (block._tag) {
      case "User":
        return (
          <div className="flex justify-end pl-16">
            <div className="flex flex-col items-end gap-2">
              {block.images && block.images.length > 0 && (
                <div className="flex flex-wrap justify-end gap-2">
                  {block.images.map((image, imageIndex) => (
                    <img
                      key={imageIndex}
                      src={`data:${image.mimeType};base64,${image.data}`}
                      alt={image.name}
                      title={image.name}
                      className="max-h-48 max-w-60 rounded-xl object-cover shadow-outline"
                    />
                  ))}
                </div>
              )}
              {block.text && (
                <div className="bg-raised selectable text-text rounded-[16px_16px_6px_16px] px-4 py-3 text-sm leading-[22px] whitespace-pre-wrap shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]">
                  {block.text}
                </div>
              )}
            </div>
          </div>
        )
      case "Agent": {
        const prompt = promptBefore(index)
        return (
          <div className="group/answer flex flex-col gap-2">
            <AnswerText text={block.text} live={working && last} />
            {isTurnEnd(index) && (
              <MessageActions
                text={block.text}
                onRetry={prompt && !working ? () => onRetry(prompt.text, prompt.images ?? [], prompt.mentions ?? []) : undefined}
                className={cn(!last && "opacity-0 transition-opacity group-hover/answer:opacity-100")}
              >
                {!working && <ForkMenu threadId={session.id} agentId={session.agentId} upTo={block.id} compact />}
              </MessageActions>
            )}
          </div>
        )
      }
      case "Thought":
        return <Thought text={block.text} live={working && last} />
      case "Stack":
        return <ToolStack tools={block.tools} live={working && last} cwd={session.cwd} />
      case "Plan":
        return <Plan entries={block.entries} />
      case "Notice":
        return (
          <div className="flex items-start gap-2.5">
            <span
              className={cn(
                "mt-[7px] size-1.5 shrink-0 rounded-full",
                block.tone === "error" ? "bg-remove" : "bg-text-3",
              )}
            />
            <p className="selectable text-text-2 text-ui leading-[21px]">{block.text}</p>
          </div>
        )
      case "Fork":
        return (
          <div className="flex items-center gap-3">
            <span className="bg-line h-px flex-1" />
            <span className="text-text-3 flex items-center gap-1.5 text-xs">
              {block.fromAgentId === session.agentId ? (
                "Forked here"
              ) : (
                <>
                  <AgentIcon agent={block.fromAgentId} className="size-3" />
                  Handed off from {agents[block.fromAgentId].name}
                </>
              )}
            </span>
            <span className="bg-line h-px flex-1" />
          </div>
        )
    }
  }

  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget
        const distance = element.scrollHeight - element.scrollTop - element.clientHeight
        const movedUp = element.scrollTop < lastScrollTop.current
        lastScrollTop.current = element.scrollTop
        // Any upward scroll detaches, however small, so following output never fights the user.
        // Sitting at the very bottom (also after content shrinks) re-attaches.
        if (distance < 1) stuck.current = true
        else if (movedUp) stuck.current = false
        else if (distance < STICK_THRESHOLD_PX) stuck.current = true
      }}
      className="min-h-0 flex-1 overflow-y-auto px-10 pt-5 pb-10"
    >
      <div ref={content} className="mx-auto flex w-full max-w-[640px] flex-col">
        {entries.map((entry, position) => {
          const previous = entries[position - 1]
          const space = spaceAbove(
            previous && kindOf(previous),
            kindOf(entry),
            previous?._tag === "Block" && hasActions(previous.index),
          )
          if (entry._tag === "Block") {
            return (
              <div key={entry.block.id} className={space}>
                {renderBlock(entry.block, entry.index)}
              </div>
            )
          }
          return (
            <div key={entry.id} className={space}>
              <Worked durationMs={entry.durationMs}>
                {entry.steps.map(({ block, index }, step) => (
                  <div
                    key={block.id}
                    className={spaceAbove(step === 0 ? "Worked" : entry.steps[step - 1]!.block._tag, block._tag, false)}
                  >
                    {renderBlock(block, index)}
                  </div>
                ))}
              </Worked>
            </div>
          )
        })}
        {working && blocks.at(-1)?._tag === "User" && (
          <div className="mt-6 flex h-[30px] items-center">
            <Shimmer className="text-text-2 text-ui">Thinking</Shimmer>
          </div>
        )}
      </div>
    </div>
  )
}
