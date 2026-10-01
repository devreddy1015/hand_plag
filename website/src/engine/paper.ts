import { clamp, createTileNoise, hashInts, mulberry32 } from './random';
import type { PageGeometry, PaperSize, Settings, TextArea } from './types';

/** Layout units per millimetre (CSS px at 96 DPI). */
export const MM = 96 / 25.4;

export const PAPER_SIZES: PaperSize[] = [
  { id: 'a4', label: 'A4 (210 × 297 mm)', width: 210, height: 297 },
  { id: 'letter', label: 'US Letter (8.5 × 11 in)', width: 215.9, height: 279.4 },
  { id: 'a5', label: 'A5 (148 × 210 mm)', width: 148, height: 210 },
  { id: 'a6', label: 'A6 (105 × 148 mm)', width: 105, height: 148 },
  { id: 'a3', label: 'A3 (297 × 420 mm)', width: 297, height: 420 },
  { id: 'legal', label: 'US Legal (8.5 × 14 in)', width: 215.9, height: 355.6 },
  { id: 'tabloid', label: 'Tabloid (11 × 17 in)', width: 279.4, height: 431.8 },
  { id: 'b5-jis', label: 'JIS B5 (182 × 257 mm)', width: 182, height: 257 },
  { id: 'index-5x3', label: 'Index card (5 × 3 in)', width: 127, height: 76.2 },
];

export function findPaperSize(id: string): PaperSize {
  return PAPER_SIZES.find((p) => p.id === id) ?? PAPER_SIZES[0];
}

/** Ratio of the line spacing used by the four-line practice ruling. */
const FOUR_LINE = { ascender: 0.62, midline: 0.31 };
/** Séyès paper subdivides each 8 mm band into four 2 mm steps. */
const SEYES_STEPS = 4;

/**
 * Page size, printed rules, furniture and the writable areas for one page.
 *
 * `pageIndex` matters because a bound notebook mirrors its margin and binding
 * on alternate sheets, so every page has to be asked for its own geometry.
 */
export function pageGeometry(s: Settings, pageIndex = 0): PageGeometry {
  const size = findPaperSize(s.paperSize);
  const widthMm = s.landscape ? size.height : size.width;
  const heightMm = s.landscape ? size.width : size.height;
  const width = widthMm * MM;
  const height = heightMm * MM;
  const spacing = clamp(s.lineSpacing, 3, 30) * MM;
  const f = s.features;

  const mirrored = f.mirrorEvenPages && pageIndex % 2 === 1;
  const bindingSide: 'left' | 'right' = mirrored ? 'right' : 'left';

  const maxSide = Math.max(0, widthMm / 2 - 8);
  const near = clamp(s.margins.left, 0, maxSide); // the binding side
  const far = clamp(s.margins.right, 0, maxSide);
  const leftMm = mirrored ? far : near;
  const rightMm = mirrored ? near : far;

  const top = clamp(s.margins.top, 0, heightMm - 20) * MM;
  const bottomLimit = height - clamp(s.margins.bottom, 0, heightMm - 20) * MM;

  // Printed horizontal rules run down the whole sheet, as on real paper.
  const rules: number[] = [];
  for (let y = top; y <= height - 3 * MM; y += spacing) rules.push(roundTo(y));

  const headerRuleY = f.headerRule && rules.length > 1 ? rules[0] : null;
  const summaryY = f.summaryBox > 0 ? height - clamp(f.summaryBox, 5, heightMm / 2) * MM : null;
  const writeBottom = Math.min(bottomLimit, summaryY === null ? bottomLimit : summaryY - spacing * 0.35);
  const firstWritable = headerRuleY === null ? top : top + spacing;

  let lines = rules.filter((y) => y >= firstWritable - 0.01 && y <= writeBottom + 0.01);
  if (lines.length === 0) lines = [Math.min(firstWritable, height - 2 * MM)];

  // The writing column, then the cue column and any second column carved out of it.
  const cue = clamp(f.cueColumn, 0, Math.max(0, widthMm - leftMm - rightMm - 25)) * MM;
  const outerLeft = leftMm * MM;
  const outerRight = Math.max(outerLeft + 15 * MM, width - rightMm * MM);
  const textLeft = mirrored ? outerLeft : outerLeft + cue;
  const textRight = mirrored ? outerRight - cue : outerRight;

  const areas: TextArea[] = [];
  if (f.columns === 2) {
    const gap = clamp(f.columnGap, 2, 40) * MM;
    const colWidth = (textRight - textLeft - gap) / 2;
    if (colWidth > 20 * MM) {
      areas.push({ left: textLeft, right: textLeft + colWidth, lines });
      areas.push({ left: textRight - colWidth, right: textRight, lines });
    }
  }
  if (areas.length === 0) areas.push({ left: textLeft, right: textRight, lines });

  // Vertical rules: the margin rule(s), the cue-column rule, the gutter rule.
  const marginLines: number[] = [];
  const gutter = 3 * MM;
  if (f.marginRule === 'single' || f.marginRule === 'double') {
    const edge = mirrored ? textRight + gutter : textLeft - gutter;
    marginLines.push(roundTo(edge));
    if (f.marginRule === 'double') marginLines.push(roundTo(edge + (mirrored ? 1.2 : -1.2) * MM));
  }
  if (cue > 0) marginLines.push(roundTo(mirrored ? textRight + gutter * 0.6 : textLeft - gutter * 0.6));
  if (f.columns === 2 && f.columnDivider && areas.length === 2) {
    marginLines.push(roundTo((areas[0].right + areas[1].left) / 2));
  }

  const verticalRules: number[] = [];
  const midRules: number[] = [];
  if (s.paperStyle === 'seyes') {
    for (const y of lines) {
      for (let k = 1; k < SEYES_STEPS; k++) midRules.push(roundTo(y - (spacing * k) / SEYES_STEPS));
    }
    for (let x = textLeft; x <= width - 2 * MM; x += spacing) verticalRules.push(roundTo(x));
    for (let x = textLeft - spacing; x >= 2 * MM; x -= spacing) verticalRules.push(roundTo(x));
  } else if (s.paperStyle === 'four-line') {
    for (const y of lines) midRules.push(roundTo(y - spacing * FOUR_LINE.midline));
  }

  const box =
    f.marginRule === 'box'
      ? {
          x: roundTo(Math.max(3 * MM, outerLeft - 5 * MM)),
          y: roundTo(Math.max(3 * MM, top - spacing * 0.8)),
          w: roundTo(Math.min(width - 6 * MM, outerRight + 5 * MM) - Math.max(3 * MM, outerLeft - 5 * MM)),
          h: roundTo(Math.min(height - 3 * MM, bottomLimit + 4 * MM) - Math.max(3 * MM, top - spacing * 0.8)),
        }
      : null;

  return {
    width,
    height,
    widthMm,
    heightMm,
    spacing,
    rules,
    midRules,
    verticalRules,
    areas,
    marginLines,
    headerRuleY,
    summaryY: summaryY === null ? null : roundTo(summaryY),
    holes: holePositions(f.holes, width, height, bindingSide),
    box,
    bindingSide,
    pageNumberAt: pageNumberSpot(s, width, height, top, bottomLimit, areas, bindingSide),
  };
}

/** Round to 1/100 u: keeps rule positions stable and hashes reproducible. */
function roundTo(v: number): number {
  return Math.round(v * 100) / 100;
}

function pageNumberSpot(
  s: Settings,
  width: number,
  height: number,
  top: number,
  bottomLimit: number,
  areas: TextArea[],
  bindingSide: 'left' | 'right',
): PageGeometry['pageNumberAt'] {
  if (s.features.pageNumber === 'none') return null;
  if (s.features.pageNumber === 'printed') {
    return { x: width / 2, y: Math.min(height - 4 * MM, bottomLimit + 7 * MM), align: 'center' };
  }
  // A writer puts the number in the outer top corner, above the first line.
  const outer = bindingSide === 'left' ? areas[areas.length - 1].right : areas[0].left;
  return { x: outer, y: Math.max(5 * MM, top - 2 * MM), align: bindingSide === 'left' ? 'right' : 'left' };
}

function holePositions(
  kind: Settings['features']['holes'],
  width: number,
  height: number,
  side: 'left' | 'right',
): PageGeometry['holes'] {
  const holes: PageGeometry['holes'] = [];
  const at = (inset: number, y: number, r: number) => holes.push({ x: side === 'left' ? inset : width - inset, y, r });
  if (kind === 'punch2') {
    const gap = 80 * MM; // ISO 838
    at(12 * MM, height / 2 - gap / 2, 3 * MM);
    at(12 * MM, height / 2 + gap / 2, 3 * MM);
  } else if (kind === 'punch3') {
    const gap = 4.25 * 25.4 * MM; // US three-ring
    at(11 * MM, height / 2, 4 * MM);
    at(11 * MM, height / 2 - gap, 4 * MM);
    at(11 * MM, height / 2 + gap, 4 * MM);
  } else if (kind === 'spiral') {
    const step = 11 * MM;
    const count = Math.floor((height - step) / step);
    const start = (height - (count - 1) * step) / 2;
    for (let i = 0; i < count; i++) at(7.5 * MM, start + i * step, 2.1 * MM);
  }
  return holes;
}

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type CanvasFactory = (width: number, height: number) => AnyCanvas;

export function get2d(canvas: AnyCanvas): Ctx2D {
  const ctx = (canvas as HTMLCanvasElement).getContext('2d') as Ctx2D | null;
  if (!ctx) throw new Error('2D canvas is not available');
  return ctx;
}

const scratchPool = new Map<string, AnyCanvas>();

/**
 * A cleared working canvas of a given size, kept between pages so a long
 * document does not allocate one per page. `key` keeps apart the canvases
 * one page needs at the same time.
 */
export function scratchCanvas(w: number, h: number, key: string, createCanvas: CanvasFactory): AnyCanvas {
  const id = `${key}:${w}x${h}`;
  let canvas = scratchPool.get(id);
  if (!canvas) {
    if (scratchPool.size > 8) scratchPool.clear();
    canvas = createCanvas(w, h);
    scratchPool.set(id, canvas);
  }
  const ctx = get2d(canvas);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, w, h);
  return canvas;
}

export function releaseScratch(): void {
  scratchPool.clear();
}

let blurSupport: boolean | undefined;

/** Whether this canvas can blur as it draws (`ctx.filter`); not every one can. */
export function canBlur(ctx: Ctx2D): boolean {
  if (blurSupport === undefined) {
    const c = ctx as CanvasRenderingContext2D;
    if (typeof c.filter !== 'string') blurSupport = false;
    else {
      const before = c.filter;
      c.filter = 'blur(1px)';
      blurSupport = c.filter === 'blur(1px)';
      c.filter = before;
    }
  }
  return blurSupport;
}

/** Paints the sheet: colour, grain, rules, margins, holes and printed labels. */
export function drawPaper(
  ctx: Ctx2D,
  geom: PageGeometry,
  s: Settings,
  scale: number,
  pageIndex: number,
  createCanvas: CanvasFactory,
): void {
  const w = Math.round(geom.width * scale);
  const h = Math.round(geom.height * scale);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = s.paperColor;
  ctx.fillRect(0, 0, w, h);

  if (s.texture) {
    ctx.globalCompositeOperation = 'multiply';
    // Two tiles of unrelated sizes hide the repeat of either one.
    for (const [variant, size] of [
      [0, grainTileSize(scale)],
      [1, Math.round(grainTileSize(scale) * 0.77)],
    ] as const) {
      const tile = grainTile(s.seed + variant * 7919, size, scale, createCanvas);
      const pattern = ctx.createPattern(tile as CanvasImageSource, 'repeat');
      if (pattern) {
        // Shift the pattern per page so pages don't share identical grain.
        const ox = hashInts(s.seed, pageIndex, variant) % size;
        const oy = hashInts(pageIndex, s.seed, variant) % size;
        ctx.setTransform(1, 0, 0, 1, ox, oy);
        ctx.fillStyle = pattern;
        ctx.fillRect(-ox, -oy, w, h);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }

  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.lineCap = 'butt';
  const hairline = 0.2 * MM;
  const style = s.paperStyle;

  const strokeLines = (color: string, alpha: number, lw: number, draw: () => void) => {
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = lw;
    ctx.beginPath();
    draw();
    ctx.stroke();
  };

  const horizontal = (ys: number[], x0: number, x1: number) => {
    for (const y of ys) {
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
    }
  };

  const ruleLeft = geom.box ? geom.box.x : 0;
  const ruleRight = geom.box ? geom.box.x + geom.box.w : geom.width;

  if (style === 'ruled' || style === 'four-line' || style === 'seyes') {
    // Faint subdivisions first, then the lines people actually write on.
    if (geom.midRules.length > 0) {
      ctx.setLineDash(style === 'four-line' ? [1.6 * MM, 1.4 * MM] : []);
      strokeLines(s.ruleColor, style === 'four-line' ? 0.5 : 0.28, hairline * 0.8, () =>
        horizontal(geom.midRules, ruleLeft, ruleRight),
      );
      ctx.setLineDash([]);
    }
    if (style === 'four-line') {
      strokeLines(s.ruleColor, 0.45, hairline * 0.8, () =>
        horizontal(
          geom.areas[0].lines.map((y) => y - geom.spacing * FOUR_LINE.ascender),
          ruleLeft,
          ruleRight,
        ),
      );
    }
    if (style === 'seyes' && geom.verticalRules.length > 0) {
      strokeLines(s.ruleColor, 0.3, hairline * 0.8, () => {
        for (const x of geom.verticalRules) {
          ctx.moveTo(x, geom.rules[0] ?? 0);
          ctx.lineTo(x, geom.rules[geom.rules.length - 1] ?? geom.height);
        }
      });
    }
    strokeLines(s.ruleColor, 0.85, hairline, () => horizontal(geom.rules, ruleLeft, ruleRight));
  } else if (style === 'grid' || style === 'dotted') {
    const cell = geom.spacing / 2;
    const originY = geom.rules[0] ?? 0;
    const firstY = originY - Math.floor(originY / cell) * cell;
    const originX = geom.areas[0].left;
    const firstX = originX - Math.floor(originX / cell) * cell;
    if (style === 'grid') {
      strokeLines(s.ruleColor, 0.55, hairline * 0.75, () => {
        for (let y = firstY; y <= geom.height; y += cell) {
          ctx.moveTo(0, y);
          ctx.lineTo(geom.width, y);
        }
        for (let x = firstX; x <= geom.width; x += cell) {
          ctx.moveTo(x, 0);
          ctx.lineTo(x, geom.height);
        }
      });
    } else {
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = s.ruleColor;
      const r = 0.18 * MM;
      ctx.beginPath();
      for (let y = firstY; y <= geom.height; y += cell) {
        for (let x = firstX; x <= geom.width; x += cell) {
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    }
  }

  // Vertical margin rules, the header rule and the Cornell summary rule.
  if (geom.marginLines.length > 0) {
    strokeLines(s.marginColor, 0.75, hairline * 1.3, () => {
      for (const x of geom.marginLines) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, geom.height);
      }
    });
  }
  if (geom.headerRuleY !== null) {
    strokeLines(s.marginColor, 0.6, hairline * 1.3, () => horizontal([geom.headerRuleY!], ruleLeft, ruleRight));
  }
  if (geom.summaryY !== null) {
    strokeLines(s.marginColor, 0.55, hairline * 1.2, () => horizontal([geom.summaryY!], ruleLeft, ruleRight));
  }
  if (geom.box) {
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = s.marginColor;
    ctx.lineWidth = hairline * 1.6;
    ctx.strokeRect(geom.box.x, geom.box.y, geom.box.w, geom.box.h);
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = hairline;
    ctx.strokeRect(geom.box.x + 1.2 * MM, geom.box.y + 1.2 * MM, geom.box.w - 2.4 * MM, geom.box.h - 2.4 * MM);
  }

  if (s.features.nameDateLine) drawNameDate(ctx, geom, s);
  if (s.features.pageNumber === 'printed' && geom.pageNumberAt) {
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = s.ruleColor;
    ctx.font = `${(3.4 * MM).toFixed(2)}px Georgia, 'Times New Roman', serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(String(pageIndex + 1), geom.pageNumberAt.x, geom.pageNumberAt.y);
    ctx.textAlign = 'left';
  }

  if (s.features.tornEdge) drawTornEdge(ctx, geom, s);
  if (geom.holes.length > 0) drawHoles(ctx, geom, s);

  ctx.globalAlpha = 1;
  ctx.restore();
}

/** One field of the printed "Name / Class / Date" line. */
export interface NameDateField {
  label: 'Name' | 'Class' | 'Date';
  /** Where the printed label starts, and where its blank starts and ends. */
  x: number;
  blank: number;
  end: number;
  /** Baseline of the label; the blank is ruled just under it. */
  y: number;
  /** Size of the printed type. */
  size: number;
}

/**
 * Where the printed "Name / Class / Date" line puts each field, so that the
 * sheet can print it and the writer can fill it in on the same blanks.
 */
export function nameDateFields(geom: PageGeometry): NameDateField[] {
  const area = geom.areas[0];
  const last = geom.areas[geom.areas.length - 1];
  const y = (geom.headerRuleY ?? geom.rules[0] ?? geom.spacing) - geom.spacing * 0.35;
  const size = Math.min(3.2 * MM, geom.spacing * 0.42);
  // Share of the line, and the width of the label and a space in Georgia, in em.
  const shares: [NameDateField['label'], number, number][] = [
    ['Name', 0.46, 2.8],
    ['Class', 0.2, 2.5],
    ['Date', 0.24, 2.35],
  ];
  const width = last.right - area.left;
  let x = area.left;
  return shares.map(([label, share, em]) => {
    const span = width * share;
    const field = { label, x, blank: x + size * em, end: x + span - 3 * MM, y, size };
    x += span;
    return field;
  });
}

/** The printed "Name / Class / Date" line found on exam and exercise sheets. */
function drawNameDate(ctx: Ctx2D, geom: PageGeometry, s: Settings): void {
  ctx.globalAlpha = 0.6;
  ctx.fillStyle = s.ruleColor;
  ctx.strokeStyle = s.ruleColor;
  ctx.textBaseline = 'alphabetic';
  ctx.lineWidth = 0.15 * MM;
  ctx.setLineDash([0.9 * MM, 0.9 * MM]);
  for (const field of nameDateFields(geom)) {
    ctx.font = `${field.size.toFixed(2)}px Georgia, 'Times New Roman', serif`;
    ctx.fillText(field.label, field.x, field.y);
    ctx.beginPath();
    ctx.moveTo(field.blank, field.y + 0.4 * MM);
    ctx.lineTo(field.end, field.y + 0.4 * MM);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

/** Holes punched or drilled for a binder, plus a spiral's wire. */
function drawHoles(ctx: Ctx2D, geom: PageGeometry, s: Settings): void {
  const spiral = s.features.holes === 'spiral';
  for (const hole of geom.holes) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#d8d6d0';
    ctx.beginPath();
    ctx.arc(hole.x, hole.y, hole.r, 0, Math.PI * 2);
    ctx.fill();
    // A hole is a gap in the sheet: light comes in at the top, shade at the bottom.
    const shade = ctx.createLinearGradient(hole.x, hole.y - hole.r, hole.x, hole.y + hole.r);
    shade.addColorStop(0, 'rgba(60,58,54,0.55)');
    shade.addColorStop(0.55, 'rgba(120,118,112,0.12)');
    shade.addColorStop(1, 'rgba(255,255,255,0.5)');
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.arc(hole.x, hole.y, hole.r, 0, Math.PI * 2);
    ctx.fill();
  }
  if (!spiral) return;
  // The wire crosses the edge above and below each hole.
  const left = geom.bindingSide === 'left';
  ctx.lineCap = 'round';
  for (const hole of geom.holes) {
    const x0 = left ? 0 : geom.width;
    const dir = left ? 1 : -1;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1.1 * MM;
    ctx.strokeStyle = '#9a9a9f';
    ctx.beginPath();
    ctx.moveTo(x0, hole.y - hole.r * 1.9);
    ctx.quadraticCurveTo(x0 + dir * hole.r * 3.4, hole.y - hole.r * 0.2, hole.x, hole.y);
    ctx.stroke();
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 0.4 * MM;
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(x0, hole.y - hole.r * 2.2);
    ctx.quadraticCurveTo(x0 + dir * hole.r * 3.2, hole.y - hole.r * 0.5, hole.x, hole.y - hole.r * 0.3);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
}

/** The fringe left when a sheet is torn out of a bound pad. */
function drawTornEdge(ctx: Ctx2D, geom: PageGeometry, s: Settings): void {
  const left = geom.bindingSide === 'left';
  const rng = mulberry32(hashInts(s.seed, 0x707e));
  const step = 2.2 * MM;
  const base = left ? 2.4 * MM : geom.width - 2.4 * MM;
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.moveTo(left ? 0 : geom.width, 0);
  for (let y = 0; y <= geom.height; y += step) {
    const depth = (0.35 + rng() * 1.5) * MM;
    const x = base + (left ? -depth : depth);
    ctx.lineTo(x, Math.min(y, geom.height));
  }
  ctx.lineTo(left ? 0 : geom.width, geom.height);
  ctx.closePath();
  const fringe = ctx.createLinearGradient(left ? 0 : geom.width, 0, base, 0);
  fringe.addColorStop(0, 'rgba(120,115,105,0.30)');
  fringe.addColorStop(0.6, 'rgba(150,145,135,0.10)');
  fringe.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = fringe;
  ctx.fill();
}

function grainTileSize(scale: number): number {
  return Math.round(clamp(190 * scale, 128, 640));
}

const tileCache = new Map<string, AnyCanvas>();

/**
 * A seamless, near-white tile of paper grain: soft blotches and fine speckle.
 * It is multiplied onto the paper colour. (Distinct features such as fibres
 * are left out on purpose: they would visibly repeat with the tile.)
 */
function grainTile(seed: number, size: number, scale: number, createCanvas: CanvasFactory): AnyCanvas {
  const key = `${seed}:${size}:${scale.toFixed(2)}`;
  const cached = tileCache.get(key);
  if (cached) return cached;
  if (tileCache.size > 24) tileCache.clear();

  const canvas = createCanvas(size, size);
  const ctx = get2d(canvas);
  const img = ctx.createImageData(size, size);
  const rng = mulberry32(hashInts(seed, 0x9a9e));

  const cells = Math.max(3, Math.round(size / (22 * scale)));
  const blotches = createTileNoise(rng, cells);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const blotch = blotches((x * cells) / size, (y * cells) / size);
      const speck = rng();
      let v = 255 - blotch * 3 - speck * speck * 5;
      if (speck > 0.9985) v -= 18; // rare darker fleck
      const o = (y * size + x) * 4;
      img.data[o] = v;
      img.data[o + 1] = v;
      img.data[o + 2] = v - 1;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  tileCache.set(key, canvas);
  return canvas;
}
