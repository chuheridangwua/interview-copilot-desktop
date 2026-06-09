from __future__ import annotations

import argparse
import asyncio
import csv
import json
import math
import os
import re
import statistics
import sys
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

from openai import AsyncOpenAI


MODEL = "doubao-seed-2-0-pro-260215"
BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
CONCURRENCY = 5
TOP_N = 50
MAX_RETRIES = 3

DATE_PATTERNS = [
    re.compile(r"(?P<y>\d{4})-(?P<m>\d{2})-(?P<d>\d{2})"),
    re.compile(r"(?P<y>\d{4})年(?P<m>\d{1,2})月(?P<d>\d{1,2})日"),
]
FIVE_PLUS_RE = re.compile(r"(?:^|[^0-9])(?:5年(?:及以上|以上)|五年(?:及以上|以上)|至少5年|5\+\s*年)")
MASTER_PLUS_RE = re.compile(
    r"(?:硕士(?:研究生)?(?:及以上|以上)?学历|研究生(?:及以上|以上)?学历|硕士及以上|研究生及以上|仅限硕士|必须硕士|硕博(?:及以上)?|硕士研究生)"
)

SYSTEM_PROMPT = """你是一个严谨的中文岗位匹配评分员。

任务：根据“简历”和“单条岗位”，输出该岗位对候选人的匹配评分。

硬规则：
1. 只根据提供的简历和岗位文本判断，不能臆造未给出的经历。
2. 分数必须拉开，不要机械集中在 75-85。
3. 90-100 只给极强同构岗位；60 以下给明显不合适或迁移成本过高岗位。
4. 如果岗位偏纯 C 端增长、纯广告投放、纯内容运营、强领域专才且简历没有对应沉淀，应主动下调。
5. 需要重点看企业 AI、ToB、流程提效、Agent、RAG、工作流、中台、权限、评测闭环、产品工程能力。

评分维度：
- business_scene_fit: 0-25，业务场景匹配度
- platform_agent_fit: 0-25，平台 / Agent / 工作流 / 工具链匹配度
- execution_fit: 0-20，0-1 落地、跨团队推进、上线复盘匹配度
- technical_fit: 0-15，LLM / RAG / MCP / Skill / coding / 工程理解匹配度
- domain_transfer_fit: 0-15，领域迁移成本，越容易迁移分越高

总分要求：
- total_score = 五个子分数之和
- 90-100：极强匹配
- 80-89：强匹配
- 70-79：中高匹配
- 60-69：部分匹配
- 0-59：弱匹配

输出要求：
仅输出一个 JSON 对象，不要输出 markdown，不要输出解释性前缀。
JSON 字段必须包含：
{
  "total_score": 0,
  "business_scene_fit": 0,
  "platform_agent_fit": 0,
  "execution_fit": 0,
  "technical_fit": 0,
  "domain_transfer_fit": 0,
  "confidence": "high|medium|low",
  "verdict": "strong_match|match|partial|weak",
  "reason": "80字以内中文总结",
  "strengths": ["...", "..."],
  "risks": ["...", "..."]
}
"""


@dataclass
class NormalizedJob:
    company: str
    source_file: str
    source_row_index: int
    title: str
    business_line: str
    location: str
    publish_date: str
    post_url: str
    jd_text: str
    responsibility: str
    requirement_text: str
    experience_text: str
    source_schema: str
    raw: dict[str, Any]


def read_windows_env(name: str) -> str:
    if os.name != "nt":
        return ""
    try:
        import winreg
    except ImportError:
        return ""

    targets = [
        (winreg.HKEY_CURRENT_USER, r"Environment"),
        (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
    ]
    for root, subkey in targets:
        try:
            with winreg.OpenKey(root, subkey) as key:
                value, _ = winreg.QueryValueEx(key, name)
            if value:
                return str(value).strip()
        except OSError:
            continue
    return ""


def resolve_ark_api_key() -> str:
    return (
        os.getenv("ARK_API_KEY", "").strip()
        or read_windows_env("ARK_API_KEY")
        or os.getenv("VOLCENGINE_ARK_API_KEY", "").strip()
        or read_windows_env("VOLCENGINE_ARK_API_KEY")
        or os.getenv("DOUBAO_ARK_API_KEY", "").strip()
        or read_windows_env("DOUBAO_ARK_API_KEY")
    )


def subtract_months(value: date, months: int) -> date:
    year = value.year
    month = value.month - months
    while month <= 0:
        month += 12
        year -= 1
    day = min(value.day, days_in_month(year, month))
    return date(year, month, day)


def days_in_month(year: int, month: int) -> int:
    if month == 12:
        next_month = date(year + 1, 1, 1)
    else:
        next_month = date(year, month + 1, 1)
    return (next_month - date(year, month, 1)).days


def parse_date(text: str) -> date:
    value = str(text or "").strip()
    if not value:
        raise ValueError("empty date")
    for pattern in DATE_PATTERNS:
        match = pattern.search(value)
        if match:
            return date(int(match["y"]), int(match["m"]), int(match["d"]))
    if value.isdigit():
        ts = int(value)
        if ts > 10_000_000_000:
            ts = ts / 1000
        return datetime.utcfromtimestamp(ts).date()
    raise ValueError(f"unsupported date format: {value}")


def csv_read(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def join_text(*parts: str) -> str:
    return "\n\n".join(part.strip() for part in parts if str(part or "").strip())


def join_inline(*parts: str) -> str:
    return " / ".join(part.strip() for part in parts if str(part or "").strip())


def infer_company(path: Path, explicit: str | None) -> str:
    if explicit:
        return explicit
    return path.parent.name


def split_bytedance_business_line(title: str, category: str, parent_category: str) -> str:
    parts = [segment.strip() for segment in re.split(r"[-—－]", title) if segment.strip()]
    if len(parts) >= 2:
        return parts[-1]
    return " / ".join(item for item in [parent_category, category] if item).strip(" /")


def normalize_row(path: Path, company: str, row_index: int, row: dict[str, str]) -> NormalizedJob:
    if "RecruitPostName" in row:
        title = row.get("RecruitPostName", "").strip()
        bg = row.get("BGName", "").strip()
        product = row.get("ProductName", "").strip()
        business_line = " / ".join(item for item in [bg, product] if item)
        responsibility = row.get("Responsibility", "").strip()
        requirement_text = row.get("RequireWorkYearsName", "").strip()
        publish_date = parse_date(row.get("LastUpdateTime", "")).isoformat()
        return NormalizedJob(
            company=company,
            source_file=str(path),
            source_row_index=row_index,
            title=title,
            business_line=business_line,
            location=row.get("LocationName", "").strip(),
            publish_date=publish_date,
            post_url=row.get("PostURL", "").strip(),
            jd_text=responsibility,
            responsibility=responsibility,
            requirement_text=requirement_text,
            experience_text=requirement_text,
            source_schema="tencent",
            raw=row,
        )
    if "title" in row and "job_link" in row:
        title = row.get("title", "").strip()
        description = row.get("description", "").strip()
        requirement_text = row.get("requirement", "").strip()
        publish_date = parse_date(row.get("publish_date", "")).isoformat()
        return NormalizedJob(
            company=company,
            source_file=str(path),
            source_row_index=row_index,
            title=title,
            business_line=split_bytedance_business_line(
                title,
                row.get("job_category_name", "").strip(),
                row.get("job_category_parent_name", "").strip(),
            ),
            location=row.get("city_name", "").strip(),
            publish_date=publish_date,
            post_url=row.get("job_link", "").strip(),
            jd_text=join_text(f"岗位职责：\n{description}", f"任职要求：\n{requirement_text}"),
            responsibility=description,
            requirement_text=requirement_text,
            experience_text=requirement_text,
            source_schema="bytedance",
            raw=row,
        )
    if "title" in row and "post_url" in row and "jd_text" in row:
        title = row.get("title", "").strip()
        description = row.get("responsibility", "").strip()
        requirement_text = row.get("requirement_text", "").strip()
        source_schema = row.get("source_schema", "").strip() or "alibaba_family"
        publish_raw = (
            row.get("publish_date", "").strip()
            or row.get("raw_publish_time", "").strip()
            or row.get("raw_modify_time", "").strip()
        )
        publish_date = parse_date(publish_raw).isoformat()
        business_line = row.get("business_line", "").strip() or join_inline(
            row.get("company", "").strip(),
            row.get("department", "").strip(),
            row.get("project", "").strip(),
            row.get("category_name", "").strip(),
            row.get("batch_name", "").strip(),
        )
        jd_text = row.get("jd_text", "").strip() or join_text(
            f"岗位职责：\n{description}",
            f"任职要求：\n{requirement_text}",
        )
        return NormalizedJob(
            company=row.get("company", "").strip() or company,
            source_file=str(path),
            source_row_index=row_index,
            title=title,
            business_line=business_line,
            location=row.get("location", "").strip(),
            publish_date=publish_date,
            post_url=row.get("post_url", "").strip(),
            jd_text=jd_text,
            responsibility=description,
            requirement_text=requirement_text,
            experience_text=row.get("experience_text", "").strip() or requirement_text,
            source_schema=source_schema,
            raw=row,
        )
    raise ValueError(f"unsupported csv schema: {path}")


def requires_five_plus(text: str) -> bool:
    normalized = re.sub(r"\s+", "", str(text or ""))
    return bool(FIVE_PLUS_RE.search(normalized))


def requires_master_plus(text: str) -> bool:
    normalized = re.sub(r"\s+", "", str(text or ""))
    return bool(MASTER_PLUS_RE.search(normalized))


def filter_jobs(jobs: list[NormalizedJob], cutoff_date: date) -> tuple[list[NormalizedJob], list[dict[str, Any]]]:
    kept: list[NormalizedJob] = []
    audit: list[dict[str, Any]] = []
    for job in jobs:
        reasons: list[str] = []
        publish_day = parse_date(job.publish_date)
        if publish_day < cutoff_date:
            reasons.append(f"发布日期早于{cutoff_date.isoformat()}")
        if requires_five_plus(job.experience_text) or requires_five_plus(job.requirement_text):
            reasons.append("要求5年以上工作经验")
        if requires_master_plus(job.requirement_text) or requires_master_plus(job.jd_text):
            reasons.append("要求硕士或研究生及以上学历")

        audit.append(
            {
                "company": job.company,
                "source_row_index": job.source_row_index,
                "title": job.title,
                "location": job.location,
                "publish_date": job.publish_date,
                "post_url": job.post_url,
                "business_line": job.business_line,
                "filter_keep": not reasons,
                "filter_reasons": "；".join(reasons),
                "source_schema": job.source_schema,
            }
        )
        if not reasons:
            kept.append(job)
    return kept, audit


def build_prompt(resume_text: str, job: NormalizedJob) -> str:
    job_payload = {
        "company": job.company,
        "title": job.title,
        "business_line": job.business_line,
        "location": job.location,
        "publish_date": job.publish_date,
        "post_url": job.post_url,
        "jd_text": job.jd_text,
        "experience_text": job.experience_text,
    }
    return (
        "请按既定评分标准，对下面这位候选人与单条岗位做匹配评分。\n"
        "注意：当前阶段已经完成“近3个月 + 排除5年以上”过滤，因此你在评分时不要再因为 0-5 年细分年限做硬性否决，"
        "但可以把明显 senior 化要求体现在领域迁移或风险里。\n\n"
        "【简历】\n"
        f"{resume_text.strip()}\n\n"
        "【岗位】\n"
        f"{json.dumps(job_payload, ensure_ascii=False, indent=2)}"
    )


def extract_json_object(text: str) -> dict[str, Any]:
    value = str(text or "").strip()
    if not value:
        raise ValueError("empty model output")
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{[\s\S]*\}", value)
    if not match:
        raise ValueError(f"no json object found: {value[:200]}")
    return json.loads(match.group(0))


def clamp_int(value: Any, minimum: int, maximum: int) -> int:
    try:
        num = int(round(float(value)))
    except Exception:
        num = minimum
    return max(minimum, min(maximum, num))


def normalize_score_payload(payload: dict[str, Any]) -> dict[str, Any]:
    normalized = {
        "business_scene_fit": clamp_int(payload.get("business_scene_fit", 0), 0, 25),
        "platform_agent_fit": clamp_int(payload.get("platform_agent_fit", 0), 0, 25),
        "execution_fit": clamp_int(payload.get("execution_fit", 0), 0, 20),
        "technical_fit": clamp_int(payload.get("technical_fit", 0), 0, 15),
        "domain_transfer_fit": clamp_int(payload.get("domain_transfer_fit", 0), 0, 15),
        "confidence": str(payload.get("confidence", "medium")).strip() or "medium",
        "verdict": str(payload.get("verdict", "partial")).strip() or "partial",
        "reason": str(payload.get("reason", "")).strip(),
        "strengths": [str(item).strip() for item in payload.get("strengths", []) if str(item).strip()],
        "risks": [str(item).strip() for item in payload.get("risks", []) if str(item).strip()],
    }
    normalized["total_score"] = (
        normalized["business_scene_fit"]
        + normalized["platform_agent_fit"]
        + normalized["execution_fit"]
        + normalized["technical_fit"]
        + normalized["domain_transfer_fit"]
    )
    return normalized


async def score_one(
    client: AsyncOpenAI,
    semaphore: asyncio.Semaphore,
    resume_text: str,
    job: NormalizedJob,
) -> dict[str, Any]:
    prompt = build_prompt(resume_text, job)
    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            async with semaphore:
                response = await client.chat.completions.create(
                    model=MODEL,
                    temperature=0,
                    max_tokens=800,
                    messages=[
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": prompt},
                    ],
                    extra_body={"thinking": {"type": "disabled"}},
                )
            content = response.choices[0].message.content or ""
            payload = extract_json_object(content)
            score = normalize_score_payload(payload)
            return {
                "company": job.company,
                "source_row_index": job.source_row_index,
                "title": job.title,
                "business_line": job.business_line,
                "location": job.location,
                "publish_date": job.publish_date,
                "post_url": job.post_url,
                "source_schema": job.source_schema,
                "model": MODEL,
                **score,
            }
        except Exception as exc:
            last_error = exc
            await asyncio.sleep(min(2 * attempt, 6))
    raise RuntimeError(f"score failed for row {job.source_row_index} {job.title}: {last_error}")


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        raise ValueError(f"no rows to write: {path}")
    fieldnames = list(rows[0].keys())
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def enrich_for_output(job: NormalizedJob, score_row: dict[str, Any] | None = None) -> dict[str, Any]:
    data = {
        "company": job.company,
        "source_schema": job.source_schema,
        "source_row_index": job.source_row_index,
        "title": job.title,
        "business_line": job.business_line,
        "location": job.location,
        "publish_date": job.publish_date,
        "post_url": job.post_url,
        "experience_text": job.experience_text,
        "responsibility": job.responsibility,
        "requirement_text": job.requirement_text,
        "jd_text": job.jd_text,
    }
    if score_row:
        data.update(score_row)
    return data


def describe_distribution(scores: list[int]) -> dict[str, Any]:
    sorted_scores = sorted(scores)
    if not sorted_scores:
        return {}

    def percentile(p: float) -> float:
        if len(sorted_scores) == 1:
            return float(sorted_scores[0])
        idx = (len(sorted_scores) - 1) * p
        lo = math.floor(idx)
        hi = math.ceil(idx)
        if lo == hi:
            return float(sorted_scores[lo])
        frac = idx - lo
        return sorted_scores[lo] + (sorted_scores[hi] - sorted_scores[lo]) * frac

    buckets = {
        "0_59": 0,
        "60_69": 0,
        "70_79": 0,
        "80_89": 0,
        "90_100": 0,
    }
    for score in sorted_scores:
        if score < 60:
            buckets["0_59"] += 1
        elif score < 70:
            buckets["60_69"] += 1
        elif score < 80:
            buckets["70_79"] += 1
        elif score < 90:
            buckets["80_89"] += 1
        else:
            buckets["90_100"] += 1

    return {
        "count": len(sorted_scores),
        "min": min(sorted_scores),
        "max": max(sorted_scores),
        "mean": round(statistics.mean(sorted_scores), 2),
        "stddev": round(statistics.pstdev(sorted_scores), 2) if len(sorted_scores) > 1 else 0,
        "p10": round(percentile(0.10), 2),
        "p50": round(percentile(0.50), 2),
        "p90": round(percentile(0.90), 2),
        "buckets": buckets,
    }


async def run(args: argparse.Namespace) -> int:
    input_path = Path(args.input).resolve()
    output_dir = Path(args.output_dir).resolve() if args.output_dir else input_path.parent.resolve()
    resume_path = Path(args.resume).resolve()
    reference_date = parse_date(args.reference_date) if args.reference_date else date.today()
    cutoff_date = subtract_months(reference_date, 3)

    api_key = resolve_ark_api_key()
    if not api_key:
        raise RuntimeError("未读取到 ARK_API_KEY。请先在系统环境变量中配置，再重试。")

    resume_text = resume_path.read_text(encoding="utf-8").strip()
    raw_rows = csv_read(input_path)
    company = infer_company(input_path, args.company)
    jobs = [normalize_row(input_path, company, index + 1, row) for index, row in enumerate(raw_rows)]
    eligible_jobs, filter_audit = filter_jobs(jobs, cutoff_date)

    filter_rows = [enrich_for_output(job) for job in eligible_jobs]
    filter_path = output_dir / f"{input_path.stem}_筛选后.csv"
    write_csv(filter_path, filter_rows)

    filter_audit_path = output_dir / f"{input_path.stem}_筛选审计.csv"
    write_csv(filter_audit_path, filter_audit)

    jobs_to_score = eligible_jobs
    if args.limit:
        jobs_to_score = jobs_to_score[: args.limit]

    client = AsyncOpenAI(
        api_key=api_key,
        base_url=BASE_URL,
        timeout=float(args.timeout_seconds),
    )
    semaphore = asyncio.Semaphore(CONCURRENCY)
    scored_rows = await asyncio.gather(*(score_one(client, semaphore, resume_text, job) for job in jobs_to_score))

    score_map = {(row["source_row_index"], row["post_url"]): row for row in scored_rows}
    full_scored_rows = [
        enrich_for_output(job, score_map.get((job.source_row_index, job.post_url)))
        for job in jobs_to_score
    ]
    full_scored_rows.sort(key=lambda item: (-int(item["total_score"]), item["publish_date"], item["title"]))

    scored_path = output_dir / f"{input_path.stem}_评分结果.csv"
    write_csv(scored_path, full_scored_rows)

    top_n = min(args.top_n, len(full_scored_rows))
    top_rows = full_scored_rows[:top_n]
    top_path = output_dir / f"{input_path.stem}_top{top_n}_模型初筛.csv"
    write_csv(top_path, top_rows)

    distribution = describe_distribution([int(row["total_score"]) for row in full_scored_rows])
    summary = {
        "company": company,
        "input": str(input_path),
        "resume": str(resume_path),
        "model": MODEL,
        "reference_date": reference_date.isoformat(),
        "cutoff_date": cutoff_date.isoformat(),
        "source_total": len(jobs),
        "eligible_total": len(eligible_jobs),
        "scored_total": len(jobs_to_score),
        "top_n": top_n,
        "concurrency": CONCURRENCY,
        "distribution": distribution,
        "files": {
            "filtered_csv": str(filter_path),
            "filter_audit_csv": str(filter_audit_path),
            "scored_csv": str(scored_path),
            "top_csv": str(top_path),
        },
    }
    summary_path = output_dir / f"{input_path.stem}_评分摘要.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Filter and score job CSVs against the resume with Doubao Ark.")
    parser.add_argument("--input", required=True, help="Input jobs CSV path")
    parser.add_argument(
        "--resume",
        default=str(Path(__file__).resolve().parent.parent / "resources" / "jianli.md"),
        help="Resume markdown path",
    )
    parser.add_argument("--company", help="Optional company name override")
    parser.add_argument("--output-dir", help="Optional output directory")
    parser.add_argument("--reference-date", help="Reference date in YYYY-MM-DD; default is today")
    parser.add_argument("--limit", type=int, help="Only score the first N eligible rows, useful for calibration")
    parser.add_argument("--top-n", type=int, default=TOP_N, help="How many rows to keep for model preselection")
    parser.add_argument("--timeout-seconds", type=float, default=45, help="Request timeout per scoring call")
    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
