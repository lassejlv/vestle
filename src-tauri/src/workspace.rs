//! File system and git helpers backing ACP `fs/*` requests and the session header.

use std::path::Path;

use tokio::process::Command;

use crate::shell_env;

#[tauri::command]
pub async fn fs_read_text(
    path: String,
    line: Option<usize>,
    limit: Option<usize>,
) -> Result<String, String> {
    read_text(&path, line, limit).await
}

#[tauri::command]
pub async fn fs_write_text(path: String, content: String) -> Result<(), String> {
    write_text(&path, &content).await
}

/// ACP `fs/read_text_file`: the whole file, or `limit` lines from 1-based `line`.
pub async fn read_text(path: &str, line: Option<usize>, limit: Option<usize>) -> Result<String, String> {
    let content = tokio::fs::read_to_string(path)
        .await
        .map_err(|error| format!("Couldn't read {path}: {error}"))?;

    if line.is_none() && limit.is_none() {
        return Ok(content);
    }

    let start = line.unwrap_or(1).saturating_sub(1);
    let lines = content.lines().skip(start);
    let selected: Vec<&str> = match limit {
        Some(limit) => lines.take(limit).collect(),
        None => lines.collect(),
    };
    Ok(selected.join("\n"))
}

/// ACP `fs/write_text_file`, creating missing parent folders.
pub async fn write_text(path: &str, content: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("Couldn't create {}: {error}", parent.display()))?;
    }
    tokio::fs::write(path, content)
        .await
        .map_err(|error| format!("Couldn't write {path}: {error}"))
}

/// Current branch name, or `None` outside a git repository.
#[tauri::command]
pub async fn git_branch(cwd: String) -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(cwd)
        .env("PATH", shell_env::login_path())
        .output()
        .await
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFile {
    name: String,
    mime_type: &'static str,
    data: String,
}

/// Reads an image for a prompt attachment, base64-encoded as ACP expects.
#[tauri::command]
pub async fn fs_read_image(path: String) -> Result<ImageFile, String> {
    use base64::Engine;

    let extension = Path::new(&path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    let mime_type = match extension.as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => return Err(format!("{path} isn't a PNG, JPEG, GIF or WebP image")),
    };
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("Couldn't read {path}: {error}"))?;
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(format!("{path} is larger than 20 MB"));
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| format!("Couldn't read {path}: {error}"))?;
    Ok(ImageFile {
        name: Path::new(&path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        mime_type,
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}
