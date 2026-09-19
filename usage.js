(() => {
  'use strict';
  const Core = globalThis.AITRCore;
  const $ = (id) => document.getElementById(id);
  const COUNTS = { day: 30, week: 12, month: 12, year: 5 };
  const PERIOD_TEXT = { day: 'últimos 30 dias', week: 'últimas 12 semanas', month: 'últimos 12 meses', year: 'últimos 5 anos' };
  const NS = 'http://www.w3.org/2000/svg';
  const fmt = (n) => n.toLocaleString('pt-BR');

  let records = [];
  let period = 'day';

  function svg(tag, attrs, text) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  }

  function niceMax(v) {
    if (v <= 0) return 10;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 5, 10]) if (v <= m * p) return m * p;
    return 10 * p;
  }

  function render() {
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-pressed', b.dataset.p === period);
    const series = Core.buildSeries(records, period, COUNTS[period]);
    const sum = (k) => series.reduce((s, b) => s + b[k], 0);

    $('totals').replaceChildren(
      ...[
        ['Revisões', sum('count')],
        ['Tokens de entrada', sum('input')],
        ['Tokens de saída', sum('output')],
        ['Total de tokens', sum('total')],
      ].map(([label, value]) => {
        const d = document.createElement('div');
        const b = document.createElement('b');
        b.textContent = fmt(value);
        d.append(b, label + ' · ' + PERIOD_TEXT[period]);
        return d;
      })
    );
    $('empty').hidden = records.length > 0;

    const W = 720, H = 300, L = 56, R = 8, T = 10, B = 30;
    const max = niceMax(Math.max(...series.map((b) => b.total)));
    const innerW = W - L - R, innerH = H - T - B;
    const slot = innerW / series.length;
    const barW = Math.max(2, slot * 0.7);
    const y = (v) => T + innerH - (v / max) * innerH;

    const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Tokens por ' + period });
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      chart.append(
        svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: 'var(--line)' }),
        svg('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, fmt(Math.round(v)))
      );
    }
    const every = Math.ceil(series.length / 12);
    series.forEach((b, i) => {
      const x = L + i * slot + (slot - barW) / 2;
      const g = svg('g');
      g.append(svg('title', {}, `${b.label}: ${fmt(b.total)} tokens (entrada ${fmt(b.input)}, saída ${fmt(b.output)}) em ${b.count} revisão(ões)`));
      if (b.input) g.append(svg('rect', { x, y: y(b.input), width: barW, height: innerH - (y(b.input) - T), fill: 'var(--in)' }));
      if (b.output) g.append(svg('rect', { x, y: y(b.total), width: barW, height: y(b.input) - y(b.total), fill: 'var(--out)' }));
      // área de toque para o tooltip mesmo em barras vazias/curtas
      g.append(svg('rect', { x: L + i * slot, y: T, width: slot, height: innerH, fill: 'transparent' }));
      chart.append(g);
      if (i % every === 0) chart.append(svg('text', { x: x + barW / 2, y: H - 10, 'text-anchor': 'middle' }, b.label));
    });
    $('chart').replaceChildren(chart);
  }

  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', () => {
      period = b.dataset.p;
      render();
    });
  }

  AITRDB.getAll().then((all) => {
    records = all;
    render();
  });
})();
