//! Windows taskbar progress reporting via `ITaskbarList3`.
//!
//! Windows ships a built-in API for surfacing per-window progress on
//! the taskbar icon (the green fill behind the icon, plus the small
//! state colour swatches for paused/error). We expose it as a single
//! Tauri command so the Extract Files view can keep the taskbar in
//! sync with its own status bar.
//!
//! The COM call runs on the blocking pool because the Tokio IPC
//! runtime would otherwise block on `CoCreateInstance` for the few ms
//! the shell takes to hand back the proxy. The HWND is sent across as
//! an `isize` since the raw pointer wrapper isn't `Send`.

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;
#[cfg(target_os = "windows")]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Shell::{
    ITaskbarList3, TaskbarList, TBPFLAG, TBPF_ERROR, TBPF_INDETERMINATE, TBPF_NOPROGRESS,
    TBPF_NORMAL, TBPF_PAUSED,
};

/// Set the taskbar icon's progress state and value.
///
/// `state`:
/// - `"no_progress"` — clear the indicator
/// - `"indeterminate"` — running marquee (used while preparing)
/// - `"normal"` — green fill (default during extraction)
/// - `"paused"` — yellow
/// - `"error"` — red
///
/// `completed` / `total` are ignored unless `state ∈ {normal, paused,
/// error}` — the indeterminate / no-progress states have no fill.
#[tauri::command]
pub async fn set_taskbar_progress(
    window: tauri::WebviewWindow,
    state: String,
    completed: u64,
    total: u64,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd_raw: isize = window
            .hwnd()
            .map_err(|e| format!("Failed to get HWND: {}", e))?
            .0 as isize;

        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            unsafe {
                // Idempotent on subsequent calls; the runtime returns
                // S_FALSE when the apartment was already initialised.
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

                let tb: ITaskbarList3 = CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER)
                    .map_err(|e| format!("CoCreateInstance(TaskbarList): {}", e))?;
                tb.HrInit().map_err(|e| format!("ITaskbarList::HrInit: {}", e))?;

                let hwnd = HWND(hwnd_raw as *mut _);
                let flag: TBPFLAG = match state.as_str() {
                    "no_progress" => TBPF_NOPROGRESS,
                    "indeterminate" => TBPF_INDETERMINATE,
                    "paused" => TBPF_PAUSED,
                    "error" => TBPF_ERROR,
                    _ => TBPF_NORMAL,
                };
                tb.SetProgressState(hwnd, flag)
                    .map_err(|e| format!("SetProgressState: {}", e))?;
                if matches!(state.as_str(), "normal" | "paused" | "error") && total > 0 {
                    tb.SetProgressValue(hwnd, completed, total)
                        .map_err(|e| format!("SetProgressValue: {}", e))?;
                }
            }
            Ok(())
        })
        .await
        .map_err(|e| format!("Taskbar task join failed: {}", e))??;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, state, completed, total);
    }
    Ok(())
}
