#![allow(unused_imports)]
pub mod types;
pub mod reader;
pub mod writer;
pub mod hashes;
pub mod text_reader;
pub mod bin_writer;
pub mod json_reader;
pub mod ltk_bridge;

pub use types::*;
pub use reader::BinReader;
pub use writer::BinTextWriter;
pub use hashes::HashManager;
pub use hashes::are_hashes_preloaded;
pub use text_reader::BinTextReader;
pub use bin_writer::BinWriter;
pub use json_reader::BinJsonReader;

// Re-export ltk_bridge functions and types for external use
pub use ltk_bridge::{
    read_bin as read_bin_ltk,
    write_bin as write_bin_ltk,
    tree_to_text,
    tree_to_text_cached,
    text_to_tree,
    get_cached_bin_hashes,
    HashMapProvider,
    MAX_BIN_SIZE,
};

// Re-export ltk_meta types
pub use ltk_meta::{BinTree, BinTreeObject, BinProperty, BinPropertyKind, PropertyValueEnum};

use std::path::PathBuf;

/// Convert binary bin data to text format using ltk_meta/ltk_ritobin
/// 
/// This is the preferred method as it uses cached hash loading for performance.
/// Supports binary, text, and JSON input formats.
pub fn convert_bin_to_text(bin_data: &[u8], _hash_dir: Option<PathBuf>) -> Result<String, String> {
    let start = std::time::Instant::now();
    
    // Check if the data is UTF-8 text (already converted or JSON)
    if let Ok(text) = std::str::from_utf8(bin_data) {
        let trimmed = text.trim_start();
        
        // Check if it's already in ritobin text format (starts with #PROP or #PTCH)
        if trimmed.starts_with("#PROP") || trimmed.starts_with("#PTCH") {
            println!("[BinConverter] File is already in text format, returning as-is");
            return Ok(text.to_string());
        }
        
        // Check if it's JSON format (BinTree serialized)
        if trimmed.starts_with('{') {
            println!("[BinConverter] Detected JSON format, converting via serde...");
            let tree: ltk_meta::BinTree = serde_json::from_str(text)
                .map_err(|e| format!("Failed to parse JSON: {}", e))?;
            let result = ltk_bridge::tree_to_text_cached(&tree)
                .map_err(|e| format!("Failed to convert to text: {}", e))?;
            println!("[BinConverter] JSON conversion time: {:?}", start.elapsed());
            return Ok(result);
        }
        
        // Check if it looks like ritobin text without header (first non-empty line has ':' and '=')
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with("//") {
                continue;
            }
            if line.contains(':') && line.contains('=') {
                println!("[BinConverter] Detected text format without header, parsing...");
                let tree = ltk_bridge::text_to_tree(text)
                    .map_err(|e| format!("Failed to parse text: {}", e))?;
                let result = ltk_bridge::tree_to_text_cached(&tree)
                    .map_err(|e| format!("Failed to convert to text: {}", e))?;
                println!("[BinConverter] Text conversion time: {:?}", start.elapsed());
                return Ok(result);
            }
            break; // Only check first non-empty, non-comment line
        }
    }
    
    // Try binary format using ltk_meta
    println!("[BinConverter] Parsing as binary BIN file...");
    let tree = ltk_bridge::read_bin(bin_data)
        .map_err(|e| format!("Failed to parse BIN: {}", e))?;
    
    println!("[BinConverter] Parsed {} objects, converting to text...", tree.objects.len());
    
    let result = ltk_bridge::tree_to_text_cached(&tree)
        .map_err(|e| format!("Failed to convert to text: {}", e))?;
    
    println!("[BinConverter] Total conversion time: {:?}", start.elapsed());
    Ok(result)
}

/// Convert ritobin text format back to binary using ltk_ritobin
pub fn convert_text_to_bin(text: String) -> Result<Vec<u8>, String> {
    println!("[BinConverter] Converting text to binary...");
    
    // Parse the ritobin text to BinTree
    let tree = ltk_bridge::text_to_tree(&text)
        .map_err(|e| format!("Failed to parse ritobin text: {}", e))?;
    
    println!("[BinConverter] Parsed {} objects from text", tree.objects.len());
    
    // Write to binary
    let binary = ltk_bridge::write_bin(&tree)
        .map_err(|e| format!("Failed to write binary: {}", e))?;
    
    println!("[BinConverter] Wrote {} bytes of binary data", binary.len());
    Ok(binary)
}

// Legacy function for backward compatibility with existing code
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
