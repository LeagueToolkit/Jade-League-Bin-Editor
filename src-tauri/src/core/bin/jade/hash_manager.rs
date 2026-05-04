//! BIN converter hash table.
//!
//! Two execution modes, picked at load time by what the FrogTools dir
//! has on disk:
//!
//! 1. **LMDB present** (preferred) — we hold an `Arc<heed::Env>` for the
//!    `bin` and (optionally) `wad` named DBs. Lookups go through the
//!    in-memory RAM cache when [Preload Hashes] is on, else through a
//!    per-call read txn. **No text files are loaded into RAM in this
//!    mode** — that's the "no duplication" guarantee Jade promises.
//!
//! 2. **Text fallback** — when no LMDB layout is detected, we fall back
//!    to the legacy in-memory load: parse every `.txt` file under the
//!    hash dir into sorted `Vec<u32>` / `Vec<u64>` arrays + a packed
//!    string pool. Same shape as before, just minus the binary HHSH
//!    format we no longer ship.

use parking_lot::RwLock;
use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::core::hash::get_frogtools_hash_dir;
use crate::core::wad::{detect_layout, lookup_bin, lookup_wad, HashLayout};

pub struct HashManager {
    /// FNV1a → packed `(offset << 16) | length` into [`Self::string_storage`].
    /// Empty when the LMDB layer is in use — the converter reads from
    /// LMDB instead.
    fnv_keys: Vec<u32>,
    fnv_data: Vec<u64>,
    /// XXH64 → packed offset/length, same layout as FNV. Empty under LMDB.
    xxh_keys: Vec<u64>,
    xxh_data: Vec<u64>,
    string_storage: Vec<u8>,
    /// `Some(_)` when an LMDB layout was found in the FrogTools dir.
    /// Treated as the source of truth — when set, the in-memory `*_keys`
    /// arrays stay empty and lookups go through `lookup_bin` / `lookup_wad`.
    hash_dir: Option<PathBuf>,
}

impl HashManager {
    pub fn new() -> Self {
        Self {
            fnv_keys: Vec::new(),
            fnv_data: Vec::new(),
            xxh_keys: Vec::new(),
            xxh_data: Vec::new(),
            string_storage: Vec::new(),
            hash_dir: None,
        }
    }

    /// Look up an FNV1a hash name. Tries LMDB first when present, falls
    /// back to the in-memory text table.
    pub fn get_fnv1a(&self, hash: u32) -> Option<Cow<'_, str>> {
        if let Some(dir) = self.hash_dir.as_deref() {
            if let Some(arc) = lookup_bin(hash, dir) {
                return Some(Cow::Owned(arc.to_string()));
            }
            return None;
        }
        let idx = self.fnv_keys.binary_search(&hash).ok()?;
        let dat = self.fnv_data[idx];
        let offset = (dat >> 16) as usize;
        let length = (dat & 0xFFFF) as usize;
        std::str::from_utf8(&self.string_storage[offset..offset + length])
            .ok()
            .map(Cow::Borrowed)
    }

    /// Look up an XXH64 hash name. Tries LMDB first when present, falls
    /// back to the in-memory text table.
    pub fn get_xxh64(&self, hash: u64) -> Option<Cow<'_, str>> {
        if let Some(dir) = self.hash_dir.as_deref() {
            if let Some(arc) = lookup_wad(hash, dir) {
                return Some(Cow::Owned(arc.to_string()));
            }
            return None;
        }
        let idx = self.xxh_keys.binary_search(&hash).ok()?;
        let dat = self.xxh_data[idx];
        let offset = (dat >> 16) as usize;
        let length = (dat & 0xFFFF) as usize;
        std::str::from_utf8(&self.string_storage[offset..offset + length])
            .ok()
            .map(Cow::Borrowed)
    }

    /// Load hashes for the BIN converter. If an LMDB layout (split or
    /// combined) is present in `hash_dir`, switch to LMDB mode and skip
    /// the text-file load entirely so we don't double up on memory. If
    /// no LMDB is on disk, fall through to the legacy text loader.
    pub fn load(hash_dir: &Path) -> Self {
        if !hash_dir.exists() {
            eprintln!(
                "[jade::hash_manager] Hash directory does not exist: {}",
                hash_dir.display()
            );
            return Self::new();
        }

        if !matches!(detect_layout(hash_dir), HashLayout::Missing) {
            // LMDB is on disk — skip the text load entirely. The first
            // lookup will lazy-open the env (or hit the warm RAM cache
            // if Preload Hashes is on).
            println!("[jade::hash_manager] Using LMDB hashtable from {}", hash_dir.display());
            return Self {
                fnv_keys: Vec::new(),
                fnv_data: Vec::new(),
                xxh_keys: Vec::new(),
                xxh_data: Vec::new(),
                string_storage: Vec::new(),
                hash_dir: Some(hash_dir.to_path_buf()),
            };
        }

        Self::load_text_fallback(hash_dir)
    }

    /// Plaintext load — used only when no LMDB layout is detected.
    /// Skips game-specific hashes and `hashes.binhashes.txt`-style files
    /// that are hash-only (no path component).
    fn load_text_fallback(hash_dir: &Path) -> Self {
        let mut mgr = Self::new();

        let entries: Vec<_> = match std::fs::read_dir(hash_dir) {
            Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
            Err(e) => {
                eprintln!("[jade::hash_manager] Failed to read hash dir: {}", e);
                return mgr;
            }
        };

        let mut files_to_load = Vec::new();
        for entry in &entries {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("hashes.game.") {
                continue;
            }
            if name.ends_with(".txt") {
                files_to_load.push(entry.path());
            }
        }

        // Pre-scan to size the string pool so we don't pay growth realloc
        // costs on a 200 MB load.
        let total_string_size: usize = files_to_load
            .iter()
            .filter_map(|p| std::fs::metadata(p).ok())
            .map(|m| m.len() as usize)
            .sum();
        mgr.string_storage = Vec::with_capacity(total_string_size);

        for file in &files_to_load {
            mgr.load_text(file);
        }

        sort_parallel(&mut mgr.fnv_keys, &mut mgr.fnv_data);
        sort_parallel_u64(&mut mgr.xxh_keys, &mut mgr.xxh_data);

        let total = mgr.fnv_keys.len() + mgr.xxh_keys.len();
        println!(
            "[jade::hash_manager] Loaded {} text hashes ({} FNV1a, {} XXH64). String pool: {} KB",
            total,
            mgr.fnv_keys.len(),
            mgr.xxh_keys.len(),
            mgr.string_storage.len() / 1024,
        );

        mgr
    }

    fn load_text(&mut self, path: &Path) {
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => return,
        };

        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let space = match line.find(' ') {
                Some(i) if i > 0 && i < line.len() - 1 => i,
                _ => continue,
            };
            let hex_part = &line[..space];
            let name_part = &line[space + 1..];
            let name_bytes = name_part.as_bytes();

            let str_offset = self.string_storage.len();
            self.string_storage.extend_from_slice(name_bytes);

            if hex_part.len() == 16 {
                if let Ok(hash) = u64::from_str_radix(hex_part, 16) {
                    self.xxh_keys.push(hash);
                    self.xxh_data.push(((str_offset as u64) << 16) | (name_bytes.len() as u64 & 0xFFFF));
                }
            } else if hex_part.len() == 8 {
                if let Ok(hash) = u32::from_str_radix(hex_part, 16) {
                    self.fnv_keys.push(hash);
                    self.fnv_data.push(((str_offset as u64) << 16) | (name_bytes.len() as u64 & 0xFFFF));
                }
            }
        }
    }

    /// Total number of hashes loaded into RAM. LMDB-backed mode keeps
    /// nothing in process memory (lookups go through the mmap'd env), so
    /// this returns 0 in that case.
    pub fn total_count(&self) -> usize {
        if self.hash_dir.is_some() {
            0
        } else {
            self.fnv_keys.len() + self.xxh_keys.len()
        }
    }

    /// Estimate of in-process bytes held by the hash tables. LMDB-backed
    /// mode reports 0 — the OS's mapped pages aren't ours to count.
    pub fn memory_bytes(&self) -> usize {
        if self.hash_dir.is_some() {
            0
        } else {
            self.fnv_keys.len() * std::mem::size_of::<u32>()
                + self.fnv_data.len() * std::mem::size_of::<u64>()
                + self.xxh_keys.len() * std::mem::size_of::<u64>()
                + self.xxh_data.len() * std::mem::size_of::<u64>()
                + self.string_storage.len()
        }
    }

    /// `true` when the manager is backed by LMDB (split or combined).
    #[allow(dead_code)] // Surface for future UI / engine-switch decisions.
    pub fn is_lmdb(&self) -> bool {
        self.hash_dir.is_some()
    }
}

fn sort_parallel(keys: &mut Vec<u32>, data: &mut Vec<u64>) {
    let mut indices: Vec<usize> = (0..keys.len()).collect();
    indices.sort_by_key(|&i| keys[i]);
    let sorted_keys: Vec<u32> = indices.iter().map(|&i| keys[i]).collect();
    let sorted_data: Vec<u64> = indices.iter().map(|&i| data[i]).collect();
    *keys = sorted_keys;
    *data = sorted_data;
}

fn sort_parallel_u64(keys: &mut Vec<u64>, data: &mut Vec<u64>) {
    let mut indices: Vec<usize> = (0..keys.len()).collect();
    indices.sort_by_key(|&i| keys[i]);
    let sorted_keys: Vec<u64> = indices.iter().map(|&i| keys[i]).collect();
    let sorted_data: Vec<u64> = indices.iter().map(|&i| data[i]).collect();
    *keys = sorted_keys;
    *data = sorted_data;
}

/// Check if the Jade hash manager is already loaded.
pub fn are_jade_hashes_loaded() -> bool {
    JADE_HASHES.get().is_some()
}

fn get_default_hash_dir() -> Option<std::path::PathBuf> {
    get_frogtools_hash_dir().ok()
}

fn load_from_default_hash_dir() -> HashManager {
    if let Some(hash_dir) = get_default_hash_dir() {
        return HashManager::load(&hash_dir);
    }
    eprintln!("[jade::hash_manager] APPDATA not set");
    HashManager::new()
}

/// Global cached hash manager. Uses RwLock so it can be refreshed in-process.
static JADE_HASHES: OnceLock<RwLock<HashManager>> = OnceLock::new();

/// Get or initialize the cached hash manager.
pub fn get_cached_hashes() -> &'static RwLock<HashManager> {
    JADE_HASHES.get_or_init(|| RwLock::new(load_from_default_hash_dir()))
}

/// Reload cached hashes from disk and return total loaded count.
///
/// Loads from disk *before* acquiring the write lock so concurrent readers
/// (e.g. file opens that resolve hash names) only block during the brief
/// swap, not for the full multi-second disk read.
pub fn reload_cached_hashes() -> usize {
    let new_hashes = load_from_default_hash_dir();
    let count = new_hashes.total_count();
    let lock = get_cached_hashes();
    let mut guard = lock.write();
    *guard = new_hashes;
    count
}
