//! Mount registry — keeps parsed WAD TOCs alive between Tauri command
//! calls so the frontend can navigate without re-parsing on every click.
//!
//! Mounts are identified by a process-monotonic u64. The registry holds
//! resolved paths alongside the chunks so callers don't pay the LMDB
//! lookup cost per query.

use crate::core::hash::get_frogtools_hash_dir;
use crate::core::wad::format::{WadChunk, WadVersion};
use crate::core::wad::lmdb_hashes::resolve_wad_bulk;
use crate::core::wad::reader::{read_wad_toc, WadToc};
use crate::error::Result;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

/// Process-monotonic mount id. Stable for the lifetime of the process,
/// reusable as a string key on the JS side.
pub type MountId = u64;

/// Parsed WAD + bulk-resolved paths. Held in the global registry until
/// [`unmount`] is called.
pub struct MountedWad {
    pub id: MountId,
    pub path: PathBuf,
    pub version: WadVersion,
    pub chunks: Vec<WadChunk>,
    /// `path_hash → resolved path` (or 16-char hex fallback when unknown).
    pub resolved: HashMap<u64, String>,
}

impl MountedWad {
    /// File-name component of the WAD path (used by the UI as a tab title).
    pub fn display_name(&self) -> String {
        self.path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.path.to_string_lossy().into_owned())
    }
}

static REGISTRY: OnceLock<RwLock<HashMap<MountId, MountedWad>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn registry() -> &'static RwLock<HashMap<MountId, MountedWad>> {
    REGISTRY.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Open a WAD, parse its TOC, bulk-resolve every chunk's hash via the
/// LMDB hashtable, and stash the result in the registry. The hash table
/// is opened lazily on the first lookup; cold-cache cost is one-shot.
pub fn mount(path: impl Into<PathBuf>) -> Result<MountId> {
    let path: PathBuf = path.into();
    let WadToc { version, chunks, .. } = read_wad_toc(&path)?;

    let hashes: Vec<u64> = chunks.iter().map(|c| c.path_hash).collect();
    let hash_dir = get_frogtools_hash_dir()?;
    let resolved = resolve_wad_bulk(&hashes, &hash_dir);

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let mounted = MountedWad {
        id,
        path,
        version,
        chunks,
        resolved,
    };

    registry().write().insert(id, mounted);
    Ok(id)
}

/// Drop a mount. No-op if `id` is unknown.
pub fn unmount(id: MountId) -> bool {
    registry().write().remove(&id).is_some()
}

/// Run `f` against the mount under a read lock and return the result, or
/// `None` if the id isn't registered.
pub fn with_mount<R>(id: MountId, f: impl FnOnce(&MountedWad) -> R) -> Option<R> {
    let guard = registry().read();
    guard.get(&id).map(f)
}

/// Snapshot a small descriptor for every currently-mounted WAD — for the
/// "open WADs" dropdown in the UI.
pub fn list_mounted() -> Vec<MountInfo> {
    registry()
        .read()
        .values()
        .map(|m| MountInfo {
            id: m.id,
            path: m.path.to_string_lossy().into_owned(),
            name: m.display_name(),
            version: m.version.to_string(),
            chunk_count: m.chunks.len(),
        })
        .collect()
}

/// Lightweight projection of a mount, returned to the frontend.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MountInfo {
    pub id: MountId,
    pub path: String,
    pub name: String,
    pub version: String,
    pub chunk_count: usize,
}
