import type { PlusIcon } from "@heroicons/react/24/outline"
import { cn } from "@/lib/utils"

/** Any Heroicon; they all share one component type. */
export type HeroIcon = typeof PlusIcon

/** The amber LED. The one place the accent means "live". */
export const Led = ({ className }: { className?: string }) => (
  <span className={cn("led animate-led inline-block size-1.5 shrink-0 rounded-full", className)} />
)

/** Four bars, lit up to the current effort level. */
export const EffortMeter = ({ level, of, size = "sm" }: { level: number; of: number; size?: "sm" | "md" }) => {
  const bars = Math.max(of, 1)
  const height = size === "sm" ? 10 : 14
  return (
    <span className="flex shrink-0 items-end gap-[2px]" style={{ height }} aria-hidden>
      {Array.from({ length: bars }, (_, index) => (
        <span
          key={index}
          className={cn("rounded-[1px]", index <= level ? "bg-amber" : "bg-text-3")}
          style={{
            width: size === "sm" ? 2 : 3,
            height: Math.round(height * ((index + 1) / bars) * 0.75 + height * 0.25),
          }}
        />
      ))}
    </span>
  )
}

export const Kbd = ({ children }: { children: React.ReactNode }) => (
  <span className="text-text-3 text-2xs">{children}</span>
)

export const Diffstat = ({ additions, deletions }: { additions: number; deletions: number }) => (
  <span className="flex items-center gap-1.5 text-2xs tabular-nums">
    {additions > 0 && <span className="text-add">+{additions}</span>}
    {deletions > 0 && <span className="text-remove">-{deletions}</span>}
  </span>
)

const units: ReadonlyArray<readonly [number, string]> = [
  [7 * 24 * 60 * 60 * 1000, "w"],
  [24 * 60 * 60 * 1000, "d"],
  [60 * 60 * 1000, "h"],
  [60 * 1000, "m"],
]

export const relativeTime = (timestamp: number, now = Date.now()) => {
  const elapsed = Math.max(now - timestamp, 0)
  for (const [size, unit] of units) {
    if (elapsed >= size) return `${Math.floor(elapsed / size)}${unit}`
  }
  return "now"
}

export const formatElapsed = (ms: number) => {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}
