import { diffLines } from "diff"
import type { TimelineItem } from "./session"

export interface FileChange {
  readonly path: string
  readonly oldText: string
  readonly newText: string
  readonly isNew: boolean
  readonly additions: number
  readonly deletions: number
}

const countLines = (text: string) => (text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0))

/**
 * Collapses every diff the agent reported in a thread into one change per file:
 * the first `oldText` seen against the last `newText`.
 */
export const collectChanges = (items: ReadonlyArray<TimelineItem>): ReadonlyArray<FileChange> => {
  const files = new Map<string, { oldText: string | null; newText: string }>()
  for (const item of items) {
    if (item._tag !== "Tool") continue
    for (const content of item.content) {
      if (content.type !== "diff") continue
      const existing = files.get(content.path)
      files.set(content.path, {
        oldText: existing ? existing.oldText : (content.oldText ?? null),
        newText: content.newText,
      })
    }
  }

  return [...files.entries()].map(([path, { oldText, newText }]) => {
    let additions = 0
    let deletions = 0
    for (const part of diffLines(oldText ?? "", newText)) {
      if (part.added) additions += countLines(part.value)
      else if (part.removed) deletions += countLines(part.value)
    }
    return { path, oldText: oldText ?? "", newText, isNew: oldText === null, additions, deletions }
  })
}

export const totals = (changes: ReadonlyArray<FileChange>) => ({
  files: changes.length,
  additions: changes.reduce((sum, change) => sum + change.additions, 0),
  deletions: changes.reduce((sum, change) => sum + change.deletions, 0),
})
