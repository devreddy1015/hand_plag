import { clamp, hashInts, mulberry32 } from './random';
import type { PageGeometry, PaperSize, Settings } from './types';

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
];

export function findPaperSize(id: string): PaperSize {
  return PAPER_SIZES.find((p) => p.id === id) ?? PAPER_SIZES[0];
}

/** Page size, ruled lines and text area for the current settings. */
export function pageGeometry(s: Settings): PageGeometry {
  const size = findPaperSize(s.paperSize);
  const widthMm = s.landscape ? size.height : size.width;
  const heightMm = s.landscape ? size.width : size.height;
  const width = widthMm * MM;
  const height = heightMm * MM;
  const spacing = clamp(s.lineSpacing, 3, 30) * MM;

  const top = clamp(s.margins.top, 0, heightMm - 10) * MM;
  const textBottom = height - clamp(s.margins.bottom, 0, heightMm - 10) * MM;

  // The first rule is the header line; text starts on the rule below it.
  const rules: number[] = [];
  for (let y = top; y <= height - 3 * MM; y += spacing) rules.push(y);
  let textLines = rules.filter((y, i) => i >= 1 && y <= textBottom);
  if (textLines.length === 0) textLines = [Math.min(top + spacing, height - MM)];

  const textLeft = clamp(s.margins.left, 0, widthMm - 20) * MM;
  const textRight = Math.max(textLeft + 10 * MM, width - clamp(s.margins.right, 0, widthMm) * MM);

  return {
    width,
    height,
    widthMm,
    heightMm,
    spacing,
    rules,
    textLines,
    textLeft,
    textRight,
    marginLineX: Math.max(2 * MM, textLeft - 3 * MM),
  };
}

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type CanvasFactory = (width: number, height: number) => AnyCanvas;

export function get2d(canvas: AnyCanvas): Ctx2D {
  const ctx = (canvas as HTMLCanvasElement).getContext('2d') as Ctx2D | null;
  if (!ctx) throw new Error('2D canvas is not available');
  return ctx;
}

/** Paints the paper: colour, grain, rules and margin line. */
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
  const hairline = 0.2 * MM;

  if (s.paperStyle === 'ruled') {
    ctx.strokeStyle = s.ruleColor;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = hairline;
    ctx.beginPath();
    for (const y of geom.rules) {
      ctx.moveTo(0, y);
      ctx.lineTo(geom.width, y);
    }
    ctx.stroke();
  } else if (s.paperStyle === 'grid' || s.paperStyle === 'dotted') {
    const cell = geom.spacing / 2;
    const originY = geom.rules[0] ?? 0;
    const firstY = originY - Math.floor(originY / cell) * cell;
    const originX = geom.textLeft;
    const firstX = originX - Math.floor(originX / cell) * cell;
    ctx.strokeStyle = s.ruleColor;
    ctx.fillStyle = s.ruleColor;
    if (s.paperStyle === 'grid') {
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = hairline * 0.75;
      ctx.beginPath();
      for (let y = firstY; y <= geom.height; y += cell) {
        ctx.moveTo(0, y);
        ctx.lineTo(geom.width, y);
      }
      for (let x = firstX; x <= geom.width; x += cell) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, geom.height);
      }
      ctx.stroke();
    } else {
      ctx.globalAlpha = 0.8;
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

  if (s.marginLine) {
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = '#e06666';
    ctx.lineWidth = hairline * 1.4;
    ctx.beginPath();
    ctx.moveTo(geom.marginLineX, 0);
    ctx.lineTo(geom.marginLineX, geom.height);
    ctx.stroke();
  }

  ctx.restore();
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
  const cellSize = size / cells;
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
  const smooth = (t: number) => t * t * (3 - 2 * t);

  for (let y = 0; y < size; y++) {
    const gy = y / cellSize;
    const y0 = Math.floor(gy) % cells;
    const y1 = (y0 + 1) % cells;
    const ty = smooth(gy - Math.floor(gy));
    for (let x = 0; x < size; x++) {
      const gx = x / cellSize;
      const x0 = Math.floor(gx) % cells;
      const x1 = (x0 + 1) % cells;
      const tx = smooth(gx - Math.floor(gx));
      const a = lattice[y0 * cells + x0] + (lattice[y0 * cells + x1] - lattice[y0 * cells + x0]) * tx;
      const b = lattice[y1 * cells + x0] + (lattice[y1 * cells + x1] - lattice[y1 * cells + x0]) * tx;
      const blotch = a + (b - a) * ty;
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
