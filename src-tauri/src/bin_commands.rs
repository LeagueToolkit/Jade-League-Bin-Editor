use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use crate::ritobin::{self, HashManager, are_hashes_preloaded};
use std::env;
use std::fs;

#[derive(Debug, Serialize, Deserialize)]
pub struct BinInfo {
    pub success: bool,
    pub message: String,
    pub data: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BatchConvertResult {
    pub path: String,
    pub success: bool,
    pub content: Option<String>,
    pub error: Option<String>,
}

fn get_hash_dir() -> Result<PathBuf, String> {
    let appdata = env::var("APPDATA").map_err(|e| format!("Failed to get APPDATA: {}", e))?;
    let path = PathBuf::from(appdata).join("RitoShark").join("Jade").join("hashes");
    Ok(path)
}

#[tauri::command]
pub async fn convert_bin_to_text(input_path: String, output_path: String) -> Result<BinInfo, String> {
    let data = std::fs::read(&input_path)
        .map_err(|e| format!("Failed to read input file: {}", e))?;
    
    let hash_dir = get_hash_dir().ok();
    
    let text = ritobin::convert_bin_to_text(&data, hash_dir)
        .map_err(|e| format!("Conversion failed: {}", e))?;
    
    // Write to output file
    std::fs::write(&output_path, &text)
        .map_err(|e| format!("Failed to write output file: {}", e))?;
    
    Ok(BinInfo {
        success: true,
        message: format!("Converted: {}", input_path),
        data: Some(text),
    })
}

#[tauri::command]
pub async fn convert_text_to_bin(text_content: String, output_path: String) -> Result<BinInfo, String> {
    let bin_data = ritobin::convert_text_to_bin(text_content)
        .map_err(|e| format!("Conversion failed: {}", e))?;
    
    std::fs::write(&output_path, &bin_data)
        .map_err(|e| format!("Failed to write output file: {}", e))?;
    
    Ok(BinInfo {
        success: true,
        message: format!("Saved: {}", output_path),
        data: None,
    })
}

/// Batch convert multiple bin files to text.
/// Loads hashes once and converts all files - much faster when hashes aren't preloaded.
#[tauri::command]
pub async fn batch_convert_bins(input_paths: Vec<String>) -> Result<Vec<BatchConvertResult>, String> {
    if input_paths.is_empty() {
        return Ok(vec![]);
    }
    
    let start = std::time::Instant::now();
    println!("[BatchConvert] Converting {} files", input_paths.len());
    
    // Load hashes once if not preloaded
    let hash_manager = if are_hashes_preloaded() {
        println!("[BatchConvert] Using preloaded hashes");
        HashManager::from_preloaded()
    } else {
        println!("[BatchConvert] Loading hashes for batch...");
        let mut hm = HashManager::new();
        if let Ok(hash_dir) = get_hash_dir() {
            let _ = hm.load(hash_dir);
        }
        hm
    };
    
    let mut results = Vec::with_capacity(input_paths.len());
    
    for path in input_paths {
        let result = convert_single_bin(&path, &hash_manager);
        results.push(result);
    }
    
    println!("[BatchConvert] Completed {} files in {:?}", results.len(), start.elapsed());
    
    Ok(results)
}

/// Convert a single bin file using a shared HashManager
fn convert_single_bin(input_path: &str, hash_manager: &HashManager) -> BatchConvertResult {
    // Read file
    let data = match std::fs::read(input_path) {
        Ok(d) => d,
        Err(e) => return BatchConvertResult {
            path: input_path.to_string(),
            success: false,
            content: None,
            error: Some(format!("Failed to read file: {}", e)),
        },
    };
    
    // Convert using the shared hash manager
    match convert_bin_with_manager(&data, hash_manager) {
        Ok(text) => BatchConvertResult {
            path: input_path.to_string(),
            success: true,
            content: Some(text),
            error: None,
        },
        Err(e) => BatchConvertResult {
            path: input_path.to_string(),
            success: false,
            content: None,
            error: Some(e),
        },
    }
}

/// Convert bin data to text using a specific HashManager instance
fn convert_bin_with_manager(bin_data: &[u8], hash_manager: &HashManager) -> Result<String, String> {
    use crate::ritobin::{BinReader, BinTextWriter, BinJsonReader, BinTextReader};
    
    // Check if the data is UTF-8 text
    if let Ok(text) = std::str::from_utf8(bin_data) {
        let trimmed = text.trim_start();
        
        // Already in text format
        if trimmed.starts_with("#PROP") || trimmed.starts_with("#PTCH") {
            return Ok(text.to_string());
        }
        
        // JSON format
        if trimmed.starts_with('{') {
            let json_reader = BinJsonReader::new(text.to_string());
            let mut bin = json_reader.read()?;
            hash_manager.unhash_bin(&mut bin);
            let mut writer = BinTextWriter::new();
            return Ok(writer.write(&bin));
        }
        
        // Text format without header
        if let Some(first_line) = text.lines().next() {
            let first_line = first_line.trim();
            if first_line.contains(':') && first_line.contains('=') {
                let mut text_reader = BinTextReader::new(text.to_string());
                if let Ok(mut bin) = text_reader.read_bin() {
                    hash_manager.unhash_bin(&mut bin);
                    let mut writer = BinTextWriter::new();
                    return Ok(writer.write(&bin));
                }
            }
        }
    }
    
    // Binary format
    let mut reader = BinReader::new(bin_data);
    match reader.read() {
        Ok(mut bin) => {
            hash_manager.unhash_bin(&mut bin);
            let mut writer = BinTextWriter::new();
            Ok(writer.write(&bin))
        }
        Err(e) => {
            // Try text reader as fallback
            if let Ok(text) = std::str::from_utf8(bin_data) {
                let mut text_reader = BinTextReader::new(text.to_string());
                if let Ok(mut bin) = text_reader.read_bin() {
                    hash_manager.unhash_bin(&mut bin);
                    let mut writer = BinTextWriter::new();
                    return Ok(writer.write(&bin));
                }
            }
            Err(e)
        }
    }
}

/// Searches for a bin file by name in the DATA folder hierarchy.
/// Starts from the given base directory and searches recursively.
#[tauri::command]
pub async fn find_linked_bin_file(base_directory: String, file_name: String) -> Result<Option<String>, String> {
    let base_path = Path::new(&base_directory);
    
    // Look for DATA folder in the path hierarchy
    let data_folder = find_data_folder(base_path);
    
    let search_root = data_folder.unwrap_or_else(|| base_path.to_path_buf());
    
    // Search for the file recursively
    match search_file_recursively(&search_root, &file_name, 0, 5) {
        Some(path) => Ok(Some(path.to_string_lossy().to_string())),
        None => Ok(None),
    }
}

/// Walks up the directory tree to find a DATA folder
fn find_data_folder(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start.to_path_buf());
    
    for _ in 0..10 {
        if let Some(ref dir) = current {
            // Check if there's a DATA subdirectory
            let potential_data = dir.join("DATA");
            if potential_data.exists() && potential_data.is_dir() {
                return Some(potential_data);
            }
            
            // Check if current folder IS the DATA folder
            if let Some(name) = dir.file_name() {
                if name.to_string_lossy().eq_ignore_ascii_case("DATA") {
                    return Some(dir.clone());
                }
            }
            
            // Check for lowercase 'data' as well
            let potential_data_lower = dir.join("data");
            if potential_data_lower.exists() && potential_data_lower.is_dir() {
                return Some(potential_data_lower);
            }
            
            current = dir.parent().map(|p| p.to_path_buf());
        } else {
            break;
        }
    }
    
    None
}

/// Recursively searches for a file by name
fn search_file_recursively(directory: &Path, file_name: &str, current_depth: u32, max_depth: u32) -> Option<PathBuf> {
    if current_depth > max_depth {
        return None;
    }
    
    // Check for file in current directory
    let file_path = directory.join(file_name);
    if file_path.exists() && file_path.is_file() {
        return Some(file_path);
    }
    
    // Search subdirectories
    if let Ok(entries) = fs::read_dir(directory) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(found) = search_file_recursively(&path, file_name, current_depth + 1, max_depth) {
                    return Some(found);
                }
            }
        }
    }
    
    None
}
