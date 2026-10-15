// A project's look: its color and icon (Neil, Oct 15 2026).
//
// The project row stores a #rrggbb `color` and an `icon` KEY from the set
// below (models.TaskProject.icon). Both are optional: a project that never
// chose shows the folder in the default blue - exactly what every project
// showed before this existed. An icon key this list does not know (an older
// tab, a key retired later) is drawn as the folder too, never as nothing.
//
// Line icons from lucide-react, the set the rest of Nexus uses, so a project's
// icon matches every other icon around it.
import {
  FolderKanban, Briefcase, ClipboardList, ListChecks, Target, Flag, Rocket, Lightbulb,
  Building2, House, Hammer, HardHat, Wrench, KeyRound, MapPin, Warehouse,
  DollarSign, Receipt, Calculator, PiggyBank, TrendingUp, Landmark,
  Users, UserPlus, GraduationCap, HeartHandshake, Megaphone, Star,
  Laptop, Server, ShieldCheck, Bug, Code, Globe,
  Truck, Package, CalendarDays, FileText, Scale, Leaf, Camera, Palette,
} from 'lucide-react';
import { NX } from './theme';

export const DEFAULT_PROJECT_ICON = 'folder';
export const DEFAULT_PROJECT_COLOR = NX.blue;

// Twelve colors, every one at least 3:1 against BOTH the light card (#fff)
// and the dark one (#171c29) - the contrast a meaningful icon needs (WCAG
// 1.4.11). The darker 600/700 shades that read well on white sink into the
// dark card, so some are the 500 shade on purpose. Blue first: the default.
export const PROJECT_COLORS = [
  { hex: '#2563eb', label: 'Blue' },
  { hex: '#6366f1', label: 'Indigo' },
  { hex: '#8b5cf6', label: 'Violet' },
  { hex: '#db2777', label: 'Pink' },
  { hex: '#dc2626', label: 'Red' },
  { hex: '#ea580c', label: 'Orange' },
  { hex: '#d97706', label: 'Amber' },
  { hex: '#a16207', label: 'Brown' },
  { hex: '#16a34a', label: 'Green' },
  { hex: '#0d9488', label: 'Teal' },
  { hex: '#0891b2', label: 'Cyan' },
  { hex: '#64748b', label: 'Slate' },
];

// Grouped the way people look for them. Keys are what the project row
// stores - never rename one (a renamed key turns every project using it back
// into the folder); add new ones instead.
export const PROJECT_ICON_GROUPS = [
  { label: 'Work', icons: [
    ['folder', 'Folder', FolderKanban], ['briefcase', 'Briefcase', Briefcase], ['clipboard', 'Clipboard', ClipboardList],
    ['checklist', 'Checklist', ListChecks], ['target', 'Target', Target], ['flag', 'Flag', Flag],
    ['rocket', 'Rocket', Rocket], ['lightbulb', 'Idea', Lightbulb],
  ] },
  { label: 'Property', icons: [
    ['building', 'Building', Building2], ['house', 'House', House], ['hammer', 'Hammer', Hammer],
    ['hard-hat', 'Hard Hat', HardHat], ['wrench', 'Wrench', Wrench], ['key', 'Key', KeyRound],
    ['map-pin', 'Location', MapPin], ['warehouse', 'Warehouse', Warehouse],
  ] },
  { label: 'Finance', icons: [
    ['dollar', 'Dollar', DollarSign], ['receipt', 'Receipt', Receipt], ['calculator', 'Calculator', Calculator],
    ['piggy-bank', 'Savings', PiggyBank], ['trending-up', 'Growth', TrendingUp], ['landmark', 'Bank', Landmark],
  ] },
  { label: 'People', icons: [
    ['users', 'Team', Users], ['user-plus', 'Hiring', UserPlus], ['graduation-cap', 'Training', GraduationCap],
    ['handshake', 'Partnership', HeartHandshake], ['megaphone', 'Announcement', Megaphone], ['star', 'Star', Star],
  ] },
  { label: 'IT', icons: [
    ['laptop', 'Laptop', Laptop], ['server', 'Server', Server], ['shield', 'Security', ShieldCheck],
    ['bug', 'Bug', Bug], ['code', 'Code', Code], ['globe', 'Website', Globe],
  ] },
  { label: 'Operations', icons: [
    ['truck', 'Delivery', Truck], ['package', 'Package', Package], ['calendar', 'Calendar', CalendarDays],
    ['file-text', 'Document', FileText], ['scale', 'Legal', Scale], ['leaf', 'Sustainability', Leaf],
    ['camera', 'Photo', Camera], ['palette', 'Design', Palette],
  ] },
];

/** key -> { key, label, Icon, group } */
export const PROJECT_ICONS = Object.fromEntries(PROJECT_ICON_GROUPS.flatMap((g) =>
  g.icons.map(([key, label, Icon]) => [key, { key, label, Icon, group: g.label }])));

const HEX = /^#[0-9a-f]{6}$/i;

/** What a project looks like: { Icon, color, iconKey, iconLabel, colorLabel }.
 *  Always answers - an unknown or empty icon is the folder, and a project with
 *  no color of its own takes `fallbackColor`. That is the default blue, but a
 *  screen that drew every project in its own neutral (a gray folder in a team's
 *  list, the purple Bookmarks rows) passes that, so a project nobody has
 *  styled looks exactly as it did there before. */
export function projectLook(project, fallbackColor = DEFAULT_PROJECT_COLOR) {
  const ic = PROJECT_ICONS[project?.icon] || PROJECT_ICONS[DEFAULT_PROJECT_ICON];
  const color = HEX.test(project?.color || '') ? project.color.toLowerCase() : fallbackColor;
  const named = PROJECT_COLORS.find((c) => c.hex === color);
  return { Icon: ic.Icon, iconKey: ic.key, iconLabel: ic.label, color, colorLabel: named ? named.label : 'Custom' };
}
