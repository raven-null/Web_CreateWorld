/**
 * 在白板里画一张世界地图。
 *
 * 为什么要有这个脚本：
 * - 手动涂满 2048×1024 的白板不现实，而一张**有大陆、山脉、气候带**的地图
 *   是检验编辑器（比例尺、图层、3D 贴图）最好的素材
 * - 生成算法全在这里，改几个常量就能换一张世界，不必重新涂一遍
 *
 * 用法（在生产或本地服务上跑）：
 * ```
 * node scripts/draw-world.mjs --world <世界ID> --name "大陆与海洋" \
 *   [--width 2048] [--seed 20261009] [--base https://ravennull.monster] \
 *   [--user 用户名] [--password 密码] [--dry-run] [--out preview.png]
 * ```
 *
 * 用户名 / 密码也可以走环境变量 `CW_USER` / `CW_PASSWORD`（避免留在命令历史里）。
 * `--dry-run` 只在本机生成并导出 PNG 预览，不连服务器。
 */
import { writeFileSync } from "node:fs";
import { deflateSync, gzipSync } from "node:zlib";

/**
 * cwt1 固定头长度（4B 魔数 + 2B 宽 + 2B 高 + 1B 压缩标识）。
 *
 * 这里不 import `@worldmap/core`：脚本是纯 Node 脚本（`.mjs`），
 * 直接引 `.ts` 源文件会让运行方式受限。为保持一致，
 * `packages/map-core/src/__tests__/` 里有一条测试核对这个常量。
 */
const CWT1_HEADER_BYTES = 9;

// —— 调色板（必须与服务端 DEFAULT_TERRAIN_PALETTE 的索引一致）——
const INDEX = {
  transparent: 0,
  ocean: 1,
  shallow: 2,
  grass: 3,
  forest: 4,
  desert: 5,
  mountain: 6,
  snow: 7,
};

/** 调色板颜色（预览图用；与 packages/map-core 的默认调色板一致） */
const PALETTE_RGB = {
  0: [0, 0, 0],
  1: [0x1d, 0x3a, 0x4e],
  2: [0x2f, 0x5a, 0x72],
  3: [0x5d, 0x7a, 0x4a],
  4: [0x3f, 0x5c, 0x3a],
  5: [0xc2, 0xa8, 0x78],
  6: [0x7b, 0x6a, 0x58],
  7: [0xd8, 0xdf, 0xe3],
  // 仅调试用（--debug-rivers）：让河网用醒目的红色显示，一眼看出范围
  8: [0xff, 0x00, 0x66],
};

// —— 地形参数（想换一张世界，先动这里）——

/** 大陆：中心经度 / 纬度 / 经向半径（度）/ 纬向半径（度）/ 高度权重 */
const CONTINENTS = [
  { name: "西大陆", lon: -96, lat: 18, rLon: 52, rLat: 38, weight: 1.0 },
  { name: "南大陆", lon: -56, lat: -44, rLon: 31, rLat: 24, weight: 0.94 },
  { name: "东大陆", lon: 76, lat: 28, rLon: 55, rLat: 33, weight: 1.0 },
  { name: "北大陆", lon: 26, lat: 64, rLon: 42, rLat: 24, weight: 0.86 },
  { name: "南方岛", lon: 148, lat: -48, rLon: 17, rLat: 17, weight: 0.72 },
  { name: "西岛", lon: -22, lat: 36, rLon: 11, rLat: 12, weight: 0.62 },
  { name: "北冰岛", lon: 106, lat: 78, rLon: 26, rLat: 11, weight: 0.6 },
];

/**
 * 山脊：每条是一串 [经度, 纬度] 控制点，高度沿脊线最强、向两侧衰减。
 * 用样条平滑，避免出现折线状的「假山」。
 */
const RIDGES = [
  [
    [-128, 44],
    [-104, 40],
    [-86, 30],
    [-70, 18],
  ],
  [
    [-118, -20],
    [-96, -22],
    [-80, -34],
  ],
  [
    [30, 44],
    [56, 42],
    [80, 32],
    [104, 24],
  ],
  [
    [62, 46],
    [66, 20],
    [60, -2],
  ],
  [
    [-70, -30],
    [-56, -46],
    [-50, -58],
  ],
  [
    [140, -46],
    [152, -52],
  ],
];

/**
 * 海洋与陆地的分界高度。
 *
 * 用 `let`：每次生成都会按目标陆地占比把它校准到高度场的目标分位数，
 * 这样「想要多少陆地」由参数决定，而不是靠反复试阈值。
 */
let SEA_LEVEL = 0.42;

// —— 运行参数：解析命令行 ——

/**
 * 解析命令行参数。
 * @returns 选项对象
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    base: "https://ravennull.monster",
    width: 2048,
    name: "大陆与海洋",
    seed: 20261009,
    user: process.env.CW_USER ?? "",
    password: process.env.CW_PASSWORD ?? "",
    world: "",
    land: 0.32,
    seaLevel: Number.NaN,
    debugRivers: false,
    dryRun: false,
    out: "",
  };
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    const value = args[i + 1];
    switch (key) {
      case "--base":
        options.base = value;
        i += 1;
        break;
      case "--width":
        options.width = Number(value);
        i += 1;
        break;
      case "--name":
        options.name = value;
        i += 1;
        break;
      case "--seed":
        options.seed = Number(value);
        i += 1;
        break;
      case "--user":
        options.user = value;
        i += 1;
        break;
      case "--password":
        options.password = value;
        i += 1;
        break;
      case "--world":
        options.world = value;
        i += 1;
        break;
      case "--out":
        options.out = value;
        i += 1;
        break;
      case "--land":
        options.land = Number(value);
        i += 1;
        break;
      case "--sea-level":
        options.seaLevel = Number(value);
        i += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--debug-rivers":
        options.debugRivers = true;
        break;
      default:
        break;
    }
  }
  return options;
}

// —— 噪声：整张图必须左右无缝，所以经度方向按「圆周」采样 ——

/**
 * 生成一个确定性伪随机数发生器（同一 seed 永远得到同一张世界）。
 * @param seed 随机种子
 * @returns 返回 [0,1) 随机数的函数
 */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * 创建值噪声函数（在二维整数格点上取随机值，双线性 + 平滑插值）。
 * @param random 随机源
 * @returns 采样函数：给定连续坐标返回 [0,1]
 */
function createNoise2D(random) {
  const size = 256;
  const mask = size - 1;
  const table = new Float32Array(size * size);
  for (let i = 0; i < table.length; i += 1) {
    table[i] = random();
  }

  /**
   * 取格点值（坐标按 size 环绕，保证可无缝重复）。
   * @param x 整数 x
   * @param y 整数 y
   * @returns [0,1] 的值
   */
  const at = (x, y) => table[((y & mask) << 8) + (x & mask)] ?? 0.5;

  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const tx = x - xi;
    const ty = y - yi;
    // 平滑插值（smoothstep），避免看出格子
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const v00 = at(xi, yi);
    const v10 = at(xi + 1, yi);
    const v01 = at(xi, yi + 1);
    const v11 = at(xi + 1, yi + 1);
    const top = v00 + (v10 - v00) * sx;
    const bottom = v01 + (v11 - v01) * sx;
    return top + (bottom - top) * sy;
  };
}

/**
 * 创建分形噪声（多个倍频叠加，得到有大结构也有细节的纹理）。
 *
 * 采样方式是**球面无缝**的：经度按圆周取值（cos/sin），因此白板左右边界天然连续，
 * 不会在地图正中间露出一条接缝——这是地图生成里最关键的一点。
 *
 * @param noise 基础噪声
 * @param octaves 倍频数
 * @param baseFrequency 第一层频率（圆周上的采样半径）
 * @returns 采样函数 (lon, lat) → [0,1]
 */
function createFbm(noise, octaves, baseFrequency) {
  return (lon, lat) => {
    let total = 0;
    let amplitude = 1;
    let scale = baseFrequency;
    let norm = 0;
    for (let i = 0; i < octaves; i += 1) {
      const angle = (lon / 180) * Math.PI;
      // 经度走圆周、纬度走直线：纬度方向不环绕，避免南北极出现镜像重复
      const x = Math.cos(angle) * scale;
      const y = Math.sin(angle) * scale + lat * (scale / Math.PI);
      total += noise(x, y) * amplitude;
      norm += amplitude;
      amplitude *= 0.5;
      scale *= 2.1;
    }
    return total / norm;
  };
}

/**
 * 把经度差归一到 [-180, 180]（处理白板左右边界相连）。
 * @param delta 原始差值
 * @returns 归一后的差值
 */
function wrapLonDelta(delta) {
  let value = delta % 360;
  if (value > 180) {
    value -= 360;
  }
  if (value < -180) {
    value += 360;
  }
  return value;
}

/**
 * 计算某点相对某个大陆中心的「椭圆距离」（0 = 正中心，1 = 边界）。
 *
 * 两个关键处理：
 * - 经度按最短弧计算，跨 180° 的大陆不会被劈开
 * - 纬向尺度乘 `cos(lat)`：等距圆柱投影下高纬度被横向拉长，
 *   不补偿的话高纬大陆会在像素上被压扁成细条
 *
 * @param lon 经度
 * @param lat 纬度
 * @param continent 大陆定义
 * @returns 归一化距离
 */
function continentDistance(lon, lat, continent) {
  const dLon = wrapLonDelta(lon - continent.lon) / continent.rLon;
  const dLat = (lat - continent.lat) / (continent.rLat * Math.max(0.25, Math.cos((lat * Math.PI) / 180)));
  return Math.sqrt(dLon * dLon + dLat * dLat);
}

/**
 * 在两点之间做 Catmull-Rom 样条插值（让山脊平滑）。
 * @param points 控制点数组 [[lon, lat], ...]
 * @param samplesPerSegment 每段采样点数
 * @returns 加密后的点列
 */
function smoothRidge(points, samplesPerSegment) {
  const out = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    for (let s = 0; s < samplesPerSegment; s += 1) {
      const t = s / samplesPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const lon =
        0.5 *
        (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const lat =
        0.5 *
        (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([lon, lat]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * 点到线段的距离（经度方向按最短弧处理）。
 * @param lon 点经度
 * @param lat 点纬度
 * @param a 线段起点 [lon, lat]
 * @param b 线段终点 [lon, lat]
 * @returns 距离（单位：度，纬度加权）
 */
function distanceToSegment(lon, lat, a, b) {
  const abLon = wrapLonDelta(b[0] - a[0]);
  const abLat = b[1] - a[1];
  const apLon = wrapLonDelta(lon - a[0]);
  const apLat = lat - a[1];
  const lengthSq = abLon * abLon + abLat * abLat;
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, (apLon * abLon + apLat * abLat) / lengthSq)) : 0;
  const dx = apLon - abLon * t;
  const dy = apLat - abLat * t;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 按目标陆地占比校准海平面。
 *
 * 取高度场的目标分位数作为海平面：想要 32% 陆地 → 取 68% 分位。
 * 采样估算即可（200 万像素没必要全排序）。
 *
 * @param heights 高度场
 * @param landRatio 目标陆地占比（0~1）
 * @returns 海平面高度
 */
function calibrateSeaLevel(heights, landRatio) {
  const step = 7;
  const samples = [];
  for (let i = 0; i < heights.length; i += step) {
    samples.push(heights[i] ?? 0);
  }
  samples.sort((a, b) => a - b);
  const quantile = Math.min(0.95, Math.max(0.05, 1 - landRatio));
  const index = Math.min(samples.length - 1, Math.floor(samples.length * quantile));
  return samples[index] ?? 0.42;
}

/**
 * 取水下高度的分位数作为「深海 / 浅海」的分界线。
 *
 * 为什么不能用固定窗口（如 `seaLevel - 0.075`）：高度场校准后水下的高度跨度很小，
 * 固定窗口会把 43% 的海洋都算成浅海，整片海变成一片浅色。
 * 按分位数定义则浅海恒为水域的一小部分，正好是贴着海岸的一条浅水带。
 *
 * @param heights 高度场
 * @param seaLevel 海平面
 * @param shallowShare 浅海占水域的比例（0~1）
 * @returns 深海与浅海的分界高度
 */
function calibrateShallowLine(heights, seaLevel, shallowShare) {
  const step = 11;
  const samples = [];
  for (let i = 0; i < heights.length; i += step) {
    const value = heights[i] ?? 0;
    if (value < seaLevel) {
      samples.push(value);
    }
  }
  if (samples.length === 0) {
    return seaLevel - 0.01;
  }
  samples.sort((a, b) => a - b);
  // 高度越大越靠近海岸：取 (1 − 浅海占比) 分位数做分界，
  // 于是「比它更浅的那部分」正好是 water 的 shallowShare
  const index = Math.min(samples.length - 1, Math.floor(samples.length * (1 - shallowShare)));
  return samples[index] ?? seaLevel - 0.01;
}

/**
 * 生成地形栅格。
 *
 * 分两个阶段，而不是边算边分类：
 * 1. **先算出整个高度场**（大陆 + 山脊 + 细噪声）
 * 2. 再**按目标陆地占比校准海平面**，最后统一分类
 *
 * 为什么要拆开：之前拿高度原始值与固定阈值比较，陆地占比完全不可控
 * （换个 seed 就从 12% 跳到 40%）。校准之后，「想要 32% 的陆地」是参数说了算，
 * 不必再靠反复试。
 *
 * 分类规则贴近真实气候：赤道湿润、副热带干旱、极地严寒，
 * 因此会自然出现沙漠带、温带森林与雪线——这是「看起来像世界」的关键。
 *
 * @param width 白板宽（像素）
 * @param height 白板高（像素）
 * @param seed 随机种子
 * @param landRatio 目标陆地占比（0~1）
 * @param forcedSeaLevel 手动指定海平面；不给则按目标占比校准
 * @returns 索引栅格（Uint8Array，长度 = width × height）
 */
function generateTerrain(width, height, seed, landRatio, forcedSeaLevel, riverDebugIndex) {
  const random = createRandom(seed);
  const baseNoise = createNoise2D(random);
  const mountainNoise = createNoise2D(random);
  // 大陆轮廓：低频、大结构；海岸细节：高频、小碎边
  const macroFbm = createFbm(baseNoise, 5, 3.6);
  const coastFbm = createFbm(baseNoise, 4, 30);
  const ridgeFbm = createFbm(mountainNoise, 4, 9);
  const moistureFbm = createFbm(mountainNoise, 3, 6);

  // 山脊预加密：避免在像素循环里重复做样条计算
  const ridges = RIDGES.map((points) => smoothRidge(points, 24));
  // 山脉隆起与否需要先有一个「大约的海平面」；这只是启发式，最终以校准值为准
  const seaLevelHint = 0.42;

  const heights = new Float32Array(width * height);

  // —— 阶段 1：高度场 ——
  for (let y = 0; y < height; y += 1) {
    // 像素中心对应的纬度：v = (90 - lat) / 180
    const lat = 90 - ((y + 0.5) / height) * 180;
    const rowOffset = y * width;

    for (let x = 0; x < width; x += 1) {
      const lon = ((x + 0.5) / width) * 360 - 180;

      // ① 大陆场：取所有大陆的最大值（重叠处自然融合）
      let land = 0;
      for (const continent of CONTINENTS) {
        const d = continentDistance(lon, lat, continent);
        if (d >= 1.5) {
          continue;
        }
        // 中心高、边缘低；超出 1 之后快速归零
        const value = continent.weight * Math.max(0, 1 - d * d);
        if (value > land) {
          land = value;
        }
      }

      // ② 用噪声揉碎海岸线：低频决定「这里是不是海」，高频决定「岸线长什么样」
      const macro = (macroFbm(lon, lat) - 0.5) * 2; // [-1,1]
      const coast = (coastFbm(lon, lat) - 0.5) * 2;
      let elevation = land * 1.05 + macro * 0.18 + coast * 0.05;

      // ③ 山脊：沿脊线最强，向两侧衰减
      let ridge = 0;
      for (const points of ridges) {
        for (let i = 0; i < points.length - 1; i += 1) {
          const d = distanceToSegment(lon, lat, points[i], points[i + 1]);
          if (d > 16) {
            continue;
          }
          const strength = Math.max(0, 1 - d / 16);
          const value = strength * strength;
          if (value > ridge) {
            ridge = value;
          }
        }
      }
      // 山脉只在陆地上隆起
      if (ridge > 0 && elevation > seaLevelHint - 0.06) {
        const detail = 0.6 + ridgeFbm(lon, lat) * 0.8;
        elevation += ridge * 0.62 * detail;
      }

      heights[rowOffset + x] = elevation;
    }
  }

  // —— 阶段 2：定海平面，再逐像素分类 ——
  const calibrated = Number.isFinite(forcedSeaLevel)
    ? Number(forcedSeaLevel)
    : calibrateSeaLevel(heights, landRatio);
  SEA_LEVEL = calibrated;
  const shallowLine = calibrateShallowLine(heights, calibrated, 0.08);
  const indices = new Uint8Array(width * height);
  // 调试用的河流颜色可在调色板之外（8 = 预览里显示为红色），方便一眼看出河网范围
  const riverIndex = Number.isFinite(riverDebugIndex) ? riverDebugIndex : INDEX.shallow;

  for (let y = 0; y < height; y += 1) {
    const lat = 90 - ((y + 0.5) / height) * 180;
    const rowOffset = y * width;

    for (let x = 0; x < width; x += 1) {
      const lon = ((x + 0.5) / width) * 360 - 180;
      const elevation = heights[rowOffset + x];

      // ④ 温度：赤道热、两极冷；再把海拔的降温算进去
      const absLat = Math.abs(lat);
      const landAbove = Math.max(0, elevation - SEA_LEVEL);
      const temperature = 1 - absLat / 92 - landAbove * 0.55;

      // ⑤ 分类
      let value;
      if (elevation < shallowLine) {
        value = INDEX.ocean;
      } else if (elevation < SEA_LEVEL) {
        value = INDEX.shallow;
      } else if (temperature < 0.08) {
        // 极地冰盖：阈值收得比较紧（0.08），否则会从 ±60° 起铺满雪白一片，
        // 白板上下各糊一条——真实世界的冰盖只有 1.5% 左右
        value = INDEX.snow;
      } else if (elevation > SEA_LEVEL + 0.45) {
        value = INDEX.mountain;
      } else {
        // 湿度：赤道多雨、副热带（±25° 附近）干旱、温带多雨
        const aridity = Math.max(0, 1 - Math.abs(absLat - 25) / 16); // 1 = 正在副热带
        const wet = (1 - aridity * 0.85) * 0.75;
        const moisture = wet - landAbove * 0.5 + (moistureFbm(lon, lat) - 0.5) * 0.45;
        if (moisture < 0.34 && absLat < 42) {
          value = INDEX.desert;
        } else if (moisture > 0.52) {
          value = INDEX.forest;
        } else {
          value = INDEX.grass;
        }
      }
      indices[rowOffset + x] = value;
    }
  }

  carveRivers(indices, heights, width, height, random, riverIndex);
  return indices;
}

/**
 * 让河流从高地流向海洋，最后印到索引栅格上（河流用浅海色表示）。
 *
 * 河流是「这像不像世界」的关键细节之一：只有大陆和山脉时画面很平，
 * 有了河网之后地形才有脉络。
 *
 * @param indices 索引栅格（就地修改）
 * @param heights 高度场
 * @param width 白板宽
 * @param height 白板高
 * @param random 随机源（决定源头位置）
 * @param riverIndex 河流用的调色板下标（调试时可换成醒目颜色）
 */
function carveRivers(indices, heights, width, height, random, riverIndex = INDEX.shallow) {
  const rivers = 90;
  const maxSteps = 900;
  // 8 邻域：沿最陡下降方向走，走不动了（到达海洋）就停
  const neighbors = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];

  for (let i = 0; i < rivers; i += 1) {
    // 源头：随机找一个海拔较高的陆地像素
    let sx = 0;
    let sy = 0;
    let found = false;
    for (let attempt = 0; attempt < 240 && !found; attempt += 1) {
      const x = Math.floor(random() * width);
      const y = Math.floor(random() * height);
      const elevation = heights[y * width + x] ?? 0;
      if (elevation > SEA_LEVEL + 0.14) {
        sx = x;
        sy = y;
        found = true;
      }
    }
    if (!found) {
      continue;
    }

    let x = sx;
    let y = sy;
    // 已到达的像素（防止两条河在同一条沟里来回打转）
    const visited = new Set();
    for (let step = 0; step < maxSteps; step += 1) {
      const currentElevation = heights[y * width + x] ?? 0;
      if (currentElevation < SEA_LEVEL) {
        break; // 入海
      }
      const key = y * width + x;
      if (visited.has(key)) {
        break; // 绕回来了：就地形成湖泊
      }
      visited.add(key);
      // 河流本身也是水：画成浅海色（覆盖森林 / 雪地）
      indices[key] = riverIndex;

      let bestX = -1;
      let bestY = -1;
      let bestHeight = currentElevation;
      for (const [dx, dy] of neighbors) {
        const nx = (x + dx + width) % width; // 经度环绕
        const ny = y + dy;
        if (ny < 0 || ny >= height) {
          continue;
        }
        const elevation = heights[ny * width + nx] ?? 0;
        if (elevation < bestHeight) {
          bestHeight = elevation;
          bestX = nx;
          bestY = ny;
        }
      }
      if (bestX < 0) {
        break; // 洼地：积水成湖，就地停住
      }
      x = bestX;
      y = bestY;
    }
  }
}

// —— cwt1 编码（与 @worldmap/core 的格式一致：魔数 + 宽高 + 压缩标识 + 负载）——

/**
 * 把一块索引数据编码为 cwt1 字节（gzip 压缩）。
 * @param indices 索引数据
 * @param width 宽
 * @param height 高
 * @returns 编码后的字节
 */
function encodeTile(indices, width, height) {
  const compressed = new Uint8Array(
    gzipSync(Buffer.from(indices.buffer, indices.byteOffset, indices.length), { level: 9 }),
  );
  const useGzip = compressed.length < indices.length;
  const payload = useGzip ? compressed : indices;
  const out = new Uint8Array(CWT1_HEADER_BYTES + payload.length);
  out[0] = 0x43; // C
  out[1] = 0x57; // W
  out[2] = 0x54; // T
  out[3] = 0x31; // 1
  out[4] = width & 0xff;
  out[5] = (width >> 8) & 0xff;
  out[6] = height & 0xff;
  out[7] = (height >> 8) & 0xff;
  out[8] = useGzip ? 1 : 0;
  out.set(payload, CWT1_HEADER_BYTES);
  return out;
}

/**
 * 把全幅索引切成 256×256 的瓦片（空瓦片跳过，与编辑器一致）。
 * @param indices 全幅索引
 * @param width 白板宽
 * @param height 白板高
 * @returns 瓦片数组
 */
function sliceTiles(indices, width, height) {
  const tiles = [];
  const cols = Math.ceil(width / 256);
  const rows = Math.ceil(height / 256);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const tileWidth = Math.min(256, width - col * 256);
      const tileHeight = Math.min(256, height - row * 256);
      const slice = new Uint8Array(tileWidth * tileHeight);
      for (let y = 0; y < tileHeight; y += 1) {
        const sourceStart = (row * 256 + y) * width + col * 256;
        slice.set(indices.subarray(sourceStart, sourceStart + tileWidth), y * tileWidth);
      }
      if (!slice.some((value) => value !== 0)) {
        continue; // 空瓦片不传
      }
      tiles.push({ col, row, data: encodeTile(slice, tileWidth, tileHeight) });
    }
  }
  return tiles;
}

// —— PNG 编码（只为本机预览：没有画布库，手写最小 PNG 写出）——

/**
 * 把索引栅格编码成 PNG（真彩色，不带透明通道）。
 * @param indices 索引栅格
 * @param width 白板宽
 * @param height 白板高
 * @returns PNG 字节
 */
function encodePng(indices, width, height) {
  // 每行前面加一个滤波器字节（0 = 不过滤）
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const rgb = PALETTE_RGB[indices[y * width + x] ?? 0] ?? [0, 0, 0];
      const offset = rowStart + 1 + x * 3;
      raw[offset] = rgb[0];
      raw[offset + 1] = rgb[1];
      raw[offset + 2] = rgb[2];
    }
  }

  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 位深
  header[9] = 2; // 颜色类型：真彩色
  chunks.push(pngChunk("IHDR", header));
  // IDAT 要的是 zlib 流：Node 的 deflateSync 产出的正是 zlib 格式（0x78 0x9c 开头），
  // 直接放进去即可——**不要再手动补 zlib 头与 Adler-32**，那样会把流破坏掉
  chunks.push(pngChunk("IDAT", deflateSync(raw, { level: 6 })));
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

/**
 * 构造一个 PNG 数据块（长度 + 类型 + 数据 + CRC）。
 * @param type 四字符类型
 * @param data 数据
 * @returns 数据块
 */
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])) >>> 0, 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** CRC32 查表（PNG 与 gzip 用的是同一种 CRC） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

/**
 * 计算 CRC32。
 * @param buffer 数据
 * @returns CRC 值
 */
function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = (CRC_TABLE[(c ^ buffer[i]) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// —— 网络：登录 → 建白板 → 上传瓦片 ——

/**
 * 创建一个会带上 cookie 的请求函数（Node 的 fetch 不会自动保持会话）。
 * @param base 站点地址
 * @returns 请求函数
 */
function createClient(base) {
  const cookies = new Map();

  /**
   * 发起请求并记录 / 回传 cookie。
   * @param path 接口路径
   * @param init 请求参数
   * @returns 响应
   */
  const request = async (path, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    if (cookies.size > 0) {
      headers.set("Cookie", [...cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    }
    // better-auth 会校验 Origin / Referer，脚本请求必须带上
    headers.set("Origin", base);
    const response = await fetch(new URL(path, base), { ...init, headers, redirect: "manual" });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const line of setCookie) {
      const [pair] = line.split(";");
      const index = pair.indexOf("=");
      if (index > 0) {
        cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    }
    return response;
  };

  return request;
}

/**
 * 登录并取得会话。
 * @param request 请求函数
 * @param username 用户名
 * @param password 密码
 */
async function login(request, username, password) {
  const response = await request("/api/auth/sign-in/username", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`登录失败（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
  return response.json().catch(() => ({}));
}

/**
 * 列出我的世界（用于让用户挑一个）。
 * @param request 请求函数
 * @returns 世界数组
 */
async function listWorlds(request) {
  const response = await request("/api/worlds/mine", { method: "GET" });
  if (!response.ok) {
    throw new Error(`读取世界列表失败（HTTP ${response.status}）`);
  }
  const body = await response.json();
  // 接口统一包了一层 { ok, data }
  const data = body?.data ?? body;
  return Array.isArray(data) ? data : (data?.worlds ?? []);
}

/**
 * 新建一张白板地图。
 * @param request 请求函数
 * @param worldId 世界 id
 * @param name 地图名称
 * @param width 白板宽度
 * @returns 创建结果
 */
async function createCanvas(request, worldId, name, width) {
  const response = await request(`/api/worlds/${worldId}/maps/canvas`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, width }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`创建白板失败（HTTP ${response.status}）：${JSON.stringify(body).slice(0, 200)}`);
  }
  return body.data ?? body;
}

/**
 * 分批上传瓦片。
 * @param request 请求函数
 * @param mapId 地图 id
 * @param layerId 图层 id
 * @param tiles 瓦片数组
 * @param baseRevision 起始 revision
 */
async function uploadTiles(request, mapId, layerId, tiles, baseRevision) {
  const MAX_PER_REQUEST = 16;
  let revision = baseRevision;
  for (let i = 0; i < tiles.length; i += MAX_PER_REQUEST) {
    const batch = tiles.slice(i, i + MAX_PER_REQUEST);
    const response = await request(`/api/maps/${mapId}/tiles`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        layerId,
        revision,
        tiles: batch.map((tile) => ({ col: tile.col, row: tile.row, data: tile.data.toString("base64") })),
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`上传瓦片失败（HTTP ${response.status}）：${JSON.stringify(body).slice(0, 200)}`);
    }
    revision = (body.data ?? body).revision ?? revision + 1;
    const done = Math.min(i + MAX_PER_REQUEST, tiles.length);
    process.stdout.write(`\r  上传瓦片 ${done}/${tiles.length}  revision=${revision}   `);
  }
  process.stdout.write("\n");
}

// —— 主流程 ——

/**
 * 入口。
 */
async function main() {
  const options = parseArgs();
  const width = Number.isFinite(options.width) && options.width >= 512 ? Math.ceil(options.width / 128) * 128 : 2048;
  const height = width / 2;

  console.log(`生成地形 ${width}×${height}（seed=${options.seed}，目标陆地 ${(options.land * 100).toFixed(0)}%）…`);
  const started = Date.now();
  const indices = generateTerrain(
    width,
    height,
    options.seed,
    options.land,
    options.seaLevel,
    options.debugRivers ? 8 : undefined,
  );
  const counts = new Map();
  for (const value of indices) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const total = width * height;
  console.log(`完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s。地形占比：`);
  for (const [index, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    const name = ["透明", "海洋", "浅海", "草地", "森林", "沙漠", "山地", "雪地"][index] ?? `#${index}`;
    console.log(`  ${name}：${((count / total) * 100).toFixed(1)}%`);
  }

  const tiles = sliceTiles(indices, width, height);
  console.log(`瓦片：${tiles.length} 个，合计 ${(tiles.reduce((sum, tile) => sum + tile.data.length, 0) / 1024).toFixed(0)} KB`);

  if (options.out) {
    writeFileSync(options.out, encodePng(indices, width, height));
    console.log(`预览已写出：${options.out}`);
  }

  if (options.dryRun) {
    console.log("dry-run：不上传。");
    return;
  }

  if (!options.user || !options.password) {
    throw new Error("需要登录凭据：--user/--password 或环境变量 CW_USER / CW_PASSWORD");
  }

  console.log(`登录 ${options.base} …`);
  const request = createClient(options.base);
  await login(request, options.user, options.password);

  let worldId = options.world;
  if (!worldId) {
    const worlds = await listWorlds(request);
    if (worlds.length === 0) {
      throw new Error("这个账号下还没有世界，请先在世界观平台创建一个");
    }
    if (worlds.length > 1) {
      console.log("可写入的世界：");
      worlds.forEach((world, i) => console.log(`  [${i}] ${world.name}  ${world.id}`));
      throw new Error("你名下不止一个世界，请用 --world <世界ID> 指定");
    }
    worldId = worlds[0].id;
    console.log(`使用唯一个世界：${worlds[0].name}`);
  }

  console.log(`创建白板「${options.name}」…`);
  const created = await createCanvas(request, worldId, options.name, width);
  console.log(`  地图 id：${created.id}  地形图层 id：${created.terrainLayerId}`);

  await uploadTiles(request, created.id, created.terrainLayerId, tiles, 0);

  const url = new URL(`/worlds/${worldId}/maps`, options.base).href;
  console.log(`✅ 已画好。打开地图页查看：${url}`);
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`);
  process.exitCode = 1;
});
