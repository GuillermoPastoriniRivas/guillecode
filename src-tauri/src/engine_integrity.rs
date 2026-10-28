use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const REINSTALL: &str = "El motor OpenCode está incompleto o dañado. Liberá espacio y reinstalá Flufy; tus chats y cuentas se conservan.";

// Windows reports a truncated PE as error 193, which looks like an account
// problem in the connection screen. Check section bounds before spawning it.
pub(crate) fn validate(path: &Path) -> Result<(), String> {
    let check = || -> std::io::Result<bool> {
        let mut file = File::open(path)?;
        let length = file.metadata()?.len();
        if length < 64 { return Ok(false); }
        let mut dos = [0u8; 64];
        file.read_exact(&mut dos)?;
        if &dos[..2] != b"MZ" { return Ok(false); }
        let offset = u32::from_le_bytes(dos[60..64].try_into().unwrap()) as u64;
        if offset + 24 > length { return Ok(false); }
        file.seek(SeekFrom::Start(offset))?;
        let mut pe = [0u8; 24];
        file.read_exact(&mut pe)?;
        if &pe[..4] != b"PE\0\0" { return Ok(false); }
        let sections = u16::from_le_bytes([pe[6], pe[7]]) as u64;
        let optional = u16::from_le_bytes([pe[20], pe[21]]) as u64;
        let table = offset + 24 + optional;
        if sections == 0 || sections > 96 || table + sections * 40 > length { return Ok(false); }
        file.seek(SeekFrom::Start(table))?;
        for _ in 0..sections {
            let mut section = [0u8; 40];
            file.read_exact(&mut section)?;
            let size = u32::from_le_bytes(section[16..20].try_into().unwrap()) as u64;
            let position = u32::from_le_bytes(section[20..24].try_into().unwrap()) as u64;
            if size > 0 && (position == 0 || position + size > length) { return Ok(false); }
        }
        Ok(true)
    };
    match check() {
        Ok(true) => Ok(()),
        _ => Err(REINSTALL.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_partial_engine_even_when_dos_and_pe_headers_are_valid() {
        let dir = std::env::temp_dir().join(format!("guillecode-pe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("engine.exe");
        let mut bytes = vec![0u8; 1024];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[60..64].copy_from_slice(&128u32.to_le_bytes());
        bytes[128..132].copy_from_slice(b"PE\0\0");
        bytes[134..136].copy_from_slice(&1u16.to_le_bytes());
        bytes[168..172].copy_from_slice(&4096u32.to_le_bytes());
        bytes[172..176].copy_from_slice(&512u32.to_le_bytes());
        std::fs::write(&path, &bytes).unwrap();
        assert!(validate(&path).unwrap_err().contains("incompleto"));
        bytes.resize(4608, 0);
        std::fs::write(&path, &bytes).unwrap();
        assert!(validate(&path).is_ok());
        bytes[60..64].copy_from_slice(&u32::MAX.to_le_bytes());
        std::fs::write(&path, &bytes).unwrap();
        assert!(validate(&path).is_err());
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
