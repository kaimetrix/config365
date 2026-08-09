export default function RiskBadge({ risk }: { risk: string | null | undefined }) {
  const map: Record<string, string> = { high: '#f87171', medium: '#fbbf24', low: '#22c55e', none: '#52525b' };
  const color = map[String(risk ?? '').toLowerCase()] ?? '#52525b';
  return (
    <span style={{ color, textTransform: 'capitalize', fontSize: '0.72rem', fontWeight: 600 }}>
      {risk || 'none'}
    </span>
  );
}
