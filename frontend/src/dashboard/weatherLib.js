import {
  Sun, Moon, CloudSun, CloudMoon, Cloud, CloudFog, CloudDrizzle, CloudRain, CloudSnow, CloudLightning,
} from 'lucide-react';

// Shared by the Weather widget and its Add / Configure fields (weatherWidget.jsx).

export const WEATHER_DEFAULT = { mode: 'here', units: 'imperial' };

// Complete enough to add / save: a city mode needs a city, a project mode a project.
export const weatherConfigValid = (config) => {
  const mode = ({ ...WEATHER_DEFAULT, ...config }).mode;
  return mode === 'place' ? !!config?.place : mode === 'project' ? !!config?.project : true;
};

// WMO weather codes (Open-Meteo) -> words, icon, tint.
export function sky(code, isDay = true) {
  const c = Number(code);
  if (c === 0) return { text: isDay ? 'Sunny' : 'Clear', Icon: isDay ? Sun : Moon, tone: isDay ? 'sun' : 'night' };
  if (c === 1) return { text: isDay ? 'Mostly Sunny' : 'Mostly Clear', Icon: isDay ? CloudSun : CloudMoon, tone: isDay ? 'sun' : 'night' };
  if (c === 2) return { text: 'Partly Cloudy', Icon: isDay ? CloudSun : CloudMoon, tone: isDay ? 'cloud' : 'night' };
  if (c === 3) return { text: 'Cloudy', Icon: Cloud, tone: 'cloud' };
  if (c === 45 || c === 48) return { text: 'Fog', Icon: CloudFog, tone: 'fog' };
  if (c >= 51 && c <= 57) return { text: c >= 56 ? 'Freezing Drizzle' : 'Drizzle', Icon: CloudDrizzle, tone: 'rain' };
  if (c >= 61 && c <= 67) return { text: c >= 66 ? 'Freezing Rain' : c === 65 ? 'Heavy Rain' : c === 61 ? 'Light Rain' : 'Rain', Icon: CloudRain, tone: 'rain' };
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return { text: c === 75 || c === 86 ? 'Heavy Snow' : 'Snow', Icon: CloudSnow, tone: 'snow' };
  if (c >= 80 && c <= 82) return { text: c === 82 ? 'Heavy Showers' : 'Showers', Icon: CloudRain, tone: 'rain' };
  if (c >= 95) return { text: c === 95 ? 'Thunderstorms' : 'Storms & Hail', Icon: CloudLightning, tone: 'storm' };
  return { text: '-', Icon: Cloud, tone: 'cloud' };
}
// "2026-09-28T20:00" (the place's own wall clock) -> "8 PM"
export const hourLabel = (iso) => { const h = Number(iso.slice(11, 13)); return `${h % 12 || 12} ${h >= 12 ? 'PM' : 'AM'}`; };

// Wet skies: rain, snow or storm codes - what stops outdoor work.
export const isWet = (code) => ['rain', 'snow', 'storm'].includes(sky(code, true).tone);

// The first hour in the strip when rain is likely (a wet sky or at least
// RAIN_CHANCE percent), or null for a dry day. The widget's face says "Rain
// from 2 PM" from this (Neil, 10/30/2026: the rain is what a crew needs to see).
export const RAIN_CHANCE = 40;
export function rainStart(hours = []) {
  return hours.find((h) => isWet(h.code) || (h.precipChance ?? 0) >= RAIN_CHANCE) || null;
}

// Accent per sky; the card wash is this at low alpha, so it reads in both themes.
export const TONE = {
  sun: '245,158,11', night: '99,102,241', cloud: '100,116,139', fog: '148,163,184',
  rain: '37,99,235', snow: '14,165,233', storm: '124,58,237',
};

