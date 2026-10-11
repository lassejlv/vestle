import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

interface WidthBounds {
  readonly initial: number
  readonly min: number
  readonly max: number
}

const clamp = (width: number, { min, max }: WidthBounds) => Math.round(Math.min(max, Math.max(min, width)))

const storedWidth = (key: string, bounds: WidthBounds) => {
  try {
    const value = Number(localStorage.getItem(key))
    return value > 0 ? clamp(value, bounds) : bounds.initial
  } catch {
    return bounds.initial
  }
}

/** A panel width the user drags, remembered across launches. */
export const usePanelWidth = (key: string, bounds: WidthBounds) => {
  const [width, setWidth] = useState(() => storedWidth(key, bounds))

  useEffect(() => {
    try {
      localStorage.setItem(key, String(width))
    } catch {
      // The width still applies for this session.
    }
  }, [key, width])

  return {
    width,
    resize: (next: number) => setWidth(clamp(next, bounds)),
    reset: () => setWidth(bounds.initial),
  }
}

/**
 * A draggable strip on one edge of a panel. `edge` is the side of the panel it sits on,
 * so dragging away from the panel grows it. Double-click resets.
 */
export const ResizeHandle = ({
  edge,
  width,
  onResize,
  onReset,
  className,
}: {
  edge: "left" | "right"
  width: number
  onResize: (width: number) => void
  onReset: () => void
  className?: string
}) => {
  const drag = useRef<{ x: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={width}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { x: event.clientX, width }
          setDragging(true)
        }}
        onPointerMove={(event) => {
          if (!drag.current) return
          const delta = event.clientX - drag.current.x
          onResize(drag.current.width + (edge === "right" ? delta : -delta))
        }}
        onLostPointerCapture={() => {
          drag.current = null
          setDragging(false)
        }}
        onDoubleClick={onReset}
        className={cn(
          "group absolute inset-y-0 z-10 w-2 cursor-col-resize",
          edge === "right" ? "-right-1" : "-left-2",
          className,
        )}
      >
        <span
          className={cn(
            "absolute inset-y-2 left-1/2 w-px -translate-x-1/2 transition-colors duration-150",
            dragging ? "bg-white/20" : "group-hover:bg-white/10",
          )}
        />
      </div>
      {/* Keeps the resize cursor and stops terminals and text reacting while dragging. */}
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </>
  )
}
