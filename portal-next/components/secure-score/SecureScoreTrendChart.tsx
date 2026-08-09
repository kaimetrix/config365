'use client';

export interface ScoreHistoryPoint {
  date: string;
  percent: number;
  currentScore?: number;
  maxScore?: number;
}

interface Props {
  data: ScoreHistoryPoint[];
  height?: number;
  color?: string;
  showAxes?: boolean;
  showLabels?: boolean;
  className?: string;
}

function fmtShortDate(dateStr: string): string {
  try {
    const d = new Date(`${dateStr}T00:00:00Z`);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

function scoreColor(pct: number): string {
  if (pct >= 75) return '#22c55e';
  if (pct >= 50) return '#f59e0b';
  return '#ef4444';
}

/** SVG line/area chart for secure score percent over time. */
export default function SecureScoreTrendChart({
  data,
  height = 180,
  color,
  showAxes = true,
  showLabels = true,
  className,
}: Props) {
  if (data.length === 0) {
    return (
      <div
        className={className}
        style={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#52525b',
          fontSize: '0.82rem',
          background: '#111113',
          border: '1px solid #27272a',
          borderRadius: 8,
        }}
      >
        No history data yet — run a backup to populate the trend.
      </div>
    );
  }

  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date));
  const values = sorted.map(d => d.percent);
  const minVal = Math.max(0, Math.floor(Math.min(...values) / 5) * 5 - 5);
  const maxVal = Math.min(100, Math.ceil(Math.max(...values) / 5) * 5 + 5);
  const range = maxVal - minVal || 1;

  const padL = showAxes ? 36 : 4;
  const padR = 8;
  const padT = 12;
  const padB = showLabels ? 28 : 8;
  const width = 600;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;

  const points = sorted.map((d, i) => {
    const x = padL + (sorted.length === 1 ? chartW / 2 : (i / (sorted.length - 1)) * chartW);
    const y = padT + chartH - ((d.percent - minVal) / range) * chartH;
    return { x, y, ...d };
  });

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${(padT + chartH).toFixed(1)} L ${points[0].x.toFixed(1)} ${(padT + chartH).toFixed(1)} Z`;
  const strokeColor = color ?? scoreColor(values[values.length - 1] ?? 0);

  const yTicks = [minVal, minVal + range / 2, maxVal].map(v => Math.round(v));

  const labelIndices = sorted.length <= 7
    ? sorted.map((_, i) => i)
    : [0, Math.floor(sorted.length / 2), sorted.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      style={{ width: '100%', height, display: 'block' }}
      role="img"
      aria-label="Secure Score trend chart"
    >
      {showAxes && yTicks.map(tick => {
        const y = padT + chartH - ((tick - minVal) / range) * chartH;
        return (
          <g key={tick}>
            <line x1={padL} y1={y} x2={width - padR} y2={y} stroke="#27272a" strokeWidth="1" />
            <text x={padL - 6} y={y + 4} textAnchor="end" fill="#52525b" fontSize="10">{tick}%</text>
          </g>
        );
      })}

      <defs>
        <linearGradient id="scoreAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={strokeColor} stopOpacity="0.25" />
          <stop offset="100%" stopColor={strokeColor} stopOpacity="0.02" />
        </linearGradient>
      </defs>

      <path d={areaPath} fill="url(#scoreAreaGrad)" />
      <path d={linePath} fill="none" stroke={strokeColor} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

      {points.map((p, i) => (
        <circle key={p.date} cx={p.x} cy={p.y} r={sorted.length === 1 ? 4 : 3} fill={strokeColor}>
          <title>{`${fmtShortDate(p.date)}: ${p.percent.toFixed(1)}%`}</title>
        </circle>
      ))}

      {showLabels && labelIndices.map(i => {
        const p = points[i];
        if (!p) return null;
        return (
          <text key={p.date} x={p.x} y={height - 6} textAnchor="middle" fill="#71717a" fontSize="10">
            {fmtShortDate(p.date)}
          </text>
        );
      })}
    </svg>
  );
}

/** Compact sparkline for table cells. */
export function SecureScoreSparkline({
  data,
  width = 80,
  height = 24,
  color,
}: {
  data: ScoreHistoryPoint[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (data.length < 2) {
    return <span style={{ color: '#52525b', fontSize: '0.72rem' }}>—</span>;
  }

  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date));
  const values = sorted.map(d => d.percent);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = maxVal - minVal || 1;
  const pad = 2;

  const points = sorted.map((d, i) => {
    const x = pad + (i / (sorted.length - 1)) * (width - pad * 2);
    const y = pad + (height - pad * 2) - ((d.percent - minVal) / range) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const strokeColor = color ?? scoreColor(values[values.length - 1] ?? 0);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke={strokeColor}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export { scoreColor as secureScoreColor };
