mod bin_commands;
mod app_commands;
mod hash_commands;
mod ritobin;

use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Load and apply custom icon on startup if one was saved
            let app_handle = app.handle().clone();
            
            // Use blocking task to ensure icon is applied before window shows
            std::thread::spawn(move || {
                // Give the window a moment to be created
                std::thread::sleep(std::time::Duration::from_millis(100));
                
                tauri::async_runtime::block_on(async {
                    if let Ok(Some(icon_path)) = app_commands::get_custom_icon_path(app_handle.clone()).await {
                        // Try multiple times in case window isn't ready yet
                        for i in 0..10 {
                            match apply_saved_icon(&app_handle, &icon_path) {
                                Ok(_) => {
                                    println!("[Icon] Successfully applied saved icon: {}", icon_path);
                                    break;
                                }
                                Err(e) if i < 9 => {
                                    // Retry after a short delay
                                    std::thread::sleep(std::time::Duration::from_millis(50));
                                }
                                Err(e) => {
                                    eprintln!("[Icon] Failed to apply saved icon: {}", e);
                                }
                            }
                        }
                    }
                });
            });
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            bin_commands::convert_bin_to_text,
            bin_commands::convert_text_to_bin,
            bin_commands::batch_convert_bins,
            bin_commands::find_linked_bin_file,
            app_commands::get_app_version,
            app_commands::get_custom_icon_path,
            app_commands::get_custom_icon_data,
            app_commands::set_custom_icon,
            app_commands::open_url,
            app_commands::save_window_state,
            app_commands::get_window_state,
            app_commands::get_preference,
            app_commands::set_preference,
            app_commands::get_recent_files,
            app_commands::add_recent_file,
            hash_commands::check_hashes,
            hash_commands::download_hashes,
            hash_commands::open_hashes_folder,
            hash_commands::preload_hashes,
            hash_commands::get_preload_status,
            hash_commands::unload_hashes,
            hash_commands::convert_hashes_to_binary,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Apply a saved icon to the window on startup
fn apply_saved_icon(app: &tauri::AppHandle, icon_path: &str) -> Result<(), String> {
    
    // Check if file still exists
    if !std::path::Path::new(icon_path).exists() {
        return Err("Icon file no longer exists".to_string());
    }
    
    // Load and decode the image
    let img = image::open(icon_path)
        .map_err(|e| format!("Failed to load icon image: {}", e))?;
    
    // Convert to RGBA8
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    let rgba_data = rgba.into_raw();
    
    // Create Tauri Image
    let icon = tauri::image::Image::new_owned(rgba_data, width, height);
    
    // Update the main window
    if let Some(window) = app.get_webview_window("main") {
        window.set_icon(icon)
            .map_err(|e| format!("Failed to set window icon: {}", e))?;
    }
    
    Ok(())
}
