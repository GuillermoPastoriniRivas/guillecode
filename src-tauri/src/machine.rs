use serde::Serialize;
use std::sync::Mutex;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MachineStatus {
    pub locked: bool,
    pub interactive: bool,
    pub on_battery: bool,
    pub battery: Option<u8>,
    pub has_battery: bool,
    pub keep_awake: bool,
    pub lid_sleeps: bool,
}

static AWAKE: Mutex<Option<isize>> = Mutex::new(None);

pub fn keep_awake(on: bool) {
    platform::keep_awake(on)
}

pub fn interactive() -> bool {
    platform::interactive()
}

pub fn status() -> MachineStatus {
    let (on_battery, battery, has_battery) = platform::power();
    MachineStatus {
        locked: platform::session_locked(),
        interactive: platform::interactive(),
        on_battery,
        battery,
        has_battery,
        keep_awake: AWAKE.lock().unwrap().is_some(),
        lid_sleeps: has_battery && platform::lid_sleeps(on_battery),
    }
}

#[cfg(windows)]
mod platform {
    use super::AWAKE;
    use windows::core::{GUID, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
    use windows::Win32::System::Power::{
        GetSystemPowerStatus, PowerClearRequest, PowerCreateRequest, PowerGetActiveScheme, PowerReadACValueIndex, PowerReadDCValueIndex, PowerRequestSystemRequired,
        PowerSetRequest, SYSTEM_POWER_STATUS,
    };
    use windows::Win32::System::RemoteDesktop::{WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW, WTS_CURRENT_SESSION, WTS_SESSIONSTATE_LOCK};
    use windows::Win32::System::StationsAndDesktops::{CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, UOI_NAME};
    use windows::Win32::System::SystemServices::{GUID_LIDCLOSE_ACTION, GUID_SYSTEM_BUTTON_SUBGROUP, POWER_REQUEST_CONTEXT_VERSION};
    use windows::Win32::System::Threading::{POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0};

    pub fn keep_awake(on: bool) {
        let mut slot = AWAKE.lock().unwrap();
        match (on, *slot) {
            (true, None) => unsafe {
                let mut reason: Vec<u16> = "GuilleCode: acceso desde el celular activo\0".encode_utf16().collect();
                let context = REASON_CONTEXT {
                    Version: POWER_REQUEST_CONTEXT_VERSION,
                    Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
                    Reason: REASON_CONTEXT_0 { SimpleReasonString: PWSTR(reason.as_mut_ptr()) },
                };
                let Ok(handle) = PowerCreateRequest(&context) else { return };
                if PowerSetRequest(handle, PowerRequestSystemRequired).is_ok() {
                    *slot = Some(handle.0 as isize);
                } else {
                    let _ = CloseHandle(handle);
                }
            },
            (false, Some(raw)) => unsafe {
                let handle = HANDLE(raw as *mut _);
                let _ = PowerClearRequest(handle, PowerRequestSystemRequired);
                let _ = CloseHandle(handle);
                *slot = None;
            },
            _ => {}
        }
    }

    pub fn interactive() -> bool {
        unsafe {
            let Ok(desk) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) else { return false };
            let mut name = [0u16; 64];
            let mut needed = 0u32;
            let read = GetUserObjectInformationW(HANDLE(desk.0), UOI_NAME, Some(name.as_mut_ptr() as *mut _), (name.len() * 2) as u32, Some(&mut needed)).is_ok();
            let _ = CloseDesktop(desk);
            let len = name.iter().position(|c| *c == 0).unwrap_or(name.len());
            read && String::from_utf16_lossy(&name[..len]).eq_ignore_ascii_case("Default")
        }
    }

    pub fn session_locked() -> bool {
        unsafe {
            let mut buffer = PWSTR::null();
            let mut bytes = 0u32;
            if WTSQuerySessionInformationW(None, WTS_CURRENT_SESSION, WTSSessionInfoEx, &mut buffer, &mut bytes).is_err() || buffer.is_null() {
                return !interactive();
            }
            let info = &*(buffer.0 as *const WTSINFOEXW);
            let locked = info.Level == 1 && info.Data.WTSInfoExLevel1.SessionFlags == WTS_SESSIONSTATE_LOCK as i32;
            WTSFreeMemory(buffer.0 as *mut _);
            locked
        }
    }

    pub fn power() -> (bool, Option<u8>, bool) {
        let mut status = SYSTEM_POWER_STATUS::default();
        if unsafe { GetSystemPowerStatus(&mut status) }.is_err() {
            return (false, None, false);
        }
        let has_battery = status.BatteryFlag != 128 && status.BatteryFlag != 255;
        let percent = (has_battery && status.BatteryLifePercent <= 100).then_some(status.BatteryLifePercent);
        (status.ACLineStatus == 0, percent, has_battery)
    }

    pub fn lid_sleeps(on_battery: bool) -> bool {
        unsafe {
            let mut scheme: *mut GUID = std::ptr::null_mut();
            if PowerGetActiveScheme(None, &mut scheme).0 != 0 || scheme.is_null() {
                return false;
            }
            let mut value = 0u32;
            let read = if on_battery {
                PowerReadDCValueIndex(None, Some(scheme), Some(&GUID_SYSTEM_BUTTON_SUBGROUP), Some(&GUID_LIDCLOSE_ACTION), &mut value) == 0
            } else {
                PowerReadACValueIndex(None, Some(scheme), Some(&GUID_SYSTEM_BUTTON_SUBGROUP), Some(&GUID_LIDCLOSE_ACTION), &mut value).0 == 0
            };
            let _ = LocalFree(Some(HLOCAL(scheme as *mut _)));
            read && value != 0
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn keep_awake(_on: bool) {}
    pub fn interactive() -> bool {
        true
    }
    pub fn session_locked() -> bool {
        false
    }
    pub fn power() -> (bool, Option<u8>, bool) {
        (false, None, false)
    }
    pub fn lid_sleeps(_on_battery: bool) -> bool {
        false
    }
}
