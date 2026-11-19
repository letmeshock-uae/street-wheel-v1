// HUD: «колесо»-миникарта (пользователь всегда внизу, колесо крутится, шов отмечен дугой) + отладка.
const SVGNS = 'http://www.w3.org/2000/svg';

export class WheelHud {
  private svg: SVGSVGElement;
  private rot: SVGGElement;
  private L: number;

  constructor(root: HTMLElement, L: number, sMax: number, seamWidth: number) {
    this.L = L;
    const R = 46;
    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.setAttribute('viewBox', '-60 -60 120 120');
    this.svg.classList.add('wheel-hud');
    this.svg.innerHTML = `
      <circle r="${R}" class="wh-rim"/>
      <g class="wh-rot"><path class="wh-seam"/></g>
      <circle r="3.2" cy="${R}" class="wh-me"/>`;
    root.appendChild(this.svg);
    this.rot = this.svg.querySelector('.wh-rot')!;
    // шов: дуга вокруг sMax
    const a0 = ((sMax - seamWidth) / L) * Math.PI * 2;
    const a1 = ((sMax + seamWidth) / L) * Math.PI * 2;
    const pt = (a: number) => `${(Math.sin(a) * R).toFixed(2)} ${(Math.cos(a) * R).toFixed(2)}`;
    this.svg.querySelector('.wh-seam')!.setAttribute('d', `M ${pt(a0)} A ${R} ${R} 0 0 0 ${pt(a1)}`);
  }

  update(sCam: number) {
    // точка s рисуется под углом a=s/L·2π от «низа»; поворачиваем так, чтобы sCam была внизу
    const deg = (sCam / this.L) * 360;
    this.rot.setAttribute('transform', `rotate(${deg.toFixed(2)})`);
  }
}

export class DebugHud {
  private el: HTMLElement;
  constructor(root: HTMLElement) {
    this.el = document.createElement('pre');
    this.el.className = 'debug';
    root.appendChild(this.el);
  }
  set(lines: Record<string, string | number>) {
    this.el.textContent = Object.entries(lines)
      .map(([k, v]) => `${k.padEnd(10)} ${v}`)
      .join('\n');
  }
  toggle() {
    this.el.hidden = !this.el.hidden;
  }
  get visible() {
    return !this.el.hidden;
  }
}
