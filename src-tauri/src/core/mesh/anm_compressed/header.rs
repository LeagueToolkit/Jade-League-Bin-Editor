//! Header + raw section reader for the compressed ANM format.
//!
//! Byte layout (offsets relative to file start):
//!   0..8    magic    "r3d2canm"
//!   8..12   version  1, 2, or 3 (treated identically)
//!   12..16  resource_size       (ignored)
//!   16..20  format_token        (ignored)
//!   20..24  flags    bit 2 = UseKeyframeParametrization
//!   24..28  joint_count
//!   28..32  frame_count
//!   32..36  jump_cache_count
//!   36..40  duration (seconds)
//!   40..44  fps
//!   44..68  3 × ErrorMetric (margin + discontinuity, 8 B each) — ignored
//!   68..92  translation_min (vec3) + translation_max (vec3)
//!   92..116 scale_min (vec3) + scale_max (vec3)
//!   116..120 frames_off            (relative to byte 12)
//!   120..124 jump_caches_off       (relative to byte 12)
//!   124..128 joint_name_hashes_off (relative to byte 12)
//!
//! All three offsets are signed and added to byte 12 (post magic+version)
//! when seeking — same convention as the uncompressed v4/v5 path.
//!
//! The jump cache is a contiguous block sized
//! `jump_cache_count × joint_count × jump_frame_size`, where
//! `jump_frame_size` is 24 if `frame_count < 0x10001` (three [u16;4]
//! arrays) and 48 otherwise (three [u32;4] arrays). Stored as raw bytes
//! and decoded on demand by the evaluator.

use std::io::{Cursor, Read, Seek, SeekFrom};

use byteorder::{LittleEndian, ReadBytesExt};
use glam::Vec3;

use super::super::error::{MeshError, Result};
use super::frame::Frame;

/// Only the parametrization bit drives evaluation; the others are
/// pose-modifier hints we don't run.
const FLAG_USE_KEYFRAME_PARAMETRIZATION: u32 = 1 << 2;

#[derive(Clone, Copy, Debug)]
pub struct AnimationFlags(u32);

impl AnimationFlags {
    pub fn from_bits(bits: u32) -> Self {
        Self(bits)
    }
    pub fn use_keyframe_parametrization(&self) -> bool {
        (self.0 & FLAG_USE_KEYFRAME_PARAMETRIZATION) != 0
    }
}

pub struct CompressedAnimation {
    pub flags: AnimationFlags,
    pub duration: f32,
    pub fps: f32,
    pub joint_count: usize,
    pub frame_count: usize,
    pub jump_cache_count: usize,
    pub translation_min: Vec3,
    pub translation_max: Vec3,
    pub scale_min: Vec3,
    pub scale_max: Vec3,
    pub joints: Vec<u32>,
    pub frames: Vec<Frame>,
    pub jump_caches: Vec<u8>,
}

impl CompressedAnimation {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 124 {
            return Err(MeshError::Malformed(
                "compressed ANM truncated header".to_string(),
            ));
        }

        let mut r = Cursor::new(bytes);
        // magic+version were validated by the dispatcher; skip them
        r.set_position(8);
        let version = r.read_u32::<LittleEndian>()?;
        if !(1..=3).contains(&version) {
            return Err(MeshError::UnsupportedVersion {
                format: "ANM (compressed)",
                major: version as u16,
                minor: 0,
            });
        }

        let _resource_size = r.read_u32::<LittleEndian>()?;
        let _format_token = r.read_u32::<LittleEndian>()?;
        let flags_raw = r.read_u32::<LittleEndian>()?;
        let flags = AnimationFlags::from_bits(flags_raw);

        let joint_count = r.read_u32::<LittleEndian>()? as usize;
        let frame_count = r.read_u32::<LittleEndian>()? as usize;
        let jump_cache_count = r.read_i32::<LittleEndian>()?.max(0) as usize;

        let duration = r.read_f32::<LittleEndian>()?;
        let fps = r.read_f32::<LittleEndian>()?;

        // Three ErrorMetric records, 8 bytes each — used by Riot's
        // pose-modifier system; we don't run those, so skip.
        for _ in 0..3 {
            let _margin = r.read_f32::<LittleEndian>()?;
            let _discon = r.read_f32::<LittleEndian>()?;
        }

        let translation_min = read_vec3(&mut r)?;
        let translation_max = read_vec3(&mut r)?;
        let scale_min = read_vec3(&mut r)?;
        let scale_max = read_vec3(&mut r)?;

        let frames_off = r.read_i32::<LittleEndian>()?;
        let jump_caches_off = r.read_i32::<LittleEndian>()?;
        let joint_name_hashes_off = r.read_i32::<LittleEndian>()?;

        if frames_off <= 0 {
            return Err(MeshError::Malformed(
                "compressed ANM missing frames section".to_string(),
            ));
        }
        if joint_name_hashes_off <= 0 {
            return Err(MeshError::Malformed(
                "compressed ANM missing joint hashes section".to_string(),
            ));
        }

        // Joint hashes — joint_count × u32 in joint-index order.
        r.seek(SeekFrom::Start(joint_name_hashes_off as u64 + 12))?;
        let mut joints = Vec::with_capacity(joint_count);
        for _ in 0..joint_count {
            joints.push(r.read_u32::<LittleEndian>()?);
        }

        // Frames — read the 10 bytes per frame field-by-field. The on-
        // disk struct is `#[repr(C, packed)]` and not naturally aligned,
        // so a bulk reinterp would be undefined behavior.
        r.seek(SeekFrom::Start(frames_off as u64 + 12))?;
        let mut frames = Vec::with_capacity(frame_count);
        for _ in 0..frame_count {
            let time = r.read_u16::<LittleEndian>()?;
            let joint_id_raw = r.read_u16::<LittleEndian>()?;
            let v0 = r.read_u16::<LittleEndian>()?;
            let v1 = r.read_u16::<LittleEndian>()?;
            let v2 = r.read_u16::<LittleEndian>()?;
            frames.push(Frame {
                time,
                joint_id_raw,
                value: [v0, v1, v2],
            });
        }

        // Jump cache — flat byte block. ltk_anim's reader uses
        // `Vec::with_capacity(...)` then `read_exact` into it, which
        // reads 0 bytes because capacity != length. We must allocate
        // the full length up front.
        let jump_caches = if jump_caches_off > 0 && jump_cache_count > 0 && joint_count > 0 {
            let jump_frame_size = if frame_count < 0x1_0001 { 24 } else { 48 };
            let total = jump_cache_count
                .checked_mul(joint_count)
                .and_then(|n| n.checked_mul(jump_frame_size))
                .ok_or_else(|| {
                    MeshError::Malformed("compressed ANM jump cache size overflow".to_string())
                })?;
            r.seek(SeekFrom::Start(jump_caches_off as u64 + 12))?;
            let mut buf = vec![0u8; total];
            r.read_exact(&mut buf)?;
            buf
        } else {
            Vec::new()
        };

        Ok(Self {
            flags,
            duration,
            fps,
            joint_count,
            frame_count,
            jump_cache_count,
            translation_min,
            translation_max,
            scale_min,
            scale_max,
            joints,
            frames,
            jump_caches,
        })
    }
}

fn read_vec3<R: Read>(r: &mut R) -> Result<Vec3> {
    let x = r.read_f32::<LittleEndian>()?;
    let y = r.read_f32::<LittleEndian>()?;
    let z = r.read_f32::<LittleEndian>()?;
    Ok(Vec3::new(x, y, z))
}
