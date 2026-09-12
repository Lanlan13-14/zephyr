/** Zephyr wind-mark painter — matches zephyr_agent CustomPainter paths. */

const PALETTES = {
  frost: {
    iconStart: '#eef2f7',
    iconMid: '#a8b5c3',
    iconEnd: '#6e7b88',
    iconDotA: '#0a84ff',
    midStop: 0.58,
  },
  lava: {
    iconStart: '#f1e8df',
    iconMid: '#c79672',
    iconEnd: '#8d5a3a',
    iconDotA: '#bf5a1f',
    midStop: 0.58,
  },
  asagi: {
    iconStart: '#edf4f2',
    iconMid: '#9bbdb5',
    iconEnd: '#5e8f83',
    iconDotA: '#4d9c8a',
    midStop: 0.58,
  },
  cyber: {
    iconStart: '#eef3f5',
    iconMid: '#9eb7bd',
    iconEnd: '#5d858d',
    iconDotA: '#4f9da6',
    midStop: 0.58,
  },
};

export function paintZephyrMark(el, paletteName = 'frost') {
  if (!el) return;
  const size = Math.max(el.clientWidth || 26, el.clientHeight || 26, 24);
  const p = PALETTES[paletteName] || PALETTES.frost;
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="${size}" height="${size}" fill="none">
  <defs>
    <linearGradient id="zg" x1="15%" y1="15%" x2="85%" y2="85%">
      <stop offset="0%" stop-color="${p.iconStart}"/>
      <stop offset="${Math.round(p.midStop * 100)}%" stop-color="${p.iconMid}"/>
      <stop offset="100%" stop-color="${p.iconEnd}"/>
    </linearGradient>
  </defs>
  <path d="M 43 64 C 84 44, 138 52, 160 77 C 148 94, 108 104, 76 123" stroke="url(#zg)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M 49 76 C 89 74, 126 89, 145 115 C 120 134, 76 153, 40 135" stroke="url(#zg)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" opacity="0.88"/>
  <path d="M 80 92 C 108 108, 137 135, 162 129" stroke="url(#zg)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.65"/>
  <circle cx="145" cy="115" r="4.5" fill="${p.iconDotA}" opacity="0.9"/>
</svg>`;
  el.innerHTML = svg;
}
