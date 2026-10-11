import { File } from "@pierre/diffs/react"
import { ArrowPathIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, DocumentDuplicateIcon, FolderIcon, FolderOpenIcon, MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline"
import { useEffect, useMemo, useRef, useState } from "react"
import type { FileChange } from "@/domain/changes"
import { rankFiles } from "@/domain/mentions"
import { Effect, Option } from "effect"
import { runtime, useRun, useWorkspace } from "@/lib/runtime"
import { cn } from "@/lib/utils"
import { iconFor } from "./mention-picker"
import { useCopy } from "./message-actions"
import { diffStyle } from "./review-pane"

/** Lines shown in a preview; enough to read, cheap to render. */
const PREVIEW_LINES = 4000

/** Filter results shown at once; the best matches come first. */
const MAX_RESULTS = 200

interface Folder {
  readonly folders: Map<string, Folder>
  readonly files: Array<string>
}

const buildTree = (paths: ReadonlyArray<string>): Folder => {
  const root: Folder = { folders: new Map(), files: [] }
  for (const path of paths) {
    const parts = path.split("/")
    let folder = root
    for (const part of parts.slice(0, -1)) {
      let next = folder.folders.get(part)
      if (!next) {
        next = { folders: new Map(), files: [] }
        folder.folders.set(part, next)
      }
      folder = next
    }
    folder.files.push(parts.at(-1)!)
  }
  return root
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" })

const relativeTo = (cwd: string, path: string) => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)

const Row = ({
  depth,
  onClick,
  selected,
  children,
  className,
}: {
  depth: number
  onClick: () => void
  selected?: boolean
  children: React.ReactNode
  className?: string
}) => (
  <button
    type="button"
    onClick={onClick}
    data-selected={selected || undefined}
    style={{ paddingLeft: 10 + depth * 14 }}
    className={cn(
      "hover:bg-hover/60 flex h-7 shrink-0 items-center gap-2 rounded-md pr-2.5 text-left",
      selected && "bg-hover/60",
      className,
    )}
  >
    {children}
  </button>
)

const FolderRows = ({
  folder,
  path,
  depth,
  open,
  onToggle,
  onOpenFile,
  changed,
}: {
  folder: Folder
  path: string
  depth: number
  open: ReadonlySet<string>
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  changed: ReadonlySet<string>
}) => (
  <>
    {[...folder.folders.keys()].sort(byName).map((name) => {
      const full = path ? `${path}/${name}` : name
      const expanded = open.has(full)
      const Icon = expanded ? FolderOpenIcon : FolderIcon
      const hasChanges = [...changed].some((file) => file.startsWith(`${full}/`))
      return (
        <div key={name} className="flex flex-col">
          <Row depth={depth} onClick={() => onToggle(full)}>
            <ChevronRightIcon
              className={cn("text-text-3 -ml-1 size-3 shrink-0 transition-transform duration-150", expanded && "rotate-90")}
            />
            <Icon className="text-text-3 size-3.5 shrink-0" strokeWidth={1.6} />
            <span className="text-text-2 min-w-0 flex-1 truncate text-ui">{name}</span>
            {hasChanges && <span className="bg-amber size-1.5 shrink-0 rounded-full" />}
          </Row>
          {expanded && (
            <FolderRows
              folder={folder.folders.get(name)!}
              path={full}
              depth={depth + 1}
              open={open}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              changed={changed}
            />
          )}
        </div>
      )
    })}
    {[...folder.files].sort(byName).map((name) => {
      const full = path ? `${path}/${name}` : name
      const Icon = iconFor(name)
      const isChanged = changed.has(full)
      return (
        <Row key={name} depth={depth} onClick={() => onOpenFile(full)}>
          {/* Lines up with folder names past the chevron. */}
          <span className="-ml-1 size-3 shrink-0" />
          <Icon className="text-text-3 size-3.5 shrink-0" strokeWidth={1.6} />
          <span className={cn("min-w-0 flex-1 truncate text-ui", isChanged ? "text-amber" : "text-text-2")}>
            {name}
          </span>
        </Row>
      )
    })}
  </>
)

const Preview = ({
  cwd,
  path,
  refreshKey,
  changedText,
  onBack,
}: {
  cwd: string
  path: string
  refreshKey: unknown
  /** The agent's latest text for this file, so the preview follows its edits. */
  changedText: string | undefined
  onBack: () => void
}) => {
  const workspace = useWorkspace()
  const [content, setContent] = useState<string | null | undefined>(undefined)

  // Binary files fail to read as text; that's a "can't preview", not an error toast.
  // Reloads keep showing the old text until the new one arrives.
  useEffect(() => {
    let current = true
    void runtime
      .runPromise(Effect.option(workspace.readFile(`${cwd}/${path}`)))
      .then((text) => current && setContent(Option.getOrNull(text)))
    return () => {
      current = false
    }
  }, [cwd, path, workspace, refreshKey, changedText])

  const { copied, copy } = useCopy(content ?? "")
  const lines = useMemo(() => content?.split("\n") ?? [], [content])
  const file = useMemo(
    () =>
      content == null
        ? null
        : { name: path, contents: lines.slice(0, PREVIEW_LINES).join("\n") },
    [content, lines, path],
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-white/5 px-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to files"
          className="text-text-3 hover:text-text hover:bg-hover flex size-6 items-center justify-center rounded-md"
        >
          <ChevronLeftIcon className="size-3.5" />
        </button>
        <span className="text-text-2 min-w-0 flex-1 truncate text-xs">{path}</span>
        {content != null && (
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={copied ? "Copied" : "Copy file"}
            className="text-text-3 hover:text-text hover:bg-hover flex size-6 shrink-0 items-center justify-center rounded-md"
          >
            {copied ? <CheckIcon className="size-3" /> : <DocumentDuplicateIcon className="size-3" />}
          </button>
        )}
      </div>
      {content === undefined ? null : !file ? (
        <p className="text-text-3 px-4 pt-3 text-ui">This file can't be previewed.</p>
      ) : (
        <div className="selectable min-h-0 flex-1 overflow-auto py-2">
          <File
            file={file}
            options={{ theme: "pierre-dark", themeType: "dark", overflow: "scroll", disableFileHeader: true }}
            style={diffStyle}
          />
          {lines.length > PREVIEW_LINES && (
            <p className="text-text-3 px-4 pt-2 font-sans text-xs">Showing the first {PREVIEW_LINES} lines.</p>
          )}
        </div>
      )}
    </div>
  )
}

/** The project's files, minus anything gitignored. Files changed in this thread are highlighted. */
export const FileTree = ({
  cwd,
  changes,
  refreshKey,
}: {
  cwd: string
  changes: ReadonlyArray<FileChange>
  /** Reloads the listing when it changes, e.g. after each turn. */
  refreshKey: unknown
}) => {
  const workspace = useWorkspace()
  const run = useRun()
  const [files, setFiles] = useState<ReadonlyArray<string> | null>(null)
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [preview, setPreview] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let current = true
    void run(workspace.listFiles(cwd)).then((list) => current && list && setFiles(list))
    return () => {
      current = false
    }
  }, [cwd, refreshKey, reloads, run, workspace])

  const tree = useMemo(() => buildTree(files ?? []), [files])
  const changed = useMemo(() => new Set(changes.map((change) => relativeTo(cwd, change.path))), [changes, cwd])
  const results = useMemo(() => (query.trim() ? rankFiles(files ?? [], query.trim(), MAX_RESULTS) : []), [files, query])

  useEffect(() => {
    list.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest" })
  }, [selected])

  if (preview) {
    return (
      <Preview
        key={preview}
        cwd={cwd}
        path={preview}
        refreshKey={refreshKey}
        changedText={changes.find((change) => relativeTo(cwd, change.path) === preview)?.newText}
        onBack={() => setPreview(null)}
      />
    )
  }

  const onFilterKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      setSelected((index) => Math.min(Math.max(index + step, 0), Math.max(results.length - 1, 0)))
    } else if (event.key === "Enter" && results[selected]) {
      setPreview(results[selected])
    } else if (event.key === "Escape" && query) {
      event.preventDefault()
      setQuery("")
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/5 pr-2 pl-3.5">
        <MagnifyingGlassIcon className="text-text-3 size-3.5 shrink-0" strokeWidth={1.6} />
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelected(0)
          }}
          onKeyDown={onFilterKey}
          placeholder={files ? `Filter ${files.length} files` : "Loading files"}
          aria-label="Filter files"
          spellCheck={false}
          className="text-text placeholder:text-text-3 min-w-0 flex-1 bg-transparent text-xs outline-none"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear filter"
            className="text-text-3 hover:text-text hover:bg-hover flex size-6 shrink-0 items-center justify-center rounded-md"
          >
            <XMarkIcon className="size-3" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setReloads((count) => count + 1)}
          aria-label="Reload files"
          className="text-text-3 hover:text-text hover:bg-hover flex size-6 shrink-0 items-center justify-center rounded-md"
        >
          <ArrowPathIcon className="size-3" />
        </button>
      </div>
      <div ref={list} className="no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5">
        {query.trim() ? (
          results.length === 0 ? (
            <p className="text-text-3 px-2.5 pt-1.5 text-ui">No matching files</p>
          ) : (
            results.map((file, index) => {
              const slash = file.lastIndexOf("/")
              const name = file.slice(slash + 1)
              const Icon = iconFor(name)
              return (
                <Row key={file} depth={0} selected={index === selected} onClick={() => setPreview(file)}>
                  <Icon className="text-text-3 size-3.5 shrink-0" strokeWidth={1.6} />
                  <span className={cn("min-w-0 truncate text-ui", changed.has(file) ? "text-amber" : "text-text-2")}>
                    {name}
                  </span>
                  {/* Takes only the room the name leaves. */}
                  <span className="text-text-3 min-w-0 flex-1 basis-0 truncate text-xs">
                    {slash > 0 ? file.slice(0, slash) : ""}
                  </span>
                </Row>
              )
            })
          )
        ) : (
          <FolderRows
            folder={tree}
            path=""
            depth={0}
            open={open}
            onToggle={(path) =>
              setOpen((current) => {
                const next = new Set(current)
                if (next.has(path)) next.delete(path)
                else next.add(path)
                return next
              })
            }
            onOpenFile={setPreview}
            changed={changed}
          />
        )}
      </div>
    </div>
  )
}
