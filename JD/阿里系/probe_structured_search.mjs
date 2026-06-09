const targets = [
  {
    name: "阿里巴巴",
    origin: "https://talent-holding.alibaba.com",
    pageUrl: "https://talent-holding.alibaba.com/off-campus/position-list?lang=zh&search=%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86",
    channel: "group_official_site",
  },
  {
    name: "淘宝闪购",
    origin: "https://talent.ele.me",
    pageUrl: "https://talent.ele.me/off-campus/position-list?urlData=%7B%22urlSearch%22%3A%22%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86%22%7D",
    channel: "group_official_site",
  },
  {
    name: "阿里国际",
    origin: "https://aidc-jobs.alibaba.com",
    pageUrl: "https://aidc-jobs.alibaba.com/off-campus/position-list?lang=zh&search=%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86",
    channel: "group_official_site",
  },
  {
    name: "阿里云",
    origin: "https://careers.aliyun.com",
    pageUrl: "https://careers.aliyun.com/off-campus/position-list?lang=zh&search=%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86",
    channel: "group_official_site",
  },
  {
    name: "高德",
    origin: "https://talent.amap.com",
    pageUrl: "https://talent.amap.com/off-campus/position-list?lang=zh&search=%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86",
    channel: "group_official_site",
  },
  {
    name: "盒马",
    origin: "https://hire.freshippo.com",
    pageUrl: "https://hire.freshippo.com/off-campus/position-list?lang=zh&search=%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86",
    channel: "group_official_site",
  },
  {
    name: "钉钉",
    origin: "https://talent.dingtalk.com",
    pageUrl: "https://talent.dingtalk.com/off-campus/position-list?lang=zh&search=%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86",
    channel: "group_official_site",
  },
  {
    name: "淘天",
    origin: "https://talent.taotian.com",
    pageUrl: "https://talent.taotian.com/off-campus/position-list?lang=zh&search=%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86",
    channel: "group_official_site",
  },
  {
    name: "千问",
    origin: "https://talent.quark.cn",
    pageUrl: "https://talent.quark.cn/off-campus/position-list?urlData=%7B%22urlSearch%22%3A%22%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86%22%7D",
    channel: "group_official_site",
  },
  {
    name: "通义",
    origin: "https://careers-tongyi.alibaba.com",
    pageUrl: "https://careers-tongyi.alibaba.com/off-campus/position-list?lang=zh&search=%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86",
    channel: "group_official_site",
  },
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

function parseSetCookieEntry(entry) {
  return String(entry || "").split(";")[0].trim();
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
    const cookieHeader = setCookies.map(parseSetCookieEntry).join("; ");
    const xsrfToken = setCookies
      .map(parseSetCookieEntry)
      .find((item) => item.startsWith("XSRF-TOKEN="))
      ?.split("=")[1];

    const response = await fetch(`${target.origin}/position/search?_csrf=${xsrfToken}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "content-type": "application/json",
        cookie: cookieHeader,
        origin: target.origin,
        referer: target.pageUrl,
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({
        channel: target.channel,
        language: "zh",
        batchId: "",
        categories: "",
        deptCodes: [],
        key: "产品经理",
        pageIndex: 1,
        pageSize: 10,
        regions: "",
        shareCode: "",
        subCategories: "",
      }),
    });

    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {}
    const items = parsed?.content?.datas ?? parsed?.content?.data ?? [];

    console.log(
      JSON.stringify(
        {
          name: target.name,
          status: response.status,
          totalCount: parsed?.content?.totalCount ?? parsed?.content?.count ?? null,
          firstNames: items.slice(0, 10).map((item) => item.name || item.title || item.positionName || ""),
          responseSnippet: text.slice(0, 800),
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
