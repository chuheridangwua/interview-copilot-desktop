import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_CAPTURE_DIR = String.raw`E:\CLX\project\interview-copilot-desktop\JD\阿里系`;
const DEFAULT_OUTPUT_DIR = DEFAULT_CAPTURE_DIR;
const DEFAULT_PAGE_SIZE = 100;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const COMBINED_COLUMNS = [
  "company",
  "source_domain",
  "job_id",
  "title",
  "business_line",
  "department",
  "project",
  "category_name",
  "category_type",
  "batch_name",
  "location",
  "publish_date",
  "publish_date_source",
  "raw_publish_time",
  "raw_modify_time",
  "post_url",
  "responsibility",
  "requirement_text",
  "experience_text",
  "jd_text",
  "circle_names",
  "status",
  "source_file",
];

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

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function formatDate(timestampMs) {
  if (!timestampMs) return "";
  const value = Number(timestampMs);
  if (!Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function uniqueJoin(parts) {
  const values = [];
  for (const part of parts) {
    if (part == null) continue;
    if (Array.isArray(part)) {
      for (const item of part) {
        const text = String(item ?? "").trim();
        if (text && !values.includes(text)) values.push(text);
      }
      continue;
    }
    const text = String(part).trim();
    if (text && !values.includes(text)) values.push(text);
  }
  return values.join(" / ");
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseLabelValue(text, label) {
  const match = text.match(new RegExp(`(?:^|\\r?\\n)${escapeRegex(label)}\\r?\\n([^\\r\\n]+)`));
  return match ? match[1].trim() : "";
}

function extractOriginFromUrl(url) {
  return new URL(url).origin;
}

function buildHeaders(meta) {
  return {
    accept: "application/json, text/plain, */*",
    "accept-language": meta.acceptLanguage || "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "content-type": "application/json",
    ...(meta.cookie ? { cookie: meta.cookie } : {}),
    origin: meta.origin,
    referer: meta.referer,
    "user-agent": meta.userAgent || USER_AGENT,
  };
}

function buildPositionUrl(meta, item) {
  if (item.positionUrl && /^https?:\/\//i.test(item.positionUrl)) {
    return item.positionUrl;
  }
  if (item.positionUrl && item.positionUrl.startsWith("/")) {
    return new URL(item.positionUrl, meta.origin).toString();
  }
  if (item.id == null) {
    return meta.referer;
  }
  if (String(item.categoryType || "").toLowerCase() === "freshman" || String(item.batchName || "").includes("届")) {
    return `${meta.origin}/campus/position/${item.id}`;
  }
  return `${meta.origin}/off-campus/position-detail?positionId=${item.id}`;
}

function buildPublishInfo(item) {
  if (item.publishTime) {
    return {
      publishDate: formatDate(item.publishTime),
      publishDateSource: "publishTime",
      rawPublishTime: String(item.publishTime),
      rawModifyTime: item.modifyTime ? String(item.modifyTime) : "",
    };
  }
  if (item.modifyTime) {
    return {
      publishDate: formatDate(item.modifyTime),
      publishDateSource: "modifyTime",
      rawPublishTime: "",
      rawModifyTime: String(item.modifyTime),
    };
  }
  return {
    publishDate: "",
    publishDateSource: "",
    rawPublishTime: "",
    rawModifyTime: "",
  };
}

function buildJdText(description, requirement) {
  const parts = [];
  const desc = String(description || "").trim();
  const req = String(requirement || "").trim();
  if (desc) {
    parts.push(`岗位职责：\n${desc}`);
  }
  if (req) {
    parts.push(`任职要求：\n${req}`);
  }
  return parts.join("\n\n");
}

function flattenItem(meta, item) {
  const publish = buildPublishInfo(item);
  const responsibility = String(item.description || "").trim();
  const requirementText = String(item.requirement || "").trim();
  const location = uniqueJoin(item.workLocations || []);
  return {
    company: meta.company,
    source_domain: meta.origin,
    job_id: item.id == null ? "" : String(item.id),
    title: String(item.name || "").trim(),
    business_line: uniqueJoin([
      item.circleNames || [],
      item.department,
      item.project,
      item.categoryName,
      item.batchName,
    ]),
    department: String(item.department || "").trim(),
    project: String(item.project || "").trim(),
    category_name: String(item.categoryName || "").trim(),
    category_type: String(item.categoryType || "").trim(),
    batch_name: String(item.batchName || "").trim(),
    location,
    publish_date: publish.publishDate,
    publish_date_source: publish.publishDateSource,
    raw_publish_time: publish.rawPublishTime,
    raw_modify_time: publish.rawModifyTime,
    post_url: buildPositionUrl(meta, item),
    responsibility,
    requirement_text: requirementText,
    experience_text: String(item.experience || "").trim() || requirementText,
    jd_text: buildJdText(responsibility, requirementText),
    circle_names: uniqueJoin(item.circleNames || []),
    status: String(item.status || "").trim(),
    source_file: meta.captureFilePath,
  };
}

function buildSiteCsvRows(items) {
  return items.map((item) => flattenItem(item.meta, item.raw));
}

function rowsToCsv(rows, columns) {
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")),
  ].join("\r\n") + "\r\n";
}

async function parseCaptureFile(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  const searchUrl = parseLabelValue(text, "请求网址");
  if (!searchUrl) {
    throw new Error(`Missing 请求网址 in ${filePath}`);
  }
  return {
    company: path.basename(filePath, path.extname(filePath)),
    captureFilePath: filePath,
    searchUrl,
    referer: parseLabelValue(text, "referer"),
    origin: parseLabelValue(text, "origin") || extractOriginFromUrl(searchUrl),
    userAgent: parseLabelValue(text, "user-agent") || USER_AGENT,
    acceptLanguage: parseLabelValue(text, "accept-language"),
    cookie: parseLabelValue(text, "cookie"),
  };
}

function parseSetCookieEntry(entry) {
  return String(entry || "").split(";")[0].trim();
}

function buildBootstrapPageUrls(meta) {
  const urls = [];
  if (meta.referer) {
    urls.push(meta.referer);
  }
  urls.push(`${meta.origin}/off-campus/position-list`);
  urls.push(`${meta.origin}/campus/position-list`);
  urls.push(meta.origin);
  return [...new Set(urls)];
}

async function bootstrapSession(meta) {
  const pageUrls = buildBootstrapPageUrls(meta);
  let lastError = null;

  for (const pageUrl of pageUrls) {
    try {
      const pageResponse = await fetch(pageUrl, {
        headers: {
          "user-agent": meta.userAgent || USER_AGENT,
          "accept-language": meta.acceptLanguage || "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        },
      });
      if (!pageResponse.ok) {
        lastError = new Error(`bootstrap page http ${pageResponse.status} ${pageUrl}`);
        continue;
      }
      const setCookies = typeof pageResponse.headers.getSetCookie === "function" ? pageResponse.headers.getSetCookie() : [];
      const cookieEntries = setCookies.map(parseSetCookieEntry).filter(Boolean);
      const xsrf = cookieEntries.find((item) => item.startsWith("XSRF-TOKEN="))?.split("=")[1];
      if (!xsrf) {
        lastError = new Error(`bootstrap page missing xsrf token ${pageUrl}`);
        continue;
      }
      meta.cookie = cookieEntries.join("; ");
      meta.referer = pageUrl;
      meta.searchUrl = `${meta.origin}/position/search?_csrf=${xsrf}`;
      meta.bootstrapPageUrl = pageUrl;
      meta.bootstrapXsrf = xsrf;
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error(`bootstrap failed for ${meta.company}`);
}

async function fetchPage(meta, pageIndex, pageSize) {
  if (!meta.cookie) {
    await bootstrapSession(meta);
  }

  const response = await fetch(meta.searchUrl, {
    method: "POST",
    headers: buildHeaders(meta),
    body: JSON.stringify({ pageIndex, pageSize }),
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON for ${meta.company} page ${pageIndex}: ${text.slice(0, 400)}`);
  }

  if (!response.ok) {
    if (response.status === 403 && !meta._bootstrappedAfter403) {
      meta._bootstrappedAfter403 = true;
      await bootstrapSession(meta);
      return fetchPage(meta, pageIndex, pageSize);
    }
    throw new Error(`HTTP ${response.status} for ${meta.company} page ${pageIndex}: ${text.slice(0, 400)}`);
  }

  const content = json?.content ?? {};
  const items = content.datas ?? content.data ?? content.list ?? [];
  const totalCount = Number(content.totalCount ?? content.count ?? items.length ?? 0);
  return {
    items,
    totalCount,
    pageIndex,
    pageSize,
  };
}

function dedupeByKey(items, keyBuilder) {
  const map = new Map();
  for (const item of items) {
    map.set(keyBuilder(item), item);
  }
  return [...map.values()];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const captureDir = args["capture-dir"] ?? DEFAULT_CAPTURE_DIR;
  const outputDir = args["output-dir"] ?? DEFAULT_OUTPUT_DIR;
  const pageSize = Number(args["page-size"] ?? DEFAULT_PAGE_SIZE);

  const captureFiles = (await fs.readdir(captureDir))
    .filter((name) => name.endsWith(".txt"))
    .sort((left, right) => left.localeCompare(right, "zh-CN"));

  const siteSummaries = [];
  const combinedRows = [];

  await fs.mkdir(outputDir, { recursive: true });

  for (const fileName of captureFiles) {
    const filePath = path.join(captureDir, fileName);
    const meta = await parseCaptureFile(filePath);
    try {
      const firstPage = await fetchPage(meta, 1, pageSize);
      const totalPages = Math.max(1, Math.ceil(firstPage.totalCount / pageSize));
      const rawItems = firstPage.items.map((item) => ({ meta, raw: item }));

      for (let pageIndex = 2; pageIndex <= totalPages; pageIndex += 1) {
        const page = await fetchPage(meta, pageIndex, pageSize);
        rawItems.push(...page.items.map((item) => ({ meta, raw: item })));
      }

      const deduped = dedupeByKey(rawItems, (item) => `${item.meta.origin}|${String(item.raw.id ?? item.raw.name ?? Math.random())}`);
      const rows = buildSiteCsvRows(deduped);
      combinedRows.push(...rows);

      const siteSlug = meta.company.replace(/[\\/:*?"<>|\s]+/g, "_");
      const siteCsvPath = path.join(outputDir, `${siteSlug}_jobs.csv`);
      const siteRawPath = path.join(outputDir, `${siteSlug}_jobs.raw.json`);

      await fs.writeFile(siteCsvPath, rowsToCsv(rows, COMBINED_COLUMNS), "utf8");
      await fs.writeFile(
        siteRawPath,
        JSON.stringify(
          {
            company: meta.company,
            origin: meta.origin,
            searchUrl: meta.searchUrl,
            totalCount: firstPage.totalCount,
            exportedCount: rows.length,
            fetchedAt: new Date().toISOString(),
            items: deduped.map((item) => item.raw),
          },
          null,
          2,
        ),
        "utf8",
      );

      siteSummaries.push({
        company: meta.company,
        origin: meta.origin,
        totalCount: firstPage.totalCount,
        exportedCount: rows.length,
        totalPages,
        csvPath: siteCsvPath,
        rawJsonPath: siteRawPath,
      });
    } catch (error) {
      siteSummaries.push({
        company: meta.company,
        origin: meta.origin,
        error: String(error),
      });
    }
  }

  const combinedDedupedRows = dedupeByKey(
    combinedRows,
    (row) => `${row.source_domain}|${row.job_id}|${row.title}|${row.location}`,
  );

  const combinedCsvPath = path.join(outputDir, "alibaba_family_jobs_all.csv");
  const summaryPath = path.join(outputDir, "alibaba_family_jobs_summary.json");

  await fs.writeFile(combinedCsvPath, rowsToCsv(combinedDedupedRows, COMBINED_COLUMNS), "utf8");
  await fs.writeFile(
    summaryPath,
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        pageSize,
        captureDir,
        outputDir,
        combinedCount: combinedDedupedRows.length,
        combinedCsvPath,
        sites: siteSummaries,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        combinedCount: combinedDedupedRows.length,
        combinedCsvPath,
        summaryPath,
        sites: siteSummaries,
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
