/**
 * 3D 渲染用的最小矩阵与向量工具。
 *
 * 为什么自己写而不是引 three.js：本方案的 3D 只需「一个球 + 贴图 + 旋转」，
 * 自己写约 100 行、零依赖；引 three.js 约 150KB 且当前构建没有任何分包配置
 * （见方案 §14.1）。等真正需要光照、后处理时再评估引入。
 *
 * 约定：列主序（与 WebGL 的 uniformMatrix4fv 一致），
 * 即 `m[col * 4 + row]`。
 */

/** 4×4 矩阵（列主序） */
export type Mat4 = Float32Array;

/**
 * 创建单位矩阵。
 * @returns 新的单位矩阵
 */
export function mat4Identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/**
 * 透视投影矩阵。
 * @param fovY 竖直视野（弧度）
 * @param aspect 宽高比
 * @param near 近裁剪面
 * @param far 远裁剪面
 * @returns 投影矩阵
 */
export function mat4Perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const rangeInv = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (near + far) * rangeInv;
  m[11] = -1;
  m[14] = 2 * near * far * rangeInv;
  return m;
}

/**
 * 平移矩阵。
 * @param x x 位移
 * @param y y 位移
 * @param z z 位移
 * @returns 平移矩阵
 */
export function mat4Translate(x: number, y: number, z: number): Mat4 {
  const m = mat4Identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/**
 * 绕 X 轴旋转。
 * @param radians 弧度
 * @returns 旋转矩阵
 */
export function mat4RotateX(radians: number): Mat4 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const m = mat4Identity();
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}

/**
 * 绕 Y 轴旋转。
 * @param radians 弧度
 * @returns 旋转矩阵
 */
export function mat4RotateY(radians: number): Mat4 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const m = mat4Identity();
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

/**
 * 矩阵相乘：out = a × b（先应用 b 再应用 a）。
 * @param a 左矩阵
 * @param b 右矩阵
 * @returns 新的乘积矩阵
 */
export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0);
      }
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * 计算「相机在球外、看向球心」的视图矩阵。
 *
 * 相机位置由 yaw（绕 Y 轴）/ pitch（绕 X 轴）/ distance 决定，
 * 这正是地球仪需要的三个交互参数。
 *
 * @param yaw 水平角（弧度）
 * @param pitch 俯仰角（弧度）
 * @param distance 相机到球心距离（单位为球半径）
 * @returns 视图矩阵
 */
export function mat4ViewFromOrbit(yaw: number, pitch: number, distance: number): Mat4 {
  const cosPitch = Math.cos(pitch);
  const eyeX = distance * cosPitch * Math.sin(yaw);
  const eyeY = distance * Math.sin(pitch);
  const eyeZ = distance * cosPitch * Math.cos(yaw);

  // 目标为原点，因此视图矩阵 = 反向平移 × 反向旋转（用基向量直接构造）
  // 前向 f = normalize(-eye)，右向 r = normalize(cross(f, up))，上向 u = cross(r, f)
  const fx = -eyeX;
  const fy = -eyeY;
  const fz = -eyeZ;
  const fLen = Math.hypot(fx, fy, fz) || 1;
  const f0 = fx / fLen;
  const f1 = fy / fLen;
  const f2 = fz / fLen;

  // 以 (0,1,0) 为上向
  let r0 = f1 * 0 - f2 * 1;
  let r1 = f2 * 0 - f0 * 0;
  let r2 = f0 * 1 - f1 * 0;
  const rLen = Math.hypot(r0, r1, r2) || 1;
  r0 /= rLen;
  r1 /= rLen;
  r2 /= rLen;

  const u0 = r1 * f2 - r2 * f1;
  const u1 = r2 * f0 - r0 * f2;
  const u2 = r0 * f1 - r1 * f0;

  return new Float32Array([
    r0, u0, -f0, 0,
    r1, u1, -f1, 0,
    r2, u2, -f2, 0,
    -(r0 * eyeX + r1 * eyeY + r2 * eyeZ),
    -(u0 * eyeX + u1 * eyeY + u2 * eyeZ),
    f0 * eyeX + f1 * eyeY + f2 * eyeZ,
    1,
  ]);
}

/**
 * 把经纬度换算成球面单位向量（与 map-core 的约定一致：y 向上、z 朝观察者）。
 * @param lon 经度（度）
 * @param lat 纬度（度）
 * @returns 单位向量
 */
export function lonLatToUnit(lon: number, lat: number): { x: number; y: number; z: number } {
  const phi = (lat * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  return { x: cosPhi * Math.sin(lambda), y: Math.sin(phi), z: cosPhi * Math.cos(lambda) };
}

/**
 * 把经纬度换算成球面顶点位置（半径可缩放）。
 * @param lon 经度（度）
 * @param lat 纬度（度）
 * @param radius 半径
 * @returns 三维坐标
 */
export function lonLatToPosition(
  lon: number,
  lat: number,
  radius: number,
): { x: number; y: number; z: number } {
  const unit = lonLatToUnit(lon, lat);
  return { x: unit.x * radius, y: unit.y * radius, z: unit.z * radius };
}
