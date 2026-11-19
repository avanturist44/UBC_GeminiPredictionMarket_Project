import { cents } from '@/lib/format';
import type { SparkView } from '@/lib/thesis-view';

const W = 168;
const H = 64;
const PAD = 6;

/**
 * The price of the side the author argued, as a small line. A dashed rule marks what they
 * paid and a ring marks when they bought; the line is green while the side is worth more
 * than they paid and red while it is worth less.
 */
export function OddsLine({ spark, trend }: { spark: SparkView; trend: 'up' | 'down' | 'flat' }) {
  const values = spark.points.map((point) => point.p);
  if (spark.entryPrice !== null) values.push(spark.entryPrice);
  let low = Math.min(...values);
  let high = Math.max(...values);
  // A flat line still needs a little height, or every wiggle would fill the box.
  if (high - low < 0.04) {
    const middle = (high + low) / 2;
    low = middle - 0.02;
    high = middle + 0.02;
  }
  const span = Math.max(spark.to - spark.from, 1);
  const x = (t: number) => PAD + ((t - spark.from) / span) * (W - PAD * 2);
  const y = (p: number) => PAD + (1 - (p - low) / (high - low)) * (H - PAD * 2);
  const path = spark.points.map((point, i) => `${i === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)},${y(point.p).toFixed(1)}`).join('');
  const last = spark.points[spark.points.length - 1]!;
  const color = trend === 'up' ? 'var(--yes)' : trend === 'down' ? 'var(--no)' : 'var(--muted-foreground)';
  const entryY = spark.entryPrice === null ? null : y(spark.entryPrice);
  const entryX = spark.entryT === null ? null : x(Math.min(Math.max(spark.entryT, spark.from), spark.to));
  // Where the line sat when the thesis was published, so the ring sits on the line.
  const atEntry =
    spark.entryT === null
      ? null
      : spark.points.reduce((best, point) => (Math.abs(point.t - spark.entryT!) < Math.abs(best.t - spark.entryT!) ? point : best));

  return (
    <svg
      role="img"
      aria-label={`Price of the side argued: ${cents(spark.points[0]!.p)} at the start of the line, ${cents(last.p)} at the end${
        spark.entryPrice === null ? '' : `, bought at ${cents(spark.entryPrice)}`
      }`}
      viewBox={`0 0 ${W} ${H}`}
      className="h-16 w-36 shrink-0 sm:w-42"
      preserveAspectRatio="none"
    >
      {entryY !== null && (
        <line
          x1={PAD}
          x2={W - PAD}
          y1={entryY}
          y2={entryY}
          stroke="var(--muted-foreground)"
          strokeOpacity={0.5}
          strokeWidth={1}
          strokeDasharray="2 3"
          vectorEffect="non-scaling-stroke"
        />
      )}
      <path d={path} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={x(last.t)} cy={y(last.p)} r={2.5} fill={color} />
      {entryX !== null && atEntry && (
        <circle cx={entryX} cy={y(atEntry.p)} r={3.5} fill="var(--card)" stroke="var(--foreground)" strokeWidth={1.5} />
      )}
    </svg>
  );
}
