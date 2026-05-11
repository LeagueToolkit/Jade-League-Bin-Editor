//! Frame struct + TransformType enum for compressed ANM.
//!
//! Each frame on disk is 10 bytes: u16 time, u16 joint_id (low 14 bits =
//! id, high 2 bits = transform type), [u16; 3] value (interpretation
//! depends on the transform type — vec3 quantization for translation/
//! scale, packed quaternion for rotation).

#[derive(Clone, Copy, Debug)]
pub struct Frame {
    pub time: u16,
    pub joint_id_raw: u16,
    pub value: [u16; 3],
}

impl Frame {
    pub fn time(&self) -> u16 {
        self.time
    }
    pub fn value(&self) -> [u16; 3] {
        self.value
    }
    pub fn joint_id(&self) -> u16 {
        self.joint_id_raw & 0x3fff
    }
    pub fn transform_type(&self) -> Option<TransformType> {
        match self.joint_id_raw >> 14 {
            0 => Some(TransformType::Rotation),
            1 => Some(TransformType::Translation),
            2 => Some(TransformType::Scale),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransformType {
    Rotation = 0,
    Translation = 1,
    Scale = 2,
}
