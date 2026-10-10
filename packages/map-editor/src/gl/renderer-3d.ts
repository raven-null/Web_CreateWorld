/**
 * 3D 地球仪的 WebGL2 渲染器（方案 §14）。
 *
 * 为什么是裸 WebGL2：本方案的 3D 只需「一个球 + 贴图 + 旋转 + 大气/星空/昼夜」，
 * 自写着色器约 300 行、零依赖；引 three.js 要 ~150KB 而当前构建没有任何分包配置。
 *
 * 美术三件套（都能单独开关，性能档位即组合这些开关）：
 * 1. 球面贴图（白板合成图）+ 经纬网 + 昼夜明暗
 * 2. 大气辉光（菲涅尔，外扩 1.03R 的背面外壳）
 * 3. 星空背景（程序化哈希噪声，零图片资源）
 *
 * 2D 与 3D 共用同一份数据：白板本身就是球面贴图，这里不做任何重投影。
 */
import {
  ATMOSPHERE_FRAGMENT_SHADER,
  ATMOSPHERE_VERTEX_SHADER,
  GLOBE_FRAGMENT_SHADER,
  GLOBE_VERTEX_SHADER,
  STARFIELD_FRAGMENT_SHADER,
  STARFIELD_VERTEX_SHADER,
} from "./shaders";
import {
  mat4Perspective,
  mat4ViewFromOrbit,
  lonLatToPosition,
  type Mat4,
} from "./mat4";

/** 性能档位（方案 §14.3.4） */
export type GlobeQuality = "full" | "lite" | "minimal";

/** 美术效果开关 */
export interface GlobeEffects {
  atmosphere: boolean;
  stars: boolean;
  dayNight: boolean;
}

/**
 * 按档位得到效果组合。
 * 桌面默认「完整」、移动端默认「精简」（关大气辉光），用户可在显示设置里改。
 * @param quality 档位
 * @returns 效果开关
 */
export function effectsForQuality(quality: GlobeQuality): GlobeEffects {
  switch (quality) {
    case "full":
      return { atmosphere: true, stars: true, dayNight: true };
    case "lite":
      return { atmosphere: false, stars: true, dayNight: true };
    case "minimal":
    default:
      return { atmosphere: false, stars: false, dayNight: false };
  }
}

/**
 * 按设备特征推荐默认档位：触摸为主或窄屏视为移动端。
 * @param options 屏幕宽度与是否触摸为主
 * @returns 推荐档位
 */
export function recommendQuality(options: { screenWidth: number; touchPrimary: boolean }): GlobeQuality {
  if (options.touchPrimary || options.screenWidth <= 768) {
    return "lite";
  }
  return "full";
}

/** 渲染器初始化选项 */
export interface GlobeRendererOptions {
  /** 白板索引栅格（行优先，0 = 透明） */
  indices: Uint8Array;
  /** 白板宽 */
  width: number;
  /** 白板高 */
  height: number;
  /** 调色板：下标 → 颜色 */
  palette: { index: number; color: string }[];
  /** 主题色（星空 / 大气 / 夜色） */
  colors: { sky: string; atmosphere: string; night: string };
}

/** 相机与交互状态 */
export interface GlobeCamera {
  /** 水平角（弧度，0 = 正对初始经度） */
  yaw: number;
  /** 俯仰角（弧度） */
  pitch: number;
  /** 距球心距离（单位为球半径） */
  distance: number;
}

/** 太阳方向（用「直射点」表达，符合直觉：拖经度就能移动黄昏线） */
export interface SunPosition {
  /** 直射点经度（度） */
  lon: number;
  /** 直射点纬度（度） */
  lat: number;
}

/** 创建渲染器时的结果 */
export interface GlobeRenderer {
  /** 画布（由调用方挂进 DOM） */
  canvas: HTMLCanvasElement;
  /** 更新贴图（2D 画完或撤销后调用） */
  updateTexture(options: GlobeRendererOptions): void;
  /** 渲染一帧 */
  render(camera: GlobeCamera, sun: SunPosition, effects: GlobeEffects): void;
  /** 尺寸变化（按设备像素比重设后备缓冲） */
  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void;
  /** 屏幕坐标 → 经纬度（拾取；为后续「在球上放标记」预留） */
  pick(cssX: number, cssY: number, camera: GlobeCamera): { lon: number; lat: number } | null;
  /** 每帧像素尺寸（供截图） */
  pixelSize(): { width: number; height: number };
  /** 释放资源 */
  dispose(): void;
}

/**
 * 判断当前环境是否支持 WebGL2。
 * @returns 支持返回 true
 */
export function isWebGL2Available(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  try {
    const canvas = document.createElement("canvas");
    return canvas.getContext("webgl2") !== null;
  } catch {
    return false;
  }
}

/**
 * 创建 3D 地球仪渲染器。
 *
 * @param options 初始白板数据与配色
 * @returns 渲染器；环境不支持 WebGL2 时返回 null
 */
export function createGlobeRenderer(options: GlobeRendererOptions): GlobeRenderer | null {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: true,
    preserveDrawingBuffer: true, // 截图需要
  });
  if (!gl) {
    return null;
  }

  const globeProgram = createProgram(gl, GLOBE_VERTEX_SHADER, GLOBE_FRAGMENT_SHADER);
  const atmosphereProgram = createProgram(gl, ATMOSPHERE_VERTEX_SHADER, ATMOSPHERE_FRAGMENT_SHADER);
  const starfieldProgram = createProgram(gl, STARFIELD_VERTEX_SHADER, STARFIELD_FRAGMENT_SHADER);
  if (!globeProgram || !atmosphereProgram || !starfieldProgram) {
    // 失败原因一定要打出来：界面上只会说「不支持 WebGL2」，
    // 但那可能是环境问题，也可能是着色器编译失败，处理方式完全不同
    const reasons = [
      globeProgram ? null : "球面程序链接失败",
      atmosphereProgram ? null : "大气程序链接失败",
      starfieldProgram ? null : "星空程序链接失败",
    ].filter((item): item is string => item !== null);
    console.error("[worldmap/3d] 着色器初始化失败：", reasons.join("；"), gl.getError());
    return null;
  }

  const sphere = createSphereMesh(gl, 128, 64);
  const atmosphereMesh = createSphereMesh(gl, 64, 32);
  const quad = createFullscreenQuad(gl);
  if (!sphere || !atmosphereMesh || !quad) {
    console.error("[worldmap/3d] 网格创建失败（可能是显存或上下文丢失）");
    return null;
  }

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([15, 26, 36, 255]));

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);

  let cssWidth = 1;
  let cssHeight = 1;
  let ratio = 1;

  /** 把索引栅格转成纹理并上传 */
  const updateTexture = (input: GlobeRendererOptions): void => {
    const rgba = new Uint8Array(input.width * input.height * 4);
    const table = new Map<number, [number, number, number]>();
    for (const brush of input.palette) {
      table.set(brush.index, parseHexColor(brush.color));
    }
    for (let i = 0; i < input.indices.length; i += 1) {
      const value = input.indices[i] ?? 0;
      const offset = i * 4;
      if (value === 0) {
        continue; // 透明：交给着色器兜成深水色
      }
      const color = table.get(value);
      if (!color) {
        continue;
      }
      rgba[offset] = color[0];
      rgba[offset + 1] = color[1];
      rgba[offset + 2] = color[2];
      rgba[offset + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1); // 让纹理第 0 行对应北极（uv.y = 0）
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, input.width, input.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  };

  /** 渲染一帧 */
  const render = (camera: GlobeCamera, sun: SunPosition, effects: GlobeEffects): void => {
    const aspect = cssHeight > 0 ? cssWidth / cssHeight : 1;
    const projection = mat4Perspective((45 * Math.PI) / 180, aspect, 0.1, 100);
    const view = mat4ViewFromOrbit(camera.yaw, camera.pitch, camera.distance);
    const cosPitch = Math.cos(camera.pitch);
    const eyeX = camera.distance * cosPitch * Math.sin(camera.yaw);
    const eyeY = camera.distance * Math.sin(camera.pitch);
    const eyeZ = camera.distance * cosPitch * Math.cos(camera.yaw);

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.02, 0.03, 0.05, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // ① 星空背景（全屏，先画且关深度写入）
    if (effects.stars) {
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(starfieldProgram);
      gl.uniform2f(gl.getUniformLocation(starfieldProgram, "uResolution"), canvas.width, canvas.height);
      gl.uniform1f(gl.getUniformLocation(starfieldProgram, "uDensity"), 1.0);
      gl.uniform1f(gl.getUniformLocation(starfieldProgram, "uBrightness"), 0.9);
      gl.uniform3fv(gl.getUniformLocation(starfieldProgram, "uSkyColor"), parseFloatColor(options.colors.sky));
      gl.bindVertexArray(quad);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.enable(gl.DEPTH_TEST);
    }

    // ② 球面
    const model = mat4IdentityModel();
    gl.useProgram(globeProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(globeProgram, "uTexture"), 0);
    gl.uniformMatrix4fv(gl.getUniformLocation(globeProgram, "uProjection"), false, projection);
    gl.uniformMatrix4fv(gl.getUniformLocation(globeProgram, "uView"), false, view);
    gl.uniformMatrix4fv(gl.getUniformLocation(globeProgram, "uModel"), false, model);
    gl.uniform3f(gl.getUniformLocation(globeProgram, "uCameraPosition"), eyeX, eyeY, eyeZ);
    gl.uniform3fv(
      gl.getUniformLocation(globeProgram, "uSunDirection"),
      sunDirection(sun),
    );
    gl.uniform3fv(gl.getUniformLocation(globeProgram, "uNightColor"), parseFloatColor(options.colors.night));
    gl.uniform1f(gl.getUniformLocation(globeProgram, "uGraticule"), 1);
    gl.uniform1f(gl.getUniformLocation(globeProgram, "uDayNight"), effects.dayNight ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(globeProgram, "uTextureFlipV"), 0);
    gl.bindVertexArray(sphere.vao);
    gl.drawElements(gl.TRIANGLES, sphere.indexCount, gl.UNSIGNED_SHORT, 0);

    // ③ 大气辉光：外扩外壳，只渲染背面（球体之外的部分才可见）
    if (effects.atmosphere) {
      const atmosphereModel = mat4Scale(1.03);
      gl.useProgram(atmosphereProgram);
      gl.uniformMatrix4fv(gl.getUniformLocation(atmosphereProgram, "uProjection"), false, projection);
      gl.uniformMatrix4fv(gl.getUniformLocation(atmosphereProgram, "uView"), false, view);
      gl.uniformMatrix4fv(gl.getUniformLocation(atmosphereProgram, "uModel"), false, atmosphereModel);
      gl.uniform3f(gl.getUniformLocation(atmosphereProgram, "uCameraPosition"), eyeX, eyeY, eyeZ);
      gl.uniform3fv(
        gl.getUniformLocation(atmosphereProgram, "uAtmosphereColor"),
        parseFloatColor(options.colors.atmosphere),
      );
      gl.uniform1f(gl.getUniformLocation(atmosphereProgram, "uIntensity"), 1.1);
      gl.uniform1f(gl.getUniformLocation(atmosphereProgram, "uPower"), 2.5);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.cullFace(gl.FRONT);
      gl.enable(gl.CULL_FACE);
      gl.bindVertexArray(atmosphereMesh.vao);
      gl.drawElements(gl.TRIANGLES, atmosphereMesh.indexCount, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.BLEND);
    }

    gl.bindVertexArray(null);
  };

  /** 尺寸变化 */
  const resize = (width: number, height: number, pixelRatio: number): void => {
    cssWidth = Math.max(1, width);
    cssHeight = Math.max(1, height);
    ratio = pixelRatio;
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
  };

  /**
   * 屏幕坐标 → 经纬度：把屏幕射线与球面求交。
   * @param cssX 相对画布的 x（css 像素）
   * @param cssY 相对画布的 y（css 像素）
   * @param camera 当前相机
   * @returns 命中点的经纬度；未命中返回 null
   */
  const pick = (cssX: number, cssY: number, camera: GlobeCamera): { lon: number; lat: number } | null => {
    // 构造 NDC
    const ndcX = (cssX / cssWidth) * 2 - 1;
    const ndcY = 1 - (cssY / cssHeight) * 2;

    // 直接由相机参数构造射线（与视图矩阵等价）
    const cosPitch = Math.cos(camera.pitch);
    const eye = {
      x: camera.distance * cosPitch * Math.sin(camera.yaw),
      y: camera.distance * Math.sin(camera.pitch),
      z: camera.distance * cosPitch * Math.cos(camera.yaw),
    };
    const forward = normalize({ x: -eye.x, y: -eye.y, z: -eye.z });
    const right = normalize(cross(forward, { x: 0, y: 1, z: 0 }));
    const up = cross(right, forward);
    const tanHalf = Math.tan(((45 * Math.PI) / 180) / 2);

    const direction = normalize({
      x: forward.x + right.x * ndcX * tanHalf * (cssWidth / cssHeight) + up.x * ndcY * tanHalf,
      y: forward.y + right.y * ndcX * tanHalf * (cssWidth / cssHeight) + up.y * ndcY * tanHalf,
      z: forward.z + right.z * ndcX * tanHalf * (cssWidth / cssHeight) + up.z * ndcY * tanHalf,
    });

    // 球心在原点、半径 1：解 |eye + t·dir|² = 1
    const b = 2 * (eye.x * direction.x + eye.y * direction.y + eye.z * direction.z);
    const c = eye.x * eye.x + eye.y * eye.y + eye.z * eye.z - 1;
    const discriminant = b * b - 4 * c;
    if (discriminant < 0) {
      return null;
    }
    const t = (-b - Math.sqrt(discriminant)) / 2;
    if (t < 0) {
      return null;
    }
    const hitPoint = { x: eye.x + direction.x * t, y: eye.y + direction.y * t, z: eye.z + direction.z * t };
    const lat = (Math.asin(clamp(hitPoint.y, -1, 1)) * 180) / Math.PI;
    const lon = (Math.atan2(hitPoint.x, hitPoint.z) * 180) / Math.PI;
    return { lon, lat };
  };

  return {
    canvas,
    updateTexture,
    render,
    resize,
    pick,
    pixelSize: () => ({ width: canvas.width, height: canvas.height }),
    dispose: () => {
      gl.deleteProgram(globeProgram);
      gl.deleteProgram(atmosphereProgram);
      gl.deleteProgram(starfieldProgram);
      gl.deleteTexture(texture);
      gl.deleteVertexArray(sphere.vao);
      gl.deleteBuffer(sphere.positionBuffer);
      gl.deleteBuffer(sphere.uvBuffer);
      gl.deleteBuffer(sphere.indexBuffer);
      gl.deleteVertexArray(atmosphereMesh.vao);
      gl.deleteVertexArray(quad);
    },
  };
}

/**
 * 单位模型矩阵（球心在原点、半径为 1）。
 * @returns 单位矩阵
 */
function mat4IdentityModel(): Mat4 {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/**
 * 均匀缩放矩阵（大气外壳用）。
 * @param scale 缩放倍数
 * @returns 缩放矩阵
 */
function mat4Scale(scale: number): Mat4 {
  const m = new Float32Array(16);
  m[0] = scale;
  m[5] = scale;
  m[10] = scale;
  m[15] = 1;
  return m;
}

/**
 * 太阳方向单位向量（由直射点经纬度得到）。
 * @param sun 直射点
 * @returns 方向向量
 */
function sunDirection(sun: SunPosition): Float32Array {
  const unit = lonLatToPosition(sun.lon, sun.lat, 1);
  return new Float32Array([unit.x, unit.y, unit.z]);
}

/**
 * 颜色：`#rrggbb` → [0,1] 浮点三元组。
 * @param hex 颜色文本
 * @returns 浮点颜色
 */
function parseFloatColor(hex: string): Float32Array {
  const [r, g, b] = parseHexColor(hex);
  return new Float32Array([r / 255, g / 255, b / 255]);
}

/**
 * 颜色：`#rrggbb` → [r,g,b]。
 * @param hex 颜色文本
 * @returns 0~255 通道值
 */
function parseHexColor(hex: string): [number, number, number] {
  const text = hex.trim().replace(/^#/, "");
  if (text.length === 3) {
    return [
      Number.parseInt(`${text[0]}${text[0]}`, 16) || 0,
      Number.parseInt(`${text[1]}${text[1]}`, 16) || 0,
      Number.parseInt(`${text[2]}${text[2]}`, 16) || 0,
    ];
  }
  if (text.length >= 6) {
    return [
      Number.parseInt(text.slice(0, 2), 16) || 0,
      Number.parseInt(text.slice(2, 4), 16) || 0,
      Number.parseInt(text.slice(4, 6), 16) || 0,
    ];
  }
  return [0, 0, 0];
}

/**
 * 向量归一化。
 * @param v 向量
 * @returns 单位向量
 */
function normalize(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const length = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

/**
 * 向量叉积。
 * @param a 向量 A
 * @param b 向量 B
 * @returns A × B
 */
function cross(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** 数值区间限制 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
/**
 * 编译着色器并链接程序；失败时把编译 / 链接日志打到控制台。
 *
 * 这一步的日志很重要：界面上失败只会提示「不支持 WebGL2」，
 * 但那可能是环境问题，也可能是着色器编译失败，两者的处理方式完全不同。
 *
 * @param gl WebGL2 上下文
 * @param vertexSource 顶点着色器源码
 * @param fragmentSource 片元着色器源码
 * @returns 程序对象；编译或链接失败返回 null
 */
function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram | null {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource, "顶点");
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, "片元");
  if (!vertex || !fragment) {
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    return null;
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("[worldmap/3d] 程序链接失败：", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

/**
 * 编译单个着色器；失败时打印具体原因（含行号）。
 * @param gl WebGL2 上下文
 * @param type 着色器类型
 * @param source 源码
 * @param label 日志标签（顶点 / 片元）
 * @returns 着色器对象；失败返回 null
 */
function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  label: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) {
    return null;
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(`[worldmap/3d] ${label}着色器编译失败：`, gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/**
 * 球体网格：含位置、UV 与索引。
 * @param gl WebGL2 上下文
 * @param segments 经度分段数
 * @param rings 纬度分段数
 * @returns 网格句柄；创建失败返回 null
 */
function createSphereMesh(
  gl: WebGL2RenderingContext,
  segments: number,
  rings: number,
): {
  vao: WebGLVertexArrayObject;
  positionBuffer: WebGLBuffer;
  uvBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  indexCount: number;
} | null {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let ring = 0; ring <= rings; ring += 1) {
    // v 从 0（北极）到 1（南极），与贴图的 v 轴一致
    const v = ring / rings;
    const lat = 90 - v * 180;
    for (let segment = 0; segment <= segments; segment += 1) {
      const u = segment / segments;
      const lon = -180 + u * 360;
      const position = lonLatToPosition(lon, lat, 1);
      positions.push(position.x, position.y, position.z);
      uvs.push(u, v);
    }
  }

  for (let ring = 0; ring < rings; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const a = ring * (segments + 1) + segment;
      const b = a + segments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  const vao = gl.createVertexArray();
  const positionBuffer = gl.createBuffer();
  const uvBuffer = gl.createBuffer();
  const indexBuffer = gl.createBuffer();
  if (!vao || !positionBuffer || !uvBuffer || !indexBuffer) {
    return null;
  }

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uvs), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
  gl.bindVertexArray(null);

  return { vao, positionBuffer, uvBuffer, indexBuffer, indexCount: indices.length };
}

/** 全屏四边形（星空用） */
function createFullscreenQuad(gl: WebGL2RenderingContext): WebGLVertexArrayObject | null {
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  if (!vao || !buffer) {
    return null;
  }
  const vertices = new Float32Array([-1, -1, 3, -1, -1, 3]);
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}
