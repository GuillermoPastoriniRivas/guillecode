use std::mem::ManuallyDrop;
use windows::core::{Interface, BOOL};
use windows::Win32::Foundation::{HMODULE, RECT};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_10_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread, ID3D11Resource, ID3D11Texture2D, ID3D11VideoContext, ID3D11VideoContext1, ID3D11VideoDevice,
    ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator, ID3D11VideoProcessorInputView, ID3D11VideoProcessorOutputView, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_CONTENT_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
    D3D11_VPIV_DIMENSION_TEXTURE2D, D3D11_VPOV_DIMENSION_TEXTURE2D,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709, DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIAdapter, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput, DXGI_ADAPTER_FLAG_SOFTWARE};

pub struct Gpu {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    video: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    pub output: Option<IDXGIOutput>,
    pub adapter: String,
}

unsafe impl Send for Gpu {}

fn wide(s: &[u16]) -> String {
    let end = s.iter().position(|c| *c == 0).unwrap_or(s.len());
    String::from_utf16_lossy(&s[..end])
}

fn err(context: &str, e: windows::core::Error) -> String {
    format!("{}: {}", context, e.message())
}

impl Gpu {
    pub fn for_monitor(monitor: isize) -> Result<Gpu, String> {
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.map_err(|e| err("DXGI no está disponible", e))?;
        let mut chosen: Option<(IDXGIAdapter1, Option<IDXGIOutput>)> = None;
        let mut index = 0;
        while let Ok(adapter) = unsafe { factory.EnumAdapters1(index) } {
            index += 1;
            let desc = unsafe { adapter.GetDesc1() }.map_err(|e| err("no pude leer la placa de video", e))?;
            if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                continue;
            }
            let mut o = 0;
            while let Ok(output) = unsafe { adapter.EnumOutputs(o) } {
                o += 1;
                let Ok(out_desc) = (unsafe { output.GetDesc() }) else { continue };
                if out_desc.Monitor.0 as isize == monitor {
                    chosen = Some((adapter.clone(), Some(output)));
                    break;
                }
            }
            if chosen.as_ref().map(|c| c.1.is_some()).unwrap_or(false) {
                break;
            }
            if chosen.is_none() {
                chosen = Some((adapter, None));
            }
        }
        let (adapter, output) = chosen.ok_or("no encontré una placa de video")?;
        let name = unsafe { adapter.GetDesc1() }.map(|d| wide(&d.Description)).unwrap_or_default();
        let base: IDXGIAdapter = adapter.cast().map_err(|e| err("placa de video", e))?;
        let levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0];
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        unsafe {
            D3D11CreateDevice(
                &base,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                Some(&levels),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
        }
        .map_err(|e| err("no se pudo abrir la placa de video", e))?;
        let device = device.ok_or("Direct3D no devolvió el dispositivo")?;
        let context = context.ok_or("Direct3D no devolvió el contexto")?;
        if let Ok(mt) = device.cast::<ID3D11Multithread>() {
            unsafe {
                let _ = mt.SetMultithreadProtected(true);
            }
        }
        let video: ID3D11VideoDevice = device.cast().map_err(|e| err("la placa no tiene procesador de video", e))?;
        let video_context: ID3D11VideoContext = context.cast().map_err(|e| err("la placa no tiene procesador de video", e))?;
        Ok(Gpu { device, context, video, video_context, output, adapter: name })
    }

    fn texture(&self, width: u32, height: u32, format: DXGI_FORMAT, staging: bool) -> Result<ID3D11Texture2D, String> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: if staging { D3D11_USAGE_STAGING } else { D3D11_USAGE_DEFAULT },
            BindFlags: if staging { 0 } else { (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32 },
            CPUAccessFlags: if staging { D3D11_CPU_ACCESS_READ.0 as u32 } else { 0 },
            MiscFlags: 0,
        };
        let mut texture: Option<ID3D11Texture2D> = None;
        unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut texture)) }.map_err(|e| err("no se pudo reservar memoria de video", e))?;
        texture.ok_or_else(|| "Direct3D no devolvió la textura".to_string())
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Pixels {
    Nv12,
    Bgra,
}

pub struct Converter {
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    source: ID3D11Texture2D,
    input: ID3D11VideoProcessorInputView,
    target: ID3D11Texture2D,
    output: ID3D11VideoProcessorOutputView,
    staging: ID3D11Texture2D,
    pub source_width: u32,
    pub source_height: u32,
    pub width: u32,
    pub height: u32,
    pub pixels: Pixels,
}

unsafe impl Send for Converter {}

impl Converter {
    pub fn new(gpu: &Gpu, source_width: u32, source_height: u32, width: u32, height: u32, pixels: Pixels) -> Result<Converter, String> {
        let format = match pixels {
            Pixels::Nv12 => DXGI_FORMAT_NV12,
            Pixels::Bgra => DXGI_FORMAT_B8G8R8A8_UNORM,
        };
        let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL { Numerator: 60, Denominator: 1 },
            InputWidth: source_width,
            InputHeight: source_height,
            OutputFrameRate: DXGI_RATIONAL { Numerator: 60, Denominator: 1 },
            OutputWidth: width,
            OutputHeight: height,
            Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
        };
        unsafe {
            let enumerator = gpu.video.CreateVideoProcessorEnumerator(&content).map_err(|e| err("el procesador de video no acepta este tamaño", e))?;
            let input_ok = enumerator.CheckVideoProcessorFormat(DXGI_FORMAT_B8G8R8A8_UNORM).map(|f| f & 1 != 0).unwrap_or(false);
            let output_ok = enumerator.CheckVideoProcessorFormat(format).map(|f| f & 2 != 0).unwrap_or(false);
            if !input_ok || !output_ok {
                return Err("el procesador de video no convierte este formato".into());
            }
            let processor = gpu.video.CreateVideoProcessor(&enumerator, 0).map_err(|e| err("no se pudo crear el procesador de video", e))?;
            let source = gpu.texture(source_width, source_height, DXGI_FORMAT_B8G8R8A8_UNORM, false)?;
            let target = gpu.texture(width, height, format, false)?;
            let staging = gpu.texture(width, height, format, true)?;
            let input_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                FourCC: 0,
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 } },
            };
            let mut input: Option<ID3D11VideoProcessorInputView> = None;
            gpu.video
                .CreateVideoProcessorInputView(&source.cast::<ID3D11Resource>().map_err(|e| err("textura", e))?, &enumerator, &input_desc, Some(&mut input))
                .map_err(|e| err("no se pudo preparar la entrada de video", e))?;
            let output_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
            };
            let mut output: Option<ID3D11VideoProcessorOutputView> = None;
            gpu.video
                .CreateVideoProcessorOutputView(&target.cast::<ID3D11Resource>().map_err(|e| err("textura", e))?, &enumerator, &output_desc, Some(&mut output))
                .map_err(|e| err("no se pudo preparar la salida de video", e))?;
            let input = input.ok_or("Direct3D no devolvió la vista de entrada")?;
            let output = output.ok_or("Direct3D no devolvió la vista de salida")?;
            gpu.video_context.VideoProcessorSetStreamFrameFormat(&processor, 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
            gpu.video_context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            if let Ok(vc1) = gpu.video_context.cast::<ID3D11VideoContext1>() {
                vc1.VideoProcessorSetStreamColorSpace1(&processor, 0, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
                let out_space = if pixels == Pixels::Nv12 { DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709 } else { DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709 };
                vc1.VideoProcessorSetOutputColorSpace1(&processor, out_space);
            }
            let full = RECT { left: 0, top: 0, right: width as i32, bottom: height as i32 };
            gpu.video_context.VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&full));
            gpu.video_context.VideoProcessorSetOutputTargetRect(&processor, true, Some(&full));
            Ok(Converter { enumerator, processor, source, input, target, output, staging, source_width, source_height, width, height, pixels })
        }
    }

    pub fn source(&self) -> &ID3D11Texture2D {
        &self.source
    }

    pub fn upload(&self, gpu: &Gpu, bgra: &[u8]) {
        let pitch = self.source_width * 4;
        if bgra.len() < (pitch * self.source_height) as usize {
            return;
        }
        unsafe {
            if let Ok(resource) = self.source.cast::<ID3D11Resource>() {
                gpu.context.UpdateSubresource(&resource, 0, None, bgra.as_ptr() as *const _, pitch, 0);
            }
        }
    }

    pub fn target(&self) -> &ID3D11Texture2D {
        &self.target
    }

    pub fn run(&self, gpu: &Gpu, crop: RECT, out: &mut Vec<u8>) -> Result<(), String> {
        self.blit(gpu, crop)?;
        self.read(gpu, out)
    }

    pub fn blit(&self, gpu: &Gpu, crop: RECT) -> Result<(), String> {
        let crop = RECT {
            left: crop.left.clamp(0, self.source_width as i32 - 2),
            top: crop.top.clamp(0, self.source_height as i32 - 2),
            right: crop.right.clamp(2, self.source_width as i32),
            bottom: crop.bottom.clamp(2, self.source_height as i32),
        };
        unsafe {
            gpu.video_context.VideoProcessorSetStreamSourceRect(&self.processor, 0, true, Some(&crop));
            let streams = [D3D11_VIDEO_PROCESSOR_STREAM { Enable: BOOL(1), pInputSurface: ManuallyDrop::new(Some(self.input.clone())), ..Default::default() }];
            let result = gpu.video_context.VideoProcessorBlt(&self.processor, &self.output, 0, &streams);
            let [stream] = streams;
            drop(ManuallyDrop::into_inner(stream.pInputSurface));
            result.map_err(|e| err("la placa no pudo convertir la imagen", e))?;
        }
        Ok(())
    }

    pub fn read(&self, gpu: &Gpu, out: &mut Vec<u8>) -> Result<(), String> {
        unsafe {
            let staging: ID3D11Resource = self.staging.cast().map_err(|e| err("textura", e))?;
            let target: ID3D11Resource = self.target.cast().map_err(|e| err("textura", e))?;
            gpu.context.CopyResource(&staging, &target);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            gpu.context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).map_err(|e| err("no se pudo leer la imagen de la placa", e))?;
            let base = mapped.pData as *const u8;
            let pitch = mapped.RowPitch as usize;
            let (w, h) = (self.width as usize, self.height as usize);
            out.clear();
            match self.pixels {
                Pixels::Nv12 => {
                    out.reserve(w * h * 3 / 2);
                    for row in 0..h {
                        out.extend_from_slice(std::slice::from_raw_parts(base.add(row * pitch), w));
                    }
                    let uv = base.add(pitch * h);
                    for row in 0..h / 2 {
                        out.extend_from_slice(std::slice::from_raw_parts(uv.add(row * pitch), w));
                    }
                }
                Pixels::Bgra => {
                    out.reserve(w * h * 4);
                    for row in 0..h {
                        out.extend_from_slice(std::slice::from_raw_parts(base.add(row * pitch), w * 4));
                    }
                }
            }
            gpu.context.Unmap(&staging, 0);
        }
        let _ = &self.enumerator;
        Ok(())
    }
}
