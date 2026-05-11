//! Tauri commands for 3D mesh previews. Mirrors `wad_commands.rs` style:
//! the parser lives in `core/mesh/` and these commands are thin
//! request-shaping layers that hand bytes to it.

use crate::core::bin::read_bin_ltk;
use crate::core::mesh::skin_textures::find_static_mesh_texture;
use crate::core::mesh::texture_decode::decode_auto;
use crate::core::mesh::{
    find_skin_bin, parse_anm, parse_scb, parse_skl, parse_skn, parse_sco,
    read_skin_textures_for_skn, read_skin_textures_for_skn_disk, read_skn_animations,
    read_skn_animations_disk, AnimationListing, BakedAnimation, SkinBinMatch, SklSkeleton,
    SknMesh, StaticMesh,
};
use crate::core::wad::{read_chunk_decompressed_bytes, with_mount};
use serde::Serialize;
use std::collections::HashSet;
use std::hash::Hasher;
use std::path::PathBuf;
use twox_hash::XxHash64;

/// Parse an SKN file off disk. Path is whatever the frontend hands us —
/// usually a previously-extracted file from the WAD extract folder.
#[tauri::command]
pub async fn read_skn_mesh(path: String) -> Result<SknMesh, String> {
    let pb = PathBuf::from(&path);
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(&pb))
        .await
        .map_err(|e| format!("Read task join failed: {}", e))?
        .map_err(|e| format!("Read SKN '{}': {}", path, e))?;
    parse_skn(&bytes).map_err(|e| e.to_string())
}

/// Parse an SKN that lives inside a mounted WAD. Pulls the chunk bytes by
/// path hash, decompresses them on the blocking pool, then parses on the
/// async thread (parsing is in-memory and fast — KB to low-MB at most).
#[tauri::command]
pub async fn wad_read_skn_mesh(id: u64, path_hash_hex: String) -> Result<SknMesh, String> {
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

    parse_skn(&bytes).map_err(|e| e.to_string())
}

// ── SCB / SCO (static meshes) ───────────────────────────────────────
//
// Same shape as the SKN commands above, just with the StaticMesh DTO.
// Frontend dispatches by the file extension on the previewed source.
// The texture pipeline reuses the existing `wad_guess_textures` flow:
// for a static mesh we pass its single material name as a one-element
// submesh list, the guess searches the same folder, and the matched
// texture (if any) gets applied. No skin-BIN lookup — SCB/SCO
// materials are referenced by direct name and don't show up under
// `skinMeshProperties.materialOverride`.

#[tauri::command]
pub async fn read_scb_mesh(path: String) -> Result<StaticMesh, String> {
    let pb = PathBuf::from(&path);
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(&pb))
        .await
        .map_err(|e| format!("Read task join failed: {}", e))?
        .map_err(|e| format!("Read SCB '{}': {}", path, e))?;
    parse_scb(&bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn wad_read_scb_mesh(id: u64, path_hash_hex: String) -> Result<StaticMesh, String> {
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
    parse_scb(&bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_sco_mesh(path: String) -> Result<StaticMesh, String> {
    let pb = PathBuf::from(&path);
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(&pb))
        .await
        .map_err(|e| format!("Read task join failed: {}", e))?
        .map_err(|e| format!("Read SCO '{}': {}", path, e))?;
    parse_sco(&bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn wad_read_sco_mesh(id: u64, path_hash_hex: String) -> Result<StaticMesh, String> {
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
    parse_sco(&bytes).map_err(|e| e.to_string())
}

// ── SKL (skeleton) ───────────────────────────────────────────────────
//
// Two consumers:
//  1. Standalone `.skl` preview — same shape as SKN, just renders the
//     bone hierarchy without any geometry.
//  2. SKN overlay — when the SKN preview is loaded with the "show
//     skeleton" toggle on, we look up the sibling .skl (same path,
//     different extension) and add its bones to the scene.
//
// `wad_find_sibling_skl` exists for case 2: from an SKN's path hash
// it derives the matching .skl path, hashes that, and returns the
// .skl's path hash if a chunk with that hash lives in the same mount.

#[tauri::command]
pub async fn read_skl_skeleton(path: String) -> Result<SklSkeleton, String> {
    let pb = PathBuf::from(&path);
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(&pb))
        .await
        .map_err(|e| format!("Read task join failed: {}", e))?
        .map_err(|e| format!("Read SKL '{}': {}", path, e))?;
    parse_skl(&bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn wad_read_skl_skeleton(id: u64, path_hash_hex: String) -> Result<SklSkeleton, String> {
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

    parse_skl(&bytes).map_err(|e| e.to_string())
}

/// Find the SKL chunk that lives next to the given SKN inside the same
/// mount. Returns `null` when the SKN's path isn't resolved (we can't
/// derive the .skl name from a hash-only path) or when the .skl isn't
/// in this WAD. Frontend uses this to layer a skeleton overlay over
/// the SKN preview.
#[tauri::command]
pub async fn wad_find_sibling_skl(
    id: u64,
    skn_path_hash_hex: String,
) -> Result<Option<String>, String> {
    let trimmed = skn_path_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let skn_hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", skn_path_hash_hex, e))?;

    // Need the SKN's resolved path to construct the sibling .skl path.
    // If we only have the hex fallback, there's no way to derive it.
    let skn_path: Option<String> = with_mount(id, |m| m.resolved.get(&skn_hash).cloned()).flatten();
    let Some(skn_path) = skn_path else {
        return Ok(None);
    };

    // Build candidate .skl paths by extension swap. Riot's tooling
    // outputs both lowercase and (rarely) capitalised paths; the
    // candidates list mirrors the same fallbacks `wad_guess_textures`
    // uses so we don't miss a sibling that happens to be cased
    // differently.
    let lower = skn_path.to_lowercase();
    let stem_end = lower.rfind('.').unwrap_or(lower.len());
    let skl_lower = format!("{}.skl", &lower[..stem_end]);

    let chunk_hashes: HashSet<u64> = with_mount(id, |m| {
        m.chunks.iter().map(|c| c.path_hash).collect()
    })
    .unwrap_or_default();

    for candidate in path_candidates(&skl_lower) {
        let h = xxh64_lower(&candidate);
        if chunk_hashes.contains(&h) {
            return Ok(Some(format!("{:016x}", h)));
        }
    }
    Ok(None)
}

/// Locate the skin BIN (`data/characters/{champion}/skins/{skin}.bin`)
/// for a given SKN path inside a mounted WAD. Returns `null` if the SKN
/// isn't in the mount, isn't resolved, or no candidate BIN exists in
/// the WAD.
#[tauri::command]
pub async fn find_skin_bin_for_skn(
    id: u64,
    path_hash_hex: String,
) -> Result<Option<SkinBinMatch>, String> {
    let trimmed = path_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", path_hash_hex, e))?;
    Ok(find_skin_bin(id, hash))
}

/// One material/texture entry returned to the frontend, enriched with
/// the texture's chunk hash (if it lives in this same mount). The
/// frontend then uses `wad_read_chunk_b64` to actually fetch + decode
/// the texture bytes — no new bytes-IPC plumbing needed.
#[derive(Debug, Clone, Serialize)]
pub struct TextureBinding {
    pub material: String,
    pub texture_path: String,
    /// `null` when the texture's path can't be hashed to a chunk
    /// present in this mount (e.g. it lives in a different WAD,
    /// or the path uses an `assets/...` prefix that doesn't match
    /// any chunk's resolved name).
    pub chunk_hash_hex: Option<String>,
    /// Disk path to the texture file when the SKN was loaded from
    /// disk and the file exists. `None` for WAD-source previews;
    /// the frontend uses `chunk_hash_hex` in that case.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture_disk_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SknTextureBindings {
    pub bin_path: String,
    pub bin_path_hash_hex: String,
    pub default_texture: Option<String>,
    pub default_chunk_hash_hex: Option<String>,
    /// Disk path to the BASE texture when the SKN was loaded from
    /// disk and the file exists. `None` for WAD-source previews.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_texture_disk_path: Option<String>,
    pub bindings: Vec<TextureBinding>,
}

/// Read + parse an ANM chunk from a mounted WAD into a baked
/// per-joint frame table. Heavy enough on big animations (200 joints
/// × 100 frames) that we run on the blocking pool. Compressed ANMs
/// produce a clean error surfaced to the frontend; only uncompressed
/// (v3/v4/v5) plays in v1.
#[tauri::command]
pub async fn wad_load_animation(
    id: u64,
    path_hash_hex: String,
) -> Result<BakedAnimation, String> {
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
    .ok_or_else(|| format!("ANM chunk {} not in mount {}", path_hash_hex, id))?;
    let (wad_path, chunk) = info;

    let baked = tokio::task::spawn_blocking(move || -> Result<BakedAnimation, String> {
        let bytes = read_chunk_decompressed_bytes(&wad_path, &chunk)
            .map_err(|e| format!("read ANM chunk: {e}"))?;
        parse_anm(&bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("ANM task join failed: {e}"))??;

    Ok(baked)
}

/// Disk-source counterpart of [`wad_load_animation`]. Reads the ANM
/// straight from the given path (no WAD lookup) and parses it into
/// the same `BakedAnimation` shape, so the frontend's player works
/// identically across sources.
#[tauri::command]
pub async fn read_animation(path: String) -> Result<BakedAnimation, String> {
    let pb = PathBuf::from(&path);
    let baked = tokio::task::spawn_blocking(move || -> Result<BakedAnimation, String> {
        let bytes = std::fs::read(&pb).map_err(|e| format!("read ANM '{}': {}", pb.display(), e))?;
        parse_anm(&bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("ANM task join failed: {e}"))??;
    Ok(baked)
}

/// Disk-source counterpart of [`wad_read_skn_animations`]. Walks up
/// from the SKN path to find the skin BIN and animation BIN on disk,
/// returning the same listing shape — except clips carry
/// `anm_disk_path` instead of `anm_chunk_hash_hex`.
#[tauri::command]
pub async fn read_skn_animations_disk_cmd(
    skn_path: String,
) -> Result<Option<AnimationListing>, String> {
    tokio::task::spawn_blocking(move || read_skn_animations_disk(&skn_path))
        .await
        .map_err(|e| format!("animations disk task join failed: {e}"))?
}

/// Disk-source counterpart of [`wad_read_skin_textures`]. Walks the
/// SKN's sibling skin BIN and resolves each material's texture path
/// to a file on disk under the same root.
#[tauri::command]
pub async fn read_skn_textures_disk(
    skn_path: String,
) -> Result<Option<SknTextureBindings>, String> {
    let map = tokio::task::spawn_blocking({
        let p = skn_path.clone();
        move || read_skin_textures_for_skn_disk(&p)
    })
    .await
    .map_err(|e| format!("textures disk task join: {e}"))??;

    let Some(map) = map else { return Ok(None) };

    // Reconstruct disk paths through the same DiskLayout the BIN /
    // animation walkers use. `texture_path` strings live in the BIN
    // as `ASSETS/...` (uppercase by Riot convention); we try each
    // candidate form (with `wad_subfolder` injected, then without)
    // since re-paths can be asymmetric — asset side may carry a
    // subfolder while BIN strings still reference the canonical path,
    // or vice versa.
    use crate::core::mesh::skin_bin::{assets_path_variants, disk_layout_for_skn};
    let layout = match disk_layout_for_skn(&skn_path) {
        Some(l) => l,
        None => return Ok(None),
    };

    let resolve = |bin_path: &str| -> Option<String> {
        let lower = bin_path.to_lowercase();
        let rel = lower.strip_prefix("assets/").unwrap_or(&lower);
        assets_path_variants(rel, &layout)
            .into_iter()
            .find(|p| std::path::Path::new(p).is_file())
    };

    let default_texture_disk_path = map.default_texture.as_deref().and_then(resolve);
    let bindings = map
        .materials
        .into_iter()
        .map(|m| TextureBinding {
            texture_disk_path: resolve(&m.texture_path),
            chunk_hash_hex: None,
            material: m.material,
            texture_path: m.texture_path,
        })
        .collect();

    Ok(Some(SknTextureBindings {
        bin_path: map.bin_path,
        bin_path_hash_hex: map.bin_path_hash_hex,
        default_texture: map.default_texture,
        default_chunk_hash_hex: None,
        default_texture_disk_path,
        bindings,
    }))
}

/// Resolve the SKN's skin BIN → AnimationGraphData link → animation
/// BIN, and return its `AtomicClipData` clips with resolved chunk
/// hashes. Returns `null` for any structural miss (no skin BIN, no
/// animation graph, animation BIN not in mount). Heavy enough on
/// big champion BINs that we run on the blocking pool.
#[tauri::command]
pub async fn wad_read_skn_animations(
    id: u64,
    path_hash_hex: String,
) -> Result<Option<AnimationListing>, String> {
    let trimmed = path_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", path_hash_hex, e))?;

    let listing = tokio::task::spawn_blocking(move || read_skn_animations(id, hash))
        .await
        .map_err(|e| format!("animations task join failed: {e}"))??;

    Ok(listing)
}

/// Resolve every texture path the SKN's skin BIN references to its
/// chunk hash inside `mount_id`. Returns `null` if the SKN's BIN can't
/// be located in the mount.
#[tauri::command]
pub async fn wad_read_skin_textures(
    id: u64,
    path_hash_hex: String,
) -> Result<Option<SknTextureBindings>, String> {
    let trimmed = path_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", path_hash_hex, e))?;

    // Heavy work — running BIN→text on the blocking pool keeps the
    // Tauri runtime responsive even on chunky champion BINs.
    let map = tokio::task::spawn_blocking(move || read_skin_textures_for_skn(id, hash))
        .await
        .map_err(|e| format!("texture-map task join failed: {e}"))??;

    let Some(map) = map else { return Ok(None) };

    // Build the set of chunk hashes in this mount once so we can do
    // O(1) presence checks per texture path. (Some champions reference
    // dozens of textures via shared materials.)
    let chunk_hashes: HashSet<u64> = with_mount(id, |m| {
        m.chunks.iter().map(|c| c.path_hash).collect()
    })
    .unwrap_or_default();

    // For each texture path, try the canonical hash + a couple of
    // common variants. Riot is inconsistent with `assets/` vs. `data/`
    // and case (paths in BINs are sometimes upper-cased ASSETS/...).
    let resolve = |path: &str| -> Option<String> {
        for candidate in path_candidates(path) {
            let h = xxh64_lower(&candidate);
            if chunk_hashes.contains(&h) {
                return Some(format!("{:016x}", h));
            }
        }
        None
    };

    let default_chunk_hash_hex = map.default_texture.as_deref().and_then(resolve);
    let bindings = map
        .materials
        .into_iter()
        .map(|m| TextureBinding {
            chunk_hash_hex: resolve(&m.texture_path),
            material: m.material,
            texture_path: m.texture_path,
            texture_disk_path: None,
        })
        .collect();

    Ok(Some(SknTextureBindings {
        bin_path: map.bin_path,
        bin_path_hash_hex: map.bin_path_hash_hex,
        default_texture: map.default_texture,
        default_chunk_hash_hex,
        default_texture_disk_path: None,
        bindings,
    }))
}

/// Find the diffuse texture for a static mesh (SCB / SCO) by walking
/// the skin BIN for any object that references the mesh's path,
/// then scoring the texture strings in that same object's subtree.
/// See `find_static_mesh_texture` for the algorithm.
///
/// Returns `null` if no candidate is found or the mesh path can't be
/// resolved through the mount.
#[tauri::command]
pub async fn wad_find_static_mesh_texture(
    id: u64,
    mesh_path_hash_hex: String,
) -> Result<Option<TextureBinding>, String> {
    let trimmed = mesh_path_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let mesh_hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", mesh_path_hash_hex, e))?;

    // Need the mesh's resolved path so we can string-match it inside
    // the BIN tree. If the mount only knows the hex fallback, we
    // can't find string-based references → bail.
    let mesh_path = with_mount(id, |m| m.resolved.get(&mesh_hash).cloned()).flatten();
    let Some(mesh_path) = mesh_path else {
        return Ok(None);
    };

    // Locate the skin BIN — same heuristic as for SKN. SCB/SCO files
    // sit alongside the skin's other assets so the BIN that owns the
    // skin owns the mesh's texture wiring too.
    let bin_match = match find_skin_bin(id, mesh_hash) {
        Some(m) => m,
        None => return Ok(None),
    };
    let bin_hash = u64::from_str_radix(&bin_match.path_hash_hex, 16)
        .map_err(|e| format!("bad bin hash hex: {e}"))?;

    let info = with_mount(id, |m| {
        m.chunks
            .iter()
            .find(|c| c.path_hash == bin_hash)
            .map(|c| (m.path.clone(), *c))
    })
    .flatten()
    .ok_or_else(|| format!("bin chunk not in mount {}", id))?;

    let texture_path: Option<String> = tokio::task::spawn_blocking(move || {
        let bytes = read_chunk_decompressed_bytes(&info.0, &info.1)
            .map_err(|e| format!("read bin: {e}"))?;
        let tree = read_bin_ltk(&bytes).map_err(|e| format!("parse bin: {e}"))?;
        Ok::<Option<String>, String>(find_static_mesh_texture(&tree, &mesh_path))
    })
    .await
    .map_err(|e| format!("static-tex task join: {e}"))??;

    let Some(texture_path) = texture_path else {
        return Ok(None);
    };

    // Resolve to a chunk hash inside the same mount. Try the
    // canonical lowercase form first, then a `data/`-mirrored variant
    // — same path-candidate machinery the SKN texture binder uses.
    let chunk_hashes: HashSet<u64> = with_mount(id, |m| {
        m.chunks.iter().map(|c| c.path_hash).collect()
    })
    .unwrap_or_default();
    let chunk_hash_hex = path_candidates(&texture_path)
        .into_iter()
        .find_map(|c| {
            let h = xxh64_lower(&c);
            chunk_hashes.contains(&h).then(|| format!("{:016x}", h))
        });

    Ok(Some(TextureBinding {
        material: bin_match.path,
        texture_path,
        chunk_hash_hex,
        texture_disk_path: None,
    }))
}

/// Guess texture bindings when no skin BIN is available (or the user
/// wants to override what the BIN says).
///
/// Searches **only the folder the SKN lives in** — Riot mod / extracted
/// trees keep meshes and their sibling textures together (e.g.
/// `data/characters/veigar/skins/baron/veigar_baron.skn` next to
/// `veigar_baron_tx_cm.tex`). Searching the whole mount would falsely
/// pull in unrelated textures from neighbouring skins.
///
/// Strategy:
///   1. Resolve the SKN's path → folder.
///   2. Find every `.tex` / `.dds` chunk whose resolved path is in
///      that exact folder.
///   3. For each requested submesh name, try in priority order:
///        a. exact stem match (`"Body"` → `body.tex`)
///        b. trailing-digit-stripped match (`"Body2"` → `body.tex`)
///        c. fuzzy substring match
///   4. Pick a "main" texture using `skn_basename` + common naming
///      heuristics (`*_tx_cm`, `*_diffuse`, `mainTex`, etc.) and use
///      it as a fallback for submeshes that nothing else matched.
///
/// Returns one entry per requested submesh; `chunk_hash_hex` is null
/// when no candidate stuck.
#[tauri::command]
pub async fn wad_guess_textures(
    id: u64,
    skn_path_hash_hex: String,
    submesh_names: Vec<String>,
    skn_basename: Option<String>,
) -> Result<Vec<TextureBinding>, String> {
    let trimmed = skn_path_hash_hex
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let skn_hash = u64::from_str_radix(trimmed, 16)
        .map_err(|e| format!("Invalid hex hash '{}': {}", skn_path_hash_hex, e))?;

    // Resolve the SKN to its folder (everything up to the last '/').
    // If the SKN's path isn't in the resolved table — i.e. it's still
    // a 16-char hex fallback — we have no folder to search and bail
    // with empty bindings.
    let skn_folder: Option<String> = with_mount(id, |m| {
        let path = m.resolved.get(&skn_hash)?;
        let lower = path.to_lowercase();
        let cut = lower.rfind('/')?;
        Some(lower[..cut].to_string())
    })
    .ok_or_else(|| format!("mount {} not registered", id))?;
    let Some(skn_folder) = skn_folder else {
        return Ok(submesh_names
            .into_iter()
            .map(|name| TextureBinding {
                material: name,
                texture_path: String::new(),
                chunk_hash_hex: None,
                texture_disk_path: None,
            })
            .collect());
    };

    // Find every texture chunk that lives in the SAME folder as the
    // SKN. That's where Riot puts the matching textures in extracted
    // mod trees, and limiting to one folder keeps cross-skin
    // pollution out (an "armoraegis" texture from a neighbour skin
    // shouldn't get pulled into Veigar Baron's preview).
    let candidates: Vec<(String, String, u64)> = with_mount(id, |m| {
        m.chunks
            .iter()
            .filter_map(|c| {
                let path = m.resolved.get(&c.path_hash)?;
                let lower = path.to_lowercase();
                if !(lower.ends_with(".tex") || lower.ends_with(".dds")) {
                    return None;
                }
                let chunk_folder = lower.rfind('/').map(|i| &lower[..i])?;
                if chunk_folder != skn_folder {
                    return None;
                }
                let stem = file_stem_lower(&lower)?;
                Some((path.clone(), stem, c.path_hash))
            })
            .collect()
    })
    .unwrap_or_default();

    if candidates.is_empty() {
        return Ok(submesh_names
            .into_iter()
            .map(|name| TextureBinding {
                material: name,
                texture_path: String::new(),
                chunk_hash_hex: None,
                texture_disk_path: None,
            })
            .collect());
    }

    // Pick a "main" texture once for the fallback path. Priority:
    //   1. stem matches the SKN's basename (e.g. SKN `aatrox.skn` →
    //      `aatrox.tex` is the body).
    //   2. stem ends in `_tx_cm` (Riot convention for color-map).
    //   3. stem contains "diffuse".
    //   4. stem contains "main_texture" / "main".
    //   5. first candidate alphabetically (just so it's stable).
    let main_chunk_hex = pick_main_texture(&candidates, skn_basename.as_deref())
        .map(|h| format!("{:016x}", h));

    // Run the per-submesh match cascade. Once one path lands we move
    // on — a hit at exact wins over loose, etc.
    let mut out = Vec::with_capacity(submesh_names.len());
    for raw_name in submesh_names {
        let name = raw_name.to_lowercase();

        let hit = match_exact(&candidates, &name)
            .or_else(|| match_strip_digits(&candidates, &name))
            .or_else(|| match_fuzzy(&candidates, &name))
            .map(|(path, h)| (path, format!("{:016x}", h)));

        let (path, hex) = match hit {
            Some(h) => (h.0, Some(h.1)),
            None => match main_chunk_hex.as_deref() {
                // Use the same texture path string as the resolved
                // "main" chunk so the frontend can log it — but
                // chunk_hash_hex is what actually matters for
                // fetching. Fall back to empty path string.
                Some(_) => {
                    let main_path = candidates
                        .iter()
                        .find(|(_, _, h)| Some(format!("{:016x}", h)) == main_chunk_hex)
                        .map(|(p, _, _)| p.clone())
                        .unwrap_or_default();
                    (main_path, main_chunk_hex.clone())
                }
                None => (String::new(), None),
            },
        };

        out.push(TextureBinding {
            material: raw_name,
            texture_path: path,
            chunk_hash_hex: hex,
            texture_disk_path: None,
        });
    }

    Ok(out)
}

fn file_stem_lower(path: &str) -> Option<String> {
    let last_slash = path.rfind('/').map(|i| i + 1).unwrap_or(0);
    let basename = &path[last_slash..];
    let dot = basename.rfind('.')?;
    Some(basename[..dot].to_string())
}

fn match_exact(candidates: &[(String, String, u64)], name: &str) -> Option<(String, u64)> {
    candidates
        .iter()
        .find(|(_, stem, _)| stem == name)
        .map(|(p, _, h)| (p.clone(), *h))
}

fn match_strip_digits(candidates: &[(String, String, u64)], name: &str) -> Option<(String, u64)> {
    let stripped = name.trim_end_matches(|c: char| c.is_ascii_digit());
    if stripped.is_empty() || stripped == name {
        return None;
    }
    candidates
        .iter()
        .find(|(_, stem, _)| stem == stripped || stem.trim_end_matches(|c: char| c.is_ascii_digit()) == stripped)
        .map(|(p, _, h)| (p.clone(), *h))
}

fn match_fuzzy(candidates: &[(String, String, u64)], name: &str) -> Option<(String, u64)> {
    // "Stem contains material name OR vice versa." Cheap heuristic
    // that catches things like `aatrox_body_tx_cm` ↔ `body`.
    candidates
        .iter()
        .find(|(_, stem, _)| stem.contains(name) || name.contains(stem.as_str()))
        .map(|(p, _, h)| (p.clone(), *h))
}

fn pick_main_texture(
    candidates: &[(String, String, u64)],
    skn_basename: Option<&str>,
) -> Option<u64> {
    if let Some(base) = skn_basename {
        let base = base.to_lowercase();
        if let Some((_, _, h)) = candidates.iter().find(|(_, s, _)| s == &base) {
            return Some(*h);
        }
    }
    let priority = ["_tx_cm", "tx_cm", "diffuse", "main_texture", "main"];
    for needle in &priority {
        if let Some((_, _, h)) = candidates.iter().find(|(_, s, _)| s.contains(needle)) {
            return Some(*h);
        }
    }
    // Stable fallback so the same WAD always picks the same default.
    candidates
        .iter()
        .min_by(|a, b| a.1.cmp(&b.1))
        .map(|(_, _, h)| *h)
}

/// Generate plausible canonical paths for a BIN-referenced texture.
/// BIN paths come in a few flavors:
///   - `ASSETS/Characters/...` (mod-tree convention, capitalized)
///   - `assets/characters/...` (lowercase canonical)
///   - `Characters/...` (rare, leading `assets/` stripped)
/// We try the lowercase form first (matches how Quartz/our LMDB tables
/// are keyed), then a `data/...` variant for paths that erroneously
/// pointed at the asset side of a mirrored layout.
fn path_candidates(path: &str) -> Vec<String> {
    let lower = path.to_lowercase();
    let mut out = vec![lower.clone()];
    // `assets/...` paths in BINs sometimes correspond to chunks
    // stored under their `data/...` mirror. Cheap to try.
    if let Some(rest) = lower.strip_prefix("assets/") {
        out.push(format!("data/{rest}"));
    }
    out
}

fn xxh64_lower(s: &str) -> u64 {
    let mut h = XxHash64::with_seed(0);
    h.write(s.as_bytes());
    h.finish()
}

// ─────────────────────────────────────────────────────────────────────
// Native texture decode — binary IPC
//
// Earlier iterations went through:
//   - JS-side TEX/DDS decoder + canvas → PNG → data URL → Image
//   - Then a batched Rust decoder returning base64-encoded RGBA in a
//     JSON response
//
// The base64 + JSON round-trip became the bottleneck (each 2K texture
// = ~22 MB of base64 string; serialize, transport, JSON.parse, atob
// each cost 100-300 ms). Binary IPC bypasses all of that — bytes go
// from a `Vec<u8>` straight into a JS `ArrayBuffer`, no encoding.
//
// Wire format (single texture per call):
//   bytes 0..4   : width  (u32 LE)
//   bytes 4..8   : height (u32 LE)
//   bytes 8..12  : flags  (u32 LE)  — bit 0 = has_alpha; rest reserved
//   bytes 12..16 : reserved (zero)
//   bytes 16..   : `width * height * 4` RGBA8 bytes
//
// Frontend reads the header off the ArrayBuffer with a DataView, then
// feeds the rest as a Uint8Array view to RawTexture.CreateRGBATexture.
// ─────────────────────────────────────────────────────────────────────

const TEX_HEADER_LEN: usize = 16;
const FLAG_HAS_ALPHA: u32 = 1 << 0;

/// Read + decompress + decode one texture chunk and return the RGBA
/// bytes (with a 16-byte metadata header) as a binary IPC response.
#[tauri::command]
pub async fn wad_decode_texture(
    id: u64,
    path_hash_hex: String,
) -> Result<tauri::ipc::Response, String> {
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
    .ok_or_else(|| format!("chunk {} not in mount {}", path_hash_hex, id))?;
    let (wad_path, chunk) = info;

    // Run read+decode on the blocking pool — texpresso block decode
    // is CPU-bound and we don't want to sit on the Tauri async runtime.
    let blob = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let bytes = read_chunk_decompressed_bytes(&wad_path, &chunk)
            .map_err(|e| format!("read chunk: {e}"))?;
        let decoded = decode_auto(&bytes).map_err(|e| format!("decode: {e}"))?;

        // Build the [16-byte header | RGBA] payload. Pre-allocate so
        // we don't realloc once the RGBA chunk lands.
        let mut out = Vec::with_capacity(TEX_HEADER_LEN + decoded.rgba.len());
        out.extend_from_slice(&decoded.width.to_le_bytes());
        out.extend_from_slice(&decoded.height.to_le_bytes());
        let flags = if decoded.has_alpha { FLAG_HAS_ALPHA } else { 0 };
        out.extend_from_slice(&flags.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes()); // reserved
        debug_assert_eq!(out.len(), TEX_HEADER_LEN);
        out.extend_from_slice(&decoded.rgba);
        Ok(out)
    })
    .await
    .map_err(|e| format!("decode task join failed: {e}"))??;

    Ok(tauri::ipc::Response::new(blob))
}

/// Disk-source counterpart of [`wad_decode_texture`]. Reads the
/// texture (.tex / .dds) straight from `path` and returns the same
/// `[16-byte header | RGBA]` payload, so the frontend's RGBA upload
/// path stays a single code path regardless of source.
#[tauri::command]
pub async fn decode_texture_disk(
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let pb = PathBuf::from(&path);
    let blob = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let bytes = std::fs::read(&pb).map_err(|e| format!("read texture '{}': {}", pb.display(), e))?;
        let decoded = decode_auto(&bytes).map_err(|e| format!("decode: {e}"))?;
        let mut out = Vec::with_capacity(TEX_HEADER_LEN + decoded.rgba.len());
        out.extend_from_slice(&decoded.width.to_le_bytes());
        out.extend_from_slice(&decoded.height.to_le_bytes());
        let flags = if decoded.has_alpha { FLAG_HAS_ALPHA } else { 0 };
        out.extend_from_slice(&flags.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes()); // reserved
        debug_assert_eq!(out.len(), TEX_HEADER_LEN);
        out.extend_from_slice(&decoded.rgba);
        Ok(out)
    })
    .await
    .map_err(|e| format!("decode task join failed: {e}"))??;

    Ok(tauri::ipc::Response::new(blob))
}
