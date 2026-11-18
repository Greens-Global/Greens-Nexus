// The board glyph (Neil, 11/12/2026: "I don't like the icon for board
// module"): a whiteboard on its stand with a hand-drawn stroke on it - what a
// board in Notes actually is, readable down to 14px. It replaces
// lucide's PenTool, the pen nib Nexus Sign uses for a signature, so a board
// no longer reads as "sign here". Same conventions as TicketToken
// (currentColor stroke, 24x24 viewBox, `size`, any other prop passed on), so
// it drops in wherever a lucide icon is drawn.
export default function BoardIcon({ size = 24, style, ...rest }) {
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
      <path d="M2.5 3.5h19" />
      <path d="M20.5 3.5v10a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-10" />
      <path d="m8 20.5 4-5 4 5" />
      <path d="M7 10c1.3-1.8 2.6-1.8 3.5 0s2.4 1.8 3.8 0" />
    </svg>
  );
}
