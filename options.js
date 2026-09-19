(() => {
  'use strict';
  const Core = globalThis.AITRCore;
  const $ = (id) => document.getElementById(id);

  function flash(id, msg, ok = true) {
    const node = $(id);
    node.textContent = msg;
    node.className = 'status ' + (ok ? 'ok' : 'err');
    if (msg) setTimeout(() => (node.textContent === msg ? (node.textContent = '') : 0), 4000);
  }

  async function save(values, statusId, okMsg = 'Salvo ✓') {
    try {
      await chrome.storage.sync.set(values);
      flash(statusId, okMsg);
      return true;
    } catch (e) {
      flash(statusId, 'Não foi possível salvar (limite do armazenamento sincronizado?): ' + e.message, false);
      return false;
    }
  }

  let settings = { ...Core.DEFAULT_SETTINGS };

  // ---------- motor ----------
  function renderEngine() {
    const cli = settings.engine === 'cli';
    for (const r of document.querySelectorAll('input[name=engine]')) r.checked = r.value === settings.engine;
    $('bridgeBox').classList.toggle('hidden', !cli);
    $('apiSection').classList.toggle('hidden', cli);
  }
  for (const r of document.querySelectorAll('input[name=engine]')) {
    r.addEventListener('change', async () => {
      settings.engine = r.value;
      renderEngine();
      await save({ engine: r.value }, 'engineStatus');
    });
  }
  $('bridgeTest').addEventListener('click', () => {
    const out = $('bridgeStatus');
    out.className = 'status';
    out.textContent = 'Testando…';
    chrome.runtime.sendNativeMessage(Core.HOST_NAME, { type: 'ping' }, (res) => {
      const lastErr = chrome.runtime.lastError;
      if (lastErr) {
        out.className = 'status err';
        out.textContent = 'Ponte não encontrada. Rode native-host/install.sh e recarregue a extensão. (' + lastErr.message + ')';
      } else if (res && res.type === 'pong') {
        out.className = 'status ok';
        out.textContent = `Ponte ativa ✓ · Claude Code ${res.version} (${res.claudePath})`;
      } else {
        out.className = 'status err';
        out.textContent = (res && res.message) || 'Resposta inesperada da ponte.';
      }
    });
  });

  // ---------- chave ----------
  async function loadKey() {
    const { apiKey } = await chrome.storage.local.get('apiKey');
    $('apiKey').value = '';
    $('apiKey').placeholder = apiKey ? `Chave salva (…${apiKey.slice(-4)}). Cole outra para substituir.` : 'sk-ant-...';
    $('welcome').classList.toggle('hidden', (settings.engine === 'cli' || !!apiKey) && location.hash !== '#welcome');
  }
  $('saveKey').addEventListener('click', async () => {
    const v = $('apiKey').value.trim();
    if (!v) return flash('keyStatus', 'Cole a chave antes de salvar.', false);
    await chrome.storage.local.set({ apiKey: v });
    flash('keyStatus', 'Chave salva ✓');
    loadKey();
  });
  $('clearKey').addEventListener('click', async () => {
    await chrome.storage.local.remove('apiKey');
    flash('keyStatus', 'Chave removida.');
    loadKey();
  });

  // ---------- modelo ----------
  $('model').append(...Core.MODELS.map((m) => Object.assign(document.createElement('option'), { value: m.id, textContent: m.label })));
  $('saveModel').addEventListener('click', () =>
    save({ model: $('model').value, customModel: $('customModel').value.trim() }, 'modelStatus')
  );

  // ---------- lista de exceções ----------
  function renderCount() {
    const n = Core.parseWordList($('wlText').value).length;
    $('wlCount').textContent = `${n} termo(s)`;
  }
  $('wlText').addEventListener('input', renderCount);
  $('wlEnabled').addEventListener('change', () => save({ whitelistEnabled: $('wlEnabled').checked }, 'wlStatus'));
  $('wlSave').addEventListener('click', async () => {
    const list = Core.parseWordList($('wlText').value);
    if (await save({ whitelist: list }, 'wlStatus')) {
      $('wlText').value = list.join('\n');
      renderCount();
    }
  });
  $('wlImport').addEventListener('click', () => $('wlFile').click());
  $('wlFile').addEventListener('change', async () => {
    const file = $('wlFile').files[0];
    if (!file) return;
    const merged = Core.parseWordList($('wlText').value + '\n' + (await file.text()));
    $('wlText').value = merged.join('\n');
    $('wlFile').value = '';
    renderCount();
    flash('wlStatus', 'Importado: clique em "Salvar lista" para gravar.');
  });
  $('wlExport').addEventListener('click', () => {
    download('lista-de-excecoes.txt', Core.parseWordList($('wlText').value).join('\n') + '\n', 'text/plain');
  });

  // ---------- estilo / prompt ----------
  $('styleSave').addEventListener('click', () => save({ styleInstructions: $('style').value }, 'styleStatus'));
  $('promptPreview').addEventListener('click', () => {
    const out = $('promptOut');
    out.textContent = Core.buildSystemPrompt({
      styleInstructions: $('style').value,
      whitelistEnabled: $('wlEnabled').checked,
      whitelist: Core.parseWordList($('wlText').value),
    });
    out.classList.toggle('hidden');
  });

  // ---------- sites ----------
  function renderSites() {
    const ul = $('siteList');
    ul.replaceChildren();
    for (const d of settings.enabledSites) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = d;
      const rm = document.createElement('button');
      rm.textContent = 'Remover';
      rm.addEventListener('click', async () => {
        settings.enabledSites = settings.enabledSites.filter((x) => x !== d);
        await save({ enabledSites: settings.enabledSites }, 'siteStatus', 'Site removido ✓');
        try {
          await chrome.permissions.remove({ origins: [Core.hostPattern(d)] });
        } catch (e) {
          /* permissões fixas do manifest não podem ser removidas */
        }
        renderSites();
      });
      li.append(name, rm);
      ul.append(li);
    }
    if (!settings.enabledSites.length) ul.textContent = 'Nenhum site ativado.';
  }
  $('siteAdd').addEventListener('click', async () => {
    const d = Core.normalizeSite($('siteInput').value);
    if (!d) return flash('siteStatus', 'Informe um domínio válido, como exemplo.com.', false);
    if (settings.enabledSites.includes(d)) return flash('siteStatus', 'Esse site já está na lista.', false);
    const granted = await chrome.permissions.request({ origins: [Core.hostPattern(d)] });
    if (!granted) return flash('siteStatus', 'Permissão negada pelo Chrome.', false);
    settings.enabledSites = [...settings.enabledSites, d];
    await save({ enabledSites: settings.enabledSites }, 'siteStatus', 'Site ativado ✓ (recarregue as abas abertas)');
    $('siteInput').value = '';
    renderSites();
  });

  // ---------- limites ----------
  $('limitsSave').addEventListener('click', () => {
    const warn = parseInt($('warnChars').value, 10);
    const block = parseInt($('blockChars').value, 10);
    if (!(warn > 0 && block > warn)) return flash('limitsStatus', 'O bloqueio deve ser maior que o aviso.', false);
    save({ warnChars: warn, blockChars: block }, 'limitsStatus');
  });

  // ---------- métricas ----------
  $('metricsOn').addEventListener('change', () => save({ recordMetrics: $('metricsOn').checked }, 'metricsStatus'));
  $('csvExport').addEventListener('click', async () => {
    download('uso-de-tokens.csv', Core.toCSV(await AITRDB.getAll()), 'text/csv');
  });
  $('metricsClear').addEventListener('click', async () => {
    if (!confirm('Apagar todo o histórico de tokens? Isso não pode ser desfeito.')) return;
    await AITRDB.clear();
    flash('metricsStatus', 'Métricas apagadas.');
  });

  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type: type + ';charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- carga inicial ----------
  (async () => {
    settings = await chrome.storage.sync.get(Core.DEFAULT_SETTINGS);
    renderEngine();
    $('model').value = settings.model;
    $('customModel').value = settings.customModel;
    $('wlEnabled').checked = settings.whitelistEnabled;
    $('wlText').value = settings.whitelist.join('\n');
    $('style').value = settings.styleInstructions;
    $('warnChars').value = settings.warnChars;
    $('blockChars').value = settings.blockChars;
    $('metricsOn').checked = settings.recordMetrics;
    renderCount();
    renderSites();
    loadKey();
  })();
})();
