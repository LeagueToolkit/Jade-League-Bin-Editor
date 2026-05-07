//! Find the .bin that belongs to a given .skn inside a mounted WAD.
//!
//! League's convention (cross-checked with Flint's `find_skin_bin` and
//! Quartz's mod-tree layout):
//!
//! ```text
//! data/characters/{champion}/skins/{skin}.bin       ← the material/skin BIN
//! assets/characters/{champion}/skins/{skin}/<file>.skn  ← mesh (typical)
//! data/characters/{champion}/skins/{skin}/<file>.skn    ← mesh (some champs)
//! ```
//!
//! `{skin}` is `skin0`..`skinNN` (or sometimes the mesh sits under
//! `base/` which Riot maps to `skin0.bin`).
//!
//! We don't walk the disk — the mount has every chunk already, both
//! resolved and as raw path hashes. So the lookup is:
//!   1. Pull the SKN's resolved path.
//!   2. Derive `{champion}` and `{skin}` from it.
//!   3. Construct candidate BIN paths.
//!   4. xxh64-hash each candidate, look it up in the mount's chunk set.
//!   5. Return the first hit (path + hash).
//!
//! If the SKN's path is unresolved (only the 16-char hex is known), we
//! can't derive the champion → return `None`. Once the hash scanner
//! recovers the SKN's name, the next call will succeed.

use std::collections::HashSet;
use std::hash::Hasher;
use std::path::PathBuf;

use serde::Serialize;
use twox_hash::XxHash64;

use crate::core::wad::with_mount;

/// Result of a successful skin-BIN lookup. `path` is normalized to the
/// canonical lower-case forward-slash form Riot uses internally.
#[derive(Debug, Clone, Serialize)]
pub struct SkinBinMatch {
    pub path: String,
    pub path_hash_hex: String,
}

/// Look up the skin BIN belonging to an SKN by its `path_hash` inside
/// the mount identified by `mount_id`. Returns `None` if the SKN isn't
/// in the mount, its path isn't resolved yet, or no candidate BIN
/// matches a chunk in the mount.
pub fn find_skin_bin(mount_id: u64, skn_path_hash: u64) -> Option<SkinBinMatch> {
    with_mount(mount_id, |m| {
        // Build a hash-set of every chunk hash in the mount for O(1)
        // candidate testing. (One mount has at most ~50k chunks, so the
        // set fits comfortably in memory.)
        let chunk_hashes: HashSet<u64> = m.chunks.iter().map(|c| c.path_hash).collect();
        let resolved_skn = m.resolved.get(&skn_path_hash)?.to_lowercase();
        let candidates = candidate_skin_bin_paths(&resolved_skn);

        for candidate in candidates {
            let h = xxh64_path(&candidate);
            if chunk_hashes.contains(&h) {
                return Some(SkinBinMatch {
                    path: candidate,
                    path_hash_hex: format!("{:016x}", h),
                });
            }
        }
        None
    })
    .flatten()
}

/// Generate every `data/characters/{champion}/skins/{skin}.bin` candidate
/// for a given SKN path. Multiple variants because Riot is inconsistent
/// — sometimes the mesh sits under `assets/`, sometimes `data/`,
/// sometimes `skin0/` and sometimes `base/`. We try them all and let
/// the chunk-set lookup pick the one that exists.
fn candidate_skin_bin_paths(skn_path_lower: &str) -> Vec<String> {
    let parts: Vec<&str> = skn_path_lower
        .split(|c| c == '/' || c == '\\')
        .filter(|s| !s.is_empty())
        .collect();

    let champion = extract_champion(&parts);
    let skin = extract_skin(&parts);

    let mut out: Vec<String> = Vec::new();
    let Some(champion) = champion else {
        return out;
    };

    // Helper to push without duplicates.
    let mut push = |s: String| {
        if !out.iter().any(|x| x == &s) {
            out.push(s);
        }
    };

    if let Some(ref skin) = skin {
        // Primary candidate — the literal skin folder name with `.bin`.
        push(format!("data/characters/{champion}/skins/{skin}.bin"));

        // Zero-stripped variant. Riot is inconsistent: the mesh folder
        // is sometimes `skin02/` while the matching BIN file is named
        // `skin2.bin` (no leading zero). Emit both so whichever is
        // present in the WAD wins. For double-digit skins the strip
        // is a no-op (`skin11` → `skin11`), so the dedup helper
        // handles it cleanly.
        if let Some(num_str) = skin.strip_prefix("skin") {
            if let Ok(n) = num_str.parse::<u32>() {
                push(format!("data/characters/{champion}/skins/skin{}.bin", n));
            }
        }
        // IMPORTANT: do NOT fall back to `skin0.bin` here. A `skin02`
        // SKN whose specific BIN happens to be missing from the WAD
        // would otherwise falsely match the base-skin BIN — wrong
        // materials, wrong textures, hours of confusion. Returning an
        // empty/short list and `None` from the lookup is much better
        // than returning a wrong answer.
    } else {
        // We couldn't determine the skin from the path (the SKN sits
        // outside the canonical `skins/{skinNN}/` layout). Last-resort
        // fallback to skin0.bin so we still try *something* useful.
        push(format!("data/characters/{champion}/skins/skin0.bin"));
    }

    out
}

/// Pick the champion name out of a path. Two common patterns:
///   - `.../characters/{champion}/...`     ← the canonical one
///   - `assets/characters/{champion}/...`  ← same, just rooted at assets/
/// First match wins.
fn extract_champion(parts: &[&str]) -> Option<String> {
    for (i, p) in parts.iter().enumerate() {
        if *p == "characters" && i + 1 < parts.len() {
            return Some(parts[i + 1].to_string());
        }
    }
    None
}

/// Pick the skin folder out of a path. Looks for `skins/{skinNN|base}`
/// — falls back to `None` if the path doesn't follow that layout.
fn extract_skin(parts: &[&str]) -> Option<String> {
    for (i, p) in parts.iter().enumerate() {
        if *p == "skins" && i + 1 < parts.len() {
            let next = parts[i + 1];
            if next == "base" {
                return Some("skin0".to_string());
            }
            // Any `skinNN` literal is taken verbatim.
            if next.starts_with("skin")
                && next.len() > 4
                && next[4..].chars().all(|c| c.is_ascii_digit())
            {
                return Some(next.to_string());
            }
        }
    }
    None
}

fn xxh64_path(s: &str) -> u64 {
    let mut h = XxHash64::with_seed(0);
    h.write(s.as_bytes());
    h.finish()
}

#[allow(dead_code)]
fn _suppress_unused_pathbuf_import_warning() -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_champion_from_canonical_layout() {
        let parts: Vec<&str> = "data/characters/aatrox/skins/skin0/aatrox.skn".split('/').collect();
        assert_eq!(extract_champion(&parts).as_deref(), Some("aatrox"));
    }

    #[test]
    fn extracts_champion_from_assets_layout() {
        let parts: Vec<&str> =
            "assets/characters/lux/skins/skin12/lux.skn".split('/').collect();
        assert_eq!(extract_champion(&parts).as_deref(), Some("lux"));
    }

    #[test]
    fn maps_base_to_skin0() {
        let parts: Vec<&str> = "data/characters/aatrox/skins/base/aatrox.skn".split('/').collect();
        assert_eq!(extract_skin(&parts).as_deref(), Some("skin0"));
    }

    #[test]
    fn extracts_skin_literal() {
        let parts: Vec<&str> =
            "data/characters/lux/skins/skin42/lux.skn".split('/').collect();
        assert_eq!(extract_skin(&parts).as_deref(), Some("skin42"));
    }

    #[test]
    fn ignores_non_skin_subdir() {
        let parts: Vec<&str> = "data/characters/aatrox/animations/idle.anm".split('/').collect();
        assert_eq!(extract_skin(&parts), None);
    }

    #[test]
    fn candidate_set_includes_skin0_fallback() {
        let cand = candidate_skin_bin_paths("data/characters/aatrox/skins/base/aatrox.skn");
        assert!(cand.iter().any(|p| p == "data/characters/aatrox/skins/skin0.bin"));
    }

    /// Regression: when the SKN sits under a specific skin folder
    /// (e.g. `skin02/`), the candidate set must NOT include `skin0.bin`.
    /// Falling back to skin0 caused wrong-material matches in the wild
    /// (skin02.skn was being paired with skin0.bin's textures).
    #[test]
    fn no_skin0_fallback_when_specific_skin_inferred() {
        let cand = candidate_skin_bin_paths("data/characters/aatrox/skins/skin02/aatrox.skn");
        assert!(cand.contains(&"data/characters/aatrox/skins/skin02.bin".to_string()));
        // Zero-stripped variant — Riot sometimes drops the leading 0 in
        // BIN filenames even when the mesh folder keeps it.
        assert!(cand.contains(&"data/characters/aatrox/skins/skin2.bin".to_string()));
        // The bug we're guarding against:
        assert!(!cand.contains(&"data/characters/aatrox/skins/skin0.bin".to_string()));
    }

    /// Two-digit skins shouldn't generate spurious extra candidates
    /// (no zero to strip, dedup keeps the list at size 1).
    #[test]
    fn double_digit_skin_emits_one_candidate() {
        let cand = candidate_skin_bin_paths("data/characters/lux/skins/skin11/lux.skn");
        assert_eq!(cand, vec!["data/characters/lux/skins/skin11.bin".to_string()]);
    }
}
