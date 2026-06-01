use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{fs, sync::OnceLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionItem {
    pub id: u32,
    pub question: String,
    pub answer: String,
}

fn heading_regex() -> &'static Regex {
    static HEADING: OnceLock<Regex> = OnceLock::new();
    HEADING.get_or_init(|| Regex::new(r"(?m)^(\d+)\.\s+(.+)$").expect("valid heading regex"))
}

pub fn load_question_bank(path: &str) -> anyhow::Result<Vec<QuestionItem>> {
    let content = fs::read_to_string(path)?;
    parse_question_bank(&content)
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

        if !question.is_empty() && !answer.is_empty() {
            items.push(QuestionItem {
                id,
                question,
                answer,
            });
        }
    }

    Ok(items)
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
    }
}

