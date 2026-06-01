mod audio;
mod doubao;
mod matcher;
mod question_bank;
mod session;

use audio::AudioCaptureHandle;
use matcher::Matcher;
use question_bank::{load_embedded_question_bank, QuestionItem};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use uuid::Uuid;

const DEFAULT_RESOURCE_ID: &str = "volc.seedasr.sauc.duration";

pub type AppSharedState = Arc<Mutex<InnerState>>;

#[derive(Default, Clone)]
pub struct AppState {
    inner: AppSharedState,
}

#[derive(Default)]
pub struct InnerState {
    question_bank: Vec<QuestionItem>,
    matcher: Option<Matcher>,
    matching_paused: bool,
    locked_answer: Option<u32>,
    session: Option<SessionHandle>,
}

pub struct SessionHandle {
    stop: Arc<AtomicBool>,
    audio: Option<AudioCaptureHandle>,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl SessionHandle {
    fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(audio) = self.audio.take() {
            audio.stop();
        }
        self.task.abort();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    WasapiLoopback,
    VirtualAudioDevice,
}

impl Default for CaptureMode {
    fn default() -> Self {
        Self::WasapiLoopback
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSettings {
    pub resource_id: String,
    pub capture_mode: CaptureMode,
    pub audio_device_id: Option<String>,
    pub save_audio: bool,
    pub session_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStarted {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStatusEvent {
    pub state: String,
    pub device_name: Option<String>,
    pub volume: Option<f32>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrTextEvent {
    pub text: String,
    pub definite: bool,
    pub utterance_start_ms: Option<u64>,
    pub utterance_end_ms: Option<u64>,
    pub received_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLogEvent {
    pub message: String,
    pub asr_log_id: Option<String>,
    pub save_audio: bool,
    pub asr_latency_ms: Option<u128>,
    pub match_latency_ms: Option<u128>,
}

#[tauri::command]
async fn list_audio_sources() -> Result<Vec<audio::AudioSource>, String> {
    audio::list_audio_sources()
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn start_session(
    app: AppHandle,
    state: State<'_, AppState>,
    mut settings: SessionSettings,
) -> Result<SessionStarted, String> {
    if settings.resource_id.trim().is_empty() {
        settings.resource_id = DEFAULT_RESOURCE_ID.to_string();
    }

    let api_key = resolve_api_key()?;
    let question_bank = load_embedded_question_bank()
        .map_err(|err| format!("读取内置问题库失败：{err}"))?;
    if question_bank.is_empty() {
        return Err("问题库为空，无法开始匹配".to_string());
    }
    let matcher = Matcher::new(question_bank.clone());

    {
        let mut inner = state.inner.lock().expect("state lock poisoned");
        if let Some(existing) = inner.session.take() {
            existing.stop();
        }
        inner.question_bank = question_bank;
        inner.matcher = Some(matcher);
        inner.matching_paused = false;
        inner.locked_answer = None;
    }

    let session_id = Uuid::new_v4().to_string();
    if settings.save_audio {
        let dir = std::env::current_dir()
            .map_err(|err| format!("获取当前目录失败：{err}"))?
            .join("sessions")
            .join(&session_id);
        std::fs::create_dir_all(&dir).map_err(|err| format!("创建会话保存目录失败：{err}"))?;
        settings.session_dir = Some(dir.to_string_lossy().to_string());
    }

    let stop = Arc::new(AtomicBool::new(false));
    let (audio_tx, audio_rx) = mpsc::channel::<Vec<u8>>(96);

    app.emit(
        "audio_status",
        AudioStatusEvent {
            state: "starting".to_string(),
            device_name: None,
            volume: Some(0.0),
            message: "正在启动系统声音采集".to_string(),
        },
    )
    .ok();

    let audio = audio::spawn_capture(app.clone(), settings.clone(), audio_tx, stop.clone())
        .await
        .map_err(|err| format!("启动系统声音采集失败：{err}"))?;

    let shared = state.inner.clone();
    let task_stop = stop.clone();
    let task_settings = settings.clone();
    let task = tauri::async_runtime::spawn(async move {
        if let Err(err) = session::run_asr_session(app.clone(), shared, task_settings, api_key, audio_rx, task_stop.clone()).await {
            let _ = app.emit(
                "audio_status",
                AudioStatusEvent {
                    state: "error".to_string(),
                    device_name: None,
                    volume: None,
                    message: format!("ASR 会话失败：{err}"),
                },
            );
            task_stop.store(true, Ordering::SeqCst);
        }
    });

    {
        let mut inner = state.inner.lock().expect("state lock poisoned");
        inner.session = Some(SessionHandle {
            stop,
            audio: Some(audio),
            task,
        });
    }

    Ok(SessionStarted {
        session_id,
    })
}

#[tauri::command]
async fn stop_session(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let existing = {
        let mut inner = state.inner.lock().expect("state lock poisoned");
        inner.matching_paused = false;
        inner.locked_answer = None;
        inner.session.take()
    };

    if let Some(session) = existing {
        session.stop();
    }

    app.emit(
        "audio_status",
        AudioStatusEvent {
            state: "stopped".to_string(),
            device_name: None,
            volume: Some(0.0),
            message: "监听已停止".to_string(),
        },
    )
    .ok();
    Ok(())
}

#[tauri::command]
async fn pause_matching(state: State<'_, AppState>) -> Result<(), String> {
    let mut inner = state.inner.lock().expect("state lock poisoned");
    inner.matching_paused = true;
    Ok(())
}

#[tauri::command]
async fn resume_matching(state: State<'_, AppState>) -> Result<(), String> {
    let mut inner = state.inner.lock().expect("state lock poisoned");
    inner.matching_paused = false;
    Ok(())
}

#[tauri::command]
async fn lock_answer(app: AppHandle, state: State<'_, AppState>, question_id: u32) -> Result<(), String> {
    let event = {
        let mut inner = state.inner.lock().expect("state lock poisoned");
        inner.locked_answer = Some(question_id);
        inner
            .matcher
            .as_ref()
            .map(|matcher| matcher.search_with_event("", Some(question_id)))
    };

    if let Some(event) = event {
        app.emit("match_candidates", event).ok();
    }
    Ok(())
}

#[tauri::command]
async fn unlock_answer(state: State<'_, AppState>) -> Result<(), String> {
    let mut inner = state.inner.lock().expect("state lock poisoned");
    inner.locked_answer = None;
    Ok(())
}

#[tauri::command]
async fn search_questions(state: State<'_, AppState>, query: String) -> Result<Vec<matcher::MatchCandidate>, String> {
    let matcher = {
        let mut inner = state.inner.lock().expect("state lock poisoned");
        if inner.matcher.is_none() {
            let bank = load_embedded_question_bank()
                .map_err(|err| format!("读取内置问题库失败：{err}"))?;
            inner.question_bank = bank.clone();
            inner.matcher = Some(Matcher::new(bank));
        }
        inner.matcher.clone()
    };

    matcher
        .map(|matcher| matcher.search(&query, None))
        .ok_or_else(|| "问题匹配器未初始化".to_string())
}

fn resolve_api_key() -> Result<String, String> {
    let value = std::env::var("DOUBAO_API_KEY")
        .or_else(|_| std::env::var("VOLCENGINE_ASR_API_KEY"))
        .map(|value| value.trim().to_string())
        .map_err(|_| "未检测到豆包 API Key。请在 Windows 用户环境变量中配置 DOUBAO_API_KEY，重启应用后会自动读取。".to_string())?;

    if value.len() < 16 {
        return Err("豆包 API Key 看起来过短，请检查 Windows 环境变量 DOUBAO_API_KEY。".to_string());
    }
    Ok(value)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            list_audio_sources,
            start_session,
            stop_session,
            pause_matching,
            resume_matching,
            lock_answer,
            unlock_answer,
            search_questions
        ])
        .run(tauri::generate_context!())
        .expect("error while running Interview Copilot");
}

