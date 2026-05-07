//! SKN (Simple Skin) parser — League's skinned-mesh container.
//!
//! Layout (cross-checked against Aventurine `import_skn.py`, Flint, and
//! Quartz `ltk_mesh::skinned::read`):
//!
//! ```text
//! u32   magic          0x00112233
//! u16   major          0 | 2 | 4
//! u16   minor          (1 in practice)
//!
//! if major == 0:
//!     u32 index_count
//!     u32 vertex_count
//!     // single implicit submesh "Base"
//! else:
//!     u32 submesh_count
//!     submesh_count * {
//!         char[64] name      // ascii, null-padded
//!         u32 vertex_start
//!         u32 vertex_count
//!         u32 index_start
//!         u32 index_count
//!     }
//!     if major >= 4:
//!         u32 _flags
//!     u32 index_count
//!     u32 vertex_count
//!     if major >= 4:
//!         u32 vertex_size  // 52 / 56 / 72
//!         u32 vertex_type  // 0 = Basic, 1 = Color, 2 = Tangent
//!         AABB(24) + Sphere(16)   // 40 bytes total
//!
//! u16 indices[index_count]
//!
//! for vertex in 0..vertex_count:
//!     vec3   position           // 12
//!     u8[4]  influences          //  4 — bone indices into SKL `influences`
//!     f32[4] weights             // 16
//!     vec3   normal              // 12 — currently discarded (we recompute)
//!     vec2   uv                  //  8
//!     if vertex_type >= 1:
//!         u8[4] color            //  4
//!     if vertex_type == 2:
//!         vec4 tangent           // 16
//! ```
//!
//! We intentionally *re-pack* the data for the GPU: positions/uvs/weights/
//! influences are hot in skinning shaders, but normals are recomputed from
//! face geometry by the renderer (Babylon does this with `createNormals`),
//! so we drop them here. If we ever need shading-quality normals back we
//! can flip a flag.

use std::io::{Cursor, Read};

use byteorder::{LittleEndian, ReadBytesExt};
use serde::Serialize;

use super::error::{MeshError, Result};

const MAGIC: u32 = 0x0011_2233;

/// One submesh range — corresponds to a single material in the .bin.
/// Indices in `[start_index, start_index + index_count)` belong to this
/// material; vertices in `[start_vertex, start_vertex + vertex_count)`
/// are the unique vertices it touches.
#[derive(Debug, Clone, Serialize)]
pub struct SknSubmesh {
    pub name: String,
    pub start_vertex: u32,
    pub vertex_count: u32,
    pub start_index: u32,
    pub index_count: u32,
}

/// Parsed SKN ready for IPC. Vertex data is flat & GPU-friendly so the
/// frontend can hand it straight to Babylon's `VertexData` without any
/// rebuilding.
#[derive(Debug, Clone, Serialize)]
pub struct SknMesh {
    pub major: u16,
    pub minor: u16,
    /// Material/submesh ranges.
    pub submeshes: Vec<SknSubmesh>,
    /// Triangle indices into the vertex buffer.
    pub indices: Vec<u16>,
    /// Vertex positions, flat `[x0, y0, z0, x1, y1, z1, ...]`.
    pub positions: Vec<f32>,
    /// Texture coordinates, flat `[u0, v0, u1, v1, ...]`.
    pub uvs: Vec<f32>,
    /// 4 bone influences per vertex, flat `[i0..i3, i0..i3, ...]`.
    /// Empty when the SKN has no skinning data (rare in practice — every
    /// modern champion mesh has them).
    pub bone_indices: Vec<u8>,
    /// 4 bone weights per vertex matching `bone_indices`.
    pub bone_weights: Vec<f32>,
    /// Axis-aligned bounding box `[min_xyz, max_xyz]` in League space.
    /// Computed from vertex positions when the file doesn't carry one
    /// (i.e. major < 4).
    pub bbox: [[f32; 3]; 2],
}

pub fn parse_skn(bytes: &[u8]) -> Result<SknMesh> {
    let mut r = Cursor::new(bytes);

    let magic = r.read_u32::<LittleEndian>()?;
    if magic != MAGIC {
        return Err(MeshError::InvalidSignature { format: "SKN", expected: MAGIC, got: magic });
    }

    let major = r.read_u16::<LittleEndian>()?;
    let minor = r.read_u16::<LittleEndian>()?;
    // Accept any major in 0..=4. Real-world SKNs include:
    //   - 0.x  legacy single-submesh layout
    //   - 1.x  ↔ 3.x  same as 2.x — submesh table, no flags/AABB.
    //          Some toolchains (Blender plugins, modkit exporters) tag
    //          v1 or v3 files even though the byte layout matches v2.
    //   - 4.x  adds the flags u32 + vertex_type + AABB block.
    // Anything else has never been seen in the wild and we'd be
    // guessing. Reject so we get a clean error rather than a silently
    // misparsed buffer.
    if major > 4 {
        return Err(MeshError::UnsupportedVersion { format: "SKN", major, minor });
    }

    let mut submeshes: Vec<SknSubmesh> = Vec::new();
    let index_count: u32;
    let vertex_count: u32;
    // 0 = Basic (52 B), 1 = Color (56 B), 2 = Tangent (72 B). Versions
    // 0/2 always emit the 52-byte Basic layout.
    let mut vertex_type: u32 = 0;
    let mut bbox_from_file: Option<[[f32; 3]; 2]> = None;

    if major == 0 {
        index_count = r.read_u32::<LittleEndian>()?;
        vertex_count = r.read_u32::<LittleEndian>()?;
        submeshes.push(SknSubmesh {
            name: "Base".to_string(),
            start_vertex: 0,
            vertex_count,
            start_index: 0,
            index_count,
        });
    } else {
        let submesh_count = r.read_u32::<LittleEndian>()? as usize;
        submeshes.reserve_exact(submesh_count);
        for _ in 0..submesh_count {
            let mut name_bytes = [0u8; 64];
            r.read_exact(&mut name_bytes)?;
            let nul = name_bytes.iter().position(|&b| b == 0).unwrap_or(64);
            let name = String::from_utf8_lossy(&name_bytes[..nul]).into_owned();
            submeshes.push(SknSubmesh {
                name,
                start_vertex: r.read_u32::<LittleEndian>()?,
                vertex_count: r.read_u32::<LittleEndian>()?,
                start_index: r.read_u32::<LittleEndian>()?,
                index_count: r.read_u32::<LittleEndian>()?,
            });
        }

        if major >= 4 {
            let _flags = r.read_u32::<LittleEndian>()?;
        }

        index_count = r.read_u32::<LittleEndian>()?;
        vertex_count = r.read_u32::<LittleEndian>()?;

        if major >= 4 {
            let vertex_size = r.read_u32::<LittleEndian>()?;
            vertex_type = r.read_u32::<LittleEndian>()?;
            // Validate the (size, type) pair the same way ltk_mesh does.
            // Mismatch usually means the file is corrupt or our version
            // detection is wrong.
            let expected_size = match vertex_type {
                0 => 52,
                1 => 56,
                2 => 72,
                _ => {
                    return Err(MeshError::InvalidField {
                        format: "SKN",
                        field: "vertex_type",
                        value: vertex_type.to_string(),
                    })
                }
            };
            if vertex_size != expected_size {
                return Err(MeshError::InvalidField {
                    format: "SKN",
                    field: "vertex_size",
                    value: format!("type={vertex_type} size={vertex_size}"),
                });
            }

            // AABB: vec3 min, vec3 max. Sphere: vec3 center + f32 radius.
            // We keep the AABB; sphere we ignore (camera framing uses AABB).
            let bb_min = [
                r.read_f32::<LittleEndian>()?,
                r.read_f32::<LittleEndian>()?,
                r.read_f32::<LittleEndian>()?,
            ];
            let bb_max = [
                r.read_f32::<LittleEndian>()?,
                r.read_f32::<LittleEndian>()?,
                r.read_f32::<LittleEndian>()?,
            ];
            // Sphere: 4 floats — skip without parsing.
            for _ in 0..4 {
                let _ = r.read_f32::<LittleEndian>()?;
            }
            bbox_from_file = Some([bb_min, bb_max]);
        }
    }

    // Indices: u16 triplets. Aventurine drops degenerate triangles (any
    // two indices equal); we keep them — the GPU happily skips them and
    // it preserves submesh.start_index alignment, which the frontend
    // relies on for per-material range slicing.
    let total_indices = index_count as usize;
    let mut indices = Vec::with_capacity(total_indices);
    for _ in 0..total_indices {
        indices.push(r.read_u16::<LittleEndian>()?);
    }

    // Vertices.
    let vc = vertex_count as usize;
    let mut positions = Vec::with_capacity(vc * 3);
    let mut uvs = Vec::with_capacity(vc * 2);
    let mut bone_indices = Vec::with_capacity(vc * 4);
    let mut bone_weights = Vec::with_capacity(vc * 4);

    for _ in 0..vc {
        // position
        positions.push(r.read_f32::<LittleEndian>()?);
        positions.push(r.read_f32::<LittleEndian>()?);
        positions.push(r.read_f32::<LittleEndian>()?);
        // 4 bone influences (bytes)
        let mut inf = [0u8; 4];
        r.read_exact(&mut inf)?;
        bone_indices.extend_from_slice(&inf);
        // 4 weights
        for _ in 0..4 {
            bone_weights.push(r.read_f32::<LittleEndian>()?);
        }
        // normal — discarded; recomputed by the renderer
        for _ in 0..3 {
            let _ = r.read_f32::<LittleEndian>()?;
        }
        // uv
        uvs.push(r.read_f32::<LittleEndian>()?);
        uvs.push(r.read_f32::<LittleEndian>()?);
        // optional color (4 bytes)
        if vertex_type >= 1 {
            let mut color = [0u8; 4];
            r.read_exact(&mut color)?;
        }
        // optional tangent (vec4)
        if vertex_type == 2 {
            for _ in 0..4 {
                let _ = r.read_f32::<LittleEndian>()?;
            }
        }
    }

    // If the file didn't carry an AABB, derive one. Skip empty meshes.
    let bbox = bbox_from_file.unwrap_or_else(|| {
        if positions.is_empty() {
            [[0.0; 3], [0.0; 3]]
        } else {
            let mut mn = [f32::MAX; 3];
            let mut mx = [f32::MIN; 3];
            for p in positions.chunks_exact(3) {
                for i in 0..3 {
                    if p[i] < mn[i] { mn[i] = p[i]; }
                    if p[i] > mx[i] { mx[i] = p[i]; }
                }
            }
            [mn, mx]
        }
    });

    Ok(SknMesh {
        major,
        minor,
        submeshes,
        indices,
        positions,
        uvs,
        bone_indices,
        bone_weights,
        bbox,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal valid v0 SKN: 1 triangle, 3 vertices, no skinning bytes
    /// to speak of (zeros). Verifies the simplest path — version 0 has no
    /// submesh table or vertex_type.
    #[test]
    fn parses_v0_single_triangle() {
        let mut buf: Vec<u8> = Vec::new();
        // header
        buf.extend(&MAGIC.to_le_bytes());
        buf.extend(&0u16.to_le_bytes()); // major
        buf.extend(&1u16.to_le_bytes()); // minor
        // counts
        buf.extend(&3u32.to_le_bytes()); // index_count
        buf.extend(&3u32.to_le_bytes()); // vertex_count
        // indices
        for i in 0..3u16 {
            buf.extend(&i.to_le_bytes());
        }
        // 3 vertices @ 52 bytes each
        for v in 0..3 {
            // position
            buf.extend(&(v as f32).to_le_bytes());
            buf.extend(&0f32.to_le_bytes());
            buf.extend(&0f32.to_le_bytes());
            // influences[4]
            buf.extend(&[0u8, 0, 0, 0]);
            // weights[4]
            buf.extend(&1f32.to_le_bytes());
            buf.extend(&0f32.to_le_bytes());
            buf.extend(&0f32.to_le_bytes());
            buf.extend(&0f32.to_le_bytes());
            // normal
            buf.extend(&0f32.to_le_bytes());
            buf.extend(&1f32.to_le_bytes());
            buf.extend(&0f32.to_le_bytes());
            // uv
            buf.extend(&0f32.to_le_bytes());
            buf.extend(&0f32.to_le_bytes());
        }

        let mesh = parse_skn(&buf).expect("parse");
        assert_eq!(mesh.major, 0);
        assert_eq!(mesh.submeshes.len(), 1);
        assert_eq!(mesh.submeshes[0].name, "Base");
        assert_eq!(mesh.indices, vec![0, 1, 2]);
        assert_eq!(mesh.positions.len(), 9);
        assert_eq!(mesh.bone_indices.len(), 12);
        assert_eq!(mesh.bone_weights.len(), 12);
    }

    #[test]
    fn rejects_bad_magic() {
        let buf = vec![0u8; 16];
        assert!(matches!(parse_skn(&buf), Err(MeshError::InvalidSignature { .. })));
    }

    #[test]
    fn rejects_unknown_major() {
        // major=7 is past the 0..=4 we know how to parse. A future
        // Riot bump would still need an explicit code path here.
        let mut buf: Vec<u8> = Vec::new();
        buf.extend(&MAGIC.to_le_bytes());
        buf.extend(&7u16.to_le_bytes());
        buf.extend(&1u16.to_le_bytes());
        assert!(matches!(parse_skn(&buf), Err(MeshError::UnsupportedVersion { .. })));
    }
}
