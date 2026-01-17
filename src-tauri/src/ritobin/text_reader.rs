use super::types::*;

pub struct BinTextReader {
    text: String,
    pos: usize,
}

impl BinTextReader {
    pub fn new(text: String) -> Self {
        Self { text, pos: 0 }
    }

    pub fn read_bin(&mut self) -> Result<Bin, String> {
        let mut bin = Bin::new();
        self.skip_whitespace_and_comments();
        
        while !self.is_eof() {
            if self.peek() == '#' {
                self.skip_line();
                self.skip_whitespace_and_comments();
                continue;
            }
            
            let name = self.read_word()?;
            if name.is_empty() { break; }
            
            self.expect(':')?;
            let (val_type, list_type, map_k_type, map_v_type) = self.read_type_annotation()?;
            self.expect('=')?;
            
            let value = self.read_value(val_type, list_type, map_k_type, map_v_type)?;
            bin.sections.insert(name, value);
            self.skip_whitespace_and_comments();
        }
        
        Ok(bin)
    }

    fn read_type_annotation(&mut self) -> Result<(BinType, Option<BinType>, Option<BinType>, Option<BinType>), String> {
        let type_name = self.read_word()?;

        if type_name == "list" || type_name == "list2" || type_name == "option" {
            let base_type = if type_name == "list" { BinType::List } 
                           else if type_name == "list2" { BinType::List2 }
                           else { BinType::Option };
            self.expect('[')?;
            let inner_name = self.read_word()?;
            self.expect(']')?;
            let list_type = Some(self.parse_type_name(&inner_name)?);
            return Ok((base_type, list_type, None, None));
        } else if type_name == "map" {
            self.expect('[')?;
            let k_name = self.read_word()?;
            self.expect(',')?;
            let v_name = self.read_word()?;
            self.expect(']')?;
            let map_k_type = Some(self.parse_type_name(&k_name)?);
            let map_v_type = Some(self.parse_type_name(&v_name)?);
            return Ok((BinType::Map, None, map_k_type, map_v_type));
        }

        Ok((self.parse_type_name(&type_name)?, None, None, None))
    }

    fn parse_type_name(&self, name: &str) -> Result<BinType, String> {
        match name {
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
            "flag" => Ok(BinType::Flag),
            "pointer" => Ok(BinType::Pointer),
            "embed" => Ok(BinType::Embed),
            _ => Err(format!("Unknown type name: {}", name)),
        }
    }

    fn read_value(&mut self, t: BinType, lt: Option<BinType>, mkt: Option<BinType>, mvt: Option<BinType>) -> Result<BinValue, String> {
        self.skip_whitespace_and_comments();
        match t {
            BinType::None => { self.read_word()?; Ok(BinValue::None) }
            BinType::Bool => {
                let w = self.read_word()?;
                Ok(BinValue::Bool(w == "true"))
            }
            BinType::I8 => Ok(BinValue::I8(self.read_word()?.parse().unwrap_or(0))),
            BinType::U8 => Ok(BinValue::U8(self.read_word()?.parse().unwrap_or(0))),
            BinType::I16 => Ok(BinValue::I16(self.read_word()?.parse().unwrap_or(0))),
            BinType::U16 => Ok(BinValue::U16(self.read_word()?.parse().unwrap_or(0))),
            BinType::I32 => Ok(BinValue::I32(self.read_word()?.parse().unwrap_or(0))),
            BinType::U32 => Ok(BinValue::U32(self.read_word()?.parse().unwrap_or(0))),
            BinType::I64 => Ok(BinValue::I64(self.read_word()?.parse().unwrap_or(0))),
            BinType::U64 => Ok(BinValue::U64(self.read_word()?.parse().unwrap_or(0))),
            BinType::F32 => Ok(BinValue::F32(self.read_word()?.parse().unwrap_or(0.0))),
            BinType::String => Ok(BinValue::String(self.read_quoted_string()?)),
            BinType::Hash | BinType::Link => Ok(BinValue::Hash(self.read_hash()?)),
            BinType::File => Ok(BinValue::File(self.read_file_hash()?)),
            
            BinType::List | BinType::List2 | BinType::Option => {
                let inner_t = lt.unwrap_or(BinType::None);
                self.expect('{')?;
                let mut items = Vec::new();
                self.skip_whitespace_and_comments();
                while self.peek() != '}' {
                    items.push(self.read_value(inner_t, None, None, None)?);
                    self.skip_whitespace_and_comments();
                    if self.peek() == ',' { self.read_char(); self.skip_whitespace_and_comments(); }
                }
                self.expect('}')?;
                if t == BinType::List { Ok(BinValue::List(inner_t, items)) }
                else if t == BinType::List2 { Ok(BinValue::List2(inner_t, items)) }
                else { Ok(BinValue::Option(inner_t, items)) }
            }
            
            BinType::Map => {
                let kt = mkt.unwrap_or(BinType::None);
                let vt = mvt.unwrap_or(BinType::None);
                self.expect('{')?;
                let mut items = Vec::new();
                self.skip_whitespace_and_comments();
                while self.peek() != '}' {
                    let k = self.read_value(kt, None, None, None)?;
                    self.expect('=')?;
                    let v = self.read_value(vt, None, None, None)?;
                    items.push((k, v));
                    self.skip_whitespace_and_comments();
                    if self.peek() == ',' { self.read_char(); self.skip_whitespace_and_comments(); }
                }
                self.expect('}')?;
                Ok(BinValue::Map(kt, vt, items))
            }
            
            BinType::Pointer | BinType::Embed => {
                let name = self.read_hash()?;
                if name.hash == 0 && name.string.is_none() && t == BinType::Pointer {
                    return Ok(BinValue::Pointer(name, Vec::new()));
                }
                self.expect('{')?;
                let mut fields = Vec::new();
                self.skip_whitespace_and_comments();
                while self.peek() != '}' {
                    let f_name = self.read_hash()?;
                    self.expect(':')?;
                    let (f_t, f_lt, f_mkt, f_mvt) = self.read_type_annotation()?;
                    self.expect('=')?;
                    let f_v = self.read_value(f_t, f_lt, f_mkt, f_mvt)?;
                    fields.push(BinField { key: f_name, value: f_v });
                    self.skip_whitespace_and_comments();
                    if self.peek() == ',' { self.read_char(); self.skip_whitespace_and_comments(); }
                }
                self.expect('}')?;
                if t == BinType::Pointer { Ok(BinValue::Pointer(name, fields)) }
                else { Ok(BinValue::Embed(name, fields)) }
            }
            
            _ => Err(format!("Value reading not implemented for type {:?}", t)),
        }
    }

    fn read_word(&mut self) -> Result<String, String> {
        self.skip_whitespace_and_comments();
        let start = self.pos;
        while !self.is_eof() && (self.peek().is_alphanumeric() || self.peek() == '_' || self.peek() == '.' || self.peek() == '-' || self.peek() == '+') {
            self.read_char();
        }
        Ok(self.text[start..self.pos].to_string())
    }

    fn read_quoted_string(&mut self) -> Result<String, String> {
        self.skip_whitespace_and_comments();
        let quote = self.read_char(); // " or '
        if quote != '"' && quote != '\'' { return Err("Expected quote".to_string()); }
        let start = self.pos;
        while !self.is_eof() && self.peek() != quote {
            self.read_char();
        }
        let s = self.text[start..self.pos].to_string();
        self.read_char(); // skip closing quote
        Ok(s)
    }

    fn read_hash(&mut self) -> Result<FNV1a, String> {
        self.skip_whitespace_and_comments();
        if self.peek() == '"' || self.peek() == '\'' {
            return Ok(FNV1a::from_string(&self.read_quoted_string()?));
        }
        let word = self.read_word()?;
        if word.starts_with("0x") {
            let h = u32::from_str_radix(&word[2..], 16).map_err(|e| e.to_string())?;
            Ok(FNV1a::new(h))
        } else {
            Ok(FNV1a::from_string(&word))
        }
    }
    
    fn read_file_hash(&mut self) -> Result<XXH64, String> {
        self.skip_whitespace_and_comments();
        if self.peek() == '"' || self.peek() == '\'' {
            return Ok(XXH64 { hash: 0, string: Some(self.read_quoted_string()?) });
        }
        let word = self.read_word()?;
        if word.starts_with("0x") {
            let h = u64::from_str_radix(&word[2..], 16).map_err(|e| e.to_string())?;
            Ok(XXH64 { hash: h, string: None })
        } else {
            Ok(XXH64 { hash: 0, string: Some(word) })
        }
    }

    fn expect(&mut self, c: char) -> Result<(), String> {
        self.skip_whitespace_and_comments();
        if self.read_char() == c { Ok(()) }
        else { Err(format!("Expected '{}' at pos {}", c, self.pos)) }
    }

    fn skip_whitespace_and_comments(&mut self) {
        while !self.is_eof() {
            let c = self.peek();
            if c.is_whitespace() {
                self.read_char();
            } else if c == '#' {
                self.skip_line();
            } else {
                break;
            }
        }
    }

    fn skip_line(&mut self) {
        while !self.is_eof() && self.read_char() != '\n' {}
    }

    fn peek(&self) -> char {
        self.text[self.pos..].chars().next().unwrap_or('\0')
    }

    fn read_char(&mut self) -> char {
        let c = self.peek();
        if c != '\0' {
            self.pos += c.len_utf8();
        }
        c
    }

    fn is_eof(&self) -> bool {
        self.pos >= self.text.len()
    }
}
