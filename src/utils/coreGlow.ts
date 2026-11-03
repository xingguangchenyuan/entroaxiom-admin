/**
 * 星核 CoreGlow：缓慢旋转的星盘 + 中心恒星 + 四角星耀斑（登录页左侧装饰）。
 * 逻辑与设计稿 core-glow.html 的 startCoreGlow 保持一致（同样的参数、同样的画法），只做了三处工程化改动：
 *  1. 写成带类型的 TS 模块，不依赖 DOM 之外的任何东西；
 *  2. 画布不可见（尺寸为 0，例如小屏下被 display:none）时暂停绘制；
 *  3. 返回的 stop() 同时取消动画和尺寸监听。
 * 画布是透明的，大小由 CSS 决定；内部按 800×800 的舞台绘制，再按画布实际像素等比缩放。
 */

export interface CoreGlowOptions {
  /** 星盘粒子数（已预渲染，对帧率几乎没有影响） */
  count: number;
  /** 星盘倾斜：1=正面看，越小越扁（侧着看） */
  tilt: number;
  /** 星盘整体旋转角（弧度） */
  tiltAngle: number;
  /** 星盘自转：圈/秒（越小越慢） */
  spin: number;
  /** 旋臂数 */
  arms: number;
  /** 随机种子（固定则每次一致） */
  seed: number;
  /** 四角星耀斑 */
  flare: boolean;
  /** 日冕细光芒 */
  rays: boolean;
}

export const CORE_GLOW_DEFAULTS: CoreGlowOptions = {
  count: 16000,
  tilt: 0.62,
  tiltAngle: -0.38,
  spin: 1 / 260,
  arms: 2,
  seed: 7,
  flare: true,
  rays: true
};

interface Star {
  r: number;
  a: number;
  s: number;
  al: number;
  ci: number;
  tw: number;
  jit: number;
  ja: number;
}

type RGB = readonly [number, number, number];

export function startCoreGlow(
  canvas: HTMLCanvasElement,
  opts: Partial<CoreGlowOptions> = {}
): () => void {
  const O: CoreGlowOptions = { ...CORE_GLOW_DEFAULTS, ...opts };
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d 不可用");
  const S = 800;
  const C = S / 2;
  const TAU = Math.PI * 2;
  const RM = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));

  /* 固定种子随机数 */
  let seed = O.seed | 0;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.73;

  /* ---------- 星盘粒子 ---------- */
  const R_IN = 26;
  const R_OUT = 340;
  const PITCH = 1.55;
  // 暖白 / 金 / 琥珀 / 淡蓝
  const PAL: RGB[] = [
    [255, 241, 210],
    [250, 208, 130],
    [232, 160, 92],
    [196, 212, 255]
  ];
  const P: Star[] = [];
  for (let i = 0; i < O.count; i++) {
    let r: number;
    let a: number;
    const k = rnd();
    if (k < 0.14) {
      // 核球：靠近中心的弥散粒子
      r = R_IN + Math.abs(gauss()) * 44;
      a = rnd() * TAU;
    } else if (k < 0.38) {
      // 弥散盘
      r = R_IN + (R_OUT - R_IN) * Math.pow(rnd(), 1.25);
      a = rnd() * TAU;
    } else {
      // 旋臂
      const u = Math.pow(rnd(), 1.35);
      r = R_IN + (R_OUT - R_IN) * u;
      const arm = ((rnd() * O.arms) | 0) * (TAU / O.arms);
      a = arm + PITCH * Math.log(r / R_IN) + gauss() * (0.16 + 0.2 * u);
    }
    const t = (r - R_IN) / (R_OUT - R_IN);
    // 越往外越偏琥珀；偶尔夹一点淡蓝
    const g = rnd();
    const ci =
      g < 0.1
        ? 3
        : t < 0.25
          ? g < 0.65
            ? 0
            : 1
          : t < 0.6
            ? g < 0.5
              ? 1
              : 2
            : g < 0.55
              ? 2
              : 1;
    // 边缘渐隐，没有硬边界
    const fall = Math.pow(1 - t, 1.15);
    P.push({
      r,
      a,
      s: 0.5 + Math.pow(rnd(), 3) * 2,
      al: Math.min(
        1,
        (0.3 + 0.8 * rnd()) * (0.4 + 0.9 * fall) * (t < 0.08 ? 0.55 + t * 5 : 1)
      ),
      ci,
      tw: rnd() < 0.16 ? rnd() * TAU : -1,
      jit: rnd() * TAU,
      ja: rnd() * 0.05
    });
  }
  const buckets = PAL.map((_, ci) => P.filter(p => p.ci === ci && p.tw < 0));
  const spark = P.filter(p => p.tw >= 0).slice(0, 460);

  /* 旋臂上的柔光：预渲染一张软圆精灵，每帧只做 drawImage，开销很小 */
  const sprite = document.createElement("canvas");
  sprite.width = sprite.height = 64;
  {
    const x = sprite.getContext("2d")!;
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,214,150,1)");
    g.addColorStop(0.3, "rgba(255,196,128,.42)");
    g.addColorStop(0.65, "rgba(250,170,110,.1)");
    g.addColorStop(1, "rgba(240,160,100,0)");
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
  }
  const haze: Array<{ r: number; a: number; sz: number; al: number }> = [];
  for (let j = 0; j < O.arms; j++) {
    for (let i = 0; i < 64; i++) {
      const u = i / 63;
      const r = R_IN + (R_OUT - R_IN) * Math.pow(u, 1.1);
      const a = (j * TAU) / O.arms + PITCH * Math.log(r / R_IN);
      haze.push({
        r,
        a,
        sz: 30 + r * 0.17,
        al: 0.042 * Math.pow(1 - u, 1.4) + 0.003
      });
    }
  }

  /* ---------- 画布尺寸 + 星盘预渲染 ---------- */
  let K = 1;
  let visible = true;
  const disc = document.createElement("canvas");
  function buildDisc() {
    disc.width = disc.height = Math.round(S * K);
    const x = disc.getContext("2d")!;
    x.setTransform(K, 0, 0, K, 0, 0);
    x.globalCompositeOperation = "lighter";
    for (const h of haze) {
      x.globalAlpha = h.al;
      x.drawImage(
        sprite,
        C + Math.cos(h.a) * h.r - h.sz,
        C + Math.sin(h.a) * h.r - h.sz,
        h.sz * 2,
        h.sz * 2
      );
    }
    for (let b = 0; b < buckets.length; b++) {
      const c = PAL[b];
      x.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      for (const p of buckets[b]) {
        x.globalAlpha = p.al;
        x.fillRect(C + Math.cos(p.a) * p.r, C + Math.sin(p.a) * p.r, p.s, p.s);
      }
    }
  }
  function fit() {
    const css = canvas.getBoundingClientRect().width;
    // 画布不可见（尺寸为 0，例如小屏下被隐藏）：不画，等尺寸恢复再重建
    visible = css >= 2;
    if (!visible) return;
    const d = Math.min(window.devicePixelRatio || 1, 2);
    K = clamp((css * d) / S, 0.8, 2.2);
    canvas.width = canvas.height = Math.round(S * K);
    buildDisc();
    if (RM) draw(0);
  }

  /* ---------- 光 ---------- */
  const add: GlobalCompositeOperation = "lighter";
  function radial(
    x: number,
    y: number,
    r: number,
    stops: Array<[number, string]>
  ) {
    const g = ctx!.createRadialGradient(x, y, 0, x, y, r);
    for (const [o, c] of stops) g.addColorStop(o, c);
    ctx!.fillStyle = g;
    ctx!.fillRect(x - r, y - r, r * 2, r * 2);
  }
  /* 细长的纺锤形光芒，沿 +/-Y 方向，长度 L，最宽处 w */
  function spindle(L: number, w: number, ang: number, a: number) {
    const c = ctx!;
    c.save();
    c.translate(C, C);
    c.rotate(ang);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, L);
    g.addColorStop(0, `rgba(255,250,232,${0.95 * a})`);
    g.addColorStop(0.12, `rgba(255,228,160,${0.6 * a})`);
    g.addColorStop(0.45, `rgba(255,196,110,${0.18 * a})`);
    g.addColorStop(1, "rgba(255,180,90,0)");
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(0, -L);
    c.bezierCurveTo(w, -L * 0.12, w, L * 0.12, 0, L);
    c.bezierCurveTo(-w, L * 0.12, -w, -L * 0.12, 0, -L);
    c.fill();
    c.restore();
  }

  function draw(t: number) {
    const c = ctx!;
    c.setTransform(K, 0, 0, K, 0, 0);
    c.clearRect(0, 0, S, S);
    c.globalCompositeOperation = add;
    c.globalAlpha = 1;
    const breath = RM ? 1 : 1 + 0.05 * Math.sin(t * 0.0009);

    /* ① 外层光晕 */
    radial(C, C, S * 0.52, [
      [0, "rgba(255,196,120,.16)"],
      [0.35, "rgba(230,150,90,.07)"],
      [1, "rgba(200,120,80,0)"]
    ]);

    /* ② 星盘：预渲染的盘面做一次「旋转 + 压扁」绘制，再叠上会闪烁的亮星 */
    const rot = RM ? 0 : t * 0.001 * O.spin * TAU;
    const ct = Math.cos(O.tiltAngle);
    const st = Math.sin(O.tiltAngle);
    c.save();
    c.translate(C, C);
    c.rotate(O.tiltAngle);
    c.scale(1, O.tilt);
    c.rotate(rot);
    c.drawImage(disc, -C, -C, S, S);
    c.restore();
    c.fillStyle = "rgb(255,244,214)";
    for (const p of spark) {
      const a = p.a + rot;
      const x = Math.cos(a) * p.r;
      const y = Math.sin(a) * p.r * O.tilt;
      c.globalAlpha = Math.min(
        1,
        p.al * (RM ? 1 : 0.55 + 0.45 * Math.sin(t * 0.0021 + p.tw)) * 1.15
      );
      c.fillRect(
        C + x * ct - y * st,
        C + x * st + y * ct,
        p.s * 1.1,
        p.s * 1.1
      );
    }
    c.globalAlpha = 1;

    /* ③ 日冕：中层泛光 + 细光芒 */
    radial(C, C, 150 * breath, [
      [0, "rgba(255,236,190,.55)"],
      [0.25, "rgba(255,205,125,.28)"],
      [0.6, "rgba(235,150,85,.08)"],
      [1, "rgba(220,120,70,0)"]
    ]);
    if (O.rays) {
      c.lineCap = "round";
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * TAU + (RM ? 0 : t * 0.00003);
        const big = i % 6 === 0;
        const fl = RM
          ? 0.7
          : 0.55 + 0.45 * Math.sin(t * 0.0011 * (1 + (i % 5) * 0.27) + i * 1.7);
        const l0 = 15;
        const l1 = l0 + (big ? 64 : 30) * (0.7 + 0.5 * fl) + (i % 2 ? 0 : 10);
        const cs = Math.cos(a);
        const sn = Math.sin(a);
        const g = c.createLinearGradient(
          C + cs * l0,
          C + sn * l0,
          C + cs * l1,
          C + sn * l1
        );
        g.addColorStop(0, `rgba(255,240,200,${(big ? 0.5 : 0.3) * fl})`);
        g.addColorStop(1, "rgba(255,200,120,0)");
        c.strokeStyle = g;
        c.lineWidth = big ? 1.1 : 0.7;
        c.beginPath();
        c.moveTo(C + cs * l0, C + sn * l0);
        c.lineTo(C + cs * l1, C + sn * l1);
        c.stroke();
      }
    }

    /* ④ 四角星耀斑：竖向最长，横向次之，斜向很淡 */
    if (O.flare) {
      const f = RM ? 1 : 1 + 0.06 * Math.sin(t * 0.0013 + 1);
      spindle(300 * f, 7.5, 0, 1);
      spindle(205 * f, 5.5, Math.PI / 2, 0.9);
      spindle(96, 3.2, Math.PI / 4, 0.45);
      spindle(96, 3.2, -Math.PI / 4, 0.45);
    }

    /* ⑤ 内核：由外向内逐层变亮，最里面是纯白 */
    radial(C, C, 64 * breath, [
      [0, "rgba(255,252,240,.95)"],
      [0.3, "rgba(255,226,160,.6)"],
      [1, "rgba(255,180,100,0)"]
    ]);
    c.globalCompositeOperation = "source-over";
    const g = c.createRadialGradient(C - 2, C - 2, 0, C, C, 13);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.6, "#fff3d2");
    g.addColorStop(1, "#ffd68a");
    c.fillStyle = g;
    c.beginPath();
    c.arc(C, C, 12.5 * (RM ? 1 : 1 + 0.02 * Math.sin(t * 0.0009)), 0, TAU);
    c.fill();
  }

  /* ---------- 运行 ---------- */
  let raf = 0;
  let alive = true;
  const ro = new ResizeObserver(fit);
  ro.observe(canvas);
  fit();
  if (RM) {
    if (visible) draw(0);
  } else {
    const loop = (t: number) => {
      if (!alive) return;
      if (visible) draw(t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }
  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    ro.disconnect();
  };
}
