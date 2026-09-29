mod capture;
mod clipboard;
mod gpu;
mod h264;
mod input;

use super::win;
use crate::{machine, remote};
use capture::Area;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tiny_http::Request;
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, WindowFromPoint};

const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_FRAME: usize = 16 * 1024 * 1024;

struct Session {
    area: Area,
    target: Option<String>,
    sent: u32,
    ack: u32,
    seen: Instant,
}

#[derive(Default)]
struct Sessions {
    viewers: HashMap<String, Session>,
    controller: Option<String>,
}

fn sessions() -> &'static Mutex<Sessions> {
    static STATE: OnceLock<Mutex<Sessions>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(Sessions::default()))
}

fn watchdog() {
    static START: std::sync::Once = std::sync::Once::new();
    START.call_once(|| { std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_millis(500));
        let mut state = sessions().lock().unwrap();
        state.viewers.retain(|_, s| s.seen.elapsed() <= TIMEOUT);
        if state.controller.as_ref().is_some_and(|id| !state.viewers.contains_key(id)) {
            state.controller = None;
            input::release_all();
        }
    }); });
}

pub fn release_control() {
    let mut state = sessions().lock().unwrap();
    state.controller = None;
    input::release_all();
}

pub fn disconnect_all() {
    let mut state = sessions().lock().unwrap();
    state.viewers.clear();
    state.controller = None;
    input::release_all();
}

struct Viewer(String);
impl Drop for Viewer {
    fn drop(&mut self) {
        let mut state = sessions().lock().unwrap();
        state.viewers.remove(&self.0);
        if state.controller.as_deref() == Some(&self.0) {
            state.controller = None;
            input::release_all();
        }
    }
}

fn area(target: Option<&str>) -> Result<Area, String> {
    capture::physical_thread();
    if !machine::interactive() {
        return Err("La pantalla está bloqueada o Windows muestra un permiso de administrador.".into());
    }
    let rect = if let Some(target) = target {
        if let Some(index) = target.strip_prefix('d').and_then(|s| s.parse::<usize>().ok()) {
            return capture::displays().into_iter().find(|d| d.index == index).map(|d| d.area).ok_or("Esa pantalla ya no está conectada.".into());
        }
        let id = target.strip_prefix('w').and_then(|s| s.parse().ok()).ok_or("Ventana inválida")?;
        let w = win::window(id).ok_or("Esa ventana ya no existe")?;
        if let Some(reason) = super::blocked_reason(&w) { return Err(reason); }
        if w.minimized { return Err("La ventana está minimizada".into()); }
        w.rect
    } else {
        win::virtual_screen()
    };
    let v = win::virtual_screen();
    Area { x: rect.left, y: rect.top, w: rect.width(), h: rect.height() }
        .intersect(&Area { x: v.left, y: v.top, w: v.width(), h: v.height() })
        .ok_or("La ventana está fuera de la pantalla".into())
}

pub fn displays_json() -> Value {
    capture::physical_thread();
    json!(capture::displays().iter().map(|d| json!({"id": format!("d{}", d.index), "name": format!("Pantalla {}", d.index + 1), "primary": d.primary})).collect::<Vec<_>>())
}

fn write_packet(out: &mut dyn Write, kind: u8, seq: u32, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_FRAME { return Err("Cuadro demasiado grande".into()); }
    // v1: kind:u8, sequence:u32be, length:u32be, payload. JSON=0, JPEG=1,
    // H264 IDR=2/delta=3, cursor=4, error=5, heartbeat=6.
    let mut head = [0u8; 9];
    head[0] = kind;
    head[1..5].copy_from_slice(&seq.to_be_bytes());
    head[5..9].copy_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.write_all(&head).and_then(|_| out.write_all(bytes)).and_then(|_| out.flush()).map_err(|e| e.to_string())
}

struct Pipeline {
    gpu: Option<gpu::Gpu>,
    converter: Option<gpu::Converter>,
    duplicator: Option<capture::Duplicator>,
    gdi: Option<capture::GdiGrabber>,
    encoder: Option<h264::Encoder>,
    source: Area,
    width: u32,
    height: u32,
    initialized: bool,
    pixels: Vec<u8>,
}

impl Pipeline {
    fn open(source: Area, video: bool, max: u32, fps: u32) -> Result<Self, String> {
        let scale = (max as f64 / source.w.max(source.h) as f64).min(1.0);
        let width = ((source.w as f64 * scale) as u32 / 2 * 2).max(2);
        let height = ((source.h as f64 * scale) as u32 / 2 * 2).max(2);
        let mut p = Self { gpu: None, converter: None, duplicator: None, gdi: None, encoder: None, source, width, height, initialized: false, pixels: Vec::new() };
        // Duplication is per output; a virtual desktop spanning outputs falls back to GDI.
        if let Some(display) = capture::displays().iter().find(|d| source.intersect(&d.area) == Some(source)) {
            if let Ok(gpu) = gpu::Gpu::for_monitor(display.monitor) {
                if let Ok(dup) = capture::Duplicator::open(&gpu) {
                    let encoder = if video { h264::Encoder::open(width, height, fps, 3_000_000, true, Some(&gpu.device)).ok() } else { None };
                    let pixels = if encoder.is_some() { gpu::Pixels::Nv12 } else { gpu::Pixels::Bgra };
                    if let Ok(conv) = gpu::Converter::new(&gpu, dup.width, dup.height, width, height, pixels) {
                        p.encoder = encoder;
                        p.source = display.area;
                        p.converter = Some(conv);
                        p.duplicator = Some(dup);
                        p.gpu = Some(gpu);
                        return Ok(p);
                    }
                }
            }
        }
        p.gdi = Some(capture::GdiGrabber::new(width as i32, height as i32)?);
        Ok(p)
    }

    fn next(&mut self, crop: Area) -> Result<Vec<(u8, Vec<u8>)>, String> {
        if let (Some(gpu), Some(conv), Some(dup)) = (&self.gpu, &self.converter, &mut self.duplicator) {
            let changed = matches!(dup.next(gpu, conv.source(), 0).map_err(|e| e.to_string())?, capture::Grab::Changed);
            if changed { self.initialized = true; }
            if !self.initialized { return Ok(Vec::new()); }
            if let Some(enc) = &mut self.encoder {
                // Feed the same texture during encoder startup too: async MFTs may buffer input.
                if changed || enc.profile.is_none() {
                    conv.blit(gpu, crop.relative_to(&self.source))?;
                    let packets = if enc.takes_textures() {
                        enc.encode_texture(conv.target(), enc.profile.is_none())?
                    } else {
                        conv.read(gpu, &mut self.pixels)?;
                        enc.encode(&self.pixels, enc.profile.is_none())?
                    };
                    return Ok(packets.into_iter().map(|p| (if p.key { 2 } else { 3 }, p.data)).collect());
                }
                return Ok(enc.collect()?.into_iter().map(|p| (if p.key { 2 } else { 3 }, p.data)).collect());
            }
            if !changed { return Ok(Vec::new()); }
            conv.run(gpu, crop.relative_to(&self.source), &mut self.pixels)?;
            return Ok(vec![(1, fastjpeg::bgra(&self.pixels, self.width as u16, self.height as u16, 75)?)]);
        }
        let Some(gdi) = &mut self.gdi else { return Err("No hay capturador".into()) };
        match gdi.grab(crop)? {
            Some(pixels) => Ok(vec![(1, fastjpeg::bgra(pixels, self.width as u16, self.height as u16, 75)?)]),
            None => Ok(Vec::new()),
        }
    }
}

pub fn serve(app: &AppHandle, req: Request, target: Option<String>, video: bool, max: u32, fps: u32) {
    let token = req.headers().iter().find(|h| h.field.equiv("Authorization")).and_then(|h| h.value.as_str().strip_prefix("Bearer ")).unwrap_or_default().to_string();
    let mut out = req.into_writer();
    if out.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/x-guillecode-screen\r\nCache-Control: no-store\r\nX-Accel-Buffering: no\r\nConnection: close\r\n\r\n").is_err() { return; }
    if let Err(e) = run(app, &mut out, target, video, max.clamp(320, 1920), fps.clamp(1, 60), &token) {
        let _ = write_packet(&mut out, 5, 0, json!({"error": e}).to_string().as_bytes());
    }
}

fn run(app: &AppHandle, out: &mut dyn Write, target: Option<String>, video: bool, max: u32, fps: u32, token: &str) -> Result<(), String> {
    watchdog();
    let crop = area(target.as_deref())?;
    let id = uuid::Uuid::new_v4().to_string();
    {
        let mut state = sessions().lock().unwrap();
        if state.viewers.len() >= 4 { return Err("Ya hay cuatro visores abiertos".into()); }
        state.viewers.insert(id.clone(), Session { area: crop, target: target.clone(), sent: 0, ack: 0, seen: Instant::now() });
    }
    let _viewer = Viewer(id.clone());
    let mut pipeline = Pipeline::open(crop, video, max, fps)?;
    let mut seq = 0u32;
    let mut metadata = String::new();
    let mut last_cursor = None;
    let mut beat = Instant::now();
    let began = Instant::now();
    loop {
        let tick = Instant::now();
        if !remote::access_valid(app, token) { break; }
        let lag = {
            let state = sessions().lock().unwrap();
            let Some(s) = state.viewers.get(&id) else { break };
            if s.seen.elapsed() > TIMEOUT { break; }
            s.sent.saturating_sub(s.ack)
        };
        if area(target.as_deref())? != crop { return Err("Cambió el tamaño o la posición: reconectando…".into()); }
        if seq == 0 && began.elapsed() > TIMEOUT { return Err("El codificador no entregó imágenes; probá el modo JPEG".into()); }
        if lag < 2 {
            let frames = match pipeline.next(crop) {
                Ok(frames) => frames,
                Err(e) => {
                    log::warn!("[screen] GPU pipeline failed, using GDI/JPEG: {}", e);
                    // A lost duplication device must not cause an endless JPEG/DXGI retry loop.
                    pipeline.encoder = None;
                    pipeline.duplicator = None;
                    pipeline.converter = None;
                    pipeline.gpu = None;
                    pipeline.gdi = Some(capture::GdiGrabber::new(pipeline.width as i32, pipeline.height as i32)?);
                    pipeline.next(crop)?
                }
            };
            let codec = pipeline.encoder.as_ref().and_then(|e| e.codec_string());
            let meta = json!({ "version": 1, "id": id, "area": {"x": crop.x, "y": crop.y, "w": crop.w, "h": crop.h}, "width": pipeline.width, "height": pipeline.height, "codec": codec, "format": if pipeline.encoder.is_some() {"h264"} else {"jpeg"} }).to_string();
            if meta != metadata { write_packet(out, 0, seq, meta.as_bytes())?; metadata = meta; }
            for (kind, bytes) in frames {
                seq += 1;
                {
                    let mut state = sessions().lock().unwrap();
                    let Some(s) = state.viewers.get_mut(&id) else { return Ok(()) };
                    s.sent = seq;
                }
                write_packet(out, kind, seq, &bytes)?;
            }
        }
        let cursor = capture::cursor();
        if cursor != last_cursor {
            let data = cursor.map(|c| json!({"x": (c.x-crop.x) as f64 / crop.w as f64, "y": (c.y-crop.y) as f64 / crop.h as f64, "kind": c.kind, "visible": c.visible && crop.contains(c.x,c.y)})).unwrap_or(json!({"visible":false}));
            write_packet(out, 4, seq, data.to_string().as_bytes())?;
            last_cursor = cursor;
        }
        if beat.elapsed() >= Duration::from_secs(1) { write_packet(out, 6, seq, &[])?; beat = Instant::now(); }
        std::thread::sleep(Duration::from_secs_f64(1.0 / fps as f64).saturating_sub(tick.elapsed()));
    }
    Ok(())
}

pub fn acknowledge(body: &Value) -> Result<Value, String> {
    let mut state = sessions().lock().unwrap();
    let s = state.viewers.get_mut(body["id"].as_str().ok_or("Falta la sesión")?).ok_or("El visor se desconectó")?;
    let seq = body["seq"].as_u64().ok_or("Falta el cuadro")?;
    if seq > s.sent as u64 { return Err("Cuadro inválido".into()); }
    s.ack = s.ack.max(seq as u32);
    s.seen = Instant::now();
    Ok(json!({"ok":true}))
}

fn checked_window(raw: isize) -> Result<(), String> {
    if raw == 0 { return Ok(()); }
    let root = win::root_of(raw);
    // Enumerated windows omit titleless/tool windows; policy must still cover them.
    let w = win::window(root).unwrap_or_else(|| {
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(win::hwnd(root), Some(&mut pid)); }
        win::WinInfo { hwnd: root, title: String::new(), class: String::new(), pid, process: win::process_name(pid), rect: win::bounds(root), minimized: false, foreground: false }
    });
    if let Some(reason) = super::blocked_reason(&w) { return Err(reason); }
    Ok(())
}

pub fn control(app: &AppHandle, body: &Value, token: &str) -> Result<Value, String> {
    capture::physical_thread();
    let id = body["id"].as_str().ok_or("Falta la sesión del visor")?;
    // This lock serializes different HTTP clients and keeps pause/revoke atomic with batches.
    let mut state = sessions().lock().unwrap();
    if body["release"].as_bool() == Some(true) {
        if state.controller.as_deref() == Some(id) { state.controller = None; input::release_all(); }
        return Ok(json!({"ok":true}));
    }
    super::gate(app)?;
    if !remote::access_valid(app, token) || !machine::interactive() { return Err("No hay un escritorio interactivo disponible".into()); }
    let s = state.viewers.get(id).ok_or("El visor se desconectó")?;
    if s.seen.elapsed() > TIMEOUT || s.ack == 0 { return Err("Esperá a recibir la pantalla antes de controlar".into()); }
    let crop = s.area;
    if area(s.target.as_deref())? != crop { return Err("La ventana se movió: esperá a que se actualice el visor".into()); }
    if state.controller.as_deref().is_some_and(|owner| owner != id) { return Err("Otro visor tiene el control".into()); }
    if let Some(action) = body["clipboard"].as_str() {
        return match action {
            "read" => clipboard::read().map(|text| json!({"text":text})),
            "write" => {
                let text = body["text"].as_str().filter(|s| s.len() <= 32_768).ok_or("Texto de portapapeles inválido")?;
                clipboard::write(text).map(|_| json!({"ok":true}))
            },
            _ => Err("Acción de portapapeles inválida".into()),
        };
    }
    let events = body["events"].as_array().ok_or("Faltan los eventos")?;
    validate_events(events)?;
    state.controller = Some(id.to_string());
    let result = (|| {
        for event in events {
            let mut e = event.clone();
            if let (Some(x), Some(y)) = (e["x"].as_f64(), e["y"].as_f64()) {
                let (x, y) = map_point(crop, x, y)?;
                let h = unsafe { WindowFromPoint(POINT {x, y}) };
                checked_window(h.0 as isize)?;
                e["x"] = json!(x); e["y"] = json!(y);
            }
            if matches!(e["t"].as_str(), Some("text" | "key" | "keydown" | "keyup")) {
                checked_window(win::foreground())?;
            }
            super::gate(app)?;
            if !remote::access_valid(app, token) { return Err("Se revocó el acceso remoto".into()); }
            if !machine::interactive() { return Err("Windows cambió a una pantalla protegida".into()); }
            input::apply(&[e])?;
        }
        Ok(json!({"ok":true}))
    })();
    if result.is_err() { input::release_all(); state.controller = None; }
    result
}

fn map_point(area: Area, x: f64, y: f64) -> Result<(i32, i32), String> {
    if !x.is_finite() || !y.is_finite() || !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) { return Err("Posición fuera de la imagen".into()); }
    Ok((area.x + (x * (area.w-1) as f64).round() as i32, area.y + (y * (area.h-1) as f64).round() as i32))
}

fn validate_events(events: &[Value]) -> Result<(), String> {
    if events.is_empty() || events.len() > 64 { return Err("Lote de eventos inválido".into()); }
    for e in events {
        match e["t"].as_str().ok_or("Falta el tipo de evento")? {
            "move" | "down" | "up" | "click" | "wheel" => {
                map_point(Area {x:0,y:0,w:2,h:2}, e["x"].as_f64().ok_or("Falta x")?, e["y"].as_f64().ok_or("Falta y")?)?;
                if e.get("b").is_some() && !matches!(e["b"].as_str(), Some("left"|"right"|"middle")) { return Err("Botón inválido".into()); }
            }
            "text" if e["s"].as_str().is_some_and(|s| s.len() <= 4096) => {},
            "key" | "keydown" | "keyup" if e["k"].as_str().is_some_and(|s| !s.is_empty() && s.len() <= 80) => {},
            "release" | "hold" => {},
            _ => return Err("Evento inválido".into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn physical_coordinates_include_negative_monitors() {
        let a = Area {x:-1920,y:-200,w:1920,h:1080};
        assert_eq!(map_point(a,0.0,0.0).unwrap(),(-1920,-200));
        assert_eq!(map_point(a,1.0,1.0).unwrap(),(-1,879));
        assert!(map_point(a,f64::NAN,0.0).is_err());
        assert!(map_point(a,-0.01,0.5).is_err());
    }
    #[test]
    fn rejects_entire_malformed_batch_before_input() {
        assert!(validate_events(&[json!({"t":"click","x":0.5,"y":0.5}), json!({"t":"focus","w":"w1"})]).is_err());
        assert!(validate_events(&[json!({"t":"click","x":2,"y":0})]).is_err());
        assert!(validate_events(&[json!({"t":"text","s":"a".repeat(4097)})]).is_err());
        assert!(validate_events(&vec![json!({"t":"hold"});65]).is_err());
    }
    #[test]
    fn binary_packet_has_explicit_length_and_sequence() {
        let mut out = Vec::new();
        write_packet(&mut out,2,257,&[1,2,3]).unwrap();
        assert_eq!(out,vec![2,0,0,1,1,0,0,0,3,1,2,3]);
    }
}
