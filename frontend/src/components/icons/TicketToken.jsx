// Custom ticket glyph (rounded-notch outline + zigzag tear line) requested by
// the team in place of lucide's dashed-line Ticket icon. Matches lucide's own
// prop/style conventions (currentColor stroke, 24x24 viewBox) so it drops
// into any spot that renders `<Icon style={...} />`.
export default function TicketToken({ size = 24, style, ...rest }) {
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
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      <path d="M12 5 10.5 7 13.5 9 10.5 11 13.5 13 10.5 15 13.5 17 12 19" />
    </svg>
  );
}
