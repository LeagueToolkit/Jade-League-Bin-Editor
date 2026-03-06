/// Extra commands: file association, autostart, updater
use serde::{Deserialize, Serialize};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use futures::StreamExt;

// ============================================================
// File Association (Windows Registry)
// ============================================================

#[cfg(windows)]
fn get_exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("Failed to get exe path: {}", e))
}

/// Notify Windows shell of association changes
#[cfg(windows)]
fn notify_shell_change() {
    // SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, NULL, NULL)
    unsafe {
        type SHChangeNotifyFn = unsafe extern "system" fn(i32, u32, *const std::ffi::c_void, *const std::ffi::c_void);
        if let Ok(lib) = libloading::Library::new("shell32.dll") {
            if let Ok(func) = lib.get::<SHChangeNotifyFn>(b"SHChangeNotify") {
                func(0x08000000i32, 0x0000u32, std::ptr::null(), std::ptr::null());
            }
        }
    }
}

/// Register .bin file association in Windows registry (HKCU, no admin needed)
#[tauri::command]
pub async fn register_bin_association() -> Result<(), String> {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let exe_path = get_exe_path()?;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        let (class_key, _) = hkcu
            .create_subkey(r"Software\Classes\JadeBinFile")
            .map_err(|e| format!("Failed to create class key: {}", e))?;
        class_key.set_value("", &"Jade League Bin File")
            .map_err(|e| format!("Failed to set class name: {}", e))?;

        let (icon_key, _) = class_key
            .create_subkey("DefaultIcon")
            .map_err(|e| format!("Failed to create icon key: {}", e))?;
        icon_key.set_value("", &format!("{},0", exe_path))
            .map_err(|e| format!("Failed to set icon: {}", e))?;

        let (cmd_key, _) = class_key
            .create_subkey(r"shell\open\command")
            .map_err(|e| format!("Failed to create command key: {}", e))?;
        cmd_key.set_value("", &format!("\"{}\" \"%1\"", exe_path))
            .map_err(|e| format!("Failed to set open command: {}", e))?;

        let (ext_key, _) = hkcu
            .create_subkey(r"Software\Classes\.bin")
            .map_err(|e| format!("Failed to create .bin key: {}", e))?;
        ext_key.set_value("", &"JadeBinFile")
            .map_err(|e| format!("Failed to set .bin default: {}", e))?;

        notify_shell_change();
        println!("[FileAssoc] Registered .bin association for: {}", exe_path);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("File association is only supported on Windows".to_string())
    }
}

/// Unregister .bin file association from Windows registry
#[tauri::command]
pub async fn unregister_bin_association() -> Result<(), String> {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        if let Ok(ext_key) = hkcu.open_subkey(r"Software\Classes\.bin") {
            let current_val: Result<String, _> = ext_key.get_value("");
            if current_val.ok().as_deref() == Some("JadeBinFile") {
                let _ = hkcu.delete_subkey_all(r"Software\Classes\.bin");
            }
        }
        let _ = hkcu.delete_subkey_all(r"Software\Classes\JadeBinFile");

        notify_shell_change();
        println!("[FileAssoc] Unregistered .bin association");
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("File association is only supported on Windows".to_string())
    }
}

/// Check if .bin file association is registered for Jade
#[tauri::command]
pub async fn get_bin_association_status() -> bool {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(ext_key) = hkcu.open_subkey(r"Software\Classes\.bin") {
            let val: Result<String, _> = ext_key.get_value("");
            return val.ok().as_deref() == Some("JadeBinFile");
        }
        false
    }
    #[cfg(not(windows))]
    {
        false
    }
}

// ============================================================
// Autostart
// ============================================================

/// Enable or disable start at startup
#[tauri::command]
pub async fn toggle_autostart(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let autolaunch = app.autolaunch();
    if enable {
        autolaunch.enable().map_err(|e| format!("Failed to enable autostart: {}", e))?;
        println!("[Autostart] Enabled startup");
    } else {
        autolaunch.disable().map_err(|e| format!("Failed to disable autostart: {}", e))?;
        println!("[Autostart] Disabled startup");
    }
    crate::app_commands::set_preference(
        app,
        "StartAtStartup".to_string(),
        if enable { "True" } else { "False" }.to_string(),
    ).await
}

/// Check if autostart is currently enabled
#[tauri::command]
pub async fn get_autostart_status(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

// ============================================================
// Updater
// ============================================================

const GITHUB_REPO: &str = "LeagueToolkit/Jade-League-Bin-Editor";
const RELEASES_URL: &str = "https://github.com/LeagueToolkit/Jade-League-Bin-Editor/releases/latest";
const INSTALLER_PATTERN: &str = "_x64-setup.exe";

/// Cached release JSON so we don't hit the API twice (check → download).
static CACHED_RELEASE: Lazy<Mutex<Option<serde_json::Value>>> =
    Lazy::new(|| Mutex::new(None));

/// Holds the path to the downloaded installer so it can be run separately.
static INSTALLER_PATH: Lazy<Mutex<Option<std::path::PathBuf>>> =
    Lazy::new(|| Mutex::new(None));

#[derive(Clone, Serialize)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub available: bool,
    pub version: String,
    pub notes: String,
    pub release_url: String,
}

fn is_newer_version(remote: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.split('.').filter_map(|p| p.parse().ok()).collect()
    };
    parse(remote) > parse(current)
}

fn make_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("jade-app")
        .build()
        .unwrap_or_default()
}

async fn fetch_latest_release() -> Result<serde_json::Value, String> {
    let url = format!("https://api.github.com/repos/{}/releases/latest", GITHUB_REPO);
    let resp = make_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let status = resp.status();
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("GitHub API rate limit reached — try again in a few minutes".to_string());
    }
    if !status.is_success() {
        return Err(format!("GitHub API returned {}", status));
    }

    resp.json().await.map_err(|e| format!("Failed to parse response: {}", e))
}

/// Clean up old Jade installer files from temp.
fn cleanup_old_installers(keep: Option<&std::path::Path>) {
    let temp = std::env::temp_dir();
    if let Ok(entries) = std::fs::read_dir(&temp) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                let lower = name.to_lowercase();
                if lower.starts_with("jade_") && lower.ends_with("_x64-setup.exe") {
                    if keep.map_or(true, |k| k != path) {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
    }
    // Also clean up the update bat script
    let _ = std::fs::remove_file(temp.join("jade_update.bat"));
}

/// Check GitHub releases API for a newer version.
/// Caches the release JSON for use by start_update_download.
#[tauri::command]
pub async fn check_for_update() -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION");
    let json = fetch_latest_release().await?;

    let tag = json["tag_name"].as_str().unwrap_or("").trim_start_matches('v').to_string();
    let notes = json["body"].as_str().unwrap_or("").to_string();
    let release_url = json["html_url"].as_str().unwrap_or(RELEASES_URL).to_string();
    let available = is_newer_version(&tag, current);

    // Cache the release so download doesn't need another API call
    if available {
        *CACHED_RELEASE.lock() = Some(json);
    }

    Ok(UpdateInfo {
        available,
        version: tag,
        notes,
        release_url,
    })
}

/// Stream-download the installer to disk, emitting progress events.
/// Uses the cached release from check_for_update to avoid a second API call.
#[tauri::command]
pub async fn start_update_download(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    use std::io::Write;

    // Use cached release, fall back to fetching if cache is empty
    let json = CACHED_RELEASE.lock().take()
        .ok_or(())
        .or_else(|_| futures::executor::block_on(fetch_latest_release()))?;

    let assets = json["assets"].as_array()
        .ok_or("No assets found in release")?;

    // Match specifically the NSIS x64 setup exe
    let installer = assets.iter()
        .find(|a| {
            let name = a["name"].as_str().unwrap_or("").to_lowercase();
            name.ends_with(INSTALLER_PATTERN)
        })
        .ok_or("No x64 NSIS installer found in the latest release")?;

    let download_url = installer["browser_download_url"].as_str()
        .ok_or("Installer asset has no download URL")?;
    let filename = installer["name"].as_str().unwrap_or("jade-setup.exe");
    let installer_path = std::env::temp_dir().join(filename);

    // Clean up old installers before downloading new one
    cleanup_old_installers(None);

    let resp = make_client()
        .get(download_url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;

    // Stream directly to file instead of buffering in memory
    let mut file = std::fs::File::create(&installer_path)
        .map_err(|e| format!("Failed to create installer file: {}", e))?;

    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download error: {}", e))?;
        downloaded += chunk.len() as u64;
        file.write_all(&chunk)
            .map_err(|e| format!("Failed to write to installer file: {}", e))?;
        let _ = app.emit("update-download-progress", DownloadProgress { downloaded, total });
    }

    file.flush().map_err(|e| format!("Failed to flush installer file: {}", e))?;
    drop(file);

    *INSTALLER_PATH.lock() = Some(installer_path);
    Ok(())
}

/// Run the previously downloaded installer.
///
/// - silent=true:  runs NSIS with /S, waits for it to finish, then relaunches Jade.
/// - silent=false: exits Jade first, then launches the installer normally so the
///                 user sees the wizard (which upgrades in-place without uninstalling).
#[tauri::command]
pub async fn run_installer(silent: bool, app: tauri::AppHandle) -> Result<(), String> {
    let path = INSTALLER_PATH.lock().clone()
        .ok_or("No installer has been downloaded yet")?;

    if !path.exists() {
        return Err("Installer file no longer exists on disk".to_string());
    }

    let install_dir = std::env::current_exe()
        .map(|p| p.parent().unwrap_or(std::path::Path::new(".")).to_path_buf())
        .unwrap_or_default();

    let exe_path = install_dir.join("jade-rust.exe");

    if silent {
        // Silent: write a bat that closes Jade, runs installer silently, relaunches
        let bat_content = format!(
            "@echo off\r\n\
             :wait\r\n\
             tasklist /FI \"IMAGENAME eq jade-rust.exe\" 2>NUL | find /I \"jade-rust.exe\" >NUL\r\n\
             if not errorlevel 1 (\r\n\
                 timeout /t 1 /nobreak >nul\r\n\
                 goto wait\r\n\
             )\r\n\
             \"{}\" /S /D={}\r\n\
             start \"\" \"{}\"\r\n\
             del \"%~f0\"\r\n",
            path.display(),
            install_dir.display(),
            exe_path.display(),
        );
        let bat_path = std::env::temp_dir().join("jade_update.bat");
        std::fs::write(&bat_path, &bat_content)
            .map_err(|e| format!("Failed to write update script: {}", e))?;

        std::process::Command::new("cmd")
            .args(["/C", "start", "", "/min", &bat_path.to_string_lossy()])
            .spawn()
            .map_err(|e| format!("Failed to launch update script: {}", e))?;

        app.exit(0);
    } else {
        // Non-silent: write a bat that closes Jade, runs installer normally (upgrade in place)
        let bat_content = format!(
            "@echo off\r\n\
             :wait\r\n\
             tasklist /FI \"IMAGENAME eq jade-rust.exe\" 2>NUL | find /I \"jade-rust.exe\" >NUL\r\n\
             if not errorlevel 1 (\r\n\
                 timeout /t 1 /nobreak >nul\r\n\
                 goto wait\r\n\
             )\r\n\
             \"{}\" /D={}\r\n\
             del \"%~f0\"\r\n",
            path.display(),
            install_dir.display(),
        );
        let bat_path = std::env::temp_dir().join("jade_update.bat");
        std::fs::write(&bat_path, &bat_content)
            .map_err(|e| format!("Failed to write update script: {}", e))?;

        std::process::Command::new("cmd")
            .args(["/C", "start", "", "/min", &bat_path.to_string_lossy()])
            .spawn()
            .map_err(|e| format!("Failed to launch update script: {}", e))?;

        app.exit(0);
    }

    Ok(())
}
