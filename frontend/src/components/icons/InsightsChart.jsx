// Custom Insights glyph (a line chart on a baseline) chosen by Neil (Oct 21
// 2026) over lucide's Gauge for the sidebar. Drawn on lucide's own 24-point
// grid with the same 2px round stroke, so it sits beside the library icons
// without reading as a different set. Same prop conventions as TicketToken,
// so it drops into any spot that renders `<Icon style={...} />`.
export default function InsightsChart({ size = 24, style, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      {...rest}
    >
      <path d="M3 20h18" />
      <path d="M6 16l4-6 4 3 5-8" />
    </svg>
  );
}
