import { MultiFileDiff } from "@pierre/diffs/react"
import { XMarkIcon } from "@heroicons/react/24/outline"
import type { CSSProperties, ReactNode } from "react"
import { type FileChange, totals } from "@/domain/changes"
import { relativePath } from "@/domain/timeline"
import { useSettings } from "@/lib/settings"
import { Diffstat } from "./primitives"
import { ResizeHandle, usePanelWidth } from "./resize-handle"

/** Pierre's dark theme, seated on the window's instrument black. */
export const diffStyle = {
  "--diffs-bg": "var(--bg)",
  "--diffs-font-family": "var(--code-font)",
  "--diffs-header-font-family": "var(--ui-font)",
  "--diffs-font-size": "var(--code-font-size)",
  "--diffs-line-height": "calc(var(--code-font-size) * 1.7)",
} as CSSProperties

const FileDiff = ({ change, cwd }: { change: FileChange; cwd: string }) => {
  const name = relativePath(change.path, cwd)
  const { diffLayout } = useSettings()
  return (
    <MultiFileDiff
      oldFile={{ name, contents: change.oldText, cacheKey: `${change.path}:old:${change.oldText.length}` }}
      newFile={{ name, contents: change.newText, cacheKey: `${change.path}:new:${change.newText.length}` }}
      options={{
        theme: "pierre-dark",
        themeType: "dark",
        diffStyle: diffLayout,
        overflow: "wrap",
        lineDiffType: "word",
        stickyHeader: true,
      }}
      style={diffStyle}
      className="selectable border-b border-white/5"
    />
  )
}

const ChangeList = ({ changes, cwd }: { changes: ReadonlyArray<FileChange>; cwd: string }) => (
  <div className="min-h-0 flex-1 overflow-y-auto">
    {changes.length === 0 ? (
      <p className="text-text-3 px-4 pt-2 text-ui leading-5">Files the agent edits in this thread show up here.</p>
    ) : (
      changes.map((change) => <FileDiff key={change.path} change={change} cwd={cwd} />)
    )}
  </div>
)

export const ReviewPane = ({
  changes,
  cwd,
  onClose,
  tabs,
  children,
}: {
  changes: ReadonlyArray<FileChange>
  cwd: string
  onClose: () => void
  /** Tab switcher rendered in the header. */
  tabs?: ReactNode
  /** Replaces the diff list, e.g. with the terminal. */
  children?: ReactNode
}) => {
  const sum = totals(changes)
  const { width, resize, reset } = usePanelWidth("panel.width", { initial: 548, min: 360, max: 960 })
  return (
    <div style={{ width }} className="relative flex h-full shrink-0">
      <ResizeHandle edge="left" width={width} onResize={resize} onReset={reset} />
      <aside className="surface animate-in fade-in-0 slide-in-from-right-2 flex h-full w-full flex-col overflow-hidden rounded-xl duration-200">
        <header data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-3 pr-2.5 pl-2.5">
          {tabs ?? <span className="text-text pl-1.5 text-ui font-semibold tracking-[-0.01em]">Changes</span>}
          <span className="flex-1" />
          {sum.files > 0 && (
            <>
              <span className="text-text-3 text-xs">
                {sum.files} {sum.files === 1 ? "file" : "files"}
              </span>
              <Diffstat additions={sum.additions} deletions={sum.deletions} />
            </>
          )}
          <button
            type="button"
            aria-label="Close panel"
            onClick={onClose}
            className="text-text-3 hover:text-text hover:bg-hover flex size-7 items-center justify-center rounded-lg"
          >
            <XMarkIcon className="size-3.5" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">{children ?? <ChangeList changes={changes} cwd={cwd} />}</div>
      </aside>
    </div>
  )
}

ReviewPane.Changes = ChangeList
