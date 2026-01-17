use std::io::{Write, Cursor};
use byteorder::{WriteBytesExt, LittleEndian};
use super::types::*;

pub struct BinWriter {
    // We might need to keep track of strings for pools, but Ritobin v2+ usually writes them inline
}

impl BinWriter {
    pub fn new() -> Self {
        Self {}
    }

    pub fn write(&self, bin: &Bin) -> Result<Vec<u8>, String> {
        let mut data = Vec::with_capacity(65536);
        let mut writer = Cursor::new(&mut data);

        let bin_type = bin.sections.get("type").and_then(|v| {
            if let BinValue::String(s) = v { Some(s.as_str()) } else { None }
        }).unwrap_or("PROP");

        if bin_type == "PTCH" {
            writer.write_all(b"PTCH").map_err(|e| e.to_string())?;
            writer.write_u64::<LittleEndian>(0).map_err(|e| e.to_string())?; // Placeholder for unk
            writer.write_all(b"PROP").map_err(|e| e.to_string())?;
        } else {
            writer.write_all(b"PROP").map_err(|e| e.to_string())?;
        }

        let version = bin.sections.get("version").and_then(|v| {
            if let BinValue::U32(u) = v { Some(*u) } else { None }
        }).unwrap_or(2);
        writer.write_u32::<LittleEndian>(version).map_err(|e| e.to_string())?;

        if version >= 2 {
            self.write_linked(&mut writer, bin)?;
        }

        self.write_entries(&mut writer, bin)?;

        if bin_type == "PTCH" {
            self.write_patches(&mut writer, bin)?;
        }

        Ok(data)
    }

    fn write_linked(&self, writer: &mut Cursor<&mut Vec<u8>>, bin: &Bin) -> Result<(), String> {
        let linked = bin.sections.get("linked");
        if let Some(BinValue::List(_, items)) = linked {
            writer.write_u32::<LittleEndian>(items.len() as u32).map_err(|e| e.to_string())?;
            for item in items {
                if let BinValue::String(s) = item {
                    self.write_string(writer, s)?;
                }
            }
        } else {
            writer.write_u32::<LittleEndian>(0).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn write_entries(&self, writer: &mut Cursor<&mut Vec<u8>>, bin: &Bin) -> Result<(), String> {
        let entries_val = bin.sections.get("entries");
        if let Some(BinValue::Map(_, _, items)) = entries_val {
            writer.write_u32::<LittleEndian>(items.len() as u32).map_err(|e| e.to_string())?;
            
            // First pass: Entry name hashes
            for (_, val) in items {
                if let BinValue::Embed(name, _) = val {
                    writer.write_u32::<LittleEndian>(name.hash).map_err(|e| e.to_string())?;
                } else {
                    return Err("Invalid entry value type".to_string());
                }
            }
            
            // Second pass: Entry data
            for (key, val) in items {
                if let (BinValue::Hash(k), BinValue::Embed(_, fields)) = (key, val) {
                    self.write_entry(writer, k, fields)?;
                }
            }
        } else {
            writer.write_u32::<LittleEndian>(0).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn write_entry(&self, writer: &mut Cursor<&mut Vec<u8>>, key: &FNV1a, fields: &Vec<BinField>) -> Result<(), String> {
        // We need to know the length beforehand. Write to a temporary buffer.
        let mut entry_data = Vec::new();
        let mut entry_writer = Cursor::new(&mut entry_data);
        
        entry_writer.write_u32::<LittleEndian>(key.hash).map_err(|e| e.to_string())?;
        entry_writer.write_u16::<LittleEndian>(fields.len() as u16).map_err(|e| e.to_string())?;
        
        for field in fields {
            entry_writer.write_u32::<LittleEndian>(field.key.hash).map_err(|e| e.to_string())?;
            entry_writer.write_u8(field.value.get_type() as u8).map_err(|e| e.to_string())?;
            self.write_value(&mut entry_writer, &field.value)?;
        }
        
        writer.write_u32::<LittleEndian>(entry_data.len() as u32).map_err(|e| e.to_string())?;
        writer.write_all(&entry_data).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn write_patches(&self, writer: &mut Cursor<&mut Vec<u8>>, bin: &Bin) -> Result<(), String> {
        let patches_val = bin.sections.get("patches");
        if let Some(BinValue::Map(_, _, items)) = patches_val {
            writer.write_u32::<LittleEndian>(items.len() as u32).map_err(|e| e.to_string())?;
            for (key, val) in items {
                if let (BinValue::Hash(k), BinValue::Embed(_, fields)) = (key, val) {
                    self.write_patch(writer, k, fields)?;
                }
            }
        } else {
            writer.write_u32::<LittleEndian>(0).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn write_patch(&self, writer: &mut Cursor<&mut Vec<u8>>, key: &FNV1a, fields: &Vec<BinField>) -> Result<(), String> {
        writer.write_u32::<LittleEndian>(key.hash).map_err(|e| e.to_string())?;
        
        let path = fields.iter().find(|f| f.key.string.as_deref() == Some("path"))
            .and_then(|f| if let BinValue::String(s) = &f.value { Some(s) } else { None })
            .ok_or("Patch missing path")?;
        
        let val = fields.iter().find(|f| f.key.string.as_deref() == Some("value"))
            .map(|f| &f.value)
            .ok_or("Patch missing value")?;

        let mut patch_data = Vec::new();
        let mut patch_writer = Cursor::new(&mut patch_data);
        
        patch_writer.write_u8(val.get_type() as u8).map_err(|e| e.to_string())?;
        self.write_string(&mut patch_writer, path)?;
        self.write_value(&mut patch_writer, val)?;
        
        writer.write_u32::<LittleEndian>(patch_data.len() as u32).map_err(|e| e.to_string())?;
        writer.write_all(&patch_data).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn write_value(&self, writer: &mut Cursor<&mut Vec<u8>>, value: &BinValue) -> Result<(), String> {
        match value {
            BinValue::None => Ok(()),
            BinValue::Bool(b) => writer.write_u8(if *b { 1 } else { 0 }).map_err(|e| e.to_string()),
            BinValue::I8(v) => writer.write_i8(*v).map_err(|e| e.to_string()),
            BinValue::U8(v) => writer.write_u8(*v).map_err(|e| e.to_string()),
            BinValue::I16(v) => writer.write_i16::<LittleEndian>(*v).map_err(|e| e.to_string()),
            BinValue::U16(v) => writer.write_u16::<LittleEndian>(*v).map_err(|e| e.to_string()),
            BinValue::I32(v) => writer.write_i32::<LittleEndian>(*v).map_err(|e| e.to_string()),
            BinValue::U32(v) => writer.write_u32::<LittleEndian>(*v).map_err(|e| e.to_string()),
            BinValue::I64(v) => writer.write_i64::<LittleEndian>(*v).map_err(|e| e.to_string()),
            BinValue::U64(v) => writer.write_u64::<LittleEndian>(*v).map_err(|e| e.to_string()),
            BinValue::F32(v) => writer.write_f32::<LittleEndian>(*v).map_err(|e| e.to_string()),
            BinValue::Vec2(x, y) => {
                writer.write_f32::<LittleEndian>(*x).map_err(|e| e.to_string())?;
                writer.write_f32::<LittleEndian>(*y).map_err(|e| e.to_string())
            }
            BinValue::Vec3(x, y, z) => {
                writer.write_f32::<LittleEndian>(*x).map_err(|e| e.to_string())?;
                writer.write_f32::<LittleEndian>(*y).map_err(|e| e.to_string())?;
                writer.write_f32::<LittleEndian>(*z).map_err(|e| e.to_string())
            }
            BinValue::Vec4(x, y, z, w) => {
                writer.write_f32::<LittleEndian>(*x).map_err(|e| e.to_string())?;
                writer.write_f32::<LittleEndian>(*y).map_err(|e| e.to_string())?;
                writer.write_f32::<LittleEndian>(*z).map_err(|e| e.to_string())?;
                writer.write_f32::<LittleEndian>(*w).map_err(|e| e.to_string())
            }
            BinValue::Mtx44(m) => {
                for i in 0..16 {
                    writer.write_f32::<LittleEndian>(m[i]).map_err(|e| e.to_string())?;
                }
                Ok(())
            }
            BinValue::Rgba(r, g, b, a) => {
                writer.write_u8(*r).map_err(|e| e.to_string())?;
                writer.write_u8(*g).map_err(|e| e.to_string())?;
                writer.write_u8(*b).map_err(|e| e.to_string())?;
                writer.write_u8(*a).map_err(|e| e.to_string())
            }
            BinValue::String(s) => self.write_string(writer, s),
            BinValue::Hash(h) | BinValue::Link(h) => writer.write_u32::<LittleEndian>(h.hash).map_err(|e| e.to_string()),
            BinValue::File(f) => writer.write_u64::<LittleEndian>(f.hash).map_err(|e| e.to_string()),
            
            BinValue::List(t, items) | BinValue::List2(t, items) => {
                writer.write_u8(*t as u8).map_err(|e| e.to_string())?;
                let mut list_data = Vec::new();
                let mut list_writer = Cursor::new(&mut list_data);
                list_writer.write_u32::<LittleEndian>(items.len() as u32).map_err(|e| e.to_string())?;
                for item in items {
                    self.write_value(&mut list_writer, item)?;
                }
                writer.write_u32::<LittleEndian>(list_data.len() as u32).map_err(|e| e.to_string())?;
                writer.write_all(&list_data).map_err(|e| e.to_string())
            }
            
            BinValue::Option(t, items) => {
                writer.write_u8(*t as u8).map_err(|e| e.to_string())?;
                writer.write_u8(items.len() as u8).map_err(|e| e.to_string())?;
                if let Some(item) = items.first() {
                    self.write_value(writer, item)?;
                }
                Ok(())
            }
            
            BinValue::Map(kt, vt, items) => {
                writer.write_u8(*kt as u8).map_err(|e| e.to_string())?;
                writer.write_u8(*vt as u8).map_err(|e| e.to_string())?;
                let mut map_data = Vec::new();
                let mut map_writer = Cursor::new(&mut map_data);
                map_writer.write_u32::<LittleEndian>(items.len() as u32).map_err(|e| e.to_string())?;
                for (k, v) in items {
                    self.write_value(&mut map_writer, k)?;
                    self.write_value(&mut map_writer, v)?;
                }
                writer.write_u32::<LittleEndian>(map_data.len() as u32).map_err(|e| e.to_string())?;
                writer.write_all(&map_data).map_err(|e| e.to_string())
            }
            
            BinValue::Pointer(name, fields) => {
                writer.write_u32::<LittleEndian>(name.hash).map_err(|e| e.to_string())?;
                if name.hash == 0 { return Ok(()); }
                
                let mut ptr_data = Vec::new();
                let mut ptr_writer = Cursor::new(&mut ptr_data);
                ptr_writer.write_u16::<LittleEndian>(fields.len() as u16).map_err(|e| e.to_string())?;
                for field in fields {
                    ptr_writer.write_u32::<LittleEndian>(field.key.hash).map_err(|e| e.to_string())?;
                    ptr_writer.write_u8(field.value.get_type() as u8).map_err(|e| e.to_string())?;
                    self.write_value(&mut ptr_writer, &field.value)?;
                }
                writer.write_u32::<LittleEndian>(ptr_data.len() as u32).map_err(|e| e.to_string())?;
                writer.write_all(&ptr_data).map_err(|e| e.to_string())
            }

            BinValue::Embed(name, fields) => {
                writer.write_u32::<LittleEndian>(name.hash).map_err(|e| e.to_string())?;
                let mut embed_data = Vec::new();
                let mut embed_writer = Cursor::new(&mut embed_data);
                embed_writer.write_u16::<LittleEndian>(fields.len() as u16).map_err(|e| e.to_string())?;
                for field in fields {
                    embed_writer.write_u32::<LittleEndian>(field.key.hash).map_err(|e| e.to_string())?;
                    embed_writer.write_u8(field.value.get_type() as u8).map_err(|e| e.to_string())?;
                    self.write_value(&mut embed_writer, &field.value)?;
                }
                writer.write_u32::<LittleEndian>(embed_data.len() as u32).map_err(|e| e.to_string())?;
                writer.write_all(&embed_data).map_err(|e| e.to_string())
            }

            BinValue::Flag(b) => writer.write_u8(if *b { 1 } else { 0 }).map_err(|e| e.to_string()),
        }
    }

    fn write_string(&self, writer: &mut Cursor<&mut Vec<u8>>, s: &str) -> Result<(), String> {
        let bytes = s.as_bytes();
        writer.write_u16::<LittleEndian>(bytes.len() as u16).map_err(|e| e.to_string())?;
        writer.write_all(bytes).map_err(|e| e.to_string())
    }
}
