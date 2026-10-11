import { Effect as WindowEffect, EffectState, getCurrentWindow } from "@tauri-apps/api/window"
import { Option, Schema } from "effect"
import { useSyncExternalStore } from "react"

const Between = (minimum: number, maximum: number) =>
  Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum, maximum })))

/** One schema per setting, so a bad stored value only resets that setting. */
const fields = {
  uiFont: Schema.String,
  uiFontSize: Between(11, 16),
  codeFont: Schema.String,
  codeFontSize: Between(9, 24),
  glass: Schema.Boolean,
  /** How much of the dark tint covers the blurred desktop, 0.2–0.95. */
  glassOpacity: Between(0.2, 0.95),
  sendKey: Schema.Literals(["enter", "mod-enter"]),
  diffLayout: Schema.Literals(["unified", "split"]),
  reduceMotion: Schema.Boolean,
  termFont: Schema.String,
  termFontSize: Between(8, 28),
  termLineHeight: Between(1, 2),
  termLetterSpacing: Between(0, 4),
  termFontWeight: Schema.Literals(["300", "400", "500"]),
  termFontWeightBold: Schema.Literals(["600", "700", "800"]),
  termCursorStyle: Schema.Literals(["bar", "block", "underline"]),
  termCursorBlink: Schema.Boolean,
  termCursorInactiveStyle: Schema.Literals(["outline", "block", "bar", "underline", "none"]),
  termBoldBright: Schema.Boolean,
  /** 1 leaves colors alone; 4.5 nudges low-contrast text until it's readable. */
  termMinContrast: Between(1, 21),
  termScrollback: Between(1000, 100000),
  termOptionAsMeta: Schema.Boolean,
  termCopyOnSelect: Schema.Boolean,
  /** WebGL draws crisper glyphs and seamless box lines; off falls back to the DOM renderer. */
  termGpu: Schema.Boolean,
}

export type Settings = { readonly [K in keyof typeof fields]: (typeof fields)[K]["Type"] }

export const defaultSettings: Settings = {
  uiFont: "Geist Variable",
  uiFontSize: 13,
  codeFont: "Geist Mono Variable",
  codeFontSize: 12,
  glass: false,
  glassOpacity: 0.6,
  sendKey: "enter",
  diffLayout: "unified",
  reduceMotion: false,
  termFont: "Geist Mono Variable",
  termFontSize: 12.5,
  termLineHeight: 1.25,
  termLetterSpacing: 0,
  termFontWeight: "400",
  termFontWeightBold: "700",
  termCursorStyle: "bar",
  termCursorBlink: true,
  termCursorInactiveStyle: "outline",
  termBoldBright: true,
  termMinContrast: 1,
  termScrollback: 5000,
  termOptionAsMeta: true,
  termCopyOnSelect: false,
  termGpu: true,
}

export interface FontChoice {
  readonly label: string
  readonly family: string
}

export const uiFonts: ReadonlyArray<FontChoice> = [
  { label: "Geist", family: "Geist Variable" },
  { label: "System (SF Pro)", family: "system-ui" },
  { label: "Helvetica Neue", family: "Helvetica Neue" },
  { label: "Avenir Next", family: "Avenir Next" },
]

export const codeFonts: ReadonlyArray<FontChoice> = [
  { label: "Geist Mono", family: "Geist Mono Variable" },
  { label: "System (SF Mono)", family: "ui-monospace" },
  { label: "Menlo", family: "Menlo" },
  { label: "Monaco", family: "Monaco" },
]

/** A family name as a CSS stack. Generic families stay unquoted; anything missing falls back. */
export const fontStack = (family: string, fallback: string) => {
  const name = family.trim().replace(/["\\]/g, "")
  if (name === "") return fallback
  return /^(system-ui|ui-monospace|ui-sans-serif)$/.test(name) ? `${name}, ${fallback}` : `"${name}", ${fallback}`
}

const UI_FALLBACK = "system-ui, sans-serif"
export const CODE_FALLBACK = "ui-monospace, monospace"

const STORAGE_KEY = "termy.settings"

const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

const readStored = (): Readonly<Record<string, unknown>> => {
  try {
    return Option.getOrElse(decodeStored(localStorage.getItem(STORAGE_KEY)), () => ({}))
  } catch {
    // Storage blocked: every setting takes its default.
    return {}
  }
}

const load = (): Settings => {
  const stored = readStored()
  const settings: Record<string, unknown> = {}
  for (const key of Object.keys(fields) as Array<keyof Settings>) {
    settings[key] = Option.getOrElse(Schema.decodeUnknownOption(fields[key])(stored[key]), () => defaultSettings[key])
  }
  return settings as unknown as Settings
}

let current = load()
const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const getSnapshot = () => current

export const getSettings = getSnapshot

export const useSettings = (): Settings => useSyncExternalStore(subscribe, getSnapshot)

export const updateSettings = (patch: Partial<Settings>) => {
  current = { ...current, ...patch }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
  } catch {
    // Still applies for this session.
  }
  applySettings(current)
  for (const listener of listeners) listener()
}

let glassApplied: boolean | null = null

/** Pushes settings into CSS variables and the native window. Call once at startup, then on every change. */
export const applySettings = (settings: Settings) => {
  const root = document.documentElement
  root.style.setProperty("--ui-font", fontStack(settings.uiFont, UI_FALLBACK))
  root.style.setProperty("--font-scale", String(settings.uiFontSize / defaultSettings.uiFontSize))
  root.style.setProperty("--code-font", fontStack(settings.codeFont, CODE_FALLBACK))
  root.style.setProperty("--code-font-size", `${settings.codeFontSize}px`)
  root.style.setProperty("--glass-opacity", String(settings.glassOpacity))
  root.toggleAttribute("data-glass", settings.glass)
  root.toggleAttribute("data-reduce-motion", settings.reduceMotion)

  if (glassApplied === settings.glass) return
  glassApplied = settings.glass
  // The blur is native (macOS vibrancy); the CSS above only makes the window see-through.
  const window = getCurrentWindow()
  const change = settings.glass
    ? window.setEffects({ effects: [WindowEffect.Sidebar], state: EffectState.FollowsWindowActiveState })
    : window.clearEffects()
  change.catch((error: unknown) => console.warn("Couldn't change the window background", error))
}
