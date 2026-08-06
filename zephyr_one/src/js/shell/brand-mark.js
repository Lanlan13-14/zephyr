/** Zephyr wind-mark painter — matches zephyr_agent CustomPainter paths. */

const PALETTES = {
  frost: {
    iconStart: '#eef2f7',
    iconMid: '#a8b5c3',
    iconEnd: '#6e7b88',
    iconDotA: '#0a84ff',
    iconDotB: '#8e99a6',
    midStop: 0.58,
  },
  lava: {
    iconStart: '#f1e8df',
    iconMid: '#c79672',
    iconEnd: '#8d5a3a',
    iconDotA: '#bf5a1f',
    iconDotB: '#a58a78',
    midStop: 0.58,
  },
  asagi: {
    iconStart: '#edf4f2',
    iconMid: '#9bbdb5',
    iconEnd: '#5e8f83',
    iconDotA: '#4d9c8a',
    iconDotB: '#829b96',
    midStop: 0.58,
  },
  cyber: {
    iconStart: '#eef3f5',
    iconMid: '#9eb7bd',
    iconEnd: '#5d858d',
    iconDotA: '#4f9da6',
    iconDotB: '#7f9298',
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
  <path d="M45 65 C85 45, 135 55, 160 80 C130 80, 95 95, 75 125" stroke="url(#zg)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M50 75 C90 75, 125 90, 145 115 C115 135, 75 155, 40 135" stroke="url(#zg)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" opacity="0.86"/>
  <path d="M85 95 C110 110, 135 135, 155 130" stroke="url(#zg)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.62"/>
  <circle cx="145" cy="115" r="4.5" fill="${p.iconDotA}" opacity="0.9"/>
  <circle cx="75" cy="125" r="3" fill="${p.iconDotB}" opacity="0.8"/>
</svg>`;
  el.innerHTML = svg;
}
