use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::Manager;

const ICON_PREF_KEY: &str = "custom_icon_path";

/// Write content to file atomically to prevent corruption
fn write_file_atomic(path: &Path, content: &str) -> std::io::Result<()> {
    // Write to a temporary file first
    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, content)?;
    
    // Then atomically rename to the target file
    // On Windows, we need to remove the target file first if it exists
    #[cfg(windows)]
    {
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    
    fs::rename(&temp_path, path)?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct AppInfo {
    pub version: String,
    pub name: String,
    pub author: String,
}

#[tauri::command]
pub async fn get_app_version() -> Result<String, String> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

#[tauri::command]
pub async fn get_custom_icon_path(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    
    let pref_file = config_dir.join("preferences.json");
    
    if !pref_file.exists() {
        return Ok(None);
    }
    
    let content = fs::read_to_string(&pref_file)
        .map_err(|e| format!("Failed to read preferences: {}", e))?;
    
    let prefs: serde_json::Value = match serde_json::from_str(&content) {
        Ok(parsed) => parsed,
        Err(e) => {
            eprintln!("Warning: Failed to parse preferences.json when getting custom icon: {}. Returning None.", e);
            return Ok(None);
        }
    };
    
    Ok(prefs.get(ICON_PREF_KEY)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string()))
}

#[tauri::command]
pub async fn get_custom_icon_data(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let icon_path = get_custom_icon_path(app.clone()).await?;
    
    if let Some(path) = icon_path {
        // Apply to window immediately (persistence fix)
        let _ = update_window_icon(&app, &path);

        // Read the icon file and convert to base64 data URL
        let icon_data = fs::read(&path)
            .map_err(|e| format!("Failed to read icon file: {}", e))?;
        
        // Determine MIME type based on file extension
        let mime_type = if path.to_lowercase().ends_with(".png") {
            "image/png"
        } else if path.to_lowercase().ends_with(".ico") {
            "image/x-icon"
        } else if path.to_lowercase().ends_with(".jpg") || path.to_lowercase().ends_with(".jpeg") {
            "image/jpeg"
        } else {
            "image/png" // default
        };
        
        // Convert to base64
        let base64_data = base64_encode(&icon_data);
        let data_url = format!("data:{};base64,{}", mime_type, base64_data);
        
        Ok(Some(data_url))
    } else {
        Ok(None)
    }
}

fn base64_encode(data: &[u8]) -> String {
    use base64::{Engine as _, engine::general_purpose};
    general_purpose::STANDARD.encode(data)
}

#[tauri::command]
pub async fn set_custom_icon(app: tauri::AppHandle, icon_path: String) -> Result<(), String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config dir: {}", e))?;
    
    let pref_file = config_dir.join("preferences.json");
    
    // Read existing preferences or create new
    let mut prefs: serde_json::Value = if pref_file.exists() {
        let content = fs::read_to_string(&pref_file)
            .map_err(|e| format!("Failed to read preferences: {}", e))?;
        match serde_json::from_str(&content) {
            Ok(parsed) => parsed,
            Err(e) => {
                eprintln!("Warning: Failed to parse preferences.json: {}. Creating new preferences file.", e);
                // Back up the corrupted file
                let backup_file = pref_file.with_extension("json.backup");
                let _ = fs::copy(&pref_file, &backup_file);
                eprintln!("Backed up corrupted preferences to: {:?}", backup_file);
                serde_json::json!({})
            }
        }
    } else {
        serde_json::json!({})
    };
    
    // Update icon path
    prefs[ICON_PREF_KEY] = serde_json::Value::String(icon_path.clone());
    
    // Write back atomically
    let content = serde_json::to_string_pretty(&prefs)
        .map_err(|e| format!("Failed to serialize preferences: {}", e))?;
    
    write_file_atomic(&pref_file, &content)
        .map_err(|e| format!("Failed to write preferences: {}", e))?;
    
    // Update window icon immediately
    update_window_icon(&app, &icon_path)?;
    
    Ok(())
}

pub fn update_window_icon(app: &tauri::AppHandle, icon_path: &str) -> Result<(), String> {
    // Load and decode the image
    let img = image::open(icon_path)
        .map_err(|e| format!("Failed to load icon image: {}", e))?;
    
    // Convert to RGBA8
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    let rgba_data = rgba.into_raw();
    
    // Create Tauri Image
    let icon = tauri::image::Image::new_owned(rgba_data, width, height);
    
    // Update all windows
    if let Some(window) = app.get_webview_window("main") {
        window.set_icon(icon)
            .map_err(|e| format!("Failed to set window icon: {}", e))?;
    }
    
    Ok(())
}

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    opener::open(url)
        .map_err(|e| format!("Failed to open URL: {}", e))
}

const WINDOW_STATE_KEY: &str = "window_state";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WindowState {
    pub width: f64,
    pub height: f64,
    pub x: i32,
    pub y: i32,
    pub maximized: bool,
}

#[tauri::command]
pub async fn save_window_state(app: tauri::AppHandle, state: WindowState) -> Result<(), String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config dir: {}", e))?;
    
    let pref_file = config_dir.join("preferences.json");
    
    // Read existing preferences or create new
    let mut prefs: serde_json::Value = if pref_file.exists() {
        let content = fs::read_to_string(&pref_file)
            .map_err(|e| format!("Failed to read preferences: {}", e))?;
        match serde_json::from_str(&content) {
            Ok(parsed) => parsed,
            Err(e) => {
                eprintln!("Warning: Failed to parse preferences.json: {}. Creating new preferences file.", e);
                // Back up the corrupted file
                let backup_file = pref_file.with_extension("json.backup");
                let _ = fs::copy(&pref_file, &backup_file);
                eprintln!("Backed up corrupted preferences to: {:?}", backup_file);
                serde_json::json!({})
            }
        }
    } else {
        serde_json::json!({})
    };
    
    // Update window state
    prefs[WINDOW_STATE_KEY] = serde_json::to_value(state.clone())
        .map_err(|e| format!("Failed to serialize window state: {}", e))?;
    
    // Write back atomically
    let content = serde_json::to_string_pretty(&prefs)
        .map_err(|e| format!("Failed to serialize preferences: {}", e))?;
    
    write_file_atomic(&pref_file, &content)
        .map_err(|e| format!("Failed to write preferences: {}", e))?;
    
    Ok(())
}

#[tauri::command]
pub async fn get_window_state(app: tauri::AppHandle) -> Result<Option<WindowState>, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    
    let pref_file = config_dir.join("preferences.json");
    
    if !pref_file.exists() {
        return Ok(None);
    }
    
    let content = fs::read_to_string(&pref_file)
        .map_err(|e| format!("Failed to read preferences: {}", e))?;
    
    let prefs: serde_json::Value = match serde_json::from_str(&content) {
        Ok(parsed) => parsed,
        Err(e) => {
            eprintln!("Warning: Failed to parse preferences.json when getting window state: {}. Returning None.", e);
            return Ok(None);
        }
    };
    
    Ok(prefs.get(WINDOW_STATE_KEY)
        .and_then(|v| serde_json::from_value(v.clone()).ok()))
}

#[tauri::command]
pub async fn get_preference(app: tauri::AppHandle, key: String, default_value: String) -> Result<String, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    
    let pref_file = config_dir.join("preferences.json");
    
    if !pref_file.exists() {
        return Ok(default_value);
    }
    
    let content = fs::read_to_string(&pref_file)
        .map_err(|e| format!("Failed to read preferences: {}", e))?;
    
    let prefs: serde_json::Value = match serde_json::from_str(&content) {
        Ok(parsed) => parsed,
        Err(e) => {
            eprintln!("Warning: Failed to parse preferences.json when getting '{}': {}. Using default value.", key, e);
            // Return default instead of failing
            return Ok(default_value);
        }
    };
    
    let value = prefs.get(&key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| default_value.clone());
    
    Ok(value)
}

#[tauri::command]
pub async fn set_preference(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config dir: {}", e))?;
    
    let pref_file = config_dir.join("preferences.json");
    
    // Read existing preferences or create new
    let mut prefs: serde_json::Value = if pref_file.exists() {
        let content = fs::read_to_string(&pref_file)
            .map_err(|e| format!("Failed to read preferences: {}", e))?;
        match serde_json::from_str(&content) {
            Ok(parsed) => parsed,
            Err(e) => {
                eprintln!("Warning: Failed to parse preferences.json: {}. Creating new preferences file.", e);
                // Back up the corrupted file
                let backup_file = pref_file.with_extension("json.backup");
                let _ = fs::copy(&pref_file, &backup_file);
                eprintln!("Backed up corrupted preferences to: {:?}", backup_file);
                serde_json::json!({})
            }
        }
    } else {
        serde_json::json!({})
    };
    
    // Update preference
    prefs[key.clone()] = serde_json::Value::String(value.clone());
    
    // Write back atomically
    let content = serde_json::to_string_pretty(&prefs)
        .map_err(|e| format!("Failed to serialize preferences: {}", e))?;
    
    write_file_atomic(&pref_file, &content)
        .map_err(|e| format!("Failed to write preferences: {}", e))?;
    
    Ok(())
}

const RECENT_FILES_KEY: &str = "recent_files";
const MAX_RECENT_FILES: usize = 10;

#[tauri::command]
pub async fn get_recent_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    
    let pref_file = config_dir.join("preferences.json");
    
    if !pref_file.exists() {
        return Ok(Vec::new());
    }
    
    let content = fs::read_to_string(&pref_file)
        .map_err(|e| format!("Failed to read preferences: {}", e))?;
    
    let prefs: serde_json::Value = match serde_json::from_str(&content) {
        Ok(parsed) => parsed,
        Err(e) => {
            eprintln!("Warning: Failed to parse preferences.json when getting recent files: {}. Returning empty list.", e);
            return Ok(Vec::new());
        }
    };
    
    Ok(prefs.get(RECENT_FILES_KEY)
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_else(Vec::new))
}

#[tauri::command]
pub async fn add_recent_file(app: tauri::AppHandle, path: String) -> Result<Vec<String>, String> {
    let mut recent = get_recent_files(app.clone()).await?;
    
    // Remove if already exists
    recent.retain(|p| p.to_lowercase() != path.to_lowercase());
    
    // Add to front
    recent.insert(0, path);
    
    // Keep only MAX_RECENT_FILES
    recent.truncate(MAX_RECENT_FILES);
    
    // Save back
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config dir: {}", e))?;
    
    let pref_file = config_dir.join("preferences.json");
    
    let mut prefs: serde_json::Value = if pref_file.exists() {
        let content = fs::read_to_string(&pref_file)
            .map_err(|e| format!("Failed to read preferences: {}", e))?;
        match serde_json::from_str(&content) {
            Ok(parsed) => parsed,
            Err(e) => {
                eprintln!("Warning: Failed to parse preferences.json: {}. Creating new preferences file.", e);
                // Back up the corrupted file
                let backup_file = pref_file.with_extension("json.backup");
                let _ = fs::copy(&pref_file, &backup_file);
                eprintln!("Backed up corrupted preferences to: {:?}", backup_file);
                serde_json::json!({})
            }
        }
    } else {
        serde_json::json!({})
    };
    
    prefs[RECENT_FILES_KEY] = serde_json::to_value(&recent)
        .map_err(|e| format!("Failed to serialize recent files: {}", e))?;
    
    let content = serde_json::to_string_pretty(&prefs)
        .map_err(|e| format!("Failed to serialize preferences: {}", e))?;
    
    write_file_atomic(&pref_file, &content)
        .map_err(|e| format!("Failed to write preferences: {}", e))?;
    
    Ok(recent)
}
