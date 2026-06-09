// ==UserScript==
// @name         PDD Jobs Exporter
// @namespace    https://careers.pddglobalhr.com/
// @version      0.4.0
// @description  Export Pinduoduo jobs to a CSV compatible with local scoring scripts.
// @match        https://careers.pddglobalhr.com/jobs*
// @match        https://careers.pddglobalhr.net/jobs*
// @match        https://careers.pinduoduo.com/jobs*
// @run-at       document-idle
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  "use strict";

  var pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  var COMPANY_NAME = "拼多多";
  var DEFAULT_KEYWORD = "产品经理";
  var DEFAULT_PAGE_SIZE = 50;
  var DEFAULT_CONCURRENCY = 1;
  var DEFAULT_GAP_MS = 1800;
  var DEFAULT_RETRY_COUNT = 2;
  var DEFAULT_START_INDEX = 1;
  var DEFAULT_MAX_ITEMS = 12;
  var RETRYABLE_ERROR_ABORT_THRESHOLD = 3;
  var DETAIL_TIMEOUT_MS = 25000;
  var PANEL_ID = "pdd-jobs-exporter-panel";

  var state = {
    running: false,
    cancelled: false,
    items: [],
  };
  var listApiModulePromise = null;
  var apiCoreModulePromise = null;

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function pad2(value) {
    return String(value).length >= 2 ? String(value) : "0" + String(value);
  }

  function timestampForFile() {
    var now = new Date();
    return (
      String(now.getFullYear()) +
      pad2(now.getMonth() + 1) +
      pad2(now.getDate()) +
      "_" +
      pad2(now.getHours()) +
      pad2(now.getMinutes()) +
      pad2(now.getSeconds())
    );
  }

  function assign(target) {
    var i;
    var source;
    var key;
    for (i = 1; i < arguments.length; i += 1) {
      source = arguments[i] || {};
      for (key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
          target[key] = source[key];
        }
      }
    }
    return target;
  }

  function safeJsonStringify(value) {
    try {
      return JSON.stringify(value);
    } catch (error) {
      return String(value);
    }
  }

  function normalizeText(value) {
    return String(value == null ? "" : value)
      .replace(/\u00a0/g, " ")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim();
  }

  function normalizeDate(text) {
    var raw = normalizeText(text);
    var match;

    if (!raw) return "";

    match = raw.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (match) return match[1] + "-" + pad2(match[2]) + "-" + pad2(match[3]);

    match = raw.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    if (match) return match[1] + "-" + pad2(match[2]) + "-" + pad2(match[3]);

    match = raw.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (match) return match[1] + "-" + pad2(match[2]) + "-" + pad2(match[3]);

    return raw;
  }

  function htmlToText(html) {
    var div;
    if (!html) return "";
    div = document.createElement("div");
    div.innerHTML = String(html);
    return normalizeText(div.innerText || div.textContent || "");
  }

  function waitWithJitter(baseMs) {
    var jitter = Math.floor(Math.random() * 600);
    return sleep(baseMs + jitter);
  }

  function describeError(error) {
    if (error instanceof Error) {
      return error.message;
    }
    if (error && typeof error === "object") {
      if (error.errorMsg) return String(error.errorMsg);
      if (error.message) return String(error.message);
      return safeJsonStringify(error);
    }
    return String(error);
  }

  function getErrorCode(error) {
    if (error && typeof error === "object" && error.errorCode != null) {
      return String(error.errorCode);
    }
    return "";
  }

  function isRetryableDetailError(error) {
    var code = getErrorCode(error);
    var message = describeError(error);
    return (
      code === "54001" ||
      /Failed to fetch/i.test(message) ||
      /ERR_FAILED/i.test(message) ||
      /verify/i.test(message) ||
      /token/i.test(message)
    );
  }

  function escapeCsv(value) {
    var text = String(value == null ? "" : value);
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function rowsToCsv(rows, columns) {
    var lines = [columns.join(",")];
    var i;
    var row;
    var values;
    var j;

    for (i = 0; i < rows.length; i += 1) {
      row = rows[i];
      values = [];
      for (j = 0; j < columns.length; j += 1) {
        values.push(escapeCsv(row[columns[j]]));
      }
      lines.push(values.join(","));
    }

    return "\ufeff" + lines.join("\r\n") + "\r\n";
  }

  function triggerDownload(filename, content, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1500);
  }

  function buildDetailUrl(code) {
    return location.origin + "/jobs/detail?code=" + encodeURIComponent(code);
  }

  function updateStatus(message) {
    var statusNode = document.querySelector("#" + PANEL_ID + " .pdd-exp-status");
    if (statusNode) {
      statusNode.textContent = message;
    }
  }

  function appendLog(message) {
    var logNode = document.querySelector("#" + PANEL_ID + " .pdd-exp-log");
    var stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    var line = "[" + stamp + "] " + message;
    if (logNode) {
      logNode.value = logNode.value + (logNode.value ? "\n" : "") + line;
      logNode.scrollTop = logNode.scrollHeight;
    }
    console.log("[PDD Exporter]", message);
  }

  function getWebpackRequire(timeoutMs) {
    var deadline = Date.now() + timeoutMs;

    return new Promise(function (resolve, reject) {
      function poll() {
        var chunk = pageWindow.webpackChunk_N_E;
        var webpackRequire;
        var chunkName;

        if (chunk && typeof chunk.push === "function") {
          chunkName = "tm-" + Date.now() + "-" + Math.random().toString(16).slice(2);
          chunk.push([
            [chunkName],
            {},
            function (requireFn) {
              webpackRequire = requireFn;
            },
          ]);

          if (webpackRequire) {
            resolve(webpackRequire);
            return;
          }
        }

        if (Date.now() >= deadline) {
          reject(new Error("未能获取页面 webpack require，请确认页面已完整加载"));
          return;
        }

        setTimeout(poll, 250);
      }

      poll();
    });
  }

  function getListApiModule() {
    if (!listApiModulePromise) {
      listApiModulePromise = getWebpackRequire(15000).then(function (webpackRequire) {
        var apiModule = webpackRequire(78948);
        if (!apiModule || typeof apiModule.Go !== "function") {
          throw new Error("未找到拼多多列表 API 模块（78948.Go）");
        }
        return apiModule;
      });
    }
    return listApiModulePromise;
  }

  function getApiCoreModule() {
    if (!apiCoreModulePromise) {
      apiCoreModulePromise = getWebpackRequire(15000).then(function (webpackRequire) {
        var apiCore = webpackRequire(33401);
        if (!apiCore || typeof apiCore.AT !== "function") {
          throw new Error("未找到拼多多核心请求模块（33401.AT）");
        }
        return apiCore;
      });
    }
    return apiCoreModulePromise;
  }

  function requestListPage(apiModule, payload) {
    return apiModule.Go(
      assign({}, payload, {
        captchaCallback: function () {
          return requestListPage(apiModule, payload);
        },
      }),
    );
  }

  function fetchAllListItems(keyword, pageSize) {
    return getListApiModule().then(function (apiModule) {
      var basePayload = {
        job: "",
        pageSize: pageSize,
        name: keyword,
        workLocationList: [],
      };

      appendLog("开始抓列表，关键词=" + keyword + "，pageSize=" + pageSize);

      return requestListPage(apiModule, assign({}, basePayload, { page: 1 })).then(function (firstPage) {
        var total = Number(firstPage && firstPage.total ? firstPage.total : 0);
        var firstItems = firstPage && firstPage.list && firstPage.list.length ? firstPage.list : [];
        var totalPages = Math.max(1, Math.ceil(total / pageSize));
        var allItems = firstItems.slice();
        var currentPage = 2;

        appendLog("列表返回 total=" + total + "，总页数=" + totalPages);

        function fetchNextPage() {
          if (state.cancelled || currentPage > totalPages) {
            return Promise.resolve();
          }

          updateStatus("抓列表中：第 " + currentPage + "/" + totalPages + " 页");
          return requestListPage(apiModule, assign({}, basePayload, { page: currentPage })).then(function (pageResult) {
            var pageItems = pageResult && pageResult.list && pageResult.list.length ? pageResult.list : [];
            appendLog("第 " + currentPage + " 页抓到 " + pageItems.length + " 条");
            Array.prototype.push.apply(allItems, pageItems);
            currentPage += 1;
            return sleep(180).then(fetchNextPage);
          });
        }

        return fetchNextPage().then(function () {
          var deduped = {};
          var result = [];
          var i;
          var item;
          var code;

          for (i = 0; i < allItems.length; i += 1) {
            item = allItems[i];
            code = normalizeText(item && item.code);
            if (!code) continue;
            if (!deduped[code]) {
              deduped[code] = true;
              result.push(item);
            }
          }

          appendLog("列表去重后共 " + result.length + " 条");
          return result;
        });
      });
    });
  }

  function extractDetailSections(doc) {
    var sections = {};
    var blocks = doc.querySelectorAll(".detail-content-desc");
    var i;
    var block;
    var title;
    var content;

    for (i = 0; i < blocks.length; i += 1) {
      block = blocks[i];
      title = normalizeText(
        block.querySelector(".detail-content-desc-title")
          ? block.querySelector(".detail-content-desc-title").textContent
          : "",
      );
      content = normalizeText(
        block.querySelector(".detail-content-desc-content")
          ? block.querySelector(".detail-content-desc-content").innerText
          : "",
      );
      if (title) {
        sections[title] = content;
      }
    }

    return sections;
  }

  function fetchOneDetail(job) {
    var code = normalizeText(job && job.code);
    var referral = normalizeText(new URLSearchParams(location.search).get("r"));

    return getApiCoreModule().then(function (apiCore) {
      function requestDetail() {
        var body = { code: code };
        if (referral) {
          body.r = referral;
        }
        return apiCore.AT({
          url: "api/recruit/position/detail",
          body: body,
          isVerification: true,
          captchaCallback: requestDetail,
        });
      }

      function requestDetailWithRetry(attempt, retryCount, gapMs) {
        return Promise.race([
          requestDetail(),
          new Promise(function (_, reject) {
            setTimeout(function () {
              reject(new Error("详情接口超时: " + code));
            }, DETAIL_TIMEOUT_MS);
          }),
        ]).catch(function (error) {
          if (attempt < retryCount && isRetryableDetailError(error)) {
            appendLog(
              "详情重试：" +
                code +
                " attempt=" +
                (attempt + 1) +
                "/" +
                retryCount +
                " error=" +
                describeError(error),
            );
            return waitWithJitter(gapMs * (attempt + 1)).then(function () {
              return requestDetailWithRetry(attempt + 1, retryCount, gapMs);
            });
          }
          throw error;
        });
      }

      return requestDetailWithRetry(0, state.retries || DEFAULT_RETRY_COUNT, state.gapMs || DEFAULT_GAP_MS).then(function (detail) {
        var title = normalizeText((detail && detail.name) || (job && job.name) || "");
        var responsibility = htmlToText(detail && detail.jobDuty);
        var requirement = htmlToText(detail && detail.serveRequirement);
        var bonus = htmlToText(detail && detail.bonus);
        var businessLine = normalizeText((job && job.job) || (detail && detail.recruitType) || "");
        var location = normalizeText((detail && detail.workLocation) || (job && job.workLocation) || "");
        var updateTime = normalizeDate((detail && detail.updateTime) || (job && job.updateTime) || "");
        var jdTextParts = [];

        if (!title) {
          throw new Error("详情接口未返回岗位标题: " + code);
        }
        if (!responsibility && !requirement && !bonus) {
          throw new Error("详情接口未返回有效 JD: " + code);
        }

        if (responsibility) jdTextParts.push("岗位职责：\n" + responsibility);
        if (requirement) jdTextParts.push("任职要求：\n" + requirement);
        if (bonus) jdTextParts.push("加分项：\n" + bonus);

        return {
          company: COMPANY_NAME,
          source_schema: "pdd_tampermonkey",
          code: code,
          title: title,
          business_line: businessLine,
          department: "",
          project: "",
          category_name: businessLine,
          batch_name: "",
          location: location,
          publish_date: updateTime,
          raw_update_time: normalizeText((detail && detail.updateTime) || (job && job.updateTime) || ""),
          post_url: buildDetailUrl(code),
          responsibility: responsibility,
          requirement_text: requirement,
          bonus: bonus,
          experience_text: requirement,
          jd_text: jdTextParts.join("\n\n"),
          list_job_name: normalizeText(job && job.name),
          list_job_category: businessLine,
        };
      });
    });
  }

  function runWithConcurrency(items, worker, concurrency) {
    var results = [];
    var errors = [];
    var index = 0;
    var workers = [];
    var i;
    var retryableErrorCount = 0;
    var abortedReason = "";

    function runner(workerId) {
      if (index >= items.length || state.cancelled || abortedReason) {
        return Promise.resolve();
      }

      var currentIndex = index;
      var item = items[currentIndex];
      index += 1;

      updateStatus("抓详情中：" + (currentIndex + 1) + "/" + items.length);
      appendLog("Worker " + workerId + " 处理 " + normalizeText(item && item.code) + " " + normalizeText(item && item.name));

      return worker(item, currentIndex)
        .then(function (result) {
          retryableErrorCount = 0;
          results[currentIndex] = result;
        })
        .catch(function (error) {
          var message = describeError(error);
          var retryable = isRetryableDetailError(error);
          appendLog("详情失败：" + normalizeText(item && item.code) + " " + message);
          errors.push({
            code: normalizeText(item && item.code),
            title: normalizeText(item && item.name),
            error: message,
            errorCode: getErrorCode(error),
            retryable: retryable,
            raw: safeJsonStringify(error),
          });
          if (retryable) {
            retryableErrorCount += 1;
            if (retryableErrorCount >= RETRYABLE_ERROR_ABORT_THRESHOLD && !abortedReason) {
              abortedReason =
                "连续触发 verify/token 类错误，当前页面令牌大概率已失效。请刷新页面后，从下一段起始序号继续。";
              appendLog("提前停止：" + abortedReason);
            }
          } else {
            retryableErrorCount = 0;
          }
        })
        .then(function () {
          if (abortedReason || state.cancelled) {
            return Promise.resolve();
          }
          return waitWithJitter(state.gapMs || DEFAULT_GAP_MS).then(function () {
            return runner(workerId);
          });
        });
    }

    for (i = 0; i < Math.max(1, concurrency); i += 1) {
      workers.push(runner(i + 1));
    }

    return Promise.all(workers).then(function () {
      var compactResults = [];
      var j;
      for (j = 0; j < results.length; j += 1) {
        if (results[j]) compactResults.push(results[j]);
      }
      return {
        results: compactResults,
        errors: errors,
        abortedReason: abortedReason,
      };
    });
  }

  function getPanelValues() {
    var root = document.getElementById(PANEL_ID);
    var keywordNode;
    var pageSizeNode;
    var concurrencyNode;
    var gapMsNode;
    var retriesNode;
    var startIndexNode;
    var maxItemsNode;
    var keyword;
    var pageSize;
    var concurrency;
    var gapMs;
    var retries;
    var startIndex;
    var maxItems;

    if (!root) {
      throw new Error("未找到脚本面板");
    }

    keywordNode = root.querySelector("input[name='keyword']");
    pageSizeNode = root.querySelector("input[name='pageSize']");
    concurrencyNode = root.querySelector("input[name='concurrency']");
    gapMsNode = root.querySelector("input[name='gapMs']");
    retriesNode = root.querySelector("input[name='retries']");
    startIndexNode = root.querySelector("input[name='startIndex']");
    maxItemsNode = root.querySelector("input[name='maxItems']");

    keyword = normalizeText(keywordNode ? keywordNode.value : "") || DEFAULT_KEYWORD;
    pageSize = Number(pageSizeNode ? pageSizeNode.value : DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE;
    concurrency = Number(concurrencyNode ? concurrencyNode.value : DEFAULT_CONCURRENCY) || DEFAULT_CONCURRENCY;
    gapMs = Number(gapMsNode ? gapMsNode.value : DEFAULT_GAP_MS) || DEFAULT_GAP_MS;
    retries = Number(retriesNode ? retriesNode.value : DEFAULT_RETRY_COUNT);
    startIndex = Number(startIndexNode ? startIndexNode.value : DEFAULT_START_INDEX) || DEFAULT_START_INDEX;
    maxItems = Number(maxItemsNode ? maxItemsNode.value : DEFAULT_MAX_ITEMS) || DEFAULT_MAX_ITEMS;

    return {
      keyword: keyword,
      pageSize: Math.min(Math.max(pageSize, 10), 100),
      concurrency: Math.min(Math.max(concurrency, 1), 6),
      gapMs: Math.min(Math.max(gapMs, 300), 10000),
      retries: Math.min(Math.max(retries, 0), 5),
      startIndex: Math.max(startIndex, 1),
      maxItems: Math.min(Math.max(maxItems, 1), 30),
    };
  }

  function startExport() {
    var config;

    if (state.running) {
      appendLog("任务已在运行中");
      return;
    }

    config = getPanelValues();

    state.running = true;
    state.cancelled = false;
    state.items = [];
    state.gapMs = config.gapMs;
    state.retries = config.retries;
    updateStatus("准备开始");
    appendLog(
      "开始导出，关键词=" +
        config.keyword +
        "，并发=" +
        config.concurrency +
        "，间隔=" +
        config.gapMs +
        "ms，重试=" +
        config.retries +
        "，起始序号=" +
        config.startIndex +
        "，批量=" +
        config.maxItems,
    );

    fetchAllListItems(config.keyword, config.pageSize)
      .then(function (listItems) {
        var slicedItems = listItems.slice(config.startIndex - 1, config.startIndex - 1 + config.maxItems);
        if (!listItems.length) {
          throw new Error("关键词 " + config.keyword + " 未抓到任何岗位");
        }
        if (!slicedItems.length) {
          throw new Error("指定的起始序号超出列表范围");
        }
        appendLog(
          "本次仅处理第 " +
            config.startIndex +
            " 到 " +
            (config.startIndex + slicedItems.length - 1) +
            " 条，共 " +
            slicedItems.length +
            " 条",
        );
        return runWithConcurrency(slicedItems, fetchOneDetail, config.concurrency);
      })
      .then(function (output) {
        var results = output.results;
        var errors = output.errors;
        var abortedReason = output.abortedReason;
        var columns;
        var csv;
        var fileBase;
        var rangeEnd;
        var rangeLabel;

        if (!results.length) {
          throw new Error("列表已抓到，但详情一个都没成功，建议刷新页面后重试");
        }

        columns = [
          "company",
          "source_schema",
          "code",
          "title",
          "business_line",
          "department",
          "project",
          "category_name",
          "batch_name",
          "location",
          "publish_date",
          "raw_update_time",
          "post_url",
          "responsibility",
          "requirement_text",
          "bonus",
          "experience_text",
          "jd_text",
          "list_job_name",
          "list_job_category",
        ];

        csv = rowsToCsv(results, columns);
        rangeEnd = config.startIndex + results.length + errors.length - 1;
        rangeLabel =
          "_part_" +
          String(config.startIndex) +
          "_" +
          String(rangeEnd);
        fileBase =
          "pinduoduo_jobs_" +
          config.keyword.replace(/[\\/:*?"<>|]/g, "_") +
          rangeLabel +
          "_all_" +
          timestampForFile();

        triggerDownload(fileBase + ".csv", csv, "text/csv;charset=utf-8");

        if (errors.length) {
          triggerDownload(
            fileBase + "_errors.json",
            JSON.stringify(errors, null, 2),
            "application/json;charset=utf-8",
          );
        }

        state.items = results;
        if (abortedReason) {
          updateStatus("提前停止：成功 " + results.length + " 条，失败 " + errors.length + " 条");
          appendLog("导出提前停止，成功 " + results.length + " 条，失败 " + errors.length + " 条");
          appendLog(abortedReason);
        } else {
          updateStatus("完成：成功 " + results.length + " 条，失败 " + errors.length + " 条");
          appendLog("导出完成，成功 " + results.length + " 条，失败 " + errors.length + " 条");
        }
        appendLog("CSV 已自动下载，可直接喂给本地 score_jobs_with_doubao.py");
      })
      .catch(function (error) {
        var message = error instanceof Error ? error.message : String(error);
        updateStatus("失败：" + message);
        appendLog("任务失败：" + message);
      })
      .finally(function () {
        state.running = false;
        state.cancelled = false;
        state.gapMs = DEFAULT_GAP_MS;
        state.retries = DEFAULT_RETRY_COUNT;
      });
  }

  function cancelExport() {
    if (!state.running) {
      appendLog("当前没有运行中的任务");
      return;
    }
    state.cancelled = true;
    updateStatus("正在停止，等待当前请求结束");
    appendLog("已请求停止任务");
  }

  function createPanel() {
    var panel;
    var style;

    if (document.getElementById(PANEL_ID)) return;

    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML =
      '<div class="pdd-exp-title">PDD JD 导出</div>' +
      '<label>关键词<input name="keyword" type="text" value="' +
      DEFAULT_KEYWORD +
      '" /></label>' +
      '<label>每页<input name="pageSize" type="number" min="10" max="100" value="' +
      DEFAULT_PAGE_SIZE +
      '" /></label>' +
      '<label>并发<input name="concurrency" type="number" min="1" max="6" value="' +
      DEFAULT_CONCURRENCY +
      '" /></label>' +
      '<label>间隔毫秒<input name="gapMs" type="number" min="300" max="10000" value="' +
      DEFAULT_GAP_MS +
      '" /></label>' +
      '<label>失败重试<input name="retries" type="number" min="0" max="5" value="' +
      DEFAULT_RETRY_COUNT +
      '" /></label>' +
      '<label>起始序号<input name="startIndex" type="number" min="1" value="' +
      DEFAULT_START_INDEX +
      '" /></label>' +
      '<label>本批条数<input name="maxItems" type="number" min="1" max="30" value="' +
      DEFAULT_MAX_ITEMS +
      '" /></label>' +
      '<div class="pdd-exp-buttons">' +
      '<button type="button" class="start-btn">开始导出</button>' +
      '<button type="button" class="stop-btn">停止</button>' +
      "</div>" +
      '<div class="pdd-exp-status">待命</div>' +
      '<textarea class="pdd-exp-log" readonly placeholder="运行日志会显示在这里"></textarea>' +
      '<div class="pdd-exp-tip">建议并发 1、间隔 1800ms，每次抓 10-12 条。失败后刷新页面，把起始序号改到下一段继续。</div>';

    style = document.createElement("style");
    style.textContent =
      "#" +
      PANEL_ID +
      "{" +
      "position:fixed;right:20px;bottom:20px;z-index:999999;width:320px;padding:14px;border-radius:14px;" +
      "background:rgba(22,22,26,0.92);color:#f5f7fa;box-shadow:0 18px 48px rgba(0,0,0,0.28);" +
      'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
      "}" +
      "#" +
      PANEL_ID +
      " .pdd-exp-title{margin-bottom:10px;font-size:16px;font-weight:700;}" +
      "#" +
      PANEL_ID +
      " label{display:block;margin-bottom:8px;}" +
      "#" +
      PANEL_ID +
      " input{width:100%;margin-top:4px;padding:8px 10px;border:1px solid rgba(255,255,255,0.18);" +
      "border-radius:8px;background:rgba(255,255,255,0.08);color:#fff;box-sizing:border-box;}" +
      "#" +
      PANEL_ID +
      " .pdd-exp-buttons{display:flex;gap:8px;margin-top:10px;}" +
      "#" +
      PANEL_ID +
      " button{flex:1;padding:9px 10px;border:0;border-radius:8px;cursor:pointer;font-weight:600;}" +
      "#" +
      PANEL_ID +
      " .start-btn{background:#e02424;color:#fff;}" +
      "#" +
      PANEL_ID +
      " .stop-btn{background:rgba(255,255,255,0.14);color:#fff;}" +
      "#" +
      PANEL_ID +
      " .pdd-exp-status{margin-top:10px;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,0.08);color:#facc15;}" +
      "#" +
      PANEL_ID +
      " .pdd-exp-log{width:100%;height:150px;margin-top:10px;padding:10px;resize:vertical;border:1px solid rgba(255,255,255,0.12);" +
      "border-radius:8px;background:rgba(5,8,16,0.75);color:#d6d9df;box-sizing:border-box;}" +
      "#" +
      PANEL_ID +
      " .pdd-exp-tip{margin-top:8px;color:#c7cad1;font-size:12px;}";

    document.documentElement.appendChild(style);
    document.body.appendChild(panel);

    panel.querySelector(".start-btn").addEventListener("click", startExport);
    panel.querySelector(".stop-btn").addEventListener("click", cancelExport);
  }

  function boot() {
    if (!/^\/jobs\/?$/.test(location.pathname)) return;
    createPanel();
    appendLog("脚本已就绪");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
