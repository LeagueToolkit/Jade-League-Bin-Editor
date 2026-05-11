//! SKL (Skeleton) parser — League's bone hierarchy + bind-pose container.
//!
//! Layout (cross-checked against Aventurine `import_skl.py`,
//! `league-toolkit-main/crates/ltk_anim/src/rig/read.rs`, and Flint):
//!
//! ```text
//! u32   _file_size      (we ignore — recoverable from .len())
//! u32   format_token    0x22FD4FC3
//! u32   version         must be 0
//! u16   flags
//! u16   joint_count
//! u32   influence_count
//! i32   joints_off      → joint table
//! i32   joint_indices_off  (sorted by name hash; we don't need it)
//! i32   influences_off  → influence indices (i16 each)
//! i32   name_off
//! i32   asset_name_off
//! i32   _bone_names_off
//! i32 × 5  reserved/extension offsets
//!
//! Joint (100 bytes each, name fetched out-of-line):
//!   u16   flags
//!   i16   id
//!   i16   parent_id     (-1 for root)
//!   i16   _padding
//!   u32   _name_hash
//!   f32   radius
//!   vec3  local_translation
//!   vec3  local_scale
//!   quat  local_rotation       (xyzw, normalize on read)
//!   vec3  inverse_bind_translation
//!   vec3  inverse_bind_scale
//!   quat  inverse_bind_rotation
//!   i32   name_off              (RELATIVE to current cursor − 4)
//! ```
//!
//! For preview rendering we only need joint names, parent links, and
//! world positions (computed from the local-TRS chain) so we can draw
//! lines from each joint to its parent. Local TRS is preserved on the
//! DTO for the upcoming animation layer — ANM tracks deliver TRS deltas
//! against this rest pose.

use std::io::{Cursor, Read, Seek, SeekFrom};

use byteorder::{LittleEndian, ReadBytesExt};
use glam::{Mat4, Quat, Vec3};
use serde::Serialize;

use super::error::{MeshError, Result};

const FORMAT_TOKEN: u32 = 0x22FD_4FC3;

/// One bone in the skeleton, in League space (LH Y-up).
#[derive(Debug, Clone, Serialize)]
pub struct SklJoint {
    pub name: String,
    pub id: i16,
    pub parent_id: i16,
    /// ELF hash of the lowercased name. We compute this ourselves
    /// rather than trusting the file's stored hash field — Aventurine
    /// does the same, citing inconsistencies in the wild where the
    /// stored hash isn't always ELF (custom rigs, older tooling).
    /// ANM joint tracks key on ELF(lowercase(name)), so computing
    /// it here guarantees the frontend's track → bone match works
    /// regardless of what the SKL file happens to carry.
    pub name_hash: u32,
    /// Bone radius from the file. Some skeletons use this to size visual
    /// indicators or collision; we surface it but don't currently use it
    /// in the preview.
    pub radius: f32,
    /// Local transform relative to the parent bone.
    pub local_translation: [f32; 3],
    pub local_rotation: [f32; 4], // xyzw
    pub local_scale: [f32; 3],
    /// World-space position in the bind pose, computed by composing the
    /// local TRS chain from this joint up to the root. The frontend uses
    /// this directly to draw bone lines without re-running the math.
    pub world_position: [f32; 3],
}

/// Parsed SKL ready for IPC. Light enough that we just JSON it across.
#[derive(Debug, Clone, Serialize)]
pub struct SklSkeleton {
    pub name: String,
    pub asset_name: String,
    pub flags: u16,
    pub joints: Vec<SklJoint>,
    /// `influences[i]` returns the joint id that SKN bone-index `i`
    /// refers to. SKN vertex `bone_indices` arrays are indices into
    /// THIS table, not raw joint ids — preserving it is required if we
    /// want to skin the SKN to this skeleton later. Empty for skeletons
    /// with no influence remap (rare).
    pub influences: Vec<i16>,
}

pub fn parse_skl(bytes: &[u8]) -> Result<SklSkeleton> {
    let mut r = Cursor::new(bytes);

    // Sniff the format token from offset 4 first — legacy SKLs have a
    // different magic and a completely different layout. We don't
    // support legacy here (Aventurine bails too); reject so the caller
    // gets a clean error rather than a silently-misparsed buffer.
    r.seek(SeekFrom::Start(4))?;
    let token = r.read_u32::<LittleEndian>()?;
    if token != FORMAT_TOKEN {
        return Err(MeshError::InvalidSignature {
            format: "SKL",
            expected: FORMAT_TOKEN,
            got: token,
        });
    }
    r.rewind()?;

    let _file_size = r.read_u32::<LittleEndian>()?;
    let _format_token = r.read_u32::<LittleEndian>()?; // already validated
    let version = r.read_u32::<LittleEndian>()?;
    if version != 0 {
        return Err(MeshError::UnsupportedVersion {
            format: "SKL",
            major: version as u16,
            minor: 0,
        });
    }

    let flags = r.read_u16::<LittleEndian>()?;
    let joint_count = r.read_u16::<LittleEndian>()? as usize;
    let influence_count = r.read_u32::<LittleEndian>()? as usize;
    let joints_off = r.read_i32::<LittleEndian>()?;
    let _joint_indices_off = r.read_i32::<LittleEndian>()?;
    let influences_off = r.read_i32::<LittleEndian>()?;
    let name_off = r.read_i32::<LittleEndian>()?;
    let asset_name_off = r.read_i32::<LittleEndian>()?;
    let _bone_names_off = r.read_i32::<LittleEndian>()?;
    // 5 × i32 reserved/extension slots — every modern SKL leaves these
    // at 0/-1, but we still need to consume them to land at the right
    // offset for the joint table.
    for _ in 0..5 {
        let _ = r.read_i32::<LittleEndian>()?;
    }

    // Read joints in file order. We accumulate raw TRS now and resolve
    // world positions in a second pass, since a joint's world position
    // depends on its parent's world position which may not have been
    // read yet (the file is mostly parent-before-child but Aventurine
    // notes some skeletons append custom bones after the natives even
    // though they reparent earlier ones).
    let mut raw: Vec<RawJoint> = Vec::with_capacity(joint_count);
    if joints_off > 0 {
        r.seek(SeekFrom::Start(joints_off as u64))?;
        for _ in 0..joint_count {
            raw.push(read_joint(&mut r)?);
        }
    }

    let mut influences: Vec<i16> = Vec::with_capacity(influence_count);
    if influences_off > 0 && influence_count > 0 {
        r.seek(SeekFrom::Start(influences_off as u64))?;
        for _ in 0..influence_count {
            influences.push(r.read_i16::<LittleEndian>()?);
        }
    }

    let name = if name_off > 0 {
        r.seek(SeekFrom::Start(name_off as u64))?;
        read_cstr(&mut r)?
    } else {
        String::new()
    };
    let asset_name = if asset_name_off > 0 {
        r.seek(SeekFrom::Start(asset_name_off as u64))?;
        read_cstr(&mut r)?
    } else {
        String::new()
    };

    // Pass 2: world positions via memoised local-TRS composition. Done
    // recursively-with-cache so out-of-order parents (parent index >
    // child index) still resolve correctly without an explicit topo
    // sort. Cycles would loop forever; we bound the recursion at the
    // joint count to bail rather than blow the stack on a malformed
    // file.
    let mut world_mats: Vec<Option<Mat4>> = vec![None; raw.len()];
    let mut joints: Vec<SklJoint> = Vec::with_capacity(raw.len());
    for i in 0..raw.len() {
        let world = compose_world_mat(&raw, &mut world_mats, i, 0)?;
        let pos = world.w_axis.truncate();
        let r = &raw[i];
        joints.push(SklJoint {
            name: r.name.clone(),
            id: r.id,
            parent_id: r.parent_id,
            // Compute ELF here so the frontend gets a hash that's
            // guaranteed to match ANM joint tracks. Using the
            // file's stored hash field works for most stock SKLs
            // but breaks on custom rigs / older tooling where
            // it's been observed to drift from ELF.
            name_hash: elf_hash_lower(&r.name),
            radius: r.radius,
            local_translation: r.local_translation.to_array(),
            local_rotation: [
                r.local_rotation.x,
                r.local_rotation.y,
                r.local_rotation.z,
                r.local_rotation.w,
            ],
            local_scale: r.local_scale.to_array(),
            world_position: pos.to_array(),
        });
    }

    Ok(SklSkeleton {
        name,
        asset_name,
        flags,
        joints,
        influences,
    })
}

struct RawJoint {
    name: String,
    id: i16,
    parent_id: i16,
    /// File's stored hash field. We mostly ignore it (see SklJoint
    /// `name_hash` for why) — kept here to avoid losing data if a
    /// debug pass wants to compare it against the computed ELF.
    #[allow(dead_code)]
    stored_name_hash: u32,
    radius: f32,
    local_translation: Vec3,
    local_rotation: Quat,
    local_scale: Vec3,
}

fn read_joint<R: Read + Seek>(r: &mut R) -> Result<RawJoint> {
    let _flags = r.read_u16::<LittleEndian>()?;
    let id = r.read_i16::<LittleEndian>()?;
    let parent_id = r.read_i16::<LittleEndian>()?;
    let _padding = r.read_i16::<LittleEndian>()?;
    let name_hash = r.read_u32::<LittleEndian>()?;
    let radius = r.read_f32::<LittleEndian>()?;

    let local_translation = read_vec3(r)?;
    let local_scale = read_vec3(r)?;
    let local_rotation = read_quat(r)?.normalize();

    // Inverse-bind TRS — 40 bytes we don't currently use. Both Aventurine
    // and our renderer compose world positions from the local-TRS chain;
    // the inverse-bind block is kept by ltk_anim for compressed
    // animations. If we ever decode compressed ANMs we'll need it back,
    // but for the preview pass it's redundant.
    let _inv_bind_translation = read_vec3(r)?;
    let _inv_bind_scale = read_vec3(r)?;
    let _inv_bind_rotation = read_quat(r)?;

    let name_off = r.read_i32::<LittleEndian>()?;
    let return_pos = r.stream_position()?;
    // The on-disk offset is relative to `name_off`'s OWN position, not
    // the cursor right after reading it — i.e. we have to back up 4
    // bytes before adding name_off. Aventurine and ltk_anim do the
    // same `-4` correction.
    let abs_name_pos = (return_pos as i64) - 4 + name_off as i64;
    if abs_name_pos < 0 {
        return Err(MeshError::Malformed(format!(
            "SKL joint name offset out of range: {abs_name_pos}"
        )));
    }
    r.seek(SeekFrom::Start(abs_name_pos as u64))?;
    let name = read_cstr(r)?;
    r.seek(SeekFrom::Start(return_pos))?;

    Ok(RawJoint {
        name,
        id,
        parent_id,
        stored_name_hash: name_hash,
        radius,
        local_translation,
        local_rotation,
        local_scale,
    })
}

/// ELF hash of the lowercased input — same algorithm League uses for
/// ANM v3 joint names and (reportedly) for v4/v5 stored hashes.
/// Lowercases ASCII before hashing so casing differences don't break
/// matching ("R_HAND" and "r_hand" hash identically).
fn elf_hash_lower(s: &str) -> u32 {
    let mut h: u32 = 0;
    for &b in s.as_bytes() {
        let c = if b.is_ascii_uppercase() { b + 32 } else { b } as u32;
        h = h.wrapping_shl(4).wrapping_add(c);
        let x = h & 0xf000_0000;
        if x != 0 {
            h ^= x >> 24;
        }
        h &= !x;
    }
    h
}

fn compose_world_mat(
    raw: &[RawJoint],
    cache: &mut [Option<Mat4>],
    i: usize,
    depth: usize,
) -> Result<Mat4> {
    if depth > raw.len() {
        return Err(MeshError::Malformed(
            "SKL joint parent chain has a cycle".to_string(),
        ));
    }
    if let Some(m) = cache[i] {
        return Ok(m);
    }
    let j = &raw[i];
    let local =
        Mat4::from_scale_rotation_translation(j.local_scale, j.local_rotation, j.local_translation);
    let world = if j.parent_id < 0 {
        local
    } else {
        let p = j.parent_id as usize;
        if p >= raw.len() {
            return Err(MeshError::Malformed(format!(
                "SKL joint {} has out-of-range parent {}",
                i, j.parent_id
            )));
        }
        let parent_world = compose_world_mat(raw, cache, p, depth + 1)?;
        parent_world * local
    };
    cache[i] = Some(world);
    Ok(world)
}

fn read_vec3<R: Read>(r: &mut R) -> Result<Vec3> {
    let x = r.read_f32::<LittleEndian>()?;
    let y = r.read_f32::<LittleEndian>()?;
    let z = r.read_f32::<LittleEndian>()?;
    Ok(Vec3::new(x, y, z))
}

fn read_quat<R: Read>(r: &mut R) -> Result<Quat> {
    let x = r.read_f32::<LittleEndian>()?;
    let y = r.read_f32::<LittleEndian>()?;
    let z = r.read_f32::<LittleEndian>()?;
    let w = r.read_f32::<LittleEndian>()?;
    Ok(Quat::from_xyzw(x, y, z, w))
}

fn read_cstr<R: Read>(r: &mut R) -> Result<String> {
    let mut bytes = Vec::with_capacity(32);
    let mut buf = [0u8; 1];
    loop {
        if r.read(&mut buf)? == 0 {
            break;
        }
        if buf[0] == 0 {
            break;
        }
        bytes.push(buf[0]);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal valid SKL with one root joint. Verifies the
    /// header layout, name-offset relocation, and world-position
    /// passthrough for a parentless bone.
    #[test]
    fn parses_single_root_joint() {
        // Layout (offsets in bytes from start):
        //  0  : file_size (u32)               4
        //  4  : format_token (u32)            4
        //  8  : version (u32)                 4
        //  12 : flags (u16)                   2
        //  14 : joint_count (u16) = 1         2
        //  16 : influence_count (u32) = 0     4
        //  20 : joints_off (i32)              4
        //  24 : joint_indices_off (i32) = 0   4
        //  28 : influences_off (i32) = 0      4
        //  32 : name_off (i32) = 0            4
        //  36 : asset_name_off (i32) = 0      4
        //  40 : bone_names_off (i32) = 0      4
        //  44 : 5 × i32 reserved              20
        //  64 : joint table (1 × 100 bytes)   100
        //  164: joint name "root" + nul       5
        let joints_off: i32 = 64;
        let mut buf: Vec<u8> = Vec::new();
        buf.extend(&0u32.to_le_bytes()); // _file_size
        buf.extend(&FORMAT_TOKEN.to_le_bytes());
        buf.extend(&0u32.to_le_bytes()); // version
        buf.extend(&0u16.to_le_bytes()); // flags
        buf.extend(&1u16.to_le_bytes()); // joint_count
        buf.extend(&0u32.to_le_bytes()); // influence_count
        buf.extend(&joints_off.to_le_bytes());
        buf.extend(&0i32.to_le_bytes()); // joint_indices_off
        buf.extend(&0i32.to_le_bytes()); // influences_off
        buf.extend(&0i32.to_le_bytes()); // name_off
        buf.extend(&0i32.to_le_bytes()); // asset_name_off
        buf.extend(&0i32.to_le_bytes()); // bone_names_off
        for _ in 0..5 {
            buf.extend(&0i32.to_le_bytes());
        }
        assert_eq!(buf.len(), 64);

        // Joint
        buf.extend(&0u16.to_le_bytes()); // flags
        buf.extend(&0i16.to_le_bytes()); // id
        buf.extend(&(-1i16).to_le_bytes()); // parent_id
        buf.extend(&0i16.to_le_bytes()); // padding
        buf.extend(&0u32.to_le_bytes()); // name_hash
        buf.extend(&1.0f32.to_le_bytes()); // radius
        // local TRS
        for _ in 0..3 {
            buf.extend(&0f32.to_le_bytes());
        } // translation
        for _ in 0..3 {
            buf.extend(&1f32.to_le_bytes());
        } // scale
        buf.extend(&0f32.to_le_bytes()); // rot.x
        buf.extend(&0f32.to_le_bytes()); // rot.y
        buf.extend(&0f32.to_le_bytes()); // rot.z
        buf.extend(&1f32.to_le_bytes()); // rot.w
        // inv-bind TRS (zeros — unused)
        for _ in 0..10 {
            buf.extend(&0f32.to_le_bytes());
        }
        // name_off — points to the byte after this i32 (= position 100
        // inside the joint), and we want the name at file offset 164.
        // Cursor after this read = 64 + 100 = 164. So file_offset =
        // (cursor - 4) + name_off → 160 + name_off = 164 → name_off=4.
        buf.extend(&4i32.to_le_bytes());
        assert_eq!(buf.len(), 164);

        buf.extend(b"root\0");

        let skl = parse_skl(&buf).expect("parse");
        assert_eq!(skl.joints.len(), 1);
        assert_eq!(skl.joints[0].name, "root");
        assert_eq!(skl.joints[0].parent_id, -1);
        assert_eq!(skl.joints[0].world_position, [0.0, 0.0, 0.0]);
    }

    #[test]
    fn rejects_legacy_token() {
        // Legacy SKLs use a different magic — anything other than
        // FORMAT_TOKEN at offset 4 should bail with InvalidSignature.
        let mut buf = vec![0u8; 8];
        buf[4..8].copy_from_slice(&0xDEAD_BEEFu32.to_le_bytes());
        assert!(matches!(parse_skl(&buf), Err(MeshError::InvalidSignature { .. })));
    }
}
