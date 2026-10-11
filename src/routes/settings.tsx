import { createFileRoute } from "@tanstack/react-router"
import { Effect } from "effect"
import { CheckIcon, ChevronDownIcon, MinusIcon, PlusIcon } from "@heroicons/react/24/outline"
import { type ReactNode, useCallback, useEffect, useState } from "react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Slider } from "@/components/ui/slider"
import {
  CODE_FALLBACK,
  codeFonts,
  defaultSettings,
  type FontChoice,
  fontStack,
  type Settings,
  updateSettings,
  uiFonts,
  useSettings,
} from "@/lib/settings"
import { useRun, useWorkspace } from "@/lib/runtime"
import { cn } from "@/lib/utils"
import type { BackgroundStatus } from "@/services/Workspace"
import { updates, useUpdateState } from "@/lib/updates"
import { version } from "../../package.json"

const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-2">
    <h2 className="text-text-3 px-1 text-xs font-medium">{title}</h2>
    <div className="shadow-hairline flex flex-col divide-y divide-white/5 rounded-xl bg-white/[0.02]">{children}</div>
  </section>
)

const Row = ({ label, detail, children }: { label: string; detail?: string; children: ReactNode }) => (
  <div className="flex min-h-14 items-center gap-6 px-4 py-3">
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-text text-ui">{label}</span>
      {detail && <span className="text-text-3 text-xs leading-5">{detail}</span>}
    </div>
    <div className="flex shrink-0 items-center gap-2">{children}</div>
  </div>
)

const Segmented = <T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: ReadonlyArray<{ readonly value: T; readonly label: string }>
  onChange: (value: T) => void
}) => (
  <div className="bg-panel shadow-hairline flex items-center gap-0.5 rounded-[9px] p-0.5">
    {options.map((option) => (
      <button
        key={option.value}
        type="button"
        onClick={() => onChange(option.value)}
        aria-pressed={value === option.value}
        className={cn(
          "h-[26px] rounded-[7px] px-3 text-xs transition-colors",
          value === option.value ? "bg-hover text-text shadow-segment font-medium" : "text-text-2 hover:text-text",
        )}
      >
        {option.label}
      </button>
    ))}
  </div>
)

const Switch = ({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={() => onChange(!checked)}
    className={cn(
      "relative h-[18px] w-8 rounded-full transition-colors",
      checked ? "bg-amber" : "shadow-hairline bg-white/10",
    )}
  >
    <span
      className={cn(
        "absolute top-0.5 left-0.5 size-3.5 rounded-full shadow-[0_1px_2px_rgb(0_0_0/0.4)] transition-transform",
        checked ? "bg-amber-ink translate-x-3.5" : "bg-text-2",
      )}
    />
  </button>
)

/** Rounds away float drift, so 1.2 + 0.05 stays 1.25. */
const stepBy = (value: number, step: number) => Math.round(value * 1000 + step * 1000) / 1000

const Stepper = ({
  value,
  min,
  max,
  onChange,
  label,
  step = 1,
  format = (value) => `${value}px`,
}: {
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  label: string
  step?: number
  format?: (value: number) => string
}) => (
  <div className="bg-panel shadow-hairline flex h-[30px] items-center rounded-[9px] p-0.5">
    <button
      type="button"
      aria-label={`Smaller ${label}`}
      disabled={value <= min}
      onClick={() => onChange(Math.max(stepBy(value, -step), min))}
      className="text-text-2 hover:text-text hover:bg-hover flex size-[26px] items-center justify-center rounded-[7px] disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <MinusIcon className="size-3.5" />
    </button>
    <span className="text-text w-14 text-center text-xs tabular-nums">{format(value)}</span>
    <button
      type="button"
      aria-label={`Larger ${label}`}
      disabled={value >= max}
      onClick={() => onChange(Math.min(stepBy(value, step), max))}
      className="text-text-2 hover:text-text hover:bg-hover flex size-[26px] items-center justify-center rounded-[7px] disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <PlusIcon className="size-3.5" />
    </button>
  </div>
)

/** Preset fonts, plus any installed font typed by name. Each option previews in its own face. */
const FontPicker = ({
  value,
  choices,
  fallback,
  onChange,
}: {
  value: string
  choices: ReadonlyArray<FontChoice>
  fallback: string
  onChange: (family: string) => void
}) => {
  const preset = choices.find((choice) => choice.family === value)
  // Stays on after picking Custom, even if the typed name happens to match a preset.
  const [custom, setCustom] = useState(!preset)
  return (
    <>
      {custom && (
        <input
          autoFocus={value === ""}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Font name"
          spellCheck={false}
          className="bg-panel shadow-hairline text-text placeholder:text-text-3 focus-visible:ring-amber/35 h-[30px] w-40 rounded-[9px] px-2.5 text-xs outline-none focus-visible:ring-2"
          style={{ fontFamily: fontStack(value, fallback) }}
        />
      )}
      <DropdownMenu>
        <DropdownMenuTrigger className="bg-panel shadow-hairline text-text hover:bg-hover aria-expanded:bg-hover flex h-[30px] min-w-36 items-center justify-between gap-2 rounded-[9px] px-2.5 text-xs transition-colors">
          <span style={preset ? { fontFamily: fontStack(preset.family, fallback) } : undefined}>
            {preset?.label ?? "Custom"}
          </span>
          <ChevronDownIcon className="text-text-3 size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-44 rounded-xl p-1">
          {choices.map((choice) => (
            <DropdownMenuItem
              key={choice.family}
              onClick={() => {
                setCustom(false)
                onChange(choice.family)
              }}
              className="h-8 gap-2.5 rounded-lg"
            >
              <span className="text-text flex-1 text-xs" style={{ fontFamily: fontStack(choice.family, fallback) }}>
                {choice.label}
              </span>
              <span className="flex size-4 shrink-0 items-center">
                {!custom && choice.family === value && <CheckIcon className="text-amber size-3.5" />}
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              setCustom(true)
              if (preset) onChange("")
            }}
            className="h-8 gap-2.5 rounded-lg"
          >
            <span className="text-text flex-1 text-xs">Custom font…</span>
            <span className="flex size-4 shrink-0 items-center">
              {custom && <CheckIcon className="text-amber size-3.5" />}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`

const Updates = () => {
  const state = useUpdateState()
  const ready = state.phase === "ready" || state.phase === "restart"
  const busy = ["disabled", "checking", "downloading", "installing"].includes(state.phase)
  const detail = state.message ?? (
    state.phase === "disabled" ? "Automatic updates are available in installed macOS release builds."
      : state.phase === "checking" ? "Checking for updates…"
      : state.phase === "downloading" ? `Downloading ${state.version}${state.progress === undefined ? "…" : ` · ${state.progress}%`}`
      : state.phase === "installing" ? "Installing and restarting…"
      : ready ? `${state.version} is ready. Restart when you’re ready to continue.`
      : state.checkedAt ? "You’re up to date. Updates are checked and downloaded automatically."
      : "Updates are checked and downloaded automatically. You choose when to restart."
  )
  return (
    <Group title="Updates">
      <Row label={`Termy Code ${version}`} detail={detail}>
        <button
          type="button"
          disabled={busy}
          onClick={() => { void (ready ? updates.restart() : updates.check()) }}
          className="text-text-2 hover:text-text hover:bg-white/6 h-7 rounded-lg px-3 text-xs transition-colors disabled:opacity-40"
        >
          {ready ? "Restart to update" : state.phase === "error" ? "Try again" : "Check for updates"}
        </button>
      </Row>
    </Group>
  )
}

/** The daemon that keeps agents and shells running after the window closes. */
const Background = () => {
  const workspace = useWorkspace()
  const run = useRun()
  const [status, setStatus] = useState<BackgroundStatus | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [restarting, setRestarting] = useState(false)

  const refresh = useCallback(() => {
    // Polled, so a failure shouldn't toast every few seconds; the row just keeps its last value.
    void run(Effect.option(workspace.backgroundStatus())).then((next) => {
      if (next?._tag === "Some") setStatus(next.value)
    })
  }, [run, workspace])

  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, 3000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const restart = async () => {
    setRestarting(true)
    setConfirming(false)
    await run(workspace.restartBackground())
    setRestarting(false)
    refresh()
  }

  const busy = status !== null && status.agents + status.shells > 0
  return (
    <Group title="Background">
      <Row
        label="Running in the background"
        detail="Agents and terminals keep working after you quit Termy Code, and pick up where they are when you open it again."
      >
        <span className="text-text-2 text-xs tabular-nums">
          {status === null ? "Connecting…" : `${count(status.agents, "agent")}, ${count(status.shells, "terminal")}`}
        </span>
      </Row>
      {status?.stale && (
        <Row
          label="From an older build"
          detail="The background service was kept running from a previous build because it had work in progress. Restart it to use this build's."
        >
          <span className="bg-amber size-1.5 rounded-full" />
        </Row>
      )}
      <Row
        label="Stop everything"
        detail={
          confirming
            ? "This stops every running agent and terminal. Unsaved agent work is lost."
            : "Stops all background agents and terminals and restarts the service."
        }
      >
        {confirming && (
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="text-text-2 hover:text-text hover:bg-white/6 h-7 rounded-lg px-3 text-xs transition-colors"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          disabled={restarting}
          onClick={() => (confirming || !busy ? void restart() : setConfirming(true))}
          className={cn(
            "h-7 rounded-lg px-3 text-xs transition-colors disabled:opacity-50",
            confirming ? "bg-remove/15 text-remove hover:bg-remove/25" : "text-text bg-white/8 hover:bg-white/12",
          )}
        >
          {restarting ? "Restarting…" : confirming ? "Stop and restart" : "Restart"}
        </button>
      </Row>
    </Group>
  )
}

const SettingsView = () => {
  const settings = useSettings()
  // Remounts the font pickers on reset, so they drop out of custom mode.
  const [resets, setResets] = useState(0)
  const set = <K extends keyof Settings>(key: K) => (value: Settings[K]) => updateSettings({ [key]: value })
  const isDefault = (Object.keys(defaultSettings) as Array<keyof Settings>).every(
    (key) => settings[key] === defaultSettings[key],
  )

  return (
    <section className="surface relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl">
      <header data-tauri-drag-region className="h-12 shrink-0" />
      <div className="min-h-0 flex-1 overflow-y-auto px-10 pb-12">
        <div className="mx-auto flex w-full max-w-[600px] flex-col gap-8">
          <div className="flex flex-col gap-1 px-1">
            <h1 className="text-text text-title font-semibold tracking-[-0.01em]">Settings</h1>
            <p className="text-text-3 text-xs">Saved on this Mac and applied right away.</p>
          </div>

          <Group title="Appearance">
            <Row label="Interface font">
              <FontPicker
                key={`ui-${resets}`}
                value={settings.uiFont}
                choices={uiFonts}
                fallback="system-ui, sans-serif"
                onChange={set("uiFont")}
              />
            </Row>
            <Row label="Interface font size" detail="Scales all text in the app.">
              <Stepper value={settings.uiFontSize} min={11} max={16} onChange={set("uiFontSize")} label="interface font" />
            </Row>
            <Row label="Code font" detail="Code blocks and diffs.">
              <FontPicker
                key={`code-${resets}`}
                value={settings.codeFont}
                choices={codeFonts}
                fallback={CODE_FALLBACK}
                onChange={set("codeFont")}
              />
            </Row>
            <Row label="Code font size">
              <Stepper value={settings.codeFontSize} min={9} max={24} onChange={set("codeFontSize")} label="code font" />
            </Row>
            <Row label="Transparent background" detail="Blurs the desktop behind the window.">
              <Switch checked={settings.glass} onChange={set("glass")} label="Transparent background" />
            </Row>
            {settings.glass && (
              <Row label="Tint" detail="Lower shows more of the desktop.">
                <Slider
                  className="w-40"
                  min={20}
                  max={95}
                  value={[Math.round(settings.glassOpacity * 100)]}
                  onValueChange={(value) => {
                    const next = Array.isArray(value) ? value[0] : value
                    if (typeof next === "number") updateSettings({ glassOpacity: next / 100 })
                  }}
                />
                <span className="text-text-2 w-9 text-right text-xs tabular-nums">
                  {Math.round(settings.glassOpacity * 100)}%
                </span>
              </Row>
            )}
            <Row label="Reduce motion" detail="Turns off shimmer, pulsing and streaming text animation.">
              <Switch checked={settings.reduceMotion} onChange={set("reduceMotion")} label="Reduce motion" />
            </Row>
          </Group>

          <Group title="Terminal">
            <Row label="Font">
              <FontPicker
                key={`term-${resets}`}
                value={settings.termFont}
                choices={codeFonts}
                fallback={CODE_FALLBACK}
                onChange={set("termFont")}
              />
            </Row>
            <Row label="Font size" detail="⌘+, ⌘− and ⌘0 in a terminal change it too.">
              <Stepper
                value={settings.termFontSize}
                min={8}
                max={28}
                step={0.5}
                onChange={set("termFontSize")}
                label="terminal font"
              />
            </Row>
            <Row label="Line height">
              <Stepper
                value={settings.termLineHeight}
                min={1}
                max={2}
                step={0.05}
                format={(value) => value.toFixed(2)}
                onChange={set("termLineHeight")}
                label="line height"
              />
            </Row>
            <Row label="Letter spacing">
              <Stepper
                value={settings.termLetterSpacing}
                min={0}
                max={4}
                step={0.5}
                onChange={set("termLetterSpacing")}
                label="letter spacing"
              />
            </Row>
            <Row label="Font weight">
              <Segmented
                value={settings.termFontWeight}
                options={[
                  { value: "300", label: "Light" },
                  { value: "400", label: "Regular" },
                  { value: "500", label: "Medium" },
                ]}
                onChange={set("termFontWeight")}
              />
            </Row>
            <Row label="Bold weight">
              <Segmented
                value={settings.termFontWeightBold}
                options={[
                  { value: "600", label: "Semibold" },
                  { value: "700", label: "Bold" },
                  { value: "800", label: "Heavy" },
                ]}
                onChange={set("termFontWeightBold")}
              />
            </Row>
            <Row label="Bold text in bright colors">
              <Switch checked={settings.termBoldBright} onChange={set("termBoldBright")} label="Bold text in bright colors" />
            </Row>
            <Row label="Cursor">
              <Segmented
                value={settings.termCursorStyle}
                options={[
                  { value: "bar", label: "Bar" },
                  { value: "block", label: "Block" },
                  { value: "underline", label: "Underline" },
                ]}
                onChange={set("termCursorStyle")}
              />
            </Row>
            <Row label="Cursor when unfocused">
              <Segmented
                value={settings.termCursorInactiveStyle}
                options={[
                  { value: "outline", label: "Outline" },
                  { value: "bar", label: "Bar" },
                  { value: "underline", label: "Underline" },
                  { value: "none", label: "Hidden" },
                ]}
                onChange={set("termCursorInactiveStyle")}
              />
            </Row>
            <Row label="Blinking cursor">
              <Switch checked={settings.termCursorBlink} onChange={set("termCursorBlink")} label="Blinking cursor" />
            </Row>
            <Row label="Readable contrast" detail="Brightens colors that are hard to read on the background.">
              <Switch
                checked={settings.termMinContrast > 1}
                onChange={(on) => updateSettings({ termMinContrast: on ? 4.5 : 1 })}
                label="Readable contrast"
              />
            </Row>
            <Row label="Scrollback" detail="Lines kept above the screen.">
              <Segmented
                value={String(settings.termScrollback)}
                options={[
                  { value: "1000", label: "1k" },
                  { value: "5000", label: "5k" },
                  { value: "10000", label: "10k" },
                  { value: "50000", label: "50k" },
                  { value: "100000", label: "100k" },
                ]}
                onChange={(value) => updateSettings({ termScrollback: Number(value) })}
              />
            </Row>
            <Row label="Option key as Meta" detail="Off types special characters like å and ∂ instead.">
              <Switch checked={settings.termOptionAsMeta} onChange={set("termOptionAsMeta")} label="Option key as Meta" />
            </Row>
            <Row label="Copy on select">
              <Switch checked={settings.termCopyOnSelect} onChange={set("termCopyOnSelect")} label="Copy on select" />
            </Row>
            <Row label="GPU rendering" detail="Sharper text and seamless box lines. Turn off if text looks wrong.">
              <Switch checked={settings.termGpu} onChange={set("termGpu")} label="GPU rendering" />
            </Row>
          </Group>

          <Updates />
          <Background />

          <Group title="Behavior">
            <Row label="Send messages with" detail="The other key adds a new line.">
              <Segmented
                value={settings.sendKey}
                options={[
                  { value: "enter", label: "Enter" },
                  { value: "mod-enter", label: "⌘ Enter" },
                ]}
                onChange={set("sendKey")}
              />
            </Row>
            <Row label="Diff layout">
              <Segmented
                value={settings.diffLayout}
                options={[
                  { value: "unified", label: "Unified" },
                  { value: "split", label: "Split" },
                ]}
                onChange={set("diffLayout")}
              />
            </Row>
          </Group>

          <div className="flex justify-end">
            <button
              type="button"
              disabled={isDefault}
              onClick={() => {
                updateSettings(defaultSettings)
                setResets((count) => count + 1)
              }}
              className="text-text-2 hover:text-text hover:bg-white/6 h-7 rounded-lg px-3 text-xs transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Reset to defaults
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

export const Route = createFileRoute("/settings")({ component: SettingsView })
