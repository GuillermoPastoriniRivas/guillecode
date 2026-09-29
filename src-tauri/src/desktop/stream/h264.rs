use std::mem::ManuallyDrop;
use std::time::{Duration, Instant};
use windows::core::{Interface, GUID, PWSTR};
use windows::Win32::Foundation::VARIANT_TRUE;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Resource, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_BIND_VIDEO_ENCODER, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};
use windows::Win32::Media::MediaFoundation::{
    eAVEncCommonRateControlMode_CBR, eAVEncCommonRateControlMode_PeakConstrainedVBR, eAVEncH264PictureType_IDR, eAVEncH264VProfile_Base, eAVEncH264VProfile_High, eAVEncH264VProfile_Main,
    ICodecAPI, IMF2DBuffer, IMFActivate, IMFDXGIDeviceManager, IMFMediaEventGenerator, IMFMediaType, IMFSample, IMFShutdown, IMFTransform, MFCreateDXGIDeviceManager, MFCreateDXGISurfaceBuffer,
    MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample, MFStartup, MFTEnumEx, METransformHaveOutput, METransformNeedInput, MFMediaType_Video, MFNominalRange_16_235,
    MFSampleExtension_Discontinuity, MFSampleExtension_VideoEncodePictureType, MFVideoFormat_H264, MFVideoFormat_NV12, MFVideoInterlace_Progressive, MFVideoPrimaries_BT709,
    MFVideoTransFunc_709, MFVideoTransferMatrix_BT709, CODECAPI_AVEncCommonBufferSize, CODECAPI_AVEncCommonMaxBitRate, CODECAPI_AVEncCommonMeanBitRate, CODECAPI_AVEncCommonQualityVsSpeed,
    CODECAPI_AVEncCommonRateControlMode, CODECAPI_AVEncMPVDefaultBPictureCount, CODECAPI_AVEncMPVGOPSize, CODECAPI_AVEncVideoForceKeyFrame, CODECAPI_AVLowLatencyMode, MFSTARTUP_LITE,
    MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_LOCALMFT, MFT_ENUM_FLAG_SORTANDFILTER, MFT_ENUM_FLAG_SYNCMFT, MFT_FRIENDLY_NAME_Attribute,
    MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, MFT_MESSAGE_NOTIFY_END_OF_STREAM, MFT_MESSAGE_NOTIFY_END_STREAMING, MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_MESSAGE_SET_D3D_MANAGER,
    MFT_OUTPUT_DATA_BUFFER, MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES, MFT_OUTPUT_STREAM_PROVIDES_SAMPLES, MFT_REGISTER_TYPE_INFO, MF_EVENT_FLAG_NO_WAIT, MF_E_NOTACCEPTING,
    MF_E_NO_EVENTS_AVAILABLE, MF_E_TRANSFORM_NEED_MORE_INPUT, MF_E_TRANSFORM_STREAM_CHANGE, MF_LOW_LATENCY, MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE,
    MF_MT_MAJOR_TYPE, MF_MT_MPEG2_PROFILE, MF_MT_MPEG_SEQUENCE_HEADER, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE, MF_MT_TRANSFER_FUNCTION, MF_MT_VIDEO_NOMINAL_RANGE, MF_MT_VIDEO_PRIMARIES,
    MF_MT_YUV_MATRIX, MF_TRANSFORM_ASYNC, MF_TRANSFORM_ASYNC_UNLOCK, MF_VERSION,
};
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::{VARIANT, VT_BOOL, VT_UI4};

const POOL: usize = 6;

pub struct Packet {
    pub data: Vec<u8>,
    pub key: bool,
}

pub struct Encoder {
    activate: IMFActivate,
    transform: IMFTransform,
    codec: Option<ICodecAPI>,
    events: Option<IMFMediaEventGenerator>,
    manager: Option<IMFDXGIDeviceManager>,
    context: Option<ID3D11DeviceContext>,
    pool: Vec<ID3D11Texture2D>,
    next: usize,
    pub name: String,
    pub hardware: bool,
    pub width: u32,
    pub height: u32,
    pub bitrate: u32,
    need_input: u32,
    provides_samples: bool,
    out_size: u32,
    started: Instant,
    sent: bool,
    params: Vec<u8>,
    pub profile: Option<[u8; 3]>,
}

unsafe impl Send for Encoder {}

fn text(e: windows::core::Error) -> String {
    let message = e.message().trim().to_string();
    if message.is_empty() {
        format!("{:?}", e.code())
    } else {
        message
    }
}

fn number(v: u32) -> VARIANT {
    let mut var = VARIANT::default();
    unsafe {
        let inner = &mut *var.Anonymous.Anonymous;
        inner.vt = VT_UI4;
        inner.Anonymous.ulVal = v;
    }
    var
}

fn flag(on: bool) -> VARIANT {
    let mut var = VARIANT::default();
    unsafe {
        let inner = &mut *var.Anonymous.Anonymous;
        inner.vt = VT_BOOL;
        inner.Anonymous.boolVal = if on { VARIANT_TRUE } else { Default::default() };
    }
    var
}

fn set(codec: &ICodecAPI, key: &GUID, value: VARIANT) -> bool {
    unsafe { codec.SetValue(key, &value).is_ok() }
}

fn startup() -> Result<(), String> {
    static STARTED: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    STARTED.get_or_init(|| unsafe { MFStartup(MF_VERSION, MFSTARTUP_LITE) }.map_err(|e| format!("Media Foundation no está disponible: {}", text(e)))).clone()
}

fn friendly(activate: &IMFActivate) -> String {
    unsafe {
        let mut value = PWSTR::null();
        let mut len = 0u32;
        if activate.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut value, &mut len).is_err() || value.is_null() {
            return "codificador H.264".into();
        }
        let name = value.to_string().unwrap_or_default();
        CoTaskMemFree(Some(value.0 as *const _));
        name
    }
}

fn candidates(hardware: bool) -> Vec<(IMFActivate, String)> {
    let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
    let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
    let flags = if hardware { MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER } else { MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_LOCALMFT | MFT_ENUM_FLAG_SORTANDFILTER };
    let mut array: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    let mut list = Vec::new();
    unsafe {
        if MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, flags, Some(&input), Some(&output), &mut array, &mut count).is_err() || array.is_null() {
            return list;
        }
        for slot in std::slice::from_raw_parts_mut(array, count as usize) {
            if let Some(activate) = slot.take() {
                let name = friendly(&activate);
                list.push((activate, name));
            }
        }
        CoTaskMemFree(Some(array as *const _));
    }
    list
}

pub fn available() -> Vec<(String, bool)> {
    if startup().is_err() {
        return Vec::new();
    }
    let mut out: Vec<(String, bool)> = candidates(true).into_iter().map(|(_, n)| (n, true)).collect();
    out.extend(candidates(false).into_iter().map(|(_, n)| (n, false)));
    out
}

fn offered(transform: &IMFTransform, output: bool, subtype: &GUID) -> Option<IMFMediaType> {
    for index in 0..64 {
        let found = unsafe {
            if output {
                transform.GetOutputAvailableType(0, index)
            } else {
                transform.GetInputAvailableType(0, index)
            }
        };
        let Ok(t) = found else { break };
        if unsafe { t.GetGUID(&MF_MT_SUBTYPE) }.ok().as_ref() == Some(subtype) {
            return Some(t);
        }
    }
    None
}

fn video_type(base: Option<IMFMediaType>, subtype: &GUID, width: u32, height: u32, fps: u32) -> Result<IMFMediaType, String> {
    unsafe {
        let t = match base {
            Some(t) => t,
            None => MFCreateMediaType().map_err(text)?,
        };
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(text)?;
        t.SetGUID(&MF_MT_SUBTYPE, subtype).map_err(text)?;
        t.SetUINT64(&MF_MT_FRAME_SIZE, ((width as u64) << 32) | height as u64).map_err(text)?;
        t.SetUINT64(&MF_MT_FRAME_RATE, ((fps as u64) << 32) | 1).map_err(text)?;
        t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1).map_err(text)?;
        t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).map_err(text)?;
        let _ = t.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32);
        let _ = t.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32);
        let _ = t.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32);
        let _ = t.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32);
        Ok(t)
    }
}

fn nal_units(data: &[u8]) -> Vec<(usize, usize)> {
    let mut starts: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 {
            if data[i + 2] == 1 {
                starts.push((i, i + 3));
                i += 3;
                continue;
            }
            if i + 4 <= data.len() && data[i + 2] == 0 && data[i + 3] == 1 {
                starts.push((i, i + 4));
                i += 4;
                continue;
            }
        }
        i += 1;
    }
    let mut units = Vec::with_capacity(starts.len());
    for (n, &(_, body)) in starts.iter().enumerate() {
        let end = starts.get(n + 1).map(|s| s.0).unwrap_or(data.len());
        if body < end {
            units.push((body, end));
        }
    }
    units
}

fn texture_pool(device: &ID3D11Device, width: u32, height: u32) -> Option<Vec<ID3D11Texture2D>> {
    for bind in [D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_VIDEO_ENCODER.0, D3D11_BIND_RENDER_TARGET.0] {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: bind as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let pool: Vec<ID3D11Texture2D> = (0..POOL)
            .filter_map(|_| {
                let mut texture: Option<ID3D11Texture2D> = None;
                unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture)) }.ok()?;
                texture
            })
            .collect();
        if pool.len() == POOL {
            return Some(pool);
        }
    }
    None
}

fn attach(transform: &IMFTransform, device: &ID3D11Device) -> Option<IMFDXGIDeviceManager> {
    unsafe {
        let mut token = 0u32;
        let mut manager: Option<IMFDXGIDeviceManager> = None;
        MFCreateDXGIDeviceManager(&mut token, &mut manager).ok()?;
        let manager = manager?;
        manager.ResetDevice(device, token).ok()?;
        transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize).ok()?;
        Some(manager)
    }
}

fn configure(codec: &ICodecAPI, fps: u32, bitrate: u32) {
    if !set(codec, &CODECAPI_AVEncCommonRateControlMode, number(eAVEncCommonRateControlMode_PeakConstrainedVBR.0 as u32)) {
        set(codec, &CODECAPI_AVEncCommonRateControlMode, number(eAVEncCommonRateControlMode_CBR.0 as u32));
    }
    set(codec, &CODECAPI_AVEncCommonMeanBitRate, number(bitrate));
    set(codec, &CODECAPI_AVEncCommonMaxBitRate, number(bitrate.saturating_mul(2)));
    set(codec, &CODECAPI_AVEncCommonBufferSize, number(bitrate.saturating_mul(2)));
    set(codec, &CODECAPI_AVLowLatencyMode, flag(true));
    set(codec, &CODECAPI_AVEncMPVGOPSize, number(fps.max(1) * 600));
    set(codec, &CODECAPI_AVEncMPVDefaultBPictureCount, number(0));
    set(codec, &CODECAPI_AVEncCommonQualityVsSpeed, number(40));
}

impl Encoder {
    pub fn open(width: u32, height: u32, fps: u32, bitrate: u32, hardware_first: bool, device: Option<&ID3D11Device>) -> Result<Encoder, String> {
        startup()?;
        let order = if hardware_first { [true, false] } else { [false, true] };
        let mut failures: Vec<String> = Vec::new();
        for hardware in order {
            for (activate, name) in candidates(hardware) {
                match Encoder::create(activate.clone(), name.clone(), hardware, width, height, fps, bitrate, device) {
                    Ok(encoder) => return Ok(encoder),
                    Err(e) => {
                        failures.push(format!("{}: {}", name, e));
                        unsafe {
                            let _ = activate.ShutdownObject();
                        }
                    }
                }
            }
        }
        if failures.is_empty() {
            Err("Windows no tiene un codificador H.264 instalado (en ediciones N falta el Media Feature Pack)".into())
        } else {
            Err(format!("ningún codificador H.264 aceptó la configuración ({})", failures.join("; ")))
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn create(activate: IMFActivate, name: String, hardware: bool, width: u32, height: u32, fps: u32, bitrate: u32, device: Option<&ID3D11Device>) -> Result<Encoder, String> {
        unsafe {
            let transform: IMFTransform = activate.ActivateObject().map_err(text)?;
            let attributes = transform.GetAttributes().ok();
            let asynchronous = attributes.as_ref().and_then(|a| a.GetUINT32(&MF_TRANSFORM_ASYNC).ok()).unwrap_or(0) == 1;
            if let Some(a) = &attributes {
                if asynchronous {
                    a.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1).map_err(text)?;
                }
                let _ = a.SetUINT32(&MF_LOW_LATENCY, 1);
            }
            let events = if asynchronous { Some(transform.cast::<IMFMediaEventGenerator>().map_err(text)?) } else { None };
            let manager = match (asynchronous, device) {
                (true, Some(device)) => attach(&transform, device),
                _ => None,
            };
            let codec = transform.cast::<ICodecAPI>().ok();
            if let Some(c) = &codec {
                configure(c, fps, bitrate);
            }
            let mut accepted = false;
            let mut last_error = String::new();
            for profile in [eAVEncH264VProfile_High, eAVEncH264VProfile_Main, eAVEncH264VProfile_Base] {
                let output = video_type(offered(&transform, true, &MFVideoFormat_H264), &MFVideoFormat_H264, width, height, fps)?;
                output.SetUINT32(&MF_MT_AVG_BITRATE, bitrate).map_err(text)?;
                output.SetUINT32(&MF_MT_MPEG2_PROFILE, profile.0 as u32).map_err(text)?;
                match transform.SetOutputType(0, &output, 0) {
                    Ok(()) => {
                        accepted = true;
                        break;
                    }
                    Err(e) => last_error = text(e),
                }
            }
            if !accepted {
                return Err(format!("no acepta {}x{}: {}", width, height, last_error));
            }
            let input = video_type(offered(&transform, false, &MFVideoFormat_NV12), &MFVideoFormat_NV12, width, height, fps)?;
            transform.SetInputType(0, &input, 0).map_err(|e| format!("no acepta NV12 {}x{}: {}", width, height, text(e)))?;
            if let Some(c) = &codec {
                set(c, &CODECAPI_AVEncCommonMeanBitRate, number(bitrate));
            }
            let (context, pool) = match (&manager, device) {
                (Some(_), Some(device)) => match (device.GetImmediateContext().ok(), texture_pool(device, width, height)) {
                    (Some(context), Some(pool)) => (Some(context), pool),
                    _ => (None, Vec::new()),
                },
                _ => (None, Vec::new()),
            };
            let info = transform.GetOutputStreamInfo(0).map_err(text)?;
            let provides_samples = info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0 as u32) != 0;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0).map_err(text)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0).map_err(text)?;
            Ok(Encoder {
                activate,
                transform,
                codec,
                events,
                manager,
                context,
                pool,
                next: 0,
                name,
                hardware,
                width,
                height,
                bitrate,
                need_input: 0,
                provides_samples,
                out_size: info.cbSize.max(width * height * 2),
                started: Instant::now(),
                sent: false,
                params: Vec::new(),
                profile: None,
            })
        }
    }

    pub fn codec_string(&self) -> Option<String> {
        self.profile.map(|p| format!("avc1.{:02x}{:02x}{:02x}", p[0], p[1], p[2]))
    }

    pub fn set_bitrate(&mut self, bitrate: u32) {
        if let Some(c) = &self.codec {
            if set(c, &CODECAPI_AVEncCommonMeanBitRate, number(bitrate)) {
                set(c, &CODECAPI_AVEncCommonMaxBitRate, number(bitrate.saturating_mul(2)));
                self.bitrate = bitrate;
            }
        }
    }

    pub fn takes_textures(&self) -> bool {
        !self.pool.is_empty()
    }

    fn stamp(&mut self, sample: &IMFSample, key: bool) -> Result<(), String> {
        unsafe {
            let now = self.started.elapsed().as_nanos() as i64 / 100;
            sample.SetSampleTime(now).map_err(text)?;
            sample.SetSampleDuration(333_333).map_err(text)?;
            if !self.sent {
                let _ = sample.SetUINT32(&MFSampleExtension_Discontinuity, 1);
                self.sent = true;
            }
            if key {
                let _ = sample.SetUINT32(&MFSampleExtension_VideoEncodePictureType, eAVEncH264PictureType_IDR.0 as u32);
            }
        }
        Ok(())
    }

    fn texture_sample(&mut self, source: &ID3D11Texture2D, key: bool) -> Result<IMFSample, String> {
        let context = self.context.clone().ok_or("el codificador no usa la placa de video")?;
        let texture = self.pool[self.next % self.pool.len()].clone();
        self.next = self.next.wrapping_add(1);
        unsafe {
            context.CopyResource(&texture.cast::<ID3D11Resource>().map_err(text)?, &source.cast::<ID3D11Resource>().map_err(text)?);
            let buffer = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, &texture, 0, false).map_err(text)?;
            if let Ok(two_d) = buffer.cast::<IMF2DBuffer>() {
                if let Ok(len) = two_d.GetContiguousLength() {
                    let _ = buffer.SetCurrentLength(len);
                }
            }
            let sample = MFCreateSample().map_err(text)?;
            sample.AddBuffer(&buffer).map_err(text)?;
            self.stamp(&sample, key)?;
            Ok(sample)
        }
    }

    fn memory_sample(&mut self, nv12: &[u8], key: bool) -> Result<IMFSample, String> {
        unsafe {
            let buffer = MFCreateMemoryBuffer(nv12.len() as u32).map_err(text)?;
            let mut ptr: *mut u8 = std::ptr::null_mut();
            buffer.Lock(&mut ptr, None, None).map_err(text)?;
            std::ptr::copy_nonoverlapping(nv12.as_ptr(), ptr, nv12.len());
            buffer.Unlock().map_err(text)?;
            buffer.SetCurrentLength(nv12.len() as u32).map_err(text)?;
            let sample = MFCreateSample().map_err(text)?;
            sample.AddBuffer(&buffer).map_err(text)?;
            self.stamp(&sample, key)?;
            Ok(sample)
        }
    }

    pub fn encode(&mut self, nv12: &[u8], key: bool) -> Result<Vec<Packet>, String> {
        let expected = (self.width * self.height * 3 / 2) as usize;
        if nv12.len() < expected {
            return Err("la imagen no tiene el tamaño del codificador".into());
        }
        let sample = self.memory_sample(&nv12[..expected], key)?;
        self.submit(sample, key)
    }

    pub fn encode_texture(&mut self, source: &ID3D11Texture2D, key: bool) -> Result<Vec<Packet>, String> {
        let sample = self.texture_sample(source, key)?;
        self.submit(sample, key)
    }

    fn submit(&mut self, sample: IMFSample, key: bool) -> Result<Vec<Packet>, String> {
        if key {
            if let Some(c) = &self.codec {
                set(c, &CODECAPI_AVEncVideoForceKeyFrame, number(1));
            }
        }
        let mut packets = Vec::new();
        match self.events.clone() {
            Some(events) => {
                self.pump(&events, &mut packets, Wait::Input, Duration::from_millis(1500))?;
                unsafe { self.transform.ProcessInput(0, &sample, 0) }.map_err(|e| format!("el codificador rechazó la imagen: {}", text(e)))?;
                self.need_input = self.need_input.saturating_sub(1);
                self.pump(&events, &mut packets, Wait::Output, Duration::from_millis(150))?;
            }
            None => {
                let mut tries = 0;
                loop {
                    match unsafe { self.transform.ProcessInput(0, &sample, 0) } {
                        Ok(()) => break,
                        Err(e) if e.code() == MF_E_NOTACCEPTING && tries < 3 => {
                            tries += 1;
                            self.drain(&mut packets)?;
                        }
                        Err(e) => return Err(format!("el codificador rechazó la imagen: {}", text(e))),
                    }
                }
                self.drain(&mut packets)?;
            }
        }
        Ok(packets)
    }

    pub fn collect(&mut self) -> Result<Vec<Packet>, String> {
        let mut packets = Vec::new();
        if let Some(events) = self.events.clone() {
            self.pump(&events, &mut packets, Wait::Nothing, Duration::ZERO)?;
        }
        Ok(packets)
    }

    fn drain(&mut self, packets: &mut Vec<Packet>) -> Result<(), String> {
        for _ in 0..16 {
            match self.pull()? {
                Pulled::Packet(p) => packets.push(p),
                Pulled::Changed => continue,
                Pulled::Empty => break,
            }
        }
        Ok(())
    }

    fn pump(&mut self, events: &IMFMediaEventGenerator, packets: &mut Vec<Packet>, wait: Wait, limit: Duration) -> Result<(), String> {
        let deadline = Instant::now() + limit;
        let before = packets.len();
        loop {
            match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                Ok(event) => {
                    let kind = unsafe { event.GetType() }.map_err(text)?;
                    if kind == METransformNeedInput.0 as u32 {
                        self.need_input += 1;
                    } else if kind == METransformHaveOutput.0 as u32 {
                        if let Pulled::Packet(p) = self.pull()? {
                            packets.push(p);
                        }
                    }
                }
                Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => {
                    let done = match wait {
                        Wait::Input => self.need_input > 0,
                        Wait::Output => packets.len() > before,
                        Wait::Nothing => true,
                    };
                    if done {
                        return Ok(());
                    }
                    if Instant::now() >= deadline {
                        return match wait {
                            Wait::Input => Err("el codificador de video dejó de responder".into()),
                            _ => Ok(()),
                        };
                    }
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(e) => return Err(format!("el codificador de video falló: {}", text(e))),
            }
        }
    }

    fn pull(&mut self) -> Result<Pulled, String> {
        unsafe {
            let provided = if self.provides_samples {
                None
            } else {
                let sample = MFCreateSample().map_err(text)?;
                let buffer = MFCreateMemoryBuffer(self.out_size).map_err(text)?;
                sample.AddBuffer(&buffer).map_err(text)?;
                Some(sample)
            };
            let mut buffers = [MFT_OUTPUT_DATA_BUFFER { dwStreamID: 0, pSample: ManuallyDrop::new(provided), dwStatus: 0, pEvents: ManuallyDrop::new(None) }];
            let mut status = 0u32;
            let result = self.transform.ProcessOutput(0, &mut buffers, &mut status);
            let [buffer] = buffers;
            let sample = ManuallyDrop::into_inner(buffer.pSample);
            drop(ManuallyDrop::into_inner(buffer.pEvents));
            match result {
                Ok(()) => {}
                Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(Pulled::Empty),
                Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                    let t = offered(&self.transform, true, &MFVideoFormat_H264).ok_or("el codificador cambió de formato y no ofrece H.264")?;
                    self.transform.SetOutputType(0, &t, 0).map_err(text)?;
                    if let Ok(info) = self.transform.GetOutputStreamInfo(0) {
                        self.provides_samples = info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0 as u32) != 0;
                        self.out_size = info.cbSize.max(self.width * self.height * 2);
                    }
                    return Ok(Pulled::Changed);
                }
                Err(e) => return Err(format!("el codificador no entregó el cuadro: {}", text(e))),
            }
            let Some(sample) = sample else { return Ok(Pulled::Empty) };
            let buffer = sample.ConvertToContiguousBuffer().map_err(text)?;
            let mut ptr: *mut u8 = std::ptr::null_mut();
            let mut len = 0u32;
            buffer.Lock(&mut ptr, None, Some(&mut len)).map_err(text)?;
            let data = std::slice::from_raw_parts(ptr, len as usize).to_vec();
            let _ = buffer.Unlock();
            if data.is_empty() {
                return Ok(Pulled::Empty);
            }
            Ok(Pulled::Packet(self.packet(data)))
        }
    }

    fn sequence_header(&self) -> Vec<u8> {
        unsafe {
            let Ok(t) = self.transform.GetOutputCurrentType(0) else { return Vec::new() };
            let Ok(size) = t.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER) else { return Vec::new() };
            let mut blob = vec![0u8; size as usize];
            if t.GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut blob, None).is_err() {
                return Vec::new();
            }
            blob
        }
    }

    fn packet(&mut self, data: Vec<u8>) -> Packet {
        let mut key = false;
        let mut has_params = false;
        let mut params: Vec<u8> = Vec::new();
        for (start, end) in nal_units(&data) {
            match data[start] & 0x1f {
                5 => key = true,
                7 => {
                    has_params = true;
                    if end - start >= 4 {
                        self.profile = Some([data[start + 1], data[start + 2], data[start + 3]]);
                    }
                    params.extend_from_slice(&[0, 0, 0, 1]);
                    params.extend_from_slice(&data[start..end]);
                }
                8 => {
                    params.extend_from_slice(&[0, 0, 0, 1]);
                    params.extend_from_slice(&data[start..end]);
                }
                _ => {}
            }
        }
        if has_params {
            self.params = params;
        }
        if key && !has_params {
            if self.params.is_empty() {
                let header = self.sequence_header();
                for (start, end) in nal_units(&header) {
                    if header[start] & 0x1f == 7 && end - start >= 4 {
                        self.profile = Some([header[start + 1], header[start + 2], header[start + 3]]);
                    }
                }
                self.params = header;
            }
            let mut full = self.params.clone();
            full.extend_from_slice(&data);
            return Packet { data: full, key };
        }
        Packet { data, key }
    }
}

enum Wait {
    Input,
    Output,
    Nothing,
}

enum Pulled {
    Packet(Packet),
    Changed,
    Empty,
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            if let Ok(shutdown) = self.transform.cast::<IMFShutdown>() {
                let _ = shutdown.Shutdown();
            }
            let _ = self.activate.ShutdownObject();
            drop(self.manager.take());
        }
    }
}
