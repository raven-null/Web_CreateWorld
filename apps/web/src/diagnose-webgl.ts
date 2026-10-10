/**
 * WebGL2 与着色器编译诊断页。
 *
 * 用途：当 3D 地球仪显示「当前设备不支持 WebGL2」时，打开这个页面就能看清
 * 到底是**环境不支持**还是**着色器编译失败**（两者在界面上是同一句提示，
 * 但处理方式完全不同）。
 *
 * 打开方式：`pnpm dev:web` 后访问 http://localhost:5173/diagnose.html
 */
import { globeShaders } from "@worldmap/editor";

const {
  GLOBE_FRAGMENT_SHADER,
  GLOBE_VERTEX_SHADER,
  ATMOSPHERE_FRAGMENT_SHADER,
  ATMOSPHERE_VERTEX_SHADER,
  STARFIELD_FRAGMENT_SHADER,
  STARFIELD_VERTEX_SHADER,
} = globeShaders;

/** 一条诊断结果 */
interface ReportItem {
  label: string;
  ok: boolean;
  detail?: string;
}

/** 逐段执行的诊断步骤 */
function runDiagnostics(): ReportItem[] {
  const items: ReportItem[] = [];

  // ① 基础环境
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  items.push({
    label: "浏览器支持 WebGL2",
    ok: gl !== null,
    detail: gl ? "" : "getContext('webgl2') 返回 null",
  });
  if (!gl) {
    const gl1 = canvas.getContext("webgl");
    items.push({ label: "至少支持 WebGL1", ok: gl1 !== null, detail: gl1 ? "只有 WebGL1" : "两者都不支持" });
    return items;
  }

  // ② 上下文参数
  items.push({
    label: "厂商 / 渲染器",
    ok: true,
    detail: `${gl.getParameter(gl.VENDOR)} / ${gl.getParameter(gl.RENDERER)}`,
  });
  items.push({
    label: "GLSL 版本",
    ok: true,
    detail: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)),
  });

  // ③ 逐个编译着色器，把日志原样带出来
  const pairs: [string, string, string][] = [
    ["球面", GLOBE_VERTEX_SHADER, GLOBE_FRAGMENT_SHADER],
    ["大气", ATMOSPHERE_VERTEX_SHADER, ATMOSPHERE_FRAGMENT_SHADER],
    ["星空", STARFIELD_VERTEX_SHADER, STARFIELD_FRAGMENT_SHADER],
  ];
  for (const [name, vertexSource, fragmentSource] of pairs) {
    const vertexResult = compile(gl, gl.VERTEX_SHADER, vertexSource);
    const fragmentResult = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
    items.push({
      label: `${name} · 顶点着色器`,
      ok: vertexResult.ok,
      detail: vertexResult.log,
    });
    items.push({
      label: `${name} · 片元着色器`,
      ok: fragmentResult.ok,
      detail: fragmentResult.log,
    });
  }

  return items;
}

/**
 * 编译一个着色器并返回日志。
 * @param gl WebGL2 上下文
 * @param type 着色器类型
 * @param source 源码
 * @returns 是否成功与编译日志
 */
function compile(gl: WebGL2RenderingContext, type: number, source: string): { ok: boolean; log: string } {
  const shader = gl.createShader(type);
  if (!shader) {
    return { ok: false, log: "createShader 返回 null" };
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS) as boolean;
  const log = (gl.getShaderInfoLog(shader) ?? "").trim();
  gl.deleteShader(shader);
  return { ok, log };
}

/**
 * 把诊断结果渲染到页面。
 */
function render(): void {
  const container = document.getElementById("report");
  if (!container) {
    return;
  }
  const items = runDiagnostics();
  const failed = items.filter((item) => !item.ok);

  const summary = document.createElement("p");
  summary.style.fontSize = "16px";
  summary.style.marginBottom = "16px";
  summary.textContent =
    failed.length === 0
      ? "✅ 全部通过：WebGL2 与三个着色器都正常——若编辑器仍提示不支持，请把这条结果发我。"
      : `❌ 有 ${failed.length} 项失败（下面标红的是原因）`;
  container.appendChild(summary);

  for (const item of items) {
    const row = document.createElement("div");
    row.style.cssText = `padding:8px 10px;margin-bottom:6px;border-radius:6px;border:1px solid ${
      item.ok ? "#3a332a" : "#c25e5e"
    };`;
    const title = document.createElement("strong");
    title.textContent = `${item.ok ? "✓" : "✗"} ${item.label}`;
    title.style.color = item.ok ? "#6fa06f" : "#c25e5e";
    row.appendChild(title);
    if (item.detail) {
      const detail = document.createElement("pre");
      detail.style.cssText = "margin:6px 0 0;white-space:pre-wrap;font-size:12px;color:#a89c88;";
      detail.textContent = item.detail;
      row.appendChild(detail);
    }
    container.appendChild(row);
  }
}

render();
