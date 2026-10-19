use super::{domain::*, evidence};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{io::Write, path::PathBuf};
use tauri::AppHandle;

const MAX_IMAGE: usize = 10 * 1024 * 1024;
const MAX_TOTAL: usize = 20 * 1024 * 1024;
const MAX_COUNT: usize = 5;

fn decode(input: &ImageInput) -> Result<Vec<u8>, String> {
    if input.url.len() > MAX_IMAGE.div_ceil(3) * 4 + 64 {
        return Err("Cada imagen puede pesar hasta 10 MB".into());
    }
    let prefix = format!("data:{};base64,", input.mime);
    let bytes = STANDARD
        .decode(
            input
                .url
                .strip_prefix(&prefix)
                .ok_or("Adjuntá una imagen PNG, JPEG, WebP o GIF válida")?,
        )
        .map_err(|_| "No se pudo leer la imagen adjunta")?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE {
        return Err("Cada imagen puede pesar hasta 10 MB y debe tener contenido".into());
    }
    let valid = match input.mime.as_str() {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    };
    if !valid {
        return Err("El archivo no coincide con una imagen PNG, JPEG, WebP o GIF".into());
    }
    Ok(bytes)
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    crate::app_data_file(app, "team-images")
        .ok_or("No se encontró la carpeta de imágenes del equipo".into())
}

pub(super) fn save(app: &AppHandle, inputs: &[ImageInput]) -> Result<Vec<ChatImage>, String> {
    if inputs.len() > MAX_COUNT {
        return Err("Podés adjuntar hasta 5 imágenes por mensaje".into());
    }
    let decoded = inputs.iter().map(decode).collect::<Result<Vec<_>, _>>()?;
    if decoded.iter().map(Vec::len).sum::<usize>() > MAX_TOTAL {
        return Err("Las imágenes del mensaje pueden sumar hasta 20 MB".into());
    }
    if inputs.is_empty() {
        return Ok(vec![]);
    }
    let root = root(app)?;
    std::fs::create_dir_all(&root).map_err(|_| "No se pudo preparar la carpeta de imágenes")?;
    let mut images = vec![];
    for (input, bytes) in inputs.iter().zip(decoded) {
        let image = ChatImage {
            id: id(),
            filename: input
                .filename
                .replace('\\', "/")
                .rsplit('/')
                .next()
                .unwrap_or("imagen")
                .chars()
                .filter(|c| !c.is_control())
                .take(160)
                .collect(),
            mime: input.mime.clone(),
            bytes: bytes.len(),
            sha256: format!("{:x}", Sha256::digest(&bytes)),
        };
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(root.join(&image.id))
            .map_err(|_| "No se pudo guardar la imagen adjunta")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "No se pudo completar el guardado de la imagen")?;
        images.push(image);
    }
    Ok(images)
}

pub(super) fn data_url(app: &AppHandle, image: &ChatImage) -> Result<String, String> {
    if image.id.len() != 32 || !image.id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Identificador de imagen inválido".into());
    }
    let root = root(app)?;
    let path = evidence::safe_path(&root.to_string_lossy(), &image.id, true)
        .map_err(|_| "La imagen adjunta ya no está disponible")?;
    if std::fs::metadata(&path)
        .map_err(|_| "No se pudo leer la imagen")?
        .len()
        > MAX_IMAGE as u64
    {
        return Err("La imagen guardada supera el tamaño admitido".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "No se pudo leer la imagen adjunta")?;
    if bytes.len() != image.bytes || format!("{:x}", Sha256::digest(&bytes)) != image.sha256 {
        return Err("La imagen cambió desde que se adjuntó; volvé a adjuntar el original".into());
    }
    Ok(format!(
        "data:{};base64,{}",
        image.mime,
        STANDARD.encode(bytes)
    ))
}

pub(super) fn parts(app: &AppHandle, images: &[ChatImage]) -> Result<Vec<Value>, String> {
    images.iter().map(|image| Ok(json!({"type":"file","mime":image.mime,"filename":image.filename,"url":data_url(app,image)?}))).collect()
}

pub(super) fn ensure_vision(
    client: &crate::oc::Opencode,
    agent: &Employee,
    images: &[ChatImage],
) -> Result<(), String> {
    if images.is_empty() {
        return Ok(());
    }
    let catalog = client.get("/config/providers")?;
    let model = catalog["providers"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["id"] == agent.model.provider_id)
        .and_then(|p| p["models"].get(&agent.model.model_id));
    if model.and_then(|m| m["capabilities"]["input"]["image"].as_bool()) == Some(false) {
        return Err(format!(
            "El modelo de {} no admite imágenes. Usá un modelo con visión para este pedido",
            agent.name
        ));
    }
    Ok(())
}

pub(super) fn merge(current: &mut Vec<ChatImage>, extra: &[ChatImage]) -> Result<(), String> {
    let mut next = current.clone();
    for image in extra {
        if !next.iter().any(|i| i.id == image.id) {
            next.push(image.clone());
        }
    }
    if next.len() > MAX_COUNT || next.iter().map(|i| i.bytes).sum::<usize>() > MAX_TOTAL {
        return Err("Esta ejecución ya alcanzó su contexto de imágenes (5 imágenes o 20 MB). Abrí otro pedido para usar más referencias".into());
    }
    *current = next;
    Ok(())
}

pub(super) fn recent(chat: &Chat) -> Vec<ChatImage> {
    let mut images: Vec<ChatImage> = vec![];
    let mut bytes = 0;
    for image in chat
        .messages
        .iter()
        .rev()
        .filter(|m| m.role == "user")
        .flat_map(|m| m.images.iter().rev())
    {
        if images.iter().any(|i| i.id == image.id) {
            continue;
        }
        if images.len() == MAX_COUNT || bytes + image.bytes > MAX_TOTAL {
            break;
        }
        bytes += image.bytes;
        images.push(image.clone());
    }
    images.reverse();
    images
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_raster_data_only_and_rejects_spoofed_or_remote_inputs() {
        let image = ImageInput {
            filename: "ref.png".into(),
            mime: "image/png".into(),
            url: format!(
                "data:image/png;base64,{}",
                STANDARD.encode(b"\x89PNG\r\n\x1a\nreference")
            ),
        };
        assert!(decode(&image).is_ok());
        for (mime, url) in [
            ("image/svg+xml", "data:image/svg+xml;base64,PHN2Zz4="),
            ("image/png", "https://example.test/x.png"),
            ("image/png", "data:image/png;base64,aGVsbG8="),
            ("image/jpeg", image.url.as_str()),
        ] {
            assert!(decode(&ImageInput {
                filename: "x".into(),
                mime: mime.into(),
                url: url.into()
            })
            .is_err());
        }
    }

    #[test]
    fn size_and_reference_limits_do_not_partially_change_the_run() {
        let oversized = ImageInput {
            filename: "x.png".into(),
            mime: "image/png".into(),
            url: "x".repeat(MAX_IMAGE.div_ceil(3) * 4 + 65),
        };
        assert!(decode(&oversized).unwrap_err().contains("10 MB"));
        let image = ChatImage {
            id: id(),
            filename: "ref.png".into(),
            mime: "image/png".into(),
            bytes: 100,
            sha256: "hash".into(),
        };
        let mut current = vec![image.clone()];
        merge(&mut current, &[image.clone()]).unwrap();
        assert_eq!(current.len(), 1);
        let mut huge = image.clone();
        huge.id = id();
        huge.bytes = MAX_TOTAL;
        assert!(merge(&mut current, &[huge]).is_err());
        assert_eq!(current.len(), 1);
    }
}
