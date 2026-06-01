use crate::{AudioStatusEvent, CaptureMode, SessionSettings};
use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::io::Write;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

const PCM_200MS_BYTES: usize = 16_000 * 2 / 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSource {
    pub id: String,
    pub name: String,
    pub capture_mode: CaptureMode,
    pub is_default: bool,
    pub available: bool,
    pub note: Option<String>,
}

pub struct AudioCaptureHandle {
    pub stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl AudioCaptureHandle {
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub async fn list_audio_sources() -> anyhow::Result<Vec<AudioSource>> {
    platform::list_audio_sources()
}

pub async fn spawn_capture(
    app: AppHandle,
    settings: SessionSettings,
    audio_tx: mpsc::Sender<Vec<u8>>,
    stop: Arc<AtomicBool>,
) -> anyhow::Result<AudioCaptureHandle> {
    platform::spawn_capture(app, settings, audio_tx, stop)
}

fn emit_audio_status(app: &AppHandle, state: &str, device_name: Option<String>, volume: Option<f32>, message: impl Into<String>) {
    let _ = app.emit(
        "audio_status",
        AudioStatusEvent {
            state: state.to_string(),
            device_name,
            volume,
            message: message.into(),
        },
    );
}

fn rms_volume_i16(pcm: &[u8]) -> f32 {
    let mut sum = 0.0f64;
    let mut count = 0.0f64;
    for chunk in pcm.chunks_exact(2) {
        let sample = i16::from_le_bytes([chunk[0], chunk[1]]) as f64 / i16::MAX as f64;
        sum += sample * sample;
        count += 1.0;
    }
    if count == 0.0 {
        0.0
    } else {
        (sum / count).sqrt() as f32
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    pub fn list_audio_sources() -> anyhow::Result<Vec<AudioSource>> {
        Ok(vec![AudioSource {
            id: "windows-only".to_string(),
            name: "Windows WASAPI loopback only".to_string(),
            capture_mode: CaptureMode::WasapiLoopback,
            is_default: true,
            available: false,
            note: Some("当前运行环境不是 Windows，音频采集模块只能在 Windows 桌面端工作。".to_string()),
        }])
    }

    pub fn spawn_capture(
        app: AppHandle,
        _settings: SessionSettings,
        _audio_tx: mpsc::Sender<Vec<u8>>,
        stop: Arc<AtomicBool>,
    ) -> anyhow::Result<AudioCaptureHandle> {
        emit_audio_status(
            &app,
            "error",
            None,
            None,
            "当前环境不是 Windows，无法采集系统输出声音。请在 Windows 上运行桌面端。",
        );
        stop.store(true, Ordering::SeqCst);
        Err(anyhow::anyhow!("Windows WASAPI loopback is required for live system-audio capture"))
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use wasapi::{initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

    pub fn list_audio_sources() -> anyhow::Result<Vec<AudioSource>> {
        initialize_mta().ok().context("初始化 Windows COM 失败")?;
        let enumerator = DeviceEnumerator::new().context("创建 WASAPI device enumerator 失败")?;
        let default_render_id = enumerator
            .get_default_device(&Direction::Render)
            .ok()
            .and_then(|device| device.get_id().ok());

        let mut sources = Vec::new();
        let render_devices = enumerator.get_device_collection(&Direction::Render)?;
        for device_result in &render_devices {
            let device = device_result?;
            let id = device.get_id()?;
            let name = device.get_friendlyname().unwrap_or_else(|_| "系统输出设备".to_string());
            sources.push(AudioSource {
                is_default: default_render_id.as_deref() == Some(id.as_str()),
                id,
                name: format!("系统声音：{name}"),
                capture_mode: CaptureMode::WasapiLoopback,
                available: true,
                note: None,
            });
        }

        let capture_devices = enumerator.get_device_collection(&Direction::Capture)?;
        for device_result in &capture_devices {
            let device = device_result?;
            let id = device.get_id()?;
            let name = device.get_friendlyname().unwrap_or_else(|_| "输入设备".to_string());
            let lower = name.to_lowercase();
            let likely_virtual = ["cable", "voicemeeter", "stereo mix", "virtual", "what u hear"]
                .iter()
                .any(|needle| lower.contains(needle));
            if likely_virtual {
                sources.push(AudioSource {
                    id,
                    name: format!("虚拟声卡：{name}"),
                    capture_mode: CaptureMode::VirtualAudioDevice,
                    is_default: false,
                    available: true,
                    note: Some("作为 WASAPI loopback 采不到会议声时的兜底路径。".to_string()),
                });
            }
        }

        Ok(sources)
    }

    pub fn spawn_capture(
        app: AppHandle,
        settings: SessionSettings,
        audio_tx: mpsc::Sender<Vec<u8>>,
        stop: Arc<AtomicBool>,
    ) -> anyhow::Result<AudioCaptureHandle> {
        let thread_stop = stop.clone();
        let thread = thread::Builder::new()
            .name("system-audio-capture".to_string())
            .spawn(move || {
                if let Err(err) = run_capture_thread(app.clone(), settings, audio_tx, thread_stop.clone()) {
                    emit_audio_status(&app, "error", None, None, format!("系统声音采集失败：{err}"));
                    thread_stop.store(true, Ordering::SeqCst);
                }
            })
            .context("启动音频采集线程失败")?;

        Ok(AudioCaptureHandle {
            stop,
            thread: Some(thread),
        })
    }

    fn run_capture_thread(
        app: AppHandle,
        settings: SessionSettings,
        audio_tx: mpsc::Sender<Vec<u8>>,
        stop: Arc<AtomicBool>,
    ) -> anyhow::Result<()> {
        initialize_mta().ok().context("初始化 Windows COM 失败")?;
        let enumerator = DeviceEnumerator::new().context("创建 WASAPI device enumerator 失败")?;
        let device = if let Some(device_id) = settings.audio_device_id.as_deref() {
            enumerator.get_device(device_id)?
        } else if settings.capture_mode == CaptureMode::WasapiLoopback {
            enumerator.get_default_device(&Direction::Render)?
        } else {
            enumerator.get_default_device(&Direction::Capture)?
        };

        let device_name = device
            .get_friendlyname()
            .unwrap_or_else(|_| "Windows audio device".to_string());
        let mut audio_client = device.get_iaudioclient()?;
        let wave_format = WaveFormat::new(16, 16, &SampleType::Int, 16_000, 1, None);
        let stream_mode = StreamMode::PollingShared {
            autoconvert: true,
            buffer_duration_hns: 2_000_000,
        };
        let direction = Direction::Capture;

        audio_client.initialize_client(&wave_format, &direction, &stream_mode)?;
        let capture_client = audio_client.get_audiocaptureclient()?;
        audio_client.start_stream()?;
        emit_audio_status(
            &app,
            "capturing",
            Some(device_name.clone()),
            Some(0.0),
            format!("正在采集系统声音：{device_name}"),
        );

        let mut packet_buffer = Vec::with_capacity(PCM_200MS_BYTES * 2);
        let mut audio_file = if settings.save_audio {
            settings.session_dir.as_ref().and_then(|dir| {
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(std::path::Path::new(dir).join("system-audio.pcm"))
                    .ok()
            })
        } else {
            None
        };

        while !stop.load(Ordering::SeqCst) {
            let Some(packet_frames) = capture_client.get_next_packet_size()? else {
                thread::sleep(Duration::from_millis(8));
                continue;
            };

            if packet_frames == 0 {
                thread::sleep(Duration::from_millis(8));
                continue;
            }

            let bytes_to_read = packet_frames as usize * wave_format.get_blockalign() as usize;
            let mut data = vec![0u8; bytes_to_read];
            let (_frames_read, _buffer_info) = capture_client.read_from_device(&mut data)?;
            packet_buffer.extend_from_slice(&data);

            while packet_buffer.len() >= PCM_200MS_BYTES {
                let chunk = packet_buffer.drain(..PCM_200MS_BYTES).collect::<Vec<_>>();
                if let Some(file) = audio_file.as_mut() {
                    let _ = file.write_all(&chunk);
                }
                let volume = rms_volume_i16(&chunk);
                emit_audio_status(
                    &app,
                    "capturing",
                    Some(device_name.clone()),
                    Some(volume),
                    format!("正在采集系统声音：{device_name}"),
                );
                if audio_tx.blocking_send(chunk).is_err() {
                    stop.store(true, Ordering::SeqCst);
                    break;
                }
            }
        }

        let _ = audio_client.stop_stream();
        emit_audio_status(&app, "stopped", Some(device_name), Some(0.0), "系统声音采集已停止");
        Ok(())
    }
}

