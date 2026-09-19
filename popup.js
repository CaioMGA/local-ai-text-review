(() => {
  'use strict';
  const Core = globalThis.AITRCore;
  const $ = (id) => document.getElementById(id);

  (async () => {
    const { apiKey } = await chrome.storage.local.get('apiKey');
    const { engine } = await chrome.storage.sync.get({ engine: Core.DEFAULT_SETTINGS.engine });
    $('keyWarn').hidden = engine === 'cli' || !!apiKey;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let host = '';
    try {
      const u = new URL(tab.url);
      if (/^https?:$/.test(u.protocol)) host = u.hostname;
    } catch (e) {
      /* sem URL acessível */
    }
    if (!host) {
      $('siteName').textContent = 'Esta página não permite o botão flutuante.';
      $('siteToggle').disabled = true;
      return;
    }
    const domain = Core.normalizeSite(host) || host;
    $('siteName').textContent = host;

    let { enabledSites } = await chrome.storage.sync.get({ enabledSites: Core.DEFAULT_SETTINGS.enabledSites });
    const matching = () => enabledSites.filter((d) => host === d || host.endsWith('.' + d));
    const refresh = () => {
      $('siteToggle').checked = matching().length > 0;
    };
    refresh();

    $('siteToggle').addEventListener('change', async () => {
      const status = $('siteStatus');
      if ($('siteToggle').checked) {
        const granted = await chrome.permissions.request({ origins: [Core.hostPattern(domain)] });
        if (!granted) {
          status.textContent = 'Permissão negada pelo Chrome.';
          status.className = 'status err';
          return refresh();
        }
        enabledSites = [...enabledSites, domain];
      } else {
        const remove = matching();
        enabledSites = enabledSites.filter((d) => !remove.includes(d));
      }
      await chrome.storage.sync.set({ enabledSites });
      if ($('siteToggle').checked) {
        try {
          // faz o botão aparecer na aba atual sem recarregar
          await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['lib/core.js', 'content.js'] });
        } catch (e) {
          /* recarregar a página resolve */
        }
      }
      status.textContent = 'Salvo ✓';
      status.className = 'status ok';
    });
  })();
})();
