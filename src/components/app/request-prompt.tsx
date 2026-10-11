import type * as acp from "@agentclientprotocol/sdk"
import { CheckIcon, ClipboardDocumentListIcon, QuestionMarkCircleIcon, ShieldCheckIcon } from "@heroicons/react/24/outline"
import { type ReactNode, useState } from "react"
import type { PendingRequest, Session } from "@/domain/session"
import { useRun, useWorkspace } from "@/lib/runtime"
import { cn } from "@/lib/utils"
import { Markdown } from "./markdown"

const primary =
  "bg-amber text-amber-ink hover:bg-amber/90 font-semibold disabled:bg-white/6 disabled:text-text-3 disabled:font-normal"
const secondary = "bg-white/8 text-text hover:bg-white/12"
const quiet = "text-text-2 hover:text-text hover:bg-white/6"

const Frame = ({ icon, title, detail, children }: { icon: ReactNode; title: string; detail?: ReactNode; children: ReactNode }) => (
  <div className="animate-in fade-in-0 slide-in-from-bottom-1 flex flex-col gap-3 border-b border-white/5 px-4 py-3.5 duration-200">
    <div className="flex items-start gap-2.5">
      <span className="text-amber mt-0.5 shrink-0 [&_svg]:size-3.5">{icon}</span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-text text-ui font-medium">{title}</span>
        {detail}
      </div>
    </div>
    {children}
  </div>
)

const Actions = ({ children }: { children: ReactNode }) => <div className="flex justify-end gap-1.5">{children}</div>

const Action = ({
  tone,
  onClick,
  disabled,
  children,
}: {
  tone: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={cn("h-7 rounded-lg px-3 text-xs transition-colors", tone)}
  >
    {children}
  </button>
)

const permissionOrder: Record<acp.PermissionOptionKind, number> = {
  reject_always: 0,
  reject_once: 1,
  allow_always: 2,
  allow_once: 3,
}

const permissionTone = (kind: acp.PermissionOptionKind) =>
  kind === "allow_once" ? primary : kind === "allow_always" ? secondary : quiet

const Permission = ({ session, request }: { session: Session; request: Extract<PendingRequest, { _tag: "Permission" }> }) => {
  const workspace = useWorkspace()
  const run = useRun()
  const options = [...request.options].sort((a, b) => permissionOrder[a.kind] - permissionOrder[b.kind])
  return (
    <Frame
      icon={<ShieldCheckIcon />}
      title="Allow this action?"
      detail={
        <span className="text-text-2 selectable truncate text-xs">
          {request.toolCall.title ?? "The agent wants to run a tool"}
        </span>
      }
    >
      <Actions>
        {options.map((option) => (
          <Action
            key={option.optionId}
            tone={permissionTone(option.kind)}
            onClick={() => void run(workspace.respondPermission(session.id, option.optionId))}
          >
            {option.name}
          </Action>
        ))}
      </Actions>
    </Frame>
  )
}

const Question = ({ session, request }: { session: Session; request: Extract<PendingRequest, { _tag: "Question" }> }) => {
  const workspace = useWorkspace()
  const run = useRun()
  const [selected, setSelected] = useState<Record<string, ReadonlyArray<string>>>({})
  const complete = request.questions.every((question) => (selected[question.id]?.length ?? 0) > 0)

  const toggle = (questionId: string, optionId: string, multiple: boolean) =>
    setSelected((current) => {
      const chosen = current[questionId] ?? []
      const next = multiple
        ? chosen.includes(optionId)
          ? chosen.filter((id) => id !== optionId)
          : [...chosen, optionId]
        : [optionId]
      return { ...current, [questionId]: next }
    })

  return (
    <Frame icon={<QuestionMarkCircleIcon />} title={request.title ?? "The agent has a question"}>
      <div className="flex max-h-72 flex-col gap-4 overflow-y-auto">
        {request.questions.map((question) => (
          <div key={question.id} className="flex flex-col gap-2">
            <span className="text-text selectable text-ui leading-5">{question.prompt}</span>
            <div className="flex flex-wrap gap-1.5">
              {question.options.map((option) => {
                const active = selected[question.id]?.includes(option.id) ?? false
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggle(question.id, option.id, question.allowMultiple ?? false)}
                    className={cn(
                      "flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs transition-colors",
                      active
                        ? "bg-amber/15 text-text shadow-[inset_0_0_0_1px_rgb(255_178_36/0.45)]"
                        : "text-text-2 hover:text-text bg-white/5 hover:bg-white/8",
                    )}
                  >
                    {active && <CheckIcon className="text-amber size-3" />}
                    {option.label}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      <Actions>
        <Action tone={quiet} onClick={() => void run(workspace.answerQuestions(session.id, null))}>
          Skip
        </Action>
        <Action
          tone={primary}
          disabled={!complete}
          onClick={() =>
            void run(
              workspace.answerQuestions(
                session.id,
                request.questions.map((question) => ({
                  questionId: question.id,
                  selectedOptionIds: selected[question.id] ?? [],
                })),
              ),
            )
          }
        >
          Answer
        </Action>
      </Actions>
    </Frame>
  )
}

const PlanApproval = ({
  session,
  request,
}: {
  session: Session
  request: Extract<PendingRequest, { _tag: "PlanApproval" }>
}) => {
  const workspace = useWorkspace()
  const run = useRun()
  return (
    <Frame
      icon={<ClipboardDocumentListIcon />}
      title={request.name ? `Approve plan: ${request.name}` : "Approve this plan?"}
      detail={request.overview && <span className="text-text-2 selectable text-xs leading-5">{request.overview}</span>}
    >
      <div className="bg-panel max-h-72 overflow-y-auto rounded-xl px-3.5 py-3 shadow-hairline">
        <Markdown text={request.plan} />
      </div>
      <Actions>
        <Action tone={quiet} onClick={() => void run(workspace.decidePlan(session.id, false))}>
          Reject
        </Action>
        <Action tone={primary} onClick={() => void run(workspace.decidePlan(session.id, true))}>
          Accept plan
        </Action>
      </Actions>
    </Frame>
  )
}

/** Whatever the agent is blocked on, shown at the top of the composer. */
export const RequestPrompt = ({ session }: { session: Session }) => {
  const request = session.request
  if (!request) return null
  switch (request._tag) {
    case "Permission":
      return <Permission session={session} request={request} />
    case "Question":
      return <Question key={request.questions.map((q) => q.id).join()} session={session} request={request} />
    case "PlanApproval":
      return <PlanApproval session={session} request={request} />
  }
}
