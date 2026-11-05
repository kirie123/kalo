//! Native file clipboard only. Bitmap bytes come from the paste event.

#[tauri::command(async)]
pub fn clipboard_file_paths() -> Result<Vec<String>, String> {
    platform_paths()
}

#[cfg(windows)]
fn platform_paths() -> Result<Vec<String>, String> {
    use std::ffi::c_void;
    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(owner: *mut c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn IsClipboardFormatAvailable(format: u32) -> i32;
        fn GetClipboardData(format: u32) -> *mut c_void;
    }
    #[link(name = "shell32")]
    extern "system" {
        fn DragQueryFileW(drop: *mut c_void, index: u32, buffer: *mut u16, length: u32) -> u32;
    }
    struct Clipboard;
    impl Drop for Clipboard {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }
    const CF_HDROP: u32 = 15;
    // Handles belong to the clipboard and are used only while it is open.
    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP) == 0 {
            return Ok(Vec::new());
        }
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("剪贴板正在被占用，请重新粘贴文件".into());
        }
        let _guard = Clipboard;
        let drop = GetClipboardData(CF_HDROP);
        if drop.is_null() {
            return Err("无法读取剪贴板文件，请重新复制后粘贴".into());
        }
        let count = DragQueryFileW(drop, u32::MAX, std::ptr::null_mut(), 0);
        let mut paths = Vec::new();
        for index in 0..count {
            let length = DragQueryFileW(drop, index, std::ptr::null_mut(), 0);
            let mut buffer = vec![0u16; length as usize + 1];
            let copied = DragQueryFileW(drop, index, buffer.as_mut_ptr(), length + 1);
            if copied > 0 {
                paths.push(String::from_utf16_lossy(&buffer[..copied as usize]));
            }
        }
        Ok(paths)
    }
}

#[cfg(target_os = "macos")]
fn platform_paths() -> Result<Vec<String>, String> {
    // Fixed script and argument array: no user path is interpolated into code.
    let script = r#"ObjC.import('AppKit');
const urls = $.NSPasteboard.generalPasteboard.readObjectsForClassesOptions(
  $([$.NSURL]), $({NSPasteboardURLReadingFileURLsOnlyKey: true}));
const paths = [];
if (urls) for (let i = 0; i < urls.count; i++) paths.push(ObjC.unwrap(urls.objectAtIndex(i).path));
JSON.stringify(paths);"#;
    let output = std::process::Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", script])
        .output()
        .map_err(|e| format!("无法读取剪贴板文件：{e}"))?;
    if !output.status.success() {
        return Err("无法读取剪贴板文件，请从 Finder 重新复制后粘贴".into());
    }
    serde_json::from_slice(&output.stdout).map_err(|e| format!("剪贴板文件列表无效：{e}"))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn platform_paths() -> Result<Vec<String>, String> {
    Ok(Vec::new())
}
