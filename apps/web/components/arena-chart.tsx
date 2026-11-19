'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts';
import { timeTicks, usd } from '@/lib/format';
import {
  ARENA_MODELS,
  MODEL_BY_ID,
  signedPct,
  spreadLabels,
  type ArenaPoint,
  type ArenaResponse,
  type ModelId,
} from '@/lib/arena-view';
import { signedUsd } from '@/lib/record-view';

/**
 * Every model's account value since the arena started. One colour per model, each line
 * ending in its provider's mark with its value beside it in plain text. The dashed line is
 * the shared start; the bracket joins the two models named on the invitation and gives the
 * gap between them.
 */

export type ArenaMode = 'usd' | 'pct';
export type ArenaRange = 'all' | '72h';

const MUTED = 'var(--muted-foreground)';
const GRID = 'var(--border)';
const HOUR = 3_600_000;
const TOP = 16;
const X_AXIS = 28;
const Y_AXIS = 64;
/** Room right of the line ends for each model's mark and value. */
const GUTTER = 132;
const BADGE_GAP = 28;

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

/** A step of 1, 2, 2.5 or 5 times a power of ten, near `rough`. */
function niceStep(rough: number): number {
  const power = 10 ** Math.floor(Math.log10(Math.max(rough, 1e-9)));
  const n = rough / power;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * power;
}

/** A domain on whole steps around the data and the start line, and its ticks. */
function scaleFor(points: ArenaPoint[], ids: readonly ModelId[], base: number, toValue: (v: number) => number) {
  let min = base;
  let max = base;
  for (const p of points) {
    for (const id of ids) {
      const v = toValue(p[id]);
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  const step = niceStep((max - min || 1) / 5);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step + (Math.ceil(max / step) * step === max ? step : 0);
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return { lo, hi, ticks };
}

function timeLabel(t: number, spanMs: number): string {
  const date = new Date(t);
  if (spanMs > 36 * HOUR) return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function ModelMark({ id, size = 24 }: { id: ModelId; size?: number }) {
  const model = MODEL_BY_ID[id];
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full border-2 bg-background"
      style={{ width: size, height: size, borderColor: model.color }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- tiny local SVG marks */}
      <img src={model.logo} alt="" width={Math.round(size * 0.58)} height={Math.round(size * 0.58)} />
    </span>
  );
}

function ArenaTooltip({
  active,
  payload,
  mode,
  toValue,
}: {
  active?: boolean;
  payload?: Array<{ payload: ArenaPoint }>;
  mode: ArenaMode;
  toValue: (v: number) => number;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const rows = ARENA_MODELS.map((m) => ({ id: m.id, name: m.name, value: point[m.id] })).sort((a, b) => b.value - a.value);
  return (
    <div className="min-w-56 space-y-2 rounded-lg border bg-popover px-3 py-2 text-sm shadow-sm">
      <div className="text-muted-foreground">
        {new Date(point.t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
      </div>
      {rows.map((row) => (
        <div key={row.id} className="flex items-center gap-2">
          <ModelMark id={row.id} size={16} />
          <span className="flex-1 truncate">{row.name}</span>
          <span className="tabular-nums">{mode === 'usd' ? usd(row.value) : signedPct(toValue(row.value))}</span>
        </div>
      ))}
    </div>
  );
}

export function ArenaChart({
  data,
  mode = 'usd',
  range = 'all',
  variant,
  focus,
}: {
  data: ArenaResponse;
  mode?: ArenaMode;
  range?: ArenaRange;
  variant: 'full' | 'mini';
  /** On the mini chart, the models drawn in colour; the rest stay faint. */
  focus?: readonly ModelId[];
}) {
  const { ref, size } = useSize<HTMLDivElement>();
  const full = variant === 'full';
  const last = data.points.at(-1);
  const from = range === '72h' && last ? last.t - 72 * HOUR : -Infinity;
  const points = data.points.filter((p) => p.t >= from);
  const base = mode === 'usd' ? data.bankrollUsd : 0;
  const toValue = (v: number) => (mode === 'usd' ? v : (v / data.bankrollUsd - 1) * 100);
  const ids = ARENA_MODELS.map((m) => m.id);
  const view = points.map((p) => {
    const out = { t: p.t } as ArenaPoint;
    for (const id of ids) out[id] = toValue(p[id]);
    return out;
  });
  const { lo, hi, ticks } = scaleFor(points, ids, base, toValue);
  const first = view[0];
  const end = view.at(-1);
  const matchup = data.matchup;
  // The leader is drawn last, so it sits on top where lines cross.
  const order = [...ids].sort((a, b) => (a === matchup?.leader ? 1 : b === matchup?.leader ? -1 : 0));

  if (!first || !end) return <div ref={ref} className="h-full w-full" />;
  const span = Math.max(end.t - first.t, 1);

  let overlay: ReactNode = null;
  if (full && size) {
    const plotTop = TOP;
    const plotHeight = size.height - TOP - X_AXIS;
    const xEnd = size.width - GUTTER;
    const py = (v: number) => plotTop + ((hi - v) / (hi - lo)) * plotHeight;
    const targets = ids.map((id) => py(end[id]));
    const placed = spreadLabels(targets, BADGE_GAP, plotTop + 12, plotTop + plotHeight - 12);
    let bracket: ReactNode = null;
    if (matchup) {
      const yLead = py(end[matchup.leader]);
      const yTrail = py(end[matchup.trailer]);
      const xb = xEnd - 14;
      const gap = end[matchup.leader] - end[matchup.trailer];
      const label = mode === 'usd' ? signedUsd(gap) : `+${gap.toFixed(1)} pts`;
      bracket = (
        <g>
          <path d={`M ${xb + 7} ${yLead} H ${xb} V ${yTrail} H ${xb + 7}`} fill="none" stroke={MUTED} strokeWidth={1} />
          <rect x={xb - 76} y={(yLead + yTrail) / 2 - 10} width={70} height={20} rx={4} fill="var(--card)" />
          <text x={xb - 8} y={(yLead + yTrail) / 2} dy="0.35em" textAnchor="end" fill="var(--foreground)" fontSize={12} fontWeight={500} style={{ fontVariantNumeric: 'tabular-nums' }}>
            {label}
          </text>
        </g>
      );
    }
    overlay = (
      <>
        <svg className="pointer-events-none absolute inset-0" width={size.width} height={size.height} aria-hidden>
          {ids.map((id, i) => (
            <line key={id} x1={xEnd + 3} y1={targets[i]} x2={xEnd + 12} y2={placed[i]} stroke={MODEL_BY_ID[id].color} strokeWidth={1} />
          ))}
          {bracket}
        </svg>
        {ids.map((id, i) => (
          <div key={id} className="pointer-events-none absolute flex items-center gap-2" style={{ left: xEnd + 12, top: placed[i]! - 12 }}>
            <ModelMark id={id} />
            <span className="text-xs text-foreground tabular-nums">{mode === 'usd' ? usd(end[id] ?? 0) : signedPct(end[id] ?? 0)}</span>
          </div>
        ))}
      </>
    );
  }

  const leader = data.standings.reduce((a, b) => (b.valueUsd > a.valueUsd ? b : a));
  return (
    <div
      ref={ref}
      className="relative h-full w-full"
      role="img"
      aria-label={`Account values of ${ids.length} models since ${new Date(data.since).toDateString()}. ${MODEL_BY_ID[leader.id].name} leads at ${usd(leader.valueUsd)}.`}
    >
      {size && (
        <LineChart
          width={size.width}
          height={size.height}
          data={view}
          margin={full ? { top: TOP, right: GUTTER, bottom: 0, left: 0 } : { top: 4, right: 4, bottom: 4, left: 4 }}
        >
          {full && <CartesianGrid stroke={GRID} vertical={false} />}
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={[first.t, end.t]}
            ticks={full ? timeTicks(first.t, end.t, 6) : []}
            tickFormatter={(t: number) => timeLabel(t, span)}
            tick={{ fill: MUTED, fontSize: 12 }}
            tickLine={false}
            axisLine={full ? { stroke: GRID } : false}
            height={X_AXIS}
            hide={!full}
          />
          <YAxis
            domain={[lo, hi]}
            ticks={ticks}
            allowDataOverflow
            tickFormatter={(v: number) => (mode === 'usd' ? `$${v}` : `${v > 0 ? '+' : ''}${v}%`)}
            tick={{ fill: MUTED, fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            width={Y_AXIS}
            hide={!full}
          />
          {full && (
            <Tooltip
              content={<ArenaTooltip mode={mode} toValue={toValue} />}
              cursor={{ stroke: MUTED, strokeWidth: 1, strokeDasharray: '3 3' }}
              isAnimationActive={false}
            />
          )}
          <ReferenceLine y={base} stroke={MUTED} strokeDasharray="4 4" strokeOpacity={0.6} />
          {order.map((id) => {
            const faint = !full && focus && !focus.includes(id);
            return (
              <Line
                key={id}
                dataKey={id}
                type="monotone"
                stroke={faint ? MUTED : MODEL_BY_ID[id].color}
                strokeWidth={faint ? 1 : 2}
                strokeOpacity={faint ? 0.35 : 1}
                dot={false}
                activeDot={full ? { r: 3.5, strokeWidth: 0 } : false}
                isAnimationActive={false}
              />
            );
          })}
          {ids
            .filter((id) => full || !focus || focus.includes(id))
            .map((id) => (
              <ReferenceDot key={`end-${id}`} x={end.t} y={end[id]} r={full ? 3 : 2.5} fill={MODEL_BY_ID[id].color} stroke="var(--card)" strokeWidth={1.5} />
            ))}
        </LineChart>
      )}
      {overlay}
    </div>
  );
}
