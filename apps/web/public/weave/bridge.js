/**
 * Weave ↔ 世界观平台 的同步桥（由画布 iframe 加载，构建时内联进 weave.html）。
 *
 * 为什么不改 Weave 本体：Weave 的工程规范要求「始终保持为单 HTML 文件、13 个模块按固定
 * 顺序拼接」，直接改它的内联脚本会破坏它的结构守护。因此这里做**外层桥**：Weave 本体零改动，
 * 桥由 `apps/web/scripts/inline-bridge.mjs` 在构建时内联进 weave.html 末尾的独立 <script>。
 * 本文件是桥的源码，改完运行一次构建（或 `node apps/web/scripts/inline-bridge.mjs`）即可生效。
 *
 * 桥负责四件事：
 *   1. 数据接管：`flow_data` 这个 localStorage 键改为走内存 + postMessage，画布内容由父页面
 *      （React 页面）从数据库加载后注入，不再依赖浏览器本地存储；
 *   2. 变更上报：Weave 每次存盘都把整份存档发给父页面，由父页面做差异合并写回数据库；
 *   3. 界面改造（全部靠移动 DOM 与注入 CSS，不改 Weave 源码）：
 *      · 顶栏重做——左侧平铺的颜色（每种颜色标注它代表的分类）、右侧操作按钮、统计贴最右；
 *      · 主题配色——把 Weave 的浅色变量换成平台深色系；
 *      · 侧边栏补一个网格背景开关；颜色与分类的对应关系用标签标出；
 *   4. 节点详情浮层：点击节点展示条目标题与摘要，双击进条目页。
 *
 * 消息协议（父页面 → 桥）：
 *   { type: "weave:data", payload }      注入画布数据（首次加载与外部改动后刷新都用它）
 *   { type: "weave:readonly", readOnly } 按当前用户权限切换只读
 *   { type: "weave:focus", nodeId }      选中并居中某个节点
 *   { type: "weave:hide-loading" }       隐藏加载遮罩
 * 消息协议（桥 → 父页面）：
 *   { type: "weave:ready" }              画布已就绪，可以注入数据（会反复广播直到收到数据）
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

  /**
   * 设置画布的只读状态（父页面按当前用户权限下发）。
   *
   * 直接复用 Weave 自己的只读开关逻辑（readOnly 标记 + 侧边栏按钮高亮 + 画布 read-only 类），
   * 而不是调用它的 toggleReadOnly（那会弹出提示并且是「切换」语义）。
   * @param {boolean} readOnly 是否只读
   */
  function applyReadOnly(readOnly) {
    if (App.readOnly === readOnly) {
      return;
    }
    App.readOnly = readOnly;
    var button = document.getElementById("sidebarReadOnlyBtn");
    if (button) {
      button.classList.toggle("active", readOnly);
    }
    var stage = document.getElementById("canvasStage");
    if (stage) {
      stage.classList.toggle("read-only", readOnly);
    }
    if (readOnly) {
      // 关掉可能正在进行的编辑动作，让只读立即生效
      if (typeof App.closeInlineEdit === "function" && App._inlineEditTarget) {
        App.closeInlineEdit();
      }
      if (typeof App._closeDescEdit === "function" && App._descEditNodeId) {
        App._closeDescEdit();
      }
      if (typeof App._clearCtx === "function") {
        App._clearCtx();
      }
    }
    if (typeof App.renderCanvas === "function") {
      App.renderCanvas({ center: false });
    }
    log(readOnly ? "已切换为只读（未登录或无编辑权限）" : "已切换为可编辑");
  }

  /** 是否已经收到父页面的画布数据（收到后就不再重发就绪信号） */
  var dataReceived = false;

  /** 就绪信号的重发定时器 */
  var readyRetryTimer = null;

  /**
   * 通知父页面「桥已就绪」。
   *
   * 为什么要重发：iframe 里的桥可能在极短时间内就绪，而父页面（React）此时可能还没挂上
   * message 监听——单次发送会永久丢失，表现为画布一直停在「加载中」、桥一直等不到数据。
   * 因此每 800ms 重发一次，直到真正收到数据为止。
   */
  function announceReady() {
    if (dataReceived) {
      if (readyRetryTimer !== null) {
        clearInterval(readyRetryTimer);
        readyRetryTimer = null;
      }
      return;
    }
    send({ type: "weave:ready" });
  }

  /** 开始反复广播就绪信号，直到数据送达 */
  function startReadyAnnounce() {
    announceReady();
    if (readyRetryTimer === null) {
      readyRetryTimer = setInterval(announceReady, 800);
    }
  }

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
      // 数据已送达：停止重发就绪信号
      dataReceived = true;
      if (readyRetryTimer !== null) {
        clearInterval(readyRetryTimer);
        readyRetryTimer = null;
      }
      applyData(data.payload);
      notify("");
      return;
    }
    if (data.type === "weave:hide-loading") {
      hideLoading();
      return;
    }
    if (data.type === "weave:readonly") {
      // 父页面按「当前用户是否有编辑权限」切换只读：未登录时画布不允许编辑，
      // 从源头避免注定 401/403 的写请求
      applyReadOnly(Boolean(data.readOnly));
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

  /**
   * 把节点的颜色写到 dataset，供 CSS 属性选择器识别（红色等自定义色没有预设 class）；
   * 只在颜色变化时写，避免每帧触发样式重算。
   */
  function syncNodeColorAttrs() {
    var map = App._nodeElMap;
    if (!map || typeof map.forEach !== "function") {
      return;
    }
    map.forEach(function (el, id) {
      var node = App._getNodeById ? App._getNodeById(id) : null;
      if (!node) {
        return;
      }
      var color = node.color || "";
      if (el.dataset.cwColor !== color) {
        el.dataset.cwColor = color;
      }
    });
  }

  /** 启动节点配色同步：每秒检查一次（节点数量与颜色变化都不频繁，开销可忽略） */
  function startNodeColorSync() {
    syncNodeColorAttrs();
    window.setInterval(syncNodeColorAttrs, 1000);
  }

  /**
   * 颜色 → 分类名。
   * 「人物=红、地点=黄」按用户指定；其余按语义补足，保证五色各有唯一分类。
   * 值的写法必须与画布数据一致：预设色用色名，红色是自选十六进制。
   */
  var COLOR_CATEGORY = {
    red: "人物",
    yellow: "地点",
    orange: "势力",
    cyan: "物品",
    green: "事件",
  };

  /** 自选色的十六进制取值（Weave 预设里没有红色，用自定义色实现） */
  var CUSTOM_COLOR_HEX = "#d9534f";

  /** 加深一档的红色（节点头部渐变用） */
  var CUSTOM_COLOR_DARK = "#c9403c";

  // ---------- 顶栏重做：左「颜色（展开）」| 右「清空 / 导入导出 / 适应 / 撤销重做」| 最右「统计」 ----------

  /** 色点容器 id（顶栏里平铺的那一排颜色） */
  var COLOR_DOTS_ID = "bridgeColorDots";

  /**
   * 顶栏重做。
   *
   * 做法：**只移动 DOM、不重建元素**——Weave 用 id 取元素绑事件（BIND_CLICKS 表），
   * 元素与 id 原地保留即可，事件绑定完全不受影响。
   *   · 隐藏：品牌区（带彩蛋，平台内不需要）、原「颜色 ▾」下拉触发器
   *   · 删除：「+ 节点」（双击空白处即可新建节点）
   *   · 右移：清空 / 导出 / 导入 / 适应 / 撤销 / 重做，统计徽章贴最右
   *   · 颜色：改为**平铺在顶栏里的一排色点**（复用 Weave 的 _buildDotPanel，
   *     选色逻辑与状态完全一致），另有「自选色」按钮
   */
  function rebuildHeader() {
    var header = document.querySelector(".header");
    if (!header) {
      log("未找到 .header，跳过顶栏重做");
      return;
    }

    var addNode = document.getElementById("btnAddNode");
    var colorDrop = document.getElementById("genColorDropdown");
    var genTrigger = document.getElementById("genColorTrigger");
    var clearBtn = document.getElementById("btnClearAllNodes");
    var exportBtn = document.getElementById("btnDoExport");
    var importBtn = document.getElementById("btnDoImport");
    var fitBtn = document.getElementById("btnCenterCanvas");
    var undoBtn = document.getElementById("undoBtn");
    var redoBtn = document.getElementById("redoBtn");
    var badge = document.getElementById("statusBadge");

    // 「+ 节点」按需求移除
    if (addNode) {
      addNode.remove();
    }
    // 原颜色下拉（触发器 + 折叠面板）不再使用，色点改为平铺
    if (colorDrop && colorDrop.parentNode) {
      colorDrop.parentNode.removeChild(colorDrop);
    }

    header.innerHTML = "";

    // 左：颜色（标题 + 当前色圆点 + 平铺色点 + 自选色）
    var colorGroup = document.createElement("div");
    colorGroup.className = "bridge-color";
    var trigger = document.createElement("span");
    trigger.className = "bridge-color-label";
    trigger.textContent = "颜色";
    var currentDot = document.createElement("span");
    currentDot.className = "bridge-current-dot";
    currentDot.id = "bridgeCurrentColor";
    trigger.appendChild(currentDot);
    colorGroup.appendChild(trigger);

    var dotRow = document.createElement("div");
    dotRow.className = "bridge-color-dots";
    dotRow.id = COLOR_DOTS_ID;
    colorGroup.appendChild(dotRow);
    header.appendChild(colorGroup);

    // 右：操作按钮组
    var group = document.createElement("div");
    group.className = "btn-group bridge-actions";
    /** 追加按钮，并可在前面补一个分隔线 */
    var append = function (el, separator) {
      if (!el) {
        return;
      }
      if (separator) {
        var sep = document.createElement("span");
        sep.className = "sep";
        group.appendChild(sep);
      }
      group.appendChild(el);
    };
    append(clearBtn, false);
    append(exportBtn, true);
    append(importBtn, false);
    append(fitBtn, true);
    append(undoBtn, true);
    append(redoBtn, false);
    header.appendChild(group);

    // 最右：统计（节点数 · 连线数）
    if (badge) {
      badge.classList.add("bridge-badge");
      header.appendChild(badge);
    }

    log("顶栏已重做");
  }

  /**
   * 调色板存储键。
   * 结构：{ version: 1, custom: ["#eb1471"], hidden: ["blue"], labels: { "#eb1471": "关键人物" } }
   *   custom —— 自己添加的颜色（预设色不在此列）
   *   hidden —— 被移除的预设色（预设色是 Weave 的常量，只能在本桥标记隐藏）
   *   labels —— 每个颜色的说明；没写时用内置的「颜色=分类」对应兜底
   * 与 Weave 自己的偏好键（flow_*）分开存，互不影响。
   */
  var PALETTE_KEY = "cw_canvas_palette";

  /** 内置色点：顺序与默认说明 = 人物 / 地点 / 势力 / 物品 / 事件 */
  var PRESET_DEFS = [
    { color: CUSTOM_COLOR_HEX, hex: CUSTOM_COLOR_HEX, label: "人物" },
    { color: "yellow", hex: "#eab308", label: "地点" },
    { color: "orange", hex: "#f97316", label: "势力" },
    { color: "cyan", hex: "#06b6d4", label: "物品" },
    { color: "green", hex: "#10b981", label: "事件" },
  ];

  /** 预设色的中文名（与 Weave 词典一致，用于给它的调色板补标签） */
  var COLOR_NAME_ZH = { blue: "蓝色", cyan: "青色", green: "绿色", yellow: "黄色", orange: "橙色" };

  /** 是否是合法的十六进制颜色 */
  function isHexColor(value) {
    return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
  }

  /**
   * 读取调色板配置（缺失或损坏时返回空结构）。
   * @returns {{version: number, custom: string[], hidden: string[], labels: object}}
   */
  function readPalette() {
    try {
      var raw = localStorage.getItem(PALETTE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== "object") {
        return { version: 1, custom: [], hidden: [], labels: {} };
      }
      return {
        version: 1,
        custom: Array.isArray(parsed.custom) ? parsed.custom.filter(isHexColor) : [],
        hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
        labels: parsed.labels && typeof parsed.labels === "object" ? parsed.labels : {},
      };
    } catch (error) {
      return { version: 1, custom: [], hidden: [], labels: {} };
    }
  }

  /**
   * 写入调色板配置。
   * @param {object} palette 配置
   */
  function writePalette(palette) {
    try {
      localStorage.setItem(PALETTE_KEY, JSON.stringify(palette));
    } catch (error) {
      // 隐私模式等场景下忽略：改动只在本次会话有效
    }
  }

  /**
   * 取某个颜色显示用的说明。
   * 优先级：用户写的说明 → 内置的「颜色=分类」对应 → Weave 的色名。
   * @param {string} color 颜色（预设色名或十六进制）
   * @returns {string} 说明文案
   */
  function labelForColor(color) {
    var custom = readPalette().labels[color];
    if (custom) {
      return custom;
    }
    for (var i = 0; i < PRESET_DEFS.length; i += 1) {
      if (PRESET_DEFS[i].color === color) {
        return PRESET_DEFS[i].label;
      }
    }
    if (color === "red" || color === CUSTOM_COLOR_HEX) {
      return "人物";
    }
    return COLOR_NAME_ZH[color] || "";
  }

  /**
   * 取颜色的实际色值（用于渲染色点与小圆点）。
   * @param {string} color 预设色名或十六进制
   * @returns {string} 十六进制色值
   */
  function hexForColor(color) {
    for (var i = 0; i < PRESET_DEFS.length; i += 1) {
      if (PRESET_DEFS[i].color === color) {
        return PRESET_DEFS[i].hex;
      }
    }
    return isHexColor(color) ? color : "#8a8378";
  }

  /**
   * 取当前要展示的颜色列表（隐藏的不出现）。
   * @returns {Array<{color: string, hex: string, label: string, custom: boolean}>}
   */
  function paletteItems() {
    var palette = readPalette();
    var items = [];
    for (var i = 0; i < PRESET_DEFS.length; i += 1) {
      var preset = PRESET_DEFS[i];
      if (palette.hidden.indexOf(preset.color) >= 0) {
        continue;
      }
      items.push({
        color: preset.color,
        hex: preset.hex,
        label: palette.labels[preset.color] || preset.label,
        custom: false,
      });
    }
    for (var j = 0; j < palette.custom.length; j += 1) {
      var color = palette.custom[j];
      if (palette.hidden.indexOf(color) >= 0) {
        continue;
      }
      items.push({ color: color, hex: color, label: palette.labels[color] || color, custom: true });
    }
    return items;
  }

  /**
   * 添加一个颜色（已在列表中则只更新说明并取消隐藏）。
   * 自选色会同时写进 Weave 的自选色列表，使「新节点默认色」的色板里也有它。
   * @param {string} color 预设色名或十六进制
   * @param {string} label 说明（可空）
   * @returns {boolean} 是否添加成功
   */
  function addPaletteColor(color, label) {
    var palette = readPalette();
    var isPreset = PRESET_DEFS.some(function (item) {
      return item.color === color;
    });
    if (!isPreset) {
      if (!isHexColor(color)) {
        return false;
      }
      if (palette.custom.indexOf(color) < 0) {
        palette.custom.push(color);
      }
      if (Array.isArray(App._customColors) && App._customColors.indexOf(color) < 0) {
        App._customColors.push(color);
        if (App._customColors.length > 4) {
          App._customColors.shift();
        }
        if (typeof App._saveCustomColors === "function") {
          App._saveCustomColors();
        }
      }
    }
    palette.hidden = palette.hidden.filter(function (item) {
      return item !== color;
    });
    if (label) {
      palette.labels[color] = String(label).trim().slice(0, 10);
    }
    writePalette(palette);
    return true;
  }

  /**
   * 移除一个颜色。
   * 预设色不能从 Weave 的常量里删，只能标记隐藏；自己添加的颜色则真正删除，
   * 并同步 Weave 的自选色列表。
   * @param {string} color 颜色
   */
  function removePaletteColor(color) {
    var palette = readPalette();
    var isPreset = PRESET_DEFS.some(function (item) {
      return item.color === color;
    });
    if (isPreset) {
      if (palette.hidden.indexOf(color) < 0) {
        palette.hidden.push(color);
      }
    } else {
      palette.custom = palette.custom.filter(function (item) {
        return item !== color;
      });
      if (Array.isArray(App._customColors)) {
        var index = App._customColors.indexOf(color);
        if (index >= 0) {
          App._customColors.splice(index, 1);
          if (typeof App._saveCustomColors === "function") {
            App._saveCustomColors();
          }
        }
      }
    }
    delete palette.labels[color];
    writePalette(palette);
  }

  /** 颜色面板状态：mode = none（收起）/ add（添加颜色）/ edit（改某个颜色的说明） */
  var palettePanel = { mode: "none", editColor: "" };

  /** 弹窗容器 id（挂在 body 上，居中显示，不再从顶栏下方展开） */
  var PALETTE_PANEL_ID = "bridgePalettePanel";

  /** 取弹窗容器（不存在则创建），失败返回 null */
  function ensurePalettePanel() {
    var panel = document.getElementById(PALETTE_PANEL_ID);
    if (panel) {
      return panel;
    }
    panel = document.createElement("div");
    panel.id = PALETTE_PANEL_ID;
    panel.className = "bridge-modal";
    panel.style.display = "none";
    document.body.appendChild(panel);
    return panel;
  }

  /** HTML 属性转义（说明是用户输入，直接拼进 value 会破坏结构） */
  function escapeAttr(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /** 重绘弹窗内容（添加 / 改说明 / 关闭） */
  function renderPalettePanel() {
    var panel = ensurePalettePanel();
    if (!panel) {
      return;
    }
    if (palettePanel.mode === "none") {
      panel.style.display = "none";
      panel.innerHTML = "";
      return;
    }

    var editing = palettePanel.mode === "edit";
    var editingHex = editing ? hexForColor(palettePanel.editColor) : "#eb1471";
    var editingLabel = editing ? labelForColor(palettePanel.editColor) : "";
    var swatches = paletteItems()
      .map(function (item) {
        var active = editing && item.color === palettePanel.editColor ? " is-active" : "";
        return (
          '<button type="button" class="bridge-swatch' +
          active +
          '" data-color="' +
          item.color +
          '" style="background:' +
          item.hex +
          '" title="' +
          escapeAttr(item.label) +
          '"></button>'
        );
      })
      .join("");

    // 完整弹窗：标题栏 + 表单 + 底部按钮 + 已有颜色
    panel.innerHTML =
      '<div class="bridge-modal-mask" data-close="1"></div>' +
      '<div class="bridge-modal-box" role="dialog" aria-modal="true" aria-label="' +
      (editing ? "修改颜色说明" : "添加颜色") +
      '">' +
      '<div class="bridge-modal-head">' +
      "<span>" +
      (editing ? "修改这个颜色" : "添加颜色") +
      "</span>" +
      '<button type="button" class="bridge-modal-close" data-close="1" aria-label="关闭">×</button>' +
      "</div>" +
      '<div class="bridge-modal-body">' +
      '<div class="bridge-field">' +
      '<span class="bridge-field-label">颜色</span>' +
      '<input type="color" class="bridge-palette-color" id="bridgePaletteColor" value="' +
      editingHex +
      '" />' +
      '<span class="bridge-field-hint">点右侧色块可直接改用已有颜色</span>' +
      "</div>" +
      '<div class="bridge-field">' +
      '<span class="bridge-field-label">说明</span>' +
      '<input type="text" class="bridge-palette-text" id="bridgePaletteLabel" maxlength="10" placeholder="它代表什么，如：关键人物" value="' +
      escapeAttr(editingLabel) +
      '" />' +
      "</div>" +
      '<div class="bridge-field">' +
      '<span class="bridge-field-label">已有</span>' +
      '<div class="bridge-palette-swatches">' +
      (swatches || '<span class="bridge-field-hint">还没有别的颜色</span>') +
      "</div>" +
      "</div>" +
      "</div>" +
      '<div class="bridge-modal-foot">' +
      (editing ? '<button type="button" class="bridge-palette-btn danger" id="bridgePaletteDelete">移除</button>' : "") +
      '<button type="button" class="bridge-palette-btn" id="bridgePaletteCancel">取消</button>' +
      '<button type="button" class="bridge-palette-btn primary" id="bridgePaletteSave">' +
      (editing ? "保存" : "添加") +
      "</button>" +
      "</div>" +
      "</div>";
    panel.style.display = "flex";

    var textInput = document.getElementById("bridgePaletteLabel");
    if (textInput) {
      textInput.focus();
      textInput.select();
    }
  }

  /** 收起面板 */
  function closePalettePanel() {
    palettePanel.mode = "none";
    palettePanel.editColor = "";
    renderPalettePanel();
  }

  /** 打开「添加颜色」面板（颜色与说明一起填） */
  function openAddColorPanel() {
    palettePanel.mode = "add";
    palettePanel.editColor = "";
    renderPalettePanel();
  }

  /** 打开「改说明」面板 */
  function openEditColorPanel(color) {
    palettePanel.mode = "edit";
    palettePanel.editColor = color;
    renderPalettePanel();
  }

  /** 保存面板（添加或改说明） */
  function savePalettePanel() {
    var colorInput = document.getElementById("bridgePaletteColor");
    var labelInput = document.getElementById("bridgePaletteLabel");
    var color = palettePanel.mode === "edit" ? palettePanel.editColor : colorInput ? colorInput.value : "";
    var label = labelInput ? labelInput.value : "";
    if (!color) {
      return;
    }
    addPaletteColor(color, label);
    closePalettePanel();
    buildColorDots();
  }

  /** 移除当前编辑的颜色 */
  function deletePaletteColor() {
    if (palettePanel.mode !== "edit" || !palettePanel.editColor) {
      return;
    }
    removePaletteColor(palettePanel.editColor);
    closePalettePanel();
    buildColorDots();
  }

  /** 面板内的事件委托（面板内容每次重渲染，绑在容器上更稳） */
  function bindPalettePanelEvents() {
    var panel = ensurePalettePanel();
    if (!panel) {
      return;
    }
    panel.onclick = function (event) {
      var target = event.target;
      if (!target || !target.closest) {
        return;
      }
      // 点遮罩或右上角 × 关闭
      if (target.closest("[data-close]")) {
        closePalettePanel();
        return;
      }
      if (target.closest("#bridgePaletteSave")) {
        savePalettePanel();
        return;
      }
      if (target.closest("#bridgePaletteDelete")) {
        deletePaletteColor();
        return;
      }
      if (target.closest("#bridgePaletteCancel")) {
        closePalettePanel();
        return;
      }
      var swatch = target.closest(".bridge-swatch");
      if (swatch) {
        openEditColorPanel(swatch.dataset.color);
      }
    };
    panel.onkeydown = function (event) {
      // 输入框里的按键不要冒泡到 Weave（否则会触发它的快捷键）
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        savePalettePanel();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closePalettePanel();
      }
    };
  }

  /**
   * 取「写在颜色块上的文字」该用什么颜色：按背景亮度选黑/白，保证看得清。
   * @param {string} hex 十六进制色值
   * @returns {string} 文字颜色
   */
  function textColorOn(hex) {
    if (!isHexColor(hex)) {
      return "#e8e0d3";
    }
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    var luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.62 ? "#1c1915" : "#ffffff";
  }

  /**
   * 重绘顶栏调色板：颜色即分类——说明文字直接写在颜色块里，可增删。
   *
   * 自己生成而不是用 Weave 的 `_buildDotPanel`：它把类名拼成「前缀 + '-dot'」
   * （传 'bridge-' 会得到 `bridge--dot`，与样式对不上），且只含 5 个固定颜色、无法增删。
   * 选色仍调用 Weave 的 `_setGenColor`，默认色与偏好存储照旧由它维护。
   */
  function buildColorDots() {
    var container = document.getElementById(COLOR_DOTS_ID);
    if (!container) {
      return;
    }
    var items = paletteItems();
    var activeColor = App._selectedGenColor;
    container.innerHTML = "";

    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      var isActive = item.color === activeColor;

      // 整个胶囊就是按钮：底色 = 颜色，说明文字写在里面
      var pill = document.createElement("button");
      pill.type = "button";
      pill.className = "bridge-pill" + (isActive ? " is-active" : "");
      pill.dataset.c = item.color;
      pill.style.background = item.hex;
      pill.style.color = textColorOn(item.hex);
      pill.title = item.label + "（" + item.color + "）　双击改说明";

      var label = document.createElement("span");
      label.className = "bridge-pill-label";
      label.textContent = item.label;
      pill.appendChild(label);

      var remove = document.createElement("span");
      remove.className = "bridge-pill-remove";
      remove.title = "移除「" + item.label + "」";
      remove.setAttribute("role", "button");
      remove.setAttribute("aria-label", "移除 " + item.label);
      remove.textContent = "×";
      pill.appendChild(remove);

      container.appendChild(pill);
    }

    // 「+ 添加」：添加颜色时可以同时写说明
    var add = document.createElement("button");
    add.type = "button";
    add.className = "bridge-add";
    add.title = "添加颜色（可同时写它代表什么）";
    add.innerHTML =
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2"' +
      ' stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line>' +
      '<line x1="5" y1="12" x2="19" y2="12"></line></svg>添加';
    container.appendChild(add);

    // 事件委托：胶囊会随增删重建，逐个绑定容易漏
    container.onclick = function (event) {
      var target = event.target;
      if (!target || !target.closest) {
        return;
      }
      // 移除按钮优先于选色
      var removeButton = target.closest(".bridge-pill-remove");
      if (removeButton) {
        event.stopPropagation();
        var pillToRemove = removeButton.closest(".bridge-pill");
        if (pillToRemove) {
          removePaletteColor(pillToRemove.dataset.c);
          buildColorDots();
        }
        return;
      }
      if (target.closest(".bridge-add")) {
        openAddColorPanel();
        return;
      }
      var pill = target.closest(".bridge-pill");
      if (pill) {
        // 单击 = 选这个颜色（新节点的默认色）
        App._setGenColor(pill.dataset.c);
        updateCurrentColor(pill.dataset.c);
        var all = container.querySelectorAll(".bridge-pill");
        for (var k = 0; k < all.length; k += 1) {
          all[k].classList.toggle("is-active", all[k].dataset.c === pill.dataset.c);
        }
      }
    };

    // 双击胶囊 = 改说明（与单击选色不冲突）
    container.ondblclick = function (event) {
      var pill = event.target && event.target.closest ? event.target.closest(".bridge-pill") : null;
      if (!pill) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      openEditColorPanel(pill.dataset.c);
    };

    updateCurrentColor(activeColor);
  }

  /** 刷新「当前颜色」小圆点的颜色 */
  function updateCurrentColor(color) {
    var dot = document.getElementById("bridgeCurrentColor");
    if (!dot) {
      return;
    }
    dot.style.background = hexForColor(color);
  }

  /**
   * 节点配色样式：自定义色（红）没有 h-<色名> class，用 data-cw-color 属性选择器补上，
   * 让它和预设色一样有正确的头部渐变、边框与 socket 描边。
   */
  function injectNodeColorStyle() {
    var style = document.createElement("style");
    style.id = "bridgeNodeColorStyle";
    var red = CUSTOM_COLOR_HEX;
    var redDark = CUSTOM_COLOR_DARK;
    style.textContent = [
      '.node[data-cw-color="' + red + '"] .node-header{background:linear-gradient(135deg,' + red + "," + redDark + ");",
      "text-shadow:0 1px 3px rgba(0,0,0,.35)}",
      '.node[data-cw-color="' + red + '"] .node-body{border-color:' + red + "}",
      '.node[data-cw-color="' + red + '"] .socket{border-color:' + red + "}",
      '.node[data-cw-color="' + red + '"] .socket-inner{background:' + red + "}",
      '.node[data-cw-color="' + red + '"] .socket{color:' + red + "}",
    ].join("");
    document.head.appendChild(style);
  }

  /**
   * 顶栏的布局样式。
   *
   * 改写 Weave 原来的「品牌在左、按钮组在右」为「颜色在左、操作按钮在右、统计贴最右」。
   * 全部用 CSS 完成，不动 Weave 的位置样式；色点行在顶栏里平铺，圆点比面板里的小一档，
   * 保证 56px 的顶栏放得下并且标签不会被裁掉。
   */
  function injectHeaderStyle() {
    var style = document.createElement("style");
    style.id = "bridgeHeaderStyle";
    style.textContent = [
      // 顶栏：左右两端对齐（统计会因 margin-left:auto 被推到最右）
      ".header{display:flex !important;align-items:center !important;justify-content:flex-start !important;",
      "gap:14px !important;padding:0 16px !important}",
      ".header .header-brand{display:none !important}",
      // 调色板：文字直接写在颜色块里（彩色胶囊），颜色即分类名
      ".bridge-color{display:flex;align-items:center;gap:10px;flex:0 1 auto;min-width:0}",
      ".bridge-color-label{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--text-secondary);",
      "white-space:nowrap;flex-shrink:0}",
      ".bridge-current-dot{width:10px;height:10px;border-radius:50%;display:inline-block;",
      "box-shadow:0 0 0 1px rgba(255,255,255,.18)}",
      ".bridge-color-dots{display:flex;align-items:center;gap:8px;overflow-x:auto;overflow-y:hidden;",
      "scrollbar-width:none;padding:2px 0}",
      ".bridge-color-dots::-webkit-scrollbar{display:none}",
      // 一个颜色 = 一个胶囊：底色是颜色，说明文字写在里面
      ".bridge-pill{display:inline-flex;align-items:center;gap:6px;flex-shrink:0;border-radius:999px;",
      "border:2px solid transparent;padding:4px 8px 5px 12px;font-family:inherit;font-size:13px;font-weight:600;",
      "line-height:1.2;letter-spacing:.2px;cursor:pointer;text-shadow:0 1px 2px rgba(0,0,0,.35);",
      "transition:box-shadow .15s,transform .15s}",
      ".bridge-pill:hover{transform:translateY(-1px)}",
      ".bridge-pill.is-active{border-color:#e8e0d3;box-shadow:0 0 0 2px rgba(201,161,92,.5)}",
      ".bridge-pill-label{white-space:nowrap;pointer-events:none}",
      ".bridge-pill-remove{width:16px;height:16px;border-radius:50%;display:inline-flex;align-items:center;",
      "justify-content:center;font-size:14px;font-weight:400;line-height:1;opacity:.6;cursor:pointer;",
      "background:rgba(0,0,0,.18);transition:opacity .15s,background .15s}",
      ".bridge-pill-remove:hover{opacity:1;background:rgba(0,0,0,.45)}",
      ".bridge-add{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 12px;border-radius:999px;",
      "border:1px dashed var(--border-light);background:transparent;color:var(--text-secondary);font-family:inherit;",
      "font-size:12px;cursor:pointer;flex-shrink:0;transition:color .15s,border-color .15s}",
      ".bridge-add:hover{color:var(--accent);border-color:var(--accent)}",
      // 添加 / 改说明的弹窗（居中模态，铺在整页之上）
      ".bridge-modal{position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center}",
      ".bridge-modal-mask{position:absolute;inset:0;background:rgba(0,0,0,.55)}",
      ".bridge-modal-box{position:relative;width:min(420px,calc(100vw - 32px));background:var(--bg-card);",
      "border:1px solid var(--border-light);border-radius:12px;box-shadow:var(--shadow-lg);",
      "font-family:inherit;overflow:hidden}",
      ".bridge-modal-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;",
      "border-bottom:1px solid var(--border);font-size:15px;font-weight:600;color:var(--text-primary)}",
      ".bridge-modal-close{width:28px;height:28px;border:0;background:transparent;color:var(--text-secondary);",
      "font-size:20px;line-height:1;cursor:pointer;border-radius:6px}",
      ".bridge-modal-close:hover{background:var(--bg-hover);color:var(--text-primary)}",
      ".bridge-modal-body{padding:16px 18px;display:flex;flex-direction:column;gap:14px}",
      ".bridge-field{display:flex;align-items:center;gap:10px}",
      ".bridge-field-label{width:36px;flex-shrink:0;font-size:13px;color:var(--text-secondary)}",
      ".bridge-field-hint{font-size:12px;color:var(--text-muted)}",
      ".bridge-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;",
      "border-top:1px solid var(--border);background:var(--bg-soft)}",
      ".bridge-palette-color{width:44px;height:30px;padding:0;border:1px solid var(--border);border-radius:6px;",
      "background:var(--bg-input);cursor:pointer;flex-shrink:0}",
      ".bridge-palette-text{flex:1;min-width:0;background:var(--bg-input);border:1px solid var(--border);",
      "border-radius:6px;color:var(--text-primary);font-family:inherit;font-size:13px;padding:6px 10px;outline:none}",
      ".bridge-palette-text:focus{border-color:var(--accent)}",
      ".bridge-palette-btn{height:30px;padding:0 16px;border-radius:6px;border:1px solid var(--border);",
      "background:var(--bg-input);color:var(--text-secondary);font-family:inherit;font-size:12px;cursor:pointer}",
      ".bridge-palette-btn:hover{color:var(--text-primary);border-color:var(--border-light)}",
      ".bridge-palette-btn.primary{background:var(--accent);border-color:var(--accent);color:#14120f;font-weight:600}",
      ".bridge-palette-btn.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}",
      ".bridge-palette-btn.danger{margin-right:auto}",
      ".bridge-palette-btn.danger:hover{color:#e07a6a;border-color:#e07a6a}",
      ".bridge-palette-swatches{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".bridge-swatch{width:22px;height:22px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0;",
      "transition:transform .15s,border-color .15s}",
      ".bridge-swatch:hover{transform:scale(1.12)}",
      ".bridge-swatch.is-active{border-color:var(--accent)}",
      ".bridge-color-dots [data-cw-label]::after{font-size:9.5px;margin-top:3px;color:var(--text-faint)}",
      // 操作按钮组靠右
      ".header .bridge-actions{margin-left:auto}",
      // 统计徽章贴最右
      ".header .bridge-badge{margin-left:12px;flex-shrink:0;white-space:nowrap}",
      // 窄屏：色点行允许横向滚动，统计徽章保持可见
      "@media (max-width:820px){.header{gap:10px !important;padding:6px 10px !important}",
      ".bridge-color-dots{overflow-x:auto;scrollbar-width:none}.bridge-color-dots::-webkit-scrollbar{display:none}}",
      "@media (max-height:620px){.bridge-color-dots{padding-bottom:9px}}",
    ].join("");
    document.head.appendChild(style);
  }

  // ---------- 侧边栏：网格背景开关（挂到 Weave 侧边栏，Weave 本体不改） ----------

  /** 网格显示偏好的 localStorage 键（Weave 自带键都是 flow_*，另开一个避免混淆） */
  var GRID_PREF_KEY = "cw_canvas_grid";

  /** 网格开关按钮的 DOM id */
  var GRID_BUTTON_ID = "bridgeGridToggle";

  /** 网格开关的 SVG 图标（九宫格，与 Weave 侧边栏其它按钮同一套描边风格） */
  var GRID_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="3" y="3" width="18" height="18" rx="2"></rect>' +
    '<path d="M9 3v18M15 3v18M3 9h18M3 15h18"></path>' +
    "</svg>";

  /**
   * 读取网格显示偏好（默认显示；localStorage 不可用时也按显示处理）。
   * @returns {boolean} 是否显示网格
   */
  function readGridPref() {
    try {
      return localStorage.getItem(GRID_PREF_KEY) !== "0";
    } catch (error) {
      return true;
    }
  }

  /**
   * 应用网格显示状态。网格画在 #gridCvs 这个 canvas 上，隐藏它即可——
   * Weave 每帧重绘的是它的内容，不改变显示属性，所以这个开关很稳。
   * @param {boolean} visible 是否显示
   */
  function applyGridPref(visible) {
    var grid = document.getElementById("gridCvs");
    if (grid) {
      grid.style.display = visible ? "" : "none";
    }
    var button = document.getElementById(GRID_BUTTON_ID);
    if (button) {
      // 用 Weave 侧边栏按钮自己的 active 类（.sidebar-btn.active），亮起表示「网格显示中」
      button.classList.toggle("active", visible);
      button.setAttribute("aria-pressed", visible ? "true" : "false");
      button.title = visible ? "网格背景：显示中（点击隐藏）" : "网格背景：已隐藏（点击显示）";
    }
    try {
      localStorage.setItem(GRID_PREF_KEY, visible ? "1" : "0");
    } catch (error) {
      // 隐私模式下忽略：只在本次会话生效
    }
  }

  /**
   * 把网格开关挂到侧边栏（「设置」按钮上方）。
   * 侧边栏由 Weave 渲染，可能在挂载之后才出现，因此由 startGridToggle 持续补挂。
   */
  function mountGridToggle() {
    var sidebar = document.getElementById("sidebar");
    if (!sidebar) {
      return;
    }
    var existing = document.getElementById(GRID_BUTTON_ID);
    if (existing && sidebar.contains(existing)) {
      return;
    }

    var button = document.createElement("button");
    button.className = "sidebar-btn";
    button.id = GRID_BUTTON_ID;
    button.type = "button";
    button.innerHTML = GRID_ICON;
    button.addEventListener("click", function () {
      var grid = document.getElementById("gridCvs");
      var currentlyVisible = !(grid && grid.style.display === "none");
      applyGridPref(!currentlyVisible);
    });

    var bottom = sidebar.querySelector(".sidebar-bottom");
    if (bottom) {
      sidebar.insertBefore(button, bottom);
    } else {
      sidebar.appendChild(button);
    }
    applyGridPref(readGridPref());
  }

  /** 启动网格开关：先挂一次，之后每秒检查（侧边栏若被重建会自动补回） */
  function startGridToggle() {
    mountGridToggle();
    applyGridPref(readGridPref());
    window.setInterval(mountGridToggle, 1000);
  }

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

  /** 启动：挂 UI、重做顶栏、颜色标注与自定义色样式、侧边栏开关，然后通知父页面下发数据 */
  function boot() {
    mountUi();
    rebuildHeader();
    buildColorDots();
    bindPalettePanelEvents();
    startNodeColorSync();
    injectNodeColorStyle();
    injectHeaderStyle();
    startGridToggle();
    log("桥已启动，等待父页面下发数据");
    loadingTimer = setTimeout(function () {
      log("等待数据超时");
      showLoadFailure("等待世界数据超时（父页面未下发或接口未返回）");
    }, LOADING_TIMEOUT_MS);
    // 反复广播就绪信号：父页面可能比桥晚挂上监听，单次发送会丢
    startReadyAnnounce();
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
