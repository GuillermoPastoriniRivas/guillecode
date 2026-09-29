pub fn bgra(pixels: &[u8], width: u16, height: u16, quality: u8) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(pixels.len() / 10);
    jpeg_encoder::Encoder::new(&mut out, quality).encode(pixels, width, height, jpeg_encoder::ColorType::Bgra).map_err(|e| e.to_string())?;
    Ok(out)
}
