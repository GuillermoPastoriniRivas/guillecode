use super::super::win::{self, key_input, mouse_input, named_key, normalized, send, virtual_screen};
use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
    MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSE_EVENT_FLAGS,
};

const STALE: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Button {
    Left,
    Right,
    Middle,
}

impl Button {
    fn parse(v: &Value) -> Button {
        match v.as_str().unwrap_or("left") {
            "right" => Button::Right,
            "middle" => Button::Middle,
            _ => Button::Left,
        }
    }
    fn flags(self) -> (MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS) {
        match self {
            Button::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
            Button::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            Button::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        }
    }
}

#[derive(Default)]
struct Held {
    keys: Vec<(u16, bool)>,
    buttons: Vec<Button>,
    last: Option<Instant>,
}

static HELD: Mutex<Held> = Mutex::new(Held { keys: Vec::new(), buttons: Vec::new(), last: None });
static LAST: Mutex<Option<Instant>> = Mutex::new(None);
// Serialize whole batches, watchdog and disconnect cleanup (not individual SendInput calls).
static SERIAL: Mutex<()> = Mutex::new(());

pub fn last_input() -> Option<Instant> {
    *LAST.lock().unwrap()
}

fn key_flags(ext: bool) -> KEYBD_EVENT_FLAGS {
    if ext {
        KEYEVENTF_EXTENDEDKEY
    } else {
        KEYBD_EVENT_FLAGS(0)
    }
}

fn resolve_key(name: &str) -> Option<(u16, bool)> {
    let lower = name.trim().to_lowercase();
    if let Some(k) = named_key(&lower) {
        return Some(k);
    }
    let mut chars = lower.chars();
    let c = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    win::char_key(c).map(|(vk, ext, _)| (vk, ext))
}

fn point(e: &Value) -> Option<(i32, i32)> {
    let x = e["x"].as_f64()?;
    let y = e["y"].as_f64()?;
    let v = virtual_screen();
    Some(((x.round() as i32).clamp(v.left, v.right - 1), (y.round() as i32).clamp(v.top, v.bottom - 1)))
}

fn absolute(x: i32, y: i32, flags: MOUSE_EVENT_FLAGS, data: i32) -> windows::Win32::UI::Input::KeyboardAndMouse::INPUT {
    let (nx, ny) = normalized(x, y);
    mouse_input(nx, ny, flags | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, data)
}

fn here(flags: MOUSE_EVENT_FLAGS, data: i32) -> windows::Win32::UI::Input::KeyboardAndMouse::INPUT {
    mouse_input(0, 0, flags, data)
}

fn button_event(button: Button, down: bool, at: Option<(i32, i32)>) -> Result<(), String> {
    let (d, u) = button.flags();
    let flag = if down { d } else { u };
    let mut inputs = Vec::new();
    if let Some((x, y)) = at {
        inputs.push(absolute(x, y, MOUSEEVENTF_MOVE, 0));
    }
    inputs.push(here(flag, 0));
    send(&inputs)?;
    let mut held = HELD.lock().unwrap();
    held.buttons.retain(|b| *b != button);
    if down {
        held.buttons.push(button);
    }
    Ok(())
}

fn key_event(name: &str, down: bool) -> Result<(), String> {
    let (vk, ext) = resolve_key(name).ok_or_else(|| format!("no conozco la tecla «{}»", name))?;
    let mut flags = key_flags(ext);
    if !down {
        flags |= KEYEVENTF_KEYUP;
    }
    send(&[key_input(vk, 0, flags)])?;
    let mut held = HELD.lock().unwrap();
    held.keys.retain(|(k, _)| *k != vk);
    if down {
        held.keys.push((vk, ext));
    }
    Ok(())
}

pub fn release_all() {
    let _serial = SERIAL.lock().unwrap();
    release_inner();
}

fn release_inner() {
    let (keys, buttons) = {
        let mut held = HELD.lock().unwrap();
        (std::mem::take(&mut held.keys), std::mem::take(&mut held.buttons))
    };
    let mut inputs = Vec::new();
    for b in buttons {
        inputs.push(here(b.flags().1, 0));
    }
    for (vk, ext) in keys.into_iter().rev() {
        inputs.push(key_input(vk, 0, key_flags(ext) | KEYEVENTF_KEYUP));
    }
    if !inputs.is_empty() {
        let _ = send(&inputs);
    }
}

pub fn holding() -> bool {
    let held = HELD.lock().unwrap();
    !held.keys.is_empty() || !held.buttons.is_empty()
}

pub fn start_watchdog() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_millis(500));
            let _serial = SERIAL.lock().unwrap();
            let stale = {
                let held = HELD.lock().unwrap();
                (!held.keys.is_empty() || !held.buttons.is_empty()) && held.last.map(|t| t.elapsed() > STALE).unwrap_or(true)
            };
            if stale {
                release_inner();
            }
        });
    });
}

fn window_id(v: &Value) -> Option<isize> {
    let raw = v.as_str()?;
    raw.trim_start_matches('w').parse::<isize>().ok()
}

fn apply_one(e: &Value) -> Result<(), String> {
    match e["t"].as_str().unwrap_or_default() {
        "move" => {
            let (x, y) = point(e).ok_or("falta la posición")?;
            send(&[absolute(x, y, MOUSEEVENTF_MOVE, 0)])
        }
        "down" => button_event(Button::parse(&e["b"]), true, point(e)),
        "up" => button_event(Button::parse(&e["b"]), false, point(e)),
        "click" => {
            let button = Button::parse(&e["b"]);
            let (d, u) = button.flags();
            let mut inputs = Vec::new();
            if let Some((x, y)) = point(e) {
                inputs.push(absolute(x, y, MOUSEEVENTF_MOVE, 0));
            }
            for _ in 0..e["n"].as_u64().unwrap_or(1).clamp(1, 3) {
                inputs.push(here(d, 0));
                inputs.push(here(u, 0));
            }
            send(&inputs)
        }
        "wheel" => {
            let mut inputs = Vec::new();
            if let Some((x, y)) = point(e) {
                inputs.push(absolute(x, y, MOUSEEVENTF_MOVE, 0));
            }
            let dy = e["dy"].as_f64().unwrap_or(0.0).round() as i32;
            let dx = e["dx"].as_f64().unwrap_or(0.0).round() as i32;
            if dy != 0 {
                inputs.push(here(MOUSEEVENTF_WHEEL, dy.clamp(-2400, 2400)));
            }
            if dx != 0 {
                inputs.push(here(MOUSEEVENTF_HWHEEL, dx.clamp(-2400, 2400)));
            }
            if inputs.is_empty() {
                return Ok(());
            }
            send(&inputs)
        }
        "key" => win::press(e["k"].as_str().unwrap_or_default()),
        "keydown" => key_event(e["k"].as_str().unwrap_or_default(), true),
        "keyup" => key_event(e["k"].as_str().unwrap_or_default(), false),
        "text" => {
            let text = e["s"].as_str().unwrap_or_default();
            if text.is_empty() {
                Ok(())
            } else {
                // IME/TSF-backed editors can lose KEYEVENTF_UNICODE sequences. Pasting
                // one Unicode clipboard value is atomic and preserves emoji/newlines.
                super::clipboard::write(text)?;
                win::press("ctrl+v")
            }
        }
        "focus" => {
            let hwnd = window_id(&e["w"]).ok_or("falta la ventana")?;
            win::focus(hwnd)
        }
        "release" => {
            release_inner();
            Ok(())
        }
        "hold" => Ok(()),
        other => Err(format!("acción desconocida «{}»", other)),
    }
}

pub fn apply(events: &[Value]) -> Result<usize, String> {
    start_watchdog();
    let _serial = SERIAL.lock().unwrap();
    let now = Instant::now();
    *LAST.lock().unwrap() = Some(now);
    HELD.lock().unwrap().last = Some(now);
    let mut done = 0;
    for e in events {
        if let Err(err) = apply_one(e) {
            release_inner();
            if e["t"] != "release" {
                return Err(err);
            }
        }
        done += 1;
    }
    Ok(done)
}
