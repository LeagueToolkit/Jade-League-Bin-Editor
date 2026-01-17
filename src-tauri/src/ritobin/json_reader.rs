use serde_json::Value;
use super::types::*;

/// Reads bin files that are in JSON format (used by some tools).
pub struct BinJsonReader {
    json: String,
}

impl BinJsonReader {
    pub fn new(json: String) -> Self {
        Self { json }
    }

    pub fn read(&self) -> Result<Bin, String> {
        let mut bin = Bin::new();
        
        let root: Value = serde_json::from_str(&self.json)
            .map_err(|e| format!("Failed to parse JSON: {}", e))?;
        
        let obj = root.as_object()
            .ok_or("Root must be an object")?;
        
        for (section_name, section_data) in obj {
            if let Some(section_obj) = section_data.as_object() {
                if let (Some(type_val), Some(value_val)) = 
                    (section_obj.get("type"), section_obj.get("value")) 
                {
                    if let Some(type_str) = type_val.as_str() {
                        let bin_type = self.parse_type_name(type_str)?;
                        let value = self.read_value(value_val, bin_type)?;
                        bin.sections.insert(section_name.clone(), value);
                    }
                }
            }
        }
        
        Ok(bin)
    }

    fn parse_type_name(&self, name: &str) -> Result<BinType, String> {
        // Handle composite types
        if name.starts_with("list[") { return Ok(BinType::List); }
        if name.starts_with("list2[") { return Ok(BinType::List2); }
        if name.starts_with("map[") { return Ok(BinType::Map); }
        if name.starts_with("option[") { return Ok(BinType::Option); }

        match name.to_lowercase().as_str() {
            "none" => Ok(BinType::None),
            "bool" => Ok(BinType::Bool),
            "i8" => Ok(BinType::I8),
            "u8" => Ok(BinType::U8),
            "i16" => Ok(BinType::I16),
            "u16" => Ok(BinType::U16),
            "i32" => Ok(BinType::I32),
            "u32" => Ok(BinType::U32),
            "i64" => Ok(BinType::I64),
            "u64" => Ok(BinType::U64),
            "f32" => Ok(BinType::F32),
            "vec2" => Ok(BinType::Vec2),
            "vec3" => Ok(BinType::Vec3),
            "vec4" => Ok(BinType::Vec4),
            "mtx44" => Ok(BinType::Mtx44),
            "rgba" => Ok(BinType::Rgba),
            "string" => Ok(BinType::String),
            "hash" => Ok(BinType::Hash),
            "file" => Ok(BinType::File),
            "link" => Ok(BinType::Link),
            "pointer" => Ok(BinType::Pointer),
            "embed" => Ok(BinType::Embed),
            "flag" => Ok(BinType::Flag),
            _ => Err(format!("Unknown type: {}", name))
        }
    }

    fn read_value(&self, element: &Value, val_type: BinType) -> Result<BinValue, String> {
        match val_type {
            BinType::None => Ok(BinValue::None),
            BinType::Bool => {
                Ok(BinValue::Bool(element.as_bool().ok_or("Expected bool")?))
            }
            BinType::I8 => {
                Ok(BinValue::I8(element.as_i64().ok_or("Expected i8")? as i8))
            }
            BinType::U8 => {
                Ok(BinValue::U8(element.as_u64().ok_or("Expected u8")? as u8))
            }
            BinType::I16 => {
                Ok(BinValue::I16(element.as_i64().ok_or("Expected i16")? as i16))
            }
            BinType::U16 => {
                Ok(BinValue::U16(element.as_u64().ok_or("Expected u16")? as u16))
            }
            BinType::I32 => {
                Ok(BinValue::I32(element.as_i64().ok_or("Expected i32")? as i32))
            }
            BinType::U32 => {
                Ok(BinValue::U32(element.as_u64().ok_or("Expected u32")? as u32))
            }
            BinType::I64 => {
                Ok(BinValue::I64(element.as_i64().ok_or("Expected i64")?))
            }
            BinType::U64 => {
                Ok(BinValue::U64(element.as_u64().ok_or("Expected u64")?))
            }
            BinType::F32 => {
                Ok(BinValue::F32(element.as_f64().ok_or("Expected f32")? as f32))
            }
            BinType::Vec2 => {
                let arr = element.as_array().ok_or("Expected array for vec2")?;
                if arr.len() < 2 { return Err("Vec2 needs 2 elements".to_string()); }
                Ok(BinValue::Vec2(
                    arr[0].as_f64().ok_or("Expected f32")? as f32,
                    arr[1].as_f64().ok_or("Expected f32")? as f32,
                ))
            }
            BinType::Vec3 => {
                let arr = element.as_array().ok_or("Expected array for vec3")?;
                if arr.len() < 3 { return Err("Vec3 needs 3 elements".to_string()); }
                Ok(BinValue::Vec3(
                    arr[0].as_f64().ok_or("Expected f32")? as f32,
                    arr[1].as_f64().ok_or("Expected f32")? as f32,
                    arr[2].as_f64().ok_or("Expected f32")? as f32,
                ))
            }
            BinType::Vec4 => {
                let arr = element.as_array().ok_or("Expected array for vec4")?;
                if arr.len() < 4 { return Err("Vec4 needs 4 elements".to_string()); }
                Ok(BinValue::Vec4(
                    arr[0].as_f64().ok_or("Expected f32")? as f32,
                    arr[1].as_f64().ok_or("Expected f32")? as f32,
                    arr[2].as_f64().ok_or("Expected f32")? as f32,
                    arr[3].as_f64().ok_or("Expected f32")? as f32,
                ))
            }
            BinType::Mtx44 => {
                let arr = element.as_array().ok_or("Expected array for mtx44")?;
                if arr.len() < 16 { return Err("Mtx44 needs 16 elements".to_string()); }
                let mut m = [0f32; 16];
                for (i, v) in arr.iter().take(16).enumerate() {
                    m[i] = v.as_f64().ok_or("Expected f32")? as f32;
                }
                Ok(BinValue::Mtx44(Box::new(m)))
            }
            BinType::Rgba => {
                let arr = element.as_array().ok_or("Expected array for rgba")?;
                if arr.len() < 4 { return Err("Rgba needs 4 elements".to_string()); }
                Ok(BinValue::Rgba(
                    arr[0].as_u64().ok_or("Expected u8")? as u8,
                    arr[1].as_u64().ok_or("Expected u8")? as u8,
                    arr[2].as_u64().ok_or("Expected u8")? as u8,
                    arr[3].as_u64().ok_or("Expected u8")? as u8,
                ))
            }
            BinType::String => {
                Ok(BinValue::String(element.as_str().ok_or("Expected string")?.to_string()))
            }
            BinType::Hash => {
                Ok(BinValue::Hash(self.parse_fnv1a(element)?))
            }
            BinType::File => {
                // Simplified - just take the string and create XXH64 with hash 0
                let s = element.as_str().unwrap_or("");
                Ok(BinValue::File(XXH64 { hash: 0, string: Some(s.to_string()) }))
            }
            BinType::Link => {
                Ok(BinValue::Link(self.parse_fnv1a(element)?))
            }
            BinType::Pointer => {
                let obj = element.as_object().ok_or("Expected object for pointer")?;
                let name = self.parse_fnv1a(obj.get("name").ok_or("Pointer needs name")?)?;
                
                if name.hash == 0 {
                    return Ok(BinValue::Pointer(name, Vec::new()));
                }
                
                let mut fields = Vec::new();
                if let Some(items) = obj.get("items").and_then(|v| v.as_array()) {
                    for field in items {
                        let field_obj = field.as_object().ok_or("Field must be object")?;
                        let key = self.parse_fnv1a(field_obj.get("key").ok_or("Field needs key")?)?;
                        let field_type_str = field_obj.get("type")
                            .and_then(|v| v.as_str())
                            .ok_or("Field needs type")?;
                        let field_type = self.parse_type_name(field_type_str)?;
                        let field_value = self.read_value(
                            field_obj.get("value").ok_or("Field needs value")?,
                            field_type
                        )?;
                        fields.push(BinField { key, value: field_value });
                    }
                }
                Ok(BinValue::Pointer(name, fields))
            }
            BinType::Embed => {
                let obj = element.as_object().ok_or("Expected object for embed")?;
                let name = self.parse_fnv1a(obj.get("name").ok_or("Embed needs name")?)?;
                
                let mut fields = Vec::new();
                if let Some(items) = obj.get("items").and_then(|v| v.as_array()) {
                    for field in items {
                        let field_obj = field.as_object().ok_or("Field must be object")?;
                        let key = self.parse_fnv1a(field_obj.get("key").ok_or("Field needs key")?)?;
                        let field_type_str = field_obj.get("type")
                            .and_then(|v| v.as_str())
                            .ok_or("Field needs type")?;
                        let field_type = self.parse_type_name(field_type_str)?;
                        let field_value = self.read_value(
                            field_obj.get("value").ok_or("Field needs value")?,
                            field_type
                        )?;
                        fields.push(BinField { key, value: field_value });
                    }
                }
                Ok(BinValue::Embed(name, fields))
            }
            BinType::List | BinType::List2 => {
                let obj = element.as_object().ok_or("Expected object for list")?;
                let value_type_str = obj.get("valueType")
                    .and_then(|v| v.as_str())
                    .ok_or("List needs valueType")?;
                let value_type = self.parse_type_name(value_type_str)?;
                
                let mut items = Vec::new();
                if let Some(arr) = obj.get("items").and_then(|v| v.as_array()) {
                    for item in arr {
                        items.push(self.read_value(item, value_type)?);
                    }
                }
                
                if val_type == BinType::List {
                    Ok(BinValue::List(value_type, items))
                } else {
                    Ok(BinValue::List2(value_type, items))
                }
            }
            BinType::Option => {
                let obj = element.as_object().ok_or("Expected object for option")?;
                let value_type_str = obj.get("valueType")
                    .and_then(|v| v.as_str())
                    .ok_or("Option needs valueType")?;
                let value_type = self.parse_type_name(value_type_str)?;
                
                let mut items = Vec::new();
                if let Some(arr) = obj.get("items").and_then(|v| v.as_array()) {
                    for item in arr {
                        items.push(self.read_value(item, value_type)?);
                    }
                }
                Ok(BinValue::Option(value_type, items))
            }
            BinType::Map => {
                let obj = element.as_object().ok_or("Expected object for map")?;
                let key_type_str = obj.get("keyType")
                    .and_then(|v| v.as_str())
                    .ok_or("Map needs keyType")?;
                let value_type_str = obj.get("valueType")
                    .and_then(|v| v.as_str())
                    .ok_or("Map needs valueType")?;
                let key_type = self.parse_type_name(key_type_str)?;
                let value_type = self.parse_type_name(value_type_str)?;
                
                let mut items = Vec::new();
                if let Some(arr) = obj.get("items").and_then(|v| v.as_array()) {
                    for item in arr {
                        let item_obj = item.as_object().ok_or("Map item must be object")?;
                        let key = self.read_value(
                            item_obj.get("key").ok_or("Map item needs key")?,
                            key_type
                        )?;
                        let val = self.read_value(
                            item_obj.get("value").ok_or("Map item needs value")?,
                            value_type
                        )?;
                        items.push((key, val));
                    }
                }
                Ok(BinValue::Map(key_type, value_type, items))
            }
            BinType::Flag => {
                Ok(BinValue::Flag(element.as_bool().ok_or("Expected bool for flag")?))
            }
        }
    }

    fn parse_fnv1a(&self, element: &Value) -> Result<FNV1a, String> {
        if let Some(n) = element.as_u64() {
            return Ok(FNV1a::new(n as u32));
        }
        if let Some(s) = element.as_str() {
            if s.starts_with("0x") || s.starts_with("0X") {
                let hex_str = &s[2..];
                let hash = u32::from_str_radix(hex_str, 16)
                    .map_err(|_| format!("Invalid hex: {}", s))?;
                return Ok(FNV1a::new(hash));
            }
            return Ok(FNV1a::from_string(s));
        }
        Ok(FNV1a::new(0))
    }
}

