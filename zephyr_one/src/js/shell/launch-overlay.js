const PALETTES = {
  frost: { start: '#eef2f7', mid: '#a8b5c3', end: '#6e7b88', midStop: 0.58 },
  lava: { start: '#f1e8df', mid: '#c79672', end: '#8d5a3a', midStop: 0.58 },
  asagi: { start: '#edf4f2', mid: '#9bbdb5', end: '#5e8f83', midStop: 0.58 },
  cyber: { start: '#eef3f5', mid: '#9eb7bd', end: '#5d858d', midStop: 0.58 },
};

const SIZES = {
  compact: { card: '128px', svg: '102px', radius: '30px', progress: '200px', mt: '28px' },
  standard: { card: '156px', svg: '128px', radius: '36px', progress: '228px', mt: '32px' },
  large: { card: '184px', svg: '156px', radius: '42px', progress: '256px', mt: '38px' },
  xlarge: { card: '216px', svg: '182px', radius: '50px', progress: '280px', mt: '44px' },
};

function $(id) {
  return document.getElementById(id);
}

function sizeForWindow() {
  const shortest = Math.min(window.innerWidth || 1100, window.innerHeight || 760);
  if (shortest < 640) return 'compact';
  if (shortest < 820) return 'standard';
  if (shortest < 1100) return 'large';
  return 'xlarge';
}

function applyIconSize(sizeKey) {
  const size = SIZES[sizeKey] || SIZES.large;
  const root = document.documentElement;
  root.style.setProperty('--icon-card-size', size.card);
  root.style.setProperty('--icon-svg-size', size.svg);
  root.style.setProperty('--icon-radius', size.radius);
  root.style.setProperty('--progress-width', size.progress);
  root.style.setProperty('--progress-margin-top', size.mt);
}

function applyPalette(name) {
  const palette = PALETTES[name] || PALETTES.frost;
  const root = document.documentElement;
  root.dataset.palette = PALETTES[name] ? name : 'frost';
  const s1 = $('gradStop1');
  const s2 = $('gradStop2');
  const s3 = $('gradStop3');
  if (s1) s1.setAttribute('stop-color', palette.start);
  if (s2) {
    s2.setAttribute('stop-color', palette.mid);
    s2.setAttribute('offset', `${Math.round(palette.midStop * 100)}%`);
  }
  if (s3) s3.setAttribute('stop-color', palette.end);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

function setCaption(text) {
  const caption = $('statusCaption');
  if (!caption || caption.textContent === text) return;
  caption.style.opacity = '0';
  window.setTimeout(() => {
    caption.textContent = text;
    caption.style.opacity = '1';
  }, 120);
}

function setProgress(pct, message) {
  const fill = $('progressFill');
  if (fill) fill.style.width = `${Math.min(100, Math.max(0, Number(pct) || 0))}%`;
  if (message) setCaption(message);
}

function startSequence() {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const squircle = $('iconSquircle');
  const logo = $('logoSvg');
  const seed = $('seedPoint');
  const progress = $('progressContainer');
  const stage = $('launchStage');
  if (stage) stage.classList.remove('dismissed');
  /* HTML ships the classes so a paint before this module is not a blank
   * window. Once the Electron window is actually visible we strip and reflow
   * so the blossom plays for the user instead of finishing while hidden. */
  const replay = () => {
    for (const node of [squircle, progress, logo, seed]) {
      node?.classList.remove('materialize', 'blossom', 'ignited');
    }
    void document.body?.offsetWidth;
    squircle?.classList.add('materialize');
    seed?.classList.add('ignited');
    logo?.classList.add('blossom');
    progress?.classList.add('materialize');
  };
  if (reduced) {
    squircle?.classList.add('materialize');
    progress?.classList.add('materialize');
    logo?.classList.add('blossom');
    seed?.classList.add('ignited');
    return;
  }
  replay();
}

function dismiss() {
  const stage = $('launchStage');
  if (!stage || stage.classList.contains('dismissed')) return Promise.resolve();
  stage.classList.add('dismissed');
  return new Promise((resolve) => window.setTimeout(resolve, 280));
}

export function createLaunchOverlay() {
  applyIconSize(sizeForWindow());
  window.addEventListener('resize', () => applyIconSize(sizeForWindow()));
  return {
    applyAppearance({ palette, theme } = {}) {
      applyPalette(palette || 'frost');
      applyTheme(theme || 'dark');
    },
    setProgress,
    startSequence,
    dismiss,
    ready() {
      setProgress(100, '准备就绪');
      return dismiss();
    },
  };
}
