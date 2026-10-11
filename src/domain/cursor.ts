import type * as acp from "@agentclientprotocol/sdk"
import { Schema } from "effect"

/** Cursor's ACP extension methods. https://cursor.com/docs/cli/acp */

const TodoStatus = Schema.Literals(["pending", "in_progress", "completed", "cancelled"])

export const Todo = Schema.Struct({
  id: Schema.String,
  content: Schema.String,
  status: TodoStatus,
})
export type Todo = typeof Todo.Type

export const AskQuestion = Schema.Struct({
  toolCallId: Schema.String,
  title: Schema.optional(Schema.String),
  questions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      prompt: Schema.String,
      options: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
      allowMultiple: Schema.optional(Schema.Boolean),
    }),
  ),
})
export type AskQuestion = typeof AskQuestion.Type

export const CreatePlan = Schema.Struct({
  toolCallId: Schema.String,
  name: Schema.optional(Schema.String),
  overview: Schema.optional(Schema.String),
  plan: Schema.String,
  todos: Schema.Array(Todo),
})
export type CreatePlan = typeof CreatePlan.Type

export const UpdateTodos = Schema.Struct({
  toolCallId: Schema.String,
  todos: Schema.Array(Todo),
  merge: Schema.optional(Schema.Boolean),
})

export const Task = Schema.Struct({
  toolCallId: Schema.String,
  description: Schema.String,
})

export const GenerateImage = Schema.Struct({
  toolCallId: Schema.String,
  description: Schema.String,
})

/** Methods may arrive with ACP's `_` extension prefix. */
export const methodName = (method: string) => method.replace(/^_/, "")

/** ACP plans have no "cancelled"; a dropped task reads as done. */
export const toPlanEntries = (todos: ReadonlyArray<Todo>): Array<acp.PlanEntry> =>
  todos.map((todo) => ({
    content: todo.content,
    priority: "medium",
    status: todo.status === "cancelled" ? "completed" : todo.status,
  }))

/** Applies an update to the running todo list, replacing it unless `merge` is set. */
export const mergeTodos = (
  current: ReadonlyArray<Todo>,
  incoming: ReadonlyArray<Todo>,
  merge: boolean,
): ReadonlyArray<Todo> => {
  if (!merge) return incoming
  const byId = new Map(current.map((todo) => [todo.id, todo]))
  for (const todo of incoming) byId.set(todo.id, todo)
  return [...byId.values()]
}
