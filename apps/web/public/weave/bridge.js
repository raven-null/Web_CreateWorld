/**
 * Weave ↔ 世界观平台 的同步桥（由 canvas 页面以 iframe 方式加载 Weave 时注入）。
 *
 * 为什么不改 Weave 本体：Weave 的工程规范要求「始终保持为单 HTML 文件、13 个模块按固定
 * 顺序拼接」，直接改它的内联脚本会破坏它的结构守护。因此这里做**外层桥**，只在 HTML 末尾
 * 追加一行 <script src="./bridge.js"></script>，其余文件原样保持。
 *
 * 桥的三件事：
 *   1. 数据接管：`flow_data` 这个 localStorage 键改为走内存 + postMessage，画布内容由父页面
 *      （React 页面）从数据库加载后注入，不再依赖浏览器本地存储；
 *   2. 变更上报：Weave 每次 saveCanvas 都把整份存档发给父页面，由父页面做差异合并写回数据库；
 *   3. 节点详情浮层：点击节点后展示条目标题与摘要，并提供「打开条目」入口。
 *
 * 消息协议（父页面 → 桥）：
 *   { type: "weave:data", payload }      注入画布数据（首次加载与外部改动后刷新都用它）
 *   { type: "weave:focus", nodeId }      选中并居中某个节点
 * 消息协议（桥 → 父页面）：
 *   { type: "weave:ready" }              画布已就绪，可以注入数据
 *   { type: "weave:change", payload }    画布内容变化（整份存档）
 *   { type: "weave:open-entry", nodeId } 用户请求打开某条目的条目页
 *   { type: "weave:status", message }    状态提示（同步中 / 同步完成 / 出错）
 */
(function () {
  "use strict";

  var App = window.App;
  if (!App) {
    return;
  }

  /** 画布数据的内存副本（代替 localStorage 的 flow_data） */
  var memoryData = null;

  /** 父页面地址（同源，仅作校验用；非同源时不接收消息） */
  var parentOrigin = window.location.origin;

  /** 防止「父页面写回 → 桥上报 → 父页面又写回」的循环 */
  var suppressReport = false;

  /** 详情浮层里当前展示的节点 id */
  var currentDetailId = null;

  /**
   * 读取画布数据：优先内存副本，其次 localStorage（兼容直接用浏览器打开的场景）。
   * @param {string} key localStorage 键
   * @returns {string|null} 原始 JSON 字符串或 null
   */
  var originalGet = App._lsGet.bind(App);
  App._lsGet = function (key) {
    if (key === "flow_data") {
      return memoryData === null ? originalGet(key) : memoryData;
    }
    return originalGet(key);
  };

  /**
   * 写入画布数据：转交内存并上报父页面，避免画布内容只留在浏览器本地。
   * @param {string} key localStorage 键
   * @param {string} value 原始 JSON 字符串
   * @returns {boolean} 是否写入成功
   */
  var originalSet = App._lsSet.bind(App);
  App._lsSet = function (key, value) {
    if (key === "flow_data") {
      memoryData = value;
      reportChange(value);
      return true;
    }
    // 其余键（语言、对齐、键位等）继续走 localStorage
    return originalSet(key, value);
  };

  /**
   * 把整份画布存档上报给父页面。
   * @param {string|null} raw 序列化后的 JSON 字符串
   */
  function reportChange(raw) {
    if (suppressReport || !raw) {
      return;
    }
    var payload = null;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      return;
    }
    send({ type: "weave:change", payload: payload });
  }

  /**
   * 向父页面发消息。
   * @param {object} message 消息体
   */
  function send(message) {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(message, parentOrigin);
    }
  }

  /**
   * 显示状态提示（父页面也会收到，便于它自己决定怎么呈现）。
   * @param {string} message 提示文案
   */
  function notify(message) {
    send({ type: "weave:status", message: message });
    var el = document.getElementById("bridgeStatus");
    if (el) {
      el.textContent = message;
      el.style.display = message ? "block" : "none";
    }
  }

  /**
   * 调试日志：同步桥出问题时需要能在浏览器控制台直接看到进度。
   * @param {...unknown} args 日志内容
   */
  function log() {
    var args = Array.prototype.slice.call(arguments);
    console.log.apply(console, ["[weave-bridge]"].concat(args));
  }

  /** 遮罩保护：超过该时间仍未成功载入数据，就把遮罩换成可读的错误提示 */
  var LOADING_TIMEOUT_MS = 6000;
  var loadingTimer = null;

  /** 载入失败时替换遮罩内容，避免出现永远转不完的「正在加载」 */
  function showLoadFailure(reason) {
    var el = document.getElementById("bridgeLoading");
    if (!el) {
      return;
    }
    el.innerHTML =
      '<div style="text-align:center;line-height:1.9;max-width:480px">' +
      "<div style=\"color:#e07a6a;margin-bottom:6px\">画布数据未能载入</div>" +
      "<div style=\"font-size:12px;color:#a89c88\">" +
      String(reason || "未知原因") +
      "<br>请按 F12 查看控制台的 [weave-bridge] 日志，或刷新页面重试。" +
      "</div></div>";
  }

  /**
   * 用父页面给的数据替换当前画布。
   * Weave 的导入路径是 App._loadFromData(存档)：它会先完整校验、再整体替换画布状态，
   * 这正是外部注入要走的入口（比直接改 canvasState 安全，能同步撤销历史与视口）。
   * @param {object} payload Weave 存档结构 { nodes, connections, regions, viewport }
   */
  function applyData(payload) {
    if (!payload || typeof payload !== "object") {
      showLoadFailure("父页面下发的数据为空");
      return;
    }
    var nodeCount = Array.isArray(payload.nodes) ? payload.nodes.length : 0;
    var linkCount = Array.isArray(payload.connections) ? payload.connections.length : 0;
    log("收到画布数据：", nodeCount, "节点 /", linkCount, "连线");
    memoryData = JSON.stringify(payload);
    suppressReport = true;
    try {
      var ok = typeof App._loadFromData === "function" ? App._loadFromData(payload) : false;
      if (!ok) {
        log("App._loadFromData 返回 false：存档未通过 Weave 的校验");
        showLoadFailure("存档未通过 Weave 校验（节点或分区字段不合法）");
      } else {
        log("数据已载入画布");
        if (loadingTimer !== null) {
          clearTimeout(loadingTimer);
          loadingTimer = null;
        }
        hideLoading();
        if (typeof App.centerCanvasOnNodes === "function") {
          App.centerCanvasOnNodes();
        }
      }
    } catch (error) {
      log("载入数据异常：", error);
      showLoadFailure(error && error.message ? error.message : String(error));
    }
    // 装载完成后把这份数据视作「已同步基线」，避免刚打开就回写一遍
    setTimeout(function () {
      suppressReport = false;
    }, 300);
  }

  /** 显示节点详情浮层（标题 + 摘要 + 打开条目） */
  function showDetail(node) {
    currentDetailId = node ? node.id : null;
    var panel = document.getElementById("bridgeDetail");
    if (!panel) {
      return;
    }
    if (!node) {
      panel.style.display = "none";
      return;
    }
    var title = document.getElementById("bridgeDetailTitle");
    var desc = document.getElementById("bridgeDetailDesc");
    if (title) {
      title.textContent = node.label || "(未命名)";
    }
    if (desc) {
      desc.textContent = node.desc || "（这条还没有正文摘要）";
    }
    panel.style.display = "block";
  }

  // ---------- 与父页面通信 ----------
  window.addEventListener("message", function (event) {
    if (event.origin !== parentOrigin) {
      return;
    }
    var data = event.data || {};
    if (data.type === "weave:data") {
      applyData(data.payload);
      notify("");
      return;
    }
    if (data.type === "weave:hide-loading") {
      hideLoading();
      return;
    }
    if (data.type === "weave:focus") {
      var focusNode = App._getNodeById ? App._getNodeById(data.nodeId) : null;
      if (focusNode) {
        // 选中该节点并按当前缩放把它居中（Weave 没有「居中单个节点」的公开方法，这里直接算平移）
        if (App.selectedNodeIds && typeof App.selectedNodeIds.add === "function") {
          App.selectedNodeIds.clear();
          App.selectedNodeIds.add(focusNode.id);
        }
        var stage = document.getElementById("canvasStage");
        if (stage && App.scale) {
          App.panX = stage.clientWidth / 2 - focusNode.x * App.scale;
          App.panY = stage.clientHeight / 2 - focusNode.y * App.scale;
        }
        if (typeof App._renderNodes === "function") {
          App._renderNodes();
        }
        if (typeof App._rebuildZOrder === "function") {
          App._rebuildZOrder();
        }
        if (typeof App.applyViewTransform === "function") {
          App.applyViewTransform();
        }
        showDetail(focusNode);
      }
    }
  });

  // ---------- 节点点击 → 事件上报 + 详情浮层 ----------
  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
      var card = target && target.closest ? target.closest(".node") : null;
      if (!card) {
        // 点空白处收起浮层
        if (target && target.closest && !target.closest("#bridgeDetail")) {
          showDetail(null);
        }
        return;
      }
      // Weave 把节点 id 写在 dataset.nodeId 上
      var nodeId = card.dataset ? card.dataset.nodeId : null;
      var node = nodeId && App._getNodeById ? App._getNodeById(nodeId) : null;
      if (!node) {
        return;
      }
      showDetail(node);
      // 双击进入条目页（与平台其它页面的习惯一致）
      if (event.detail >= 2) {
        send({ type: "weave:open-entry", nodeId: nodeId });
      }
    },
    true,
  );

  // ---------- 注入浮层 UI ----------
  /**
   * 主题注入：把 Weave 默认的浅色配色换成平台「档案馆」深色系（变量取值与 apps/web/src/styles.css 一致）。
   * Weave 用 CSS 变量控制颜色，这里整体重定义变量即可，不修改它的样式表；
   * 画布底色（.canvas 是硬编码的 #f8f9fb）再用一条规则覆盖。
   */
  function injectTheme() {
    var style = document.createElement("style");
    style.id = "bridgeTheme";
    style.textContent = [
      ":root{",
      "--bg-page:#14120f;",
      "--bg-card:#221e19;",
      "--bg-hover:#2b261f;",
      "--bg-input:#1c1915;",
      "--border:#3a332a;",
      "--border-light:#4a4234;",
      "--text-primary:#e8e0d3;",
      "--text-secondary:#a89c88;",
      "--text-muted:#776c5c;",
      "--accent:#c9a15c;",
      "--accent-hover:#d8b26a;",
      "--accent-light:rgba(201,161,92,.18);",
      "--accent-bg:rgba(201,161,92,.10);",
      "--shadow-sm:0 1px 2px rgba(0,0,0,.35);",
      "--shadow-md:0 2px 8px rgba(0,0,0,.4);",
      "--shadow-lg:0 4px 16px rgba(0,0,0,.5);",
      "--node-bg:#221e19;",
      "--node-border:#3a332a;",
      "--node-header-text:#e8e0d3;",
      "--grid-line:rgba(201,161,92,.06);",
      "--grid-line-strong:rgba(201,161,92,.12);",
      "}",
      // 画布与顶栏背景贴合主题
      ".canvas{background-color:#14120f !important;}",
      ".node{background:var(--bg-card);border-color:var(--border);box-shadow:0 6px 20px rgba(0,0,0,.35);}",
      ".node:hover{box-shadow:0 8px 26px rgba(0,0,0,.45);}",
      ".socket{background:var(--bg-card);}",
    ].join("");
    document.head.appendChild(style);
  }

  /** 插入桥接用的样式与浮层，保证不依赖平台样式表 */
  function mountUi() {
    injectTheme();
    var style = document.createElement("style");
    style.textContent = [
      "#bridgeDetail{position:fixed;right:16px;bottom:16px;z-index:9999;max-width:320px;display:none;",
      "background:#221e19;border:1px solid #3a332a;border-radius:10px;padding:12px 14px;color:#e8e0d3;",
      "font:13px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.45)}",
      "#bridgeDetailTitle{font-size:15px;font-weight:600;margin-bottom:6px;color:#c9a15c}",
      "#bridgeDetailDesc{color:#a89c88;max-height:150px;overflow:auto;white-space:pre-wrap}",
      "#bridgeDetailBtns{margin-top:10px;display:flex;gap:8px}",
      "#bridgeDetailBtns button{cursor:pointer;border:1px solid #4a4234;background:#1c1915;color:#e8e0d3;",
      "border-radius:6px;padding:4px 10px;font-size:12px}",
      "#bridgeDetailBtns button:hover{border-color:#c9a15c;color:#c9a15c}",
      "#bridgeStatus{position:fixed;left:16px;bottom:16px;z-index:9999;display:none;background:#221e19;",
      "border:1px solid #3a332a;border-radius:8px;padding:6px 12px;color:#c9a15c;",
      "font:12px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}",
      "#bridgeLoading{position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;",
      "background:#14120f;color:#a89c88;font:14px system-ui,-apple-system,'Segoe UI',sans-serif}",
      "#bridgeLoading b{color:#c9a15c;font-weight:600}",
    ].join("");
    document.head.appendChild(style);

    var loading = document.createElement("div");
    loading.id = "bridgeLoading";
    loading.innerHTML = "<div><b>正在从世界加载条目…</b></div>";
    document.body.appendChild(loading);

    var panel = document.createElement("div");
    panel.id = "bridgeDetail";
    panel.innerHTML =
      '<div id="bridgeDetailTitle"></div>' +
      '<div id="bridgeDetailDesc"></div>' +
      '<div id="bridgeDetailBtns">' +
      '<button type="button" id="bridgeOpenEntry">打开条目</button>' +
      '<button type="button" id="bridgeCloseDetail">收起</button>' +
      "</div>";
    document.body.appendChild(panel);

    var status = document.createElement("div");
    status.id = "bridgeStatus";
    document.body.appendChild(status);

    var openButton = document.getElementById("bridgeOpenEntry");
    if (openButton) {
      openButton.addEventListener("click", function () {
        if (currentDetailId) {
          send({ type: "weave:open-entry", nodeId: currentDetailId });
        }
      });
    }
    var closeButton = document.getElementById("bridgeCloseDetail");
    if (closeButton) {
      closeButton.addEventListener("click", function () {
        showDetail(null);
      });
    }
  }

  /** 启动：挂 UI、通知父页面可以下发数据，并加上载入超时保护 */
  function boot() {
    mountUi();
    log("桥已启动，等待父页面下发数据");
    loadingTimer = setTimeout(function () {
      log("等待数据超时");
      showLoadFailure("等待世界数据超时（父页面未下发或接口未返回）");
    }, LOADING_TIMEOUT_MS);
    send({ type: "weave:ready" });
  }

  /** 隐藏加载遮罩（数据注入成功后调用） */
  function hideLoading() {
    if (loadingTimer !== null) {
      clearTimeout(loadingTimer);
      loadingTimer = null;
    }
    var el = document.getElementById("bridgeLoading");
    if (el) {
      el.remove();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
