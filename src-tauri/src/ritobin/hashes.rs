use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::io::{Read, Cursor};
use byteorder::{ReadBytesExt, LittleEndian};
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use super::types::*;

/// Global hash manager instance - shared across all conversions
static GLOBAL_HASH_MANAGER: Lazy<RwLock<GlobalHashState>> = Lazy::new(|| {
    RwLock::new(GlobalHashState::new())
});

/// Tracks the global hash loading state
struct GlobalHashState {
    fnv_keys: Vec<u32>,
    fnv_data: Vec<u64>,  // Packed: offset << 16 | length
    xxh_keys: Vec<u64>,
    xxh_data: Vec<u64>,  // Packed: offset << 16 | length
    string_storage: Vec<u8>,
    loaded: bool,
    loading: bool,
}

impl GlobalHashState {
    fn new() -> Self {
        Self {
            fnv_keys: Vec::new(),
            fnv_data: Vec::new(),
            xxh_keys: Vec::new(),
            xxh_data: Vec::new(),
            string_storage: Vec::new(),
            loaded: false,
            loading: false,
        }
    }

    fn get_fnv(&self, hash: u32) -> Option<String> {
        if !self.loaded || self.fnv_keys.is_empty() {
            return None;
        }
        
        match self.fnv_keys.binary_search(&hash) {
            Ok(idx) => {
                let data = self.fnv_data[idx];
                let offset = (data >> 16) as usize;
                let length = (data & 0xFFFF) as usize;
                
                if offset + length <= self.string_storage.len() {
                    Some(String::from_utf8_lossy(&self.string_storage[offset..offset + length]).to_string())
                } else {
                    None
                }
            }
            Err(_) => None
        }
    }

    fn get_xxh(&self, hash: u64) -> Option<String> {
        if !self.loaded || self.xxh_keys.is_empty() {
            return None;
        }
        
        match self.xxh_keys.binary_search(&hash) {
            Ok(idx) => {
                let data = self.xxh_data[idx];
                let offset = (data >> 16) as usize;
                let length = (data & 0xFFFF) as usize;
                
                if offset + length <= self.string_storage.len() {
                    Some(String::from_utf8_lossy(&self.string_storage[offset..offset + length]).to_string())
                } else {
                    None
                }
            }
            Err(_) => None
        }
    }
}

/// Public interface for hash management
pub struct HashManager {
    // For backwards compatibility - non-preloaded use
    fnv_hashes: HashMap<u32, String>,
    xxh_hashes: HashMap<u64, String>,
    loaded: bool,
    use_global: bool,
}

impl HashManager {
    pub fn new() -> Self {
        // Check if global hashes are loaded - if so, use them
        let use_global = GLOBAL_HASH_MANAGER.read().loaded;
        
        Self {
            fnv_hashes: HashMap::new(),
            xxh_hashes: HashMap::new(),
            loaded: use_global,
            use_global,
        }
    }

    /// Create a HashManager that uses the preloaded global hashes
    pub fn from_preloaded() -> Self {
        Self {
            fnv_hashes: HashMap::new(),
            xxh_hashes: HashMap::new(),
            loaded: true,
            use_global: true,
        }
    }

    pub fn load(&mut self, hash_dir: PathBuf) -> Result<(), String> {
        // If global hashes are already loaded, use them
        if GLOBAL_HASH_MANAGER.read().loaded {
            self.use_global = true;
            self.loaded = true;
            println!("[HashManager] Using preloaded global hashes");
            return Ok(());
        }

        if self.loaded { return Ok(()); }

        if !hash_dir.exists() {
            return Err(format!("Hash directory does not exist: {:?}", hash_dir));
        }

        // Load into local HashMap (backwards compatible)
        let entries = fs::read_dir(&hash_dir).map_err(|e| e.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            
            // Skip hashes.game.* files
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.starts_with("hashes.game.") {
                    continue;
                }
            }
            
            if path.extension().map_or(false, |ext| ext == "bin") {
                self.load_binary(&path)?;
            } else if path.extension().map_or(false, |ext| ext == "txt") {
                // Only load txt if no corresponding bin exists
                let bin_path = path.with_extension("bin");
                if !bin_path.exists() {
                    self.load_text(&path)?;
                }
            }
        }

        self.loaded = true;
        self.use_global = false;
        Ok(())
    }

    fn load_binary(&mut self, path: &PathBuf) -> Result<(), String> {
        let data = fs::read(path).map_err(|e| e.to_string())?;
        let mut cursor = Cursor::new(&data);

        let mut magic = [0u8; 4];
        cursor.read_exact(&mut magic).map_err(|e| e.to_string())?;
        if &magic != b"HHSH" {
            return Ok(()); // Not a hash file we recognize
        }

        let _version = cursor.read_i32::<LittleEndian>().map_err(|e| e.to_string())?;
        let fnv_count = cursor.read_i32::<LittleEndian>().map_err(|e| e.to_string())?;
        let xxh_count = cursor.read_i32::<LittleEndian>().map_err(|e| e.to_string())?;

        for _ in 0..fnv_count {
            let hash = cursor.read_u32::<LittleEndian>().map_err(|e| e.to_string())?;
            let s = self.read_7bit_string(&mut cursor)?;
            self.fnv_hashes.insert(hash, s);
        }

        for _ in 0..xxh_count {
            let hash = cursor.read_u64::<LittleEndian>().map_err(|e| e.to_string())?;
            let s = self.read_7bit_string(&mut cursor)?;
            self.xxh_hashes.insert(hash, s);
        }

        Ok(())
    }

    fn load_text(&mut self, path: &PathBuf) -> Result<(), String> {
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        
        for line in content.lines() {
            if line.trim().is_empty() { continue; }
            
            if let Some((hash_part, value_part)) = line.split_once(' ') {
                if hash_part.len() == 16 {
                    if let Ok(hash) = u64::from_str_radix(hash_part, 16) {
                        self.xxh_hashes.insert(hash, value_part.to_string());
                    }
                } else if hash_part.len() == 8 {
                    if let Ok(hash) = u32::from_str_radix(hash_part, 16) {
                        self.fnv_hashes.insert(hash, value_part.to_string());
                    }
                }
            }
        }
        
        Ok(())
    }

    fn read_7bit_string(&self, cursor: &mut Cursor<&Vec<u8>>) -> Result<String, String> {
        let length = self.read_7bit_encoded_int(cursor)?;
        let mut bytes = vec![0u8; length as usize];
        cursor.read_exact(&mut bytes).map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&bytes).to_string())
    }

    fn read_7bit_encoded_int(&self, cursor: &mut Cursor<&Vec<u8>>) -> Result<u32, String> {
        let mut count = 0u32;
        let mut shift = 0;
        loop {
            let b = cursor.read_u8().map_err(|e| e.to_string())?;
            count |= ((b & 0x7F) as u32) << shift;
            if (b & 0x80) == 0 { break; }
            shift += 7;
        }
        Ok(count)
    }

    pub fn unhash_fnv(&self, hash: u32) -> Option<String> {
        if self.use_global {
            GLOBAL_HASH_MANAGER.read().get_fnv(hash)
        } else {
            self.fnv_hashes.get(&hash).cloned()
        }
    }

    pub fn unhash_xxh(&self, hash: u64) -> Option<String> {
        if self.use_global {
            GLOBAL_HASH_MANAGER.read().get_xxh(hash)
        } else {
            self.xxh_hashes.get(&hash).cloned()
        }
    }

    pub fn unhash_bin(&self, bin: &mut Bin) {
        for value in bin.sections.values_mut() {
            self.unhash_value(value);
        }
    }

    fn unhash_value(&self, value: &mut BinValue) {
        match value {
            BinValue::Hash(h) | BinValue::Link(h) => {
                if h.string.is_none() {
                    h.string = self.unhash_fnv(h.hash);
                }
            }
            BinValue::File(f) => {
                if f.string.is_none() {
                    f.string = self.unhash_xxh(f.hash);
                }
            }
            BinValue::Pointer(h, fields) | BinValue::Embed(h, fields) => {
                if h.string.is_none() {
                    h.string = self.unhash_fnv(h.hash);
                }
                for field in fields {
                    if field.key.string.is_none() {
                        field.key.string = self.unhash_fnv(field.key.hash);
                    }
                    self.unhash_value(&mut field.value);
                }
            }
            BinValue::List(_, items) | BinValue::List2(_, items) | BinValue::Option(_, items) => {
                for item in items {
                    self.unhash_value(item);
                }
            }
            BinValue::Map(_, _, items) => {
                for (k, v) in items {
                    self.unhash_value(k);
                    self.unhash_value(v);
                }
            }
            _ => {}
        }
    }
}

// ============================================================================
// Global Hash Preloading Functions
// ============================================================================

/// Check if hashes are preloaded and ready to use
pub fn are_hashes_preloaded() -> bool {
    GLOBAL_HASH_MANAGER.read().loaded
}

/// Check if hashes are currently being loaded
pub fn are_hashes_loading() -> bool {
    GLOBAL_HASH_MANAGER.read().loading
}

/// Preload hashes into memory for instant access
/// This runs synchronously - call from a background thread/task
pub fn preload_hashes(hash_dir: PathBuf) -> Result<(usize, usize), String> {
    {
        let state = GLOBAL_HASH_MANAGER.read();
        if state.loaded {
            println!("[HashManager] Hashes already preloaded");
            return Ok((state.fnv_keys.len(), state.xxh_keys.len()));
        }
        if state.loading {
            println!("[HashManager] Hashes are currently loading");
            return Err("Hashes are currently loading".to_string());
        }
    }

    // Mark as loading
    {
        let mut state = GLOBAL_HASH_MANAGER.write();
        state.loading = true;
    }

    println!("[HashManager] Starting preload from {:?}", hash_dir);
    let start = std::time::Instant::now();

    if !hash_dir.exists() {
        let mut state = GLOBAL_HASH_MANAGER.write();
        state.loading = false;
        return Err(format!("Hash directory does not exist: {:?}", hash_dir));
    }

    // 1. Find files to load (prefer .bin over .txt)
    let mut files_to_load: Vec<PathBuf> = Vec::new();
    let mut base_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    
    let entries = fs::read_dir(&hash_dir).map_err(|e| {
        let mut state = GLOBAL_HASH_MANAGER.write();
        state.loading = false;
        e.to_string()
    })?;

    let all_files: Vec<_> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();

    // First pass: find all .bin files
    for path in &all_files {
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with("hashes.game.") {
                continue;
            }
        }
        
        if path.extension().map_or(false, |ext| ext == "bin") {
            files_to_load.push(path.clone());
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                base_names.insert(stem.to_lowercase());
            }
        }
    }

    // Second pass: add .txt files only if no .bin exists
    for path in &all_files {
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with("hashes.game.") {
                continue;
            }
        }
        
        if path.extension().map_or(false, |ext| ext == "txt") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                if !base_names.contains(&stem.to_lowercase()) {
                    files_to_load.push(path.clone());
                }
            }
        }
    }

    // 2. Pre-scan for sizes
    let mut total_fnv_count = 0usize;
    let mut total_xxh_count = 0usize;
    let mut estimated_string_size = 0usize;

    for path in &files_to_load {
        if path.extension().map_or(false, |ext| ext == "bin") {
            if let Ok(data) = fs::read(path) {
                if data.len() >= 12 && &data[0..4] == b"HHSH" {
                    let fnv_count = i32::from_le_bytes([data[8], data[9], data[10], data[11]]) as usize;
                    let xxh_count = i32::from_le_bytes([data[12], data[13], data[14], data[15]]) as usize;
                    total_fnv_count += fnv_count;
                    total_xxh_count += xxh_count;
                    estimated_string_size += data.len();
                }
            }
        } else if let Ok(metadata) = fs::metadata(path) {
            estimated_string_size += metadata.len() as usize;
        }
    }

    // 3. Allocate arrays
    let mut fnv_keys: Vec<u32> = Vec::with_capacity(total_fnv_count);
    let mut fnv_data: Vec<u64> = Vec::with_capacity(total_fnv_count);
    let mut xxh_keys: Vec<u64> = Vec::with_capacity(total_xxh_count);
    let mut xxh_data: Vec<u64> = Vec::with_capacity(total_xxh_count);
    let mut string_storage: Vec<u8> = Vec::with_capacity(estimated_string_size);
    let mut storage_offset: usize = 0;

    // 4. Load data
    for path in &files_to_load {
        if path.extension().map_or(false, |ext| ext == "bin") {
            load_binary_preload(
                path,
                &mut fnv_keys, &mut fnv_data,
                &mut xxh_keys, &mut xxh_data,
                &mut string_storage, &mut storage_offset
            )?;
        } else {
            load_text_preload(
                path,
                &mut fnv_keys, &mut fnv_data,
                &mut xxh_keys, &mut xxh_data,
                &mut string_storage, &mut storage_offset
            )?;
        }
    }

    // 5. Sort for binary search
    let mut fnv_pairs: Vec<(u32, u64)> = fnv_keys.iter().copied().zip(fnv_data.iter().copied()).collect();
    fnv_pairs.sort_by_key(|&(k, _)| k);
    let (sorted_fnv_keys, sorted_fnv_data): (Vec<_>, Vec<_>) = fnv_pairs.into_iter().unzip();

    let mut xxh_pairs: Vec<(u64, u64)> = xxh_keys.iter().copied().zip(xxh_data.iter().copied()).collect();
    xxh_pairs.sort_by_key(|&(k, _)| k);
    let (sorted_xxh_keys, sorted_xxh_data): (Vec<_>, Vec<_>) = xxh_pairs.into_iter().unzip();

    // 6. Store in global state
    {
        let mut state = GLOBAL_HASH_MANAGER.write();
        state.fnv_keys = sorted_fnv_keys;
        state.fnv_data = sorted_fnv_data;
        state.xxh_keys = sorted_xxh_keys;
        state.xxh_data = sorted_xxh_data;
        state.string_storage = string_storage;
        state.loaded = true;
        state.loading = false;
    }

    let elapsed = start.elapsed();
    let state = GLOBAL_HASH_MANAGER.read();
    let total_hashes = state.fnv_keys.len() + state.xxh_keys.len();
    let storage_mb = state.string_storage.len() / 1024 / 1024;
    
    println!(
        "[HashManager] Preloaded {} hashes ({} FNV, {} XXH) in {:?}. String buffer: {}MB",
        total_hashes, state.fnv_keys.len(), state.xxh_keys.len(), elapsed, storage_mb
    );

    Ok((state.fnv_keys.len(), state.xxh_keys.len()))
}

fn load_binary_preload(
    path: &PathBuf,
    fnv_keys: &mut Vec<u32>, fnv_data: &mut Vec<u64>,
    xxh_keys: &mut Vec<u64>, xxh_data: &mut Vec<u64>,
    string_storage: &mut Vec<u8>, storage_offset: &mut usize
) -> Result<(), String> {
    let data = fs::read(path).map_err(|e| e.to_string())?;
    let mut cursor = Cursor::new(&data);

    let mut magic = [0u8; 4];
    cursor.read_exact(&mut magic).map_err(|e| e.to_string())?;
    if &magic != b"HHSH" {
        return Ok(());
    }

    let _version = cursor.read_i32::<LittleEndian>().map_err(|e| e.to_string())?;
    let fnv_count = cursor.read_i32::<LittleEndian>().map_err(|e| e.to_string())?;
    let xxh_count = cursor.read_i32::<LittleEndian>().map_err(|e| e.to_string())?;

    for _ in 0..fnv_count {
        let hash = cursor.read_u32::<LittleEndian>().map_err(|e| e.to_string())?;
        let len = read_7bit_encoded_int(&mut cursor)?;
        
        // Store offset and length in packed format
        let packed = ((*storage_offset as u64) << 16) | (len as u64 & 0xFFFF);
        fnv_keys.push(hash);
        fnv_data.push(packed);
        
        // Read string directly into storage
        let mut bytes = vec![0u8; len as usize];
        cursor.read_exact(&mut bytes).map_err(|e| e.to_string())?;
        string_storage.extend_from_slice(&bytes);
        *storage_offset += len as usize;
    }

    for _ in 0..xxh_count {
        let hash = cursor.read_u64::<LittleEndian>().map_err(|e| e.to_string())?;
        let len = read_7bit_encoded_int(&mut cursor)?;
        
        let packed = ((*storage_offset as u64) << 16) | (len as u64 & 0xFFFF);
        xxh_keys.push(hash);
        xxh_data.push(packed);
        
        let mut bytes = vec![0u8; len as usize];
        cursor.read_exact(&mut bytes).map_err(|e| e.to_string())?;
        string_storage.extend_from_slice(&bytes);
        *storage_offset += len as usize;
    }

    Ok(())
}

fn load_text_preload(
    path: &PathBuf,
    fnv_keys: &mut Vec<u32>, fnv_data: &mut Vec<u64>,
    xxh_keys: &mut Vec<u64>, xxh_data: &mut Vec<u64>,
    string_storage: &mut Vec<u8>, storage_offset: &mut usize
) -> Result<(), String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    
    for line in content.lines() {
        if line.trim().is_empty() { continue; }
        
        if let Some((hash_part, value_part)) = line.split_once(' ') {
            let bytes = value_part.as_bytes();
            let len = bytes.len();
            
            if hash_part.len() == 16 {
                if let Ok(hash) = u64::from_str_radix(hash_part, 16) {
                    let packed = ((*storage_offset as u64) << 16) | (len as u64 & 0xFFFF);
                    xxh_keys.push(hash);
                    xxh_data.push(packed);
                    string_storage.extend_from_slice(bytes);
                    *storage_offset += len;
                }
            } else if hash_part.len() == 8 {
                if let Ok(hash) = u32::from_str_radix(hash_part, 16) {
                    let packed = ((*storage_offset as u64) << 16) | (len as u64 & 0xFFFF);
                    fnv_keys.push(hash);
                    fnv_data.push(packed);
                    string_storage.extend_from_slice(bytes);
                    *storage_offset += len;
                }
            }
        }
    }
    
    Ok(())
}

fn read_7bit_encoded_int(cursor: &mut Cursor<&Vec<u8>>) -> Result<u32, String> {
    let mut count = 0u32;
    let mut shift = 0;
    loop {
        let b = cursor.read_u8().map_err(|e| e.to_string())?;
        count |= ((b & 0x7F) as u32) << shift;
        if (b & 0x80) == 0 { break; }
        shift += 7;
    }
    Ok(count)
}

/// Unload preloaded hashes to free memory
pub fn unload_hashes() {
    let mut state = GLOBAL_HASH_MANAGER.write();
    state.fnv_keys = Vec::new();
    state.fnv_data = Vec::new();
    state.xxh_keys = Vec::new();
    state.xxh_data = Vec::new();
    state.string_storage = Vec::new();
    state.loaded = false;
    state.loading = false;
    println!("[HashManager] Unloaded hashes from memory");
}

/// Get stats about loaded hashes
pub fn get_hash_stats() -> (usize, usize, usize) {
    let state = GLOBAL_HASH_MANAGER.read();
    (state.fnv_keys.len(), state.xxh_keys.len(), state.string_storage.len())
}
