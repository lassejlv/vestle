import { Terminal, type TerminalOptions } from "@termysh/web"
import { openUrl } from "@tauri-apps/plugin-opener"
import { Effect, Exit, Scope } from "effect"
import { useEffect, useRef, useState } from "react"
import { runtime } from "@/lib/runtime"
import { cn } from "@/lib/utils"
import {
  CODE_FALLBACK,
  defaultSettings,
  fontStack,
  getSettings,
  type Settings,
  updateSettings,
  useSettings,
} from "@/lib/settings"
import { TerminalHost } from "@/services/TerminalHost"

const theme = {
  // Transparent, so the panel behind shows through, glass included.
  background: "#00000000",
  foreground: "#ece9e4",
  cursor: "#ffffff",
  cursorAccent: "#0c0c0d",
  selectionBackground: "rgba(255, 255, 255, 0.25)",
  black: "#1b1b1e",
  red: "#f0605a",
  green: "#4cc38a",
  yellow: "#ffb224",
  blue: "#82a9e8",
  magenta: "#c79bf2",
  cyan: "#6cc7d4",
  white: "#ece9e4",
  brightBlack: "#66645f",
  brightRed: "#ff7b74",
  brightGreen: "#6fd8a4",
  brightYellow: "#ffc75c",
  brightBlue: "#a3c0f0",
  brightMagenta: "#d9b8f7",
  brightCyan: "#8fdbe5",
  brightWhite: "#ffffff",
}

const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 28

/** ⌘= and ⌘- step the terminal font size setting, ⌘0 resets it. `null` for any other key. */
const zoomed = (event: KeyboardEvent, size: number): number | null => {
  if (!event.metaKey || event.altKey || event.ctrlKey) return null
  if (event.key === "=" || event.key === "+") return Math.min(Math.floor(size) + 1, MAX_FONT_SIZE)
  if (event.key === "-") return Math.max(Math.ceil(size) - 1, MIN_FONT_SIZE)
  if (event.key === "0") return defaultSettings.termFontSize
  return null
}

/** The terminal options the Terminal settings control. */
const optionsFrom = (settings: Settings): TerminalOptions => ({
  fontFamily: fontStack(settings.termFont, CODE_FALLBACK),
  fontSize: settings.termFontSize,
  lineHeight: settings.termLineHeight,
  letterSpacing: settings.termLetterSpacing,
  fontWeight: settings.termFontWeight,
  fontWeightBold: settings.termFontWeightBold,
  cursorStyle: settings.termCursorStyle,
  cursorBlink: settings.termCursorBlink,
  cursorInactiveStyle: settings.termCursorInactiveStyle,
  drawBoldTextInBrightColors: settings.termBoldBright,
  minimumContrastRatio: settings.termMinContrast,
  scrollback: settings.termScrollback,
  macOptionIsMeta: settings.termOptionAsMeta,
  copyOnSelect: settings.termCopyOnSelect,
})

/**
 * Loads the terminal font (regular and bold). The terminal draws on a canvas, which
 * doesn't ask for a web font by itself; once it's loaded the terminal re-measures its cells.
 */
const fontReady = (settings: Settings) => {
  const family = fontStack(settings.termFont, CODE_FALLBACK)
  const size = `${settings.termFontSize}px`
  return Promise.all([
    document.fonts.load(`${settings.termFontWeight} ${size} ${family}`),
    document.fonts.load(`${settings.termFontWeightBold} ${size} ${family}`),
  ]).then(
    () => undefined,
    () => undefined,
  )
}

/**
 * A shell in the project folder: the background daemon runs the PTY on libtermy, and
 * libtermy's web terminal (the same engine compiled to WebAssembly) parses and draws it.
 * The shell is found again by `shellKey`, so it survives this view unmounting and the app quitting.
 */
export const TerminalView = ({
  shellKey,
  cwd,
  active,
  onTitleChange,
  className,
}: {
  /** Names the shell in the daemon; the same key reattaches to the same shell. */
  shellKey: string
  cwd: string
  /** Padding around the terminal; the default suits a panel with a header above it. */
  className?: string
  active: boolean
  /** The shell's window title (OSC 0/2), e.g. the running command. */
  onTitleChange?: (title: string) => void
}) => {
  const container = useRef<HTMLDivElement>(null)
  const titleListener = useRef(onTitleChange)
  titleListener.current = onTitleChange
  const terminalRef = useRef<Terminal | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const [generation, setGeneration] = useState(0)
  const settings = useSettings()

  useEffect(() => {
    const element = container.current
    if (!element) return
    let cancelled = false
    let teardown: (() => void) | undefined

    const start = () => {
      const terminal = new Terminal({
        ...optionsFrom(getSettings()),
        theme,
        allowTransparency: true,
        // Box drawing and block glyphs drawn to the cell, so borders meet at any line height.
        customGlyphs: true,
        linkHandler: { activate: (_event, uri) => void openUrl(uri) },
        // OSC 52, so tmux, vim and ssh sessions can copy to the system clipboard.
        allowClipboardWrite: true,
      })
      terminal.attachCustomKeyEventHandler((event) => {
        const size = zoomed(event, getSettings().termFontSize)
        if (size === null) return true
        if (event.type === "keydown") {
          event.preventDefault()
          // Every terminal follows; the settings effect below refits them.
          updateSettings({ termFontSize: size })
        }
        return false
      })
      terminal.onTitleChange((title) => titleListener.current?.(title))
      // Follows the element's size from here on (`autoFit`).
      terminal.open(element)
      // A restart comes from a keypress in this terminal, and the first open comes from showing it.
      if (generation > 0 || activeRef.current) terminal.focus()
      terminalRef.current = terminal

      const scope = runtime.runSync(Scope.make())
      let disposed = false
      let ended = false

      void runtime
        .runPromise(
          Effect.gen(function* () {
            const host = yield* TerminalHost
            // The engine loads in the background; the shell should start at the fitted size.
            yield* Effect.promise(() => terminal.ready)
            terminal.fit()
            // After the shell exited, a keypress starts a new one under the same key.
            if (generation > 0) yield* host.close(shellKey)
            const session = yield* host.open({
              key: shellKey,
              cwd,
              cols: terminal.cols,
              rows: terminal.rows,
              onOutput: (bytes) => terminal.write(bytes),
              onExit: () => {
                ended = true
                terminal.processExited()
                terminal.write("\r\n\x1b[2mShell exited. Press any key to start a new one.\x1b[0m\r\n")
              },
            })
            // Keys, pastes and the terminal's replies to queries all go to the shell.
            const typing = terminal.onData((data) => {
              if (ended) setGeneration((value) => value + 1)
              else void runtime.runPromise(Effect.ignore(session.write(data)))
            })
            const resizing = terminal.onResize(({ cols, rows }) =>
              void runtime.runPromise(Effect.ignore(session.resize(cols, rows))),
            )
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                typing.dispose()
                resizing.dispose()
              }),
            )
          }).pipe(Scope.provide(scope)),
        )
        .catch((error: unknown) => {
          if (!disposed) terminal.write(`\r\n\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`)
        })

      return () => {
        disposed = true
        void runtime.runPromise(Scope.close(scope, Exit.void))
        terminal.dispose()
        terminalRef.current = null
      }
    }

    void fontReady(getSettings()).then(() => {
      if (!cancelled) teardown = start()
    })

    return () => {
      cancelled = true
      teardown?.()
    }
  }, [shellKey, cwd, generation])

  // Settings apply to running terminals, which re-measure and refit; a new font is loaded first.
  useEffect(() => {
    let cancelled = false
    void fontReady(settings).then(() => {
      if (!cancelled) terminalRef.current?.setOptions(optionsFrom(settings))
    })
    return () => {
      cancelled = true
    }
  }, [settings])

  useEffect(() => {
    if (!active) return
    terminalRef.current?.fit()
    terminalRef.current?.focus()
  }, [active])

  // The terminal fills the element it opens in, so the padding sits outside it.
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col px-3 pt-1 pb-2", className)}>
      <div ref={container} data-terminal className="selectable min-h-0 flex-1" />
    </div>
  )
}
