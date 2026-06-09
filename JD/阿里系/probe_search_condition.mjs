const targets = [
  {
    name: "quark",
    pageUrl: "https://talent.quark.cn/off-campus/position-list",
    searchBase: "https://talent.quark.cn",
  },
  {
    name: "ele",
    pageUrl: "https://talent.ele.me/off-campus/position-list",
    searchBase: "https://talent.ele.me",
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
    const conditionUrl = `${target.searchBase}/searchCondition/list?_csrf=${xsrfToken}`;
    const response = await fetch(conditionUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "content-type": "application/json",
        cookie: cookieHeader,
        origin: target.searchBase,
        referer: target.pageUrl,
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({}),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {}
    console.log(
      JSON.stringify(
        {
          name: target.name,
          status: response.status,
          topKeys: parsed ? Object.keys(parsed) : [],
          contentKeys: parsed?.content ? Object.keys(parsed.content) : [],
          responseSnippet: text.slice(0, 1800),
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
