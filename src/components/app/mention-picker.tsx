import type * as acp from "@agentclientprotocol/sdk"
import { CodeBracketIcon, CodeBracketSquareIcon, Cog6ToothIcon, CommandLineIcon, CubeIcon, DocumentIcon, DocumentTextIcon, PhotoIcon, SlashIcon } from "@heroicons/react/24/outline"
import { useEffect, useRef } from "react"
import type { HeroIcon } from "./primitives"
import type { AgentId } from "@/domain/agents"
import { type Mention, type QueryKind, rankByName, rankFiles, rankSkills, type Skill, skillTitle } from "@/domain/mentions"
import { cn } from "@/lib/utils"

const MAX_ROWS = 50

const extensionIcons: ReadonlyArray<readonly [RegExp, HeroIcon]> = [
  [/\.(toml|ya?ml|ini|env|lock|config)$|^\.|rc$/, Cog6ToothIcon],
  [/\.json5?$/, CodeBracketSquareIcon],
  [/\.(md|mdx|txt|rst)$/, DocumentTextIcon],
  [/\.(png|jpe?g|gif|webp|svg|ico|icns)$/, PhotoIcon],
  [/\.(sh|bash|zsh|fish)$/, CommandLineIcon],
  [/\.(tsx?|jsx?|mjs|cjs|rs|go|py|rb|swift|kt|java|c|cc|cpp|h|hpp|cs|css|scss|html|vue|svelte|sql|lua|zig)$/, CodeBracketIcon],
]

export const iconFor = (fileName: string) =>
  extensionIcons.find(([pattern]) => pattern.test(fileName.toLowerCase()))?.[1] ?? DocumentIcon

export interface PickerRow {
  readonly key: string
  readonly icon: HeroIcon
  readonly title: string
  readonly detail: string
  readonly trailing?: string
  /** Replaces the typed query, trigger included. */
  readonly insert: string
  /** Files and skills also go to the agent as links; commands are just text. */
  readonly mention?: Mention
}

/** Rows for the current query. Files are relative to `cwd`; mentions carry absolute paths. */
export const pickerRows = (
  kind: QueryKind,
  query: string,
  cwd: string,
  files: ReadonlyArray<string>,
  skills: ReadonlyArray<Skill>,
  commands: ReadonlyArray<acp.AvailableCommand>,
): ReadonlyArray<PickerRow> => {
  if (kind === "command") {
    return rankByName(commands, query, MAX_ROWS).map((command) => ({
      key: command.name,
      icon: SlashIcon,
      title: `/${command.name}`,
      detail: command.description,
      trailing: command.input?.hint,
      insert: `/${command.name}`,
    }))
  }
  if (kind === "file") {
    return rankFiles(files, query, MAX_ROWS).map((file) => {
      const slash = file.lastIndexOf("/")
      const name = file.slice(slash + 1)
      return {
        key: file,
        icon: iconFor(name),
        title: name,
        detail: slash > 0 ? file.slice(0, slash) : "",
        insert: `@${file}`,
        mention: { kind, name, path: `${cwd}/${file}`, token: `@${file}` },
      }
    })
  }
  return rankSkills(skills, query, MAX_ROWS).map((skill) => ({
    key: skill.path,
    icon: CubeIcon,
    title: skillTitle(skill.name),
    detail: skill.description,
    trailing: skill.scope === "project" ? "Project" : "Global",
    insert: `$${skill.name}`,
    mention: { kind, name: skill.name, path: skill.path, token: `$${skill.name}` },
  }))
}

export const emptyText = (kind: QueryKind, agentId: AgentId | undefined, loading: boolean) => {
  if (kind === "command") return loading ? "Waiting for the agent's commands" : "No matching commands"
  if (loading) return kind === "file" ? "Loading files" : "Loading skills"
  if (kind === "file") return "No matching files"
  return agentId === "claude" ? "No matching skills in .claude/skills" : "No matching skills"
}

/** The list above the composer while typing an `@` or `$` mention. */
export const MentionPicker = ({
  rows,
  active,
  empty,
  onActiveChange,
  onSelect,
}: {
  rows: ReadonlyArray<PickerRow>
  active: number
  empty: string
  onActiveChange: (index: number) => void
  onSelect: (row: PickerRow) => void
}) => {
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: "nearest" })
  }, [active])

  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 bg-raised absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-2xl p-1 shadow-popover duration-150">
      {rows.length === 0 ? (
        <p className="text-text-3 flex h-9 items-center px-3 text-ui">{empty}</p>
      ) : (
        <div ref={list} role="listbox" className="no-scrollbar flex max-h-[296px] flex-col overflow-y-auto">
          {rows.map((row, index) => {
            const Icon = row.icon
            return (
              <button
                key={row.key}
                type="button"
                role="option"
                aria-selected={index === active}
                // Keep focus (and the caret) in the textarea.
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => index !== active && onActiveChange(index)}
                onClick={() => onSelect(row)}
                className={cn(
                  "flex h-9 shrink-0 items-center gap-2.5 rounded-xl px-3 text-left",
                  index === active && "bg-white/6",
                )}
              >
                <Icon className={cn("size-4 shrink-0", index === active ? "text-text" : "text-text-2")} strokeWidth={1.6} />
                <span className={cn("shrink-0 text-ui", index === active ? "text-text" : "text-text-2")}>
                  {row.title}
                </span>
                <span className="text-text-3 min-w-0 flex-1 truncate text-ui">{row.detail}</span>
                {row.trailing && <span className="text-text-3 shrink-0 text-xs">{row.trailing}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
