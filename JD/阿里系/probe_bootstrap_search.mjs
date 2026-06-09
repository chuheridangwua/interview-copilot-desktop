const targets = [
  {
    name: "quark-off-campus",
    pageUrl: "https://talent.quark.cn/off-campus/position-list",
    searchBase: "https://talent.quark.cn/position/search",
  },
  {
    name: "quark-campus",
    pageUrl: "https://talent.quark.cn/campus/position-list",
    searchBase: "https://talent.quark.cn/position/search",
  },
  {
    name: "ele-off-campus",
    pageUrl: "https://talent.ele.me/off-campus/position-list",
    searchBase: "https://talent.ele.me/position/search",
  },
  {
    name: "ele-campus",
    pageUrl: "https://talent.ele.me/campus/position-list",
    searchBase: "https://talent.ele.me/position/search",
  },
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

function parseCookie(setCookie) {
  return setCookie.split(";")[0].trim();
}

for (const target of targets) {
  try {
    const pageResponse = await fetch(target.pageUrl, {
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
    const searchUrl = `${target.searchBase}?_csrf=${xsrfToken}`;
    const searchResponse = await fetch(searchUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "content-type": "application/json",
        cookie: cookieHeader,
        origin: new URL(target.pageUrl).origin,
        referer: target.pageUrl,
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({ pageIndex: 1, pageSize: 5 }),
    });
    const searchText = await searchResponse.text();
    let parsed = null;
    try {
      parsed = JSON.parse(searchText);
    } catch {}
    const datas = parsed?.content?.datas ?? parsed?.content?.data ?? [];
    console.log(
      JSON.stringify(
        {
          name: target.name,
          pageStatus: pageResponse.status,
          searchStatus: searchResponse.status,
          xsrfToken,
          cookieHeader,
          totalCount: parsed?.content?.totalCount ?? null,
          firstNames: datas.slice(0, 5).map((item) => item.name || item.title || item.positionName || ""),
          responseSnippet: searchText.slice(0, 500),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          name: target.name,
          error: String(error),
        },
        null,
        2,
      ),
    );
  }
}
