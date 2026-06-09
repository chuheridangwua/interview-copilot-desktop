// ==UserScript==
// @name         PDD Jobs Exporter
// @namespace    https://careers.pddglobalhr.com/
// @version      0.2.0
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
  var DEFAULT_CONCURRENCY = 3;
  var DETAIL_TIMEOUT_MS = 25000;
  var PANEL_ID = "pdd-jobs-exporter-panel";

  var state = {
    running: false,
    cancelled: false,
    items: [],
  };

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
    return getWebpackRequire(15000).then(function (webpackRequire) {
      var apiModule = webpackRequire(78948);
      if (!apiModule || typeof apiModule.Go !== "function") {
        throw new Error("未找到拼多多列表 API 模块（78948.Go）");
      }
      return apiModule;
    });
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
    return new Promise(function (resolve, reject) {
      var code = normalizeText(job && job.code);
      var iframe = document.createElement("iframe");
      var pollTimer = null;
      var timeoutTimer = null;
      var finished = false;

      iframe.style.cssText =
        "position:fixed;left:-99999px;top:-99999px;width:1280px;height:900px;border:0;opacity:0;pointer-events:none;";
      iframe.src = buildDetailUrl(code);

      function cleanup() {
        if (pollTimer) clearInterval(pollTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        iframe.remove();
      }

      function fail(error) {
        if (finished) return;
        finished = true;
        cleanup();
        reject(error);
      }

      function succeed(payload) {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(payload);
      }

      function tryRead() {
        var doc;
        var notFound;
        var title;
        var sections;
        var responsibility;
        var requirement;
        var bonus;
        var businessLine;
        var location;
        var updateTime;
        var jdTextParts;

        try {
          doc = iframe.contentDocument;
          if (!doc) return false;

          notFound = doc.querySelector(".recruit-not-found-content");
          if (notFound) {
            fail(new Error("详情页不存在或已过期: " + code));
            return true;
          }

          title = normalizeText(
            (doc.querySelector(".detail-header-title") && doc.querySelector(".detail-header-title").textContent) ||
              (job && job.name) ||
              "",
          );
          sections = extractDetailSections(doc);
          responsibility = sections["岗位职责"] || "";
          requirement = sections["任职要求"] || "";
          bonus = sections["加分项"] || "";

          if (!title) return false;
          if (!responsibility && !requirement && !bonus) return false;

          businessLine = normalizeText(job && job.job);
          location = normalizeText(job && job.workLocation);
          updateTime = normalizeDate(job && job.updateTime);
          jdTextParts = [];
          if (responsibility) jdTextParts.push("岗位职责：\n" + responsibility);
          if (requirement) jdTextParts.push("任职要求：\n" + requirement);
          if (bonus) jdTextParts.push("加分项：\n" + bonus);

          succeed({
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
            raw_update_time: normalizeText(job && job.updateTime),
            post_url: buildDetailUrl(code),
            responsibility: responsibility,
            requirement_text: requirement,
            bonus: bonus,
            experience_text: requirement,
            jd_text: jdTextParts.join("\n\n"),
            list_job_name: normalizeText(job && job.name),
            list_job_category: businessLine,
          });
          return true;
        } catch (error) {
          return false;
        }
      }

      iframe.addEventListener("load", tryRead);
      pollTimer = setInterval(tryRead, 500);
      timeoutTimer = setTimeout(function () {
        fail(new Error("详情页超时: " + code));
      }, DETAIL_TIMEOUT_MS);
      document.body.appendChild(iframe);
    });
  }

  function runWithConcurrency(items, worker, concurrency) {
    var results = [];
    var errors = [];
    var index = 0;
    var workers = [];
    var i;

    function runner(workerId) {
      if (index >= items.length || state.cancelled) {
        return Promise.resolve();
      }

      var currentIndex = index;
      var item = items[currentIndex];
      index += 1;

      updateStatus("抓详情中：" + (currentIndex + 1) + "/" + items.length);
      appendLog("Worker " + workerId + " 处理 " + normalizeText(item && item.code) + " " + normalizeText(item && item.name));

      return worker(item, currentIndex)
        .then(function (result) {
          results[currentIndex] = result;
        })
        .catch(function (error) {
          var message = error instanceof Error ? error.message : String(error);
          appendLog("详情失败：" + normalizeText(item && item.code) + " " + message);
          errors.push({
            code: normalizeText(item && item.code),
            title: normalizeText(item && item.name),
            error: message,
          });
        })
        .then(function () {
          return sleep(120).then(function () {
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
      };
    });
  }

  function getPanelValues() {
    var root = document.getElementById(PANEL_ID);
    var keywordNode;
    var pageSizeNode;
    var concurrencyNode;
    var keyword;
    var pageSize;
    var concurrency;

    if (!root) {
      throw new Error("未找到脚本面板");
    }

    keywordNode = root.querySelector("input[name='keyword']");
    pageSizeNode = root.querySelector("input[name='pageSize']");
    concurrencyNode = root.querySelector("input[name='concurrency']");

    keyword = normalizeText(keywordNode ? keywordNode.value : "") || DEFAULT_KEYWORD;
    pageSize = Number(pageSizeNode ? pageSizeNode.value : DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE;
    concurrency = Number(concurrencyNode ? concurrencyNode.value : DEFAULT_CONCURRENCY) || DEFAULT_CONCURRENCY;

    return {
      keyword: keyword,
      pageSize: Math.min(Math.max(pageSize, 10), 100),
      concurrency: Math.min(Math.max(concurrency, 1), 6),
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
    updateStatus("准备开始");
    appendLog("开始导出，关键词=" + config.keyword + "，并发=" + config.concurrency);

    fetchAllListItems(config.keyword, config.pageSize)
      .then(function (listItems) {
        if (!listItems.length) {
          throw new Error("关键词 " + config.keyword + " 未抓到任何岗位");
        }
        return runWithConcurrency(listItems, fetchOneDetail, config.concurrency);
      })
      .then(function (output) {
        var results = output.results;
        var errors = output.errors;
        var columns;
        var csv;
        var fileBase;

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
        fileBase =
          "pinduoduo_jobs_" +
          config.keyword.replace(/[\\/:*?"<>|]/g, "_") +
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
        updateStatus("完成：成功 " + results.length + " 条，失败 " + errors.length + " 条");
        appendLog("导出完成，成功 " + results.length + " 条，失败 " + errors.length + " 条");
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
      '<div class="pdd-exp-buttons">' +
      '<button type="button" class="start-btn">开始导出</button>' +
      '<button type="button" class="stop-btn">停止</button>' +
      "</div>" +
      '<div class="pdd-exp-status">待命</div>' +
      '<textarea class="pdd-exp-log" readonly placeholder="运行日志会显示在这里"></textarea>' +
      '<div class="pdd-exp-tip">如页面弹出验证，请先完成验证，脚本会继续。</div>';

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
