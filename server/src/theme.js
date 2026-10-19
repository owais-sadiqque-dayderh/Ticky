/**
 * Theme presets and the rules for what an organiser may override.
 *
 * The pages only ever receive a resolved theme: the preset's full palette with
 * the organiser's overrides laid on top, so assets/js/theme.js never has to
 * guess a missing colour.
 */

const PRESETS = {
  day: {
    bg: '#f7f3eb', surface: '#fffdf8', surfaceSunk: '#efe8db', ink: '#191512',
    inkMuted: '#4a443e', inkFaint: '#6b645e', hair: '#e3dacb', accent: '#b4441f',
    accentWash: '#f6e6dd', ok: '#2f6b4f', bad: '#b4441f', headerBg: '#191512',
    headerText: '#f7f3eb', btnPrimaryBg: '#191512', btnPrimaryText: '#f7f3eb',
    glowA: 'rgba(180, 68, 31, 0.11)', glowB: 'rgba(47, 107, 79, 0.07)'
  },
  night: {
    bg: '#141210', surface: '#1d1916', surfaceSunk: '#0e0c0b', ink: '#f2ece2',
    inkMuted: '#a8a096', inkFaint: '#8a8177', hair: '#302a25', accent: '#f0733f',
    accentWash: 'rgba(240, 115, 63, 0.12)', ok: '#6ed9a6', bad: '#f0733f', headerBg: '#0e0c0b',
    headerText: '#f2ece2', btnPrimaryBg: '#f2ece2', btnPrimaryText: '#141210',
    glowA: 'rgba(240, 115, 63, 0.16)', glowB: 'rgba(110, 217, 166, 0.09)'
  },
  space: {
    bg: '#0b0e1a', surface: '#141a2e', surfaceSunk: '#080a13', ink: '#f3efe4',
    inkMuted: '#9294b0', inkFaint: '#5c5f7d', hair: '#262c47', accent: '#ff6a3d',
    accentWash: 'rgba(255, 106, 61, 0.14)', ok: '#6ed9a6', bad: '#ff6a3d', headerBg: '#080a13',
    headerText: '#f3efe4', btnPrimaryBg: '#f3efe4', btnPrimaryText: '#0b0e1a',
    glowA: 'rgba(255, 106, 61, 0.13)', glowB: 'rgba(91, 79, 207, 0.16)'
  }
};

const DEFAULT_FONTS = { display: 'Fraunces', body: 'Instrument Sans', mono: 'IBM Plex Mono' };

/** Font names end up in a Google Fonts URL, so only these are accepted. */
export const THEME_OPTIONS = {
  presets: Object.keys(PRESETS),
  patterns: ['none', 'stars', 'grain', 'dots'],
  fonts: {
    display: ['Fraunces', 'Playfair Display', 'DM Serif Display', 'Libre Baskerville', 'Space Grotesk', 'Bricolage Grotesque'],
    body: ['Instrument Sans', 'Inter', 'DM Sans', 'Work Sans', 'Source Sans 3', 'Nunito Sans'],
    mono: ['IBM Plex Mono', 'JetBrains Mono', 'Space Mono', 'DM Mono', 'Fira Code']
  }
};

const BG_TYPES = ['default', 'image', 'pattern'];
const BG_POSITIONS = ['center', 'top', 'bottom'];
const COLOR = /^(#[0-9a-f]{6}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/i;

export const DEFAULT_THEME = {
  register: { preset: 'day', colors: {}, fonts: {}, background: defaultBackground() },
  staff: { preset: 'night', colors: {}, fonts: {}, background: defaultBackground() }
};

function defaultBackground() {
  return { type: 'default', imageUrl: '', pattern: 'stars', overlayOpacity: 0.35, animate: true, position: 'center' };
}

function cleanSurface(raw, fallbackPreset) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const preset = PRESETS[input.preset] ? input.preset : fallbackPreset;

  const colors = {};
  Object.entries(input.colors || {}).forEach(([key, value]) => {
    if (key in PRESETS.day && COLOR.test(String(value).trim())) colors[key] = String(value).trim();
  });

  const fonts = {};
  Object.entries(input.fonts || {}).forEach(([role, name]) => {
    if (THEME_OPTIONS.fonts[role] && THEME_OPTIONS.fonts[role].includes(name)) fonts[role] = name;
  });

  const bgIn = input.background || {};
  const imageUrl = String(bgIn.imageUrl || '').trim();
  const overlay = Number(bgIn.overlayOpacity);
  const background = {
    type: BG_TYPES.includes(bgIn.type) ? bgIn.type : 'default',
    // Lands inside a CSS url(""), so https (or a local dev server) and nothing that can close the string.
    imageUrl: /^(https:\/\/|http:\/\/localhost[:/])[^\s"'()\\]+$/.test(imageUrl) ? imageUrl : '',
    pattern: THEME_OPTIONS.patterns.includes(bgIn.pattern) ? bgIn.pattern : 'stars',
    overlayOpacity: Number.isFinite(overlay) ? Math.min(1, Math.max(0, overlay)) : 0.35,
    animate: bgIn.animate !== false,
    position: BG_POSITIONS.includes(bgIn.position) ? bgIn.position : 'center'
  };

  return { preset, colors, fonts, background };
}

/** Accepts whatever admin.html sent and keeps only what is valid. */
export function cleanTheme(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    register: cleanSurface(input.register, 'day'),
    staff: cleanSurface(input.staff, 'night')
  };
}

function resolveSurface(surface) {
  const colors = { ...PRESETS[surface.preset], ...surface.colors };
  return {
    preset: surface.preset,
    colors,
    fonts: { ...DEFAULT_FONTS, ...surface.fonts },
    background: surface.background,
    meta: { themeColor: colors.headerBg }
  };
}

export function resolveTheme(raw) {
  const clean = cleanTheme(raw);
  return { register: resolveSurface(clean.register), staff: resolveSurface(clean.staff) };
}
