/**
 * 3D 地球仪着色器源码。
 *
 * 分三个程序，各司其职（方案 §14.3）：
 * 1. **球面**：贴白板纹理 + 经纬网 + 昼夜明暗（黄昏过渡）
 * 2. **大气辉光**：菲涅尔效应的外壳（边缘亮、正对圆心透明）
 * 3. **星空**：全屏程序化星点（哈希噪声，不用图片资源，因此无需任何贴图素材）
 *
 * 用 GLSL ES 3.00（WebGL2）。所有效果都能单独关闭，性能档位即组合这些开关。
 */

/** 球面顶点着色器 */
export const GLOBE_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec2 aUv;

uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;

out vec2 vUv;
out vec3 vNormal;
out vec3 vWorldPosition;

void main() {
  vUv = aUv;
  vNormal = normalize(mat3(uModel) * aPosition);
  vec4 world = uModel * vec4(aPosition, 1.0);
  vWorldPosition = world.xyz;
  gl_Position = uProjection * uView * world;
}
`;

/**
 * 球面片元着色器：纹理 + 经纬网 + 昼夜。
 *
 * 经纬网用 uv 的小数部分画细线，这样不需要额外的几何体。
 */
export const GLOBE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vUv;
in vec3 vNormal;
in vec3 vWorldPosition;

uniform sampler2D uTexture;
uniform vec3 uCameraPosition;
uniform vec3 uSunDirection;
uniform vec3 uNightColor;
uniform float uGraticule;     // 0 = 关闭，1 = 显示
uniform float uDayNight;      // 0 = 关闭（均匀光照），1 = 开启
uniform float uTextureFlipV;  // 部分环境纹理上下相反，用开关兜住

out vec4 outColor;

/** 经纬网：每 30° 一条淡线 */
float graticuleMask(vec2 uv) {
  // 经度 360° 分 12 段（每 30°），纬度 180° 分 6 段
  vec2 grid = vec2(uv.x * 12.0, uv.y * 6.0);
  vec2 fraction = abs(fract(grid) - 0.5);
  vec2 width = fwidth(grid) * 1.2;
  vec2 line = smoothstep(0.5 - width, 0.5, fraction);
  return clamp(max(line.x, line.y), 0.0, 1.0);
}

void main() {
  vec2 uv = uTextureFlipV > 0.5 ? vec2(vUv.x, 1.0 - vUv.y) : vUv;
  vec4 texel = texture(uTexture, uv);

  // 透明区域给一个深水底色，避免地球出现「破洞」
  vec3 base = texel.a > 0.01 ? texel.rgb : vec3(0.06, 0.10, 0.14);

  // 昼夜：太阳方向的朗伯余弦，用 smoothstep 得到柔和黄昏带
  float lighting = 1.0;
  float night = 0.0;
  if (uDayNight > 0.5) {
    float lambert = dot(normalize(vNormal), normalize(uSunDirection));
    float dayFactor = smoothstep(-0.10, 0.10, lambert);
    lighting = mix(1.0, 0.28, 1.0 - dayFactor);
    night = 1.0 - dayFactor;
  }

  vec3 color = base * lighting;
  // 夜面偏冷蓝，做出「被夜色覆盖」的感觉
  color = mix(color, uNightColor, night * 0.55);

  if (uGraticule > 0.5) {
    float line = graticuleMask(uv);
    color = mix(color, vec3(0.91, 0.87, 0.82), line * 0.35);
  }

  outColor = vec4(color, 1.0);
}
`;

/** 大气辉光顶点着色器（球体外壳） */
export const ATMOSPHERE_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;

uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;

out vec3 vNormal;
out vec3 vWorldPosition;

void main() {
  vNormal = normalize(mat3(uModel) * aPosition);
  vec4 world = uModel * vec4(aPosition, 1.0);
  vWorldPosition = world.xyz;
  gl_Position = uProjection * uView * world;
}
`;

/**
 * 大气辉光片元着色器：菲涅尔效应。
 *
 * 视线越接近切线方向穿过的「大气」越厚 → 边缘亮、正对圆心处透明。
 * 用背面渲染（`cull front`）让外壳只在球体之外可见。
 */
export const ATMOSPHERE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec3 vNormal;
in vec3 vWorldPosition;

uniform vec3 uCameraPosition;
uniform vec3 uAtmosphereColor;
uniform float uIntensity;
uniform float uPower;

out vec4 outColor;

void main() {
  vec3 viewDirection = normalize(uCameraPosition - vWorldPosition);
  float fresnel = pow(1.0 - abs(dot(normalize(vNormal), viewDirection)), uPower);
  float alpha = clamp(fresnel * uIntensity, 0.0, 1.0);
  outColor = vec4(uAtmosphereColor, alpha);
}
`;

/** 星空顶点着色器（全屏三角形/四边形） */
export const STARFIELD_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aPosition;
out vec2 vUv;

void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/**
 * 星空片元着色器：程序化撒星。
 *
 * 用哈希噪声按格点生成星点，同一格点永远得到同一颗星，
 * 因此背景稳定不闪烁（也不占任何图片资源；方案 §14.3.2）。
 */
export const STARFIELD_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vUv;

uniform vec2 uResolution;
uniform float uDensity;
uniform vec3 uSkyColor;
uniform float uBrightness;

out vec4 outColor;

/** 二维哈希，返回 [0,1) 的伪随机数 */
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 uv = vUv * uResolution / 120.0 * uDensity;
  vec2 cell = floor(uv);
  vec2 local = fract(uv);

  float total = 0.0;
  // 检查 3×3 邻域，避免星点被格子边界裁掉
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 neighbor = vec2(float(x), float(y));
      vec2 point = neighbor + vec2(hash(cell + neighbor), hash(cell + neighbor + 17.0));
      float distance = length(local - point);
      float brightness = hash(cell + neighbor + 71.0);
      total += smoothstep(0.06, 0.0, distance) * brightness;
    }
  }

  vec3 color = uSkyColor + vec3(total * uBrightness);
  outColor = vec4(color, 1.0);
}
`;
