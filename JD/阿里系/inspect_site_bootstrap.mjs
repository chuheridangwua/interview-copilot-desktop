const targets = [
  "https://talent.quark.cn/off-campus/position-list",
  "https://talent.quark.cn/campus/position-list",
  "https://talent.ele.me/off-campus/position-list",
  "https://talent.ele.me/campus/position-list",
  "https://talent.quark.cn",
  "https://talent.ele.me",
];

for (const url of targets) {
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });
    const text = await response.text();
    const title = text.match(/<title>([^<]+)<\/title>/i)?.[1] ?? "";
    const token = text.match(/__token__\s*:\s*"([^"]+)"/)?.[1] ?? "";
    const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    console.log(
      JSON.stringify(
        {
          url,
          status: response.status,
          title,
          token,
          setCookieCount: setCookies.length,
          setCookiePreview: setCookies.slice(0, 4),
          snippet: text.slice(0, 300),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          url,
          error: String(error),
        },
        null,
        2,
      ),
    );
  }
}
