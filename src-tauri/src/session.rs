use crate::doubao::{self, ServerFrame};
use crate::matcher::Matcher;
use crate::{AppSharedState, AsrTextEvent, SessionLogEvent, SessionSettings};
use anyhow::{anyhow, Context};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message};
use uuid::Uuid;

pub async fn run_asr_session(
    app: AppHandle,
    shared: AppSharedState,
    settings: SessionSettings,
    api_key: String,
    mut audio_rx: mpsc::Receiver<Vec<u8>>,
    stop: Arc<AtomicBool>,
) -> anyhow::Result<()> {
    let endpoint = doubao::default_endpoint();
    let request_id = Uuid::new_v4().to_string();
    let mut request = endpoint.into_client_request()?;
    {
        let headers = request.headers_mut();
        headers.insert("X-Api-Key", HeaderValue::from_str(&api_key)?);
        headers.insert(
            "X-Api-Resource-Id",
            HeaderValue::from_str(&settings.resource_id)?,
        );
        headers.insert("X-Api-Request-Id", HeaderValue::from_str(&request_id)?);
        headers.insert("X-Api-Sequence", HeaderValue::from_static("-1"));
    }

    emit_log(
        &app,
        SessionLogEvent {
            message: format!(
                "正在连接豆包流式 ASR · resource={} · request={}",
                settings.resource_id, request_id
            ),
            asr_log_id: None,
            save_audio: settings.save_audio,
            asr_latency_ms: None,
            match_latency_ms: None,
        },
    );

    let connect_started = Instant::now();
    let (ws_stream, response) = tokio::time::timeout(
        Duration::from_secs(20),
        tokio_tungstenite::connect_async(request),
    )
    .await
    .context("连接豆包流式 ASR 超时，请检查网络或火山引擎服务可用性")?
    .context("连接豆包流式 ASR 失败")?;
    let asr_log_id = response
        .headers()
        .get("X-Tt-Logid")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    emit_log(
        &app,
        SessionLogEvent {
            message: format!(
                "豆包流式 ASR 已连接 · {}ms",
                connect_started.elapsed().as_millis()
            ),
            asr_log_id: asr_log_id.clone(),
            save_audio: settings.save_audio,
            asr_latency_ms: None,
            match_latency_ms: None,
        },
    );

    let (mut write, mut read) = ws_stream.split();
    let hotwords = doubao::default_hotwords();
    write
        .send(Message::Binary(doubao::build_full_client_request(
            &hotwords,
        )?))
        .await
        .context("发送豆包 full client request 失败")?;
    emit_log(
        &app,
        SessionLogEvent {
            message: format!("豆包 full request 已发送 · 热词 {} 个", hotwords.len()),
            asr_log_id: asr_log_id.clone(),
            save_audio: settings.save_audio,
            asr_latency_ms: None,
            match_latency_ms: None,
        },
    );

    let mut sequence = 1i32;
    let mut audio_chunks_sent = 0u64;
    let mut last_audio_sent = Instant::now();

    loop {
        if stop.load(Ordering::SeqCst) {
            let _ = write
                .send(Message::Binary(doubao::build_last_audio_request(sequence)))
                .await;
            emit_log(
                &app,
                SessionLogEvent {
                    message: format!("停止信号已发送到豆包 ASR · audio_chunks={audio_chunks_sent}"),
                    asr_log_id: asr_log_id.clone(),
                    save_audio: settings.save_audio,
                    asr_latency_ms: None,
                    match_latency_ms: None,
                },
            );
            break;
        }

        tokio::select! {
            maybe_chunk = audio_rx.recv() => {
                if let Some(chunk) = maybe_chunk {
                    sequence += 1;
                    audio_chunks_sent += 1;
                    last_audio_sent = Instant::now();
                    let frame = doubao::build_audio_request(sequence, &chunk, false)?;
                    write.send(Message::Binary(frame)).await.context("发送豆包音频包失败")?;
                    if audio_chunks_sent == 1 || audio_chunks_sent % 10 == 0 {
                        emit_log(
                            &app,
                            SessionLogEvent {
                                message: format!("豆包音频包已发送 · chunks={} · seq={} · bytes={}", audio_chunks_sent, sequence, chunk.len()),
                                asr_log_id: asr_log_id.clone(),
                                save_audio: settings.save_audio,
                                asr_latency_ms: None,
                                match_latency_ms: None,
                            },
                        );
                    }
                } else {
                    stop.store(true, Ordering::SeqCst);
                }
            }
            maybe_message = read.next() => {
                match maybe_message {
                    Some(Ok(Message::Binary(frame))) => {
                        match doubao::parse_server_frame(&frame) {
                            Ok(ServerFrame::Transcript(transcript)) => {
                                let latency = last_audio_sent.elapsed().as_millis();
                                handle_transcript(
                                    &app,
                                    shared.clone(),
                                    &transcript.text,
                                    transcript.definite,
                                    transcript.start_ms,
                                    transcript.end_ms,
                                    Some(latency),
                                    settings.save_audio,
                                    settings.session_dir.as_deref(),
                                );
                            }
                            Ok(ServerFrame::Ack) => {}
                            Err(err) => emit_log(
                                &app,
                                SessionLogEvent {
                                    message: format!("豆包响应解析失败：{err}"),
                                    asr_log_id: asr_log_id.clone(),
                                    save_audio: settings.save_audio,
                                    asr_latency_ms: None,
                                    match_latency_ms: None,
                                },
                            ),
                        }
                    }
                    Some(Ok(Message::Close(_))) => {
                        return Err(anyhow!("豆包 ASR WebSocket 已关闭"));
                    }
                    Some(Ok(_)) => {}
                    Some(Err(err)) => return Err(anyhow!("豆包 ASR WebSocket 错误：{err}")),
                    None => return Err(anyhow!("豆包 ASR WebSocket 连接结束")),
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
    }

    emit_log(
        &app,
        SessionLogEvent {
            message: "豆包流式 ASR 已停止".to_string(),
            asr_log_id,
            save_audio: settings.save_audio,
            asr_latency_ms: None,
            match_latency_ms: None,
        },
    );

    Ok(())
}

fn handle_transcript(
    app: &AppHandle,
    shared: AppSharedState,
    text: &str,
    definite: bool,
    start_ms: Option<u64>,
    end_ms: Option<u64>,
    asr_latency_ms: Option<u128>,
    save_audio: bool,
    session_dir: Option<&str>,
) {
    let event_name = if definite { "asr_final" } else { "asr_partial" };
    let asr_event = AsrTextEvent {
        text: text.to_string(),
        definite,
        utterance_start_ms: start_ms,
        utterance_end_ms: end_ms,
        received_at: now_ms(),
    };
    let _ = app.emit(event_name, asr_event.clone());
    if save_audio {
        append_jsonl(
            session_dir,
            "transcript.jsonl",
            &json!({
                "text": asr_event.text,
                "definite": asr_event.definite,
                "utteranceStartMs": asr_event.utterance_start_ms,
                "utteranceEndMs": asr_event.utterance_end_ms,
                "receivedAt": asr_event.received_at
            }),
        );
    }

    let maybe_match = {
        let inner = shared.lock().expect("state lock poisoned");
        if inner.matching_paused {
            None
        } else {
            let answer_locked = inner.locked_answer.is_some();
            inner.matcher.as_ref().map(|matcher: &Matcher| {
                let mut event = matcher.search_with_event(text, None);
                event.locked = answer_locked;
                event.definite = definite;
                event.received_at = asr_event.received_at;
                event
            })
        }
    };

    if let Some(event) = maybe_match {
        let match_latency = event.latency_ms;
        if save_audio {
            append_jsonl(session_dir, "matches.jsonl", &event);
        }
        let _ = app.emit("match_candidates", event);
        emit_log(
            app,
            SessionLogEvent {
                message: if definite {
                    "稳定分句已触发匹配".to_string()
                } else {
                    "流式候选已刷新".to_string()
                },
                asr_log_id: None,
                save_audio,
                asr_latency_ms,
                match_latency_ms: Some(match_latency),
            },
        );
    }
}

fn append_jsonl<T: serde::Serialize>(session_dir: Option<&str>, filename: &str, payload: &T) {
    let Some(session_dir) = session_dir else {
        return;
    };
    let path = Path::new(session_dir).join(filename);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        if serde_json::to_writer(&mut file, payload).is_ok() {
            let _ = file.write_all(b"\n");
        }
    }
}

fn emit_log(app: &AppHandle, payload: SessionLogEvent) {
    println!(
        "[interview-copilot][session] {}{}{}{}",
        payload.message,
        payload
            .asr_log_id
            .as_deref()
            .map(|log_id| format!(" · logid={log_id}"))
            .unwrap_or_default(),
        payload
            .asr_latency_ms
            .map(|latency| format!(" · asr_latency={latency}ms"))
            .unwrap_or_default(),
        payload
            .match_latency_ms
            .map(|latency| format!(" · match_latency={latency}ms"))
            .unwrap_or_default(),
    );
    let _ = app.emit("session_log", payload);
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
