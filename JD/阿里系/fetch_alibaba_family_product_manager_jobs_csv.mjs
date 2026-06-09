import fs from "node:fs/promises";
import path from "node:path";

const captureDir = String.raw`E:\CLX\project\interview-copilot-desktop\JD\阿里系`;
const outputDir = captureDir;
const searchKey = "产品经理";
const pageSize = 100;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const columns = [
  "company",
  "search_key",
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

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseLabelValue(text, label) {
  const match = text.match(new RegExp(`(?:^|\\r?\\n)${escapeRegex(label)}\\r?\\n([^\\r\\n]+)`));
  return match ? match[1].trim() : "";
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function rowsToCsv(rows) {
  return [columns.join(","), ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(","))].join("\r\n") + "\r\n";
}

function parseSetCookieEntry(entry) {
  return String(entry || "").split(";")[0].trim();
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

function inferSearchPage(origin, company, key) {
  const encodedKey = encodeURIComponent(key);
  if (origin === "https://talent.ele.me" || origin === "https://talent.quark.cn") {
    return `${origin}/off-campus/position-list?urlData=%7B%22urlSearch%22%3A%22${encodedKey}%22%7D`;
  }
  return `${origin}/off-campus/position-list?lang=zh&search=${encodedKey}`;
}

function buildPositionUrl(origin, item) {
  if (item.positionUrl && /^https?:\/\//i.test(item.positionUrl)) {
    return item.positionUrl;
  }
  if (item.positionUrl && item.positionUrl.startsWith("/")) {
    return new URL(item.positionUrl, origin).toString();
  }
  if (item.id == null) return origin;
  return `${origin}/off-campus/position-detail?positionId=${item.id}`;
}

function flattenRow(meta, item) {
  const publishDate = item.publishTime ? formatDate(item.publishTime) : formatDate(item.modifyTime);
  const publishDateSource = item.publishTime ? "publishTime" : item.modifyTime ? "modifyTime" : "";
  const responsibility = String(item.description || "").trim();
  const requirementText = String(item.requirement || "").trim();
  return {
    company: meta.company,
    search_key: meta.searchKey,
    source_domain: meta.origin,
    job_id: item.id == null ? "" : String(item.id),
    title: String(item.name || "").trim(),
    business_line: uniqueJoin([
      item.circleNames || [],
      item.department,
      item.project,
      item.categoryName,
      item.batchName,
      item.categories || [],
    ]),
    department: String(item.department || "").trim(),
    project: String(item.project || "").trim(),
    category_name: String(item.categoryName || "").trim(),
    category_type: String(item.categoryType || "").trim(),
    batch_name: String(item.batchName || "").trim(),
    location: uniqueJoin(item.workLocations || []),
    publish_date: publishDate,
    publish_date_source: publishDateSource,
    raw_publish_time: item.publishTime == null ? "" : String(item.publishTime),
    raw_modify_time: item.modifyTime == null ? "" : String(item.modifyTime),
    post_url: buildPositionUrl(meta.origin, item),
    responsibility,
    requirement_text: requirementText,
    experience_text: String(item.experience || "").trim() || requirementText,
    jd_text: [responsibility ? `岗位职责：\n${responsibility}` : "", requirementText ? `任职要求：\n${requirementText}` : ""]
      .filter(Boolean)
      .join("\n\n"),
    circle_names: uniqueJoin(item.circleNames || []),
    status: String(item.status || "").trim(),
    source_file: meta.captureFilePath,
  };
}

function dedupe(rows) {
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.source_domain}|${row.job_id}|${row.title}|${row.location}`, row);
  }
  return [...map.values()];
}

const files = (await fs.readdir(captureDir))
  .filter((name) => name.endsWith(".txt"))
  .sort((a, b) => a.localeCompare(b, "zh-CN"));

const combinedRows = [];
const siteSummaries = [];

for (const fileName of files) {
  const captureFilePath = path.join(captureDir, fileName);
  const text = await fs.readFile(captureFilePath, "utf8");
  const searchUrl = parseLabelValue(text, "请求网址");
  const origin = parseLabelValue(text, "origin") || new URL(searchUrl).origin;
  const company = path.basename(fileName, ".txt");
  const pageUrl = inferSearchPage(origin, company, searchKey);

  try {
    const pageResponse = await fetch(pageUrl, {
      headers: {
        "user-agent": USER_AGENT,
        "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });
    const setCookies = typeof pageResponse.headers.getSetCookie === "function" ? pageResponse.headers.getSetCookie() : [];
    const cookieHeader = setCookies.map(parseSetCookieEntry).join("; ");
    const xsrfToken = setCookies
      .map(parseSetCookieEntry)
      .find((item) => item.startsWith("XSRF-TOKEN="))
      ?.split("=")[1];
    if (!xsrfToken) {
      throw new Error("missing xsrf token");
    }

    const allItems = [];
    let totalCount = 0;
    const totalPagesGuess = 50;

    for (let pageIndex = 1; pageIndex <= totalPagesGuess; pageIndex += 1) {
      const response = await fetch(`${origin}/position/search?_csrf=${xsrfToken}`, {
        method: "POST",
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
          "content-type": "application/json",
          cookie: cookieHeader,
          origin,
          referer: pageUrl,
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({
          channel: "group_official_site",
          language: "zh",
          batchId: "",
          categories: "",
          deptCodes: [],
          key: searchKey,
          pageIndex,
          pageSize,
          regions: "",
          shareCode: "",
          subCategories: "",
        }),
      });
      const parsed = await response.json();
      const items = parsed?.content?.datas ?? parsed?.content?.data ?? [];
      totalCount = Number(parsed?.content?.totalCount ?? parsed?.content?.count ?? 0);
      allItems.push(...items);
      if (allItems.length >= totalCount || items.length === 0 || totalCount === 0) {
        break;
      }
    }

    const meta = { company, origin, captureFilePath, searchKey };
    const rows = dedupe(allItems.map((item) => flattenRow(meta, item)));
    combinedRows.push(...rows);

    const siteCsvPath = path.join(outputDir, `${company}_jobs_产品经理.csv`);
    const rawJsonPath = path.join(outputDir, `${company}_jobs_产品经理.raw.json`);

    await fs.writeFile(siteCsvPath, rowsToCsv(rows), "utf8");
    await fs.writeFile(
      rawJsonPath,
      JSON.stringify(
        {
          company,
          origin,
          pageUrl,
          searchKey,
          totalCount,
          exportedCount: rows.length,
          fetchedAt: new Date().toISOString(),
          items: allItems,
        },
        null,
        2,
      ),
      "utf8",
    );

    siteSummaries.push({
      company,
      origin,
      searchKey,
      totalCount,
      exportedCount: rows.length,
      csvPath: siteCsvPath,
      rawJsonPath,
    });
  } catch (error) {
    siteSummaries.push({
      company,
      origin,
      searchKey,
      error: String(error),
    });
  }
}

const combinedDeduped = dedupe(combinedRows);
const combinedCsvPath = path.join(outputDir, "alibaba_family_jobs_产品经理_all.csv");
const summaryPath = path.join(outputDir, "alibaba_family_jobs_产品经理_summary.json");

await fs.writeFile(combinedCsvPath, rowsToCsv(combinedDeduped), "utf8");
await fs.writeFile(
  summaryPath,
  JSON.stringify(
    {
      fetchedAt: new Date().toISOString(),
      searchKey,
      combinedCount: combinedDeduped.length,
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
      searchKey,
      combinedCount: combinedDeduped.length,
      combinedCsvPath,
      summaryPath,
      sites: siteSummaries,
    },
    null,
    2,
  ),
);
