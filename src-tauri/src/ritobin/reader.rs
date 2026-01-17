use std::io::{Cursor, Read};
use byteorder::{ReadBytesExt, LittleEndian};
use super::types::*;

pub struct BinReader<'a> {
    data: Cursor<&'a [u8]>,
}

impl<'a> BinReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self {
            data: Cursor::new(data),
        }
    }

    pub fn read(&mut self) -> Result<Bin, String> {
        let mut bin = Bin::new();
        self.read_sections(&mut bin)?;
        Ok(bin)
    }

    fn read_sections(&mut self, bin: &mut Bin) -> Result<(), String> {
        let mut magic = [0u8; 4];
        self.data.read_exact(&mut magic).map_err(|e| e.to_string())?;
        
        let mut is_patch = false;
        if &magic == b"PTCH" {
            let _unk = self.data.read_u64::<LittleEndian>().map_err(|e| e.to_string())?;
            self.data.read_exact(&mut magic).map_err(|e| e.to_string())?;
            bin.sections.insert("type".to_string(), BinValue::String("PTCH".to_string()));
            is_patch = true;
        } else {
            bin.sections.insert("type".to_string(), BinValue::String("PROP".to_string()));
        }

        if &magic != b"PROP" {
            return Err(format!("Invalid magic: expected PROP, found {:?}", magic));
        }

        let version = self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?;
        bin.sections.insert("version".to_string(), BinValue::U32(version));

        if version >= 2 {
            self.read_linked(bin)?;
        }

        self.read_entries(bin)?;

        if is_patch {
            self.read_patches(bin)?;
        }

        Ok(())
    }

    fn read_linked(&mut self, bin: &mut Bin) -> Result<(), String> {
        let count = self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?;
        let mut list = Vec::new();
        for _ in 0..count {
            list.push(BinValue::String(self.read_string()?));
        }
        bin.sections.insert("linked".to_string(), BinValue::List(BinType::String, list));
        Ok(())
    }

    fn read_entries(&mut self, bin: &mut Bin) -> Result<(), String> {
        let count = self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?;
        let mut entry_name_hashes = Vec::new();
        for _ in 0..count {
            entry_name_hashes.push(self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?);
        }

        let mut entries = Vec::new();
        for hash in entry_name_hashes {
            let (key, mut value) = self.read_entry()?;
            if let BinValue::Embed(ref mut name, _) = value {
                name.hash = hash;
            }
            entries.push((BinValue::Hash(key), value));
        }
        bin.sections.insert("entries".to_string(), BinValue::Map(BinType::Hash, BinType::Embed, entries));
        Ok(())
    }

    fn read_entry(&mut self) -> Result<(FNV1a, BinValue), String> {
        let length = self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?;
        let start_pos = self.data.position();

        let entry_key_hash = FNV1a::new(self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?);
        let count = self.data.read_u16::<LittleEndian>().map_err(|e| e.to_string())?;

        let mut fields = Vec::new();
        for _ in 0..count {
            let name = FNV1a::new(self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?);
            let type_byte = self.data.read_u8().map_err(|e| e.to_string())?;
            let value = self.read_value(BinType::from(type_byte))?;
            fields.push(BinField { key: name, value });
        }

        if self.data.position() != start_pos + length as u64 {
            return Err("Entry length mismatch".to_string());
        }

        Ok((entry_key_hash, BinValue::Embed(FNV1a::new(0), fields))) // Embed name hash is not used for entries
    }

    fn read_patches(&mut self, bin: &mut Bin) -> Result<(), String> {
        let count = self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?;
        let mut patches = Vec::new();
        for _ in 0..count {
            let (key, value) = self.read_patch()?;
            patches.push((BinValue::Hash(key), value));
        }
        bin.sections.insert("patches".to_string(), BinValue::Map(BinType::Hash, BinType::Embed, patches));
        Ok(())
    }

    fn read_patch(&mut self) -> Result<(FNV1a, BinValue), String> {
        let key_hash = FNV1a::new(self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?);
        let length = self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?;
        let start_pos = self.data.position();

        let type_byte = self.data.read_u8().map_err(|e| e.to_string())?;
        let path = self.read_string()?;
        let value = self.read_value(BinType::from(type_byte))?;

        if self.data.position() != start_pos + length as u64 {
            return Err("Patch length mismatch".to_string());
        }

        let fields = vec![
            BinField { key: FNV1a::from_string("path"), value: BinValue::String(path) },
            BinField { key: FNV1a::from_string("value"), value },
        ];

        Ok((key_hash, BinValue::Embed(FNV1a::from_string("patch"), fields)))
    }

    fn read_value(&mut self, val_type: BinType) -> Result<BinValue, String> {
        match val_type {
            BinType::None => Ok(BinValue::None),
            BinType::Bool => Ok(BinValue::Bool(self.data.read_u8().map_err(|e| e.to_string())? != 0)),
            BinType::I8 => Ok(BinValue::I8(self.data.read_i8().map_err(|e| e.to_string())?)),
            BinType::U8 => Ok(BinValue::U8(self.data.read_u8().map_err(|e| e.to_string())?)),
            BinType::I16 => Ok(BinValue::I16(self.data.read_i16::<LittleEndian>().map_err(|e| e.to_string())?)),
            BinType::U16 => Ok(BinValue::U16(self.data.read_u16::<LittleEndian>().map_err(|e| e.to_string())?)),
            BinType::I32 => Ok(BinValue::I32(self.data.read_i32::<LittleEndian>().map_err(|e| e.to_string())?)),
            BinType::U32 => Ok(BinValue::U32(self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?)),
            BinType::I64 => Ok(BinValue::I64(self.data.read_i64::<LittleEndian>().map_err(|e| e.to_string())?)),
            BinType::U64 => Ok(BinValue::U64(self.data.read_u64::<LittleEndian>().map_err(|e| e.to_string())?)),
            BinType::F32 => Ok(BinValue::F32(self.data.read_f32::<LittleEndian>().map_err(|e| e.to_string())?)),
            BinType::Vec2 => Ok(BinValue::Vec2(
                self.data.read_f32::<LittleEndian>().map_err(|e| e.to_string())?,
                self.data.read_f32::<LittleEndian>().map_err(|e| e.to_string())?,
            )),
            BinType::Vec3 => Ok(BinValue::Vec3(
                self.data.read_f32::<LittleEndian>().map_err(|e| e.to_string())?,
                self.data.read_f32::<LittleEndian>().map_err(|e| e.to_string())?,
                self.data.read_f32::<LittleEndian>().map_err(|e| e.to_string())?,
            )),
            BinType::Vec4 => Ok(BinValue::Vec4(
                self.data.read_f32::<LittleEndian>().map_err(|e| e.to_string())?,
                self.data.read_f32::<LittleEndian>().map_err(|e| e.to_string())?,
                self.data.read_f32::<LittleEndian>().map_err(|e| e.to_string())?,
                self.data.read_f32::<LittleEndian>().map_err(|e| e.to_string())?,
            )),
            BinType::Mtx44 => {
                let mut m = [0f32; 16];
                for i in 0..16 {
                    m[i] = self.data.read_f32::<LittleEndian>().map_err(|e| e.to_string())?;
                }
                Ok(BinValue::Mtx44(Box::new(m)))
            }
            BinType::Rgba => Ok(BinValue::Rgba(
                self.data.read_u8().map_err(|e| e.to_string())?,
                self.data.read_u8().map_err(|e| e.to_string())?,
                self.data.read_u8().map_err(|e| e.to_string())?,
                self.data.read_u8().map_err(|e| e.to_string())?,
            )),
            BinType::String => Ok(BinValue::String(self.read_string()?)),
            BinType::Hash => Ok(BinValue::Hash(FNV1a::new(self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?))),
            BinType::File => Ok(BinValue::File(XXH64::new(self.data.read_u64::<LittleEndian>().map_err(|e| e.to_string())?))),
            
            BinType::List | BinType::List2 => {
                let element_type = BinType::from(self.data.read_u8().map_err(|e| e.to_string())?);
                let size = self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?;
                let start_pos = self.data.position();
                let count = self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?;
                
                let mut list = Vec::new();
                for _ in 0..count {
                    list.push(self.read_value(element_type)?);
                }
                
                if self.data.position() != start_pos + size as u64 {
                    return Err(format!("List size mismatch: expected {}, got {}", size, self.data.position() - start_pos));
                }
                
                if val_type == BinType::List {
                    Ok(BinValue::List(element_type, list))
                } else {
                    Ok(BinValue::List2(element_type, list))
                }
            }

            BinType::Pointer => {
                let name = FNV1a::new(self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?);
                if name.hash == 0 {
                    return Ok(BinValue::Pointer(name, Vec::new()));
                }
                
                let size = self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?;
                let start_pos = self.data.position();
                let count = self.data.read_u16::<LittleEndian>().map_err(|e| e.to_string())?;
                
                let mut fields = Vec::new();
                for _ in 0..count {
                    let field_name = FNV1a::new(self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?);
                    let field_type = BinType::from(self.data.read_u8().map_err(|e| e.to_string())?);
                    fields.push(BinField { key: field_name, value: self.read_value(field_type)? });
                }
                
                if self.data.position() != start_pos + size as u64 {
                    return Err("Pointer size mismatch".to_string());
                }
                Ok(BinValue::Pointer(name, fields))
            }

            BinType::Embed => {
                let name = FNV1a::new(self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?);
                let size = self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?;
                let start_pos = self.data.position();
                let count = self.data.read_u16::<LittleEndian>().map_err(|e| e.to_string())?;
                
                let mut fields = Vec::new();
                for _ in 0..count {
                    let field_name = FNV1a::new(self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?);
                    let field_type = BinType::from(self.data.read_u8().map_err(|e| e.to_string())?);
                    fields.push(BinField { key: field_name, value: self.read_value(field_type)? });
                }
                
                if self.data.position() != start_pos + size as u64 {
                    return Err("Embed size mismatch".to_string());
                }
                Ok(BinValue::Embed(name, fields))
            }

            BinType::Link => Ok(BinValue::Link(FNV1a::new(self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?))),

            BinType::Option => {
                let element_type = BinType::from(self.data.read_u8().map_err(|e| e.to_string())?);
                let count = self.data.read_u8().map_err(|e| e.to_string())?;
                let mut items = Vec::new();
                if count != 0 {
                    items.push(self.read_value(element_type)?);
                }
                Ok(BinValue::Option(element_type, items))
            }

            BinType::Map => {
                let key_type = BinType::from(self.data.read_u8().map_err(|e| e.to_string())?);
                let val_type = BinType::from(self.data.read_u8().map_err(|e| e.to_string())?);
                let size = self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?;
                let start_pos = self.data.position();
                let count = self.data.read_u32::<LittleEndian>().map_err(|e| e.to_string())?;
                
                let mut map = Vec::new();
                for _ in 0..count {
                    let key = self.read_value(key_type)?;
                    let value = self.read_value(val_type)?;
                    map.push((key, value));
                }
                
                if self.data.position() != start_pos + size as u64 {
                    return Err("Map size mismatch".to_string());
                }
                Ok(BinValue::Map(key_type, val_type, map))
            }

            BinType::Flag => Ok(BinValue::Flag(self.data.read_u8().map_err(|e| e.to_string())? != 0)),
        }
    }

    fn read_string(&mut self) -> Result<String, String> {
        let length = self.data.read_u16::<LittleEndian>().map_err(|e| e.to_string())?;
        let mut bytes = vec![0u8; length as usize];
        self.data.read_exact(&mut bytes).map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&bytes).to_string())
    }
}
