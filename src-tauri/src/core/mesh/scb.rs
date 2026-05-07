//! SCB (Static Character Binary) parser — League's static-mesh
//! container for items, weapons, props, and other non-skinned geometry.
//!
//! Layout (cross-checked with Aventurine `import_scb.py`):
//!
//! ```text
//! char[8]    magic = "r3d2Mesh"
//! u16        major
//! u16        minor              // 2.1, 2.2, 3.2 in the wild
//! char[128]  name (skipped)
//! u32        vertex_count
//! u32        face_count
//! u32        flag (skipped)
//! f32[6]     bbox_min[3] + bbox_max[3]
//! [if major == 3 && minor == 2:]
//!   u32      vertex_type
//! f32[3]   * vertex_count        // shared vertex positions
//! [if vertex_type == 1:]
//!   u32    * vertex_count        // vertex colors (skipped)
//! f32[3]                         // central point (skipped)
//! face_count * {
//!   u32[3]    indices into vertex array
//!   char[64]  material name (per-face — first non-empty wins)
//!   f32[6]    UVs:  u0 u1 u2 v0 v1 v2  (note: split layout!)
//! }
//! ```
//!
//! Key shape difference vs SKN: UVs are stored *per face* (each vertex
//! of each face has its own UV), so a single shared vertex can map to
//! different UVs on different triangles. We handle this by emitting
//! un-indexed geometry — every triangle becomes 3 unique output
//! vertices with their own UV pair, and the index buffer is
//! sequential (0,1,2,3,…). Babylon doesn't care; it ends up rendering
//! the same number of pixels either way.

use std::io::{Cursor, Read};

use byteorder::{LittleEndian, ReadBytesExt};
use serde::Serialize;

use super::error::{MeshError, Result};

const MAGIC: &[u8; 8] = b"r3d2Mesh";

/// Parsed static mesh ready for IPC. Same flat-typed-array layout the
/// SKN path uses, with a single implicit "submesh" so the frontend
/// material/texture pipeline can treat it uniformly.
#[derive(Debug, Clone, Serialize)]
pub struct StaticMesh {
    pub major: u16,
    pub minor: u16,
    /// Material name from the SCB's per-face strings. Used by the
    /// texture-guess pipeline as the "submesh name" to match against
    /// sibling .tex / .dds files.
    pub material: String,
    /// Triangle indices into the per-vertex buffers. Sequential
    /// (`0..n`) since UVs are per-face.
    pub indices: Vec<u32>,
    /// Flat `[x0, y0, z0, x1, y1, z1, ...]`. One unique vertex per
    /// face corner, so `len() == face_count * 3 * 3`.
    pub positions: Vec<f32>,
    /// Flat `[u0, v0, u1, v1, ...]`. Same indexing as `positions`.
    pub uvs: Vec<f32>,
    /// AABB read from the file (we don't recompute since SCB header's
    /// bbox is reliable, unlike SKN v4's sometimes-stale one).
    pub bbox: [[f32; 3]; 2],
}

pub fn parse_scb(bytes: &[u8]) -> Result<StaticMesh> {
    let mut r = Cursor::new(bytes);

    let mut magic = [0u8; 8];
    r.read_exact(&mut magic)?;
    if &magic != MAGIC {
        // Pack first 4 bytes as the "got" magic; the real magic is 8
        // bytes but our error type is u32-wide. Good enough for a
        // user-facing diagnostic.
        let got = u32::from_le_bytes([magic[0], magic[1], magic[2], magic[3]]);
        return Err(MeshError::InvalidSignature {
            format: "SCB",
            expected: u32::from_le_bytes([MAGIC[0], MAGIC[1], MAGIC[2], MAGIC[3]]),
            got,
        });
    }

    let major = r.read_u16::<LittleEndian>()?;
    let minor = r.read_u16::<LittleEndian>()?;
    if !matches!(major, 2 | 3) {
        return Err(MeshError::UnsupportedVersion { format: "SCB", major, minor });
    }

    // 128-byte name field — Riot writes the mesh's name in here but
    // we don't need it (the file the user opened tells us all we need
    // for labelling).
    let mut _name = [0u8; 128];
    r.read_exact(&mut _name)?;

    let vertex_count = r.read_u32::<LittleEndian>()? as usize;
    let face_count = r.read_u32::<LittleEndian>()? as usize;
    let _flag = r.read_u32::<LittleEndian>()?;

    let mut bbox = [[0f32; 3]; 2];
    for axis in 0..3 {
        bbox[0][axis] = r.read_f32::<LittleEndian>()?;
    }
    for axis in 0..3 {
        bbox[1][axis] = r.read_f32::<LittleEndian>()?;
    }

    // Vertex type only present in 3.2. 0 = positions only, 1 = +color.
    let vertex_type = if major == 3 && minor == 2 {
        r.read_u32::<LittleEndian>()?
    } else {
        0
    };
    if vertex_type > 1 {
        return Err(MeshError::InvalidField {
            format: "SCB",
            field: "vertex_type",
            value: format!("{} (only 0 and 1 are known)", vertex_type),
        });
    }

    // Shared vertex positions table — faces reference into this by
    // index. We re-emit them per-face below to support per-face UVs.
    let mut shared_pos: Vec<[f32; 3]> = Vec::with_capacity(vertex_count);
    for _ in 0..vertex_count {
        let x = r.read_f32::<LittleEndian>()?;
        let y = r.read_f32::<LittleEndian>()?;
        let z = r.read_f32::<LittleEndian>()?;
        shared_pos.push([x, y, z]);
    }

    if vertex_type == 1 {
        // Skip per-vertex color (RGBA u8). We don't render vertex
        // colors yet and the textures provide all the colour we need.
        let mut _colors = vec![0u8; vertex_count * 4];
        r.read_exact(&mut _colors)?;
    }

    // Central point — used by Riot's tooling but irrelevant to us.
    let mut _central = [0u8; 12];
    r.read_exact(&mut _central)?;

    // Allocate output buffers. Each face contributes 3 vertices; we
    // reserve up-front to avoid intermediate reallocs on big meshes.
    let mut positions: Vec<f32> = Vec::with_capacity(face_count * 9);
    let mut uvs: Vec<f32> = Vec::with_capacity(face_count * 6);
    let mut indices: Vec<u32> = Vec::with_capacity(face_count * 3);
    let mut material: Option<String> = None;
    let mut next_index: u32 = 0;

    for _ in 0..face_count {
        let i0 = r.read_u32::<LittleEndian>()? as usize;
        let i1 = r.read_u32::<LittleEndian>()? as usize;
        let i2 = r.read_u32::<LittleEndian>()? as usize;

        // Per-face material name — first non-empty wins. SCB files
        // are virtually always single-material in practice, so this
        // matches Aventurine's behaviour.
        let mut name_bytes = [0u8; 64];
        r.read_exact(&mut name_bytes)?;
        if material.is_none() {
            let nul = name_bytes.iter().position(|&b| b == 0).unwrap_or(64);
            let name = String::from_utf8_lossy(&name_bytes[..nul]).into_owned();
            if !name.is_empty() {
                material = Some(name);
            }
        }

        // 6 UV floats — note the split layout: u0 u1 u2 v0 v1 v2.
        // Aventurine reads them and pairs them up the same way.
        let u0 = r.read_f32::<LittleEndian>()?;
        let u1 = r.read_f32::<LittleEndian>()?;
        let u2 = r.read_f32::<LittleEndian>()?;
        let v0 = r.read_f32::<LittleEndian>()?;
        let v1 = r.read_f32::<LittleEndian>()?;
        let v2 = r.read_f32::<LittleEndian>()?;

        // Skip degenerates after we've read the rest — we still have
        // to consume the 64+24 bytes of material+UV regardless.
        if i0 == i1 || i1 == i2 || i0 == i2 {
            continue;
        }

        // Write 3 fresh output vertices for this face. Position taken
        // from the shared table; UV is the per-face value.
        for (vi, ui, vi2) in [(i0, u0, v0), (i1, u1, v1), (i2, u2, v2)] {
            let p = shared_pos.get(vi).copied().unwrap_or([0.0; 3]);
            positions.extend_from_slice(&p);
            uvs.push(ui);
            uvs.push(vi2);
            indices.push(next_index);
            next_index += 1;
        }
    }

    Ok(StaticMesh {
        major,
        minor,
        material: material.unwrap_or_else(|| "default".to_string()),
        indices,
        positions,
        uvs,
        bbox,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_magic() {
        let buf = vec![0u8; 256];
        assert!(matches!(parse_scb(&buf), Err(MeshError::InvalidSignature { .. })));
    }

    /// Build a minimal valid SCB 2.1 with one triangle. Exercises the
    /// no-color, no-vertex_type path that 2.x SCBs use.
    #[test]
    fn parses_v2_single_triangle() {
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(MAGIC);
        buf.extend(&2u16.to_le_bytes());
        buf.extend(&1u16.to_le_bytes());
        buf.extend(&[0u8; 128]); // name
        buf.extend(&3u32.to_le_bytes()); // vertex_count
        buf.extend(&1u32.to_le_bytes()); // face_count
        buf.extend(&0u32.to_le_bytes()); // flag
        for f in &[0f32, 0.0, 0.0, 1.0, 1.0, 1.0] {
            buf.extend(&f.to_le_bytes()); // bbox
        }
        // 3 vertices
        for v in &[[0f32, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]] {
            for c in v {
                buf.extend(&c.to_le_bytes());
            }
        }
        // central point
        buf.extend(&0f32.to_le_bytes());
        buf.extend(&0f32.to_le_bytes());
        buf.extend(&0f32.to_le_bytes());
        // single face: indices 0,1,2; material "test"; uvs
        buf.extend(&0u32.to_le_bytes());
        buf.extend(&1u32.to_le_bytes());
        buf.extend(&2u32.to_le_bytes());
        let mut name = [0u8; 64];
        name[0..4].copy_from_slice(b"test");
        buf.extend_from_slice(&name);
        for f in &[0f32, 1.0, 0.0, 0.0, 0.0, 1.0] {
            buf.extend(&f.to_le_bytes());
        }

        let mesh = parse_scb(&buf).expect("parse");
        assert_eq!(mesh.major, 2);
        assert_eq!(mesh.material, "test");
        assert_eq!(mesh.indices, vec![0, 1, 2]);
        assert_eq!(mesh.positions.len(), 9);
        assert_eq!(mesh.uvs.len(), 6);
    }
}
