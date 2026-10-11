//! What the composer can mention: project files for `@` and agent skills for `$`.

use std::path::{Path, PathBuf};

use ignore::WalkBuilder;
use serde::Serialize;

/// Enough for large monorepos; the picker only ever shows the best matches.
const MAX_FILES: usize = 50_000;

/// Files in the project, relative to it. Honors .gitignore but keeps dotfiles.
#[tauri::command]
pub async fn project_files(cwd: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&cwd);
        let walker = WalkBuilder::new(&root)
            .hidden(false)
            .require_git(false)
            .filter_entry(|entry| entry.file_name() != ".git")
            .build();
        let mut files = Vec::new();
        for entry in walker.flatten() {
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                continue;
            }
            if let Ok(relative) = entry.path().strip_prefix(&root) {
                files.push(relative.to_string_lossy().into_owned());
            }
            if files.len() >= MAX_FILES {
                break;
            }
        }
        files
    })
    .await
    .map_err(|error| error.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    name: String,
    description: String,
    /// Absolute path of the skill's SKILL.md.
    path: String,
    /// "project" or "user".
    scope: &'static str,
}

/// Skill folders for an agent, most specific first. Each agent reads its own
/// project and home folders; all but Claude also read the shared `.agents`
/// folders, and OpenCode reads Claude's too.
fn skill_roots(agent: &str, cwd: &Path, home: &Path) -> Vec<(PathBuf, &'static str)> {
    let (project, user, shared): (&str, &str, &[&str]) = match agent {
        "claude" => (".claude", ".claude", &[]),
        "codex" => (".codex", ".codex", &[".agents"]),
        "cursor" => (".cursor", ".cursor", &[".agents"]),
        "grok" => (".grok", ".grok", &[".agents"]),
        // Runs Gemini CLI, so it reads Gemini's folders.
        "antigravity" => (".gemini", ".gemini", &[".agents"]),
        "opencode" => (".opencode", ".config/opencode", &[".claude", ".agents"]),
        _ => return Vec::new(),
    };
    let mut roots = vec![(cwd.join(project).join("skills"), "project")];
    roots.extend(shared.iter().map(|dir| (cwd.join(dir).join("skills"), "project")));
    roots.push((home.join(user).join("skills"), "user"));
    roots.extend(shared.iter().map(|dir| (home.join(dir).join("skills"), "user")));
    roots
}

/// Skills the agent can use in this project. A name defined in a more
/// specific folder hides the same name further down.
#[tauri::command]
pub async fn skills_list(agent: String, cwd: String) -> Result<Vec<Skill>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
        let mut skills: Vec<Skill> = Vec::new();
        for (root, scope) in skill_roots(&agent, Path::new(&cwd), &home) {
            let Ok(entries) = std::fs::read_dir(&root) else { continue };
            for entry in entries.flatten() {
                // Follows symlinks, since skill folders are often linked in.
                let path = entry.path().join("SKILL.md");
                let Ok(content) = std::fs::read_to_string(&path) else { continue };
                let folder = entry.file_name().to_string_lossy().into_owned();
                let (name, description) = frontmatter(&content);
                let name = name.unwrap_or(folder);
                if skills.iter().any(|skill| skill.name == name) {
                    continue;
                }
                skills.push(Skill {
                    name,
                    description: description.unwrap_or_default(),
                    path: path.to_string_lossy().into_owned(),
                    scope,
                });
            }
        }
        skills.sort_by(|a, b| a.name.cmp(&b.name));
        skills
    })
    .await
    .map_err(|error| error.to_string())
}

/// `name` and `description` from a SKILL.md's YAML frontmatter. Handles plain,
/// quoted and folded (`>`, `|`) values, which covers what skills use.
fn frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let body: Vec<&str> = lines.take_while(|line| line.trim() != "---").collect();
    let field = |key: &str| -> Option<String> {
        let prefix = format!("{key}:");
        let start = body.iter().position(|line| line.starts_with(&prefix))?;
        let value = body[start][prefix.len()..].trim();
        if value.starts_with('>') || value.starts_with('|') {
            let folded: Vec<&str> = body[start + 1..]
                .iter()
                .take_while(|line| line.starts_with(' ') || line.starts_with('\t') || line.is_empty())
                .map(|line| line.trim())
                .filter(|line| !line.is_empty())
                .collect();
            return Some(folded.join(" "));
        }
        let unquoted = value
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|rest| rest.strip_suffix('\'')))
            .unwrap_or(value);
        Some(unquoted.to_owned()).filter(|value| !value.is_empty())
    };
    (field("name"), field("description"))
}
