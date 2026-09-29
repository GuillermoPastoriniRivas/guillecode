use std::time::Duration;
use windows::core::{BOOL, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HDC,
    ROP_CODE, SRCCOPY,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK,
    MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GetAncestor, GetClassNameW, GetForegroundWindow, GetSystemMetrics, GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, PostMessageW, SetForegroundWindow, ShowWindow, GA_ROOT, GWL_EXSTYLE, PW_RENDERFULLCONTENT, SM_CXVIRTUALSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_RESTORE, SW_SHOWNORMAL, WM_CLOSE, WS_EX_TOOLWINDOW,
};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn width(&self) -> i32 {
        self.right - self.left
    }
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
    pub fn center(&self) -> (i32, i32) {
        (self.left + self.width() / 2, self.top + self.height() / 2)
    }
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }
}

impl From<RECT> for Rect {
    fn from(r: RECT) -> Self {
        Rect { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    }
}

#[derive(Clone, Debug)]
pub struct WinInfo {
    pub hwnd: isize,
    pub title: String,
    pub class: String,
    pub pid: u32,
    pub process: String,
    pub rect: Rect,
    pub minimized: bool,
    pub foreground: bool,
}

pub struct Shot {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
    pub origin: (i32, i32),
}

#[derive(Clone, Copy)]
pub enum Button {
    Left,
    Right,
    Middle,
}

pub fn hwnd(raw: isize) -> HWND {
    HWND(raw as *mut _)
}

fn title_of(h: HWND) -> String {
    let mut buf = [0u16; 512];
    let n = unsafe { GetWindowTextW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn class_of(h: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

pub fn process_name(pid: u32) -> String {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size).is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..size as usize]);
        path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string()
    }
}

fn cloaked(h: HWND) -> bool {
    let mut value = 0u32;
    unsafe { DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut value as *mut u32 as *mut _, 4).is_ok() && value != 0 }
}

pub fn bounds(raw: isize) -> Rect {
    let h = hwnd(raw);
    let mut r = RECT::default();
    unsafe {
        if DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut RECT as *mut _, std::mem::size_of::<RECT>() as u32).is_err() {
            let _ = GetWindowRect(h, &mut r);
        }
    }
    r.into()
}

unsafe extern "system" fn collect(h: HWND, lparam: LPARAM) -> BOOL {
    let list = &mut *(lparam.0 as *mut Vec<isize>);
    list.push(h.0 as isize);
    BOOL(1)
}

fn listed(h: HWND) -> bool {
    unsafe {
        if !IsWindowVisible(h).as_bool() || cloaked(h) || GetWindowTextLengthW(h) == 0 {
            return false;
        }
        if GetWindowLongW(h, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0 {
            return false;
        }
    }
    !matches!(class_of(h).as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd")
}

fn info(raw: isize, foreground: isize) -> Option<WinInfo> {
    let h = hwnd(raw);
    if !listed(h) {
        return None;
    }
    let rect = bounds(raw);
    let minimized = unsafe { IsIconic(h).as_bool() };
    if !minimized && (rect.width() <= 1 || rect.height() <= 1) {
        return None;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
    Some(WinInfo { hwnd: raw, title: title_of(h), class: class_of(h), pid, process: process_name(pid), rect, minimized, foreground: raw == foreground })
}

pub fn foreground() -> isize {
    unsafe { GetForegroundWindow() }.0 as isize
}

pub fn windows() -> Vec<WinInfo> {
    let mut raw: Vec<isize> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut raw as *mut Vec<isize> as isize));
    }
    let fg = foreground();
    raw.into_iter().filter_map(|h| info(h, fg)).collect()
}

pub fn window(raw: isize) -> Option<WinInfo> {
    if !exists(raw) {
        return None;
    }
    info(raw, foreground())
}

pub fn exists(raw: isize) -> bool {
    unsafe { IsWindow(Some(hwnd(raw))).as_bool() }
}

pub fn root_of(raw: isize) -> isize {
    let root = unsafe { GetAncestor(hwnd(raw), GA_ROOT) };
    if root.0.is_null() {
        raw
    } else {
        root.0 as isize
    }
}

pub(crate) fn send(inputs: &[INPUT]) -> Result<(), String> {
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        return Err("Windows bloqueó el mouse/teclado simulado: la PC puede estar bloqueada o la ventana corre como administrador".into());
    }
    Ok(())
}

pub(crate) fn mouse_input(dx: i32, dy: i32, flags: MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

pub(crate) fn key_input(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

pub(crate) fn virtual_screen() -> Rect {
    unsafe {
        let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        Rect { left: x, top: y, right: x + GetSystemMetrics(SM_CXVIRTUALSCREEN), bottom: y + GetSystemMetrics(SM_CYVIRTUALSCREEN) }
    }
}

pub(crate) fn normalized(x: i32, y: i32) -> (i32, i32) {
    let v = virtual_screen();
    let nx = ((x - v.left) as f64 * 65535.0 / (v.width() - 1).max(1) as f64).round() as i32;
    let ny = ((y - v.top) as f64 * 65535.0 / (v.height() - 1).max(1) as f64).round() as i32;
    (nx, ny)
}

pub fn on_screen(x: i32, y: i32) -> bool {
    virtual_screen().contains(x, y)
}

fn in_front(raw: isize) -> bool {
    let fg = foreground();
    fg == raw || root_of(fg) == root_of(raw)
}

fn wait_front(raw: isize, tries: u32) -> bool {
    for _ in 0..tries {
        std::thread::sleep(Duration::from_millis(50));
        if in_front(raw) {
            return true;
        }
    }
    false
}

pub fn focus(raw: isize) -> Result<(), String> {
    let h = hwnd(raw);
    unsafe {
        if !IsWindow(Some(h)).as_bool() {
            return Err("esa ventana ya no existe".into());
        }
        if IsIconic(h).as_bool() {
            let _ = ShowWindow(h, SW_RESTORE);
        }
        if in_front(raw) {
            return Ok(());
        }
        let _ = SetForegroundWindow(h);
    }
    if wait_front(raw, 4) {
        return Ok(());
    }
    unsafe {
        let fg_thread = GetWindowThreadProcessId(GetForegroundWindow(), None);
        let me = GetCurrentThreadId();
        let attached = fg_thread != 0 && fg_thread != me && AttachThreadInput(me, fg_thread, true).as_bool();
        let _ = BringWindowToTop(h);
        let _ = SetForegroundWindow(h);
        if attached {
            let _ = AttachThreadInput(me, fg_thread, false);
        }
    }
    if wait_front(raw, 4) {
        return Ok(());
    }
    let tap = [
        key_input(0x12, 0, KEYBD_EVENT_FLAGS(0)),
        key_input(0x12, 0, KEYEVENTF_KEYUP),
        key_input(0x12, 0, KEYBD_EVENT_FLAGS(0)),
        key_input(0x12, 0, KEYEVENTF_KEYUP),
    ];
    let _ = send(&tap);
    unsafe {
        let _ = SetForegroundWindow(h);
        let _ = BringWindowToTop(h);
    }
    if wait_front(raw, 8) {
        return Ok(());
    }
    Err("Windows no dejó traer esa ventana al frente (otra app tiene el foco bloqueado)".into())
}

pub fn click(x: i32, y: i32, button: Button, double: bool) -> Result<(), String> {
    let (nx, ny) = normalized(x, y);
    let base = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    let (down, up) = match button {
        Button::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        Button::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        Button::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    };
    let mut inputs = vec![mouse_input(nx, ny, MOUSEEVENTF_MOVE | base, 0)];
    for _ in 0..if double { 2 } else { 1 } {
        inputs.push(mouse_input(nx, ny, down | base, 0));
        inputs.push(mouse_input(nx, ny, up | base, 0));
    }
    send(&inputs)
}

pub fn wheel(x: i32, y: i32, notches: i32) -> Result<(), String> {
    let (nx, ny) = normalized(x, y);
    let base = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    send(&[mouse_input(nx, ny, MOUSEEVENTF_MOVE | base, 0), mouse_input(nx, ny, MOUSEEVENTF_WHEEL | base, notches * 120)])
}

pub fn type_text(text: &str) -> Result<(), String> {
    let mut inputs: Vec<INPUT> = Vec::new();
    for unit in text.encode_utf16() {
        match unit {
            13 => continue,
            10 => {
                inputs.push(key_input(0x0D, 0, KEYBD_EVENT_FLAGS(0)));
                inputs.push(key_input(0x0D, 0, KEYEVENTF_KEYUP));
            }
            9 => {
                inputs.push(key_input(0x09, 0, KEYBD_EVENT_FLAGS(0)));
                inputs.push(key_input(0x09, 0, KEYEVENTF_KEYUP));
            }
            _ => {
                inputs.push(key_input(0, unit, KEYEVENTF_UNICODE));
                inputs.push(key_input(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
            }
        }
    }
    for chunk in inputs.chunks(120) {
        send(chunk)?;
        std::thread::sleep(Duration::from_millis(15));
    }
    Ok(())
}

pub(crate) fn named_key(name: &str) -> Option<(u16, bool)> {
    let key = match name {
        "enter" | "return" => (0x0D, false),
        "esc" | "escape" => (0x1B, false),
        "tab" => (0x09, false),
        "space" | "espacio" => (0x20, false),
        "backspace" | "retroceso" => (0x08, false),
        "delete" | "del" | "supr" | "suprimir" => (0x2E, true),
        "insert" | "ins" => (0x2D, true),
        "home" | "inicio" => (0x24, true),
        "end" | "fin" => (0x23, true),
        "pageup" | "pgup" => (0x21, true),
        "pagedown" | "pgdn" => (0x22, true),
        "up" | "arrowup" | "arriba" => (0x26, true),
        "down" | "arrowdown" | "abajo" => (0x28, true),
        "left" | "arrowleft" | "izquierda" => (0x25, true),
        "right" | "arrowright" | "derecha" => (0x27, true),
        "menu" | "apps" | "contextmenu" => (0x5D, true),
        "printscreen" | "prtsc" => (0x2C, false),
        "capslock" => (0x14, false),
        "ctrl" | "control" | "ctl" => (0x11, false),
        "shift" | "mayus" => (0x10, false),
        "alt" => (0x12, false),
        "win" | "windows" | "meta" | "cmd" | "super" => (0x5B, true),
        _ => {
            if let Some(n) = name.strip_prefix('f').and_then(|n| n.parse::<u16>().ok()).filter(|n| (1..=24).contains(n)) {
                return Some((0x70 + n - 1, false));
            }
            return None;
        }
    };
    Some(key)
}

pub(crate) fn char_key(c: char) -> Option<(u16, bool, bool)> {
    let mut buf = [0u16; 2];
    let units = c.encode_utf16(&mut buf);
    if units.len() != 1 {
        return None;
    }
    let scan = unsafe { VkKeyScanW(units[0]) };
    if scan == -1 {
        return None;
    }
    let vk = (scan as u16) & 0xFF;
    let shift = (scan as u16 >> 8) & 1 == 1;
    Some((vk, false, shift))
}

pub fn press(combos: &str) -> Result<(), String> {
    let mut steps: Vec<(Vec<INPUT>, Vec<INPUT>, Vec<INPUT>)> = Vec::new();
    for combo in combos.split_whitespace() {
        let parts: Vec<String> = combo.split('+').map(|p| p.trim().to_lowercase()).filter(|p| !p.is_empty()).collect();
        if parts.is_empty() {
            continue;
        }
        let mut held: Vec<(u16, bool)> = Vec::new();
        let (last, modifiers) = parts.split_last().unwrap();
        for m in modifiers {
            let key = named_key(m).ok_or_else(|| format!("no conozco la tecla «{}»", m))?;
            held.push(key);
        }
        let main = match named_key(last) {
            Some(k) => k,
            None => {
                let c = last.chars().next().filter(|_| last.chars().count() == 1).ok_or_else(|| format!("no conozco la tecla «{}»", last))?;
                let (vk, ext, shift) = char_key(c).ok_or_else(|| format!("no conozco la tecla «{}»", last))?;
                if shift && !held.iter().any(|(k, _)| *k == 0x10) {
                    held.push((0x10, false));
                }
                (vk, ext)
            }
        };
        let flag = |ext: bool| if ext { KEYEVENTF_EXTENDEDKEY } else { KEYBD_EVENT_FLAGS(0) };
        let down: Vec<INPUT> = held.iter().map(|(vk, ext)| key_input(*vk, 0, flag(*ext))).collect();
        let tap = vec![key_input(main.0, 0, flag(main.1)), key_input(main.0, 0, flag(main.1) | KEYEVENTF_KEYUP)];
        let up: Vec<INPUT> = held.iter().rev().map(|(vk, ext)| key_input(*vk, 0, flag(*ext) | KEYEVENTF_KEYUP)).collect();
        steps.push((down, tap, up));
    }
    if steps.is_empty() {
        return Err("no me pasaste ninguna tecla".into());
    }
    let pause = || std::thread::sleep(Duration::from_millis(30));
    for (down, tap, up) in steps {
        if !down.is_empty() {
            send(&down)?;
            pause();
        }
        let sent = send(&tap);
        if !up.is_empty() {
            pause();
            send(&up)?;
        }
        sent?;
        std::thread::sleep(Duration::from_millis(40));
    }
    Ok(())
}

unsafe fn grab(source: HDC, x: i32, y: i32, width: i32, height: i32, print: Option<HWND>) -> Result<Vec<u8>, String> {
    let memory = CreateCompatibleDC(Some(source));
    let bitmap = CreateCompatibleBitmap(source, width, height);
    let previous = SelectObject(memory, bitmap.into());
    let drawn = match print {
        Some(h) => PrintWindow(h, memory, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool(),
        None => BitBlt(memory, 0, 0, width, height, Some(source), x, y, ROP_CODE(SRCCOPY.0 | CAPTUREBLT.0)).is_ok(),
    };
    SelectObject(memory, previous);
    let mut info = BITMAPINFO::default();
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width,
        biHeight: -height,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    let mut pixels = vec![0u8; (width * height * 4) as usize];
    let lines = GetDIBits(memory, bitmap, 0, height as u32, Some(pixels.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS);
    let _ = DeleteObject(bitmap.into());
    let _ = DeleteDC(memory);
    if !drawn || lines == 0 {
        return Err("Windows no devolvió la imagen de la pantalla".into());
    }
    Ok(pixels)
}

fn blank(pixels: &[u8]) -> bool {
    pixels.chunks(4).step_by(97).all(|p| p[0] < 4 && p[1] < 4 && p[2] < 4)
}

pub fn capture_screen() -> Result<Shot, String> {
    let v = virtual_screen();
    unsafe {
        let screen = GetDC(None);
        let result = grab(screen, v.left, v.top, v.width(), v.height(), None);
        ReleaseDC(None, screen);
        let bgra = result?;
        if blank(&bgra) {
            return Err("la captura salió negra: la PC está bloqueada o la pantalla apagada".into());
        }
        Ok(Shot { width: v.width() as u32, height: v.height() as u32, bgra, origin: (v.left, v.top) })
    }
}

pub fn capture_window(raw: isize) -> Result<Shot, String> {
    let h = hwnd(raw);
    unsafe {
        if !IsWindow(Some(h)).as_bool() {
            return Err("esa ventana ya no existe".into());
        }
        if IsIconic(h).as_bool() {
            return Err("la ventana está minimizada: traela al frente con focus_window antes de capturarla".into());
        }
    }
    let mut outer = RECT::default();
    unsafe { GetWindowRect(h, &mut outer) }.map_err(|e| e.to_string())?;
    let outer: Rect = outer.into();
    let (w, hgt) = (outer.width(), outer.height());
    if w <= 1 || hgt <= 1 {
        return Err("la ventana no tiene tamaño visible".into());
    }
    let full = unsafe {
        let screen = GetDC(None);
        let result = grab(screen, 0, 0, w, hgt, Some(h));
        ReleaseDC(None, screen);
        result
    };
    let visible = bounds(raw);
    let crop = Rect {
        left: (visible.left - outer.left).clamp(0, w),
        top: (visible.top - outer.top).clamp(0, hgt),
        right: (visible.right - outer.left).clamp(0, w),
        bottom: (visible.bottom - outer.top).clamp(0, hgt),
    };
    let crop = if crop.width() > 1 && crop.height() > 1 { crop } else { Rect { left: 0, top: 0, right: w, bottom: hgt } };
    let pixels = match full {
        Ok(p) if !blank(&p) => cut(&p, w, crop),
        _ => {
            let screen = capture_screen()?;
            let v = virtual_screen();
            let area = Rect { left: visible.left - v.left, top: visible.top - v.top, right: visible.right - v.left, bottom: visible.bottom - v.top };
            let area = Rect {
                left: area.left.clamp(0, v.width()),
                top: area.top.clamp(0, v.height()),
                right: area.right.clamp(0, v.width()),
                bottom: area.bottom.clamp(0, v.height()),
            };
            if area.width() <= 1 || area.height() <= 1 {
                return Err("la ventana está fuera de la pantalla".into());
            }
            return Ok(Shot { width: area.width() as u32, height: area.height() as u32, bgra: cut(&screen.bgra, v.width(), area), origin: (visible.left, visible.top) });
        }
    };
    Ok(Shot { width: crop.width() as u32, height: crop.height() as u32, bgra: pixels, origin: (outer.left + crop.left, outer.top + crop.top) })
}

fn cut(pixels: &[u8], stride_px: i32, area: Rect) -> Vec<u8> {
    let mut out = Vec::with_capacity((area.width() * area.height() * 4) as usize);
    for row in area.top..area.bottom {
        let start = ((row * stride_px + area.left) * 4) as usize;
        let end = start + (area.width() * 4) as usize;
        out.extend_from_slice(&pixels[start..end]);
    }
    out
}

fn downscale(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<u8> {
    let mut out = vec![0u8; (dw * dh * 4) as usize];
    for dy in 0..dh {
        let y0 = (dy as u64 * sh as u64 / dh as u64) as u32;
        let y1 = (((dy + 1) as u64 * sh as u64 / dh as u64) as u32).max(y0 + 1).min(sh);
        for dx in 0..dw {
            let x0 = (dx as u64 * sw as u64 / dw as u64) as u32;
            let x1 = (((dx + 1) as u64 * sw as u64 / dw as u64) as u32).max(x0 + 1).min(sw);
            let mut acc = [0u32; 4];
            for y in y0..y1 {
                let row = (y * sw) as usize;
                for x in x0..x1 {
                    let i = (row + x as usize) * 4;
                    acc[0] += src[i] as u32;
                    acc[1] += src[i + 1] as u32;
                    acc[2] += src[i + 2] as u32;
                }
            }
            let n = (y1 - y0) * (x1 - x0);
            let o = ((dy * dw + dx) * 4) as usize;
            out[o] = (acc[0] / n) as u8;
            out[o + 1] = (acc[1] / n) as u8;
            out[o + 2] = (acc[2] / n) as u8;
            out[o + 3] = 255;
        }
    }
    out
}

pub struct Encoded {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

pub fn encode(shot: &Shot, max_side: u32, quality: u8) -> Result<Encoded, String> {
    let longest = shot.width.max(shot.height).max(1);
    let scale = (max_side as f64 / longest as f64).min(1.0);
    let width = ((shot.width as f64 * scale).round() as u32).max(1);
    let height = ((shot.height as f64 * scale).round() as u32).max(1);
    let pixels = if width == shot.width && height == shot.height { shot.bgra.clone() } else { downscale(&shot.bgra, shot.width, shot.height, width, height) };
    let mut jpeg = Vec::new();
    jpeg_encoder::Encoder::new(&mut jpeg, quality)
        .encode(&pixels, width as u16, height as u16, jpeg_encoder::ColorType::Bgra)
        .map_err(|e| e.to_string())?;
    Ok(Encoded { jpeg, width, height, scale: width as f64 / shot.width as f64 })
}

pub fn post_close(raw: isize) -> bool {
    unsafe { PostMessageW(Some(hwnd(raw)), WM_CLOSE, WPARAM(0), LPARAM(0)).is_ok() }
}

pub fn launch(target: &str, args: &str) -> Result<(), String> {
    let result = unsafe {
        ShellExecuteW(None, &HSTRING::from("open"), &HSTRING::from(target), &HSTRING::from(args), PCWSTR::null(), SW_SHOWNORMAL)
    };
    let code = result.0 as isize;
    if code <= 32 {
        return Err(format!("Windows no pudo abrir «{}» (código {})", target, code));
    }
    Ok(())
}
