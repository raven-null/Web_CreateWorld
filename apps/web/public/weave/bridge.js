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

    // 左：颜色（胶囊本身就是分类名与状态显示，不再需要标题与当前色小圆点）
    var colorGroup = document.createElement("div");
    colorGroup.className = "bridge-color";
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
        // 顺序表：记录用户拖拽后的颜色排列（缺失时由 normalizeOrder 补全）
        order: Array.isArray(parsed.order) ? parsed.order : [],
      };
    } catch (error) {
      return { version: 1, custom: [], hidden: [], labels: {}, order: [] };
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
   * 补全调色板的顺序表：把「存在但不在 order 里」的颜色追加到末尾
   * （旧数据兼容——早期版本没有 order 字段）。就地修改传入的 palette。
   * @param {object} palette 调色板配置
   * @returns {string[]} 有效的顺序数组
   */
  function normalizeOrder(palette) {
    var known = [];
    for (var i = 0; i < PRESET_DEFS.length; i += 1) {
      known.push(PRESET_DEFS[i].color);
    }
    for (var j = 0; j < palette.custom.length; j += 1) {
      known.push(palette.custom[j]);
    }
    var order = Array.isArray(palette.order) ? palette.order : [];
    // 去掉已不存在的颜色，保持原顺序
    order = order.filter(function (color, index) {
      return known.indexOf(color) >= 0 && order.indexOf(color) === index;
    });
    // 补齐缺失的（旧数据或新添加）
    for (var k = 0; k < known.length; k += 1) {
      if (order.indexOf(known[k]) < 0) {
        order.push(known[k]);
      }
    }
    palette.order = order;
    return order;
  }

  /**
   * 取当前要展示的颜色列表，顺序遵循用户的拖拽排序（隐藏的不出现）。
   * @returns {Array<{color: string, hex: string, label: string, custom: boolean}>}
   */
  function paletteItems() {
    var palette = readPalette();
    var order = normalizeOrder(palette);
    var items = [];
    for (var i = 0; i < order.length; i += 1) {
      var color = order[i];
      if (palette.hidden.indexOf(color) >= 0) {
        continue;
      }
      var isPreset = false;
      var defaultLabel = color;
      for (var j = 0; j < PRESET_DEFS.length; j += 1) {
        if (PRESET_DEFS[j].color === color) {
          isPreset = true;
          defaultLabel = PRESET_DEFS[j].label;
          break;
        }
      }
      items.push({
        color: color,
        hex: hexForColor(color),
        label: palette.labels[color] || defaultLabel,
        custom: !isPreset,
      });
    }
    return items;
  }

  /**
   * 重排颜色：把 color 移动到 targetColor 的位置。
   *
   * 说明：拖拽松手时用的是「按 DOM 实际顺序整体写回」（见 handlePillDragEnd），
   * 比逐个移动更稳；这里保留一个单点移动的实现，供以后需要「上移/下移」这类菜单操作时复用。
   * @param {string} color 被移动的颜色
   * @param {string} targetColor 目标位置的颜色
   */
  function reorderPalette(color, targetColor) {
    if (color === targetColor) {
      return;
    }
    var palette = readPalette();
    var order = normalizeOrder(palette).slice();
    var from = order.indexOf(color);
    var to = order.indexOf(targetColor);
    if (from < 0 || to < 0) {
      return;
    }
    order.splice(from, 1);
    order.splice(to, 0, color);
    palette.order = order;
    writePalette(palette);
    log("颜色顺序已更新：", order.join(" → "));
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
    // 新颜色排到末尾
    var order = Array.isArray(palette.order) ? palette.order : [];
    if (order.indexOf(color) < 0) {
      order.push(color);
    }
    palette.order = order;
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

  // ---------- 画布节点：按颜色筛选与删除（删颜色时的级联处理） ----------

  /**
   * 列出画布上使用某个颜色的节点。
   * @param {string} color 颜色（预设色名或十六进制）
   * @returns {Array<{id: string, label: string, color: string}>} 节点列表
   */
  function nodesWithColor(color) {
    var nodes = (App.canvasState && App.canvasState.nodes) || [];
    var list = nodes.filter(function (node) {
      return (node.color || "") === color;
    });
    return list.map(function (node) {
      return { id: node.id, label: node.label || "未命名", color: node.color || "" };
    });
  }

  /**
   * 删除画布上的节点（连带其条目）。
   *
   * 直接复用 Weave 自己的 `App.removeNodes(ids)`：它会一并处理连线清理、分区 nodeIds、
   * 选中状态、收起记录、DOM 销毁与画布重绘——比桥自己拼一遍更稳。
   * 删除后触发一次保存，父页面（React 画布宿主）会把这批「画布上消失的节点」对应的条目删掉。
   * @param {string[]} nodeIds 要删除的节点 id
   * @returns {number} 提交删除的节点数
   */
  function deleteEntriesForNodes(nodeIds) {
    if (!nodeIds.length) {
      return 0;
    }
    if (typeof App.removeNodes !== "function") {
      log("App.removeNodes 不存在，取消级联删除");
      return 0;
    }
    // 删除过程里的中间态不必上报，删完统一报一次
    suppressReport = true;
    try {
      App.removeNodes(nodeIds);
    } catch (error) {
      log("删除节点出错：", error);
    }
    suppressReport = false;
    App.saveCanvas();
    log("已删除节点：", nodeIds.join(", "));
    return nodeIds.length;
  }

  // ---------- 确认弹窗（破坏性操作前的询问） ----------

  /** 确认弹窗容器 id */
  var CONFIRM_ID = "bridgeConfirm";

  /** 关闭确认弹窗 */
  function closeConfirm() {
    var box = document.getElementById(CONFIRM_ID);
    if (box) {
      box.style.display = "none";
      box.innerHTML = "";
    }
  }

  /**
   * 打开确认弹窗。
   * @param {{title: string, messageHtml: string, confirmText: string, danger?: boolean, nodes?: Array, onConfirm: Function}} options 选项
   */
  function openConfirm(options) {
    var box = document.getElementById(CONFIRM_ID);
    if (!box) {
      box = document.createElement("div");
      box.id = CONFIRM_ID;
      box.className = "bridge-modal";
      box.style.display = "none";
      document.body.appendChild(box);
    }
    var children = options.nodes || [];
    var nodeListHtml = "";
    if (children.length > 0) {
      var names = children
        .slice(0, 6)
        .map(function (node) {
          return '<li class="bridge-confirm-node">' + escapeAttr(node.label) + "</li>";
        })
        .join("");
      var more =
        children.length > 6 ? '<li class="bridge-confirm-node">…等共 ' + children.length + " 个</li>" : "";
      nodeListHtml = '<ul class="bridge-confirm-list">' + names + more + "</ul>";
    }

    box.innerHTML =
      '<div class="bridge-modal-mask" data-confirm="cancel"></div>' +
      '<div class="bridge-modal-box" role="dialog" aria-modal="true">' +
      '<div class="bridge-modal-head">' +
      escapeAttr(options.title) +
      '<button type="button" class="bridge-modal-close" data-confirm="cancel" aria-label="关闭">×</button>' +
      "</div>" +
      '<div class="bridge-modal-body"><p class="bridge-confirm-text">' +
      (options.messageHtml || "") +
      "</p>" +
      nodeListHtml +
      "</div>" +
      '<div class="bridge-modal-foot">' +
      '<button type="button" class="bridge-palette-btn" data-confirm="cancel">取消</button>' +
      '<button type="button" class="bridge-palette-btn ' +
      (options.danger ? "danger-strong" : "primary") +
      '" data-confirm="ok">' +
      escapeAttr(options.confirmText) +
      "</button>" +
      "</div>" +
      "</div>";
    box.style.display = "flex";

    box.onclick = function (event) {
      var target = event.target;
      if (!target || !target.closest) {
        return;
      }
      var kind = target.closest("[data-confirm]");
      if (!kind) {
        return;
      }
      var action = kind.getAttribute("data-confirm");
      closeConfirm();
      if (action === "ok" && typeof options.onConfirm === "function") {
        options.onConfirm();
      }
    };
    box.onkeydown = function (event) {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        closeConfirm();
      }
    };
  }

  /**
   * 取某个颜色的显示说明（找不到时返回颜色本身）。
   * @param {string} color 颜色
   * @returns {string} 说明
   */
  function labelOfColor(color) {
    var items = paletteItems();
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].color === color) {
        return items[i].label;
      }
    }
    return color;
  }

  /**
   * 删除颜色前的确认与级联处理。
   *
   * 行为：
   *   · 若画布上有使用该颜色的节点 → 弹窗列出节点，确认后**连带删除这些节点（即对应条目）**
   *   · 若没有节点使用 → 仍然弹窗确认（避免误点把颜色删掉），但语气轻一些
   * @param {string} color 颜色
   */
  function confirmRemoveColor(color) {
    var name = escapeAttr(labelOfColor(color));
    var nodes = nodesWithColor(color);
    var messageHtml =
      nodes.length > 0
        ? "画布上有 <strong>" +
          nodes.length +
          "</strong> 个节点正在使用「<strong>" +
          name +
          "</strong>」。删除这个颜色会<strong>连同这些节点一起删除</strong>（节点即条目，正文也会一并删除）："
        : "确定删除颜色「<strong>" + name + "</strong>」吗？画布上目前没有节点在使用它。";
    openConfirm({
      title: "删除颜色",
      messageHtml: messageHtml,
      confirmText: nodes.length > 0 ? "删除颜色与节点" : "删除颜色",
      danger: nodes.length > 0,
      nodes: nodes,
      onConfirm: function () {
        if (nodes.length > 0) {
          deleteEntriesForNodes(
            nodes.map(function (node) {
              return node.id;
            }),
          );
        }
        removePaletteColor(color);
        buildColorDots();
      },
    });
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

  /**
   * 保存弹窗内容。
   * 「添加」模式：颜色 + 说明一起写入。
   * 「修改」模式：颜色与说明都可以改——配色变了就等价于「移除旧色、加入新色」。
   */
  function savePalettePanel() {
    var colorInput = document.getElementById("bridgePaletteColor");
    var labelInput = document.getElementById("bridgePaletteLabel");
    var pickedColor = colorInput ? colorInput.value : "";
    var label = labelInput ? labelInput.value : "";

    if (palettePanel.mode === "edit" && palettePanel.editColor) {
      var origin = palettePanel.editColor;
      if (pickedColor && pickedColor !== origin) {
        // 改色：旧色移除（预设色会被标记隐藏），新色带上新说明
        removePaletteColor(origin);
        addPaletteColor(pickedColor, label);
      } else {
        // 只改说明
        var palette = readPalette();
        if (label && String(label).trim()) {
          palette.labels[origin] = String(label).trim().slice(0, 10);
        } else {
          delete palette.labels[origin];
        }
        writePalette(palette);
      }
    } else if (pickedColor) {
      addPaletteColor(pickedColor, label);
    }

    closePalettePanel();
    buildColorDots();
  }

  /** 移除当前弹窗里编辑的颜色（同样先走确认） */
  function deletePaletteColor() {
    if (palettePanel.mode !== "edit" || !palettePanel.editColor) {
      return;
    }
    var color = palettePanel.editColor;
    closePalettePanel();
    confirmRemoveColor(color);
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
   * 取「写在颜色块上的文字」该用什么颜色：默认白字，只有背景很浅时才换成深色。
   * @param {string} hex 十六进制色值
   * @returns {string} 文字颜色
   */
  function textColorOn(hex) {
    if (!isHexColor(hex)) {
      return "#ffffff";
    }
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    var luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    // 阈值取 0.78：绝大多数颜色用白字（保持统一），只有浅黄这类很亮的底才转深色
    return luminance > 0.78 ? "#1c1915" : "#ffffff";
  }

  /**
   * 悬浮操作菜单（修改 / 删除）。
   *
   * 为什么不放在胶囊内部：色点行为了横向滚动设了 `overflow-x:auto`，而 CSS 规定
   * 「一个轴不是 visible 时，另一个轴也会被当成 auto」——菜单放在胶囊里会被这一层裁掉（实测悬浮没反应）。
   * 因此菜单挂在 body 上、用 position:fixed 按胶囊位置定位，彻底不受任何容器裁剪。
   */
  var pillMenuEl = null;
  /** 当前菜单对应的颜色 */
  var pillMenuColor = "";
  /** 延迟关闭的定时器：留出鼠标从胶囊移到菜单上的时间 */
  var pillMenuTimer = null;

  /** 取（或创建）悬浮菜单元素 */
  function ensurePillMenu() {
    if (pillMenuEl && document.body.contains(pillMenuEl)) {
      return pillMenuEl;
    }
    pillMenuEl = document.createElement("div");
    pillMenuEl.className = "bridge-pill-menu";
    pillMenuEl.style.display = "none";
    pillMenuEl.innerHTML =
      '<button type="button" class="bridge-pill-action" data-action="edit">修改</button>' +
      '<button type="button" class="bridge-pill-action" data-action="remove">删除</button>';
    pillMenuEl.addEventListener("click", function (event) {
      // 阻止冒泡到 document：否则「点空白收起菜单」的全局监听会在本处理器之后触发
      event.stopPropagation();
      var action = event.target && event.target.closest ? event.target.closest(".bridge-pill-action") : null;
      if (!action || !pillMenuColor) {
        return;
      }
      var color = pillMenuColor;
      hidePillMenu();
      if (action.dataset.action === "remove") {
        // 先确认：画布上若有该颜色的节点，会提示会连带删除
        confirmRemoveColor(color);
      } else {
        openEditColorPanel(color);
      }
    });
    // 鼠标进入菜单时取消关闭，离开则收起
    pillMenuEl.addEventListener("mouseenter", function () {
      if (pillMenuTimer !== null) {
        clearTimeout(pillMenuTimer);
        pillMenuTimer = null;
      }
    });
    pillMenuEl.addEventListener("mouseleave", function () {
      hidePillMenu();
    });
    document.body.appendChild(pillMenuEl);
    return pillMenuEl;
  }

  /** 收起悬浮菜单 */
  function hidePillMenu() {
    if (pillMenuTimer !== null) {
      clearTimeout(pillMenuTimer);
      pillMenuTimer = null;
    }
    pillMenuColor = "";
    if (pillMenuEl) {
      pillMenuEl.style.display = "none";
    }
  }

  /**
   * 在胶囊附近显示悬浮菜单：默认贴其下方，下方空间不足时翻到上方。
   * @param {HTMLElement} pill 胶囊元素
   */
  function showPillMenu(pill) {
    var menu = ensurePillMenu();
    var color = pill.dataset.c;
    if (!color) {
      return;
    }
    if (pillMenuTimer !== null) {
      clearTimeout(pillMenuTimer);
      pillMenuTimer = null;
    }
    pillMenuColor = color;
    menu.style.display = "inline-flex";
    // 先显示再量尺寸，保证定位准确
    var rect = pill.getBoundingClientRect();
    var menuRect = menu.getBoundingClientRect();
    var gap = 6;
    var top = rect.bottom + gap;
    if (top + menuRect.height > window.innerHeight - 4) {
      top = rect.top - menuRect.height - gap;
    }
    var left = rect.left + rect.width / 2 - menuRect.width / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - menuRect.width - 6));
    menu.style.top = Math.round(top) + "px";
    menu.style.left = Math.round(left) + "px";
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
    hidePillMenu();

    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      var isActive = item.color === activeColor;

      // 胶囊 = 颜色 + 说明文字；选中时整体高亮
      var pill = document.createElement("span");
      pill.className = "bridge-pill" + (isActive ? " is-active" : "");
      pill.dataset.c = item.color;
      pill.style.background = item.hex;
      pill.style.color = textColorOn(item.hex);
      pill.title = item.label + "（" + item.color + "）";

      var label = document.createElement("span");
      label.className = "bridge-pill-label";
      label.textContent = item.label;
      pill.appendChild(label);

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

    // 单击：选颜色 / 打开添加弹窗
    container.onclick = function (event) {
      var target = event.target;
      if (!target || !target.closest) {
        return;
      }
      // 刚拖拽完的这一次点击不要当成选色
      if (Date.now() < suppressClickUntil) {
        return;
      }
      if (target.closest(".bridge-add")) {
        openAddColorPanel();
        return;
      }
      var pill = target.closest(".bridge-pill");
      if (!pill) {
        return;
      }
      App._setGenColor(pill.dataset.c);
      var all = container.querySelectorAll(".bridge-pill");
      for (var k = 0; k < all.length; k += 1) {
        all[k].classList.toggle("is-active", all[k].dataset.c === pill.dataset.c);
      }
    };

    // 长按拖拽排序
    container.onpointerdown = function (event) {
      var pill = event.target && event.target.closest ? event.target.closest(".bridge-pill") : null;
      if (!pill || event.button !== 0) {
        return;
      }
      beginLongPress(pill, event.clientX, event.clientY);
    };
    container.onpointermove = function (event) {
      // 还没进入拖拽状态就大幅移动 → 视为滚动/点选，放弃长按
      if (dragState.active || !dragState.color) {
        return;
      }
      if (Math.abs(event.clientX - dragState.startX) + Math.abs(event.clientY - dragState.startY) > LONG_PRESS_MOVE_TOLERANCE) {
        clearLongPressTimer();
        dragState = { active: false, color: "", startX: 0, startY: 0, moved: false };
      }
    };
    container.onpointerup = function () {
      // 长按计时期间松手：取消长按（这次仍是普通点击）
      if (!dragState.active) {
        clearLongPressTimer();
        dragState = { active: false, color: "", startX: 0, startY: 0, moved: false };
      }
    };
    container.onpointerleave = function () {
      if (!dragState.active) {
        clearLongPressTimer();
        dragState = { active: false, color: "", startX: 0, startY: 0, moved: false };
      }
    };

    // 悬浮：显示「修改 / 删除」
    container.onmouseover = function (event) {
      var pill = event.target && event.target.closest ? event.target.closest(".bridge-pill") : null;
      if (pill) {
        showPillMenu(pill);
      }
    };
    container.onmouseleave = function () {
      // 鼠标可能正移向菜单，延迟一点再收起
      if (pillMenuTimer !== null) {
        clearTimeout(pillMenuTimer);
      }
      pillMenuTimer = window.setTimeout(hidePillMenu, 180);
    };
  }

  /** 全局：点空白处收起悬浮菜单（只注册一次） */
  function bindPillMenuGlobalEvents() {
    document.addEventListener("click", function (event) {
      if (event.target && event.target.closest && event.target.closest(".bridge-pill-menu")) {
        return;
      }
      hidePillMenu();
    });
  }

  // ---------- 长按拖拽排序 ----------

  /** 长按判定时长（毫秒）：按住这么久才开始拖拽 */
  var LONG_PRESS_MS = 350;

  /** 长按期间的容错位移：超过这个距离就当成普通手势（滚动/点选）而放弃拖拽 */
  var LONG_PRESS_MOVE_TOLERANCE = 8;

  /** 拖拽状态 */
  var dragState = { active: false, color: "", startX: 0, startY: 0, moved: false };

  /** 刚结束拖拽的时间戳：用来抑制紧随其后的 click（否则会顺手改了默认色） */
  var suppressClickUntil = 0;

  /** 长按计时器 */
  var longPressTimer = null;

  /** 取消长按计时 */
  function clearLongPressTimer() {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  /**
   * 结束拖拽：清理监听与视觉状态；移动过则重绘一次（顺序已由写回过程保存）。
   * @param {boolean} commit 是否在移动后重绘
   */
  function endPillDrag(commit) {
    clearLongPressTimer();
    if (!dragState.active) {
      dragState = { active: false, color: "", startX: 0, startY: 0, moved: false };
      return;
    }
    var dragged = document.querySelector(".bridge-pill.is-dragging");
    if (dragged) {
      dragged.classList.remove("is-dragging");
    }
    // 抑制紧随其后的 click：否则松手会顺手把「默认色」改成被拖的那个
    suppressClickUntil = Date.now() + 200;
    var moved = dragState.moved;
    dragState = { active: false, color: "", startX: 0, startY: 0, moved: false };
    document.body.classList.remove("bridge-dragging");
    document.removeEventListener("pointermove", handlePillDragMove, true);
    document.removeEventListener("pointerup", handlePillDragEnd, true);
    document.removeEventListener("pointercancel", handlePillDragEnd, true);
    if (commit && moved) {
      buildColorDots();
    }
  }

  /**
   * 拖拽中：把被拖的胶囊插入到指针当前所在的胶囊之前/之后。
   * 直接重排 DOM，松手后再保存顺序（视觉上跟手，且期间不写 localStorage）。
   * @param {PointerEvent} event 指针事件
   */
  function handlePillDragMove(event) {
    if (!dragState.active) {
      return;
    }
    event.preventDefault();
    var container = document.getElementById(COLOR_DOTS_ID);
    if (!container) {
      return;
    }
    var dragged = container.querySelector('.bridge-pill[data-c="' + dragState.color + '"]');
    if (!dragged) {
      return;
    }
    var pills = container.querySelectorAll(".bridge-pill");
    var reference = null;
    for (var i = 0; i < pills.length; i += 1) {
      var pill = pills[i];
      if (pill === dragged) {
        continue;
      }
      var rect = pill.getBoundingClientRect();
      if (event.clientX < rect.left + rect.width / 2) {
        reference = pill;
        break;
      }
    }
    if (reference) {
      if (dragged.nextSibling !== reference) {
        container.insertBefore(dragged, reference);
        dragState.moved = true;
      }
    } else if (container.lastElementChild !== dragged) {
      // 拖到最右：插到所有胶囊之后（但保持在「＋ 添加」按钮之前）
      var addButton = container.querySelector(".bridge-add");
      container.insertBefore(dragged, addButton);
      dragState.moved = true;
    }
  }

  /**
   * 松手：按当前 DOM 顺序写入排序表。
   * @param {PointerEvent} event 指针事件
   */
  function handlePillDragEnd() {
    var container = document.getElementById(COLOR_DOTS_ID);
    var draggedColor = dragState.color;
    var moved = dragState.moved;
    var sequence = [];
    if (container) {
      var pills = container.querySelectorAll(".bridge-pill");
      for (var i = 0; i < pills.length; i += 1) {
        sequence.push(pills[i].dataset.c);
      }
    }
    var wasActive = dragState.active;
    endPillDrag(false);
    if (!wasActive || !moved || sequence.length === 0) {
      return;
    }
    // 按拖拽后的实际顺序整体写回（比「移动某一个」更稳）
    var palette = readPalette();
    palette.order = sequence;
    writePalette(palette);
    log("颜色顺序已更新：", sequence.join(" → "));
    void draggedColor;
    buildColorDots();
  }

  /**
   * 在胶囊上开始长按 → 进入拖拽。
   * @param {HTMLElement} pill 胶囊元素
   * @param {number} clientX 指针 x
   * @param {number} clientY 指针 y
   */
  function beginLongPress(pill, clientX, clientY) {
    clearLongPressTimer();
    dragState = { active: false, color: pill.dataset.c, startX: clientX, startY: clientY, moved: false };
    longPressTimer = window.setTimeout(function () {
      longPressTimer = null;
      if (!dragState.color) {
        return;
      }
      dragState.active = true;
      var current = document.querySelector('.bridge-pill[data-c="' + dragState.color + '"]');
      if (current) {
        current.classList.add("is-dragging");
      }
      document.body.classList.add("bridge-dragging");
      hidePillMenu();
      log("开始拖拽排序：", dragState.color);
      document.addEventListener("pointermove", handlePillDragMove, true);
      document.addEventListener("pointerup", handlePillDragEnd, true);
      document.addEventListener("pointercancel", handlePillDragEnd, true);
    }, LONG_PRESS_MS);
  }

  // 视图变化时菜单会错位，直接收起
  window.addEventListener("scroll", hidePillMenu, true);
  window.addEventListener("resize", hidePillMenu);

  /**
   * 兼容保留的空实现：当前选中的颜色已由胶囊自身的高亮表达（.bridge-pill.is-active），
   * 不再需要额外的「当前色小圆点」。保留函数与调用点是为了不破坏历史引用。
   */
  function updateCurrentColor() {
    // 无需操作
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
      ".bridge-color-dots{display:flex;align-items:center;gap:8px;overflow-x:auto;overflow-y:visible;",
      "scrollbar-width:none;padding:3px 0}",
      ".bridge-color-dots::-webkit-scrollbar{display:none}",
      // 胶囊：底色=颜色，说明文字写在里面；文字颜色由 JS 按亮度自适应（默认白字）
      ".bridge-pill{position:relative;display:inline-flex;align-items:center;flex-shrink:0;border-radius:999px;",
      "border:2px solid transparent;padding:4px 12px 5px;font-family:inherit;font-size:13px;font-weight:600;",
      "line-height:1.2;letter-spacing:.2px;cursor:pointer;text-shadow:0 1px 2px rgba(0,0,0,.35);",
      "transition:box-shadow .15s,transform .15s}",
      // 选中的胶囊整体高亮
          ".bridge-pill.is-active{border-color:#e8e0d3;box-shadow:0 0 0 2px rgba(201,161,92,.55)}",
      ".bridge-pill-label{white-space:nowrap;pointer-events:none}",
      // 拖拽排序：被拖的胶囊半透明 + 虚线框；拖动期间禁用文本选择
      ".bridge-pill.is-dragging{opacity:.65;border-style:dashed;border-color:#e8e0d3}",
      "body.bridge-dragging{cursor:grabbing !important;user-select:none !important}",
      ".bridge-color-dots{user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}",
      // 悬浮操作菜单：挂在 body 上、fixed 定位，不受色点行 overflow 裁剪
      ".bridge-pill-menu{position:fixed;z-index:1500;display:none;gap:2px;padding:3px;border-radius:8px;",
      "background:var(--bg-card);border:1px solid var(--border-light);box-shadow:var(--shadow-lg);white-space:nowrap}",
      ".bridge-pill-action{border:0;background:transparent;color:var(--text-secondary);font-family:inherit;",
      "font-size:12px;line-height:1.6;padding:2px 10px;border-radius:5px;cursor:pointer;white-space:nowrap}",
      ".bridge-pill-action:hover{background:var(--bg-hover);color:var(--text-primary)}",
      ".bridge-pill-action[data-action='remove']:hover{color:#e07a6a}",
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
      // 破坏性确认：这个按钮要比普通按钮更醒目
      ".bridge-palette-btn.danger-strong{background:#c25e5e;border-color:#c25e5e;color:#fff;font-weight:600}",
      ".bridge-palette-btn.danger-strong:hover{background:#d06a6a;border-color:#d06a6a;color:#fff}",
      // 确认弹窗正文与节点清单
      ".bridge-confirm-text{margin:0;font-size:13px;line-height:1.75;color:var(--text-primary)}",
      ".bridge-confirm-text strong{color:var(--accent)}",
      ".bridge-confirm-list{margin:12px 0 0;padding:0;list-style:none;max-height:150px;overflow-y:auto;",
      "display:flex;flex-direction:column;gap:4px}",
      ".bridge-confirm-node{font-size:12px;color:var(--text-secondary);background:var(--bg-input);",
      "border:1px solid var(--border);border-radius:6px;padding:4px 10px}",
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
    bindPillMenuGlobalEvents();
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
