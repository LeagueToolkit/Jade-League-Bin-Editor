//! 3D mesh + skeleton + animation support for League of Legends formats.
//!
//! - SKN: skinned mesh (vertices, indices, submeshes, bone weights/indices)
//! - SKL: skeleton (bones with bind-pose transforms + inverse-bind matrices)
//! - ANM: skeletal animation (per-bone TRS curves, evaluated at a given time)
//! - SCB / SCO: static mesh (single buffer, no skinning)
//!
//! Parsers live here in `core/mesh/`; the Tauri commands that surface this
//! data to the frontend live in `mesh_commands.rs` one layer up. This split
//! mirrors how `core/wad/` + `wad_commands.rs` are organised.
//!
//! Format references (cross-checked):
//! - Aventurine (Blender plugin) `io/import_*.py` — most authoritative spec
//! - Flint `crates/flint-ltk/src/mesh/*.rs` — Rust-shaped reference
//! - Quartz `league-toolkit-quartz/crates/ltk_*` — additional cross-check

pub mod error;
pub mod scb;
pub mod sco;
pub mod skin_bin;
pub mod skin_textures;
pub mod skn;
pub mod texture_decode;

// `MeshError` and `SknSubmesh` are re-exported for symmetry with how
// `core/wad/mod.rs` surfaces its types. Suppress the unused-import warning
// until SKL/ANM start using them next phase.
#[allow(unused_imports)]
pub use error::MeshError;
#[allow(unused_imports)]
pub use skin_bin::{find_skin_bin, SkinBinMatch};
#[allow(unused_imports)]
pub use skin_textures::{read_skin_textures_for_skn, SkinTextureMap};
#[allow(unused_imports)]
pub use skn::{parse_skn, SknMesh, SknSubmesh};
#[allow(unused_imports)]
pub use scb::{parse_scb, StaticMesh};
#[allow(unused_imports)]
pub use sco::parse_sco;
