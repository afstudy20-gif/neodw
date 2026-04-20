/**
 * QCA SVG Overlay — renders QCA markers/contours as SVG elements
 * inside cornerstone's own .svg-layer, guaranteeing zero drift on pan/zoom.
 *
 * Cornerstone manages the svg-layer's coordinate system so that
 * worldToCanvas CSS-pixel values map directly to SVG user-space.
 */
import type { Point2D, WorldPoint, QCASession } from './QCATypes';

export type WorldToCanvasFn = (wp: WorldPoint) => Point2D | null;

const NS = 'http://www.w3.org/2000/svg';
const QCA_GROUP_ID = 'qca-overlay-group';

function getOrCreateGroup(svgLayer: SVGSVGElement): SVGGElement {
  let g = svgLayer.getElementById(QCA_GROUP_ID) as SVGGElement | null;
  if (!g) {
    g = document.createElementNS(NS, 'g') as SVGGElement;
    g.setAttribute('id', QCA_GROUP_ID);
    svgLayer.appendChild(g);
  }
  return g;
}

function clearGroup(g: SVGGElement) {
  while (g.firstChild) g.removeChild(g.firstChild);
}

function createLine(x1: number, y1: number, x2: number, y2: number, stroke: string, width: number, dash?: string): SVGLineElement {
  const line = document.createElementNS(NS, 'line');
  line.setAttribute('x1', String(x1));
  line.setAttribute('y1', String(y1));
  line.setAttribute('x2', String(x2));
  line.setAttribute('y2', String(y2));
  line.setAttribute('stroke', stroke);
  line.setAttribute('stroke-width', String(width));
  if (dash) line.setAttribute('stroke-dasharray', dash);
  return line;
}

function createCircle(cx: number, cy: number, r: number, fill: string, stroke?: string): SVGCircleElement {
  const c = document.createElementNS(NS, 'circle');
  c.setAttribute('cx', String(cx));
  c.setAttribute('cy', String(cy));
  c.setAttribute('r', String(r));
  c.setAttribute('fill', fill);
  if (stroke) { c.setAttribute('stroke', stroke); c.setAttribute('stroke-width', '1.5'); }
  return c;
}

function createText(x: number, y: number, text: string, fill: string, size: number = 13, bold = false): SVGTextElement {
  const t = document.createElementNS(NS, 'text');
  t.setAttribute('x', String(x));
  t.setAttribute('y', String(y));
  t.setAttribute('fill', fill);
  t.setAttribute('font-size', String(size));
  t.setAttribute('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace');
  if (bold) t.setAttribute('font-weight', 'bold');
  t.setAttribute('paint-order', 'stroke');
  t.setAttribute('stroke', 'rgba(0,0,0,0.6)');
  t.setAttribute('stroke-width', '3');
  t.textContent = text;
  return t;
}

function createPolyline(points: Point2D[], stroke: string, width: number, fill?: string, dash?: string): SVGPolylineElement {
  const pl = document.createElementNS(NS, 'polyline');
  pl.setAttribute('points', points.map(p => `${p.x},${p.y}`).join(' '));
  pl.setAttribute('stroke', stroke);
  pl.setAttribute('stroke-width', String(width));
  pl.setAttribute('fill', fill ?? 'none');
  pl.setAttribute('stroke-linejoin', 'round');
  pl.setAttribute('stroke-linecap', 'round');
  if (dash) pl.setAttribute('stroke-dasharray', dash);
  return pl;
}

function createPolygon(points: Point2D[], fill: string): SVGPolygonElement {
  const pg = document.createElementNS(NS, 'polygon');
  pg.setAttribute('points', points.map(p => `${p.x},${p.y}`).join(' '));
  pg.setAttribute('fill', fill);
  pg.setAttribute('stroke', 'none');
  return pg;
}

/**
 * Render QCA overlay into the cornerstone SVG layer.
 */
/** Draw perpendicular ticks at endpoints of a measurement line */
function drawPerpTicks(g: SVGGElement, p1: Point2D, p2: Point2D, color: string, tickLen: number = 12) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const nx = -dy / len;
  const ny = dx / len;
  // Tick at p1
  g.appendChild(createLine(p1.x + nx * tickLen, p1.y + ny * tickLen, p1.x - nx * tickLen, p1.y - ny * tickLen, color, 2));
  // Tick at p2
  g.appendChild(createLine(p2.x + nx * tickLen, p2.y + ny * tickLen, p2.x - nx * tickLen, p2.y - ny * tickLen, color, 2));
}

export function renderQCASvg(
  svgLayer: SVGSVGElement,
  session: QCASession,
  w2c: WorldToCanvasFn,
  rubberBand?: { start: Point2D; end: Point2D } | null
): void {
  const g = getOrCreateGroup(svgLayer);
  clearGroup(g);

  const YELLOW = '#ffdd00';
  const GREEN = '#4ec49a';
  const WHITE = 'rgba(255,255,255,0.85)';

  // ── Rubber-band line (while drawing calibration) ──
  if (rubberBand) {
    g.appendChild(createLine(rubberBand.start.x, rubberBand.start.y, rubberBand.end.x, rubberBand.end.y, GREEN, 1.5, '6 4'));
    drawPerpTicks(g, rubberBand.start, rubberBand.end, GREEN, 8);
    const dist = Math.hypot(rubberBand.end.x - rubberBand.start.x, rubberBand.end.y - rubberBand.start.y);
    g.appendChild(createText(rubberBand.end.x + 10, rubberBand.end.y - 8, `${dist.toFixed(1)} px`, GREEN, 11));
  }

  // ── Calibration line ──
  if (session.calibration?.catheterLine) {
    const p1 = w2c(session.calibration.catheterLine[0]);
    const p2 = w2c(session.calibration.catheterLine[1]);
    if (p1 && p2) {
      g.appendChild(createLine(p1.x, p1.y, p2.x, p2.y, GREEN, 2.5));
      drawPerpTicks(g, p1, p2, GREEN, 12);

      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2;
      g.appendChild(createText(mx + 10, my - 6, `${session.calibration.mmPerPixel.toFixed(4)} mm/px`, GREEN, 12, true));
    }
  }

  // ── Vessel contour ──
  if (session.contour) {
    const lb = projectAll(session.contour.leftBorder, w2c);
    const rb = projectAll(session.contour.rightBorder, w2c);
    const cl = projectAll(session.contour.centerline, w2c);

    // Left & right borders (yellow)
    if (lb.length > 1) g.appendChild(createPolyline(lb, YELLOW, 1.5));
    if (rb.length > 1) g.appendChild(createPolyline(rb, YELLOW, 1.5));

    // Cross-hatching (perpendicular ticks)
    const step = Math.max(1, Math.floor(lb.length / 20));
    for (let i = 0; i < lb.length && i < rb.length; i += step) {
      g.appendChild(createLine(lb[i].x, lb[i].y, rb[i].x, rb[i].y, 'rgba(255,221,0,0.4)', 0.8));
    }

    // Centerline (dashed white)
    if (cl.length > 1) g.appendChild(createPolyline(cl, 'rgba(255,255,255,0.3)', 1, undefined, '4 4'));

    // Lesion highlight (use override if set, else auto-detected)
    if (session.measurements && lb.length > 1 && rb.length > 1) {
      const s = Math.min(session.lesionStartOverride ?? session.measurements.lesionStartIndex, lb.length - 1, rb.length - 1);
      const e = Math.min(session.lesionEndOverride ?? session.measurements.lesionEndIndex, lb.length - 1, rb.length - 1);
      if (e > s) {
        const poly = [...lb.slice(s, e + 1), ...rb.slice(s, e + 1).reverse()];
        g.appendChild(createPolygon(poly, 'rgba(255,107,107,0.15)'));
      }
    }

    // Contour handle points (every N-th left/right border point)
    // These are draggable edit handles shown as small squares
    const HANDLE_STEP = Math.max(1, Math.floor(lb.length / 12));
    for (let i = 0; i < lb.length; i += HANDLE_STEP) {
      const lp = lb[i];
      const rp = i < rb.length ? rb[i] : null;
      if (lp) {
        const sq = document.createElementNS(NS, 'rect');
        sq.setAttribute('x', String(lp.x - 3));
        sq.setAttribute('y', String(lp.y - 3));
        sq.setAttribute('width', '6');
        sq.setAttribute('height', '6');
        sq.setAttribute('fill', 'rgba(121,199,255,0.8)');
        sq.setAttribute('stroke', 'rgba(0,0,0,0.4)');
        sq.setAttribute('stroke-width', '1');
        sq.setAttribute('data-handle', `left-${i}`);
        g.appendChild(sq);
      }
      if (rp) {
        const sq = document.createElementNS(NS, 'rect');
        sq.setAttribute('x', String(rp.x - 3));
        sq.setAttribute('y', String(rp.y - 3));
        sq.setAttribute('width', '6');
        sq.setAttribute('height', '6');
        sq.setAttribute('fill', 'rgba(121,199,255,0.8)');
        sq.setAttribute('stroke', 'rgba(0,0,0,0.4)');
        sq.setAttribute('stroke-width', '1');
        sq.setAttribute('data-handle', `right-${i}`);
        g.appendChild(sq);
      }
    }

    // MLD marker
    if (session.measurements && cl.length > 0) {
      const idx = Math.min(session.measurements.mldIndex, cl.length - 1);
      const p = cl[idx];
      if (p) {
        g.appendChild(createCircle(p.x, p.y, 6, WHITE, 'rgba(0,0,0,0.5)'));
        g.appendChild(createText(p.x - 20, p.y - 10, 'MLD', WHITE, 12, true));
      }
    }
  }

  // ── P marker ──
  if (session.proximalPoint) {
    const p = w2c(session.proximalPoint);
    if (p) {
      g.appendChild(createCircle(p.x, p.y, 6, YELLOW, 'rgba(0,0,0,0.5)'));
      g.appendChild(createText(p.x + 10, p.y - 8, 'P', YELLOW, 14, true));
    }
  }

  // ── D marker ──
  if (session.distalPoint) {
    const p = w2c(session.distalPoint);
    if (p) {
      g.appendChild(createCircle(p.x, p.y, 6, YELLOW, 'rgba(0,0,0,0.5)'));
      g.appendChild(createText(p.x + 10, p.y - 8, 'D', YELLOW, 14, true));
    }
  }

  // ── Guide points ──
  for (const wp of session.centerlinePoints) {
    const p = w2c(wp);
    if (p) g.appendChild(createCircle(p.x, p.y, 3, 'rgba(121,199,255,0.7)'));
  }
}

export function clearQCASvg(svgLayer: SVGSVGElement): void {
  const g = svgLayer.getElementById(QCA_GROUP_ID);
  if (g) g.parentElement?.removeChild(g);
}

function projectAll(wps: WorldPoint[], w2c: WorldToCanvasFn): Point2D[] {
  const result: Point2D[] = [];
  for (const wp of wps) {
    const p = w2c(wp);
    if (p) result.push(p);
  }
  return result;
}
