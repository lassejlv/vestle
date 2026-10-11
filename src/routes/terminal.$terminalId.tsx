import { createFileRoute } from "@tanstack/react-router"

// Terminal tabs stay mounted in the root layout so their shells survive tab
// switches; this route only marks which one is showing.
export const Route = createFileRoute("/terminal/$terminalId")({ component: () => null })
