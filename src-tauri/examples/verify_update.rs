//! Verify the exact updater archive with the public key shipped inside the app.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let archive = args.get(1).ok_or("Expected archive path")?;
    let version = args.get(2).ok_or("Expected release version")?;
    let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))?;
    let public_key = String::from_utf8(
        STANDARD.decode(
            config["plugins"]["updater"]["pubkey"]
                .as_str()
                .ok_or("Missing updater public key")?,
        )?,
    )?;
    let signature = String::from_utf8(
        STANDARD.decode(std::fs::read_to_string(format!("{archive}.sig"))?.trim())?,
    )?;
    let signature = Signature::decode(&signature)?;
    PublicKey::decode(&public_key)?.verify(&std::fs::read(archive)?, &signature, true)?;
    let signed_version = signature
        .trusted_comment()
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"));
    if signed_version != Some(version.as_str()) {
        return Err("Updater signature does not match the release version".into());
    }
    println!("Updater signature and version verified against the app's public key");
    Ok(())
}
