const pageUrls = [
  "https://talent.ele.me/off-campus/position-list",
  "https://talent.ele.me/campus/position-list",
];

const keywords = ["", "产品", "产品经理", "AI", "运营", "研发", "算法"];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

function parseCookie(setCookie) {
  return setCookie.split(";")[0].trim();
}

for (const pageUrl of pageUrls) {
  const pageResponse = await fetch(pageUrl, {
    headers: {
      "user-agent": USER_AGENT,
      "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });
  const setCookies = typeof pageResponse.headers.getSetCookie === "function" ? pageResponse.headers.getSetCookie() : [];
  const cookieHeader = setCookies.map(parseCookie).join("; ");
  const xsrfToken = setCookies
    .map(parseCookie)
    .find((item) => item.startsWith("XSRF-TOKEN="))
    ?.split("=")[1];

  const results = [];
  for (const keyword of keywords) {
    const response = await fetch(`https://talent.ele.me/position/search?_csrf=${xsrfToken}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "content-type": "application/json",
        cookie: cookieHeader,
        origin: "https://talent.ele.me",
        referer: pageUrl,
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({ pageIndex: 1, pageSize: 10, keyword }),
    });
    const parsed = await response.json();
    results.push({
      keyword,
      totalCount: parsed?.content?.totalCount ?? null,
      firstNames: (parsed?.content?.datas ?? []).slice(0, 5).map((item) => item.name || ""),
    });
  }

  console.log(
    JSON.stringify(
      {
        pageUrl,
        results,
      },
      null,
      2,
    ),
  );
}
