use anyhow::{anyhow, Context};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde_json::{json, Value};
use std::io::{Read, Write};

const MSG_FULL_CLIENT_REQUEST: u8 = 0x1;
const MSG_AUDIO_ONLY_REQUEST: u8 = 0x2;
const MSG_FULL_SERVER_RESPONSE: u8 = 0x9;
const MSG_ERROR: u8 = 0xf;
const FLAG_NO_SEQUENCE: u8 = 0x0;
const FLAG_POS_SEQUENCE: u8 = 0x1;
const FLAG_NEG_SEQUENCE: u8 = 0x3;
const SERIALIZATION_NONE: u8 = 0x0;
const SERIALIZATION_JSON: u8 = 0x1;
const COMPRESSION_NONE: u8 = 0x0;
const COMPRESSION_GZIP: u8 = 0x1;

#[derive(Debug, Clone)]
pub enum ServerFrame {
    Transcript(TranscriptFrame),
    Ack,
}

#[derive(Debug, Clone)]
pub struct TranscriptFrame {
    pub text: String,
    pub definite: bool,
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
}

pub fn default_endpoint() -> &'static str {
    "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
}

pub fn default_hotwords() -> Vec<String> {
    [
        "AI产品经理",
        "RAG",
        "Agent",
        "Workflow",
        "MCP",
        "Function Calling",
        "badcase",
        "MVP",
        "AI中台",
        "合同评审",
        "投标评审",
        "商机推送",
        "复杂PDF",
        "知识库",
    ]
    .iter()
    .map(|item| item.to_string())
    .collect()
}

pub fn build_full_client_request(hotwords: &[String]) -> anyhow::Result<Vec<u8>> {
    let hotword_json = json!({
        "hotwords": hotwords.iter().map(|word| json!({ "word": word })).collect::<Vec<_>>()
    });

    let payload = json!({
        "user": {
            "uid": "interview-copilot"
        },
        "audio": {
            "format": "pcm",
            "codec": "raw",
            "rate": 16000,
            "bits": 16,
            "channel": 1
        },
        "request": {
            "model_name": "bigmodel",
            "enable_nonstream": true,
            "enable_itn": true,
            "enable_punc": true,
            "enable_ddc": false,
            "show_utterances": true,
            "result_type": "full",
            "end_window_size": 800,
            "corpus": {
                "context": hotword_json.to_string()
            }
        }
    });

    let bytes = gzip(serde_json::to_vec(&payload)?)?;
    Ok(pack_payload(
        MSG_FULL_CLIENT_REQUEST,
        FLAG_NO_SEQUENCE,
        SERIALIZATION_JSON,
        COMPRESSION_GZIP,
        None,
        &bytes,
    ))
}

pub fn build_audio_request(sequence: i32, pcm: &[u8], is_last: bool) -> anyhow::Result<Vec<u8>> {
    let compressed = gzip(pcm.to_vec())?;
    let flags = if is_last {
        FLAG_NEG_SEQUENCE
    } else {
        FLAG_POS_SEQUENCE
    };
    let sequence = if is_last {
        -sequence.abs()
    } else {
        sequence.abs()
    };
    Ok(pack_payload(
        MSG_AUDIO_ONLY_REQUEST,
        flags,
        SERIALIZATION_NONE,
        COMPRESSION_GZIP,
        Some(sequence),
        &compressed,
    ))
}

pub fn build_last_audio_request(sequence: i32) -> Vec<u8> {
    build_audio_request(sequence, &[], true).unwrap_or_else(|_| {
        pack_payload(
            MSG_AUDIO_ONLY_REQUEST,
            FLAG_NEG_SEQUENCE,
            SERIALIZATION_NONE,
            COMPRESSION_NONE,
            Some(-sequence.abs()),
            &[],
        )
    })
}

pub fn parse_server_frame(frame: &[u8]) -> anyhow::Result<ServerFrame> {
    if frame.len() < 8 {
        return Err(anyhow!("豆包 ASR 返回帧过短"));
    }

    let header_size = ((frame[0] & 0x0f) as usize) * 4;
    let message_type = frame[1] >> 4;
    let flags = frame[1] & 0x0f;
    let compression = frame[2] & 0x0f;
    let mut cursor = header_size;

    if message_type == MSG_ERROR {
        let code = read_u32(frame, cursor)?;
        cursor += 4;
        let size = read_u32(frame, cursor)? as usize;
        cursor += 4;
        let message = String::from_utf8_lossy(frame.get(cursor..cursor + size).unwrap_or_default());
        return Err(anyhow!("豆包 ASR 错误 {code}: {message}"));
    }

    if message_type != MSG_FULL_SERVER_RESPONSE {
        return Ok(ServerFrame::Ack);
    }

    if matches!(flags, FLAG_POS_SEQUENCE | FLAG_NEG_SEQUENCE) {
        cursor += 4;
    }

    let payload_size = read_u32(frame, cursor)? as usize;
    cursor += 4;
    let payload = frame
        .get(cursor..cursor + payload_size)
        .ok_or_else(|| anyhow!("豆包 ASR payload 长度不正确"))?;

    let payload = if compression == COMPRESSION_GZIP {
        gunzip(payload)?
    } else if compression == COMPRESSION_NONE {
        payload.to_vec()
    } else {
        return Err(anyhow!("不支持的豆包 ASR 压缩类型: {compression}"));
    };

    let value: Value = serde_json::from_slice(&payload).context("解析豆包 ASR JSON 失败")?;
    Ok(extract_transcript(&value)
        .map(ServerFrame::Transcript)
        .unwrap_or(ServerFrame::Ack))
}

fn extract_transcript(value: &Value) -> Option<TranscriptFrame> {
    let result = value.get("result")?;
    let result_obj = if result.is_array() {
        result.as_array()?.first()?
    } else {
        result
    };

    let text = result_obj.get("text")?.as_str()?.trim().to_string();
    if text.is_empty() {
        return None;
    }

    let utterances = result_obj.get("utterances").and_then(Value::as_array);
    let definite = utterances
        .map(|items| {
            items.iter().any(|item| {
                item.get("definite")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    let last_utterance = utterances.and_then(|items| items.last());

    Some(TranscriptFrame {
        text,
        definite,
        start_ms: last_utterance
            .and_then(|item| item.get("start_time"))
            .and_then(Value::as_u64),
        end_ms: last_utterance
            .and_then(|item| item.get("end_time"))
            .and_then(Value::as_u64),
    })
}

fn pack_payload(
    message_type: u8,
    flags: u8,
    serialization: u8,
    compression: u8,
    sequence: Option<i32>,
    payload: &[u8],
) -> Vec<u8> {
    let mut output = Vec::with_capacity(12 + payload.len());
    output.extend_from_slice(&[
        0x11,
        (message_type << 4) | flags,
        (serialization << 4) | compression,
        0x00,
    ]);
    if let Some(sequence) = sequence {
        output.extend_from_slice(&sequence.to_be_bytes());
    }
    output.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    output.extend_from_slice(payload);
    output
}

fn gzip(input: Vec<u8>) -> anyhow::Result<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&input)?;
    Ok(encoder.finish()?)
}

fn gunzip(input: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut decoder = GzDecoder::new(input);
    let mut output = Vec::new();
    decoder.read_to_end(&mut output)?;
    Ok(output)
}

fn read_u32(frame: &[u8], cursor: usize) -> anyhow::Result<u32> {
    let bytes = frame
        .get(cursor..cursor + 4)
        .ok_or_else(|| anyhow!("豆包 ASR 帧缺少 u32 字段"))?;
    Ok(u32::from_be_bytes(
        bytes.try_into().expect("slice length checked"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_full_request() {
        let frame = build_full_client_request(&default_hotwords()).unwrap();
        assert_eq!(frame[0], 0x11);
        assert_eq!(frame[1] >> 4, MSG_FULL_CLIENT_REQUEST);
    }

    #[test]
    fn builds_audio_request_with_sequence() {
        let frame = build_audio_request(7, &[0, 1, 2], false).unwrap();
        assert_eq!(frame[1] >> 4, MSG_AUDIO_ONLY_REQUEST);
        assert_eq!(i32::from_be_bytes(frame[4..8].try_into().unwrap()), 7);
    }

    #[test]
    fn builds_last_audio_request_with_negative_sequence() {
        let frame = build_last_audio_request(8);
        assert_eq!(frame[1] >> 4, MSG_AUDIO_ONLY_REQUEST);
        assert_eq!(frame[1] & 0x0f, FLAG_NEG_SEQUENCE);
        assert_eq!(i32::from_be_bytes(frame[4..8].try_into().unwrap()), -8);
    }
}
