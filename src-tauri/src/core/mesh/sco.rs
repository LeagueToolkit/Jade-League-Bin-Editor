//! SCO (Simple Character Object) parser — League's *text-based*
//! static-mesh format. Used for similar things SCB is used for, just
//! human-readable instead of packed binary.
//!
//! Format (cross-checked with Aventurine `import_sco.py`):
//!
//! ```text
//! [ObjectBegin]
//! Name= <name>
//! CentralPoint= x y z          (optional)
//! PivotPoint= x y z            (optional)
//! Verts= N
//! x y z                        × N
//! Faces= M
//! 3 v0 v1 v2 mat u0 v0 u1 v1 u2 v2     × M
//! [ObjectEnd]
//! ```
//!
//! Each face's vertex line carries indices into the vertex list AND
//! a material name AND per-face UVs (so the same vertex can have
//! different UVs on different triangles). We emit un-indexed
//! geometry the same way [`super::scb`] does — sequential indices,
//! one fresh output vertex per face corner.

use serde::Serialize;

use super::error::{MeshError, Result};
use super::scb::StaticMesh;

pub fn parse_sco(bytes: &[u8]) -> Result<StaticMesh> {
    // Tolerate UTF-8 BOM and stray CRLFs — some SCO files come from
    // Windows tooling that adds both.
    let text = std::str::from_utf8(bytes)
        .map_err(|e| MeshError::Malformed(format!("SCO not valid UTF-8: {e}")))?
        .trim_start_matches('\u{feff}');

    let mut lines = text.lines().map(|l| l.trim()).peekable();

    let header = lines.next().unwrap_or("");
    if header != "[ObjectBegin]" {
        return Err(MeshError::Malformed(format!(
            "SCO must start with [ObjectBegin], got '{}'",
            header
        )));
    }

    let mut shared_pos: Vec<[f32; 3]> = Vec::new();
    let mut positions: Vec<f32> = Vec::new();
    let mut uvs: Vec<f32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut material: Option<String> = None;
    let mut next_index: u32 = 0;

    while let Some(line) = lines.next() {
        if line.is_empty() || line == "[ObjectEnd]" {
            continue;
        }

        if let Some(rest) = line.strip_prefix("Verts=") {
            // `Verts= N` then N lines of `x y z`. Pre-allocate so big
            // meshes don't grow the vec one entry at a time.
            let n = rest.trim().parse::<usize>().unwrap_or(0);
            shared_pos.reserve_exact(n);
            for _ in 0..n {
                let vline = lines.next().ok_or_else(|| {
                    MeshError::Malformed("SCO truncated mid-Verts block".into())
                })?;
                let mut parts = vline.split_ascii_whitespace();
                let x = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
                let y = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
                let z = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
                shared_pos.push([x, y, z]);
            }
            continue;
        }

        if let Some(rest) = line.strip_prefix("Faces=") {
            // Each face line: `3 v0 v1 v2 matname u0 v0 u1 v1 u2 v2`.
            // Whitespace is irregular (mix of tabs + spaces) so we
            // split on any whitespace.
            let n = rest.trim().parse::<usize>().unwrap_or(0);
            positions.reserve(n * 9);
            uvs.reserve(n * 6);
            indices.reserve(n * 3);
            for _ in 0..n {
                let fline = lines.next().ok_or_else(|| {
                    MeshError::Malformed("SCO truncated mid-Faces block".into())
                })?;
                let parts: Vec<&str> = fline.split_ascii_whitespace().collect();
                if parts.len() < 11 {
                    continue; // skip malformed face lines
                }

                let i0: usize = parts[1].parse().unwrap_or(0);
                let i1: usize = parts[2].parse().unwrap_or(0);
                let i2: usize = parts[3].parse().unwrap_or(0);

                if material.is_none() {
                    let name = parts[4].trim_matches('\0').to_string();
                    if !name.is_empty() {
                        material = Some(name);
                    }
                }

                if i0 == i1 || i1 == i2 || i0 == i2 {
                    continue; // degenerate
                }

                let u0: f32 = parts[5].parse().unwrap_or(0.0);
                let v0: f32 = parts[6].parse().unwrap_or(0.0);
                let u1: f32 = parts[7].parse().unwrap_or(0.0);
                let v1: f32 = parts[8].parse().unwrap_or(0.0);
                let u2: f32 = parts[9].parse().unwrap_or(0.0);
                let v2: f32 = parts[10].parse().unwrap_or(0.0);

                for (vi, u, v) in [(i0, u0, v0), (i1, u1, v1), (i2, u2, v2)] {
                    let p = shared_pos.get(vi).copied().unwrap_or([0.0; 3]);
                    positions.extend_from_slice(&p);
                    uvs.push(u);
                    uvs.push(v);
                    indices.push(next_index);
                    next_index += 1;
                }
            }
            continue;
        }

        // Unknown / ignored line (Name=, CentralPoint=, PivotPoint=,
        // misc metadata). Walk past — we only care about geometry +
        // material name for the preview.
    }

    if shared_pos.is_empty() && positions.is_empty() {
        return Err(MeshError::Malformed("SCO contains no geometry".into()));
    }

    // Compute AABB from the actual emitted positions. Cheap because
    // we already pay the iteration on every render-side pipeline anyway.
    let bbox = if positions.is_empty() {
        [[0.0; 3], [0.0; 3]]
    } else {
        let mut mn = [f32::MAX; 3];
        let mut mx = [f32::MIN; 3];
        for p in positions.chunks_exact(3) {
            for i in 0..3 {
                if p[i] < mn[i] {
                    mn[i] = p[i];
                }
                if p[i] > mx[i] {
                    mx[i] = p[i];
                }
            }
        }
        [mn, mx]
    };

    Ok(StaticMesh {
        // SCO has no version field in the common form, so we report
        // 0.0 to make the source obvious in any logs.
        major: 0,
        minor: 0,
        material: material.unwrap_or_else(|| "default".to_string()),
        indices,
        positions,
        uvs,
        bbox,
    })
}

// Unused — silences a warning if `Serialize` is somehow unused.
#[allow(dead_code)]
fn _ensure_serde<T: Serialize>() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_sco() {
        let text = "[ObjectBegin]\nName= cube\nVerts= 3\n0 0 0\n1 0 0\n0 1 0\nFaces= 1\n3 0 1 2 testmat 0 0 1 0 0 1\n[ObjectEnd]\n";
        let mesh = parse_sco(text.as_bytes()).expect("parse");
        assert_eq!(mesh.material, "testmat");
        assert_eq!(mesh.indices, vec![0, 1, 2]);
        assert_eq!(mesh.positions.len(), 9);
        assert_eq!(mesh.uvs.len(), 6);
    }

    #[test]
    fn skips_degenerate_faces() {
        let text = "[ObjectBegin]\nVerts= 3\n0 0 0\n1 0 0\n0 1 0\nFaces= 2\n3 0 0 0 m 0 0 0 0 0 0\n3 0 1 2 m 0 0 1 0 0 1\n[ObjectEnd]\n";
        let mesh = parse_sco(text.as_bytes()).expect("parse");
        assert_eq!(mesh.indices, vec![0, 1, 2]); // first face skipped
    }

    #[test]
    fn rejects_missing_header() {
        let text = "Hello world\n";
        assert!(matches!(parse_sco(text.as_bytes()), Err(MeshError::Malformed(_))));
    }
}
