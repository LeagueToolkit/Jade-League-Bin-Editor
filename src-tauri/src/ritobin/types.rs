use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum BinType {
    None = 0,
    Bool = 1,
    I8 = 2,
    U8 = 3,
    I16 = 4,
    U16 = 5,
    I32 = 6,
    U32 = 7,
    I64 = 8,
    U64 = 9,
    F32 = 10,
    Vec2 = 11,
    Vec3 = 12,
    Vec4 = 13,
    Mtx44 = 14,
    Rgba = 15,
    String = 16,
    Hash = 17,
    File = 18,
    List = 0x80 | 0,
    List2 = 0x80 | 1,
    Pointer = 0x80 | 2,
    Embed = 0x80 | 3,
    Link = 0x80 | 4,
    Option = 0x80 | 5,
    Map = 0x80 | 6,
    Flag = 0x80 | 7,
}

impl From<u8> for BinType {
    fn from(val: u8) -> Self {
        match val {
            0 => BinType::None,
            1 => BinType::Bool,
            2 => BinType::I8,
            3 => BinType::U8,
            4 => BinType::I16,
            5 => BinType::U16,
            6 => BinType::I32,
            7 => BinType::U32,
            8 => BinType::I64,
            9 => BinType::U64,
            10 => BinType::F32,
            11 => BinType::Vec2,
            12 => BinType::Vec3,
            13 => BinType::Vec4,
            14 => BinType::Mtx44,
            15 => BinType::Rgba,
            16 => BinType::String,
            17 => BinType::Hash,
            18 => BinType::File,
            0x80 => BinType::List,
            0x81 => BinType::List2,
            0x82 => BinType::Pointer,
            0x83 => BinType::Embed,
            0x84 => BinType::Link,
            0x85 => BinType::Option,
            0x86 => BinType::Map,
            0x87 => BinType::Flag,
            _ => BinType::None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FNV1a {
    pub hash: u32,
    pub string: Option<String>,
}

impl FNV1a {
    pub fn new(hash: u32) -> Self {
        Self { hash, string: None }
    }

    pub fn from_string(s: &str) -> Self {
        Self {
            hash: Self::calculate(s),
            string: Some(s.to_string()),
        }
    }

    pub fn calculate(text: &str) -> u32 {
        let mut hash = 0x811c9dc5u32;
        for c in text.to_lowercase().bytes() {
            hash ^= c as u32;
            hash = hash.wrapping_mul(0x01000193);
        }
        hash
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct XXH64 {
    pub hash: u64,
    pub string: Option<String>,
}

impl XXH64 {
    pub fn new(hash: u64) -> Self {
        Self { hash, string: None }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BinValue {
    None,
    Bool(bool),
    I8(i8),
    U8(u8),
    I16(i16),
    U16(u16),
    I32(i32),
    U32(u32),
    I64(i64),
    U64(u64),
    F32(f32),
    Vec2(f32, f32),
    Vec3(f32, f32, f32),
    Vec4(f32, f32, f32, f32),
    Mtx44(Box<[f32; 16]>),
    Rgba(u8, u8, u8, u8),
    String(String),
    Hash(FNV1a),
    File(XXH64),
    List(BinType, Vec<BinValue>),
    List2(BinType, Vec<BinValue>),
    Pointer(FNV1a, Vec<BinField>),
    Embed(FNV1a, Vec<BinField>),
    Link(FNV1a),
    Option(BinType, Vec<BinValue>),
    Map(BinType, BinType, Vec<(BinValue, BinValue)>),
    Flag(bool),
}

impl BinValue {
    pub fn get_type(&self) -> BinType {
        match self {
            BinValue::None => BinType::None,
            BinValue::Bool(_) => BinType::Bool,
            BinValue::I8(_) => BinType::I8,
            BinValue::U8(_) => BinType::U8,
            BinValue::I16(_) => BinType::I16,
            BinValue::U16(_) => BinType::U16,
            BinValue::I32(_) => BinType::I32,
            BinValue::U32(_) => BinType::U32,
            BinValue::I64(_) => BinType::I64,
            BinValue::U64(_) => BinType::U64,
            BinValue::F32(_) => BinType::F32,
            BinValue::Vec2(_, _) => BinType::Vec2,
            BinValue::Vec3(_, _, _) => BinType::Vec3,
            BinValue::Vec4(_, _, _, _) => BinType::Vec4,
            BinValue::Mtx44(_) => BinType::Mtx44,
            BinValue::Rgba(_, _, _, _) => BinType::Rgba,
            BinValue::String(_) => BinType::String,
            BinValue::Hash(_) => BinType::Hash,
            BinValue::File(_) => BinType::File,
            BinValue::List(_, _) => BinType::List,
            BinValue::List2(_, _) => BinType::List2,
            BinValue::Pointer(_, _) => BinType::Pointer,
            BinValue::Embed(_, _) => BinType::Embed,
            BinValue::Link(_) => BinType::Link,
            BinValue::Option(_, _) => BinType::Option,
            BinValue::Map(_, _, _) => BinType::Map,
            BinValue::Flag(_) => BinType::Flag,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinField {
    pub key: FNV1a,
    pub value: BinValue,
}

#[derive(Debug, Clone)]
pub struct Bin {
    pub sections: HashMap<String, BinValue>,
}

impl Bin {
    pub fn new() -> Self {
        Self {
            sections: HashMap::new(),
        }
    }
}
