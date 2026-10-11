import type * as acp from "@agentclientprotocol/sdk"
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/24/outline"
import { type CSSProperties, useEffect, useLayoutEffect, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Slider } from "@/components/ui/slider"
import { cn } from "@/lib/utils"

/* Notra's ChatGPT model selector, retinted to the app's amber and fed by ACP config options. */

export interface Choice {
  readonly value: string
  readonly name: string
}

const effortNames: Record<string, string> = { xhigh: "Extra high" }

/** Effort stops for the slider: "default" isn't a level, so it sits out. */
export const effortChoicesOf = (option: acp.SessionConfigOption | undefined): ReadonlyArray<Choice> =>
  choicesOf(option)
    .filter((choice) => choice.value !== "default")
    .map((choice) => ({ ...choice, name: effortNames[choice.value] ?? choice.name }))

/** ACP select options can be flat or grouped; the picker only needs the flat list. */
export const choicesOf = (option: acp.SessionConfigOption | undefined): ReadonlyArray<Choice> => {
  if (!option || option.type !== "select") return []
  return option.options.flatMap((entry) => ("group" in entry ? entry.options : [entry]))
}

const BURST_MS = 1000
/** Half the thumb width, so dots line up with where the thumb stops. */
const THUMB_INSET = "0.875rem"
/** The top stop gets the shimmering fill once there are enough stops for it to mean "max". */
const MIN_STOPS_FOR_MAX = 3

/** Where each burst particle ends up, as an offset from the thumb center in px, plus size in px and delay in ms. */
const SPARKLES = [
  { delay: 0, size: 4, x: -30, y: -26 },
  { delay: 30, size: 3, x: 0, y: -34 },
  { delay: 10, size: 4, x: 30, y: -24 },
  { delay: 50, size: 3, x: -38, y: 2 },
  { delay: 20, size: 3, x: 38, y: 4 },
  { delay: 40, size: 4, x: -28, y: 26 },
  { delay: 0, size: 3, x: 2, y: 34 },
  { delay: 60, size: 4, x: 28, y: 26 },
  { delay: 80, size: 2, x: -18, y: -14 },
  { delay: 70, size: 2, x: 18, y: 16 },
] as const

/** Stars inside the max track: position in % of the track, size in px, and animation timing in ms. */
const TWINKLES = [
  { delay: 0, duration: 3000, size: 2, x: 6, y: 32 },
  { delay: 900, duration: 3600, size: 3, x: 15, y: 66 },
  { delay: 400, duration: 2800, size: 2, x: 24, y: 28 },
  { delay: 1500, duration: 3400, size: 2, x: 33, y: 60 },
  { delay: 700, duration: 3200, size: 3, x: 43, y: 36 },
  { delay: 2100, duration: 3800, size: 2, x: 52, y: 70 },
  { delay: 300, duration: 3000, size: 2, x: 61, y: 30 },
  { delay: 1200, duration: 3500, size: 3, x: 70, y: 62 },
  { delay: 1800, duration: 2900, size: 2, x: 79, y: 34 },
  { delay: 600, duration: 3300, size: 2, x: 87, y: 64 },
] as const

const sliderClassName = [
  "[&_[data-slot=slider-track]]:h-6 [&_[data-slot=slider-track]]:bg-white/8",
  "[&_[data-slot=slider-range]]:bg-amber [&_[data-slot=slider-range]]:before:absolute [&_[data-slot=slider-range]]:before:inset-0 [&_[data-slot=slider-range]]:before:bg-(image:--effort-max-gradient) [&_[data-slot=slider-range]]:before:bg-size-[200%_100%] [&_[data-slot=slider-range]]:before:animate-effort-flow motion-reduce:[&_[data-slot=slider-range]]:before:animate-none [&_[data-slot=slider-range]]:before:opacity-0 [&_[data-slot=slider-range]]:before:transition-opacity [&_[data-slot=slider-range]]:before:duration-500 group-data-[max=true]/slider:[&_[data-slot=slider-range]]:before:opacity-100",
  // Ease the thumb and fill between stops, but follow the pointer 1:1 while dragging.
  "[&_[data-slot=slider-thumb]]:transition-[inset-inline-start,left,scale] [&_[data-slot=slider-thumb]]:duration-300 [&_[data-slot=slider-thumb]]:ease-[cubic-bezier(0.22,1,0.36,1)] [&_[data-slot=slider-range]]:transition-[width,inset-inline-start] [&_[data-slot=slider-range]]:duration-300 [&_[data-slot=slider-range]]:ease-[cubic-bezier(0.22,1,0.36,1)]",
  "group-data-[moving=true]/slider:[&_[data-slot=slider-thumb]]:transition-none group-data-[moving=true]/slider:[&_[data-slot=slider-range]]:transition-none motion-reduce:[&_[data-slot=slider-thumb]]:transition-none motion-reduce:[&_[data-slot=slider-range]]:transition-none [&_[data-slot=slider-thumb]]:active:scale-95",
  "[&_[data-slot=slider-thumb]]:bg-text [&_[data-slot=slider-thumb]]:size-7 [&_[data-slot=slider-thumb]]:border-0 [&_[data-slot=slider-thumb]]:shadow-[0_2px_8px_rgb(0_0_0/0.45)] [&_[data-slot=slider-thumb]]:ring-0 [&_[data-slot=slider-thumb]]:hover:ring-0 [&_[data-slot=slider-thumb]]:active:ring-0 [&_[data-slot=slider-thumb]]:focus-visible:ring-2 [&_[data-slot=slider-thumb]]:focus-visible:ring-amber/60",
].join(" ")

const useElementSize = <E extends HTMLElement>(dimension: "offsetHeight" | "offsetWidth") => {
  const [element, setElement] = useState<E | null>(null)
  const [size, setSize] = useState<number>()

  useLayoutEffect(() => {
    if (!element) return
    // offset sizes ignore the popup's zoom-in scale, unlike getBoundingClientRect.
    setSize(element[dimension])
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize((entry.target as HTMLElement)[dimension])
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, dimension])

  return [size, setElement] as const
}

const EffortName = ({ effort, max }: { effort: Choice; max: boolean }) =>
  max ? <span className="text-amber">{effort.name}</span> : <span>{effort.name}</span>

interface Props {
  readonly models: ReadonlyArray<Choice>
  readonly model: string | undefined
  readonly onModelChange: (value: string) => void
  readonly efforts: ReadonlyArray<Choice>
  readonly effort: string | undefined
  readonly onEffortChange: (value: string) => void
  readonly disabled?: boolean
}

export const ModelEffortSelector = ({
  models,
  model,
  onModelChange,
  efforts,
  effort,
  onEffortChange,
  disabled,
}: Props) => {
  const [open, setOpen] = useState(false)
  const hasEfforts = efforts.length > 1
  const [view, setView] = useState<"effort" | "models">("effort")
  // Both views stay mounted in one grid cell, so the popup never changes size. Only the
  // background card animates its height, which avoids the positioner lagging a frame behind.
  const [effortHeight, effortRef] = useElementSize<HTMLDivElement>("offsetHeight")
  const [modelsHeight, modelsRef] = useElementSize<HTMLDivElement>("offsetHeight")
  const cardHeight = view === "effort" ? effortHeight : modelsHeight

  // The card only animates after its first measurement, so opening never plays a resize.
  const [cardReady, setCardReady] = useState(false)
  useEffect(() => {
    if (!open) {
      setCardReady(false)
      return
    }
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setCardReady(true)))
    return () => cancelAnimationFrame(frame)
  }, [open])

  const [moving, setMoving] = useState(false)

  // The burst plays once when the slider lands on the top stop, not whenever the view remounts.
  const [burstActive, setBurstActive] = useState(false)
  useEffect(() => {
    if (!burstActive) return
    const timer = window.setTimeout(() => setBurstActive(false), BURST_MS)
    return () => window.clearTimeout(timer)
  }, [burstActive])

  // Both trigger labels stay mounted and crossfade while the trigger eases between their
  // widths, so opening and closing never snap the trigger's size.
  const [closedLabelWidth, closedLabelRef] = useElementSize<HTMLSpanElement>("offsetWidth")
  const [openLabelWidth, openLabelRef] = useElementSize<HTMLSpanElement>("offsetWidth")
  const labelWidth = open ? openLabelWidth : closedLabelWidth

  const selectedModel = models.find((choice) => choice.value === model)
  const effortIndex = Math.max(
    efforts.findIndex((choice) => choice.value === effort),
    0,
  )
  const selectedEffort = efforts[effortIndex]
  const lastIndex = Math.max(efforts.length - 1, 1)
  const maxIndex = efforts.length >= MIN_STOPS_FOR_MAX ? efforts.length - 1 : -1
  const isMax = hasEfforts && effortIndex === maxIndex

  if (models.length === 0 && !hasEfforts) return null

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) setView(hasEfforts ? "effort" : "models")
  }

  const handleSlide = (value: number | readonly number[]) => {
    const index = Array.isArray(value) ? value[0] : value
    const next = efforts[index as number]
    if (next && next.value !== effort) {
      setBurstActive(index === maxIndex)
      onEffortChange(next.value)
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={[selectedModel?.name, hasEfforts && selectedEffort?.name].filter(Boolean).join(", ")}
        className="group/selector text-text-2 hover:text-text aria-expanded:text-text flex h-7 items-center gap-1.5 rounded-full px-3 text-xs transition-[background-color,scale] duration-150 hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-amber/35 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50 aria-expanded:bg-white/5 motion-reduce:transition-none"
      >
        <span
          className="relative block h-4 overflow-hidden transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
          style={{ width: labelWidth }}
        >
          <span
            ref={closedLabelRef}
            className={cn(
              "absolute inset-y-0 left-0 flex items-center gap-1.5 whitespace-nowrap transition-opacity duration-200 motion-reduce:transition-none",
              open ? "opacity-0" : "opacity-100",
            )}
          >
            {selectedModel && <span className="text-text">{selectedModel.name}</span>}
            {hasEfforts && selectedEffort && <EffortName effort={selectedEffort} max={isMax} />}
          </span>
          <span
            ref={openLabelRef}
            aria-hidden={!open}
            className={cn(
              "absolute inset-y-0 left-0 flex items-center whitespace-nowrap transition-opacity duration-200 motion-reduce:transition-none",
              open ? "opacity-100" : "opacity-0",
            )}
          >
            {hasEfforts ? "Thinking effort" : "Model"}
          </span>
        </span>
        <ChevronDownIcon className="text-text-3 size-3.5 transition-transform duration-150 group-aria-expanded/selector:rotate-180 motion-reduce:transition-none" />
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="text-text data-open:zoom-in-90 data-closed:zoom-out-95 w-64 gap-0 rounded-3xl bg-transparent p-0 shadow-none ring-0 duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] data-closed:duration-[240ms] data-closed:ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:duration-0"
      >
        <div className="relative grid">
          <div
            aria-hidden
            className={cn(
              "absolute inset-x-0 bottom-0 rounded-3xl bg-popover/97 shadow-popover backdrop-blur-xl",
              cardReady && "transition-[height] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
            )}
            style={{ height: cardHeight ?? "100%" }}
          />

          {hasEfforts && (
            <div
              ref={effortRef}
              inert={view !== "effort"}
              className={cn(
                "relative col-start-1 row-start-1 flex flex-col gap-2 self-end p-3 transition-[opacity,filter,translate] motion-reduce:transition-none",
                view === "effort"
                  ? "blur-0 translate-y-0 opacity-100 delay-50 duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
                  : "pointer-events-none -translate-y-3 opacity-0 blur-[4px] duration-[180ms] ease-[cubic-bezier(0.4,0,0.2,1)]",
              )}
            >
              {models.length > 0 ? (
                <button
                  type="button"
                  aria-label={`Model: ${selectedModel?.name ?? "default"}. Change model`}
                  onClick={() => setView("models")}
                  className="text-text mx-auto flex h-7 items-center gap-1 rounded-full px-3 text-ui transition-colors hover:bg-white/6 focus-visible:ring-2 focus-visible:ring-amber/35"
                >
                  {selectedModel?.name ?? "Choose model"}
                  <ChevronRightIcon className="text-text-3 size-3.5" strokeWidth={2} />
                </button>
              ) : (
                <span className="text-text mx-auto flex h-7 items-center text-ui">
                  {selectedEffort && <EffortName effort={selectedEffort} max={isMax} />}
                </span>
              )}
              <div
                data-moving={moving}
                data-max={isMax}
                className="group/slider relative px-0.5 pt-0.5 pb-1"
                // Clicking a stop eases the thumb there; only a real drag follows the pointer 1:1.
                onPointerCancel={() => setMoving(false)}
                onPointerDown={() => setMoving(false)}
                onPointerMove={(event) => {
                  if (event.buttons > 0) setMoving(true)
                }}
                onPointerUp={() => setMoving(false)}
              >
                <Slider
                  aria-label="Thinking effort"
                  className={sliderClassName}
                  min={0}
                  max={efforts.length - 1}
                  step={1}
                  value={[effortIndex]}
                  onValueChange={handleSlide}
                />
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0.5 top-0.5 bottom-1 z-10 transition-opacity duration-500 group-data-[max=true]/slider:opacity-0 motion-reduce:transition-none"
                >
                  {efforts.map((choice, index) =>
                    index === effortIndex ? null : (
                      <span
                        key={choice.value}
                        className={cn(
                          "absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-300",
                          index < effortIndex ? "bg-amber-ink/45" : "bg-white/25",
                        )}
                        style={{ left: `calc(${THUMB_INSET} + (100% - 2 * ${THUMB_INSET}) * ${index / lastIndex})` }}
                      />
                    ),
                  )}
                </div>
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0.5 top-0.5 bottom-1 z-10 opacity-0 transition-opacity duration-500 group-data-[max=true]/slider:opacity-100 motion-reduce:transition-none"
                >
                  {TWINKLES.map((star) => (
                    <span
                      key={`${star.x}:${star.y}`}
                      className="animate-effort-twinkle absolute rounded-full bg-white opacity-0 shadow-[0_0_4px_1px_rgb(255_255_255/0.7)] motion-reduce:animate-none motion-reduce:opacity-60"
                      style={{
                        animationDelay: `${star.delay}ms`,
                        animationDuration: `${star.duration}ms`,
                        height: star.size,
                        left: `${star.x}%`,
                        top: `${star.y}%`,
                        width: star.size,
                      }}
                    />
                  ))}
                </div>
                {isMax && burstActive && (
                  <div aria-hidden className="pointer-events-none absolute inset-x-0.5 top-0.5 bottom-1 z-10">
                    <div className="absolute size-0" style={{ left: `calc(100% - ${THUMB_INSET})`, top: "50%" }}>
                      {SPARKLES.map((sparkle) => (
                        <span
                          key={`${sparkle.x}:${sparkle.y}`}
                          className="animate-effort-burst bg-amber absolute -top-px -left-px rounded-full opacity-0 motion-reduce:hidden"
                          style={
                            {
                              "--burst-x": `${sparkle.x}px`,
                              "--burst-y": `${sparkle.y}px`,
                              animationDelay: `${sparkle.delay}ms`,
                              height: sparkle.size,
                              width: sparkle.size,
                            } as CSSProperties
                          }
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          <div
            ref={modelsRef}
            inert={view !== "models"}
            className={cn(
              "relative col-start-1 row-start-1 flex flex-col self-end p-2 transition-[opacity,filter,translate] motion-reduce:transition-none",
              view === "models"
                ? "blur-0 translate-y-0 opacity-100 delay-50 duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
                : "pointer-events-none translate-y-3 opacity-0 blur-[4px] duration-[180ms] ease-[cubic-bezier(0.4,0,0.2,1)]",
            )}
          >
            <div role="radiogroup" aria-label="Model" className="flex max-h-72 flex-col overflow-y-auto">
              {models.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  role="radio"
                  aria-checked={choice.value === model}
                  onClick={() => {
                    if (choice.value !== model) onModelChange(choice.value)
                    if (hasEfforts) setView("effort")
                    else setOpen(false)
                  }}
                  className="text-text flex h-9 shrink-0 items-center justify-between gap-3 rounded-xl px-3 text-start text-ui transition-colors hover:bg-white/6 focus-visible:ring-2 focus-visible:ring-amber/35"
                >
                  <span className="truncate">{choice.name}</span>
                  {choice.value === model && <CheckIcon className="size-4 shrink-0" strokeWidth={1.75} />}
                </button>
              ))}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
