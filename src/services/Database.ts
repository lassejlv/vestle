import { Context, Effect, Layer, Schema } from "effect"
import { AgentId } from "@/domain/agents"
import type { TimelineItem } from "@/domain/session"
import { Tauri, type TauriError } from "./Tauri"

export class Project extends Schema.Class<Project>("Project")({
  id: Schema.String,
  path: Schema.String,
  name: Schema.String,
  createdAt: Schema.Number,
  lastOpenedAt: Schema.Number,
}) {}

export class ThreadSummary extends Schema.Class<ThreadSummary>("ThreadSummary")({
  id: Schema.String,
  projectId: Schema.String,
  agentId: AgentId,
  acpSessionId: Schema.NullOr(Schema.String),
  title: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}) {}

export class SearchHit extends Schema.Class<SearchHit>("SearchHit")({
  ...ThreadSummary.fields,
  snippet: Schema.NullOr(Schema.String),
}) {}

const ThreadRow = Schema.Struct({
  ...ThreadSummary.fields,
  items: Schema.Array(Schema.Unknown),
  logSeq: Schema.Number,
})

export interface ThreadRecord extends ThreadSummary {
  readonly items: ReadonlyArray<TimelineItem>
  /** How far into the daemon's log for this thread's agent `items` go. */
  readonly logSeq: number
}

export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  message: Schema.String,
}) {}

const fail = (error: TauriError | Schema.SchemaError) => new DatabaseError({ message: error.message })

/** Projects and threads, persisted in SQLite by the Rust side. */
export class Database extends Context.Service<
  Database,
  {
    listProjects(): Effect.Effect<ReadonlyArray<Project>, DatabaseError>
    saveProject(project: Project): Effect.Effect<Project, DatabaseError>
    deleteProject(id: string): Effect.Effect<void, DatabaseError>
    listThreads(): Effect.Effect<ReadonlyArray<ThreadSummary>, DatabaseError>
    getThread(id: string): Effect.Effect<ThreadRecord | null, DatabaseError>
    saveThread(thread: ThreadRecord): Effect.Effect<void, DatabaseError>
    deleteThread(id: string): Effect.Effect<void, DatabaseError>
    searchThreads(query: string): Effect.Effect<ReadonlyArray<SearchHit>, DatabaseError>
  }
>()("termy/services/Database") {
  static readonly layer = Layer.effect(
    Database,
    Effect.gen(function* () {
      const tauri = yield* Tauri

      const query = <S extends Schema.Top>(schema: S, command: string, args?: Record<string, unknown>) =>
        tauri.invoke<unknown>(command, args).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(schema)),
          Effect.mapError(fail),
        ) as Effect.Effect<S["Type"], DatabaseError>

      const execute = (command: string, args: Record<string, unknown>) =>
        tauri.invoke<void>(command, args).pipe(Effect.mapError(fail))

      return Database.of({
        listProjects: () => query(Schema.Array(Project), "db_projects_list"),
        saveProject: (project) => query(Project, "db_project_save", { project }),
        deleteProject: (id) => execute("db_project_delete", { id }),
        listThreads: () => query(Schema.Array(ThreadSummary), "db_threads_list"),
        getThread: (id) =>
          query(Schema.NullOr(ThreadRow), "db_thread_get", { id }) as Effect.Effect<
            ThreadRecord | null,
            DatabaseError
          >,
        saveThread: (thread) =>
          execute("db_thread_save", {
            thread: {
              id: thread.id,
              projectId: thread.projectId,
              agentId: thread.agentId,
              acpSessionId: thread.acpSessionId,
              title: thread.title,
              items: thread.items,
              createdAt: thread.createdAt,
              updatedAt: thread.updatedAt,
              logSeq: thread.logSeq,
            },
          }),
        deleteThread: (id) => execute("db_thread_delete", { id }),
        searchThreads: (text) => query(Schema.Array(SearchHit), "db_threads_search", { query: text }),
      })
    }),
  ).pipe(Layer.provide(Tauri.layer))
}
