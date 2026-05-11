//! Stateful evaluator for compressed ANM playback.
//!
//! Sequential `evaluate(t)` calls walk a cursor forward through the
//! frame table, shifting each affected joint's hot frame window from
//! `[P0, P1, P2, P3]` to `[P1, P2, P3, new]` whenever the cursor
//! crosses the `P2.time` mark. Backwards seeks or large forward
//! jumps trigger a re-init from the jump cache, which gives us a
//! starting hot-frame window for every joint without scanning from
//! frame 0.

use std::collections::HashMap;

use glam::{Quat, Vec3};

use super::evaluate::{
    compress_time, decompress_quat_u16, decompress_vector3, JointHotFrame, QuaternionHotFrame,
    VectorHotFrame,
};
use super::frame::TransformType;
use super::header::CompressedAnimation;

pub struct CompressedEvaluator<'a> {
    animation: &'a CompressedAnimation,
    last_evaluation_time: f32,
    cursor: usize,
    hot_frames: Vec<JointHotFrame>,
}

impl<'a> CompressedEvaluator<'a> {
    pub fn new(animation: &'a CompressedAnimation) -> Self {
        Self {
            last_evaluation_time: -1.0,
            cursor: 0,
            hot_frames: vec![JointHotFrame::default(); animation.joint_count],
            animation,
        }
    }

    /// Sample every joint at `time`. Returns `(rotation, translation,
    /// scale)` keyed by joint hash so callers can match against
    /// `SklJoint.name_hash`.
    pub fn evaluate(&mut self, time: f32) -> HashMap<u32, (Quat, Vec3, Vec3)> {
        let time = time.clamp(0.0, self.animation.duration);
        let parametrized = self.animation.flags.use_keyframe_parametrization();

        self.update_hot_frames(time);

        let compressed_time = compress_time(time, self.animation.duration);
        let mut out = HashMap::with_capacity(self.animation.joints.len());
        for (joint_idx, &hash) in self.animation.joints.iter().enumerate() {
            let hf = &self.hot_frames[joint_idx];
            out.insert(hash, hf.sample(compressed_time, parametrized));
        }
        out
    }

    fn update_hot_frames(&mut self, time: f32) {
        let needs_reinit = self.last_evaluation_time < 0.0
            || self.last_evaluation_time > time
            || (self.animation.jump_cache_count > 0
                && (time - self.last_evaluation_time)
                    > self.animation.duration / self.animation.jump_cache_count as f32);

        if needs_reinit {
            self.initialize_from_jump_cache(time);
        }

        let compressed_time = compress_time(time, self.animation.duration);
        self.advance_cursor(compressed_time);

        self.last_evaluation_time = time;
    }

    fn initialize_from_jump_cache(&mut self, time: f32) {
        if self.animation.jump_cache_count == 0 || self.animation.duration <= 0.0 {
            return;
        }

        let jump_cache_id = ((self.animation.jump_cache_count as f32
            * (time / self.animation.duration)) as usize)
            .min(self.animation.jump_cache_count - 1);

        self.cursor = 0;

        if self.animation.frame_count < 0x1_0001 {
            self.init_from_cache_u16(jump_cache_id);
        } else {
            self.init_from_cache_u32(jump_cache_id);
        }

        self.cursor += 1;
    }

    fn init_from_cache_u16(&mut self, jump_cache_id: usize) {
        // Each jump frame is 24 bytes: 3 × [u16; 4].
        const FRAME_SIZE: usize = 24;
        let cache_start = jump_cache_id * FRAME_SIZE * self.animation.joints.len();
        for joint_idx in 0..self.animation.joints.len() {
            let off = cache_start + joint_idx * FRAME_SIZE;
            let Some(slice) = self.animation.jump_caches.get(off..off + FRAME_SIZE) else {
                continue;
            };
            let rot = read_u16x4(&slice[0..8]);
            let trans = read_u16x4(&slice[8..16]);
            let scale = read_u16x4(&slice[16..24]);
            self.init_joint_hot_frame(
                joint_idx,
                &rot.map(|k| k as usize),
                &trans.map(|k| k as usize),
                &scale.map(|k| k as usize),
            );
        }
    }

    fn init_from_cache_u32(&mut self, jump_cache_id: usize) {
        // Each jump frame is 48 bytes: 3 × [u32; 4].
        const FRAME_SIZE: usize = 48;
        let cache_start = jump_cache_id * FRAME_SIZE * self.animation.joints.len();
        for joint_idx in 0..self.animation.joints.len() {
            let off = cache_start + joint_idx * FRAME_SIZE;
            let Some(slice) = self.animation.jump_caches.get(off..off + FRAME_SIZE) else {
                continue;
            };
            let rot = read_u32x4(&slice[0..16]);
            let trans = read_u32x4(&slice[16..32]);
            let scale = read_u32x4(&slice[32..48]);
            self.init_joint_hot_frame(
                joint_idx,
                &rot.map(|k| k as usize),
                &trans.map(|k| k as usize),
                &scale.map(|k| k as usize),
            );
        }
    }

    fn init_joint_hot_frame(
        &mut self,
        joint_idx: usize,
        rotation_keys: &[usize; 4],
        translation_keys: &[usize; 4],
        scale_keys: &[usize; 4],
    ) {
        let mut hot = JointHotFrame::default();

        for (i, &frame_idx) in rotation_keys.iter().enumerate() {
            self.cursor = self.cursor.max(frame_idx);
            if let Some(frame) = self.animation.frames.get(frame_idx) {
                hot.rotation[i] = QuaternionHotFrame {
                    time: frame.time(),
                    value: decompress_quat_u16(&frame.value()),
                };
            }
        }
        for (i, &frame_idx) in translation_keys.iter().enumerate() {
            self.cursor = self.cursor.max(frame_idx);
            if let Some(frame) = self.animation.frames.get(frame_idx) {
                hot.translation[i] = VectorHotFrame {
                    time: frame.time(),
                    value: decompress_vector3(
                        &frame.value(),
                        self.animation.translation_min,
                        self.animation.translation_max,
                    ),
                };
            }
        }
        for (i, &frame_idx) in scale_keys.iter().enumerate() {
            self.cursor = self.cursor.max(frame_idx);
            if let Some(frame) = self.animation.frames.get(frame_idx) {
                hot.scale[i] = VectorHotFrame {
                    time: frame.time(),
                    value: decompress_vector3(
                        &frame.value(),
                        self.animation.scale_min,
                        self.animation.scale_max,
                    ),
                };
            }
        }

        // Quaternion shortest-path negation. Without this, slerp can
        // walk the long way around the sphere and produce visibly
        // wrong intermediate rotations.
        for i in 1..4 {
            if hot.rotation[i].value.dot(hot.rotation[0].value) < 0.0 {
                hot.rotation[i].value = -hot.rotation[i].value;
            }
        }

        self.hot_frames[joint_idx] = hot;
    }

    fn advance_cursor(&mut self, compressed_time: u16) {
        while self.cursor < self.animation.frames.len() {
            let frame = self.animation.frames[self.cursor];
            let joint_idx = frame.joint_id() as usize;
            if joint_idx >= self.animation.joint_count {
                // Out-of-range joint id — advance past the frame so we
                // don't loop forever; treat as a no-op.
                self.cursor += 1;
                continue;
            }
            let Some(transform_type) = frame.transform_type() else {
                self.cursor += 1;
                continue;
            };

            let hot = &self.hot_frames[joint_idx];
            let needs_update = match transform_type {
                TransformType::Rotation => compressed_time >= hot.rotation[2].time,
                TransformType::Translation => compressed_time >= hot.translation[2].time,
                TransformType::Scale => compressed_time >= hot.scale[2].time,
            };
            if !needs_update {
                break;
            }

            match transform_type {
                TransformType::Rotation => {
                    self.fetch_rotation_frame(joint_idx, frame.time(), &frame.value());
                }
                TransformType::Translation => {
                    self.fetch_translation_frame(joint_idx, frame.time(), &frame.value());
                }
                TransformType::Scale => {
                    self.fetch_scale_frame(joint_idx, frame.time(), &frame.value());
                }
            }

            self.cursor += 1;
        }
    }

    fn fetch_rotation_frame(&mut self, joint_idx: usize, time: u16, value: &[u16; 3]) {
        let hot = &mut self.hot_frames[joint_idx];
        hot.rotation[0] = hot.rotation[1];
        hot.rotation[1] = hot.rotation[2];
        hot.rotation[2] = hot.rotation[3];
        hot.rotation[3] = QuaternionHotFrame {
            time,
            value: decompress_quat_u16(value),
        };
        for i in 1..4 {
            if hot.rotation[i].value.dot(hot.rotation[0].value) < 0.0 {
                hot.rotation[i].value = -hot.rotation[i].value;
            }
        }
    }

    fn fetch_translation_frame(&mut self, joint_idx: usize, time: u16, value: &[u16; 3]) {
        let hot = &mut self.hot_frames[joint_idx];
        hot.translation[0] = hot.translation[1];
        hot.translation[1] = hot.translation[2];
        hot.translation[2] = hot.translation[3];
        hot.translation[3] = VectorHotFrame {
            time,
            value: decompress_vector3(
                value,
                self.animation.translation_min,
                self.animation.translation_max,
            ),
        };
    }

    fn fetch_scale_frame(&mut self, joint_idx: usize, time: u16, value: &[u16; 3]) {
        let hot = &mut self.hot_frames[joint_idx];
        hot.scale[0] = hot.scale[1];
        hot.scale[1] = hot.scale[2];
        hot.scale[2] = hot.scale[3];
        hot.scale[3] = VectorHotFrame {
            time,
            value: decompress_vector3(value, self.animation.scale_min, self.animation.scale_max),
        };
    }
}

fn read_u16x4(b: &[u8]) -> [u16; 4] {
    [
        u16::from_le_bytes([b[0], b[1]]),
        u16::from_le_bytes([b[2], b[3]]),
        u16::from_le_bytes([b[4], b[5]]),
        u16::from_le_bytes([b[6], b[7]]),
    ]
}

fn read_u32x4(b: &[u8]) -> [u32; 4] {
    [
        u32::from_le_bytes([b[0], b[1], b[2], b[3]]),
        u32::from_le_bytes([b[4], b[5], b[6], b[7]]),
        u32::from_le_bytes([b[8], b[9], b[10], b[11]]),
        u32::from_le_bytes([b[12], b[13], b[14], b[15]]),
    ]
}
