//! Compressed ANM (`r3d2canm`) parser.
//!
//! Riot's compressed format stores each joint's TRS curves as a sparse
//! sequence of keyframes, sorted by time across all joints. The
//! evaluator walks the sequence with a hot-frame window and fills gaps
//! between keyframes with Catmull-Rom interpolation. Jump caches give
//! the evaluator a starting window for any time point so seek is O(1)
//! per joint instead of a linear scan from frame 0.
//!
//! For our purposes — the JS player consumes baked frames at uniform
//! intervals — we run the evaluator at `fps` for `duration` seconds
//! and produce the same `BakedAnimation` shape the uncompressed path
//! returns. The frontend stays format-agnostic.
//!
//! Cross-checked against `ltk_anim::Compressed::from_reader` and its
//! `CompressedEvaluator`. We don't depend on those crates per the
//! user's rule — the algorithms are reimplemented from scratch.

mod evaluate;
mod evaluator;
mod frame;
mod header;

use super::anm::{AnmFrame, AnmTrack, BakedAnimation};
use super::error::Result;
use evaluator::CompressedEvaluator;
use header::CompressedAnimation;

pub fn parse_compressed_anm(bytes: &[u8]) -> Result<BakedAnimation> {
    let animation = CompressedAnimation::from_bytes(bytes)?;

    let duration = animation.duration;
    let fps = if animation.fps > 0.0 { animation.fps } else { 30.0 };

    if duration <= 0.0 || animation.frame_count == 0 || animation.joint_count == 0 {
        return Ok(BakedAnimation {
            duration: duration.max(0.0),
            fps,
            frame_count: 0,
            tracks: Vec::new(),
        });
    }

    // Resample at the source fps. Pinning to `fps` rather than
    // `frame_count` matches what the uncompressed path produces and
    // keeps the JS player's lerp budget consistent across formats.
    let baked_frame_count = ((duration * fps).round() as usize).max(1);

    let mut tracks: Vec<AnmTrack> = animation
        .joints
        .iter()
        .map(|&hash| AnmTrack {
            joint_hash: hash,
            frames: Vec::with_capacity(baked_frame_count),
        })
        .collect();

    let mut evaluator = CompressedEvaluator::new(&animation);
    for f in 0..baked_frame_count {
        let t = ((f as f32) / fps).min(duration);
        let pose = evaluator.evaluate(t);
        for (track_idx, &joint_hash) in animation.joints.iter().enumerate() {
            // Default to identity-ish if for some reason the joint
            // isn't in the pose map (shouldn't happen — evaluator
            // returns every joint hash). Mirrors the uncompressed
            // baker's defensive fallback.
            let (rot, trans, scale) = pose.get(&joint_hash).copied().unwrap_or_else(|| {
                (
                    glam::Quat::IDENTITY,
                    glam::Vec3::ZERO,
                    glam::Vec3::ONE,
                )
            });
            tracks[track_idx].frames.push(AnmFrame {
                translation: trans.to_array(),
                rotation: [rot.x, rot.y, rot.z, rot.w],
                scale: scale.to_array(),
            });
        }
    }

    Ok(BakedAnimation {
        duration,
        fps,
        frame_count: baked_frame_count as u32,
        tracks,
    })
}
