//! Tauri commands for the WAD extraction UI.
//!
//! Phase 1 surface: hashtable status, download, preload/unload, and a
//! debug single-hash resolver.
//! Phase 2 adds mount/list/inspect commands that parse a WAD's TOC and
//! bulk-resolve every path hash. Extraction lands in Phase 3.

use crate::core::hash::get_frogtools_hash_dir;
use crate::core::wad::{
    cancel_extraction, check_for_hash_update, detect_layout, download_combined_hashes,
    extract_hashes, extract_to_dir, hashes_present, list_mounted, loaded_stats, mount,
    read_chunk_decompressed_bytes, resolve_wad, unload_envs, unmount, with_mount, ExtractResult,
    HashScanResult, HashUpdateStatus, MountInfo,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct WadHashStatus {
    pub present: bool,
    /// "split" | "combined" | "missing"
    pub layout: String,
    pub hash_dir: String,
}

#[derive(Serialize)]
pub struct WadPreloadStatus {
    pub wad_loaded: bool,
    pub bin_loaded: bool,
    /// Layout detected on disk at the time of the call.
    pub layout: String,
}

/// Probe disk for the FrogTools hash directory and report which layout (if
/// any) is populated. Cheap — no env opens, just `data.mdb` existence checks.
#[tauri::command]
pub async fn wad_hash_status() -> Result<WadHashStatus, String> {
    let dir = get_frogtools_hash_dir().map_err(|e| e.to_string())?;
    let layout = detect_layout(&dir);
    Ok(WadHashStatus {
        present: hashes_present(&dir),
        layout: layout.as_str().to_string(),
        hash_dir: dir.to_string_lossy().into_owned(),
    })
}

/// Download `lol-hashes-combined.zst` and decompress it into the FrogTools
/// dir. No-ops with a "complete" event when a layout is already present
/// unless `force == true`. Returns the resulting layout string.
#[tauri::command]
pub async fn wad_download_hashes(
    app: tauri::AppHandle,
    force: Option<bool>,
) -> Result<String, String> {
    let dir = get_frogtools_hash_dir().map_err(|e| e.to_string())?;
    let layout = download_combined_hashes(&app, &dir, force.unwrap_or(false))
        .await
        .map_err(|e| e.to_string())?;
    Ok(layout.as_str().to_string())
}

/// Read current env state. The LMDB envs are opened lazily on first
/// lookup; this command just reports whether that has happened yet so
/// the UI can show a passive "ready" indicator.
#[tauri::command]
pub async fn wad_get_preload_status() -> Result<WadPreloadStatus, String> {
    let dir = get_frogtools_hash_dir().map_err(|e| e.to_string())?;
    let env_stats = loaded_stats(&dir);
    Ok(WadPreloadStatus {
        wad_loaded: env_stats.wad_loaded,
        bin_loaded: env_stats.bin_loaded,
        layout: detect_layout(&dir).as_str().to_string(),
    })
}

/// Compare the local `releaseTag` against the latest published release.
/// One HTTPS round-trip — the every-launch auto-update mode runs this
/// and only triggers a real download when the tags differ.
#[tauri::command]
pub async fn wad_check_for_hash_update() -> Result<HashUpdateStatus, String> {
    let dir = get_frogtools_hash_dir().map_err(|e| e.to_string())?;
    check_for_hash_update(&dir).await.map_err(|e| e.to_string())
}

/// Drop the cached LMDB env(s). Free at runtime — only the OS-cached
/// pages get released. Use when the user leaves the Extract Files tab if
/// auto-unload is enabled.
#[tauri::command]
pub async fn wad_unload_hashes() -> Result<(), String> {
    unload_envs();
    Ok(())
}

/// Resolve a single 16-char hex WAD path hash. Test/debug helper for the
/// UI; returns the hex string itself when the hash is unknown.
#[tauri::command]
pub async fn wad_resolve_hash(hex: String) -> Result<String, String> {
    let dir = get_frogtools_hash_dir().map_err(|e| e.to_string())?;
    let trimmed = hex.trim().trim_start_matches("0x").trim_start_matches("0X");
    let hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", hex, e))?;
    Ok(resolve_wad(hash, &dir))
}

// ── Phase 2 — mount + entry listing ─────────────────────────────────────────

#[derive(Serialize)]
pub struct WadOpenResult {
    pub id: u64,
    pub name: String,
    pub path: String,
    pub version: String,
    pub chunk_count: usize,
}

/// One row of a mounted WAD's chunk list — what the frontend uses to
/// build its folder tree. `path` is the resolved string when the LMDB
/// hashtable knows the hash, else its 16-char hex form.
#[derive(Serialize)]
pub struct WadEntry {
    pub path: String,
    pub path_hash_hex: String,
    pub size: u64,
    pub compressed_size: u64,
    pub compression: &'static str,
    /// True when the chunk is a duplicate of an earlier chunk's data
    /// section (v3.0–v3.3 only). Phase 3 may surface this in the UI.
    pub is_duplicated: bool,
    /// True when the path was unresolved — the UI can render hex names
    /// under an "unknown/" bucket or with a different icon.
    pub unknown: bool,
}

/// Open + parse a WAD, bulk-resolve every path hash, and register it in
/// the in-process mount registry. Returns the new `MountId` plus a small
/// header describing the file.
#[tauri::command]
pub async fn wad_open(path: String) -> Result<WadOpenResult, String> {
    let id = mount(&path).map_err(|e| e.to_string())?;
    with_mount(id, |m| WadOpenResult {
        id: m.id,
        name: m.display_name(),
        path: m.path.to_string_lossy().into_owned(),
        version: m.version.to_string(),
        chunk_count: m.chunks.len(),
    })
    .ok_or_else(|| "Mount disappeared between insert and read".to_string())
}

/// Drop a mount and free its TOC + resolved paths. Idempotent.
#[tauri::command]
pub async fn wad_close(id: u64) -> Result<bool, String> {
    Ok(unmount(id))
}

/// Return every entry in the given mount as a flat list, suitable for
/// the frontend to fold into a tree by `/`-splitting `path`. Ordered by
/// resolved path so identical structure across re-opens is stable.
#[tauri::command]
pub async fn wad_list_entries(id: u64) -> Result<Vec<WadEntry>, String> {
    with_mount(id, |m| {
        let mut entries: Vec<WadEntry> = m
            .chunks
            .iter()
            .map(|c| {
                let hex = format!("{:016x}", c.path_hash);
                let path = m
                    .resolved
                    .get(&c.path_hash)
                    .cloned()
                    .unwrap_or_else(|| hex.clone());
                // `unknown` originally meant "resolved name equals the
                // hex fallback". The lazy magic-byte sniffer rewrites
                // that fallback to `<hex>.<ext>` once it has data, so
                // compare against the **file stem** (without extension)
                // — anything whose stem is still the hex didn't come
                // from a hashtable and should still render with the
                // unknown styling.
                let stem = std::path::Path::new(&path)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("");
                let unknown = stem == hex;
                WadEntry {
                    path,
                    path_hash_hex: hex,
                    size: c.uncompressed_size,
                    compressed_size: c.compressed_size,
                    compression: c.compression.as_str(),
                    is_duplicated: c.is_duplicated,
                    unknown,
                }
            })
            .collect();
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        entries
    })
    .ok_or_else(|| format!("No mounted WAD with id {}", id))
}

/// Snapshot of all currently-mounted WADs.
#[tauri::command]
pub async fn wad_list_mounted() -> Vec<MountInfo> {
    list_mounted()
}

// ── Phase 3 — extraction ─────────────────────────────────────────────────────

/// Extract chunks from a mounted WAD into `output_dir`. When
/// `selected_hashes` is empty or omitted, every chunk is extracted.
/// Otherwise only chunks whose 16-char hex hash is in the list are written.
///
/// Progress is emitted on the `wad-extract-progress` event tagged with
/// `action_id` so multiple concurrent extractions don't bleed into each
/// other's UI.
#[tauri::command]
pub async fn wad_extract(
    app: tauri::AppHandle,
    id: u64,
    output_dir: String,
    action_id: String,
    selected_hashes: Option<Vec<String>>,
    use_rename: Option<bool>,
) -> Result<ExtractResult, String> {
    let selected: HashSet<u64> = match selected_hashes {
        Some(list) => list
            .into_iter()
            .filter_map(|s| {
                let trimmed = s.trim().trim_start_matches("0x").trim_start_matches("0X");
                u64::from_str_radix(trimmed, 16).ok()
            })
            .collect(),
        None => HashSet::new(),
    };
    let use_rename = use_rename.unwrap_or(true);

    let output_path = PathBuf::from(&output_dir);

    // Run on the Tokio blocking pool so the rayon work doesn't block the
    // async runtime that's pumping IPC events.
    let app_clone = app.clone();
    let action_clone = action_id.clone();
    tokio::task::spawn_blocking(move || {
        extract_to_dir(&app_clone, id, &selected, &output_path, &action_clone, use_rename)
    })
    .await
    .map_err(|e| format!("Extraction task failed to join: {}", e))?
    .map_err(|e| e.to_string())
}

/// Signal a running extraction to stop. Returns `true` when the action
/// id matched a live job. Workers check the cancel flag between chunks,
/// so cancellation is cooperative — already-flying writes finish first.
#[tauri::command]
pub async fn wad_cancel_extract(action_id: String) -> bool {
    cancel_extraction(&action_id)
}

// ── Lazy extension sniff for unhashed entries ──────────────────────────────

/// Decompress just the magic bytes of every chunk in `id` whose
/// resolved name is still the 16-char hex fallback, append the sniffed
/// extension (`.dds`, `.bin`, `.skn`, …), and return the count of
/// chunks that gained an extension. Heavy operation — runs on the
/// blocking pool. The frontend kicks this off right after `wad_open`
/// so the file list shows real types instead of every unhashed entry
/// looking like a generic unknown blob.
#[tauri::command]
pub async fn wad_sniff_unknown(id: u64) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || crate::core::wad::sniff::sniff_unknown_in_mount(id))
        .await
        .map_err(|e| format!("Sniff task failed to join: {}", e))?
        .map_err(|e| e.to_string())
}

// ── Hash extraction (overlay scan) ──────────────────────────────────────────

/// Scan every chunk in `id` for embedded path strings and submesh names,
/// merge new discoveries into the FrogTools hash overlay files, and
/// return aggregate counts. Progress is emitted on the
/// `wad-hash-scan-progress` channel tagged with `action_id` so the UI
/// can stream chunk-level updates.
#[tauri::command]
pub async fn wad_extract_hashes(
    app: tauri::AppHandle,
    id: u64,
    action_id: String,
) -> Result<HashScanResult, String> {
    let dir = get_frogtools_hash_dir().map_err(|e| e.to_string())?;
    let app_clone = app.clone();
    let action_clone = action_id.clone();
    tokio::task::spawn_blocking(move || extract_hashes(&app_clone, id, &dir, &action_clone))
        .await
        .map_err(|e| format!("Hash scan task failed to join: {}", e))?
        .map_err(|e| e.to_string())
}

/// Read + decompress a single chunk and return its bytes as base64. Used
/// by the preview pane to feed DDS/TEX/PNG decoders without writing to
/// disk first. Runs on the blocking pool so the main async runtime stays
/// responsive even for multi-MB textures.
#[tauri::command]
pub async fn wad_read_chunk_b64(id: u64, path_hash_hex: String) -> Result<String, String> {
    let trimmed = path_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", path_hash_hex, e))?;

    let info = with_mount(id, |m| {
        m.chunks
            .iter()
            .find(|c| c.path_hash == hash)
            .map(|c| (m.path.clone(), *c))
    })
    .flatten()
    .ok_or_else(|| format!("Chunk {} not in mount {}", path_hash_hex, id))?;

    let (wad_path, chunk) = info;
    let bytes = tokio::task::spawn_blocking(move || read_chunk_decompressed_bytes(&wad_path, &chunk))
        .await
        .map_err(|e| format!("Read task join failed: {}", e))?
        .map_err(|e| e.to_string())?;

    Ok(B64.encode(&bytes))
}
