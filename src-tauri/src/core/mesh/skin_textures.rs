//! Extract per-submesh diffuse-texture paths from a parsed skin BIN.
//!
//! Originally went through ritobin TEXT (BIN → text → regex), which
//! made the BIN-parse step the dominant cost on champion previews
//! (~2.6 s out of ~3.3 s end-to-end on Samira skin30). Now we walk
//! the parsed `BinTree` directly with FNV1a-32 hash field lookups —
//! same algorithm Aventurine's C++ DLL uses, but in pure Rust without
//! the FFI baggage. The text-based regex pipeline + its dictionary
//! bookkeeping is gone entirely.
//!
//! BIN structure (cross-checked with Aventurine `bin_parser.cpp`):
//!
//! ```text
//! "champion_skin0" SkinCharacterDataProperties {
//!     skinMeshProperties: embed = SkinMeshDataProperties {
//!         texture: string                                    // BASE
//!         materialOverride: list[embed] = {
//!             SkinMeshDataProperties_MaterialOverride {
//!                 submesh: string                            // material name
//!                 texture: string                            // direct override
//!                 // OR
//!                 material: link = ObjectLink → StaticMaterialDef
//!             }
//!         }
//!     }
//! }
//!
//! "Characters/Aatrox/Skin0_Body" StaticMaterialDef {
//!     samplerValues: list[embed] = {
//!         StaticMaterialShaderSamplerDef {
//!             textureName: string = "Diffuse_Texture"
//!             texturePath: string = "ASSETS/.../body_diffuse.tex"
//!         }
//!     }
//! }
//! ```

use indexmap::IndexMap;
use ltk_meta::{BinProperty, BinTree, BinTreeObject, PropertyValueEnum};
use serde::Serialize;

use crate::core::bin::read_bin_ltk;
use crate::core::wad::{read_chunk_decompressed_bytes, with_mount};

use super::skin_bin::find_skin_bin;

// ── FNV1a-32 hash constants ────────────────────────────────────────
//
// Computed at compile-time from the lowercased field name. Identical
// to what Aventurine's C++ DLL hardcodes — kept as `const fn` so a
// reader can verify any of them by changing the string and recompiling
// without having to rerun a hash tool.

const fn fnv1a_lower(s: &str) -> u32 {
    let bytes = s.as_bytes();
    let mut hash: u32 = 0x811c_9dc5;
    let mut i = 0;
    while i < bytes.len() {
        let mut b = bytes[i];
        if b >= b'A' && b <= b'Z' {
            b += 32; // ASCII lowercase
        }
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x0100_0193);
        i += 1;
    }
    hash
}

const H_SKIN_MESH_PROPERTIES: u32 = fnv1a_lower("skinMeshProperties");
const H_TEXTURE: u32 = fnv1a_lower("texture");
const H_MATERIAL_OVERRIDE: u32 = fnv1a_lower("materialOverride");
const H_SUBMESH: u32 = fnv1a_lower("submesh");
const H_MATERIAL: u32 = fnv1a_lower("material");
const H_SAMPLER_VALUES: u32 = fnv1a_lower("samplerValues");
const H_TEXTURE_NAME: u32 = fnv1a_lower("textureName");
const H_TEXTURE_PATH: u32 = fnv1a_lower("texturePath");

// ── Public types (unchanged shape — frontend consumers stay valid) ─

#[derive(Debug, Clone, Serialize)]
pub struct MaterialTexture {
    pub material: String,
    pub texture_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkinTextureMap {
    pub bin_path: String,
    pub bin_path_hash_hex: String,
    pub default_texture: Option<String>,
    pub materials: Vec<MaterialTexture>,
}

// ── End-to-end command path ─────────────────────────────────────────

/// Disk-source variant — given an SKN file path, find its sibling
/// skin BIN, parse it, and return the same texture map shape the WAD
/// path produces. Returns `Ok(None)` for any structural miss (no
/// skin BIN found, parse error). The texture paths in the result
/// are still BIN-string format (`ASSETS/...`); a separate per-clip
/// resolver maps them to disk paths.
pub fn read_skin_textures_for_skn_disk(
    skn_disk_path: &str,
) -> Result<Option<SkinTextureMap>, String> {
    use super::skin_bin::find_skin_bin_disk;

    let skin_bin_path = match find_skin_bin_disk(skn_disk_path) {
        Some(p) => p,
        None => return Ok(None),
    };
    let bytes = std::fs::read(&skin_bin_path)
        .map_err(|e| format!("read skin bin '{}': {}", skin_bin_path, e))?;
    let tree = read_bin_ltk(&bytes).map_err(|e| format!("parse skin bin: {e}"))?;
    let (default_texture, materials) = extract_textures_from_tree(&tree);

    Ok(Some(SkinTextureMap {
        bin_path: skin_bin_path.replace('\\', "/").to_lowercase(),
        // Disk source has no xxh64 chunk hash — fill with zeros so
        // the field stays serializable and frontend code that
        // doesn't care about it (the disk path is what's used)
        // doesn't have to special-case Optional vs Required.
        bin_path_hash_hex: format!("{:016x}", 0u64),
        default_texture,
        materials,
    }))
}

pub fn read_skin_textures_for_skn(
    mount_id: u64,
    skn_path_hash: u64,
) -> Result<Option<SkinTextureMap>, String> {
    let bin_match = match find_skin_bin(mount_id, skn_path_hash) {
        Some(m) => m,
        None => return Ok(None),
    };
    let bin_hash = u64::from_str_radix(&bin_match.path_hash_hex, 16)
        .map_err(|e| format!("bad bin hash hex: {e}"))?;

    let info = with_mount(mount_id, |m| {
        m.chunks
            .iter()
            .find(|c| c.path_hash == bin_hash)
            .map(|c| (m.path.clone(), *c))
    })
    .flatten()
    .ok_or_else(|| format!("bin chunk {} not in mount {}", bin_match.path_hash_hex, mount_id))?;
    let bytes = read_chunk_decompressed_bytes(&info.0, &info.1)
        .map_err(|e| format!("read bin chunk: {e}"))?;

    // Parse the binary directly — no text round-trip.
    let tree = read_bin_ltk(&bytes).map_err(|e| format!("parse bin tree: {e}"))?;
    let (default_texture, materials) = extract_textures_from_tree(&tree);

    Ok(Some(SkinTextureMap {
        bin_path: bin_match.path,
        bin_path_hash_hex: bin_match.path_hash_hex,
        default_texture,
        materials,
    }))
}

// ── Tree walker ─────────────────────────────────────────────────────

/// Walk the parsed BinTree and pull out (default_texture, per-material).
/// Public so tests can hit it without IPC plumbing.
pub fn extract_textures_from_tree(tree: &BinTree) -> (Option<String>, Vec<MaterialTexture>) {
    let mut default_texture: Option<String> = None;
    let mut materials: Vec<MaterialTexture> = Vec::new();

    for object in tree.objects.values() {
        // Only objects with a `skinMeshProperties` field are interesting.
        let smp_value = match object.properties.get(&H_SKIN_MESH_PROPERTIES) {
            Some(p) => &p.value,
            None => continue,
        };
        let smp_props = match embedded_props(smp_value) {
            Some(s) => s,
            None => continue,
        };

        if default_texture.is_none() {
            if let Some(s) = string_field(smp_props, H_TEXTURE) {
                if !s.is_empty() {
                    default_texture = Some(s.to_lowercase());
                }
            }
        }

        // Per-submesh overrides — `materialOverride` is a `list[embed]`
        // (Container whose items are EmbeddedValue → StructValue).
        let overrides = match smp_props.get(&H_MATERIAL_OVERRIDE) {
            Some(p) => &p.value,
            None => continue,
        };
        let Some(list) = container_items(overrides) else {
            continue;
        };

        for item in list {
            let Some(item_props) = embedded_props(item) else { continue };
            let Some(submesh) = string_field(item_props, H_SUBMESH) else { continue };
            let material_name = submesh.to_string();

            // Direct texture override wins.
            if let Some(t) = string_field(item_props, H_TEXTURE) {
                if !t.is_empty() {
                    materials.push(MaterialTexture {
                        material: material_name,
                        texture_path: t.to_lowercase(),
                    });
                    continue;
                }
            }

            // Otherwise resolve `material: link = <object_hash>` against
            // a StaticMaterialDef elsewhere in the tree.
            if let Some(link_hash) = object_link_field(item_props, H_MATERIAL) {
                if let Some(t) = resolve_material_diffuse(tree, link_hash) {
                    materials.push(MaterialTexture {
                        material: material_name,
                        texture_path: t.to_lowercase(),
                    });
                }
            }
        }
    }

    (default_texture, materials)
}

/// Look up a StaticMaterialDef object by its FNV1a path hash and pull a
/// diffuse texture path out of its `samplerValues` list. Priority
/// matches what the regex version did:
///   1. `Main_Texture` sampler with a `/skin{N}/` path (project-specific)
///   2. `Diffuse_Texture` sampler with a `/skin{N}/` path
///   3. Any sampler with a `/skin{N}/` path
///   4. First `Main_Texture` sampler regardless of path
///   5. First `Diffuse_Texture` sampler regardless of path
fn resolve_material_diffuse(tree: &BinTree, mat_path_hash: u32) -> Option<String> {
    let mat_obj: &BinTreeObject = tree.objects.get(&mat_path_hash)?;
    let samplers = container_items(&mat_obj.properties.get(&H_SAMPLER_VALUES)?.value)?;

    // Collect each sampler's (textureName, texturePath) once so we can
    // run the priority cascade without redundant tree walks.
    let mut samples: Vec<(String, String)> = Vec::with_capacity(samplers.len());
    for item in samplers {
        let Some(item_props) = embedded_props(item) else { continue };
        let name = string_field(item_props, H_TEXTURE_NAME).unwrap_or("");
        let path = string_field(item_props, H_TEXTURE_PATH).unwrap_or("");
        if path.is_empty() {
            continue;
        }
        samples.push((name.to_lowercase(), path.to_string()));
    }

    let is_project_specific = |p: &str| {
        let lower = p.to_lowercase();
        // Same `/skin{digit+}/` heuristic the text parser used.
        let bytes = lower.as_bytes();
        let mut i = 0;
        while i + 5 < bytes.len() {
            if &bytes[i..i + 5] == b"/skin" {
                let mut j = i + 5;
                let mut saw_digit = false;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    saw_digit = true;
                    j += 1;
                }
                if saw_digit && j < bytes.len() && bytes[j] == b'/' {
                    return true;
                }
            }
            i += 1;
        }
        false
    };

    // Priorities 1–3 require a project-specific path.
    for (name, path) in &samples {
        if name.contains("main_texture") && is_project_specific(path) {
            return Some(path.clone());
        }
    }
    for (name, path) in &samples {
        if name.contains("diffuse") && is_project_specific(path) {
            return Some(path.clone());
        }
    }
    for (_name, path) in &samples {
        if is_project_specific(path) {
            return Some(path.clone());
        }
    }
    // 4 + 5: fallbacks without the project-specific filter.
    for (name, path) in &samples {
        if name.contains("main_texture") {
            return Some(path.clone());
        }
    }
    for (name, path) in &samples {
        if name.contains("diffuse") {
            return Some(path.clone());
        }
    }
    None
}

// ── Static-mesh (SCB / SCO) texture lookup ─────────────────────────
//
// Static meshes aren't wired through `skinMeshProperties` — they're
// referenced from VFX emitters, item materials, weapon mounts, etc.,
// usually as a string path on a nested struct like
// `VfxPrimitiveMesh.mMesh.mSimpleMeshName`. The texture(s) for that
// mesh live as *sibling* string properties in the same top-level
// BinTreeObject — same `VfxEmitterDefinitionData`, just different
// nested struct.
//
// We can't follow the same FNV1a-hash-keyed approach as the SKN
// walker because the field names involved are inconsistent across
// the BIN ecosystem (mSimpleMeshName, mainTexture, baseColor,
// erosionMapName, …). Instead we do a dumb-but-effective generic
// pass:
//
//   1. Walk every top-level object's value tree once.
//   2. Find any object whose subtree contains the SCB/SCO path as a
//      string value (case-insensitive).
//   3. Collect every `.tex` / `.dds` string in that same object's
//      subtree.
//   4. Score the collected paths and pick the most likely "main"
//      diffuse — skipping obvious non-diffuse maps (alpha erosion,
//      noise, normal, mask).
//
// Returns one path string for the frontend to resolve into a chunk
// hash.

pub fn find_static_mesh_texture(tree: &BinTree, mesh_path: &str) -> Option<String> {
    let needle = mesh_path.to_lowercase();
    let mut all_textures: Vec<String> = Vec::new();
    for obj in tree.objects.values() {
        let mut found_mesh_ref = false;
        let mut texture_paths: Vec<String> = Vec::new();
        visit_strings_in_props(&obj.properties, &mut |s| {
            let lower = s.to_lowercase();
            if !found_mesh_ref && lower == needle {
                found_mesh_ref = true;
            }
            if lower.ends_with(".tex") || lower.ends_with(".dds") {
                texture_paths.push(s.to_string());
            }
        });
        if found_mesh_ref {
            for p in texture_paths {
                if !all_textures.contains(&p) {
                    all_textures.push(p);
                }
            }
        }
    }
    pick_main_static_texture(&all_textures)
}

/// Score-and-pick the most likely diffuse from a flat list of
/// candidate texture paths. Skips obvious effect maps; falls back to
/// the first candidate when nothing scores high enough.
fn pick_main_static_texture(paths: &[String]) -> Option<String> {
    // Likely-not-diffuse keywords. Substring match on lowercased
    // path. These cover Riot's common naming conventions for non-
    // colour textures so we don't apply an alpha mask as the main
    // diffuse on a mesh.
    const EFFECT_HINTS: &[&str] = &[
        "erosion", "_n.", "_dn.", "normal", "noise", "_mask", "alphaerosion",
    ];
    // Positive hints — preferred when present.
    const MAIN_HINTS: &[&str] = &["_tx_cm", "tx_cm", "diffuse", "main_texture", "_color", "base"];

    // First pass: project-specific (`/skin{N}/`) + main hint match.
    for p in paths {
        let lower = p.to_lowercase();
        if EFFECT_HINTS.iter().any(|kw| lower.contains(kw)) {
            continue;
        }
        if MAIN_HINTS.iter().any(|kw| lower.contains(kw)) {
            return Some(p.clone());
        }
    }
    // Second pass: any non-effect texture.
    for p in paths {
        let lower = p.to_lowercase();
        if !EFFECT_HINTS.iter().any(|kw| lower.contains(kw)) {
            return Some(p.clone());
        }
    }
    // Last resort: first path of any kind.
    paths.first().cloned()
}

fn visit_strings_in_props<F: FnMut(&str)>(
    props: &IndexMap<u32, BinProperty>,
    f: &mut F,
) {
    for prop in props.values() {
        visit_strings_in_value(&prop.value, f);
    }
}

fn visit_strings_in_value<F: FnMut(&str)>(v: &PropertyValueEnum, f: &mut F) {
    match v {
        PropertyValueEnum::String(s) => f(&s.0),
        PropertyValueEnum::Embedded(e) => visit_strings_in_props(&e.0.properties, f),
        PropertyValueEnum::Struct(s) => visit_strings_in_props(&s.properties, f),
        PropertyValueEnum::Container(c) => {
            for item in &c.items {
                visit_strings_in_value(item, f);
            }
        }
        PropertyValueEnum::UnorderedContainer(uc) => {
            for item in &uc.0.items {
                visit_strings_in_value(item, f);
            }
        }
        // Other variants either don't carry strings (numerics,
        // hashes, booleans) or are exotic enough that BIN texture
        // references basically never live in them. If we miss
        // something, the field-name search will still cover it on
        // the next call.
        _ => {}
    }
}

// ── Property unwrappers ────────────────────────────────────────────
//
// These take the IndexMap directly rather than the StructValue type
// itself — the pinned ltk_meta keeps its `property` module private,
// so the inner value types (StructValue, ContainerValue, etc.)
// aren't reachable by name from outside the crate. Field access on
// the matched binding (`e.0.properties`, `c.items`, `link.0`) doesn't
// need the type to be importable, so we work with the structural
// pieces and stay portable across ltk_meta versions.

fn embedded_props(v: &PropertyValueEnum) -> Option<&IndexMap<u32, BinProperty>> {
    match v {
        PropertyValueEnum::Embedded(e) => Some(&e.0.properties),
        PropertyValueEnum::Struct(s) => Some(&s.properties),
        _ => None,
    }
}

fn container_items(v: &PropertyValueEnum) -> Option<&Vec<PropertyValueEnum>> {
    match v {
        PropertyValueEnum::Container(c) => Some(&c.items),
        PropertyValueEnum::UnorderedContainer(uc) => Some(&uc.0.items),
        _ => None,
    }
}

fn string_field(props: &IndexMap<u32, BinProperty>, name_hash: u32) -> Option<&str> {
    match &props.get(&name_hash)?.value {
        PropertyValueEnum::String(sv) => Some(&sv.0),
        _ => None,
    }
}

fn object_link_field(props: &IndexMap<u32, BinProperty>, name_hash: u32) -> Option<u32> {
    match &props.get(&name_hash)?.value {
        PropertyValueEnum::ObjectLink(link) => Some(link.0),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sanity-check the precomputed FNV1a-32 hashes against Aventurine's
    /// hardcoded values. If `fnv1a_lower` ever drifts (e.g. a
    /// case-handling tweak), this catches it before the parser starts
    /// silently missing fields.
    #[test]
    fn hash_constants_match_aventurine() {
        assert_eq!(H_SKIN_MESH_PROPERTIES, 0x45ff_5904);
        assert_eq!(H_TEXTURE, 0x3c64_68f4);
        assert_eq!(H_MATERIAL_OVERRIDE, 0x2472_5910);
        assert_eq!(H_SUBMESH, 0xaad7_612c);
        assert_eq!(H_MATERIAL, 0xd2e4_d060);
        assert_eq!(H_SAMPLER_VALUES, 0x0a6f_0eb5);
        assert_eq!(H_TEXTURE_NAME, 0xb311_d4ef);
        assert_eq!(H_TEXTURE_PATH, 0xf0a3_63e3);
    }
}
