import { type ClassValue, clsx } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/** Knows the type scale and shadows from index.css, so `text-ui` isn't taken for a color. */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["2xs", "ui", "title", "display", "code"],
      shadow: ["hairline", "outline", "raised", "segment", "popover", "dialog", "composer", "composer-drop", "amber"],
    },
  },
})

export const cn = (...inputs: Array<ClassValue>) => twMerge(clsx(inputs))
