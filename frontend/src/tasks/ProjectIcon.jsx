// A project's own icon, in its own color (Neil, Oct 15 2026) - the one
// component every screen draws a project with, so a project's chosen icon and
// color read the same on the Projects page, the project header, Bookmarks,
// portfolios and teams. The look itself (which icon, which color, the
// fallbacks) is projectLook.js.
//
// Decorative: the project's name is always beside it, so it is hidden from
// screen readers rather than read out as "hard hat" before every name.
import { projectLook } from './projectLook';

// `fallbackColor`: what this screen drew an unstyled project in before (see
// projectLook) - left out, the default blue.
export default function ProjectIcon({ project, size = 15, fallbackColor, style }) {
  const { Icon, color } = projectLook(project, fallbackColor);
  return <Icon size={size} aria-hidden="true" style={{ color, flexShrink: 0, ...style }} />;
}
