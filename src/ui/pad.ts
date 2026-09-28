/**
 * A surface to write or draw on with a finger, a stylus or a mouse.
 *
 * It is split into cells — three boxes to write a letter in three times, or a
 * single page to draw a diagram on — and it records each stroke as the pen
 * moved: position, and pressure where the device reports it. Mice and
 * fingers report no pressure, so there it is read from speed instead: a line
 * drawn quickly goes down lighter, as it does on paper.
 *
 * Points are kept in units of the cell's height, so what is written does not
 * depend on the size of the screen it was written on.
 */

export interface PadConfig {
  cells: number;
  /** Height of a cell over its width. */
  cellAspect: number;
  /** Rule the cells like a handwriting practice sheet. */
  guides: boolean;
  onChange?: () => void;
}

/** The practice-sheet lines, as fractions of the cell height from the top. */
export const PAD_GUIDES = {
  cap: 0.228,
  xHeight: 0.36,
  baseline: 0.66,
  descender: 0.804,
  /** One em, as a fraction of the cell height. */
  em: 0.6,
};

type Stroke = number[];

export class Pad {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly config: PadConfig;
  private cells: Stroke[][];
  private history: number[] = [];
  private active: { cell: number; stroke: Stroke; last: { x: number; y: number; t: number } } | null = null;
  private cellWidth = 1;
  private cellHeight = 1;
  private readonly resize: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, config: PadConfig) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    this.ctx = ctx;
    this.config = config;
    this.cells = Array.from({ length: config.cells }, () => []);
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(canvas);
    this.layout();
  }

  /** Strokes in one cell, as x, y, pressure triples in cell heights. */
  strokesOf(cell: number): number[][] {
    return this.cells[cell].map((s) => [...s]);
  }

  setStrokes(cell: number, strokes: number[][]): void {
    this.cells[cell] = strokes.map((s) => [...s]);
    this.history = this.history.filter((c) => c !== cell);
    for (let i = 0; i < strokes.length; i++) this.history.push(cell);
    this.draw();
  }

  isEmpty(cell?: number): boolean {
    return cell === undefined ? this.cells.every((c) => c.length === 0) : this.cells[cell].length === 0;
  }

  undo(): void {
    const cell = this.history.pop();
    if (cell === undefined) return;
    this.cells[cell].pop();
    this.draw();
    this.config.onChange?.();
  }

  clear(): void {
    this.cells = this.cells.map(() => []);
    this.history = [];
    this.draw();
    this.config.onChange?.();
  }

  dispose(): void {
    this.resize.disconnect();
  }

  private layout(): void {
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, rect.width);
    this.cellWidth = cssWidth / this.config.cells;
    this.cellHeight = this.cellWidth * this.config.cellAspect;
    const cssHeight = this.cellHeight;
    this.canvas.style.height = `${cssHeight}px`;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.draw();
  }

  private point(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const { x, y } = this.point(e);
    const cell = Math.max(0, Math.min(this.config.cells - 1, Math.floor(x / this.cellWidth)));
    const stroke: Stroke = [];
    this.active = { cell, stroke, last: { x, y, t: e.timeStamp } };
    this.push(stroke, cell, x, y, this.pressure(e, 0));
    this.cells[cell].push(stroke);
    this.history.push(cell);
    this.draw();
  }

  private move(e: PointerEvent): void {
    if (!this.active) return;
    e.preventDefault();
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
    for (const ev of events.length > 0 ? events : [e]) {
      const { x, y } = this.point(ev);
      const last = this.active.last;
      const dist = Math.hypot(x - last.x, y - last.y);
      // Ignore jitter smaller than a fraction of a pixel's worth of letter.
      if (dist < this.cellHeight * 0.004) continue;
      const dt = Math.max(1, ev.timeStamp - last.t);
      const speed = dist / this.cellHeight / (dt / 1000);
      this.push(this.active.stroke, this.active.cell, x, y, this.pressure(ev, speed));
      this.active.last = { x, y, t: ev.timeStamp };
    }
    this.draw();
  }

  private up(e: PointerEvent): void {
    if (!this.active) return;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.active = null;
    this.draw();
    this.config.onChange?.();
  }

  private pressure(e: PointerEvent, speed: number): number {
    if (e.pointerType === 'pen' && e.pressure > 0) return Math.min(1, 0.35 + 0.65 * e.pressure);
    // No pressure to read: a fast stroke goes down lighter.
    return Math.max(0.5, Math.min(1, 1.02 - speed * 0.12));
  }

  private push(stroke: Stroke, cell: number, x: number, y: number, p: number): void {
    const u = (x - cell * this.cellWidth) / this.cellHeight;
    const v = y / this.cellHeight;
    stroke.push(Math.round(u * 10000) / 10000, Math.round(v * 10000) / 10000, Math.round(p * 100) / 100);
  }

  private draw(): void {
    const { ctx, canvas } = this;
    const dpr = canvas.width / Math.max(1, this.cellWidth * this.config.cells);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const styles = getComputedStyle(canvas);
    const ink = styles.getPropertyValue('--pad-ink').trim() || '#1d3b8f';
    const rule = styles.getPropertyValue('--pad-rule').trim() || 'rgba(60, 90, 150, 0.35)';
    const H = this.cellHeight;
    const W = this.cellWidth;

    for (let c = 0; c < this.config.cells; c++) {
      const x0 = c * W;
      if (c > 0) {
        ctx.strokeStyle = rule;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x0 + 0.5, 6);
        ctx.lineTo(x0 + 0.5, H - 6);
        ctx.stroke();
      }
      if (this.config.guides) {
        const line = (f: number, dash: number[], alpha: number, width = 1) => {
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = rule;
          ctx.lineWidth = width;
          ctx.setLineDash(dash);
          ctx.beginPath();
          ctx.moveTo(x0 + 8, f * H);
          ctx.lineTo(x0 + W - 8, f * H);
          ctx.stroke();
        };
        line(PAD_GUIDES.cap, [2, 5], 0.55);
        line(PAD_GUIDES.xHeight, [6, 5], 0.9);
        line(PAD_GUIDES.baseline, [], 1, 1.6);
        line(PAD_GUIDES.descender, [2, 5], 0.55);
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
      }
    }

    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let c = 0; c < this.config.cells; c++) {
      const x0 = c * W;
      for (const stroke of this.cells[c]) {
        if (stroke.length < 3) continue;
        if (stroke.length === 3) {
          ctx.beginPath();
          ctx.arc(x0 + stroke[0] * H, stroke[1] * H, H * 0.018, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        for (let i = 3; i < stroke.length; i += 3) {
          ctx.lineWidth = H * 0.032 * (0.55 + 0.45 * stroke[i + 2]);
          ctx.beginPath();
          ctx.moveTo(x0 + stroke[i - 3] * H, stroke[i - 2] * H);
          ctx.lineTo(x0 + stroke[i] * H, stroke[i + 1] * H);
          ctx.stroke();
        }
      }
    }
  }
}

/** Convert strokes from pad units (cell heights) to em, for a letter written on the guides. */
export function padToEm(strokes: number[][]): number[][] {
  return strokes.map((stroke) => {
    const out: number[] = [];
    for (let i = 0; i < stroke.length; i += 3) {
      out.push(stroke[i] / PAD_GUIDES.em, (stroke[i + 1] - PAD_GUIDES.baseline) / PAD_GUIDES.em, stroke[i + 2]);
    }
    return out;
  });
}

/** The reverse: letters stored in em, shown back on the pad. */
export function emToPad(strokes: number[][], offset: number): number[][] {
  return strokes.map((stroke) => {
    const out: number[] = [];
    for (let i = 0; i < stroke.length; i += 3) {
      out.push(stroke[i] * PAD_GUIDES.em + offset, stroke[i + 1] * PAD_GUIDES.em + PAD_GUIDES.baseline, stroke[i + 2]);
    }
    return out;
  });
}
