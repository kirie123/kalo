//! Only this module knows the native directory-alias representation.
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub fn alias(target: &Path, path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        // junction::create may leave its empty directory when setting the reparse point fails.
        if fs::symlink_metadata(path).is_ok() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "兼容入口已存在",
            ));
        }
        let result = junction::create(target, path);
        if result.is_err() {
            let _ = fs::remove_dir(path);
        }
        result
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, path)
    }
}

pub fn link_target(path: &Path) -> io::Result<Option<PathBuf>> {
    let meta = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            // get_target also handles dangling junctions; exists follows their target.
            if let Ok(target) = junction::get_target(path) {
                return Ok(Some(target));
            }
        }
    }
    if meta.file_type().is_symlink() {
        fs::read_link(path).map(Some)
    } else {
        Ok(None)
    }
}

pub fn copy_link(from: &Path, to: &Path, target: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        if junction::get_target(from).is_ok() {
            return junction::create(target, to);
        }
        use std::os::windows::fs::FileTypeExt;
        use std::os::windows::fs::{symlink_dir, symlink_file};
        if fs::symlink_metadata(from)?.file_type().is_symlink_dir() {
            symlink_dir(target, to)
        } else {
            symlink_file(target, to)
        }
    }
    #[cfg(unix)]
    {
        let _ = from;
        std::os::unix::fs::symlink(target, to)
    }
}

/// Never replace a destination created after the preflight, even if it is empty.
pub fn rename_new(from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
        }
        let wide = |path: &Path| -> io::Result<Vec<u16>> {
            let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
            if value.contains(&0) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "路径包含空字符",
                ));
            }
            value.push(0);
            Ok(value)
        };
        let from = wide(from)?;
        let to = wide(to)?;
        // No MOVEFILE_REPLACE_EXISTING. std::fs::rename may replace an empty directory.
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } != 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    #[cfg(target_os = "macos")]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        extern "C" {
            fn renamex_np(
                from: *const std::ffi::c_char,
                to: *const std::ffi::c_char,
                flags: u32,
            ) -> i32;
        }
        let from = CString::new(from.as_os_str().as_bytes())?;
        let to = CString::new(to.as_os_str().as_bytes())?;
        // Darwin RENAME_EXCL: fail atomically when the destination already exists.
        if unsafe { renamex_np(from.as_ptr(), to.as_ptr(), 0x4) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (from, to);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "数据目录迁移当前支持 Windows 和 macOS",
        ))
    }
}

pub fn canonical(path: &Path) -> io::Result<PathBuf> {
    let path = fs::canonicalize(path)?;
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return Ok(PathBuf::from(format!(r"\\{rest}")));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(rest));
        }
    }
    Ok(path)
}

pub fn remove_alias(path: &Path, expected: &Path) -> Result<(), String> {
    let actual = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if actual != fs::canonicalize(expected).map_err(|e| e.to_string())?
        || link_target(path).map_err(|e| e.to_string())?.is_none()
    {
        return Err(format!(
            "兼容入口已被改动，保留现场，请检查 {}",
            path.display()
        ));
    }
    #[cfg(windows)]
    {
        junction::delete(path).map_err(|e| e.to_string())?;
        fs::remove_dir(path).map_err(|e| e.to_string())?;
    }
    #[cfg(unix)]
    {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
