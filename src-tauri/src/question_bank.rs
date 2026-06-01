use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionItem {
    pub id: u32,
    pub question: String,
    pub answer: String,
    pub answer_logic: String,
    pub answer_detail: String,
}

const EMBEDDED_QUESTION_BANK: &str = include_str!("question_bank_embedded.md");

fn heading_regex() -> &'static Regex {
    static HEADING: OnceLock<Regex> = OnceLock::new();
    HEADING.get_or_init(|| Regex::new(r"(?m)^(\d+)\.\s+(.+)$").expect("valid heading regex"))
}

pub fn load_embedded_question_bank() -> anyhow::Result<Vec<QuestionItem>> {
    parse_question_bank(EMBEDDED_QUESTION_BANK)
}

pub fn parse_question_bank(content: &str) -> anyhow::Result<Vec<QuestionItem>> {
    let matches: Vec<_> = heading_regex().captures_iter(content).collect();
    let mut items = Vec::with_capacity(matches.len());

    for (index, caps) in matches.iter().enumerate() {
        let full = caps.get(0).expect("full match");
        let next_start = matches
            .get(index + 1)
            .and_then(|next| next.get(0))
            .map(|next| next.start())
            .unwrap_or(content.len());

        let id = caps
            .get(1)
            .expect("id")
            .as_str()
            .parse::<u32>()?;
        let question = caps.get(2).expect("question").as_str().trim().to_string();
        let answer = content[full.end()..next_start].trim().to_string();
        let (answer_logic, answer_detail) = split_answer_sections(&answer);

        if !question.is_empty() && !answer.is_empty() {
            items.push(QuestionItem {
                id,
                question,
                answer,
                answer_logic,
                answer_detail,
            });
        }
    }

    Ok(items)
}

fn split_answer_sections(answer: &str) -> (String, String) {
    let logic_marker = "回答逻辑：";
    let detail_marker = "具体内容：";

    let Some(logic_start) = answer.find(logic_marker) else {
        return (String::new(), answer.trim().to_string());
    };
    let logic_content_start = logic_start + logic_marker.len();
    let Some(detail_relative_start) = answer[logic_content_start..].find(detail_marker) else {
        return (answer[logic_content_start..].trim().to_string(), String::new());
    };

    let detail_start = logic_content_start + detail_relative_start;
    let detail_content_start = detail_start + detail_marker.len();

    (
        answer[logic_content_start..detail_start].trim().to_string(),
        answer[detail_content_start..].trim().to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_numbered_markdown() {
        let content = "1. 问题一\n答案一\n\n2. 问题二\n答案二";
        let parsed = parse_question_bank(content).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].id, 1);
        assert_eq!(parsed[0].question, "问题一");
        assert_eq!(parsed[0].answer, "答案一");
        assert_eq!(parsed[0].answer_detail, "答案一");
    }

    #[test]
    fn parses_answer_logic_and_detail() {
        let content = "1. 问题一\n回答逻辑：\nA——B——C\n具体内容：\n【A】 第一段\n【B】 第二段";
        let parsed = parse_question_bank(content).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].answer_logic, "A——B——C");
        assert_eq!(parsed[0].answer_detail, "【A】 第一段\n【B】 第二段");
        assert!(parsed[0].answer.contains("回答逻辑："));
        assert!(parsed[0].answer.contains("具体内容："));
    }
}

