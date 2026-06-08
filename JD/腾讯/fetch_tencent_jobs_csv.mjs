import fs from "node:fs/promises";
import path from "node:path";

const outputDir = String.raw`E:\CLX\project\interview-copilot-desktop\JD\腾讯`;
const outputFile = path.join(outputDir, "tencent_jobs_产品经理.csv");

const baseUrl = "https://careers.tencent.com/tencentcareer/api/post/Query";
const pageSize = 10;
const keyword = "产品经理";

const headers = {
  accept: "application/json, text/plain, */*",
  referer:
    "https://careers.tencent.com/search.html?keyword=%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
};

const columns = [
  "PostId",
  "RecruitPostId",
  "RecruitPostName",
  "CountryName",
  "LocationName",
  "BGName",
  "ProductName",
  "CategoryName",
  "Responsibility",
  "LastUpdateTime",
  "PostURL",
  "RequireWorkYearsName",
  "SourceID",
  "IsCollect",
  "IsValid",
];

function buildUrl(pageIndex) {
  const url = new URL(baseUrl);
  url.searchParams.set("timestamp", String(Date.now()));
  url.searchParams.set("countryId", "");
  url.searchParams.set("cityId", "");
  url.searchParams.set("bgIds", "");
  url.searchParams.set("productId", "");
  url.searchParams.set("categoryId", "");
  url.searchParams.set("parentCategoryId", "");
  url.searchParams.set("attrId", "");
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("pageIndex", String(pageIndex));
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("language", "zh-cn");
  url.searchParams.set("area", "cn");
  return url;
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

async function fetchPage(pageIndex) {
  const response = await fetch(buildUrl(pageIndex), { headers });
  if (!response.ok) {
    throw new Error(`Request failed for page ${pageIndex}: HTTP ${response.status}`);
  }
  const json = await response.json();
  if (json?.Code !== 200 || !json?.Data || !Array.isArray(json.Data.Posts)) {
    throw new Error(`Unexpected response for page ${pageIndex}: ${JSON.stringify(json)}`);
  }
  return json.Data;
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });

  const firstPage = await fetchPage(1);
  const totalCount = Number(firstPage.Count ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const posts = [...firstPage.Posts];

  for (let pageIndex = 2; pageIndex <= totalPages; pageIndex += 1) {
    const page = await fetchPage(pageIndex);
    posts.push(...page.Posts);
  }

  const lines = [
    columns.join(","),
    ...posts.map((post) => columns.map((column) => csvEscape(post[column])).join(",")),
  ];

  await fs.writeFile(outputFile, `${lines.join("\r\n")}\r\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        totalCount,
        totalPages,
        exportedCount: posts.length,
        outputFile,
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
