use windows::core::{Interface, BOOL, PCWSTR};
use windows::Win32::Foundation::{E_ACCESSDENIED, LPARAM, RECT};
use windows::Win32::Graphics::Direct3D11::{ID3D11Resource, ID3D11Texture2D, D3D11_TEXTURE2D_DESC};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_MODE_ROTATION_IDENTITY, DXGI_MODE_ROTATION_UNSPECIFIED};
use windows::Win32::Graphics::Dxgi::{
    IDXGIOutput1, IDXGIOutput5, IDXGIOutputDuplication, IDXGIResource, DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_NOT_CURRENTLY_AVAILABLE, DXGI_ERROR_SESSION_DISCONNECTED, DXGI_ERROR_UNSUPPORTED,
    DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, EnumDisplayMonitors, GdiFlush, GetDC, GetMonitorInfoW, ReleaseDC, SelectObject, SetBrushOrgEx, SetStretchBltMode, StretchBlt,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ, HMONITOR, MONITORINFO, MONITORINFOEXW, HALFTONE, SRCCOPY,
};
use windows::Win32::UI::HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorInfo, LoadCursorW, CURSORINFO, CURSOR_SHOWING, HCURSOR, IDC_APPSTARTING, IDC_ARROW, IDC_CROSS, IDC_HAND, IDC_HELP, IDC_IBEAM, IDC_NO, IDC_SIZEALL, IDC_SIZENESW, IDC_SIZENS,
    IDC_SIZENWSE, IDC_SIZEWE, IDC_UPARROW, IDC_WAIT,
};

use super::gpu::Gpu;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Area {
    pub fn right(&self) -> i32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }
    pub fn intersect(&self, other: &Area) -> Option<Area> {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let r = self.right().min(other.right());
        let b = self.bottom().min(other.bottom());
        (r - x > 1 && b - y > 1).then_some(Area { x, y, w: r - x, h: b - y })
    }
    pub fn center(&self) -> (i32, i32) {
        (self.x + self.w / 2, self.y + self.h / 2)
    }
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }
    pub fn relative_to(&self, origin: &Area) -> RECT {
        RECT { left: self.x - origin.x, top: self.y - origin.y, right: self.right() - origin.x, bottom: self.bottom() - origin.y }
    }
}

#[derive(Clone, Debug)]
pub struct Display {
    pub index: usize,
    pub device: String,
    pub area: Area,
    pub primary: bool,
    pub monitor: isize,
}

pub fn physical_thread() {
    unsafe {
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

unsafe extern "system" fn collect_monitor(h: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
    let list = &mut *(data.0 as *mut Vec<isize>);
    list.push(h.0 as isize);
    BOOL(1)
}

pub fn displays() -> Vec<Display> {
    let mut handles: Vec<isize> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(collect_monitor), LPARAM(&mut handles as *mut Vec<isize> as isize));
    }
    let mut list: Vec<Display> = handles
        .into_iter()
        .filter_map(|raw| {
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            let ok = unsafe { GetMonitorInfoW(HMONITOR(raw as *mut _), &mut info.monitorInfo as *mut MONITORINFO) }.as_bool();
            if !ok {
                return None;
            }
            let r = info.monitorInfo.rcMonitor;
            let end = info.szDevice.iter().position(|c| *c == 0).unwrap_or(info.szDevice.len());
            Some(Display {
                index: 0,
                device: String::from_utf16_lossy(&info.szDevice[..end]),
                area: Area { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top },
                primary: info.monitorInfo.dwFlags & 1 != 0,
                monitor: raw,
            })
        })
        .collect();
    list.sort_by_key(|d| (!d.primary, d.area.x, d.area.y));
    for (i, d) in list.iter_mut().enumerate() {
        d.index = i;
    }
    list
}

pub fn display_of(list: &[Display], x: i32, y: i32) -> Option<&Display> {
    list.iter().find(|d| d.area.contains(x, y))
}

#[derive(Debug)]
pub enum CaptureError {
    Lost,
    Secure,
    Unsupported(String),
    Failed(String),
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CaptureError::Lost => write!(f, "se reinició la captura"),
            CaptureError::Secure => write!(f, "Windows muestra una pantalla protegida (bloqueo o permiso de administrador)"),
            CaptureError::Unsupported(e) => write!(f, "esta pantalla no admite captura acelerada: {}", e),
            CaptureError::Failed(e) => write!(f, "{}", e),
        }
    }
}

fn classify(e: windows::core::Error) -> CaptureError {
    let code = e.code();
    if code == DXGI_ERROR_ACCESS_LOST {
        CaptureError::Lost
    } else if code == E_ACCESSDENIED || code == DXGI_ERROR_SESSION_DISCONNECTED {
        CaptureError::Secure
    } else if code == DXGI_ERROR_UNSUPPORTED || code == DXGI_ERROR_NOT_CURRENTLY_AVAILABLE {
        CaptureError::Unsupported(e.message().to_string())
    } else {
        CaptureError::Failed(e.message().to_string())
    }
}

pub struct Duplicator {
    dup: IDXGIOutputDuplication,
    pub width: u32,
    pub height: u32,
    held: bool,
}

pub enum Grab {
    Changed,
    Same,
}

impl Duplicator {
    pub fn open(gpu: &Gpu) -> Result<Duplicator, CaptureError> {
        let output = gpu.output.as_ref().ok_or_else(|| CaptureError::Unsupported("la placa de video no expone esta pantalla".into()))?;
        let dup = unsafe {
            match output.cast::<IDXGIOutput5>() {
                Ok(o5) => o5.DuplicateOutput1(&gpu.device, 0, &[DXGI_FORMAT_B8G8R8A8_UNORM]),
                Err(_) => output.cast::<IDXGIOutput1>().map_err(classify)?.DuplicateOutput(&gpu.device),
            }
        }
        .map_err(classify)?;
        let desc = unsafe { dup.GetDesc() };
        if desc.Rotation != DXGI_MODE_ROTATION_IDENTITY && desc.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED {
            return Err(CaptureError::Unsupported("la pantalla está rotada".into()));
        }
        Ok(Duplicator { dup, width: desc.ModeDesc.Width, height: desc.ModeDesc.Height, held: false })
    }

    pub fn next(&mut self, gpu: &Gpu, target: &ID3D11Texture2D, wait_ms: u32) -> Result<Grab, CaptureError> {
        unsafe {
            if self.held {
                let _ = self.dup.ReleaseFrame();
                self.held = false;
            }
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource: Option<IDXGIResource> = None;
            match self.dup.AcquireNextFrame(wait_ms, &mut info, &mut resource) {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(Grab::Same),
                Err(e) => return Err(classify(e)),
            }
            self.held = true;
            if info.LastPresentTime == 0 || info.AccumulatedFrames == 0 {
                return Ok(Grab::Same);
            }
            let Some(resource) = resource else { return Ok(Grab::Same) };
            let texture: ID3D11Texture2D = resource.cast().map_err(classify)?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            texture.GetDesc(&mut desc);
            let mut mine = D3D11_TEXTURE2D_DESC::default();
            target.GetDesc(&mut mine);
            if desc.Width != mine.Width || desc.Height != mine.Height || desc.Format != mine.Format {
                return Err(CaptureError::Lost);
            }
            gpu.context.CopyResource(&target.cast::<ID3D11Resource>().map_err(classify)?, &texture.cast::<ID3D11Resource>().map_err(classify)?);
            let _ = self.dup.ReleaseFrame();
            self.held = false;
            Ok(Grab::Changed)
        }
    }
}

impl Drop for Duplicator {
    fn drop(&mut self) {
        if self.held {
            unsafe {
                let _ = self.dup.ReleaseFrame();
            }
        }
    }
}

pub struct GdiGrabber {
    memory: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut u8,
    pub width: i32,
    pub height: i32,
    last: Vec<u8>,
}

unsafe impl Send for GdiGrabber {}

impl GdiGrabber {
    pub fn new(width: i32, height: i32) -> Result<GdiGrabber, String> {
        unsafe {
            let screen = GetDC(None);
            let memory = CreateCompatibleDC(Some(screen));
            ReleaseDC(None, screen);
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
            let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
            let bitmap = match CreateDIBSection(Some(memory), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
                Ok(b) => b,
                Err(e) => {
                    let _ = DeleteDC(memory);
                    return Err(format!("no se pudo reservar la imagen de captura: {}", e.message()));
                }
            };
            let previous = SelectObject(memory, bitmap.into());
            if SetStretchBltMode(memory, HALFTONE) != 0 {
                let _ = SetBrushOrgEx(memory, 0, 0, None);
            }
            Ok(GdiGrabber { memory, bitmap, previous, bits: bits as *mut u8, width, height, last: Vec::new() })
        }
    }

    pub fn grab(&mut self, source: Area) -> Result<Option<&[u8]>, String> {
        let len = (self.width * self.height * 4) as usize;
        unsafe {
            let screen = GetDC(None);
            let drawn = if source.w == self.width && source.h == self.height {
                BitBlt(self.memory, 0, 0, self.width, self.height, Some(screen), source.x, source.y, SRCCOPY).is_ok()
            } else {
                StretchBlt(self.memory, 0, 0, self.width, self.height, Some(screen), source.x, source.y, source.w, source.h, SRCCOPY).as_bool()
            };
            ReleaseDC(None, screen);
            let _ = GdiFlush();
            if !drawn {
                return Err("Windows no devolvió la imagen de la pantalla".into());
            }
            let pixels = std::slice::from_raw_parts(self.bits, len);
            // A black desktop/video frame is valid; the caller checks the input desktop.
            if self.last.len() == len && self.last.as_slice() == pixels {
                return Ok(None);
            }
            self.last.clear();
            self.last.extend_from_slice(pixels);
            Ok(Some(&self.last))
        }
    }

    pub fn forget(&mut self) {
        self.last.clear();
    }
}

impl Drop for GdiGrabber {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.memory, self.previous);
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.memory);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cursor {
    pub x: i32,
    pub y: i32,
    pub kind: &'static str,
    pub visible: bool,
}

fn standard_cursors() -> &'static [(isize, &'static str)] {
    static LIST: std::sync::OnceLock<Vec<(isize, &'static str)>> = std::sync::OnceLock::new();
    LIST.get_or_init(|| {
        let names: [(PCWSTR, &'static str); 15] = [
            (IDC_ARROW, "arrow"),
            (IDC_IBEAM, "text"),
            (IDC_WAIT, "wait"),
            (IDC_APPSTARTING, "progress"),
            (IDC_CROSS, "crosshair"),
            (IDC_UPARROW, "arrow"),
            (IDC_SIZENWSE, "nwse"),
            (IDC_SIZENESW, "nesw"),
            (IDC_SIZEWE, "ew"),
            (IDC_SIZENS, "ns"),
            (IDC_SIZEALL, "move"),
            (IDC_NO, "no"),
            (IDC_HAND, "hand"),
            (IDC_HELP, "help"),
            (IDC_ARROW, "arrow"),
        ];
        names
            .iter()
            .filter_map(|(id, kind)| unsafe { LoadCursorW(None, *id) }.ok().map(|h: HCURSOR| (h.0 as isize, *kind)))
            .collect()
    })
}

pub fn cursor() -> Option<Cursor> {
    let mut info = CURSORINFO { cbSize: std::mem::size_of::<CURSORINFO>() as u32, ..Default::default() };
    unsafe { GetCursorInfo(&mut info) }.ok()?;
    let handle = info.hCursor.0 as isize;
    let kind = standard_cursors().iter().find(|(h, _)| *h == handle).map(|(_, k)| *k).unwrap_or("arrow");
    Some(Cursor { x: info.ptScreenPos.x, y: info.ptScreenPos.y, kind, visible: info.flags.0 & CURSOR_SHOWING.0 != 0 && handle != 0 })
}
