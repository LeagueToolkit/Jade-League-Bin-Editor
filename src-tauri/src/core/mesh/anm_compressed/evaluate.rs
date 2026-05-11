//! Pure interpolation primitives for compressed ANM evaluation.
//!
//! Time and vector quantization are linear; quaternions reuse the v5
//! 6-byte packed format from `super::super::anm::decompress_quat`.
//!
//! Catmull-Rom is implemented in two flavours: uniform (fixed
//! `tau = 0.5`) and parametrized (tau derived from frame timing).
//! Riot picks one per clip via the `UseKeyframeParametrization` flag.

use glam::{Quat, Vec3};

use super::super::anm::decompress_quat;

#[allow(dead_code)] // symmetric with compress_time; kept for tests + future seek UIs.
pub fn decompress_time(compressed_time: u16, duration: f32) -> f32 {
    (compressed_time as f32 / u16::MAX as f32) * duration
}

pub fn compress_time(time: f32, duration: f32) -> u16 {
    if duration <= 0.0 {
        return 0;
    }
    let scaled = (time / duration) * u16::MAX as f32;
    if scaled <= 0.0 {
        0
    } else if scaled >= u16::MAX as f32 {
        u16::MAX
    } else {
        scaled as u16
    }
}

pub fn decompress_vector3(value: &[u16; 3], min: Vec3, max: Vec3) -> Vec3 {
    let scale = max - min;
    Vec3::new(
        (value[0] as f32 / u16::MAX as f32) * scale.x + min.x,
        (value[1] as f32 / u16::MAX as f32) * scale.y + min.y,
        (value[2] as f32 / u16::MAX as f32) * scale.z + min.z,
    )
}

/// 3 × u16 → 6 bytes → 4-component quat. The byte order matches what
/// `decompress_quat` expects (little-endian field reads when packing
/// into the u64).
pub fn decompress_quat_u16(value: &[u16; 3]) -> Quat {
    let bytes = [
        (value[0] & 0xff) as u8,
        ((value[0] >> 8) & 0xff) as u8,
        (value[1] & 0xff) as u8,
        ((value[1] >> 8) & 0xff) as u8,
        (value[2] & 0xff) as u8,
        ((value[2] >> 8) & 0xff) as u8,
    ];
    decompress_quat(&bytes)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct VectorHotFrame {
    pub time: u16,
    pub value: Vec3,
}

#[derive(Clone, Copy, Debug)]
pub struct QuaternionHotFrame {
    pub time: u16,
    pub value: Quat,
}

impl Default for QuaternionHotFrame {
    fn default() -> Self {
        Self {
            time: 0,
            value: Quat::IDENTITY,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct JointHotFrame {
    pub rotation: [QuaternionHotFrame; 4],
    pub translation: [VectorHotFrame; 4],
    pub scale: [VectorHotFrame; 4],
}

impl JointHotFrame {
    pub fn sample(&self, time: u16, parametrized: bool) -> (Quat, Vec3, Vec3) {
        if parametrized {
            (
                self.sample_rotation_parametrized(time),
                self.sample_translation_parametrized(time),
                self.sample_scale_parametrized(time),
            )
        } else {
            (
                self.sample_rotation_uniform(time),
                self.sample_translation_uniform(time),
                self.sample_scale_uniform(time),
            )
        }
    }

    fn sample_rotation_uniform(&self, time: u16) -> Quat {
        let t_d = self.rotation[2].time.saturating_sub(self.rotation[1].time);
        if t_d == 0 {
            return self.rotation[1].value;
        }
        let amount = time.saturating_sub(self.rotation[1].time) as f32 / t_d as f32;
        interpolate_quat_catmull(
            amount,
            0.5,
            0.5,
            self.rotation[0].value,
            self.rotation[1].value,
            self.rotation[2].value,
            self.rotation[3].value,
        )
    }

    fn sample_translation_uniform(&self, time: u16) -> Vec3 {
        let t_d = self.translation[2]
            .time
            .saturating_sub(self.translation[1].time);
        if t_d == 0 {
            return self.translation[1].value;
        }
        let amount = time.saturating_sub(self.translation[1].time) as f32 / t_d as f32;
        interpolate_vec3_catmull(
            amount,
            0.5,
            0.5,
            self.translation[0].value,
            self.translation[1].value,
            self.translation[2].value,
            self.translation[3].value,
        )
    }

    fn sample_scale_uniform(&self, time: u16) -> Vec3 {
        let t_d = self.scale[2].time.saturating_sub(self.scale[1].time);
        if t_d == 0 {
            return self.scale[1].value;
        }
        let amount = time.saturating_sub(self.scale[1].time) as f32 / t_d as f32;
        interpolate_vec3_catmull(
            amount,
            0.5,
            0.5,
            self.scale[0].value,
            self.scale[1].value,
            self.scale[2].value,
            self.scale[3].value,
        )
    }

    fn sample_rotation_parametrized(&self, time: u16) -> Quat {
        let (amount, scale_in, scale_out) = create_keyframe_weights(
            time,
            self.rotation[0].time,
            self.rotation[1].time,
            self.rotation[2].time,
            self.rotation[3].time,
        );
        interpolate_quat_catmull(
            amount,
            scale_in,
            scale_out,
            self.rotation[0].value,
            self.rotation[1].value,
            self.rotation[2].value,
            self.rotation[3].value,
        )
    }

    fn sample_translation_parametrized(&self, time: u16) -> Vec3 {
        let (amount, scale_in, scale_out) = create_keyframe_weights(
            time,
            self.translation[0].time,
            self.translation[1].time,
            self.translation[2].time,
            self.translation[3].time,
        );
        interpolate_vec3_catmull(
            amount,
            scale_in,
            scale_out,
            self.translation[0].value,
            self.translation[1].value,
            self.translation[2].value,
            self.translation[3].value,
        )
    }

    fn sample_scale_parametrized(&self, time: u16) -> Vec3 {
        let (amount, scale_in, scale_out) = create_keyframe_weights(
            time,
            self.scale[0].time,
            self.scale[1].time,
            self.scale[2].time,
            self.scale[3].time,
        );
        interpolate_vec3_catmull(
            amount,
            scale_in,
            scale_out,
            self.scale[0].value,
            self.scale[1].value,
            self.scale[2].value,
            self.scale[3].value,
        )
    }
}

const SLERP_EPSILON: f32 = 0.000001;

fn create_keyframe_weights(time: u16, t0: u16, t1: u16, t2: u16, t3: u16) -> (f32, f32, f32) {
    let t_d = t2.saturating_sub(t1) as f32;
    let amount = time.saturating_sub(t1) as f32 / (t_d + SLERP_EPSILON);
    let scale_in = t_d / (t2.saturating_sub(t0) as f32 + SLERP_EPSILON);
    let scale_out = t_d / (t3.saturating_sub(t1) as f32 + SLERP_EPSILON);
    (amount, scale_in, scale_out)
}

fn create_catmull_rom_weights(amount: f32, ease_in: f32, ease_out: f32) -> (f32, f32, f32, f32) {
    let m0 = (((2.0 - amount) * amount) - 1.0) * (amount * ease_in);
    let m1 = ((((2.0 - ease_out) * amount) + (ease_out - 3.0)) * (amount * amount)) + 1.0;
    let m2 =
        ((((3.0 - ease_in * 2.0) + ((ease_in - 2.0) * amount)) * amount) + ease_in) * amount;
    let m3 = ((amount - 1.0) * amount) * (amount * ease_out);
    (m0, m1, m2, m3)
}

fn interpolate_vec3_catmull(
    amount: f32,
    tau_in: f32,
    tau_out: f32,
    p0: Vec3,
    p1: Vec3,
    p2: Vec3,
    p3: Vec3,
) -> Vec3 {
    let (m0, m1, m2, m3) = create_catmull_rom_weights(amount, tau_in, tau_out);
    Vec3::new(
        m1 * p1.x + m0 * p0.x + m3 * p3.x + m2 * p2.x,
        m1 * p1.y + m0 * p0.y + m3 * p3.y + m2 * p2.y,
        m1 * p1.z + m0 * p0.z + m3 * p3.z + m2 * p2.z,
    )
}

fn interpolate_quat_catmull(
    amount: f32,
    tau_in: f32,
    tau_out: f32,
    p0: Quat,
    p1: Quat,
    p2: Quat,
    p3: Quat,
) -> Quat {
    let (m0, m1, m2, m3) = create_catmull_rom_weights(amount, tau_in, tau_out);
    Quat::from_xyzw(
        m1 * p1.x + m0 * p0.x + m3 * p3.x + m2 * p2.x,
        m1 * p1.y + m0 * p0.y + m3 * p3.y + m2 * p2.y,
        m1 * p1.z + m0 * p0.z + m3 * p3.z + m2 * p2.z,
        m1 * p1.w + m0 * p0.w + m3 * p3.w + m2 * p2.w,
    )
    .normalize()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_round_trip() {
        let dur = 2.5_f32;
        for t in [0.0, 0.5, 1.25, 2.5] {
            let c = compress_time(t, dur);
            let back = decompress_time(c, dur);
            // u16 quantization → roughly dur/65535 precision.
            assert!((back - t).abs() < dur / 65000.0, "t={t} back={back}");
        }
    }

    #[test]
    fn time_compress_zero_duration() {
        assert_eq!(compress_time(0.0, 0.0), 0);
        assert_eq!(compress_time(1.0, 0.0), 0);
    }

    #[test]
    fn vector3_decompresses_unit_range() {
        let min = Vec3::ZERO;
        let max = Vec3::ONE;
        let v = decompress_vector3(&[u16::MAX, u16::MAX, u16::MAX], min, max);
        assert!((v.x - 1.0).abs() < 1e-4);
        assert!((v.y - 1.0).abs() < 1e-4);
        assert!((v.z - 1.0).abs() < 1e-4);

        let v = decompress_vector3(&[0, 0, 0], min, max);
        assert!(v.x.abs() < 1e-4);
    }

    #[test]
    fn catmull_rom_uniform_midpoint_of_linear_data() {
        // Four colinear points equally spaced — Catmull-Rom at amount=0.5
        // with uniform tau=0.5 should land on the linear midpoint
        // between p1 and p2.
        let p0 = Vec3::new(0.0, 0.0, 0.0);
        let p1 = Vec3::new(1.0, 0.0, 0.0);
        let p2 = Vec3::new(2.0, 0.0, 0.0);
        let p3 = Vec3::new(3.0, 0.0, 0.0);
        let mid = interpolate_vec3_catmull(0.5, 0.5, 0.5, p0, p1, p2, p3);
        assert!((mid.x - 1.5).abs() < 1e-4, "mid={mid:?}");
    }
}
