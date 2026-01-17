use super::types::*;
use std::fmt::Write;

pub struct BinTextWriter {
    indent: usize,
}

impl BinTextWriter {
    pub fn new() -> Self {
        Self { indent: 0 }
    }

    pub fn write(&mut self, bin: &Bin) -> String {
        let mut buffer = String::with_capacity(65536);
        let _ = write!(buffer, "#PROP_text\n");

        // Sort sections for consistent output
        let mut keys: Vec<&String> = bin.sections.keys().collect();
        keys.sort();

        for key in keys {
            let value = &bin.sections[key];
            self.write_section(&mut buffer, key, value);
        }

        buffer
    }

    fn write_section(&mut self, buffer: &mut String, name: &str, value: &BinValue) {
        let _ = write!(buffer, "{}: ", name);
        self.write_type(buffer, value);
        let _ = write!(buffer, " = ");
        self.write_value(buffer, value);
        let _ = write!(buffer, "\n");
    }

    fn write_type(&mut self, buffer: &mut String, value: &BinValue) {
        match value {
            BinValue::List(t, _) => {
                let _ = write!(buffer, "list[{}]", self.get_type_string(*t));
            }
            BinValue::List2(t, _) => {
                let _ = write!(buffer, "list2[{}]", self.get_type_string(*t));
            }
            BinValue::Option(t, _) => {
                let _ = write!(buffer, "option[{}]", self.get_type_string(*t));
            }
            BinValue::Map(kt, vt, _) => {
                let _ = write!(buffer, "map[{},{}]", self.get_type_string(*kt), self.get_type_string(*vt));
            }
            _ => {
                let _ = write!(buffer, "{}", self.get_type_string(value.get_type()));
            }
        }
    }

    fn get_type_string(&self, t: BinType) -> &'static str {
        match t {
            BinType::None => "none",
            BinType::Bool => "bool",
            BinType::I8 => "i8",
            BinType::U8 => "u8",
            BinType::I16 => "i16",
            BinType::U16 => "u16",
            BinType::I32 => "i32",
            BinType::U32 => "u32",
            BinType::I64 => "i64",
            BinType::U64 => "u64",
            BinType::F32 => "f32",
            BinType::Vec2 => "vec2",
            BinType::Vec3 => "vec3",
            BinType::Vec4 => "vec4",
            BinType::Mtx44 => "mtx44",
            BinType::Rgba => "rgba",
            BinType::String => "string",
            BinType::Hash => "hash",
            BinType::File => "file",
            BinType::Link => "link",
            BinType::Flag => "flag",
            BinType::Pointer => "pointer",
            BinType::Embed => "embed",
            _ => "unknown",
        }
    }

    fn write_value(&mut self, buffer: &mut String, value: &BinValue) {
        match value {
            BinValue::None => { let _ = write!(buffer, "null"); }
            BinValue::Bool(b) => { let _ = write!(buffer, "{}", b); }
            BinValue::I8(v) => { let _ = write!(buffer, "{}", v); }
            BinValue::U8(v) => { let _ = write!(buffer, "{}", v); }
            BinValue::I16(v) => { let _ = write!(buffer, "{}", v); }
            BinValue::U16(v) => { let _ = write!(buffer, "{}", v); }
            BinValue::I32(v) => { let _ = write!(buffer, "{}", v); }
            BinValue::U32(v) => { let _ = write!(buffer, "{}", v); }
            BinValue::I64(v) => { let _ = write!(buffer, "{}", v); }
            BinValue::U64(v) => { let _ = write!(buffer, "{}", v); }
            BinValue::F32(v) => { let _ = write!(buffer, "{:?}", v); } // Use debug for precision or format
            BinValue::Vec2(x, y) => { let _ = write!(buffer, "{{ {:?}, {:?} }}", x, y); }
            BinValue::Vec3(x, y, z) => { let _ = write!(buffer, "{{ {:?}, {:?}, {:?} }}", x, y, z); }
            BinValue::Vec4(x, y, z, w) => { let _ = write!(buffer, "{{ {:?}, {:?}, {:?}, {:?} }}", x, y, z, w); }
            BinValue::Mtx44(m) => {
                let _ = write!(buffer, "{{\n");
                self.indent += 4;
                for i in 0..4 {
                    self.write_padding(buffer);
                    let _ = write!(buffer, "{:?}, {:?}, {:?}, {:?}\n", m[i*4], m[i*4+1], m[i*4+2], m[i*4+3]);
                }
                self.indent -= 4;
                self.write_padding(buffer);
                let _ = write!(buffer, "}}");
            }
            BinValue::Rgba(r, g, b, a) => { let _ = write!(buffer, "{{ {}, {}, {}, {} }}", r, g, b, a); }
            BinValue::String(s) => { let _ = write!(buffer, "\"{}\"", s); }
            BinValue::Hash(h) => self.write_hash_value(buffer, h),
            BinValue::File(f) => self.write_file_hash_value(buffer, f),
            BinValue::Link(l) => self.write_hash_value(buffer, l),
            BinValue::Flag(b) => { let _ = write!(buffer, "{}", b); }
            
            BinValue::List(_, items) | BinValue::List2(_, items) | BinValue::Option(_, items) => self.write_list(buffer, items),
            BinValue::Map(_, _, items) => self.write_map(buffer, items),
            
            BinValue::Pointer(name, fields) => {
                if name.hash == 0 && name.string.is_none() {
                    let _ = write!(buffer, "null");
                } else {
                    self.write_hash_name(buffer, name);
                    let _ = write!(buffer, " ");
                    self.write_fields(buffer, fields);
                }
            }
            BinValue::Embed(name, fields) => {
                self.write_hash_name(buffer, name);
                let _ = write!(buffer, " ");
                self.write_fields(buffer, fields);
            }
        }
    }

    fn write_list(&mut self, buffer: &mut String, items: &Vec<BinValue>) {
        if items.is_empty() {
            let _ = write!(buffer, "{{}}");
            return;
        }

        let _ = write!(buffer, "{{\n");
        self.indent += 4;
        for item in items {
            self.write_padding(buffer);
            self.write_value(buffer, item);
            let _ = write!(buffer, "\n");
        }
        self.indent -= 4;
        self.write_padding(buffer);
        let _ = write!(buffer, "}}");
    }

    fn write_map(&mut self, buffer: &mut String, items: &Vec<(BinValue, BinValue)>) {
        if items.is_empty() {
            let _ = write!(buffer, "{{}}");
            return;
        }

        let _ = write!(buffer, "{{\n");
        self.indent += 4;
        for (k, v) in items {
            self.write_padding(buffer);
            self.write_value(buffer, k);
            let _ = write!(buffer, " = ");
            self.write_value(buffer, v);
            let _ = write!(buffer, "\n");
        }
        self.indent -= 4;
        self.write_padding(buffer);
        let _ = write!(buffer, "}}");
    }

    fn write_fields(&mut self, buffer: &mut String, fields: &Vec<BinField>) {
        if fields.is_empty() {
            let _ = write!(buffer, "{{}}");
            return;
        }

        let _ = write!(buffer, "{{\n");
        self.indent += 4;
        for field in fields {
            self.write_padding(buffer);
            self.write_hash_name(buffer, &field.key);
            let _ = write!(buffer, ": ");
            self.write_type(buffer, &field.value);
            let _ = write!(buffer, " = ");
            self.write_value(buffer, &field.value);
            let _ = write!(buffer, "\n");
        }
        self.indent -= 4;
        self.write_padding(buffer);
        let _ = write!(buffer, "}}");
    }

    fn write_hash_value(&mut self, buffer: &mut String, h: &FNV1a) {
        if let Some(s) = &h.string {
            let _ = write!(buffer, "\"{}\"", s);
        } else {
            let _ = write!(buffer, "0x{:08x}", h.hash);
        }
    }

    fn write_file_hash_value(&mut self, buffer: &mut String, f: &XXH64) {
        if let Some(s) = &f.string {
            let _ = write!(buffer, "\"{}\"", s);
        } else {
            let _ = write!(buffer, "0x{:016x}", f.hash);
        }
    }

    fn write_hash_name(&mut self, buffer: &mut String, h: &FNV1a) {
        if let Some(s) = &h.string {
            let _ = write!(buffer, "{}", s);
        } else {
            let _ = write!(buffer, "0x{:08x}", h.hash);
        }
    }

    fn write_padding(&self, buffer: &mut String) {
        for _ in 0..self.indent {
            buffer.push(' ');
        }
    }
}
