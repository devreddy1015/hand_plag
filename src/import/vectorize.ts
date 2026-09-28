/**
 * Turning a picture of a diagram into the lines a person would draw.
 *
 * Someone copying a chart does not reproduce its pixels. They draw each line
 * once, with the pen, from one end to the other; they outline a solid bar and
 * shade it in; they write the labels in their own hand. To do the same, a
 * figure has to become lines again:
 *
 *   1. Find the ink: everything darker than the paper around it.
 *   2. Set aside the solid areas — bars, pie slices, filled arrowheads —
 *      which are shaded, not traced.
 *   3. Thin what is left to a one-pixel centre line (Zhang–Suen), so that a
 *      line of any weight becomes the path the pen took.
 *   4. Follow that centre line from end to end and from junction to
 *      junction, trim the whiskers thinning leaves at corners, and join the
 *      pieces that carry straight on through a crossing, so an axis crossed
 *      by ticks is still one line.
 *   5. Simplify each path to the few points that describe it.
 *
 * Nothing here touches a canvas: it works on a luminance array, so it can be
 * tested on its own and run anywhere.
 */

export interface VectorPath {
  /** x, y pairs in pixels of the source image. */
  pts: number[];
  /** How heavy the line is, relative to the typical line in this figure. */
  weight: number;
  closed: boolean;
}

export interface VectorFill {
  /** Outline as x, y pairs in pixels. */
  pts: number[];
  /** Area in pixels, so small fills can be inked solid and big ones shaded. */
  area: number;
  /** How dark the fill was, 0 (white) to 1 (black), so dark areas are shaded closer. */
  tone: number;
  /**
   * Fills of one colour share a group, and each group is shaded its own way,
   * so the bars of two series, or the slices of a pie, can still be told apart.
   */
  group: number;
}

export interface Vectorized {
  paths: VectorPath[];
  fills: VectorFill[];
  /** Typical line width in pixels. */
  lineWidth: number;
}

export interface VectorizeOptions {
  /** Pixels darker than this (0..255) are ink. Found from the image when not given. */
  threshold?: number;
  /** Anything with fewer pixels than this is dust. */
  minSpeck?: number;
  /** Give up on images that turn into more paths than this: they are not line art. */
  maxPaths?: number;
}

/**
 * Trace a luminance image (one byte per pixel, 0 = black) into pen paths and
 * filled areas. `ignore` marks pixels to treat as paper, such as the text that
 * is going to be written out by hand instead. Returns null when the picture
 * is not line art at all.
 */
export function vectorize(
  lum: Uint8Array,
  width: number,
  height: number,
  ignore: Uint8Array | null = null,
  options: VectorizeOptions = {},
  rgba: Uint8ClampedArray | null = null,
): Vectorized | null {
  const n = width * height;
  if (n === 0) return { paths: [], fills: [], lineWidth: 1 };
  const threshold = options.threshold ?? inkThreshold(lum);
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (lum[i] < threshold && (ignore === null || ignore[i] === 0)) ink[i] = 1;
  removeSpecks(ink, width, height, options.minSpeck ?? 4);

  const dist = distanceTransform(ink, width, height);
  const skeleton = ink.slice();
  thin(skeleton, width, height);

  // The typical half-width of a line: low in the range, so the centre lines
  // of solid bars do not count as lines.
  const halves: number[] = [];
  for (let i = 0; i < n; i++) if (skeleton[i] === 1) halves.push(dist[i]);
  if (halves.length === 0) return { paths: [], fills: [], lineWidth: 1 };
  halves.sort((a, b) => a - b);
  const typicalHalf = Math.max(0.5, halves[Math.floor(halves.length * 0.2)]);
  const lineWidth = Math.min(typicalHalf * 2, Math.max(2, Math.max(width, height) * 0.006));

  // Solid areas: where the ink is well over twice as wide as a line. An
  // arrowhead only just qualifies, and must: thinned, it would become the
  // end of its shaft and the arrow would lose its point. A figure that is
  // nearly all solid (a pie chart) has no thin lines to compare with, so the
  // limit is also held to a fixed share of the picture: nobody draws a line
  // that heavy.
  const solidHalf = Math.min(Math.max(1.8, typicalHalf * 2), Math.max(3, Math.max(width, height) * 0.006));
  // An opening: keep the ink a disc of that radius fits inside, then grow it
  // back by the same radius. What comes back is the solid areas whole, square
  // corners and all, and none of the lines.
  const core = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (dist[i] >= solidHalf) core[i] = 1;
  const solid = new Uint8Array(n);
  if (core.some((v) => v === 1)) {
    const outside = new Uint8Array(n);
    for (let i = 0; i < n; i++) outside[i] = core[i] === 1 ? 0 : 1;
    const toCore = distanceTransform(outside, width, height);
    for (let i = 0; i < n; i++) if (ink[i] === 1 && toCore[i] <= solidHalf + 0.6) solid[i] = 1;
  }
  const fills: VectorFill[] = [];
  const colours: [number, number, number][] = [];
  const minFill = Math.max(10, (lineWidth * 2.2) ** 2);
  const lines = ink.slice();
  for (const component of components(solid, width, height)) {
    if (component.pixels.length < minFill) {
      // A thick spot on a line, not an area: leave it to be traced.
      for (const p of component.pixels) solid[p] = 0;
      continue;
    }
    const outline = traceBoundary(solid, width, height, component.pixels[0]);
    if (outline.length >= 6) {
      const { tone, colour } = averageOf(component.pixels, lum, rgba);
      let group = colours.findIndex((c) => Math.abs(c[0] - colour[0]) + Math.abs(c[1] - colour[1]) + Math.abs(c[2] - colour[2]) < 60);
      if (group === -1) {
        group = colours.length;
        colours.push(colour);
      }
      fills.push({ pts: simplify(outline, 0.9, true), area: component.pixels.length, tone, group });
    }
    // What is shaded is not traced as well; its edge is drawn with the fill.
    for (const p of component.pixels) lines[p] = 0;
  }
  // The fringe the solid left behind would come back as whiskers round it.
  if (fills.length > 0) {
    for (let i = 0; i < n; i++) {
      if (lines[i] === 0) continue;
      const x = i % width;
      const y = (i / width) | 0;
      if (nearSolid(solid, width, height, x, y, 2)) lines[i] = 0;
    }
    removeSpecks(lines, width, height, options.minSpeck ?? 4);
  }

  const centre = fills.length > 0 ? lines.slice() : skeleton;
  if (fills.length > 0) thin(centre, width, height);
  cleanStaircases(centre, width, height);

  const raw = tracePaths(centre, width, height, Math.max(3, lineWidth * 1.6 + 1));
  const maxPaths = options.maxPaths ?? 2500;
  if (raw.length > maxPaths) return null;

  const paths: VectorPath[] = [];
  for (const path of raw) {
    const pts = simplify(path.pts, 0.75, path.closed);
    if (pts.length < 4 && !path.closed) {
      // A lone dot is worth keeping: it is a point on a graph.
      if (path.pts.length >= 2) paths.push({ pts: [path.pts[0], path.pts[1]], weight: 1, closed: false });
      continue;
    }
    let sum = 0;
    let count = 0;
    for (let k = 0; k < path.pts.length; k += 2) {
      sum += dist[(path.pts[k + 1] | 0) * width + (path.pts[k] | 0)];
      count++;
    }
    const weight = count > 0 ? Math.min(3, Math.max(0.6, sum / count / typicalHalf)) : 1;
    paths.push({ pts, weight, closed: path.closed });
  }
  return { paths, fills, lineWidth };
}

/**
 * Grey level of each pixel of RGBA data, weighted towards its darkest
 * channel: a yellow or pale-coloured line is still ink, though its luminance
 * is close to paper's. Transparent pixels count as paper.
 */
export function luminance(data: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(data.length / 4);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const a = data[i + 3] / 255;
    const r = data[i] * a + 255 * (1 - a);
    const g = data[i + 1] * a + 255 * (1 - a);
    const b = data[i + 2] * a + 255 * (1 - a);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    out[j] = Math.round(lum * 0.55 + Math.min(r, g, b) * 0.45);
  }
  return out;
}

/** Mean darkness and colour of a set of pixels. */
function averageOf(pixels: number[], lum: Uint8Array, rgba: Uint8ClampedArray | null): { tone: number; colour: [number, number, number] } {
  let l = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const p of pixels) {
    l += lum[p];
    if (rgba) {
      r += rgba[p * 4];
      g += rgba[p * 4 + 1];
      b += rgba[p * 4 + 2];
    }
  }
  const n = Math.max(1, pixels.length);
  const grey = l / n;
  return { tone: 1 - grey / 255, colour: rgba ? [r / n, g / n, b / n] : [grey, grey, grey] };
}

/**
 * Otsu's threshold: the grey level that best separates ink from paper. It is
 * held to a sensible band, because a page that is nearly all paper gives a
 * histogram with almost nothing on one side.
 */
export function inkThreshold(lum: Uint8Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < lum.length; i++) hist[lum[i]]++;
  const total = lum.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let sumBack = 0;
  let weightBack = 0;
  let best = 170;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    weightBack += hist[t];
    if (weightBack === 0) continue;
    const weightFore = total - weightBack;
    if (weightFore === 0) break;
    sumBack += t * hist[t];
    const meanBack = sumBack / weightBack;
    const meanFore = (sumAll - sumBack) / weightFore;
    const between = weightBack * weightFore * (meanBack - meanFore) ** 2;
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  // Otsu splits the two biggest groups, which in a chart can be black text
  // from a grey bar. Anything clearly darker than the paper is ink, so the
  // threshold is also kept close under the paper's own brightness.
  let seen = 0;
  let paper = 255;
  for (let t = 255; t >= 0; t--) {
    seen += hist[t];
    if (seen >= total * 0.2) {
      paper = t;
      break;
    }
  }
  return Math.max(120, Math.min(205, Math.max(best, paper - 70)));
}

/**
 * Is this image drawn — paper with lines and a few flat colours on it —
 * rather than a photograph? A drawing's greys pile up on a handful of values
 * (the paper, the ink, each fill colour); a photograph's spread smoothly over
 * all of them.
 */
export function looksLikeLineArt(lum: Uint8Array): boolean {
  if (lum.length === 0) return true;
  const bins = new Float64Array(64);
  const step = Math.max(1, Math.floor(lum.length / 60000));
  let counted = 0;
  let pale = 0;
  for (let i = 0; i < lum.length; i += step) {
    const v = lum[i];
    bins[v >> 2]++;
    if (v > 215) pale++;
    counted++;
  }
  let busy = 0;
  for (const b of bins) if (b / counted > 0.004) busy++;
  return pale / counted > 0.3 && busy <= 24;
}

// ------------------------------------------------------------------ helpers

interface Component {
  pixels: number[];
}

/** Eight-connected groups of set pixels. */
function components(mask: Uint8Array, width: number, height: number): Component[] {
  const seen = new Uint8Array(mask.length);
  const out: Component[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || seen[start] === 1) continue;
    const pixels: number[] = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop()!;
      pixels.push(p);
      const x = p % width;
      const y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const q = ny * width + nx;
          if (mask[q] === 0 || seen[q] === 1) continue;
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    out.push({ pixels });
  }
  return out;
}

function removeSpecks(mask: Uint8Array, width: number, height: number, minSize: number): void {
  for (const c of components(mask, width, height)) {
    if (c.pixels.length < minSize) for (const p of c.pixels) mask[p] = 0;
  }
}

/**
 * Distance from each ink pixel to the nearest paper, in pixels (a two-pass
 * chamfer approximation, accurate to a few per cent, which is plenty).
 */
export function distanceTransform(mask: Uint8Array, width: number, height: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) d[i] = mask[i] === 1 ? INF : 0;
  const A = 1;
  const B = Math.SQRT2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (d[i] === 0) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + A);
      else v = Math.min(v, A);
      if (y > 0) {
        v = Math.min(v, d[i - width] + A);
        if (x > 0) v = Math.min(v, d[i - width - 1] + B);
        if (x < width - 1) v = Math.min(v, d[i - width + 1] + B);
      } else v = Math.min(v, A);
      d[i] = v;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (d[i] === 0) continue;
      let v = d[i];
      if (x < width - 1) v = Math.min(v, d[i + 1] + A);
      else v = Math.min(v, A);
      if (y < height - 1) {
        v = Math.min(v, d[i + width] + A);
        if (x < width - 1) v = Math.min(v, d[i + width + 1] + B);
        if (x > 0) v = Math.min(v, d[i + width - 1] + B);
      } else v = Math.min(v, A);
      d[i] = v;
    }
  }
  return d;
}

function nearSolid(solid: Uint8Array, width: number, height: number, x: number, y: number, r: number): boolean {
  for (let dy = -r; dy <= r; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;
      if (solid[ny * width + nx] === 1) return true;
    }
  }
  return false;
}

// Neighbour offsets, clockwise from north: P2..P9 in Zhang–Suen's numbering.
const NX = [0, 1, 1, 1, 0, -1, -1, -1];
const NY = [-1, -1, 0, 1, 1, 1, 0, -1];

function neighbours(m: Uint8Array, width: number, height: number, x: number, y: number, out: number[]): void {
  for (let k = 0; k < 8; k++) {
    const nx = x + NX[k];
    const ny = y + NY[k];
    out[k] = nx >= 0 && ny >= 0 && nx < width && ny < height ? m[ny * width + nx] : 0;
  }
}

/** Zhang–Suen thinning, in place: every line becomes one pixel wide. */
export function thin(m: Uint8Array, width: number, height: number): void {
  const p = [0, 0, 0, 0, 0, 0, 0, 0];
  const remove: number[] = [];
  // Only pixels near the edge can change, so keep a list of candidates.
  let candidates: number[] = [];
  for (let i = 0; i < m.length; i++) if (m[i] === 1) candidates.push(i);
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      remove.length = 0;
      for (const i of candidates) {
        if (m[i] === 0) continue;
        const x = i % width;
        const y = (i - x) / width;
        neighbours(m, width, height, x, y, p);
        const b = p[0] + p[1] + p[2] + p[3] + p[4] + p[5] + p[6] + p[7];
        if (b < 2 || b > 6) continue;
        let a = 0;
        for (let k = 0; k < 8; k++) if (p[k] === 0 && p[(k + 1) % 8] === 1) a++;
        if (a !== 1) continue;
        if (pass === 0) {
          if (p[0] * p[2] * p[4] !== 0) continue;
          if (p[2] * p[4] * p[6] !== 0) continue;
        } else {
          if (p[0] * p[2] * p[6] !== 0) continue;
          if (p[0] * p[4] * p[6] !== 0) continue;
        }
        remove.push(i);
      }
      if (remove.length > 0) {
        changed = true;
        for (const i of remove) m[i] = 0;
      }
    }
    candidates = candidates.filter((i) => m[i] === 1);
  }
}

/**
 * Thinning leaves "staircase" corners on diagonal lines: a pixel whose two
 * neighbours already touch each other diagonally. Such a pixel makes a
 * junction out of nothing, so it is removed.
 */
function cleanStaircases(m: Uint8Array, width: number, height: number): void {
  const p = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (m[i] === 0) continue;
      neighbours(m, width, height, x, y, p);
      const b = p[0] + p[1] + p[2] + p[3] + p[4] + p[5] + p[6] + p[7];
      if (b < 2 || b > 3) continue;
      let a = 0;
      for (let k = 0; k < 8; k++) if (p[k] === 0 && p[(k + 1) % 8] === 1) a++;
      if (a !== 1) continue;
      // Two of the four straight neighbours set, at right angles: N+E, E+S, S+W, W+N.
      const staircase = (p[0] && p[2]) || (p[2] && p[4]) || (p[4] && p[6]) || (p[6] && p[0]);
      if (staircase) m[i] = 0;
    }
  }
}

interface RawPath {
  pts: number[];
  closed: boolean;
}

interface Edge {
  pts: number[];
  a: number;
  b: number;
  alive: boolean;
}

/**
 * Follow the centre line: from every end and junction along each branch to
 * the next end or junction. Short whiskers are trimmed, and branches that
 * carry straight on through a junction are joined into one path.
 */
function tracePaths(m: Uint8Array, width: number, height: number, spur: number): RawPath[] {
  const n = m.length;
  const degree = new Uint8Array(n);
  const p = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    if (m[i] === 0) continue;
    const x = i % width;
    neighbours(m, width, height, x, (i - x) / width, p);
    degree[i] = p[0] + p[1] + p[2] + p[3] + p[4] + p[5] + p[6] + p[7];
  }

  // Nodes: ends (degree 1), and junctions (3+), with touching junction pixels
  // gathered into one node.
  const nodeOf = new Int32Array(n).fill(-1);
  const nodes: { x: number; y: number; pixels: number[] }[] = [];
  for (let i = 0; i < n; i++) {
    if (m[i] === 0 || nodeOf[i] !== -1 || degree[i] === 2) continue;
    const id = nodes.length;
    const pixels = [i];
    nodeOf[i] = id;
    if (degree[i] >= 3) {
      for (let k = 0; k < pixels.length; k++) {
        const q = pixels[k];
        const qx = q % width;
        const qy = (q - qx) / width;
        for (let d = 0; d < 8; d++) {
          const nx = qx + NX[d];
          const ny = qy + NY[d];
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const r = ny * width + nx;
          if (m[r] === 1 && degree[r] >= 3 && nodeOf[r] === -1) {
            nodeOf[r] = id;
            pixels.push(r);
          }
        }
      }
    }
    let sx = 0;
    let sy = 0;
    for (const q of pixels) {
      sx += q % width;
      sy += Math.floor(q / width);
    }
    nodes.push({ x: sx / pixels.length + 0.5, y: sy / pixels.length + 0.5, pixels });
  }

  const used = new Uint8Array(n);
  const edges: Edge[] = [];
  const walk = (from: number, first: number): Edge => {
    const start = nodes[nodeOf[from]];
    const pts = [start.x, start.y];
    let prev = from;
    let cur = first;
    for (let guard = 0; guard < n; guard++) {
      if (nodeOf[cur] !== -1) {
        const end = nodes[nodeOf[cur]];
        pts.push(end.x, end.y);
        return { pts, a: nodeOf[from], b: nodeOf[cur], alive: true };
      }
      used[cur] = 1;
      const cx = cur % width;
      const cy = (cur - cx) / width;
      pts.push(cx + 0.5, cy + 0.5);
      let next = -1;
      // Prefer an unvisited path pixel; a node pixel ends the walk.
      for (let d = 0; d < 8; d++) {
        const nx = cx + NX[d];
        const ny = cy + NY[d];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const r = ny * width + nx;
        if (m[r] === 0 || r === prev) continue;
        if (nodeOf[r] !== -1 && nodeOf[r] !== nodeOf[from]) {
          next = r;
          break;
        }
        if (nodeOf[r] === -1 && used[r] === 0) next = r;
        else if (nodeOf[r] === nodeOf[from] && next === -1 && pts.length > 6) next = r;
      }
      if (next === -1) return { pts, a: nodeOf[from], b: -1, alive: true };
      prev = cur;
      cur = next;
    }
    return { pts, a: nodeOf[from], b: -1, alive: true };
  };

  for (let id = 0; id < nodes.length; id++) {
    for (const q of nodes[id].pixels) {
      const qx = q % width;
      const qy = (q - qx) / width;
      for (let d = 0; d < 8; d++) {
        const nx = qx + NX[d];
        const ny = qy + NY[d];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const r = ny * width + nx;
        if (m[r] === 0 || nodeOf[r] === id) continue;
        if (nodeOf[r] !== -1) {
          // Two nodes side by side: a one-step edge, walked once.
          if (nodeOf[r] > id) edges.push({ pts: [nodes[id].x, nodes[id].y, nodes[nodeOf[r]].x, nodes[nodeOf[r]].y], a: id, b: nodeOf[r], alive: true });
          continue;
        }
        if (used[r] === 1) continue;
        edges.push(walk(q, r));
      }
    }
  }

  // Whatever is left is closed loops with no ends or junctions: circles, boxes.
  const loops: RawPath[] = [];
  for (let i = 0; i < n; i++) {
    if (m[i] === 0 || used[i] === 1 || nodeOf[i] !== -1) continue;
    const pts: number[] = [];
    let prev = -1;
    let cur = i;
    for (let guard = 0; guard < n; guard++) {
      used[cur] = 1;
      const cx = cur % width;
      const cy = (cur - cx) / width;
      pts.push(cx + 0.5, cy + 0.5);
      let next = -1;
      for (let d = 0; d < 8; d++) {
        const nx = cx + NX[d];
        const ny = cy + NY[d];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const r = ny * width + nx;
        if (m[r] === 1 && r !== prev && used[r] === 0) {
          next = r;
          break;
        }
      }
      if (next === -1) break;
      prev = cur;
      cur = next;
    }
    if (pts.length >= 6) loops.push({ pts, closed: true });
  }

  pruneSpurs(edges, nodes.length, spur);
  return [...joinThrough(edges), ...loops];
}

function edgeLength(e: Edge): number {
  let total = 0;
  for (let k = 2; k < e.pts.length; k += 2) total += Math.hypot(e.pts[k] - e.pts[k - 2], e.pts[k + 1] - e.pts[k - 1]);
  return total;
}

/** Trim the whiskers thinning grows at corners and at the ends of thick lines. */
function pruneSpurs(edges: Edge[], nodeCount: number, spur: number): void {
  for (let round = 0; round < 2; round++) {
    const degree = new Int32Array(nodeCount);
    for (const e of edges) {
      if (!e.alive) continue;
      if (e.a >= 0) degree[e.a]++;
      if (e.b >= 0) degree[e.b]++;
    }
    let pruned = false;
    for (const e of edges) {
      if (!e.alive) continue;
      const da = e.a >= 0 ? degree[e.a] : 1;
      const db = e.b >= 0 ? degree[e.b] : 1;
      // A spur runs from a free end into a junction.
      if ((da === 1 && db >= 3) || (db === 1 && da >= 3)) {
        if (edgeLength(e) < spur) {
          e.alive = false;
          pruned = true;
          if (e.a >= 0) degree[e.a]--;
          if (e.b >= 0) degree[e.b]--;
        }
      }
    }
    if (!pruned) break;
  }
}

/** Direction leaving a node along an edge, from its first few pixels. */
function leaving(e: Edge, atStart: boolean): [number, number] {
  const pts = e.pts;
  const count = pts.length / 2;
  const reach = Math.min(count - 1, 7);
  const i0 = atStart ? 0 : count - 1;
  const i1 = atStart ? reach : count - 1 - reach;
  const dx = pts[i1 * 2] - pts[i0 * 2];
  const dy = pts[i1 * 2 + 1] - pts[i0 * 2 + 1];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

/**
 * Join edges end to end: through a node where only two meet, and through a
 * junction where two of them carry straight on. Everything else ends there.
 */
function joinThrough(edges: Edge[]): RawPath[] {
  const live = edges.filter((e) => e.alive && e.pts.length >= 4);
  // At each node, the edge ends that meet there.
  const at = new Map<number, { e: number; start: boolean }[]>();
  live.forEach((e, idx) => {
    if (e.a >= 0) (at.get(e.a) ?? at.set(e.a, []).get(e.a)!).push({ e: idx, start: true });
    if (e.b >= 0) (at.get(e.b) ?? at.set(e.b, []).get(e.b)!).push({ e: idx, start: false });
  });
  // link[edge*2 + (start?0:1)] = the edge end it continues into.
  const link = new Int32Array(live.length * 2).fill(-1);
  const key = (end: { e: number; start: boolean }) => end.e * 2 + (end.start ? 0 : 1);
  for (const ends of at.values()) {
    if (ends.length < 2) continue;
    const dirs = ends.map((end) => leaving(live[end.e], end.start));
    const pairs: [number, number, number][] = [];
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        if (ends[i].e === ends[j].e) continue;
        // Carrying straight on means leaving in opposite directions.
        const dot = dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1];
        pairs.push([dot, i, j]);
      }
    }
    pairs.sort((p, q) => p[0] - q[0]);
    const taken = new Set<number>();
    for (const [dot, i, j] of pairs) {
      // Two ends meeting alone join at any angle (the corner of a box); at a
      // real junction only those that carry on within about 35 degrees do.
      const limit = ends.length === 2 ? 0.2 : -0.82;
      if (dot > limit || taken.has(i) || taken.has(j)) continue;
      taken.add(i);
      taken.add(j);
      link[key(ends[i])] = key(ends[j]);
      link[key(ends[j])] = key(ends[i]);
    }
  }

  const done = new Uint8Array(live.length);
  const out: RawPath[] = [];
  const follow = (startEdge: number, fromStart: boolean): RawPath => {
    const pts: number[] = [];
    let e = startEdge;
    let forward = fromStart;
    let closed = false;
    for (let guard = 0; guard <= live.length; guard++) {
      done[e] = 1;
      const src = live[e].pts;
      const count = src.length / 2;
      for (let k = 0; k < count; k++) {
        const idx = forward ? k : count - 1 - k;
        // Skip the shared node point when continuing from the previous edge.
        if (pts.length > 0 && k === 0) continue;
        pts.push(src[idx * 2], src[idx * 2 + 1]);
      }
      const exit = e * 2 + (forward ? 1 : 0);
      const next = link[exit];
      if (next === -1) break;
      const ne = next >> 1;
      if (done[ne] === 1) {
        closed = ne === startEdge;
        break;
      }
      e = ne;
      forward = (next & 1) === 0;
    }
    return { pts, closed };
  };
  // Start from ends that are not continued, so each chain is walked from one end.
  for (let i = 0; i < live.length; i++) {
    if (done[i] === 1) continue;
    if (link[i * 2] === -1) out.push(follow(i, true));
    else if (link[i * 2 + 1] === -1) out.push(follow(i, false));
  }
  // Whatever remains is chained round in a loop.
  for (let i = 0; i < live.length; i++) if (done[i] === 0) out.push(follow(i, true));
  return out;
}

/**
 * Walk round the outside of a solid area (Moore neighbour tracing), giving
 * its outline as x, y pairs.
 */
function traceBoundary(mask: Uint8Array, width: number, height: number, start: number): number[] {
  // Find the top-left pixel of the component that contains `start`.
  let first = start;
  const sx = start % width;
  let sy = (start - sx) / width;
  // Walk up while still inside, then this column's topmost is a boundary pixel.
  while (sy > 0 && mask[(sy - 1) * width + sx] === 1) sy--;
  first = sy * width + sx;
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  const pts: number[] = [];
  let cx = first % width;
  let cy = (first - cx) / width;
  // Came in from above.
  let dir = 0;
  const startX = cx;
  const startY = cy;
  for (let guard = 0; guard < mask.length * 2; guard++) {
    pts.push(cx + 0.5, cy + 0.5);
    let found = false;
    // Look round clockwise, starting just after where we came from.
    for (let k = 0; k < 8; k++) {
      const d = (dir + 6 + k) % 8;
      const nx = cx + NX[d];
      const ny = cy + NY[d];
      if (at(nx, ny)) {
        cx = nx;
        cy = ny;
        dir = d;
        found = true;
        break;
      }
    }
    if (!found || (cx === startX && cy === startY)) break;
  }
  return pts;
}

/** Ramer–Douglas–Peucker: the fewest points within `epsilon` of the path. */
export function simplify(pts: number[], epsilon: number, closed: boolean): number[] {
  const count = pts.length / 2;
  if (count <= 2) return pts.slice();
  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;
  const stack: [number, number][] = [[0, count - 1]];
  if (closed && count > 3) {
    // A loop has no ends: split it at its farthest point from the start.
    let far = 0;
    let best = -1;
    for (let i = 1; i < count; i++) {
      const d = (pts[i * 2] - pts[0]) ** 2 + (pts[i * 2 + 1] - pts[1]) ** 2;
      if (d > best) {
        best = d;
        far = i;
      }
    }
    keep[far] = 1;
    stack.length = 0;
    stack.push([0, far], [far, count - 1]);
  }
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const ax = pts[a * 2];
    const ay = pts[a * 2 + 1];
    const bx = pts[b * 2];
    const by = pts[b * 2 + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i * 2];
      const py = pts[i * 2 + 1];
      const d = len < 1e-9 ? Math.hypot(px - ax, py - ay) : Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > epsilon && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < count; i++) if (keep[i] === 1) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}
