import fs from "node:fs/promises";
import path from "node:path";

const captureDir = String.raw`E:\CLX\project\interview-copilot-desktop\JD\阿里系`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const keywords = ["AI产品经理", "产品经理", "产品"];

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseLabelValue(text, label) {
  const match = text.match(new RegExp(`(?:^|\\r?\\n)${escapeRegex(label)}\\r?\\n([^\\r\\n]+)`));
  return match ? match[1].trim() : "";
}

function parseSetCookieEntry(entry) {
  return String(entry || "").split(";")[0].trim();
}

function buildBootstrapPageUrls(origin, referer) {
  const urls = [];
  if (referer) urls.push(referer);
  urls.push(`${origin}/off-campus/position-list`);
  urls.push(`${origin}/campus/position-list`);
  urls.push(origin);
  return [...new Set(urls)];
}

async function bootstrap(origin, referer, userAgent, acceptLanguage) {
  for (const pageUrl of buildBootstrapPageUrls(origin, referer)) {
    try {
      const response = await fetch(pageUrl, {
        headers: {
          "user-agent": userAgent || USER_AGENT,
          "accept-language": acceptLanguage || "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        },
      });
      if (!response.ok) continue;
      const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
      const cookieEntries = setCookies.map(parseSetCookieEntry).filter(Boolean);
      const xsrf = cookieEntries.find((item) => item.startsWith("XSRF-TOKEN="))?.split("=")[1];
      if (!xsrf) continue;
      return {
        pageUrl,
        cookie: cookieEntries.join("; "),
        xsrf,
      };
    } catch {}
  }
  return null;
}

const files = (await fs.readdir(captureDir))
  .filter((name) => name.endsWith(".txt"))
  .sort((a, b) => a.localeCompare(b, "zh-CN"));

for (const fileName of files) {
  const text = await fs.readFile(path.join(captureDir, fileName), "utf8");
  const searchUrl = parseLabelValue(text, "请求网址");
  const origin = parseLabelValue(text, "origin") || new URL(searchUrl).origin;
  const referer = parseLabelValue(text, "referer");
  const userAgent = parseLabelValue(text, "user-agent") || USER_AGENT;
  const acceptLanguage = parseLabelValue(text, "accept-language") || "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7";
  const boot = await bootstrap(origin, referer, userAgent, acceptLanguage);
  if (!boot) {
    console.log(JSON.stringify({ company: path.basename(fileName, ".txt"), error: "bootstrap_failed" }, null, 2));
    continue;
  }

  const results = [];
  for (const keyword of keywords) {
    try {
      const response = await fetch(`${origin}/position/search?_csrf=${boot.xsrf}`, {
        method: "POST",
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": acceptLanguage,
          "content-type": "application/json",
          cookie: boot.cookie,
          origin,
          referer: boot.pageUrl,
          "user-agent": userAgent,
        },
        body: JSON.stringify({ pageIndex: 1, pageSize: 10, keyword }),
      });
      const textBody = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(textBody);
      } catch {}
      const items = parsed?.content?.datas ?? parsed?.content?.data ?? [];
      results.push({
        keyword,
        status: response.status,
        totalCount: parsed?.content?.totalCount ?? parsed?.content?.count ?? null,
        firstNames: items.slice(0, 5).map((item) => item.name || item.title || item.positionName || ""),
      });
    } catch (error) {
      results.push({ keyword, error: String(error) });
    }
  }

  console.log(
    JSON.stringify(
      {
        company: path.basename(fileName, ".txt"),
        origin,
        bootstrapPage: boot.pageUrl,
        results,
      },
      null,
      2,
    ),
  );
}
