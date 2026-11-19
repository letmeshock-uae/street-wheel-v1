// Панель живой настройки: компактная кнопка в углу → слайдеры. Значения применяются на лету,
// запоминаются в этом браузере (localStorage) и копируются JSON-ом — потом их можно вписать в DEFAULTS.

export interface Settings {
  // движение
  driftFar: number;
  driftNear: number;
  speed: number;
  scatterBase: number;
  scatterPerM: number;
  emBand: number;
  arrive: number;
  twinkle: number;
  // проявление
  densNear: number;
  densPow: number;
  farDensity: number;
  partNear: number;
  partFar: number;
  dotPx: number;
  partAlpha: number;
  // камера и скролл
  eye: number;
  pitch: number;
  fov: number;
  exposure: number;
  wheelGain: number;
  smoothing: number;
}

export const DEFAULTS: Settings = {
  driftFar: 1.8,
  driftNear: 0.08,
  speed: 1,
  scatterBase: 0.5,
  scatterPerM: 0.045,
  emBand: 0.25,
  arrive: 1.5,
  twinkle: 0.45,
  densNear: 9,
  densPow: 1.5,
  farDensity: 0.02,
  partNear: 14,
  partFar: 62,
  dotPx: 0.75,
  partAlpha: 0.85,
  eye: 1.7,
  pitch: 0.3,
  fov: 78,
  exposure: 1.15,
  wheelGain: 0.022,
  smoothing: 4.5,
};

interface Field {
  key: keyof Settings;
  label: string;
  min: number;
  max: number;
  step: number;
}

const GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: 'Движение',
    fields: [
      { key: 'driftFar', label: 'Парение вдали, м', min: 0, max: 6, step: 0.1 },
      { key: 'driftNear', label: 'Парение частиц рядом, м', min: 0, max: 0.6, step: 0.01 },
      { key: 'speed', label: 'Скорость парения', min: 0, max: 3, step: 0.05 },
      { key: 'scatterBase', label: 'Разлёт перед сборкой, м', min: 0, max: 3, step: 0.05 },
      { key: 'scatterPerM', label: 'Разлёт: + м на метр дали', min: 0, max: 0.15, step: 0.005 },
      { key: 'emBand', label: 'Доля собирающихся', min: 0.05, max: 0.8, step: 0.01 },
      { key: 'arrive', label: 'Прилёт догруженного, с', min: 0.2, max: 5, step: 0.1 },
      { key: 'twinkle', label: 'Мерцание', min: 0, max: 1, step: 0.05 },
    ],
  },
  {
    title: 'Проявление',
    fields: [
      { key: 'densNear', label: 'Полная детализация, м', min: 2, max: 40, step: 0.5 },
      { key: 'densPow', label: 'Крутизна спада', min: 0.5, max: 3, step: 0.05 },
      { key: 'farDensity', label: 'Плотность вдали', min: 0, max: 0.15, step: 0.005 },
      { key: 'partNear', label: 'Точки начинаются с, м', min: 0, max: 60, step: 1 },
      { key: 'partFar', label: 'Только точки дальше, м', min: 10, max: 200, step: 1 },
      { key: 'dotPx', label: 'Размер точки, px', min: 0.3, max: 3, step: 0.05 },
      { key: 'partAlpha', label: 'Яркость точек', min: 0, max: 1, step: 0.05 },
    ],
  },
  {
    title: 'Камера и скролл',
    fields: [
      { key: 'eye', label: 'Высота глаз, м', min: 0.5, max: 8, step: 0.1 },
      { key: 'pitch', label: 'Наклон вверх, рад', min: -0.3, max: 1.2, step: 0.01 },
      { key: 'fov', label: 'Угол обзора, °', min: 40, max: 110, step: 1 },
      { key: 'exposure', label: 'Экспозиция', min: 0.5, max: 2.5, step: 0.05 },
      { key: 'wheelGain', label: 'Метров на px скролла', min: 0.005, max: 0.08, step: 0.001 },
      { key: 'smoothing', label: 'Отклик скролла', min: 1, max: 15, step: 0.5 },
    ],
  },
];

const STORAGE_KEY = 'street-wheel-tune-v1';
const URL_KEYS: Partial<Record<string, keyof Settings>> = { eye: 'eye', pitch: 'pitch', fov: 'fov', exp: 'exposure' };

/** DEFAULTS ← сохранённое в браузере ← параметры URL (?eye=, ?pitch=, ?fov=, ?exp=) */
export function loadSettings(params: URLSearchParams): Settings {
  const s: Settings = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) if (typeof saved[k] === 'number' && isFinite(saved[k])) s[k] = saved[k];
  } catch {
    /* приватный режим и т.п. — работаем на значениях по умолчанию */
  }
  for (const [p, k] of Object.entries(URL_KEYS)) {
    const v = Number(params.get(p));
    if (params.has(p) && isFinite(v) && k) s[k] = v;
  }
  return s;
}

const decimals = (step: number) => Math.max(0, -Math.floor(Math.log10(step) + 1e-9));

export class TunePanel {
  private btn: HTMLButtonElement;
  private panel: HTMLElement;
  private inputs = new Map<keyof Settings, { input: HTMLInputElement; out: HTMLOutputElement; f: Field }>();

  constructor(root: HTMLElement, private s: Settings, private onChange: () => void) {
    this.btn = document.createElement('button');
    this.btn.className = 'tune-btn';
    this.btn.setAttribute('aria-label', 'Настройки');
    this.btn.setAttribute('aria-expanded', 'false');
    this.btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' +
      '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></g></svg>';
    this.panel = document.createElement('div');
    this.panel.className = 'tune-panel';
    this.panel.hidden = true;
    this.panel.innerHTML =
      '<div class="tune-head"><b>Настройки</b><span><button data-act="copy">Копировать</button><button data-act="reset">Сброс</button></span></div>' +
      GROUPS.map(
        (g, gi) =>
          `<details${gi === 0 ? ' open' : ''}><summary>${g.title}</summary>` +
          g.fields
            .map(
              (f) =>
                `<label class="tune-row" data-key="${f.key}" title="Двойной клик — значение по умолчанию"><span>${f.label}</span><output></output>` +
                `<input type="range" min="${f.min}" max="${f.max}" step="${f.step}"></label>`,
            )
            .join('') +
          '</details>',
      ).join('');
    root.append(this.btn, this.panel);

    for (const g of GROUPS)
      for (const f of g.fields) {
        const row = this.panel.querySelector(`[data-key="${f.key}"]`)!;
        const input = row.querySelector('input')!;
        const out = row.querySelector('output')!;
        this.inputs.set(f.key, { input, out, f });
        input.addEventListener('input', () => this.set(f.key, Number(input.value)));
        row.addEventListener('dblclick', () => this.set(f.key, DEFAULTS[f.key]));
      }
    this.sync();

    this.btn.addEventListener('click', () => this.toggle());
    this.panel.querySelector('[data-act="reset"]')!.addEventListener('click', () => {
      Object.assign(this.s, DEFAULTS);
      this.sync();
      this.changed();
    });
    this.panel.querySelector('[data-act="copy"]')!.addEventListener('click', (e) => {
      const b = e.currentTarget as HTMLButtonElement;
      navigator.clipboard?.writeText(JSON.stringify(this.s, null, 2)).then(
        () => {
          b.textContent = 'Скопировано';
          setTimeout(() => (b.textContent = 'Копировать'), 1400);
        },
        () => {},
      );
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.panel.hidden) this.toggle(false);
    });
  }

  toggle(open = this.panel.hidden) {
    this.panel.hidden = !open;
    this.btn.setAttribute('aria-expanded', String(open));
    this.btn.classList.toggle('is-open', open);
  }

  private set(k: keyof Settings, v: number) {
    this.s[k] = v;
    this.sync(k);
    this.changed();
  }

  private sync(only?: keyof Settings) {
    for (const [k, { input, out, f }] of this.inputs) {
      if (only && k !== only) continue;
      input.value = String(this.s[k]);
      out.textContent = this.s[k].toFixed(decimals(f.step));
      out.classList.toggle('is-changed', Math.abs(this.s[k] - DEFAULTS[k]) > f.step / 2);
    }
  }

  private changed() {
    try {
      const diff: Partial<Settings> = {};
      for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) if (this.s[k] !== DEFAULTS[k]) diff[k] = this.s[k];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(diff));
    } catch {
      /* ignore */
    }
    this.onChange();
  }
}
