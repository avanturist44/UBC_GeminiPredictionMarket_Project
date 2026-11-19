'use client';

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { timeTicks, usd } from '@/lib/format';
import { signedUsd } from '@/lib/record-view';
import type { RacePoint, RaceResponse, RaceSlot } from '@/lib/race-view';

/**
 * Two agents' account values, racing from the same bankroll. The one ahead is drawn in the
 * accent, the other in ink; the dashed line is where both started. On the full chart a
 * bracket at the right edge joins the two line ends and gives the gap between them.
 */

const ACCENT = 'var(--primary)';
const INK = 'var(--foreground)';
const MUTED = 'var(--muted-foreground)';
const GRID = 'var(--border)';
const HOUR = 3_600_000;

/** The accent goes to whoever leads; when level, to the first agent. */
export function slotColor(race: Pick<RaceResponse, 'leader'>, slot: RaceSlot): string {
  return (race.leader ?? 'a') === slot ? ACCENT : INK;
}

function timeLabel(t: number, spanMs: number): string {
  const date = new Date(t);
  if (spanMs > 36 * HOUR) return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Room above and below the lines, so a flat start does not hug the edges. */
function valueDomain(points: RacePoint[], bankroll: number): [number, number] {
  let min = bankroll;
  let max = bankroll;
  for (const p of points) {
    min = Math.min(min, p.a, p.b);
    max = Math.max(max, p.a, p.b);
  }
  const pad = Math.max((max - min) * 0.18, 2);
  return [Math.floor(min - pad), Math.ceil(max + pad)];
}

/** The lead bracket: a "]" between the two line ends, labelled with the gap. */
function LeadBracket(props: { x1?: number; y1?: number; x2?: number; y2?: number; label: string }) {
  const { x1, y1, x2, y2, label } = props;
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return <g />;
  const mid = (y1 + y2) / 2;
  return (
    <g aria-hidden="true">
      <path d={`M ${x1 - 6} ${y1} H ${x1} V ${y2} H ${x2 - 6}`} fill="none" stroke={MUTED} strokeWidth={1} />
      <text x={x1 + 8} y={mid} dy="0.35em" fill={ACCENT} fontSize={12} style={{ fontVariantNumeric: 'tabular-nums' }}>
        {label}
      </text>
    </g>
  );
}

/** A triangle up for a YES position, down for NO, in its agent's colour. */
function OpenMark({ cx, cy, side, color, title }: { cx?: number; cy?: number; side: 'yes' | 'no'; color: string; title: string }) {
  if (cx === undefined || cy === undefined) return <g />;
  const size = 4.5;
  const direction = side === 'yes' ? -1 : 1;
  const points = [
    `${cx},${cy + direction * size}`,
    `${cx - size},${cy - direction * size * 0.75}`,
    `${cx + size},${cy - direction * size * 0.75}`,
  ].join(' ');
  return (
    <polygon points={points} fill={color} stroke="var(--background)" strokeWidth={1.5}>
      <title>{title}</title>
    </polygon>
  );
}

function RaceTooltip({ active, payload, race }: { active?: boolean; payload?: Array<{ payload: RacePoint }>; race: RaceResponse }) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const rows = (['a', 'b'] as const)
    .map((slot) => ({ slot, name: race[slot].name, value: point[slot] }))
    .sort((x, y) => y.value - x.value);
  return (
    <div className="space-y-1 rounded-md border bg-popover px-3 py-2 text-sm shadow-sm">
      <div className="text-muted-foreground">
        {new Date(point.t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
      </div>
      {rows.map((row) => (
        <div key={row.slot} className="flex items-center gap-2">
          <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: slotColor(race, row.slot) }} />
          <span className="flex-1">{row.name}</span>
          <span className="tabular-nums">{usd(row.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function RaceChart({ race, variant }: { race: RaceResponse; variant: 'full' | 'mini' }) {
  const { points } = race;
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return null;
  const full = variant === 'full';
  const span = Math.max(last.t - first.t, 1);
  // The full chart leaves a little room right of the line ends for the bracket.
  const end = full ? last.t + span * 0.04 : last.t;
  const domain = valueDomain(points, race.bankrollUsd);
  const order: RaceSlot[] = race.leader === 'a' ? ['b', 'a'] : ['a', 'b'];
  const lead = race.leader ? race[race.leader] : null;
  const trail = race.leader ? race[race.leader === 'a' ? 'b' : 'a'] : null;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={points} margin={full ? { top: 12, right: 64, bottom: 0, left: 0 } : { top: 6, right: 6, bottom: 6, left: 6 }}>
        {full && <CartesianGrid stroke={GRID} vertical={false} />}
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={[first.t, end]}
          ticks={full ? timeTicks(first.t, last.t) : []}
          tickFormatter={(t: number) => timeLabel(t, span)}
          tick={{ fill: MUTED, fontSize: 12 }}
          tickLine={false}
          axisLine={full ? { stroke: GRID } : false}
          hide={!full}
          minTickGap={48}
        />
        <YAxis
          domain={domain}
          tickFormatter={(v: number) => `$${v}`}
          tick={{ fill: MUTED, fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          width={56}
          tickCount={5}
          allowDecimals={false}
          hide={!full}
        />
        {full && <Tooltip content={<RaceTooltip race={race} />} isAnimationActive={false} />}
        <ReferenceLine y={race.bankrollUsd} stroke={MUTED} strokeDasharray="4 4" strokeOpacity={0.6} />
        {/* The leader is drawn last, so it sits on top where the lines cross. */}
        {order.map((slot) => (
          <Line
            key={slot}
            dataKey={slot}
            type="monotone"
            stroke={slotColor(race, slot)}
            strokeWidth={slotColor(race, slot) === ACCENT ? 2 : 1.5}
            strokeOpacity={slotColor(race, slot) === ACCENT ? 1 : 0.75}
            dot={false}
            activeDot={full ? { r: 3.5 } : false}
            isAnimationActive={false}
          />
        ))}
        {full &&
          race.marks.map((mark) => (
            <ReferenceDot
              key={mark.id}
              x={mark.t}
              y={mark.value}
              ifOverflow="extendDomain"
              shape={(props: { cx?: number; cy?: number }) => (
                <OpenMark
                  cx={props.cx}
                  cy={props.cy}
                  side={mark.side}
                  color={slotColor(race, mark.slot)}
                  title={`${race[mark.slot].name} bought ${mark.side.toUpperCase()}: ${mark.market}`}
                />
              )}
            />
          ))}
        {(['a', 'b'] as const).map((slot) => (
          <ReferenceDot key={`end-${slot}`} x={last.t} y={last[slot]} r={full ? 3 : 2.5} fill={slotColor(race, slot)} stroke="var(--card)" strokeWidth={1.5} />
        ))}
        {full && lead && trail && (
          <ReferenceLine
            segment={[
              { x: last.t + span * 0.015, y: last[race.leader === 'a' ? 'b' : 'a'] },
              { x: last.t + span * 0.015, y: last[race.leader!] },
            ]}
            shape={(props: { x1?: number; y1?: number; x2?: number; y2?: number }) => (
              <LeadBracket {...props} label={signedUsd(Number(race.leadUsd))} />
            )}
          />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}
