from __future__ import annotations

import argparse
import csv
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Any

import requests


API_URL = "https://talent.baidu.com/httservice/getPostListNew"
SOURCE_DOMAIN = "https://talent.baidu.com"
DEFAULT_POST_TYPE = "产品"
PAGE_SIZE = 10
MAX_WORKERS = 8
TIMEOUT_SECONDS = 20
HEADERS = {
    "Referer": "https://talent.baidu.com/jobs/social-list?search=",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0"
    ),
}


def join_text(*parts: str) -> str:
    return "\n\n".join(part.strip() for part in parts if str(part or "").strip())


def request_page(session: requests.Session, page: int, keyword: str = "") -> dict[str, Any]:
    payload = {
        "recruitType": "SOCIAL",
        "pageSize": str(PAGE_SIZE),
        "keyWord": keyword,
        "curPage": str(page),
        "projectType": "",
    }
    response = session.post(API_URL, headers=HEADERS, data=payload, timeout=TIMEOUT_SECONDS)
    response.raise_for_status()
    data = response.json()
    if data.get("status") != "ok":
        raise RuntimeError(f"unexpected response for page {page}: {data}")
    return data


def build_post_url(post_id: str) -> str:
    return f"{SOURCE_DOMAIN}/jobs/detail/SOCIAL/{post_id}"


def normalize_row(item: dict[str, Any]) -> dict[str, Any]:
    title = str(item.get("name", "")).strip()
    department = str(item.get("bgShortName", "")).strip()
    org_name = str(item.get("orgName", "")).strip()
    business_line = " / ".join(part for part in [department, org_name] if part)
    responsibility = str(item.get("workContent", "")).strip()
    requirement_text = str(item.get("serviceCondition", "")).strip()
    experience_text = str(item.get("workYears", "")).strip() or requirement_text
    publish_date = str(item.get("publishDate", "")).strip()
    update_date = str(item.get("updateDate", "")).strip()
    post_id = str(item.get("postId", "")).strip()

    return {
        "company": "百度",
        "source_schema": "baidu",
        "source_domain": SOURCE_DOMAIN,
        "job_id": str(item.get("jobId", "")).strip(),
        "post_id": post_id,
        "title": title,
        "business_line": business_line,
        "department": department,
        "project": org_name,
        "category_name": str(item.get("postType", "")).strip(),
        "category_type": "SOCIAL",
        "batch_name": str(item.get("projectType", "")).strip(),
        "location": str(item.get("workPlace", "")).strip(),
        "publish_date": publish_date,
        "publish_date_source": "publishDate",
        "raw_publish_time": publish_date,
        "raw_modify_time": update_date,
        "post_url": build_post_url(post_id) if post_id else "",
        "responsibility": responsibility,
        "requirement_text": requirement_text,
        "experience_text": experience_text,
        "jd_text": join_text(f"岗位职责：\n{responsibility}", f"任职要求：\n{requirement_text}"),
        "circle_names": "",
        "status": "",
        "source_file": API_URL,
        "education": str(item.get("education", "")).strip(),
        "recruit_num": str(item.get("recruitNum", "")).strip(),
        "favorite_flag": str(item.get("favoriteFlag", "")).strip(),
        "hot_flag": str(item.get("hotFlag", "")).strip(),
        "raw_post_type": str(item.get("postType", "")).strip(),
    }


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        raise ValueError(f"no rows to write: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch Baidu social jobs and export CSV/JSON.")
    parser.add_argument(
        "--output-dir",
        default=str(Path(__file__).resolve().parent),
        help="Directory to write output files into.",
    )
    parser.add_argument(
        "--post-type",
        default=DEFAULT_POST_TYPE,
        help="Keep only rows whose postType matches this value. Default: 产品",
    )
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    first_page = request_page(session, 1)
    total = int(str(first_page["data"]["total"]))
    total_pages = (total + PAGE_SIZE - 1) // PAGE_SIZE

    page_map: dict[int, list[dict[str, Any]]] = {1: first_page["data"]["list"]}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {
            executor.submit(request_page, session, page): page
            for page in range(2, total_pages + 1)
        }
        for future in as_completed(futures):
            page = futures[future]
            page_map[page] = future.result()["data"]["list"]

    all_rows: list[dict[str, Any]] = []
    for page in range(1, total_pages + 1):
        all_rows.extend(page_map[page])

    deduped_by_post_id: dict[str, dict[str, Any]] = {}
    for item in all_rows:
        post_id = str(item.get("postId", "")).strip()
        if not post_id:
            continue
        deduped_by_post_id[post_id] = item

    deduped_rows = list(deduped_by_post_id.values())
    filtered_rows = [
        item for item in deduped_rows if str(item.get("postType", "")).strip() == args.post_type
    ]
    filtered_rows.sort(
        key=lambda item: (
            str(item.get("publishDate", "")).strip(),
            str(item.get("updateDate", "")).strip(),
            str(item.get("name", "")).strip(),
        ),
        reverse=True,
    )

    normalized_rows = [normalize_row(item) for item in filtered_rows]

    raw_json_path = output_dir / "baidu_jobs_产品岗.raw.json"
    csv_path = output_dir / "baidu_jobs_产品岗.csv"
    summary_path = output_dir / "baidu_jobs_summary.json"

    raw_json_path.write_text(
        json.dumps(
            {
                "fetched_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "api_url": API_URL,
                "page_size": PAGE_SIZE,
                "total_social_jobs": total,
                "total_pages": total_pages,
                "deduped_total": len(deduped_rows),
                "post_type_filter": args.post_type,
                "filtered_total": len(filtered_rows),
                "items": filtered_rows,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    write_csv(csv_path, normalized_rows)
    summary_path.write_text(
        json.dumps(
            {
                "fetched_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "api_url": API_URL,
                "page_size": PAGE_SIZE,
                "total_social_jobs": total,
                "total_pages": total_pages,
                "deduped_total": len(deduped_rows),
                "post_type_filter": args.post_type,
                "filtered_total": len(filtered_rows),
                "files": {
                    "raw_json": str(raw_json_path),
                    "csv": str(csv_path),
                },
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    print(
        json.dumps(
            {
                "total_social_jobs": total,
                "total_pages": total_pages,
                "deduped_total": len(deduped_rows),
                "post_type_filter": args.post_type,
                "filtered_total": len(filtered_rows),
                "csv": str(csv_path),
                "summary": str(summary_path),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
