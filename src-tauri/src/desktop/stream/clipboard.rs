use std::time::Duration;
use windows::core::w;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, SetClipboardData};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE};

const UNICODE_TEXT: u32 = 13;
const MAX_CHARS: usize = 200_000;

fn open(owner: Option<HWND>) -> Result<(), String> {
    for _ in 0..10 {
        if unsafe { OpenClipboard(owner) }.is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Err("otra app está usando el portapapeles de la PC; probá de nuevo".into())
}

pub fn read() -> Result<String, String> {
    open(None)?;
    let text = unsafe {
        if IsClipboardFormatAvailable(UNICODE_TEXT).is_err() {
            String::new()
        } else {
            match GetClipboardData(UNICODE_TEXT) {
                Ok(handle) => {
                    let global = HGLOBAL(handle.0);
                    let ptr = GlobalLock(global) as *const u16;
                    if ptr.is_null() {
                        String::new()
                    } else {
                        let mut len = 0usize;
                        let capacity = (GlobalSize(global) / 2).min(MAX_CHARS);
                        while len < capacity && *ptr.add(len) != 0 {
                            len += 1;
                        }
                        let value = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
                        let _ = GlobalUnlock(global);
                        value
                    }
                }
                Err(_) => String::new(),
            }
        }
    };
    unsafe {
        let _ = CloseClipboard();
    }
    Ok(text)
}

pub fn write(text: &str) -> Result<(), String> {
    let mut units: Vec<u16> = text.chars().take(MAX_CHARS).collect::<String>().replace("\r\n", "\n").replace('\n', "\r\n").encode_utf16().collect();
    units.push(0);
    // EmptyClipboard + SetClipboardData need a non-null clipboard owner.
    let owner = unsafe { CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), w!("GuilleCode clipboard"), WINDOW_STYLE(0), 0, 0, 0, 0, Some(HWND_MESSAGE), None, None, None) }.map_err(|e| e.to_string())?;
    if let Err(e) = open(Some(owner)) {
        unsafe { let _ = DestroyWindow(owner); }
        return Err(e);
    }
    let result = unsafe {
        let _ = EmptyClipboard();
        match GlobalAlloc(GMEM_MOVEABLE, units.len() * 2) {
            Ok(global) => {
                let ptr = GlobalLock(global) as *mut u16;
                if ptr.is_null() {
                    let _ = GlobalFree(Some(global));
                    Err("Windows no dejó reservar memoria para el portapapeles".to_string())
                } else {
                    std::ptr::copy_nonoverlapping(units.as_ptr(), ptr, units.len());
                    let _ = GlobalUnlock(global);
                    match SetClipboardData(UNICODE_TEXT, Some(HANDLE(global.0))) {
                        Ok(_) => Ok(()),
                        Err(e) => {
                            let _ = GlobalFree(Some(global));
                            Err(format!("no se pudo escribir el portapapeles: {}", e.message()))
                        }
                    }
                }
            }
            Err(e) => Err(format!("no se pudo escribir el portapapeles: {}", e.message())),
        }
    };
    unsafe {
        let _ = CloseClipboard();
        let _ = DestroyWindow(owner);
    }
    result
}

const SAVE_MAX: usize = 64 * 1024 * 1024;

pub struct Saved(Vec<(u32, Vec<u8>)>);

fn handle_format(format: u32) -> bool {
    matches!(format, 2 | 3 | 9 | 14 | 0x80 | 0x82 | 0x8E) || (0x200..=0x3FF).contains(&format)
}

pub fn save() -> Result<Saved, String> {
    open(None)?;
    let mut out = Vec::new();
    unsafe {
        let mut format = 0u32;
        loop {
            format = EnumClipboardFormats(format);
            if format == 0 {
                break;
            }
            if handle_format(format) {
                continue;
            }
            let Ok(handle) = GetClipboardData(format) else { continue };
            let global = HGLOBAL(handle.0);
            let size = GlobalSize(global);
            let ptr = GlobalLock(global) as *const u8;
            if ptr.is_null() {
                continue;
            }
            if size > 0 && size <= SAVE_MAX {
                out.push((format, std::slice::from_raw_parts(ptr, size).to_vec()));
            }
            let _ = GlobalUnlock(global);
        }
        let _ = CloseClipboard();
    }
    Ok(Saved(out))
}

pub fn restore(saved: Saved) -> Result<(), String> {
    let owner = unsafe { CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), w!("GuilleCode clipboard"), WINDOW_STYLE(0), 0, 0, 0, 0, Some(HWND_MESSAGE), None, None, None) }.map_err(|e| e.to_string())?;
    if let Err(e) = open(Some(owner)) {
        unsafe {
            let _ = DestroyWindow(owner);
        }
        return Err(e);
    }
    unsafe {
        let _ = EmptyClipboard();
        for (format, bytes) in &saved.0 {
            let Ok(global) = GlobalAlloc(GMEM_MOVEABLE, bytes.len()) else { continue };
            let ptr = GlobalLock(global) as *mut u8;
            if ptr.is_null() {
                let _ = GlobalFree(Some(global));
                continue;
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
            let _ = GlobalUnlock(global);
            if SetClipboardData(*format, Some(HANDLE(global.0))).is_err() {
                let _ = GlobalFree(Some(global));
            }
        }
        let _ = CloseClipboard();
        let _ = DestroyWindow(owner);
    }
    Ok(())
}
