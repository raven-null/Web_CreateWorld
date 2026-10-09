import { useEffect, useRef } from "react";

/**
 * 交互动画角色（登录页左侧）。
 *
 * 设计来源：参考 `guohaolian/animatedlogin` 的交互设计（四角色跟随鼠标、
 * 输入密码时礼貌转头回避、登录失败时摇头）；**配色与形状按本项目视觉体系统一**
 * ——深色墨底 + 金 / 陶土 / 墨 / 苔四色，不照搬参考项目的浅紫配色。
 *
 * 实现要点：
 * - 瞳孔跟随鼠标与状态机驱动的位置计算放在 `requestAnimationFrame` 里，
 *   直接写 DOM 样式，避免每帧触发 React 重渲染（这是流畅度的关键）
 * - 角色的「表情状态」（眨眼、沮丧、摇头）用 CSS 类切换，交给 CSS 过渡与关键帧
 */

/** 角色配色（按项目视觉体系：深色墨底上的低饱和古典色） */
const CHARACTER_COLORS = {
  gold: "#8a6d3b",
  ink: "#2a2622",
  clay: "#a4705a",
  moss: "#6f7f5a",
} as const;

/** 眼睛跟随的可视范围与倾斜上限（沿用参考设计的取值） */
const FACE_RANGE_X = 15;
const FACE_RANGE_Y = 10;
const BODY_SKEW_MAX = 6;

/** 角色属性 */
export interface AnimatedCharactersProps {
  /** 密码框聚焦且密码处于隐藏状态 → 角色转头回避 */
  passwordHidden: boolean;
  /** 密码可见 → 角色看向远处（金色角色会偷偷回看） */
  passwordVisible: boolean;
  /** 身份（用户名）框聚焦 → 角色互相对视 */
  identityFocused: boolean;
  /** 登录失败 → 沮丧表情 + 摇头 */
  loginFailed: boolean;
}

/** 一个角色的眼睛元素集合 */
interface CharacterRefs {
  body: HTMLDivElement | null;
  eyes: HTMLDivElement | null;
  pupils: (HTMLDivElement | null)[];
  mouth: HTMLDivElement | null;
}

/**
 * 交互动画角色组件。
 * @param props 见 `AnimatedCharactersProps`
 * @returns 角色场景节点
 */
export default function AnimatedCharacters(props: AnimatedCharactersProps) {
  const { passwordHidden, passwordVisible, identityFocused, loginFailed } = props;

  // 四个角色各自一组引用（金色 / 墨色 / 陶土 / 苔色）
  const goldRefs = useCharacterRefs();
  const inkRefs = useCharacterRefs();
  const clayRefs = useCharacterRefs();
  const mossRefs = useCharacterRefs();

  // 状态放进 ref：rAF 循环读取最新值，但不因状态变化重建循环
  const stateRef = useRef({ passwordHidden, passwordVisible, identityFocused, loginFailed });
  stateRef.current = { passwordHidden, passwordVisible, identityFocused, loginFailed };

  /** 鼠标位置（相对视口），空闲时用 */
  const mouseRef = useRef({ x: 0, y: 0 });
  /**
   * 各角色中心点缓存。
   *
   * 不在每帧里调 `getBoundingClientRect()`：逐帧读取布局属性会强制浏览器重排，
   * 是动画循环里的典型性能陷阱。改为首次挂载 + resize / scroll 时测量一次。
   */
  const centersRef = useRef<{ refs: CharacterRefSet; x: number; y: number }[]>([]);

  /** 测量角色中心点（挂载、缩放、滚动时各一次） */
  useEffect(() => {
    const measure = (): void => {
      centersRef.current = [goldRefs, inkRefs, clayRefs, mossRefs].map((refs) => {
        const rect = refs.body?.getBoundingClientRect();
        return {
          refs,
          x: rect ? rect.left + rect.width / 2 : 0,
          y: rect ? rect.top + rect.height / 2 : 0,
        };
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, { passive: true });
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure);
    };
  }, [goldRefs, inkRefs, clayRefs, mossRefs]);

  /** 鼠标移动只记录位置，不做任何测量 */
  useEffect(() => {
    const onMouseMove = (event: MouseEvent): void => {
      mouseRef.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("mousemove", onMouseMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMouseMove);
  }, []);

  /** 主循环：每帧计算眼睛朝向与身体倾斜 */
  useEffect(() => {
    let frame = 0;
    const tick = (): void => {
      frame = window.requestAnimationFrame(tick);
      const { passwordHidden: hidden, passwordVisible: visible, identityFocused: focused } =
        stateRef.current;
      const mouse = mouseRef.current;

      // 状态优先级：密码隐藏 > 密码可见 > 身份输入聚焦 > 空闲跟随
      let targetPupil = { x: 0, y: 0 };
      let targetFace = { x: 0, y: 0 };
      let skew = 0;

      if (hidden) {
        // 礼貌地转头回避：看向左上，身体侧转
        targetFace = { x: -12, y: -8 };
        targetPupil = { x: -5, y: -5 };
        skew = -10;
      } else if (visible) {
        // 密码已显示，不必回避：看向左侧（金色角色另有偷看逻辑）
        targetFace = { x: -10, y: 0 };
        targetPupil = { x: -4, y: -4 };
        skew = 0;
      } else if (focused) {
        // 输入身份信息：角色互相看着对方（金色看右下、墨色看左上）
        targetFace = { x: 8, y: 4 };
        targetPupil = { x: 4, y: 3 };
        skew = -6;
      } else {
        // 空闲：瞳孔跟随鼠标，身体向鼠标方向微微倾斜
        for (const entry of centersRef.current) {
          const body = entry.refs.body;
          if (!body) {
            continue;
          }
          const offsetX = mouse.x - entry.x;
          const offsetY = mouse.y - entry.y;
          const faceX = clamp(offsetX / 20, -FACE_RANGE_X, FACE_RANGE_X);
          const faceY = clamp(offsetY / 30, -FACE_RANGE_Y, FACE_RANGE_Y);
          body.style.setProperty("--face-x", `${faceX}px`);
          body.style.setProperty("--face-y", `${faceY}px`);
          body.style.setProperty("--skew", `${clamp(-offsetX / 120, -BODY_SKEW_MAX, BODY_SKEW_MAX)}deg`);
          // 空闲时瞳孔跟随鼠标（限制在眼球内）
          applyPupil(entry.refs.pupils, offsetX / 40, offsetY / 40, 4);
        }
        return;
      }

      for (const refs of [goldRefs, inkRefs, clayRefs, mossRefs]) {
        const body = refs.body;
        if (!body) {
          continue;
        }
        body.style.setProperty("--face-x", `${targetFace.x}px`);
        body.style.setProperty("--face-y", `${targetFace.y}px`);
        body.style.setProperty("--skew", `${skew}deg`);
        applyPupil(refs.pupils, targetPupil.x, targetPupil.y, 5);
      }
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [goldRefs, inkRefs, clayRefs, mossRefs]);

  /** 金色角色的随机眨眼（参考设计：3~7 秒随机间隔） */
  useBlink(goldRefs.eyes, 3000, 7000);
  useBlink(inkRefs.eyes, 3000, 7000);

  /** 密码可见时，金色角色偶尔「偷看」 */
  useEffect(() => {
    if (!passwordVisible) {
      return;
    }
    let timer = 0;
    const peek = (): void => {
      const body = goldRefs.body;
      if (body) {
        body.classList.add("wme-peeking");
        window.setTimeout(() => body.classList.remove("wme-peeking"), 800);
      }
      timer = window.setTimeout(peek, 2000 + Math.random() * 3000);
    };
    timer = window.setTimeout(peek, 1500);
    return () => window.clearTimeout(timer);
  }, [passwordVisible, goldRefs]);

  return (
    <div className="wme-characters" aria-hidden="true">
      <div className="wme-characters-stage">
        {/* 金色：最高最靠后 */}
        <div
          className="wme-char wme-char-gold"
          ref={(node) => {
            goldRefs.body = node;
          }}
          style={{ background: CHARACTER_COLORS.gold, ["--w" as string]: "170px", ["--h" as string]: "370px" }}
        >
          <div className="wme-eyes" ref={(node) => { goldRefs.eyes = node; }}>
            <div className="wme-eye">
              <div className="wme-pupil" ref={(node) => { goldRefs.pupils[0] = node; }} />
            </div>
            <div className="wme-eye">
              <div className="wme-pupil" ref={(node) => { goldRefs.pupils[1] = node; }} />
            </div>
          </div>
        </div>

        {/* 墨色：稍矮，眼睛为白底瞳孔 */}
        <div
          className="wme-char wme-char-ink"
          ref={(node) => {
            inkRefs.body = node;
          }}
          style={{ background: CHARACTER_COLORS.ink, ["--w" as string]: "115px", ["--h" as string]: "290px" }}
        >
          <div className="wme-eyes" ref={(node) => { inkRefs.eyes = node; }}>
            <div className="wme-eye">
              <div className="wme-pupil" ref={(node) => { inkRefs.pupils[0] = node; }} />
            </div>
            <div className="wme-eye">
              <div className="wme-pupil" ref={(node) => { inkRefs.pupils[1] = node; }} />
            </div>
          </div>
        </div>

        {/* 陶土：半圆，裸瞳孔；失败时露出悲伤的嘴 */}
        <div
          className="wme-char wme-char-clay"
          ref={(node) => {
            clayRefs.body = node;
          }}
          style={{ background: CHARACTER_COLORS.clay, ["--w" as string]: "230px", ["--h" as string]: "190px" }}
        >
          <div className="wme-eyes" ref={(node) => { clayRefs.eyes = node; }}>
            <div className="wme-bare-pupil" ref={(node) => { clayRefs.pupils[0] = node; }} />
            <div className="wme-bare-pupil" ref={(node) => { clayRefs.pupils[1] = node; }} />
          </div>
          <div className="wme-mouth-sad" />
        </div>

        {/* 苔色：最小最靠前，带一条嘴线 */}
        <div
          className="wme-char wme-char-moss"
          ref={(node) => {
            mossRefs.body = node;
          }}
          style={{ background: CHARACTER_COLORS.moss, ["--w" as string]: "135px", ["--h" as string]: "215px" }}
        >
          <div className="wme-eyes" ref={(node) => { mossRefs.eyes = node; }}>
            <div className="wme-bare-pupil" ref={(node) => { mossRefs.pupils[0] = node; }} />
            <div className="wme-bare-pupil" ref={(node) => { mossRefs.pupils[1] = node; }} />
          </div>
          <div className="wme-mouth-line" />
        </div>
      </div>
    </div>
  );
}

/** 三个引用（身体 / 眼睛容器 / 瞳孔数组） */
interface CharacterRefSet {
  body: HTMLDivElement | null;
  eyes: HTMLDivElement | null;
  pupils: (HTMLDivElement | null)[];
}

/**
 * 生成一组角色引用。
 *
 * 用 useRef 惰性初始化：rAF 循环把这些引用当作稳定依赖，
 * 若每次都新建对象会导致循环反复重建（且不能在 render 里写 ref.current）。
 * @returns 引用集合（每个角色两只眼睛，因此瞳孔数组长度为 2）
 */
function useCharacterRefs(): CharacterRefSet {
  const ref = useRef<CharacterRefSet | null>(null);
  if (ref.current === null) {
    ref.current = {
      body: null,
      eyes: null,
      pupils: new Array<HTMLDivElement | null>(2).fill(null),
    };
  }
  return ref.current;
}

/**
 * 设置瞳孔偏移（限制在眼球范围内）。
 * @param pupils 瞳孔元素
 * @param dx 期望横向偏移
 * @param dy 期望纵向偏移
 * @param max 最大偏移
 */
function applyPupil(pupils: (HTMLDivElement | null)[], dx: number, dy: number, max: number): void {
  const distance = Math.hypot(dx, dy);
  const scale = distance > max ? max / distance : 1;
  const x = dx * scale;
  const y = dy * scale;
  for (const pupil of pupils) {
    if (!pupil) {
      continue;
    }
    pupil.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
  }
}

/**
 * 随机眨眼。
 * @param eyes 眼睛容器（加类触发 CSS 动画）
 * @param minMs 最小间隔
 * @param maxMs 最大间隔
 */
function useBlink(eyes: HTMLDivElement | null, minMs: number, maxMs: number): void {
  useEffect(() => {
    if (!eyes) {
      return;
    }
    let timer = 0;
    const schedule = (): void => {
      const delay = minMs + Math.random() * (maxMs - minMs);
      timer = window.setTimeout(() => {
        eyes.classList.add("wme-blinking");
        window.setTimeout(() => eyes.classList.remove("wme-blinking"), 150);
        schedule();
      }, delay);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [eyes, minMs, maxMs]);
}

/**
 * 数值区间限制。
 * @param value 输入
 * @param min 下限
 * @param max 上限
 * @returns 限制后的值
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
