import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
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

function getRequiredConfig(args) {
  const searchUrl = args["search-url"] ?? process.env.BYTEDANCE_SEARCH_URL;
  const cookie = args.cookie ?? process.env.BYTEDANCE_COOKIE;
  const csrfToken = args["csrf-token"] ?? process.env.BYTEDANCE_CSRF_TOKEN;
  const referer = args.referer ?? process.env.BYTEDANCE_REFERER;

  if (!searchUrl) {
    throw new Error("Missing search URL. Pass --search-url or BYTEDANCE_SEARCH_URL.");
  }
  if (!cookie) {
    throw new Error("Missing cookie. Pass --cookie or BYTEDANCE_COOKIE.");
  }
  if (!csrfToken) {
    throw new Error("Missing CSRF token. Pass --csrf-token or BYTEDANCE_CSRF_TOKEN.");
  }
  if (!referer) {
    throw new Error("Missing referer. Pass --referer or BYTEDANCE_REFERER.");
  }

  return { searchUrl, cookie, csrfToken, referer };
}

function normalizeKeyword(rawKeyword) {
  return (rawKeyword ?? "").trim() || "AI产品经理";
}

function slugifyKeyword(keyword) {
  return keyword.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_");
}

function parseArrayParam(value) {
  if (value == null || value === "") return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseNumberParam(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildRequestTemplate(searchUrl) {
  const url = new URL(searchUrl);
  const query = url.searchParams;

  return {
    url,
    keyword: normalizeKeyword(query.get("keyword")),
    portalType: parseNumberParam(query.get("portal_type"), 2),
    portalEntrance: parseNumberParam(query.get("portal_entrance"), 1),
    jobCategoryIdList: parseArrayParam(query.get("job_category_id_list")),
    tagIdList: parseArrayParam(query.get("tag_id_list")),
    locationCodeList: parseArrayParam(query.get("location_code_list")),
    subjectIdList: parseArrayParam(query.get("subject_id_list")),
    recruitmentIdList: parseArrayParam(query.get("recruitment_id_list")),
    jobFunctionIdList: parseArrayParam(query.get("job_function_id_list")),
    storefrontIdList: parseArrayParam(query.get("storefront_id_list")),
  };
}

function buildUrl(template, offset, limit) {
  const url = new URL(template.url.toString());
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("keyword", template.keyword);
  return url;
}

function buildBody(template, offset, limit) {
  return {
    keyword: template.keyword,
    limit,
    offset,
    job_category_id_list: template.jobCategoryIdList,
    tag_id_list: template.tagIdList,
    location_code_list: template.locationCodeList,
    subject_id_list: template.subjectIdList,
    recruitment_id_list: template.recruitmentIdList,
    portal_type: template.portalType,
    job_function_id_list: template.jobFunctionIdList,
    storefront_id_list: template.storefrontIdList,
    portal_entrance: template.portalEntrance,
  };
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function formatPublishDate(timestampMs) {
  if (!timestampMs) return "";
  const date = new Date(Number(timestampMs));
  if (Number.isNaN(date.getTime())) return "";
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function buildJobLink(jobId) {
  return `https://jobs.bytedance.com/experienced/position/${jobId}/detail`;
}

function flattenJob(job) {
  return {
    id: job.id ?? "",
    title: job.title ?? "",
    sub_title: job.sub_title ?? "",
    job_category_name: job.job_category?.name ?? "",
    job_category_parent_name: job.job_category?.parent?.name ?? "",
    city_name: job.city_info?.name ?? "",
    city_list: (job.city_list ?? []).map((city) => city.name).join(" | "),
    description: job.description ?? "",
    requirement: job.requirement ?? "",
    publish_time: job.publish_time ?? "",
    publish_date: formatPublishDate(job.publish_time),
    code: job.code ?? "",
    recruit_type: job.recruit_type?.name ?? "",
    job_link: buildJobLink(job.id),
    raw_address: job.job_post_info?.address ?? "",
  };
}

async function fetchPage({ template, offset, limit, headers }) {
  const response = await fetch(buildUrl(template, offset, limit), {
    method: "POST",
    headers,
    body: JSON.stringify(buildBody(template, offset, limit)),
  });

  if (!response.ok) {
    throw new Error(`Request failed at offset ${offset}: HTTP ${response.status}`);
  }

  const json = await response.json();
  if (json?.code !== 0 || !json?.data || !Array.isArray(json.data.job_post_list)) {
    throw new Error(`Unexpected response at offset ${offset}: ${JSON.stringify(json)}`);
  }

  return json;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { searchUrl, cookie, csrfToken, referer } = getRequiredConfig(args);
  const template = buildRequestTemplate(searchUrl);
  const limit = parseNumberParam(args.limit, 100);
  const outputDir =
    args["output-dir"] ?? String.raw`E:\CLX\project\interview-copilot-desktop\JD\字节`;

  const headers = {
    accept: "application/json, text/plain, */*",
    "accept-language": "zh-CN",
    "content-type": "application/json",
    origin: "https://jobs.bytedance.com",
    "portal-channel": "office",
    "portal-platform": "pc",
    referer,
    "website-path": "society",
    "x-csrf-token": csrfToken,
    cookie,
  };

  const firstPage = await fetchPage({ template, offset: 0, limit, headers });
  const totalCount = Number(firstPage.data.count ?? 0);
  const jobs = [...firstPage.data.job_post_list];

  for (let offset = limit; offset < totalCount; offset += limit) {
    const page = await fetchPage({ template, offset, limit, headers });
    jobs.push(...page.data.job_post_list);
  }

  const dedupedMap = new Map();
  for (const job of jobs) {
    dedupedMap.set(String(job.id), job);
  }
  const dedupedJobs = [...dedupedMap.values()];

  await fs.mkdir(outputDir, { recursive: true });

  const keywordSlug = slugifyKeyword(template.keyword);
  const rawJsonPath = path.join(outputDir, `bytedance_jobs_${keywordSlug}.raw.json`);
  const csvPath = path.join(outputDir, `bytedance_jobs_${keywordSlug}.csv`);

  const flattened = dedupedJobs.map(flattenJob);
  const columns = [
    "id",
    "title",
    "sub_title",
    "job_category_name",
    "job_category_parent_name",
    "city_name",
    "city_list",
    "publish_time",
    "publish_date",
    "code",
    "recruit_type",
    "job_link",
    "raw_address",
    "description",
    "requirement",
  ];

  const csvLines = [
    columns.join(","),
    ...flattened.map((item) => columns.map((column) => csvEscape(item[column])).join(",")),
  ];

  await fs.writeFile(
    rawJsonPath,
    JSON.stringify(
      {
        keyword: template.keyword,
        totalCount,
        exportedCount: dedupedJobs.length,
        fetchedAt: new Date().toISOString(),
        searchUrl,
        items: dedupedJobs,
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
        keyword: template.keyword,
        totalCount,
        exportedCount: dedupedJobs.length,
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
