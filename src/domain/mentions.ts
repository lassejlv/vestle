/** Something the prompt points the agent at: a project file (`@`) or a skill (`$`). */
export interface Mention {
  readonly kind: "file" | "skill"
  /** What the agent sees as the link text. */
  readonly name: string
  /** Absolute path; a skill points at its SKILL.md. */
  readonly path: string
  /** The text inserted into the prompt, e.g. `@src/main.ts` or `$frontend-design`. */
  readonly token: string
}

export interface Skill {
  readonly name: string
  readonly description: string
  readonly path: string
  readonly scope: "project" | "user"
}

/** What the picker is completing: an `@` file, a `$` skill, or a `/` command at the start of the message. */
export type QueryKind = Mention["kind"] | "command"

/** The mention or command being typed right before the caret, if any. */
export const activeQuery = (text: string, caret: number): { kind: QueryKind; query: string; start: number } | null => {
  const before = text.slice(0, caret)
  const command = /^\/(\S*)$/.exec(before)
  if (command) return { kind: "command", query: command[1] ?? "", start: 0 }
  const match = /(?:^|\s)([@$])([^\s@$]*)$/.exec(before)
  if (!match) return null
  const [, trigger = "", query = ""] = match
  return { kind: trigger === "@" ? "file" : "skill", query, start: caret - query.length - 1 }
}

/** `frontend-design` → `Frontend Design`. */
export const skillTitle = (name: string) =>
  name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")

/** Lower is better; `null` means no match. Prefers name prefixes, then substrings, then in-order letters. */
const score = (candidate: string, query: string): number | null => {
  const text = candidate.toLowerCase()
  if (text.startsWith(query)) return 0
  const index = text.indexOf(query)
  if (index >= 0) return 1 + index / 1000
  let position = 0
  for (const character of query) {
    position = text.indexOf(character, position)
    if (position < 0) return null
    position += 1
  }
  return 3
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1)

/** Best file matches for a query, by file name first and then by whole path. */
export const rankFiles = (files: ReadonlyArray<string>, query: string, limit: number): ReadonlyArray<string> => {
  const needle = query.toLowerCase()
  if (!needle) return [...files].sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length).slice(0, limit)
  const ranked: Array<readonly [string, number]> = []
  for (const file of files) {
    const byName = score(basename(file), needle)
    const byPath = score(file, needle)
    const best = byName ?? (byPath === null ? null : byPath + 2)
    if (best !== null) ranked.push([file, best])
  }
  return ranked
    .sort(([a, x], [b, y]) => x - y || a.length - b.length)
    .slice(0, limit)
    .map(([file]) => file)
}

export const rankByName = <A extends { readonly name: string }>(
  choices: ReadonlyArray<A>,
  query: string,
  limit: number,
): ReadonlyArray<A> => {
  const needle = query.toLowerCase()
  if (!needle) return choices.slice(0, limit)
  const ranked: Array<readonly [A, number]> = []
  for (const choice of choices) {
    const best = score(choice.name, needle)
    if (best !== null) ranked.push([choice, best])
  }
  return ranked
    .sort(([a, x], [b, y]) => x - y || a.name.length - b.name.length)
    .slice(0, limit)
    .map(([choice]) => choice)
}

export const rankSkills = (skills: ReadonlyArray<Skill>, query: string, limit: number): ReadonlyArray<Skill> => {
  const needle = query.toLowerCase()
  if (!needle) return skills.slice(0, limit)
  const ranked: Array<readonly [Skill, number]> = []
  for (const skill of skills) {
    const best = score(skill.name, needle) ?? score(skillTitle(skill.name), needle)
    if (best !== null) ranked.push([skill, best])
  }
  return ranked
    .sort(([a, x], [b, y]) => x - y || a.name.length - b.name.length)
    .slice(0, limit)
    .map(([skill]) => skill)
}
