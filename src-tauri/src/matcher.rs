use crate::question_bank::QuestionItem;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchCandidate {
    pub id: u32,
    pub question: String,
    pub answer: String,
    pub answer_logic: String,
    pub answer_detail: String,
    pub score: u32,
    pub hit_terms: Vec<String>,
    pub highlight_terms: Vec<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchCandidatesEvent {
    pub query: String,
    pub locked: bool,
    pub candidates: Vec<MatchCandidate>,
    pub latency_ms: u128,
}

#[derive(Debug, Clone)]
struct IndexedQuestion {
    item: QuestionItem,
    question_tokens: HashSet<String>,
    answer_tokens: HashSet<String>,
    curated_hints: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Matcher {
    docs: Vec<IndexedQuestion>,
}

impl Matcher {
    pub fn new(items: Vec<QuestionItem>) -> Self {
        let docs = items
            .into_iter()
            .map(|item| {
                let curated_hints = curated_hints(item.id);
                let question_tokens = tokenize(&item.question);
                let mut answer_tokens = tokenize(&item.answer);
                for hint in &curated_hints {
                    answer_tokens.extend(tokenize(hint));
                }
                IndexedQuestion {
                    item,
                    question_tokens,
                    answer_tokens,
                    curated_hints,
                }
            })
            .collect();
        Self { docs }
    }

    pub fn search(&self, query: &str, locked_id: Option<u32>) -> Vec<MatchCandidate> {
        let started = Instant::now();
        if let Some(id) = locked_id {
            return self
                .docs
                .iter()
                .find(|doc| doc.item.id == id)
                .map(|doc| {
                    vec![candidate_from_doc(
                        doc,
                        100,
                        vec!["锁定".to_string()],
                        "locked",
                    )]
                })
                .unwrap_or_default();
        }

        let query = query.trim();
        if query.is_empty() {
            return Vec::new();
        }

        let query_tokens = tokenize(query);
        let query_norm = normalize(query);
        let idf = self.idf();

        let mut scored = self
            .docs
            .iter()
            .map(|doc| {
                let hint_hits = hint_hits(&query_norm, &doc.curated_hints);
                let mut raw_score = (hint_hits.len() as f64) * 18.0;
                let mut hit_terms: Vec<String> = hint_hits;

                for token in &query_tokens {
                    let token_weight = *idf.get(token).unwrap_or(&1.0);
                    if doc.question_tokens.contains(token) {
                        raw_score += 5.0 * token_weight;
                        if token.chars().count() >= 2 {
                            hit_terms.push(token.clone());
                        }
                    }
                    if doc.answer_tokens.contains(token) {
                        raw_score += 1.25 * token_weight;
                    }
                }

                if normalize(&doc.item.question).contains(&query_norm) {
                    raw_score += 30.0;
                }

                let score = raw_score.round().clamp(0.0, 99.0) as u32;
                (doc, score, dedupe(hit_terms))
            })
            .filter(|(_, score, _)| *score > 0)
            .collect::<Vec<_>>();

        scored.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.item.id.cmp(&b.0.item.id)));

        scored
            .into_iter()
            .take(3)
            .map(|(doc, score, hits)| {
                let mut candidate = candidate_from_doc(doc, score, hits, "candidate");
                if candidate.highlight_terms.is_empty() {
                    candidate.highlight_terms = query_tokens
                        .iter()
                        .filter(|token| token.chars().count() >= 2)
                        .take(10)
                        .cloned()
                        .collect();
                }
                let _ = started.elapsed();
                candidate
            })
            .collect()
    }

    pub fn search_with_event(&self, query: &str, locked_id: Option<u32>) -> MatchCandidatesEvent {
        let started = Instant::now();
        let candidates = self.search(query, locked_id);
        MatchCandidatesEvent {
            query: query.to_string(),
            locked: locked_id.is_some(),
            candidates,
            latency_ms: started.elapsed().as_millis(),
        }
    }

    fn idf(&self) -> HashMap<String, f64> {
        let mut df: HashMap<String, usize> = HashMap::new();
        for doc in &self.docs {
            let all_tokens = doc
                .question_tokens
                .union(&doc.answer_tokens)
                .cloned()
                .collect::<HashSet<_>>();
            for token in all_tokens {
                *df.entry(token).or_insert(0) += 1;
            }
        }

        let total = self.docs.len() as f64;
        df.into_iter()
            .map(|(token, count)| {
                let value = ((total - count as f64 + 0.5) / (count as f64 + 0.5) + 1.0).ln();
                (token, value.max(0.35))
            })
            .collect()
    }
}

fn candidate_from_doc(doc: &IndexedQuestion, score: u32, hits: Vec<String>, status: &str) -> MatchCandidate {
    let mut highlight_terms = hits.clone();
    highlight_terms.extend(doc.curated_hints.iter().take(8).cloned());
    MatchCandidate {
        id: doc.item.id,
        question: doc.item.question.clone(),
        answer: doc.item.answer.clone(),
        answer_logic: doc.item.answer_logic.clone(),
        answer_detail: doc.item.answer_detail.clone(),
        score,
        hit_terms: hits,
        highlight_terms: dedupe(highlight_terms),
        status: status.to_string(),
    }
}

fn normalize(input: &str) -> String {
    input
        .to_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_punctuation()
                || matches!(
                    ch,
                    '，' | '。' | '！' | '？' | '；' | '：' | '、' | '（' | '）' | '【' | '】'
                        | '《' | '》' | '“' | '”' | '"' | '\'' | '`'
                )
            {
                ' '
            } else {
                ch
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn tokenize(input: &str) -> HashSet<String> {
    let normalized = normalize(input);
    let mut tokens = HashSet::new();
    let mut ascii = String::new();
    let mut chinese = Vec::new();

    for ch in normalized.chars() {
        if ch.is_ascii_alphanumeric() {
            ascii.push(ch);
            continue;
        }
        if ascii.len() >= 2 {
            tokens.insert(ascii.clone());
        }
        ascii.clear();

        if ('\u{4e00}'..='\u{9fff}').contains(&ch) {
            chinese.push(ch);
            tokens.insert(ch.to_string());
        }
    }

    if ascii.len() >= 2 {
        tokens.insert(ascii);
    }

    for window in chinese.windows(2) {
        tokens.insert(window.iter().collect());
    }
    for window in chinese.windows(3) {
        tokens.insert(window.iter().collect());
    }

    tokens
}

fn hint_hits(query_norm: &str, hints: &[String]) -> Vec<String> {
    hints
        .iter()
        .filter(|hint| {
            let hint_norm = normalize(hint);
            query_norm.contains(&hint_norm) || hint_norm.contains(query_norm)
        })
        .cloned()
        .collect()
}

fn curated_hints(id: u32) -> Vec<String> {
    let raw: &[&str] = match id {
        4 => &["离开", "离职", "国企", "传统制造业", "薪资", "机会"],
        5 => &["期望薪资", "薪资", "工资", "给不到", "多少钱", "待遇", "薪酬"],
        9 => &["badcase", "反馈", "迭代", "机制", "准确率", "评测集", "标错", "漏标"],
        17 => &["badcase", "负反馈", "收集", "迭代", "优化", "评测集", "准确率"],
        20 => &["合同评审", "投标评审", "合同", "标书", "风险报告", "流程", "项目"],
        24 => &[
            "RAG", "复杂PDF", "PDF", "表格", "扫描件", "OCR", "知识库", "幻觉", "切片",
            "召回", "重排序", "向量",
        ],
        25 => &[
            "Agent",
            "Workflow",
            "Tool",
            "MCP",
            "Function Calling",
            "函数调用",
            "工作流",
        ],
        _ => &[],
    };
    raw.iter().map(|item| item.to_string()).collect()
}

fn dedupe(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .filter(|value| seen.insert(normalize(value)))
        .collect()
}

