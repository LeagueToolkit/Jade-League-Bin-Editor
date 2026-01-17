#![allow(unused_imports)]
pub mod types;
pub mod reader;
pub mod writer;
pub mod hashes;
pub mod text_reader;
pub mod bin_writer;
pub mod json_reader;

pub use types::*;
pub use reader::BinReader;
pub use writer::BinTextWriter;
pub use hashes::HashManager;
pub use hashes::are_hashes_preloaded;
pub use text_reader::BinTextReader;
pub use bin_writer::BinWriter;
pub use json_reader::BinJsonReader;

use std::path::PathBuf;

/// Convert binary bin data to text format
/// If hashes are preloaded, uses those for instant conversion
/// Otherwise, loads hashes on-demand from hash_dir
pub fn convert_bin_to_text(bin_data: &[u8], hash_dir: Option<PathBuf>) -> Result<String, String> {
    let start = std::time::Instant::now();
    
    // Check if the data is UTF-8 text
    if let Ok(text) = std::str::from_utf8(bin_data) {
        let trimmed = text.trim_start();
        
        // Check if it's already in text format (starts with #PROP or #PTCH)
        if trimmed.starts_with("#PROP") || trimmed.starts_with("#PTCH") {
            println!("[BinConverter] File is already in text format, returning as-is");
            return Ok(text.to_string());
        }
        
        // Check if it's JSON format (starts with '{')
        if trimmed.starts_with('{') {
            println!("[BinConverter] Detected JSON format, converting...");
            let json_reader = BinJsonReader::new(text.to_string());
            let mut bin = json_reader.read()?;
            
            // Use preloaded hashes if available, otherwise load on-demand
            let hash_manager = get_hash_manager(hash_dir.clone());
            hash_manager.unhash_bin(&mut bin);
            
            let mut writer = BinTextWriter::new();
            return Ok(writer.write(&bin));
        }
        
        // Check if it's text format without header (first line has ':' and '=')
        if let Some(first_line) = text.lines().next() {
            let first_line = first_line.trim();
            if first_line.contains(':') && first_line.contains('=') {
                println!("[BinConverter] Detected text format without header, converting...");
                let mut text_reader = BinTextReader::new(text.to_string());
                if let Ok(mut bin) = text_reader.read_bin() {
                    let hash_manager = get_hash_manager(hash_dir.clone());
                    hash_manager.unhash_bin(&mut bin);
                    let mut writer = BinTextWriter::new();
                    return Ok(writer.write(&bin));
                }
            }
        }
    }
    
    // Try binary format
    let mut reader = BinReader::new(bin_data);
    match reader.read() {
        Ok(mut bin) => {
            let hash_manager = get_hash_manager(hash_dir.clone());
            
            let preload_status = if are_hashes_preloaded() { "preloaded" } else { "on-demand" };
            println!("[BinConverter] Using {} hashes", preload_status);
            
            hash_manager.unhash_bin(&mut bin);
            let mut writer = BinTextWriter::new();
            let result = writer.write(&bin);
            
            println!("[BinConverter] Total conversion time: {:?}", start.elapsed());
            Ok(result)
        }
        Err(e) => {
            // If binary reader fails, try text reader as last fallback
            if let Ok(text) = std::str::from_utf8(bin_data) {
                println!("[BinConverter] BinReader failed: {}. Trying BinTextReader fallback...", e);
                let mut text_reader = BinTextReader::new(text.to_string());
                if let Ok(mut bin) = text_reader.read_bin() {
                    let hash_manager = get_hash_manager(hash_dir);
                    hash_manager.unhash_bin(&mut bin);
                    let mut writer = BinTextWriter::new();
                    return Ok(writer.write(&bin));
                }
            }
            Err(e)
        }
    }
}

/// Get a HashManager instance - uses preloaded if available, otherwise loads on-demand
fn get_hash_manager(hash_dir: Option<PathBuf>) -> HashManager {
    // If hashes are preloaded, use those
    if are_hashes_preloaded() {
        return HashManager::from_preloaded();
    }
    
    // Otherwise, load on-demand
    let mut hash_manager = HashManager::new();
    if let Some(dir) = hash_dir {
        let _ = hash_manager.load(dir);
    }
    hash_manager
}

pub fn convert_text_to_bin(text: String) -> Result<Vec<u8>, String> {
    let mut reader = BinTextReader::new(text);
    let bin = reader.read_bin()?;
    
    let writer = BinWriter::new();
    writer.write(&bin)
}
