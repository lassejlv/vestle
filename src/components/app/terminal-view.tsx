import { ClipboardAddon } from "@xterm/addon-clipboard"
import { FitAddon } from "@xterm/addon-fit"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { WebglAddon } from "@xterm/addon-webgl"
import { type ITerminalOptions, Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
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
  cursor: "#ffb224",
  cursorAccent: "#0c0c0d",
  selectionBackground: "rgba(255, 178, 36, 0.25)",
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

/** The xterm options the Terminal settings control. */
const optionsFrom = (settings: Settings): ITerminalOptions => ({
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
})

/**
 * Resolves once the terminal font (regular and bold) is loaded. xterm measures
 * the cell size from the font it has when it opens, so measuring a fallback
 * font misaligns every column once the real one arrives.
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

/** WebGL rendering, or `null` to stay on the DOM renderer (no WebGL2, or the context was lost). */
const loadWebgl = (xterm: Terminal, onLost: () => void): WebglAddon | null => {
  try {
    const webgl = new WebglAddon()
    xterm.loadAddon(webgl)
    webgl.onContextLoss(() => {
      webgl.dispose()
      onLost()
    })
    return webgl
  } catch {
    return null
  }
}

/**
 * A shell in the project folder: Termy's background daemon runs the PTY, xterm.js draws it.
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
  const fitRef = useRef<FitAddon | null>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const [generation, setGeneration] = useState(0)
  const settings = useSettings()
  /** Falls back to the DOM renderer if the GPU drops the context, until the GPU setting is applied again. */
  const gpuLost = () => {
    webglRef.current = null
  }

  useEffect(() => {
    const element = container.current
    if (!element) return
    let cancelled = false
    let teardown: (() => void) | undefined

    const start = () => {
      const xterm = new Terminal({
        ...optionsFrom(getSettings()),
        theme,
        allowTransparency: true,
        allowProposedApi: true,
        // Box drawing and Powerline glyphs drawn to the cell, so borders meet at any line height.
        customGlyphs: true,
        // Icons wider than one cell (Nerd Font symbols) shrink to fit instead of overlapping.
        rescaleOverlappingGlyphs: true,
      })
      const fit = new FitAddon()
      xterm.loadAddon(fit)
      xterm.loadAddon(new WebLinksAddon((_event, uri) => void openUrl(uri)))
      // OSC 52, so tmux, vim and ssh sessions can copy to the system clipboard.
      xterm.loadAddon(new ClipboardAddon())
      // Unicode 11 widths: emoji and CJK take two columns, like the shell expects.
      xterm.loadAddon(new Unicode11Addon())
      xterm.unicode.activeVersion = "11"
      xterm.attachCustomKeyEventHandler((event) => {
        const size = zoomed(event, getSettings().termFontSize)
        if (size === null) return true
        if (event.type === "keydown") {
          event.preventDefault()
          // Every terminal follows; the settings effect below refits them.
          updateSettings({ termFontSize: size })
        }
        return false
      })
      xterm.onTitleChange((title) => titleListener.current?.(title))
      xterm.open(element)
      if (getSettings().termGpu) webglRef.current = loadWebgl(xterm, gpuLost)
      fit.fit()
      // A restart comes from a keypress in this terminal, and the first open comes from showing it.
      if (generation > 0 || activeRef.current) xterm.focus()
      fitRef.current = fit
      xtermRef.current = xterm

      const copyOnSelect = () => {
        if (getSettings().termCopyOnSelect && xterm.hasSelection()) {
          void navigator.clipboard.writeText(xterm.getSelection()).catch(() => undefined)
        }
      }
      element.addEventListener("mouseup", copyOnSelect)

      const scope = runtime.runSync(Scope.make())
      let disposed = false
      let ended = false

      void runtime
        .runPromise(
          Effect.gen(function* () {
            const host = yield* TerminalHost
            // After the shell exited, a keypress starts a new one under the same key.
            if (generation > 0) yield* host.close(shellKey)
            const session = yield* host.open({
              key: shellKey,
              cwd,
              cols: xterm.cols,
              rows: xterm.rows,
              onOutput: (bytes) => xterm.write(bytes),
              onExit: () => {
                ended = true
                xterm.write("\r\n\x1b[2mShell exited. Press any key to start a new one.\x1b[0m\r\n")
              },
            })
            const typing = xterm.onData((data) => {
              if (ended) setGeneration((value) => value + 1)
              else void runtime.runPromise(Effect.ignore(session.write(data)))
            })
            const resizing = xterm.onResize(({ cols, rows }) =>
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
          if (!disposed) xterm.write(`\r\n\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`)
        })

      const observer = new ResizeObserver(() => {
        if (element.offsetWidth > 0) fit.fit()
      })
      observer.observe(element)

      return () => {
        disposed = true
        observer.disconnect()
        element.removeEventListener("mouseup", copyOnSelect)
        void runtime.runPromise(Scope.close(scope, Exit.void))
        xterm.dispose()
        xtermRef.current = null
        fitRef.current = null
        webglRef.current = null
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

  // Settings apply to running terminals; a new font is loaded before xterm re-measures.
  useEffect(() => {
    let cancelled = false
    void fontReady(settings).then(() => {
      const xterm = xtermRef.current
      if (cancelled || !xterm) return
      const options = optionsFrom(settings)
      for (const key of Object.keys(options) as Array<keyof ITerminalOptions>) {
        if (xterm.options[key] !== options[key]) Object.assign(xterm.options, { [key]: options[key] })
      }
      if (settings.termGpu && !webglRef.current) webglRef.current = loadWebgl(xterm, gpuLost)
      if (!settings.termGpu && webglRef.current) {
        webglRef.current.dispose()
        webglRef.current = null
      }
      fitRef.current?.fit()
    })
    return () => {
      cancelled = true
    }
  }, [settings])

  useEffect(() => {
    if (!active) return
    fitRef.current?.fit()
    xtermRef.current?.focus()
  }, [active])

  // FitAddon measures the element xterm opens in, padding included, so the padding sits outside it.
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col px-3 pt-1 pb-2", className)}>
      <div ref={container} className="selectable min-h-0 flex-1" />
    </div>
  )
}
