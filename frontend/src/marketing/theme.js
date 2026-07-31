// Marketing module - design-token bridge (ported 1:1 from the standalone
// "Marketing Module Nexus" export). The export was styled with TailwindCSS v4
// utilities; Nexus uses inline styles, so we expose the exact Tailwind default
// palette as a JS object and every ported component translates its classes to
// inline styles against these hex values - keeping the look identical.

// Tailwind default palette (the shades the export actually uses).
export const C = {
  white: '#ffffff',
  black: '#000000',
  gray50: '#f9fafb', gray100: '#f3f4f6', gray200: '#e5e7eb', gray300: '#d1d5db',
  gray400: '#9ca3af', gray500: '#6b7280', gray600: '#4b5563', gray700: '#374151',
  gray800: '#1f2937', gray900: '#111827',
  emerald50: '#ecfdf5', emerald100: '#d1fae5', emerald400: '#34d399', emerald500: '#10b981',
  emerald600: '#059669', emerald700: '#047857',
  blue50: '#eff6ff', blue100: '#dbeafe', blue200: '#bfdbfe', blue500: '#3b82f6',
  blue600: '#2563eb', blue700: '#1d4ed8',
  amber50: '#fffbeb', amber100: '#fef3c7', amber200: '#fde68a', amber500: '#f59e0b',
  amber600: '#d97706', amber700: '#b45309',
  purple50: '#faf5ff', purple100: '#f3e8ff', purple200: '#e9d5ff', purple500: '#a855f7',
  purple600: '#9333ea', purple700: '#7e22ce',
  red50: '#fef2f2', red100: '#fee2e2', red500: '#ef4444', red600: '#dc2626', red700: '#b91c1c',
  orange50: '#fff7ed', orange100: '#ffedd5', orange500: '#f97316', orange600: '#ea580c',
  teal50: '#f0fdfa', teal500: '#14b8a6', teal600: '#0d9488',
  pink50: '#fdf2f8', pink500: '#ec4899', pink600: '#db2777',
  indigo500: '#6366f1', indigo600: '#4f46e5',
};

export const FONT = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

// rgba helper for the export's translucent utilities (bg-black/30, bg-gray-50/60…).
export function alpha(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Reusable primitives matching the export's most common class clusters, so the
// ported components stay terse. All optional - components may also inline directly.
export const card = {
  background: C.white,
  border: `1px solid ${C.gray200}`,
  borderRadius: 12,
  boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)',   // shadow-sm
};
export const cardPad = { ...card, padding: 16 };
export const shadowMd = '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)';
export const shadowLg = '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)';

// Chart palette used across recharts components in the export.
export const CHART = {
  blue: C.blue600, emerald: C.emerald500, amber: C.amber500, purple: C.purple500,
  red: C.red500, orange: C.orange500, teal: C.teal500, gray: C.gray400,
  grid: C.gray100, axis: C.gray400,
};
