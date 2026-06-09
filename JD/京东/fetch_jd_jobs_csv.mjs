import fs from "node:fs/promises";
import path from "node:path";

const OUTPUT_DIR = String.raw`E:\CLX\project\interview-copilot-desktop\JD\京东`;
const DEFAULT_KEYWORD = "产品经理";
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const LIST_URL = "https://zhaopin.jd.com/web/job/job_list";
const DETAIL_URL_BASE = "https://zhaopin.jd.com/web/job-info-detail?requementId=";
const LIST_REFERER = "https://zhaopin.jd.com/web/job_info_list/3?isHunterFlag=false";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value == null || value.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function formatDate(raw) {
  if (!raw) {
    return "";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) {
    return String(raw);
  }
  const date = new Date(Number(raw));
  if (Number.isNaN(date.getTime())) {
    return String(raw);
  }
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function slugifyKeyword(keyword) {
  return keyword.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_");
}

function buildHeaders() {
  return {
    accept: "*/*",
    "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    origin: "https://zhaopin.jd.com",
    referer: LIST_REFERER,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    "x-requested-with": "XMLHttpRequest",
  };
}

function buildBody(keyword, pageIndex, pageSize) {
  return new URLSearchParams({
    pageIndex: String(pageIndex),
    pageSize: String(pageSize),
    workCityJson: "[]",
    jobTypeJson: "[]",
    jobSearch: keyword,
    depTypeJson: "[]",
  }).toString();
}

async function fetchPage(keyword, pageIndex, pageSize) {
  const response = await fetch(LIST_URL, {
    method: "POST",
    headers: buildHeaders(),
    body: buildBody(keyword, pageIndex, pageSize),
  });

  if (!response.ok) {
    throw new Error(`Request failed for page ${pageIndex}: HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error(`Unexpected response for page ${pageIndex}: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data;
}

function buildDetailUrl(requirementId) {
  if (!requirementId) {
    return "";
  }
  return `${DETAIL_URL_BASE}${requirementId}`;
}

function joinText(...parts) {
  return parts
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function flattenJob(job, sourceRowIndex) {
  const title = String(job.positionNameOpen || job.positionName || "").trim();
  const responsibility = String(job.workContent || "").trim();
  const requirementText = String(job.qualification || "").trim();
  const publishDate = formatDate(job.formatPublishTime || job.publishTime);
  return {
    company: "京东",
    source_schema: "jd",
    source_row_index: sourceRowIndex,
    title,
    location: String(job.workCity || "").trim(),
    publish_date: publishDate,
    post_url: buildDetailUrl(job.requirementId),
    business_line: String(job.positionDeptName || "").trim(),
    experience_text: requirementText,
    responsibility,
    requirement_text: requirementText,
    jd_text: joinText(
      responsibility ? `岗位职责：\n${responsibility}` : "",
      requirementText ? `任职要求：\n${requirementText}` : "",
    ),
    requirement_id: String(job.requirementId ?? ""),
    position_id: String(job.positionId ?? ""),
    jd_internal_id: String(job.id ?? ""),
    req_number: String(job.reqNumber ?? ""),
    position_name: String(job.positionName || "").trim(),
    position_name_open: String(job.positionNameOpen || "").trim(),
    department_name: String(job.positionDeptName || "").trim(),
    work_city_code: String(job.workCityCode || "").trim(),
    job_type: String(job.jobType || "").trim(),
    job_type_code: String(job.jobTypeCode || "").trim(),
    is_hot: String(job.isHot ?? ""),
    publish_time: String(job.publishTime ?? ""),
    raw_source: LIST_URL,
  };
}

async function collectJobs(keyword, pageSize) {
  const seenPageSignatures = new Set();
  const dedupedJobs = new Map();
  const pageStats = [];

  for (let pageIndex = 1; pageIndex <= MAX_PAGES; pageIndex += 1) {
    const rows = await fetchPage(keyword, pageIndex, pageSize);
    const signature = rows.map((row) => row.id).join(",");
    pageStats.push({
      pageIndex,
      rowCount: rows.length,
      firstId: rows[0]?.id ?? null,
      lastId: rows[rows.length - 1]?.id ?? null,
    });

    if (!rows.length) {
      break;
    }
    if (seenPageSignatures.has(signature)) {
      break;
    }
    seenPageSignatures.add(signature);

    for (const row of rows) {
      dedupedJobs.set(String(row.id), row);
    }

    if (rows.length < pageSize) {
      break;
    }
  }

  return {
    jobs: [...dedupedJobs.values()],
    pageStats,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const keyword = String(args.keyword || DEFAULT_KEYWORD).trim() || DEFAULT_KEYWORD;
  const pageSize = Number(args["page-size"] || PAGE_SIZE);

  const { jobs, pageStats } = await collectJobs(keyword, pageSize);
  const rows = jobs.map((job, index) => flattenJob(job, index + 1));
  const keywordSlug = slugifyKeyword(keyword);

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const rawJsonPath = path.join(OUTPUT_DIR, `jd_jobs_${keywordSlug}.raw.json`);
  const csvPath = path.join(OUTPUT_DIR, `jd_jobs_${keywordSlug}.csv`);

  const columns = [
    "company",
    "source_schema",
    "source_row_index",
    "title",
    "location",
    "publish_date",
    "post_url",
    "business_line",
    "experience_text",
    "responsibility",
    "requirement_text",
    "jd_text",
    "requirement_id",
    "position_id",
    "jd_internal_id",
    "req_number",
    "position_name",
    "position_name_open",
    "department_name",
    "work_city_code",
    "job_type",
    "job_type_code",
    "is_hot",
    "publish_time",
    "raw_source",
  ];

  const csvLines = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")),
  ];

  await fs.writeFile(
    rawJsonPath,
    JSON.stringify(
      {
        keyword,
        pageSize,
        fetchedAt: new Date().toISOString(),
        pageStats,
        exportedCount: rows.length,
        items: jobs,
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(csvPath, `${csvLines.join("\r\n")}\r\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        keyword,
        pageSize,
        exportedCount: rows.length,
        pageStats,
        rawJsonPath,
        csvPath,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
