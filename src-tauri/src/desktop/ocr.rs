use super::win::{self, Rect, Shot};
use std::panic::AssertUnwindSafe;
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::Duration;
use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

const UPSCALE: f64 = 1.0;
const JOB_TIMEOUT: Duration = Duration::from_secs(30);

type Job = Box<dyn FnOnce() + Send>;

static WORKER: Mutex<Option<Sender<Job>>> = Mutex::new(None);

fn spawn_worker() -> Sender<Job> {
    let (tx, rx) = mpsc::channel::<Job>();
    let _ = std::thread::Builder::new().name("guillecode-ocr".into()).spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        for job in rx {
            let _ = std::panic::catch_unwind(AssertUnwindSafe(job));
        }
    });
    tx
}

fn on_worker<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    let job: Job = Box::new(move || {
        let _ = tx.send(f());
    });
    {
        let mut worker = WORKER.lock().unwrap();
        let sender = worker.get_or_insert_with(spawn_worker);
        if let Err(mpsc::SendError(job)) = sender.send(job) {
            let fresh = spawn_worker();
            fresh.send(job).map_err(|_| "no pude iniciar el OCR de Windows".to_string())?;
            *worker = Some(fresh);
        }
    }
    match rx.recv_timeout(JOB_TIMEOUT) {
        Ok(result) => result,
        Err(_) => {
            *WORKER.lock().unwrap() = None;
            Err("el OCR de Windows no respondió a tiempo".into())
        }
    }
}

#[derive(Clone)]
pub struct Word {
    pub text: String,
    pub rect: Rect,
}

#[derive(Clone)]
pub struct Line {
    pub text: String,
    pub words: Vec<Word>,
}

impl Line {
    pub fn rect(&self) -> Rect {
        union(self.words.iter().map(|w| w.rect))
    }
}

pub fn union(rects: impl Iterator<Item = Rect>) -> Rect {
    rects
        .reduce(|a, b| Rect { left: a.left.min(b.left), top: a.top.min(b.top), right: a.right.max(b.right), bottom: a.bottom.max(b.bottom) })
        .unwrap_or_default()
}

pub fn recognize(shot: &Shot) -> Result<Vec<Line>, String> {
    let (bgra, sw, sh) = (shot.bgra.clone(), shot.width, shot.height);
    let (lines, width, height) = on_worker(move || {
        let limit = OcrEngine::MaxImageDimension().unwrap_or(2600) as f64;
        let scale = (limit / sw.max(sh).max(1) as f64).min(UPSCALE);
        let width = ((sw as f64 * scale).floor() as u32).max(1);
        let height = ((sh as f64 * scale).floor() as u32).max(1);
        let pixels = if width == sw && height == sh { bgra } else { win::resample(&bgra, sw, sh, width, height) };
        run(pixels, width, height).map(|lines| (lines, width, height))
    })?;
    let origin = shot.origin;
    let fx = sw as f64 / width as f64;
    let fy = sh as f64 / height as f64;
    Ok(lines
        .into_iter()
        .map(|(text, words)| Line {
            text,
            words: words
                .into_iter()
                .map(|(t, x, y, w, h)| Word {
                    text: t,
                    rect: Rect {
                        left: origin.0 + (x as f64 * fx).floor() as i32,
                        top: origin.1 + (y as f64 * fy).floor() as i32,
                        right: origin.0 + ((x + w) as f64 * fx).ceil() as i32,
                        bottom: origin.1 + ((y + h) as f64 * fy).ceil() as i32,
                    },
                })
                .collect(),
        })
        .filter(|l: &Line| !l.words.is_empty())
        .collect())
}

type RawWord = (String, f32, f32, f32, f32);

fn run(pixels: Vec<u8>, width: u32, height: u32) -> Result<Vec<(String, Vec<RawWord>)>, String> {
    let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(|_| "Windows no tiene instalado ningún idioma para reconocer texto (OCR): agregalo en Configuración → Hora e idioma → Idioma".to_string())?;
    let fail = |e: windows::core::Error| format!("el OCR de Windows falló: {}", e.message());
    let writer = DataWriter::new().map_err(fail)?;
    writer.WriteBytes(&pixels).map_err(fail)?;
    let buffer = writer.DetachBuffer().map_err(fail)?;
    let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(&buffer, BitmapPixelFormat::Bgra8, width as i32, height as i32, BitmapAlphaMode::Ignore).map_err(fail)?;
    let result = engine.RecognizeAsync(&bitmap).map_err(fail)?.join().map_err(fail)?;
    let lines = result.Lines().map_err(fail)?;
    let mut out = Vec::new();
    for i in 0..lines.Size().map_err(fail)? {
        let line = lines.GetAt(i).map_err(fail)?;
        let words = line.Words().map_err(fail)?;
        let mut list = Vec::new();
        for j in 0..words.Size().map_err(fail)? {
            let word = words.GetAt(j).map_err(fail)?;
            let r = word.BoundingRect().map_err(fail)?;
            list.push((word.Text().map_err(fail)?.to_string(), r.X, r.Y, r.Width, r.Height));
        }
        out.push((line.Text().map_err(fail)?.to_string(), list));
    }
    Ok(out)
}

pub fn locate(lines: &[Line], needle: &str) -> Vec<(String, Rect)> {
    let wanted = fold(needle);
    if wanted.is_empty() {
        return Vec::new();
    }
    let mut found = Vec::new();
    for line in lines {
        if !fold(&line.text).contains(&wanted) && !fold(&joined(&line.words)).contains(&wanted) {
            continue;
        }
        let mut best: Option<(usize, usize)> = None;
        for i in 0..line.words.len() {
            for j in i..line.words.len() {
                if fold(&joined(&line.words[i..=j])).contains(&wanted) {
                    if best.map(|(a, b)| j - i < b - a).unwrap_or(true) {
                        best = Some((i, j));
                    }
                    break;
                }
            }
        }
        match best {
            Some((i, j)) => found.push((joined(&line.words[i..=j]), union(line.words[i..=j].iter().map(|w| w.rect)))),
            None => found.push((line.text.clone(), line.rect())),
        }
    }
    found
}

pub fn segments(line: &Line) -> Vec<(String, Rect)> {
    let mut out: Vec<(String, Rect)> = Vec::new();
    let mut start = 0;
    for i in 1..=line.words.len() {
        let split = i == line.words.len() || {
            let (a, b) = (line.words[i - 1].rect, line.words[i].rect);
            let height = a.height().max(b.height()).max(1);
            (b.left - a.right) * 2 > height * 3
        };
        if split {
            let part = &line.words[start..i];
            out.push((joined(part), union(part.iter().map(|w| w.rect))));
            start = i;
        }
    }
    out
}

fn joined(words: &[Word]) -> String {
    words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ")
}

fn fold(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            other => other,
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(text: &str, left: i32) -> Word {
        Word { text: text.into(), rect: Rect { left, top: 10, right: left + 40, bottom: 30 } }
    }

    #[test]
    fn locate_picks_the_shortest_span_of_words() {
        let lines = vec![Line { text: "Archivo Guardar como Salir".into(), words: vec![word("Archivo", 0), word("Guardar", 50), word("como", 100), word("Salir", 150)] }];
        let found = locate(&lines, "guardar COMO");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, "Guardar como");
        assert_eq!(found[0].1, Rect { left: 50, top: 10, right: 140, bottom: 30 });
    }

    #[test]
    fn segments_split_on_wide_gaps_only() {
        let line = Line { text: "Archivo Edición Guardar como".into(), words: vec![word("Archivo", 0), word("Edición", 80), word("Guardar", 200), word("como", 245)] };
        let parts: Vec<String> = segments(&line).into_iter().map(|(t, _)| t).collect();
        assert_eq!(parts, vec!["Archivo", "Edición", "Guardar como"]);
    }

    #[test]
    fn locate_ignores_accents_and_misses() {
        let lines = vec![Line { text: "Configuración".into(), words: vec![word("Configuración", 0)] }];
        assert_eq!(locate(&lines, "configuracion").len(), 1);
        assert!(locate(&lines, "ayuda").is_empty());
    }
}

