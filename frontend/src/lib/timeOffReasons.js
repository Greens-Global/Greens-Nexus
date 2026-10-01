// The icon and color for a type of time off on the request form (Neil, Sep
// 30 - Teams lists each kind of time off with its icon; views/TimeClock.jsx's
// type picker). Its own module so the view file exports only components.
import {
  TreePalm, Thermometer, User, Wallet, CircleEllipsis, CalendarOff, Clock,
  Baby, PartyPopper, CalendarCheck, CalendarX, Stethoscope, Flower2, Gavel, GraduationCap,
  Cake, Shield, HandHeart, House, Plane, Vote,
} from 'lucide-react';

// A company's own types are named freely ("Parental Leave", "Holiday", "Off"),
// so they are matched by what the name says, first match wins (Oct 1: every
// custom type showed the same green calendar).
// Order matters: "Approved Time Off" must hit "approved" before "off".
const REASON_LOOKS = [
  [/vacation|annual leave|\bpto\b/, TreePalm, '#2563eb'],
  [/sick/, Thermometer, '#16a34a'],
  [/^personal$/, User, '#8b5cf6'],
  [/unpaid|without pay|\blwp\b/, Wallet, '#6b7280'],
  [/^other$/, CircleEllipsis, '#f59e0b'],
  [/parent|maternity|paternity|adoption|baby/, Baby, '#db2777'],
  [/holiday|festival/, PartyPopper, '#ea580c'],
  [/approved/, CalendarCheck, '#15803d'],
  [/medical|doctor|surgery|hospital|health|dental/, Stethoscope, '#0891b2'],
  [/bereave|funeral|condolence/, Flower2, '#64748b'],
  [/jury|court/, Gavel, '#475569'],
  [/training|exam|study|education|course/, GraduationCap, '#4f46e5'],
  [/birthday/, Cake, '#e11d48'],
  [/military|reserve/, Shield, '#4d7c0f'],
  [/volunteer|charity/, HandHeart, '#be185d'],
  [/work from home|\bwfh\b|remote/, House, '#0d9488'],
  [/travel|business trip/, Plane, '#0284c7'],
  [/\bcomp\b|compensatory|in lieu|overtime/, Clock, '#a16207'],
  [/\bvote\b|voting|election/, Vote, '#7c3aed'],
  [/\boff\b/, CalendarX, '#9333ea'],
];
// Anything still unmatched keeps the calendar, in a color picked from its
// name - two unknown types never look identical.
const REASON_FALLBACK = ['#0f766e', '#b45309', '#1d4ed8', '#9d174d', '#4338ca', '#15803d', '#c2410c', '#6d28d9'];
export function reasonLook(key, label = '') {
  const text = `${key || ''} ${label || ''}`.trim().toLowerCase();
  const hit = REASON_LOOKS.find(([re]) => re.test(text));
  if (hit) return { Icon: hit[1], color: hit[2] };
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { Icon: CalendarOff, color: REASON_FALLBACK[h % REASON_FALLBACK.length] };
}
