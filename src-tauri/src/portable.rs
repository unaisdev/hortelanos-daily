//! Self-update for the Windows *portable* build (a zip unzipped anywhere, no installer).
//!
//! tauri-plugin-updater can only run NSIS/MSI installers, so the portable zip gets its own
//! flow, signed with the same Ed25519 key (`plugins.updater.pubkey` in tauri.conf.json):
//!
//! 1. `portable.json` (published next to the release) → version, zip URL, signature.
//! 2. Download the zip *inside the install folder* (same volume ⇒ renames are atomic-ish),
//!    verify the signature, extract.
//! 3. Swap files: every existing file is renamed to `<name>.old` (Windows lets you rename a
//!    running exe, not overwrite it) and the new one moved in. Any failure rolls back.
//! 4. Relaunch the exe after a short delay (so the old process frees the local server port)
//!    and exit. Leftover `.old` files are removed on the next start.
//!
//! A portable install is recognised by a `portable.txt` marker next to the exe.

use std::fs::{self, File};
use std::path::{Component, Path, PathBuf};

use base64::Engine;
use serde::Deserialize;
use tauri::AppHandle;
use zip::ZipArchive;

use crate::error::{AppError, AppResult};
use crate::updates;

pub const MARKER: &str = "portable.txt";
const MANIFEST_URL: &str =
    "https://github.com/unaisdev/hortelanos-daily/releases/latest/download/portable.json";
/// Name of the exe inside the release zip; mapped onto whatever the user's exe is called.
const ZIP_EXE_NAME: &str = "Hortelanos Daily.exe";
const STAGING_DIR: &str = ".update-staging";

#[derive(Debug, Deserialize)]
struct PortableManifest {
    version: String,
    url: String,
    /// Contents of the `.sig` file produced by `tauri signer sign`.
    signature: String,
}

fn install_dir() -> AppResult<(PathBuf, PathBuf)> {
    let exe = std::env::current_exe()?;
    let dir = exe
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| AppError::msg("no se pudo localizar la carpeta del ejecutable"))?;
    Ok((exe, dir))
}

/// True when running from an unzipped portable folder (marker file next to the exe).
pub fn is_portable() -> bool {
    install_dir()
        .map(|(_, dir)| dir.join(MARKER).is_file())
        .unwrap_or(false)
}

/// Downloads, verifies and installs the latest portable build, then relaunches.
/// Returns `None` when already up to date.
pub async fn install_update(app: &AppHandle) -> AppResult<Option<String>> {
    let (exe, dir) = install_dir()?;
    let current = app.package_info().version.to_string();

    let response = updates::client()?.get(MANIFEST_URL).send().await?;
    if !response.status().is_success() {
        return Err(AppError::msg(format!(
            "portable.json: HTTP {}",
            response.status()
        )));
    }
    let manifest: PortableManifest = response.json().await?;
    let remote = manifest.version.trim_start_matches('v').to_string();
    if !updates::is_newer(&remote, &current)? {
        return Ok(None);
    }

    let pubkey = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::msg("falta plugins.updater.pubkey en la configuración"))?
        .to_string();

    let staging = dir.join(STAGING_DIR);
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| {
        AppError::msg(format!(
            "no se puede escribir en {} ({e}); mueve la carpeta a un sitio con permisos",
            dir.display()
        ))
    })?;

    let result = stage_and_apply(&manifest, &pubkey, &staging, &dir, &exe).await;
    let _ = fs::remove_dir_all(&staging);
    result?;

    relaunch(&exe, &dir)?;
    app.exit(0);
    Ok(Some(remote))
}

async fn stage_and_apply(
    manifest: &PortableManifest,
    pubkey: &str,
    staging: &Path,
    dir: &Path,
    exe: &Path,
) -> AppResult<()> {
    let zip_path = staging.join("update.zip");
    updates::download_file(&manifest.url, &zip_path).await?;

    let bytes = fs::read(&zip_path)?;
    verify_signature(pubkey, &bytes, &manifest.signature)?;
    drop(bytes);

    let extracted = staging.join("new");
    extract_zip_stripped(&zip_path, &extracted)?;

    let exe_name = exe
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::msg("nombre de ejecutable no válido"))?;
    apply_update(&extracted, dir, exe_name)
}

/// `pubkey_b64` / `signature_b64` are the base64 texts Tauri uses (of the minisign files).
pub fn verify_signature(pubkey_b64: &str, data: &[u8], signature_b64: &str) -> AppResult<()> {
    let decode = |label: &str, b64: &str| -> AppResult<String> {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .map_err(|e| AppError::msg(format!("{label} no es base64 válido: {e}")))?;
        String::from_utf8(raw).map_err(|e| AppError::msg(format!("{label} no es UTF-8: {e}")))
    };
    let pk = minisign_verify::PublicKey::decode(&decode("clave pública", pubkey_b64)?)
        .map_err(|e| AppError::msg(format!("clave pública inválida: {e}")))?;
    let sig = minisign_verify::Signature::decode(&decode("firma", signature_b64)?)
        .map_err(|e| AppError::msg(format!("firma inválida: {e}")))?;
    pk.verify(data, &sig, false)
        .map_err(|e| AppError::msg(format!("la firma de la actualización no es válida: {e}")))
}

/// Relative path from a zip entry name. Accepts `\` separators (old Compress-Archive) and
/// rejects anything that could escape the destination (`..`, absolute paths, drive letters).
fn safe_rel(name: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for part in name.replace('\\', "/").split('/') {
        match part {
            "" | "." => {}
            ".." => return None,
            p if p.contains(':') => return None,
            p => out.push(p),
        }
    }
    Some(out)
}

/// Extracts our release zip, dropping its single top-level folder ("Hortelanos Daily/").
fn extract_zip_stripped(zip_path: &Path, dest: &Path) -> AppResult<()> {
    let mut archive = ZipArchive::new(File::open(zip_path)?)?;
    fs::create_dir_all(dest)?;

    let mut top: Option<String> = None;
    let mut single_top = true;
    for i in 0..archive.len() {
        let file = archive.by_index(i)?;
        let Some(path) = safe_rel(file.name()) else {
            return Err(AppError::msg("el zip contiene una ruta no permitida"));
        };
        let first = path
            .components()
            .next()
            .map(|c| c.as_os_str().to_string_lossy().to_string());
        let has_parent = path.components().count() > 1 || file.is_dir();
        match (&top, first) {
            (None, Some(f)) => top = Some(f),
            (Some(t), Some(f)) if *t != f => single_top = false,
            _ => {}
        }
        if !has_parent {
            single_top = false;
        }
    }

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let Some(path) = safe_rel(file.name()) else {
            return Err(AppError::msg("el zip contiene una ruta no permitida"));
        };
        let rel: PathBuf = if single_top {
            path.components().skip(1).collect()
        } else {
            path
        };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let out = dest.join(&rel);
        if file.is_dir() {
            fs::create_dir_all(&out)?;
        } else {
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut f = File::create(&out)?;
            std::io::copy(&mut file, &mut f)?;
        }
    }
    Ok(())
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            collect_files(root, &path, out)?;
        } else if let Ok(rel) = path.strip_prefix(root) {
            out.push(rel.to_path_buf());
        }
    }
    Ok(())
}

fn old_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".old");
    path.with_file_name(name)
}

/// Moves every file of `new_root` into `install_dir`, keeping the previous version as
/// `<file>.old`. All-or-nothing: on error the previous files are restored.
pub fn apply_update(new_root: &Path, install_dir: &Path, exe_name: &str) -> AppResult<()> {
    let mut files = Vec::new();
    collect_files(new_root, new_root, &mut files)?;
    files.sort();

    // (destination, backup of what was there before)
    let mut done: Vec<(PathBuf, Option<PathBuf>)> = Vec::new();
    for rel in files {
        if rel == Path::new(MARKER) {
            continue; // never touch the user's marker
        }
        let dest_rel = if rel == Path::new(ZIP_EXE_NAME) {
            PathBuf::from(exe_name)
        } else {
            rel.clone()
        };
        if dest_rel
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            rollback(&done);
            return Err(AppError::msg("ruta de actualización no permitida"));
        }
        let dest = install_dir.join(&dest_rel);
        let src = new_root.join(&rel);

        let step = (|| -> std::io::Result<()> {
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            let backup = if dest.exists() {
                let b = old_path(&dest);
                let _ = fs::remove_file(&b);
                fs::rename(&dest, &b)?;
                Some(b)
            } else {
                None
            };
            done.push((dest.clone(), backup));
            fs::rename(&src, &dest)
        })();

        if let Err(e) = step {
            rollback(&done);
            return Err(AppError::msg(format!(
                "no se pudo actualizar {}: {e}",
                dest.display()
            )));
        }
    }
    Ok(())
}

fn rollback(done: &[(PathBuf, Option<PathBuf>)]) {
    for (dest, backup) in done.iter().rev() {
        if dest.is_file() {
            let _ = fs::remove_file(dest);
        }
        if let Some(b) = backup {
            let _ = fs::rename(b, dest);
        }
    }
}

/// Removes `*.old` leftovers and the staging dir from a previous update (best effort).
pub fn cleanup_leftovers() {
    let Ok((_, dir)) = install_dir() else { return };
    cleanup_dir(&dir, 0);
    let _ = fs::remove_dir_all(dir.join(STAGING_DIR));
}

fn cleanup_dir(dir: &Path, depth: usize) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            cleanup_dir(&path, depth + 1);
        } else if path.extension().is_some_and(|e| e == "old") {
            let _ = fs::remove_file(&path);
        }
    }
}

/// Starts the new exe a moment later, so the old process has released the local server port
/// (a different port would change the WebView origin and hide localStorage data).
fn relaunch(exe: &Path, dir: &Path) -> AppResult<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .raw_arg(format!(
                "/C ping -n 3 127.0.0.1 >nul & start \"\" \"{}\"",
                exe.display()
            ))
            .current_dir(dir)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new(exe).current_dir(dir).spawn()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("hd-portable-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn replaces_files_and_keeps_old_copies() {
        let root = tmp("ok");
        let (inst, new) = (root.join("inst"), root.join("new"));
        write(&inst.join("MiJuego.exe"), "exe v1");
        write(&inst.join("portable.txt"), "marker");
        write(&inst.join("shell/index.html"), "ui v1");
        write(&inst.join("data/save.dat"), "mine"); // not in the zip: must survive
        write(&new.join("Hortelanos Daily.exe"), "exe v2");
        write(&new.join("portable.txt"), "marker from zip");
        write(&new.join("shell/index.html"), "ui v2");
        write(&new.join("shell/extra.js"), "extra");

        apply_update(&new, &inst, "MiJuego.exe").unwrap();

        assert_eq!(read(&inst.join("MiJuego.exe")), "exe v2");
        assert_eq!(read(&inst.join("MiJuego.exe.old")), "exe v1");
        assert!(!inst.join("Hortelanos Daily.exe").exists(), "exe keeps the user's name");
        assert_eq!(read(&inst.join("shell/index.html")), "ui v2");
        assert_eq!(read(&inst.join("shell/extra.js")), "extra");
        assert_eq!(read(&inst.join("portable.txt")), "marker");
        assert_eq!(read(&inst.join("data/save.dat")), "mine");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rolls_back_everything_on_failure() {
        let root = tmp("rollback");
        let (inst, new) = (root.join("inst"), root.join("new"));
        write(&inst.join("a.txt"), "a v1");
        write(&inst.join("q"), "I am a file"); // blocks creating q/inner.txt
        write(&new.join("a.txt"), "a v2");
        write(&new.join("q/inner.txt"), "boom");

        assert!(apply_update(&new, &inst, "x.exe").is_err());

        assert_eq!(read(&inst.join("a.txt")), "a v1", "a.txt restored");
        assert_eq!(read(&inst.join("q")), "I am a file");
        assert!(!inst.join("a.txt.old").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_bad_signature_and_accepts_good_one() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let pubkey = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
        let data = include_bytes!("../testdata/sample.txt");
        let sig = include_str!("../testdata/sample.txt.sig");

        verify_signature(pubkey, data, sig).unwrap();
        assert!(verify_signature(pubkey, b"tampered", sig).is_err());
        assert!(verify_signature(pubkey, data, "bm90IGEgc2lnbmF0dXJl").is_err());
    }

    #[test]
    fn safe_rel_handles_backslashes_and_rejects_escapes() {
        assert_eq!(
            safe_rel("Hortelanos Daily\\shell\\index.html").unwrap(),
            PathBuf::from("Hortelanos Daily").join("shell").join("index.html")
        );
        assert!(safe_rel("../evil.txt").is_none());
        assert!(safe_rel("a\\..\\..\\evil").is_none());
        assert!(safe_rel("C:\\evil").is_none());
        assert_eq!(safe_rel("/abs/x").unwrap(), PathBuf::from("abs").join("x"));
    }

    #[test]
    fn extract_strips_single_top_folder() {
        use std::io::Write;
        let root = tmp("zip");
        let zip_path = root.join("u.zip");
        {
            let mut w = zip::ZipWriter::new(File::create(&zip_path).unwrap());
            let opts = zip::write::SimpleFileOptions::default();
            w.add_directory("Hortelanos Daily/", opts).unwrap();
            w.start_file("Hortelanos Daily/Hortelanos Daily.exe", opts).unwrap();
            w.write_all(b"exe").unwrap();
            w.start_file("Hortelanos Daily/shell/index.html", opts).unwrap();
            w.write_all(b"ui").unwrap();
            w.finish().unwrap();
        }
        let out = root.join("out");
        extract_zip_stripped(&zip_path, &out).unwrap();
        assert_eq!(read(&out.join("Hortelanos Daily.exe")), "exe");
        assert_eq!(read(&out.join("shell/index.html")), "ui");
        let _ = fs::remove_dir_all(&root);
    }
}
