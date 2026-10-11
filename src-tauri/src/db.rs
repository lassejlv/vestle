//! Local SQLite store for projects and threads.
//! Lives at `<app data dir>/termy.db`. Thread timelines are stored as JSON.

use std::{path::Path, sync::Mutex};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

pub struct Db(Mutex<Connection>);

const MIGRATIONS: &[&str] = &[r#"
    CREATE TABLE projects (
        id              TEXT PRIMARY KEY,
        path            TEXT NOT NULL UNIQUE,
        name            TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        last_opened_at  INTEGER NOT NULL
    );
    CREATE TABLE threads (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_id        TEXT NOT NULL,
        acp_session_id  TEXT,
        title           TEXT NOT NULL,
        items           TEXT NOT NULL DEFAULT '[]',
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
    );
    CREATE INDEX threads_project_updated ON threads(project_id, updated_at DESC);
"#,
    // How far into the daemon's log for this thread's agent the saved items go.
    r#"ALTER TABLE threads ADD COLUMN log_seq INTEGER NOT NULL DEFAULT 0;"#,
];

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let mut conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&mut conn)?;
        Ok(Self(Mutex::new(conn)))
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let conn = self.0.lock().map_err(|_| "Database lock poisoned".to_owned())?;
        f(&conn).map_err(|error| error.to_string())
    }
}

fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let tx = conn.transaction()?;
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", index as i64 + 1)?;
    }
    tx.commit()
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    id: String,
    path: String,
    name: String,
    created_at: i64,
    last_opened_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    id: String,
    project_id: String,
    agent_id: String,
    acp_session_id: Option<String>,
    title: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    id: String,
    project_id: String,
    agent_id: String,
    acp_session_id: Option<String>,
    title: String,
    items: serde_json::Value,
    created_at: i64,
    updated_at: i64,
    #[serde(default)]
    log_seq: i64,
}

#[tauri::command]
pub fn db_projects_list(db: State<'_, Db>) -> Result<Vec<Project>, String> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, path, name, created_at, last_opened_at FROM projects ORDER BY last_opened_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                created_at: row.get(3)?,
                last_opened_at: row.get(4)?,
            })
        })?;
        rows.collect()
    })
}

/// Inserts a project, or refreshes `last_opened_at` when the path is already known.
/// Returns the stored row so callers get the canonical id.
#[tauri::command]
pub fn db_project_save(db: State<'_, Db>, project: Project) -> Result<Project, String> {
    db.with(|conn| {
        conn.execute(
            "INSERT INTO projects (id, path, name, created_at, last_opened_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(path) DO UPDATE SET name = excluded.name, last_opened_at = excluded.last_opened_at",
            params![project.id, project.path, project.name, project.created_at, project.last_opened_at],
        )?;
        conn.query_row(
            "SELECT id, path, name, created_at, last_opened_at FROM projects WHERE path = ?1",
            [&project.path],
            |row| {
                Ok(Project {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    name: row.get(2)?,
                    created_at: row.get(3)?,
                    last_opened_at: row.get(4)?,
                })
            },
        )
    })
}

#[tauri::command]
pub fn db_project_delete(db: State<'_, Db>, id: String) -> Result<(), String> {
    db.with(|conn| conn.execute("DELETE FROM projects WHERE id = ?1", [id]).map(drop))
}

#[tauri::command]
pub fn db_threads_list(db: State<'_, Db>) -> Result<Vec<ThreadSummary>, String> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, project_id, agent_id, acp_session_id, title, created_at, updated_at
             FROM threads ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ThreadSummary {
                id: row.get(0)?,
                project_id: row.get(1)?,
                agent_id: row.get(2)?,
                acp_session_id: row.get(3)?,
                title: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })?;
        rows.collect()
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    #[serde(flatten)]
    thread: ThreadSummary,
    /// A short excerpt around the first match in the conversation, if the title didn't match.
    snippet: Option<String>,
}

const SNIPPET_RADIUS: usize = 48;
const SEARCH_LIMIT: usize = 30;

/// Finds `needle` in any message text of a thread timeline and returns an excerpt.
fn find_snippet(items: &serde_json::Value, needle: &str) -> Option<String> {
    let items = items.as_array()?;
    items.iter().find_map(|item| {
        let tag = item.get("_tag")?.as_str()?;
        if !matches!(tag, "User" | "Agent") {
            return None;
        }
        let text = item.get("text")?.as_str()?;
        let haystack = text.to_lowercase();
        let found = haystack.find(needle)?;
        // Lowercasing can change byte lengths; map back by character count.
        let start_chars = haystack[..found].chars().count().saturating_sub(SNIPPET_RADIUS);
        let excerpt: String = text
            .chars()
            .skip(start_chars)
            .take(SNIPPET_RADIUS * 2 + needle.chars().count())
            .collect();
        let mut words: Vec<&str> = excerpt.split_whitespace().collect();
        if start_chars > 0 && words.len() > 1 {
            // Don't open on a cut-off word.
            words.remove(0);
        }
        let excerpt = words.join(" ");
        Some(if start_chars > 0 { format!("...{excerpt}") } else { excerpt })
    })
}

/// Case-insensitive search over thread titles and message text, newest first.
#[tauri::command]
pub fn db_threads_search(db: State<'_, Db>, query: String) -> Result<Vec<SearchHit>, String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(vec![]);
    }
    let pattern = format!(
        "%{}%",
        needle.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
    );
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, project_id, agent_id, acp_session_id, title, created_at, updated_at, items
             FROM threads
             WHERE lower(title) LIKE ?1 ESCAPE '\\' OR lower(items) LIKE ?1 ESCAPE '\\'
             ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([&pattern], |row| {
            let items: String = row.get(7)?;
            Ok((
                ThreadSummary {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    agent_id: row.get(2)?,
                    acp_session_id: row.get(3)?,
                    title: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                },
                items,
            ))
        })?;
        let mut hits = Vec::new();
        for row in rows {
            let (thread, items) = row?;
            let title_match = thread.title.to_lowercase().contains(&needle);
            // The LIKE prefilter also matches JSON keys and image data; confirm against real text.
            let snippet = serde_json::from_str(&items)
                .ok()
                .and_then(|items| find_snippet(&items, &needle));
            if title_match || snippet.is_some() {
                hits.push(SearchHit {
                    thread,
                    snippet: if title_match { None } else { snippet },
                });
            }
            if hits.len() == SEARCH_LIMIT {
                break;
            }
        }
        Ok(hits)
    })
}

#[tauri::command]
pub fn db_thread_get(db: State<'_, Db>, id: String) -> Result<Option<Thread>, String> {
    db.with(|conn| {
        conn.query_row(
            "SELECT id, project_id, agent_id, acp_session_id, title, items, created_at, updated_at, log_seq
             FROM threads WHERE id = ?1",
            [id],
            |row| {
                let items: String = row.get(5)?;
                Ok(Thread {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    agent_id: row.get(2)?,
                    acp_session_id: row.get(3)?,
                    title: row.get(4)?,
                    items: serde_json::from_str(&items).unwrap_or(serde_json::Value::Array(vec![])),
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                    log_seq: row.get(8)?,
                })
            },
        )
        .optional()
    })
}

#[tauri::command]
pub fn db_thread_save(db: State<'_, Db>, thread: Thread) -> Result<(), String> {
    db.with(|conn| {
        conn.execute(
            "INSERT INTO threads (id, project_id, agent_id, acp_session_id, title, items, created_at, updated_at, log_seq)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                acp_session_id = excluded.acp_session_id,
                title = excluded.title,
                items = excluded.items,
                updated_at = excluded.updated_at,
                log_seq = excluded.log_seq",
            params![
                thread.id,
                thread.project_id,
                thread.agent_id,
                thread.acp_session_id,
                thread.title,
                thread.items.to_string(),
                thread.created_at,
                thread.updated_at,
                thread.log_seq
            ],
        )
        .map(drop)
    })
}

#[tauri::command]
pub fn db_thread_delete(db: State<'_, Db>, id: String) -> Result<(), String> {
    db.with(|conn| conn.execute("DELETE FROM threads WHERE id = ?1", [id]).map(drop))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippet_comes_from_message_text_not_json_or_images() {
        let items = serde_json::json!([
            { "_tag": "User", "id": "1", "text": "Fix the resize jank", "images": [{ "data": "cmVzaXpl" }] },
            { "_tag": "Agent", "id": "2", "text": "The divider jumps because resize_split loses the grab offset." }
        ]);
        assert_eq!(find_snippet(&items, "grab offset").as_deref(), Some("...divider jumps because resize_split loses the grab offset."));
        assert_eq!(find_snippet(&items, "cmvzaxpl"), None);
        assert_eq!(find_snippet(&items, "_tag"), None);
    }
}
