// Content script: botão flutuante (só em sites ativados), painel de revisão e
// aplicação das correções.
//
// REGRA DE PRIVACIDADE: este script nunca lê o texto para enviá-lo por conta
// própria. O único caminho que abre a porta 'aitr-review' é startReview(), chamado
// apenas (a) pelo clique confiável (isTrusted) no botão flutuante ou (b) pela
// mensagem 'aitr:trigger' que o service worker envia após o atalho ou o menu.
(() => {
  'use strict';
  if (window.__aitr) return;
  window.__aitr = true;

  const Core = globalThis.AITRCore;
  const LABELS = { ortografia: 'Ortografia', gramatica: 'Gramática', clareza: 'Clareza', outro: 'Outro' };
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel']);

  // =====================================================================
  // Alvo da revisão
  // =====================================================================

  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function isTextField(el) {
    if (el instanceof HTMLTextAreaElement) return true;
    return el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type);
  }

  function isSensitiveField(el) {
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return false;
    if (el instanceof HTMLInputElement && el.type === 'password') return true;
    return /^(cc-|one-time-code|current-password|new-password)/.test(el.getAttribute('autocomplete') || '');
  }

  function editingHostOf(node) {
    let el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
    if (!el || !el.isContentEditable) return null;
    while (el.parentElement && el.parentElement.isContentEditable) el = el.parentElement;
    return el;
  }

  function blockOf(node) {
    let el = node.parentElement;
    while (el) {
      const d = getComputedStyle(el).display;
      if (!d.startsWith('inline') && d !== 'contents') return el;
      el = el.parentElement;
    }
    return document.documentElement;
  }

  // Texto de um trecho de contenteditable, com '\n' virtuais entre blocos e <br>.
  // O nbsp vira espaço comum (mesmo comprimento) para o modelo casar os trechos.
  function buildMap(range) {
    const top = range.commonAncestorContainer;
    const walker = document.createTreeWalker(
      top.nodeType === Node.ELEMENT_NODE ? top : top.parentNode,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT
    );
    const segs = [];
    const virtual = new Set();
    let text = '';
    let lastBlock = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!range.intersectsNode(n)) continue;
      if (n.nodeType === Node.ELEMENT_NODE) {
        if (n.tagName === 'BR') {
          virtual.add(text.length);
          text += '\n';
        }
        continue;
      }
      let s = 0;
      let e = n.data.length;
      if (n === range.startContainer) s = range.startOffset;
      if (n === range.endContainer) e = range.endOffset;
      if (e <= s) continue;
      const data = n.data.slice(s, e);
      if (/^\s+$/.test(data) && data.includes('\n')) continue; // espaço de formatação do HTML
      const block = blockOf(n);
      if (lastBlock && block !== lastBlock && text && !text.endsWith('\n')) {
        virtual.add(text.length);
        text += '\n';
      }
      lastBlock = block;
      segs.push({ node: n, nodeStart: s, textStart: text.length, textEnd: text.length + (e - s) });
      text += data.replace(/ /g, ' '); // o regex casa U+00A0 (nbsp): vira espaço comum, mesmo comprimento
    }
    return { text, segs, virtual };
  }

  function domPoint(map, i, isEnd) {
    for (const s of map.segs) {
      const inside = isEnd ? i > s.textStart && i <= s.textEnd : i >= s.textStart && i < s.textEnd;
      if (inside) return { node: s.node, offset: s.nodeStart + i - s.textStart };
    }
    return null;
  }

  function fullRange(host) {
    const r = document.createRange();
    r.selectNodeContents(host);
    return r;
  }

  function makeEditableTarget(host, selRange) {
    const map = buildMap(fullRange(host));
    let rs = 0;
    let re = map.text.length;
    if (selRange) {
      const upTo = (container, offset) => {
        const r = document.createRange();
        r.setStart(host, 0);
        r.setEnd(container, offset);
        return buildMap(r).text.length;
      };
      rs = upTo(selRange.startContainer, selRange.startOffset);
      re = upTo(selRange.endContainer, selRange.endOffset);
    }
    const region = map.text.slice(rs, re);
    const trimmed = region.trimStart();
    rs += region.length - trimmed.length;
    re = rs + trimmed.trimEnd().length;
    return {
      kind: 'editable',
      el: host,
      rs,
      re,
      makeHighlighter(a, b) {
        const m = buildMap(fullRange(host));
        const p1 = domPoint(m, a, false);
        const p2 = domPoint(m, b, true);
        if (!p1 || !p2) return null;
        const r = document.createRange();
        r.setStart(p1.node, p1.offset);
        r.setEnd(p2.node, p2.offset);
        return rangeHighlighter(host, r);
      },
      getText: () => buildMap(fullRange(host)).text,
      replaceRange(a, b, str) {
        const m = buildMap(fullRange(host));
        const p1 = domPoint(m, a, false);
        const p2 = domPoint(m, b, true);
        if (!p1 || !p2) return false;
        for (let i = a; i < b; i++) if (m.virtual.has(i)) return false;
        const r = document.createRange();
        r.setStart(p1.node, p1.offset);
        r.setEnd(p2.node, p2.offset);
        host.focus({ preventScroll: true });
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        return document.execCommand('insertText', false, str);
      },
    };
  }

  // ---------- destaque do trecho na página ----------
  // Retângulos de tela do trecho [a, b) de um textarea/input, medidos com um
  // "espelho" invisível que copia a tipografia do campo.
  const FIELD_STYLE_PROPS = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch', 'letterSpacing',
    'wordSpacing', 'textTransform', 'textIndent', 'textAlign', 'lineHeight', 'tabSize', 'direction',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'wordBreak',
  ];

  function measureField(el, a, b) {
    const cs = getComputedStyle(el);
    const isInput = el instanceof HTMLInputElement;
    const mirror = document.createElement('div');
    const s = mirror.style;
    for (const p of FIELD_STYLE_PROPS) s[p] = cs[p];
    s.position = 'absolute';
    s.visibility = 'hidden';
    s.top = '0';
    s.left = '-99999px';
    s.boxSizing = 'border-box';
    s.width = el.clientWidth + 'px';
    s.height = 'auto';
    s.border = '0';
    s.overflow = 'visible';
    s.whiteSpace = isInput ? 'pre' : 'pre-wrap';
    s.overflowWrap = 'break-word';
    const v = el.value;
    const span = document.createElement('span');
    span.textContent = v.slice(a, b) || '​'; // o literal é U+200B (espaço de largura zero), para medir trecho vazio
    mirror.append(document.createTextNode(v.slice(0, a)), span, document.createTextNode(v.slice(b)));
    (document.body || document.documentElement).appendChild(mirror);
    const m = mirror.getBoundingClientRect();
    const out = [...span.getClientRects()].map((r) => ({
      x: r.left - m.left,
      y: isInput ? (el.clientHeight - r.height) / 2 : r.top - m.top,
      w: r.width,
      h: r.height,
    }));
    mirror.remove();
    return out;
  }

  function fieldScreenRects(el, a, b) {
    const box = el.getBoundingClientRect();
    const x0 = box.left + el.clientLeft;
    const y0 = box.top + el.clientTop;
    const out = [];
    for (const r of measureField(el, a, b)) {
      const left = Math.max(x0, x0 + r.x - el.scrollLeft);
      const top = Math.max(y0, y0 + r.y - el.scrollTop);
      const right = Math.min(x0 + el.clientWidth, x0 + r.x + r.w - el.scrollLeft);
      const bottom = Math.min(y0 + el.clientHeight, y0 + r.y + r.h - el.scrollTop);
      if (right > left && bottom > top) out.push({ left, top, width: right - left, height: bottom - top });
    }
    return out;
  }

  function revealInField(el, a, b) {
    const r = measureField(el, a, b)[0];
    if (!r) return;
    if (r.y < el.scrollTop || r.y + r.h > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, r.y - el.clientHeight / 3);
    if (r.x < el.scrollLeft || r.x + r.w > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.max(0, r.x - el.clientWidth / 3);
  }

  function rangeHighlighter(el, range) {
    const start = range.startContainer;
    return {
      el,
      anchor: start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement,
      reveal() {},
      rects: () => [...range.getClientRects()],
    };
  }

  function makeFieldTarget(el, from, to) {
    return {
      kind: 'field',
      el,
      rs: from,
      re: to,
      makeHighlighter: (a, b) => ({
        el,
        anchor: el,
        reveal: () => revealInField(el, a, b),
        rects: () => fieldScreenRects(el, a, b),
      }),
      getText: () => el.value,
      replaceRange(a, b, str) {
        el.focus({ preventScroll: true });
        el.setSelectionRange(a, b);
        if (document.execCommand('insertText', false, str)) return true;
        el.setRangeText(str, a, b, 'end');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: str }));
        return true;
      },
    };
  }

  function resolveTarget() {
    const active = deepActive();

    if (ui.host && active === ui.host && review && review.target) {
      return review.target; // painel com foco: revisar de novo o mesmo alvo
    }
    if (isSensitiveField(active)) {
      return { error: 'Campos de senha e de pagamento nunca são lidos.' };
    }
    if (isTextField(active) && !active.readOnly && !active.disabled) {
      const s = active.selectionStart;
      const e = active.selectionEnd;
      const hasSel = s != null && e != null && s !== e;
      return makeFieldTarget(active, hasSel ? s : 0, hasSel ? e : active.value.length);
    }

    const sel = window.getSelection();
    const range = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null;
    const host = editingHostOf(active) || (range && editingHostOf(range.commonAncestorContainer));
    if (host) {
      const inside = range && host.contains(range.commonAncestorContainer) ? range : null;
      return makeEditableTarget(host, inside);
    }
    const selected = sel && !sel.isCollapsed ? sel.toString() : '';
    if (selected.trim()) {
      const t = selected;
      const src = sel.getRangeAt(0).cloneRange();
      return {
        kind: 'readonly',
        rs: 0,
        re: t.length,
        getText: () => t,
        replaceRange: null,
        // melhor esforço: procura o trecho no texto do DOM da seleção original
        makeHighlighter(a, b, original) {
          const m = buildMap(src);
          let idx = -1;
          for (let i = m.text.indexOf(original); i !== -1; i = m.text.indexOf(original, i + 1)) {
            if (idx === -1 || Math.abs(i - a) < Math.abs(idx - a)) idx = i;
          }
          if (idx === -1) return null;
          const p1 = domPoint(m, idx, false);
          const p2 = domPoint(m, idx + original.length, true);
          if (!p1 || !p2) return null;
          const r = document.createRange();
          r.setStart(p1.node, p1.offset);
          r.setEnd(p2.node, p2.offset);
          return rangeHighlighter(null, r);
        },
      };
    }
    return { error: 'Nada para revisar: foque um campo de texto ou selecione um trecho.' };
  }

  // =====================================================================
  // Interface (Shadow DOM)
  // =====================================================================

  const ui = { host: null, root: null, button: null, panel: null, body: null, footer: null, meta: null, overlay: null };
  let hl = null; // destaque atual: { el, reveal(), rects() }
  let review = null;
  let siteEnabled = false;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .overlay { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; pointer-events: none; }
    .hl { position: fixed; pointer-events: none; border-radius: 3px; background: rgba(255, 214, 0, .4);
      outline: 2px solid #f59e0b; box-shadow: 0 0 0 4px rgba(245, 158, 11, .25); }
    .fab { position: fixed; width: 30px; height: 30px; border-radius: 50%; border: 0; padding: 0;
      background: #4f46e5; color: #fff; font-size: 15px; line-height: 30px; text-align: center; cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,.35); display: none; }
    .fab:hover { background: #4338ca; }
    .panel { position: fixed; right: 16px; bottom: 16px; width: 400px; max-width: calc(100vw - 32px);
      max-height: min(70vh, 620px); display: none; flex-direction: column; background: #fff; color: #1f2430;
      border: 1px solid #d5d8e0; border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,.28); outline: none;
      font-size: 13px; line-height: 1.4; }
    .panel.open { display: flex; }
    header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #e6e8ee; }
    header strong { font-size: 14px; }
    .meta { flex: 1; color: #6b7280; font-size: 12px; }
    .body { overflow-y: auto; padding: 10px 12px; flex: 1; }
    footer { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 12px; border-top: 1px solid #e6e8ee; }
    button { font: inherit; cursor: pointer; }
    .btn { border: 1px solid #c7cad4; background: #f5f6fa; color: inherit; border-radius: 7px; padding: 5px 10px; }
    .btn:hover { background: #eceef5; }
    .btn.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
    .btn.primary:hover { background: #4338ca; }
    .btn:disabled { opacity: .45; cursor: default; }
    .x { border: 0; background: transparent; font-size: 16px; color: #6b7280; padding: 2px 6px; }
    .note { color: #6b7280; font-size: 12px; margin: 0 0 8px; }
    .warn { background: #fff7e0; border: 1px solid #f0d58a; border-radius: 6px; padding: 6px 8px; margin: 0 0 8px; }
    .err { background: #fdecec; border: 1px solid #f3b4b4; border-radius: 6px; padding: 8px; }
    .item { border: 1px solid #e3e5ec; border-radius: 8px; padding: 8px; margin-bottom: 8px; }
    .item.current { border-color: #4f46e5; box-shadow: 0 0 0 1px #4f46e5; }
    .item.done { opacity: .5; }
    .tag { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 10px; background: #e8e9fb; color: #3730a3; }
    .tag.gramatica { background: #fde8f1; color: #9d174d; }
    .tag.clareza { background: #e0f4ec; color: #065f46; }
    .snip { margin: 6px 0; word-break: break-word; white-space: pre-wrap; }
    .ctx { color: #6b7280; }
    del { background: #fdd; text-decoration: line-through; }
    ins { background: #d6f5dc; text-decoration: none; }
    .why { color: #4b5563; margin-bottom: 6px; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .state { font-size: 12px; color: #6b7280; }
    .keys { color: #9ca3af; font-size: 11px; margin: 4px 0 0; }
    .panel.left { right: auto; left: 16px; }
    .explain { margin: 6px 0; padding: 8px 10px; border-left: 3px solid #4f46e5; background: rgba(79, 70, 229, .08);
      border-radius: 0 6px 6px 0; white-space: pre-wrap; word-break: break-word; display: flex; gap: 8px; align-items: flex-start; }
    .explain .errtxt { color: #b91c1c; }
    .spinner.sm { width: 12px; height: 12px; border-width: 2px; margin-top: 3px; }
    .loading { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
    .spinner { width: 20px; height: 20px; flex: none; border-radius: 50%; border: 3px solid #d5d8e0;
      border-top-color: #4f46e5; animation: aitr-spin .8s linear infinite; }
    @keyframes aitr-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } }
    @media (prefers-color-scheme: dark) {
      .panel { background: #1e2028; color: #e6e8ee; border-color: #3a3d4a; }
      header, footer { border-color: #33363f; }
      .btn { background: #2b2e39; border-color: #444857; }
      .btn:hover { background: #343846; }
      .item { border-color: #3a3d4a; }
      .warn { background: #3a3218; border-color: #6b5a22; }
      .err { background: #3b1f1f; border-color: #6e3333; }
      del { background: #5b2a2a; } ins { background: #23492b; }
      .spinner { border-color: #444857; border-top-color: #8b85ff; }
      .explain .errtxt { color: #f87171; }
      .why { color: #b4b8c5; } .tag { background: #2f2f5c; color: #c7c9ff; }
    }
  `;

  function ensureUI() {
    if (ui.host) return;
    ui.host = document.createElement('div');
    ui.host.setAttribute('data-aitr', '');
    ui.host.style.cssText = 'all:initial;position:fixed;top:0;left:0;z-index:2147483647;';
    ui.root = ui.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;

    ui.button = el('button', { class: 'fab', title: 'Revisar texto (Alt+Shift+R)', 'aria-label': 'Revisar texto' }, '✎');
    ui.button.addEventListener('mousedown', (e) => e.preventDefault()); // mantém foco e seleção
    ui.button.addEventListener('click', (e) => {
      if (!e.isTrusted) return; // só um clique real do usuário dispara a revisão
      startReview();
    });

    ui.meta = el('span', { class: 'meta' });
    const close = el('button', { class: 'x', 'aria-label': 'Fechar' }, '✕');
    close.addEventListener('click', closeReview);
    ui.body = el('div', { class: 'body' });
    ui.footer = el('footer');
    ui.panel = el('div', { class: 'panel', tabindex: '-1', role: 'dialog', 'aria-label': 'Revisão de texto' },
      el('header', {}, el('strong', {}, 'Revisão de texto'), ui.meta, close), ui.body, ui.footer);
    ui.panel.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) e.preventDefault(); // botões não roubam o foco do painel
    });
    ui.panel.addEventListener('keydown', onPanelKey);

    ui.overlay = el('div', { class: 'overlay' });
    ui.root.append(style, ui.overlay, ui.button, ui.panel);
    document.documentElement.appendChild(ui.host);
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  function btn(label, onClick, cls) {
    const b = el('button', { class: 'btn' + (cls ? ' ' + cls : ''), tabindex: '-1' }, label);
    b.addEventListener('click', (e) => {
      if (e.isTrusted) onClick();
    });
    return b;
  }

  // ---------- botão flutuante ----------

  function buttonAnchor() {
    const active = deepActive();
    if (active === ui.host) return null;
    if (isSensitiveField(active)) return null;
    if ((isTextField(active) && !active.readOnly && !active.disabled) || editingHostOf(active)) {
      const r = active.getBoundingClientRect();
      if (r.width < 40 || r.height < 16) return null;
      return { x: r.right - 34, y: r.bottom - 34 };
    }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount && sel.toString().trim()) {
      const rects = sel.getRangeAt(0).getClientRects();
      const last = rects[rects.length - 1];
      if (last) return { x: last.right + 4, y: last.bottom + 4 };
    }
    return null;
  }

  let rafPending = false;
  function scheduleButtonUpdate() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      updateButton();
      if (hl) {
        try {
          drawHighlight(); // reposiciona ao rolar/redimensionar
        } catch (e) {
          clearHighlight();
        }
      }
    });
  }

  function updateButton() {
    if (!siteEnabled) {
      if (ui.button) ui.button.style.display = 'none';
      return;
    }
    const a = buttonAnchor();
    if (!a) {
      if (ui.button) ui.button.style.display = 'none';
      return;
    }
    ensureUI();
    const x = Math.max(4, Math.min(a.x, window.innerWidth - 36));
    const y = Math.max(4, Math.min(a.y, window.innerHeight - 36));
    ui.button.style.cssText = `display:block;left:${x}px;top:${y}px;`;
  }

  // ---------- destaque da sugestão atual ----------

  function drawHighlight() {
    if (!ui.overlay) return;
    ui.overlay.replaceChildren();
    if (!hl) return;
    for (const r of hl.rects()) {
      if (r.width < 1 || r.height < 1) continue;
      const box = el('div', { class: 'hl' });
      box.style.cssText = `left:${r.left - 2}px;top:${r.top - 1}px;width:${r.width + 4}px;height:${r.height + 2}px;`;
      ui.overlay.append(box);
    }
  }

  function clearHighlight() {
    hl = null;
    if (ui.overlay) ui.overlay.replaceChildren();
  }

  function allRects() {
    return (hl ? hl.rects() : [])
      .filter((r) => r.width >= 1 && r.height >= 1)
      .map((r) => ({ left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height }));
  }

  const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

  function isScrollable(n) {
    return /(auto|scroll|overlay)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1;
  }

  function panelRect() {
    return ui.panel && ui.panel.classList.contains('open') ? ui.panel.getBoundingClientRect() : null;
  }

  // Rola (campo interno, áreas roláveis e página) até o trecho ficar no terço superior da janela.
  // Só rola quando ele está fora da zona confortável (topo até 60% da altura) ou coberto pelo painel.
  function revealHighlight() {
    hl.reveal();
    for (let n = hl.anchor; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (!isScrollable(n)) continue;
      const r = allRects()[0];
      if (!r) return;
      const box = n.getBoundingClientRect();
      const top = Math.max(box.top, 0);
      const h = Math.min(box.bottom, window.innerHeight) - top;
      if (r.top < top + 8 || r.bottom > top + h * 0.6) {
        n.scrollTo({ top: n.scrollTop + r.top - (top + h / 3), behavior: 'instant' });
      }
    }
    const r = allRects()[0];
    if (!r) return;
    const p = panelRect();
    if (r.top < 8 || r.bottom > window.innerHeight * 0.6 || (p && allRects().some((x) => intersects(x, p)))) {
      window.scrollBy({ top: r.top - window.innerHeight / 3, behavior: 'instant' });
    }
  }

  // Se o painel ainda cobre o trecho, passa para o outro lado da janela.
  function avoidPanel() {
    ui.panel.classList.remove('left');
    const rects = allRects();
    if (!rects.length) return;
    if (!rects.some((r) => intersects(r, ui.panel.getBoundingClientRect()))) return;
    ui.panel.classList.add('left');
    if (rects.some((r) => intersects(r, ui.panel.getBoundingClientRect()))) ui.panel.classList.remove('left');
  }

  // Marca na página o trecho da sugestão atual (se ainda pendente) e o traz para a vista.
  function updateHighlight() {
    clearHighlight();
    const r = review;
    if (!r || r.phase !== 'result') return;
    const c = r.changes[r.current];
    const t = r.target;
    if (!c || c.status !== 'pending' || !t.makeHighlighter) return;
    try {
      const pos = locate(t.getText().slice(t.rs, t.re), c);
      if (pos < 0) return;
      const abs = t.rs + pos;
      hl = t.makeHighlighter(abs, abs + c.original.length, c.original);
      if (!hl) return;
      revealHighlight();
      drawHighlight();
      avoidPanel();
    } catch (e) {
      clearHighlight(); // o destaque é um extra: nunca deve quebrar o painel
    }
  }

  // ---------- painel ----------

  function openPanel() {
    ensureUI();
    ui.panel.classList.add('open');
    ui.panel.focus({ preventScroll: true });
  }

  function closeReview() {
    stopLoadingTimer();
    clearHighlight();
    if (review) {
      for (const p of review.explainPorts || []) {
        try {
          p.disconnect();
        } catch (e) {
          /* já desconectada */
        }
      }
      review.cancelled = true;
      try {
        review.port && review.port.disconnect();
      } catch (e) {
        /* já desconectada */
      }
    }
    review = null;
    if (ui.panel) ui.panel.classList.remove('open');
    scheduleButtonUpdate();
  }

  function setMeta(text) {
    ui.meta.textContent = text || '';
  }

  let loadingTimer = null;
  function stopLoadingTimer() {
    clearInterval(loadingTimer);
    loadingTimer = null;
  }

  function renderLoading(chars, warn) {
    stopLoadingTimer();
    ui.body.replaceChildren();
    if (warn) ui.body.append(el('p', { class: 'warn' }, warn));
    const elapsed = el('span', {}, '0s');
    ui.body.append(
      el('div', { class: 'loading', role: 'status', 'aria-live': 'polite' },
        el('div', { class: 'spinner' }),
        el('span', {}, `Revisando ${chars} caracteres… `, elapsed))
    );
    const t0 = Date.now();
    loadingTimer = setInterval(() => {
      elapsed.textContent = `${Math.floor((Date.now() - t0) / 1000)}s`;
    }, 1000);
    ui.footer.replaceChildren(btn('Cancelar', closeReview));
  }

  function renderError(message, code) {
    stopLoadingTimer();
    clearHighlight();
    openPanel();
    setMeta('');
    ui.body.replaceChildren(el('div', { class: 'err' }, message));
    const buttons = [];
    if (['no-key', 'auth', 'no-bridge', 'no-claude', 'cli-auth'].includes(code)) {
      buttons.push(btn('Abrir configurações', () => chrome.runtime.sendMessage({ type: 'aitr:open-options' }), 'primary'));
    }
    buttons.push(btn('Fechar', closeReview));
    ui.footer.replaceChildren(...buttons);
  }

  function snippet(item) {
    const text = review.baseText;
    const clean = (s) => s.replace(/\n/g, '↵');
    const before = clean(text.slice(Math.max(0, item.start - 28), item.start));
    const after = clean(text.slice(item.end, item.end + 28));
    const p = el('div', { class: 'snip' });
    p.append(
      el('span', { class: 'ctx' }, (item.start > 28 ? '…' : '') + before),
      el('del', {}, clean(item.original)),
      ' ',
      el('ins', {}, clean(item.replacement)),
      el('span', { class: 'ctx' }, after + (item.end + 28 < text.length ? '…' : ''))
    );
    return p;
  }

  function renderResult() {
    stopLoadingTimer();
    const r = review;
    const canApply = !!r.target.replaceRange;
    const pending = r.changes.filter((c) => c.status === 'pending').length;

    const wl = r.whitelist.enabled ? `ligada (${r.whitelist.count})` : 'desligada';
    setMeta(`${r.changes.length} sugestões · lista de exceções ${wl}`);
    ui.body.replaceChildren();

    if (r.warn) ui.body.append(el('p', { class: 'warn' }, r.warn));
    if (r.ignoredByWhitelist) {
      ui.body.append(el('p', { class: 'note' }, `${r.ignoredByWhitelist} sugestão(ões) descartada(s) pela lista de exceções.`));
    }
    if (!canApply) {
      ui.body.append(el('p', { class: 'note' }, 'Texto somente leitura: copie o texto corrigido.'));
    }
    if (!r.changes.length) {
      ui.body.append(el('p', { class: 'note' }, 'Nenhum problema encontrado. ✓'));
    }

    r.changes.forEach((c, i) => {
      const done = c.status !== 'pending';
      const item = el('div', { class: 'item' + (i === r.current && !done ? ' current' : '') + (done ? ' done' : '') });
      item.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        r.current = i;
        renderResult();
      });
      item.append(el('span', { class: 'tag ' + c.category }, LABELS[c.category] || 'Outro'), snippet(c));
      if (c.explanation) item.append(el('div', { class: 'why' }, c.explanation));
      if (c.explainOpen) item.append(explainBox(c));
      const actions = el('div', { class: 'actions' });
      if (!done) {
        if (canApply) actions.append(btn('Aplicar', () => act(() => applyOne(i)), 'primary'));
        actions.append(btn(explainLabel(c), () => toggleExplain(i)));
        actions.append(btn('Rejeitar', () => act(() => (c.status = 'dismissed'))));
        actions.append(btn('Ignorar sempre', () => act(() => ignoreForever(i))));
      } else {
        actions.append(el('span', { class: 'state' }, STATUS_TEXT[c.status] || ''));
      }
      item.append(actions);
      ui.body.append(item);
    });
    if (pending) ui.body.append(el('p', { class: 'keys' }, 'Enter aplica · ↑/↓ navega · E explica · Delete rejeita · Ctrl+Enter aplica tudo · Esc fecha'));

    const foot = [];
    if (canApply && pending) foot.push(btn('Aplicar tudo', () => act(applyAll), 'primary'));
    foot.push(btn('Copiar texto corrigido', copyCorrected));
    foot.push(btn('Fechar', closeReview));
    ui.footer.replaceChildren(...foot);

    const cur = ui.body.querySelector('.item.current');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
    updateHighlight();
  }

  // ---------- "Me explica" ----------
  // Só roda por um clique do usuário no botão (ou a tecla E no painel): uma chamada extra ao modelo.

  function explainLabel(c) {
    if (c.explainState === 'error') return 'Tentar de novo';
    return c.explainOpen ? 'Ocultar explicação' : 'Me explica';
  }

  function explainBox(c) {
    const box = el('div', { class: 'explain', role: 'status' });
    if (c.explainState === 'loading') {
      box.append(el('div', { class: 'spinner sm' }), el('span', {}, 'Explicando…'));
    } else if (c.explainState === 'error') {
      box.append(el('span', { class: 'errtxt' }, c.explainError));
    } else {
      box.textContent = c.explainText;
    }
    return box;
  }

  function toggleExplain(i) {
    const r = review;
    const c = r.changes[i];
    r.current = i;
    if (c.explainState === 'done' || c.explainState === 'loading') {
      c.explainOpen = !c.explainOpen; // já explicada: só mostra/oculta, sem gastar tokens
      renderResult();
    } else {
      requestExplain(c);
    }
    ui.panel.focus({ preventScroll: true });
  }

  function requestExplain(c) {
    const r = review;
    c.explainOpen = true;
    c.explainState = 'loading';
    c.explainError = '';
    let port;
    try {
      port = chrome.runtime.connect({ name: 'aitr-review' });
    } catch (e) {
      c.explainState = 'error';
      c.explainError = 'A extensão foi recarregada. Recarregue a página e tente de novo.';
      return renderResult();
    }
    r.explainPorts.add(port);
    const finish = (state) => {
      r.explainPorts.delete(port);
      try {
        port.disconnect();
      } catch (e) {
        /* já desconectada */
      }
      c.explainState = state;
      if (review === r) renderResult();
    };
    port.onMessage.addListener((msg) => {
      if (msg.type === 'explanation') {
        c.explainText = msg.text || 'Sem explicação disponível.';
        finish('done');
      } else if (msg.type === 'error') {
        c.explainError = msg.message;
        finish('error');
      }
    });
    port.onDisconnect.addListener(() => {
      if (c.explainState !== 'loading') return;
      r.explainPorts.delete(port);
      c.explainState = 'error';
      c.explainError = 'A conexão com a extensão foi interrompida.';
      if (review === r) renderResult();
    });
    port.postMessage({ type: 'explain', explanation: c.explanation || `${c.original} → ${c.replacement}` });
    renderResult();
  }

  const STATUS_TEXT = {
    applied: 'Aplicada ✓',
    dismissed: 'Rejeitada',
    ignored: 'Adicionada à lista de exceções',
    stale: 'O texto mudou; não foi possível aplicar',
    failed: 'Não foi possível aplicar neste campo (use "Copiar texto corrigido")',
  };

  function act(fn) {
    if (!review) return;
    fn();
    advance();
    renderResult();
    ui.panel.focus({ preventScroll: true });
  }

  function advance() {
    const r = review;
    const n = r.changes.length;
    for (let k = 0; k < n; k++) {
      const i = (r.current + k) % n;
      if (r.changes[i].status === 'pending') {
        r.current = i;
        return;
      }
    }
  }

  function move(dir) {
    const r = review;
    const n = r.changes.length;
    for (let k = 1; k <= n; k++) {
      const i = (r.current + dir * k + n * k) % n;
      if (r.changes[i].status === 'pending') {
        r.current = i;
        return;
      }
    }
  }

  function onPanelKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeReview();
      return;
    }
    if (!review || review.phase !== 'result' || e.target.closest('button')) return;
    const r = review;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (r.target.replaceRange) act(applyAll);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (r.target.replaceRange && r.changes[r.current]?.status === 'pending') act(() => applyOne(r.current));
    } else if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      move(1);
      renderResult();
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      move(-1);
      renderResult();
    } else if (e.key === 'e' || e.key === 'E') {
      e.preventDefault();
      if (r.changes[r.current]?.status === 'pending') toggleExplain(r.current);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (r.changes[r.current]?.status === 'pending') act(() => (r.changes[r.current].status = 'dismissed'));
    }
  }

  // ---------- aplicar correções ----------

  // Posição atual do trecho, considerando o que já foi aplicado; se o texto
  // mudou por fora, aceita só uma ocorrência única do original.
  function locate(region, c) {
    const shift = review.applied.filter((a) => a.start < c.start).reduce((s, a) => s + a.delta, 0);
    const pos = c.start + shift;
    if (region.substr(pos, c.original.length) === c.original) return pos;
    const first = region.indexOf(c.original);
    if (first !== -1 && region.indexOf(c.original, first + 1) === -1) return first;
    return -1;
  }

  function applyOne(i) {
    const c = review.changes[i];
    const t = review.target;
    if (c.status !== 'pending' || !t.replaceRange) return false;
    const pos = locate(t.getText().slice(t.rs, t.re), c);
    if (pos < 0) {
      c.status = 'stale';
      return false;
    }
    const abs = t.rs + pos;
    let ok = false;
    try {
      ok = t.replaceRange(abs, abs + c.original.length, c.replacement);
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      c.status = 'failed';
      return false;
    }
    const delta = c.replacement.length - c.original.length;
    review.applied.push({ start: c.start, delta });
    t.re += delta;
    c.status = 'applied';
    return true;
  }

  function applyAll() {
    const idx = review.changes.map((c, i) => i).filter((i) => review.changes[i].status === 'pending');
    for (const i of idx.reverse()) applyOne(i); // do fim para o começo: os deslocamentos não interferem
  }

  async function ignoreForever(i) {
    const c = review.changes[i];
    const term = c.original.trim();
    c.status = 'ignored';
    try {
      const { whitelist } = await chrome.storage.sync.get({ whitelist: [] });
      if (!whitelist.some((w) => w.toLowerCase() === term.toLowerCase())) {
        await chrome.storage.sync.set({ whitelist: [...whitelist, term] });
        review.whitelist.count += 1;
      }
    } catch (e) {
      c.status = 'failed';
    }
    if (review) renderResult();
  }

  function correctedText() {
    const t = review.target;
    let region = t.getText().slice(t.rs, t.re);
    const pend = review.changes
      .filter((c) => c.status === 'pending')
      .map((c) => ({ pos: locate(region, c), c }))
      .filter((x) => x.pos >= 0)
      .sort((a, b) => b.pos - a.pos);
    for (const { pos, c } of pend) {
      region = region.slice(0, pos) + c.replacement + region.slice(pos + c.original.length);
    }
    return region;
  }

  async function copyCorrected() {
    const text = correctedText();
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;';
      ui.root.append(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    }
    setMeta(ok ? 'Texto corrigido copiado ✓' : 'Não foi possível copiar.');
  }

  // ---------- revisão ----------

  async function startReview() {
    const t = resolveTarget();
    if (t.error) {
      openPanel();
      return renderError(t.error, 'target');
    }
    const text = t.getText().slice(t.rs, t.re);
    if (!text.trim()) return renderError('Não há texto para revisar.', 'empty');

    const settings = await chrome.storage.sync.get(Core.DEFAULT_SETTINGS);
    const verdict = Core.checkLength(text.length, settings);
    if (verdict === 'block') {
      return renderError(
        `Texto grande demais (${text.length} caracteres; o limite é ${settings.blockChars}). Selecione um trecho menor e tente de novo.`,
        'too-long'
      );
    }
    const warn = verdict === 'warn' ? `Texto longo (${text.length} caracteres): a revisão pode demorar e custar mais tokens.` : '';

    closeReview();
    ensureUI();
    review = { target: t, baseText: text, changes: [], applied: [], explainPorts: new Set(), current: 0, phase: 'loading', warn, cancelled: false };
    openPanel();
    setMeta('');
    renderLoading(text.length, warn);
    updateButton();

    let port;
    try {
      port = chrome.runtime.connect({ name: 'aitr-review' });
    } catch (e) {
      return renderError('A extensão foi atualizada ou recarregada. Recarregue esta página e tente de novo.', 'context');
    }
    const mine = review;
    mine.port = port;
    port.onMessage.addListener((msg) => {
      if (review !== mine) return;
      if (msg.type === 'error') {
        mine.phase = 'error';
        renderError(msg.message, msg.code);
      } else if (msg.type === 'result') {
        mine.phase = 'result';
        mine.changes = msg.changes.map((c) => ({ ...c, status: 'pending' }));
        mine.whitelist = msg.whitelist;
        mine.ignoredByWhitelist = msg.ignoredByWhitelist;
        mine.current = 0;
        renderResult();
        ui.panel.focus({ preventScroll: true });
      }
    });
    port.onDisconnect.addListener(() => {
      if (review === mine && mine.phase === 'loading') {
        mine.phase = 'error';
        renderError('A conexão com a extensão foi interrompida. Tente de novo.', 'disconnect');
      }
    });
    port.postMessage({ type: 'review', text });
  }

  // =====================================================================
  // Gatilhos e ciclo de vida
  // =====================================================================

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'aitr:trigger') return;
    // Em iframes, só o quadro que tem o foco/seleção reage.
    const t = resolveTarget();
    if (t.error && (window !== window.top || document.activeElement instanceof HTMLIFrameElement)) return;
    startReview();
  });

  async function refreshSiteEnabled() {
    try {
      const { enabledSites } = await chrome.storage.sync.get({ enabledSites: Core.DEFAULT_SETTINGS.enabledSites });
      siteEnabled = Core.siteMatches(location.hostname, enabledSites);
    } catch (e) {
      siteEnabled = false;
    }
    updateButton();
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.enabledSites) refreshSiteEnabled();
    });
  } catch (e) {
    /* contexto invalidado */
  }

  for (const ev of ['focusin', 'focusout', 'selectionchange', 'mouseup', 'keyup', 'scroll', 'resize']) {
    document.addEventListener(ev, scheduleButtonUpdate, true);
  }
  window.addEventListener('resize', scheduleButtonUpdate);
  // Se o usuário edita o campo destacado, as posições ficam obsoletas: some o destaque
  // (ele volta ao navegar ou aplicar uma sugestão).
  document.addEventListener(
    'input',
    (e) => {
      if (hl && hl.el && (hl.el === e.target || hl.el.contains(e.target))) clearHighlight();
    },
    true
  );

  refreshSiteEnabled();
})();
