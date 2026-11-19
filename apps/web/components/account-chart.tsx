'use client';

import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { PortfolioPoint } from '@/lib/record-view';
import { cn } from '@/lib/utils';

const PAD_Y = 8;
/** Below this range the axis is widened, so a few cents of noise do not look like a cliff. */
const MIN_RANGE_USD = 2;

/** The index of the point nearest in time to `t`. */
function nearest(points: readonly PortfolioPoint[], t: number): number {
  let best = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (Math.abs(points[i]!.t - t) < Math.abs(points[best]!.t - t)) best = i;
  }
  return best;
}

/**
 * The account value over time, as a line over a soft fill, with a dashed line at the
 * starting value so above and below the start read at a glance. Pointing at the line, or
 * dragging a finger along it, reports the value at that moment through `onScrub`.
 */
export function AccountChart({
  points,
  startUsd,
  label,
  onScrub,
  className,
}: {
  points: readonly PortfolioPoint[];
  startUsd: number;
  /** What the chart shows, for screen readers. */
  label: string;
  onScrub: (point: PortfolioPoint | null) => void;
  className?: string;
}) {
  // React's ids hold characters that do not survive inside url(#…).
  const fillId = `account-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [active, setActive] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { width, height } = size;
  const drawable = points.length >= 2 && width > 0 && height > 0;
  const last = points.at(-1)?.v ?? startUsd;
  const tone = last > startUsd + 0.004 ? 'text-yes' : last < startUsd - 0.004 ? 'text-no' : 'text-muted-foreground';

  let line = '';
  let area = '';
  let baseY = height / 2;
  let x = (_t: number) => 0;
  let y = (_v: number) => 0;
  if (drawable) {
    const t0 = points[0]!.t;
    const t1 = points.at(-1)!.t;
    const values = [...points.map((p) => p.v), startUsd];
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (max - min < MIN_RANGE_USD) {
      const mid = (max + min) / 2;
      min = mid - MIN_RANGE_USD / 2;
      max = mid + MIN_RANGE_USD / 2;
    }
    x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * width;
    y = (v) => PAD_Y + ((max - v) / (max - min)) * (height - PAD_Y * 2);
    line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    area = `${line} L${width.toFixed(1)},${height} L0,${height} Z`;
    baseY = y(startUsd);
  }

  const point = active === null ? null : points[active] ?? null;

  function scrub(clientX: number) {
    const element = box.current;
    if (!drawable || !element) return;
    const left = element.getBoundingClientRect().left;
    const t0 = points[0]!.t;
    const t1 = points.at(-1)!.t;
    const index = nearest(points, t0 + ((clientX - left) / width) * (t1 - t0));
    setActive(index);
    onScrub(points[index]!);
  }
  function clear() {
    setActive(null);
    onScrub(null);
  }

  return (
    <div
      ref={box}
      role="img"
      aria-label={label}
      className={cn('relative touch-pan-y select-none', tone, className)}
      onPointerMove={(event) => scrub(event.clientX)}
      onPointerDown={(event) => scrub(event.clientX)}
      onPointerLeave={clear}
      onPointerCancel={clear}
      onPointerUp={(event) => event.pointerType !== 'mouse' && clear()}
    >
      <svg width={width} height={height} className="absolute inset-0 overflow-visible" aria-hidden>
        {drawable ? (
          <>
            <defs>
              <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity={0.12} />
                <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
              </linearGradient>
            </defs>
            <line
              x1={0}
              x2={width}
              y1={baseY}
              y2={baseY}
              className="stroke-muted-foreground/40"
              strokeDasharray="2 4"
              strokeWidth={1}
            />
            <path d={area} fill={`url(#${fillId})`} />
            <path d={line} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {point && (
              <>
                <line x1={x(point.t)} x2={x(point.t)} y1={0} y2={height} className="stroke-foreground/25" strokeWidth={1} />
                <circle cx={x(point.t)} cy={y(point.v)} r={4} fill="currentColor" className="stroke-background" strokeWidth={2} />
              </>
            )}
          </>
        ) : (
          width > 0 && (
            <line
              x1={0}
              x2={width}
              y1={height / 2}
              y2={height / 2}
              className="stroke-muted-foreground/40"
              strokeDasharray="2 4"
              strokeWidth={1}
            />
          )
        )}
      </svg>
    </div>
  );
}
