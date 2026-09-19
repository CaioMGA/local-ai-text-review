importScripts('lib/core.js', 'lib/db.js');

const Core = globalThis.AITRCore;
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const TIMEOUT_MS = 60000; // API HTTP
const CLI_TIMEOUT_MS = 180000; // ponte com o Claude Code (inicia o CLI; textos longos demoram mais)

function timeoutError(ms) {
  return new ReviewError(`A revisão demorou mais de ${ms / 1000} segundos e foi interrompida.`, 'timeout');
}
const MAX_TOKENS = 8192;
const SCRIPT_ID = 'aitr-sites';

// ---------- instalação, menu e scripts dos sites ativados ----------

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'aitr-review',
      title: 'Revisar texto com IA',
      contexts: ['selection', 'editable'],
    });
  });
  const cur = await chrome.storage.sync.get('enabledSites');
  if (!cur.enabledSites) {
    await chrome.storage.sync.set({ enabledSites: Core.DEFAULT_SETTINGS.enabledSites });
  }
  await syncContentScripts();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(syncContentScripts);
chrome.permissions.onAdded.addListener(syncContentScripts);
chrome.permissions.onRemoved.addListener(syncContentScripts);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.enabledSites) syncContentScripts();
});

// O botão flutuante só existe nos sites ativados: registramos o content script
// dinamicamente apenas para eles (com permissão de host já concedida).
let syncChain = Promise.resolve();
function syncContentScripts() {
  syncChain = syncChain.then(doSync).catch((e) => console.warn('sync scripts', e));
  return syncChain;
}

async function doSync() {
  const { enabledSites } = await chrome.storage.sync.get({
    enabledSites: Core.DEFAULT_SETTINGS.enabledSites,
  });
  const matches = [];
  for (const domain of enabledSites) {
    const pattern = Core.hostPattern(domain);
    if (await chrome.permissions.contains({ origins: [pattern] })) matches.push(pattern);
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (matches.length) {
    await chrome.scripting.registerContentScripts([
      {
        id: SCRIPT_ID,
        matches,
        js: ['lib/core.js', 'content.js'],
        allFrames: true,
        runAt: 'document_idle',
        persistAcrossSessions: true,
      },
    ]);
  }
}

// ---------- gatilhos manuais (atalho e menu de contexto) ----------

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'review') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  triggerReview(tab);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'aitr-review') triggerReview(tab);
});

async function triggerReview(tab) {
  if (!tab || tab.id == null) return;
  const files = ['lib/core.js', 'content.js'];
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files });
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
    } catch (e2) {
      flashBadge(tab.id); // página restrita (chrome://, Web Store...)
      return;
    }
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'aitr:trigger' });
  } catch (e) {
    flashBadge(tab.id);
  }
}

function flashBadge(tabId) {
  chrome.action.setBadgeBackgroundColor({ color: '#b91c1c', tabId });
  chrome.action.setBadgeText({ text: '!', tabId });
  setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }), 3000);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'aitr:open-options') chrome.runtime.openOptionsPage();
});

// ---------- revisão ----------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'aitr-review') return;
  const ctrl = new AbortController();
  port.onDisconnect.addListener(() => ctrl.abort());
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === 'review') handleReview(port, msg, ctrl);
    else if (msg && msg.type === 'explain') handleExplain(port, msg, ctrl);
  });
});

class ReviewError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function handleReview(port, msg, ctrl) {
  const usage = { input: 0, output: 0 };
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  const text = typeof msg.text === 'string' ? msg.text : '';
  const settings = await chrome.storage.sync.get(Core.DEFAULT_SETTINGS);
  const send = (m) => {
    try {
      port.postMessage(m);
    } catch (e) {
      /* porta fechada: revisão cancelada */
    }
  };
  try {
    const result = await runReview(text, settings, usage, ctrl.signal);
    send({ type: 'result', ...result });
  } catch (e) {
    if (ctrl.signal.aborted) return;
    send({
      type: 'error',
      code: e.code || 'unknown',
      message: e.message || 'Erro inesperado.',
    });
  } finally {
    clearInterval(keepAlive);
    await recordUsage(settings, usage, text);
  }
}

async function recordUsage(settings, usage, sentText) {
  if (!settings.recordMetrics || usage.input + usage.output <= 0) return;
  try {
    await AITRDB.add({
      ts: Date.now(),
      inputTokens: usage.input,
      outputTokens: usage.output,
      chars: sentText.length,
      words: Core.countWords(sentText),
    });
  } catch (e) {
    console.warn('métricas', e);
  }
}

// Uma chamada ao modelo pelo motor escolhido (ponte ou API). Soma os tokens em `usage`.
async function complete(settings, { system, user, maxTokens }, usage, signal) {
  const model = (settings.customModel || '').trim() || settings.model;
  let data;
  if (settings.engine === 'cli') {
    data = await callCli({ model, system, user, signal });
  } else {
    const { apiKey } = await chrome.storage.local.get('apiKey');
    if (!apiKey) {
      throw new ReviewError('Configure sua chave de API nas configurações da extensão.', 'no-key');
    }
    data = await callApi({ apiKey, model, system, user, signal, maxTokens });
  }
  usage.input += data.usage?.input_tokens || 0;
  usage.output += data.usage?.output_tokens || 0;
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { text, stopReason: data.stop_reason };
}

// "Me explica": só roda quando o usuário clica no botão do card. Envia apenas a
// explicação curta entre aspas seguida de "Por quê?" (o mínimo de tokens).
const EXPLAIN_SYSTEM =
  'You explain text corrections. The user sends, in quotes, the short explanation of a correction, followed by "Por quê?". ' +
  'Answer with the grammatical or spelling rule behind the correction, in plain language and without examples. ' +
  'LANGUAGE: write your answer in the same language as the quoted explanation. If the quoted text is in English, answer in English; ' +
  'if it is in Portuguese, answer in Portuguese. Never use the language of these instructions unless it matches. ' +
  'No introduction and no markdown formatting.';

async function handleExplain(port, msg, ctrl) {
  const usage = { input: 0, output: 0 };
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  const settings = await chrome.storage.sync.get(Core.DEFAULT_SETTINGS);
  const explanation = typeof msg.explanation === 'string' ? msg.explanation.trim().slice(0, 1000) : '';
  const user = `"${explanation}" Por quê?`;
  const send = (m) => {
    try {
      port.postMessage(m);
    } catch (e) {
      /* porta fechada */
    }
  };
  try {
    if (!explanation) throw new ReviewError('Esta sugestão não tem uma explicação para detalhar.', 'empty');
    const { text } = await complete(settings, { system: EXPLAIN_SYSTEM, user, maxTokens: 1024 }, usage, ctrl.signal);
    send({ type: 'explanation', text: text.trim() });
  } catch (e) {
    if (ctrl.signal.aborted) return;
    send({ type: 'error', code: e.code || 'unknown', message: e.message || 'Erro inesperado.' });
  } finally {
    clearInterval(keepAlive);
    await recordUsage(settings, usage, user);
  }
}

async function runReview(text, settings, usage, signal) {
  if (!text.trim()) throw new ReviewError('Não há texto para revisar.', 'empty');
  if (text.length > settings.blockChars) {
    throw new ReviewError(
      `Texto grande demais (${text.length} caracteres; o limite é ${settings.blockChars}). Selecione um trecho menor.`,
      'too-long'
    );
  }
  const system = Core.buildSystemPrompt(settings);
  const user = Core.buildUserMessage(text);

  let parsed = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const { text: raw, stopReason } = await complete(settings, { system, user }, usage, signal);
    if (stopReason === 'max_tokens') {
      throw new ReviewError(
        'A resposta foi cortada por ser longa demais. Selecione um trecho menor.',
        'truncated'
      );
    }
    try {
      parsed = Core.parseModelResponse(raw);
    } catch (e) {
      if (attempt === 1) {
        throw new ReviewError('O modelo devolveu uma resposta fora do formato. Tente de novo.', 'malformed');
      }
    }
  }

  const validated = Core.validateChanges(text, parsed.changes);
  const list = settings.whitelistEnabled ? settings.whitelist : [];
  const { kept, dropped } = Core.filterWhitelist(text, validated, list);
  return {
    changes: kept,
    ignoredByWhitelist: dropped.length,
    language: parsed.language || '',
    whitelist: { enabled: !!settings.whitelistEnabled, count: (settings.whitelist || []).length },
  };
}

// Motor "assinatura": pede a revisão ao Claude Code instalado no computador, pela
// ponte de Native Messaging. Devolve o mesmo formato que a API HTTP.
function callCli({ model, system, user, signal }) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(Core.HOST_NAME);
    } catch (e) {
      return reject(noBridge());
    }
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      try {
        port.disconnect(); // encerra o Claude Code no host, se ainda estiver rodando
      } catch (e) {
        /* já desconectada */
      }
      fn(value);
    };
    const onAbort = () => finish(reject, new ReviewError('Revisão cancelada.', 'cancelled'));
    const timer = setTimeout(() => finish(reject, timeoutError(CLI_TIMEOUT_MS)), CLI_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort);

    port.onMessage.addListener((m) => {
      if (m.type === 'result') {
        finish(resolve, {
          content: [{ type: 'text', text: m.text }],
          usage: { input_tokens: m.usage?.input || 0, output_tokens: m.usage?.output || 0 },
          stop_reason: m.stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn',
        });
      } else if (m.type === 'error') {
        finish(reject, new ReviewError(m.message || 'Erro na ponte com o Claude Code.', m.code || 'cli'));
      }
    });
    port.onDisconnect.addListener(() => {
      const msg = chrome.runtime.lastError?.message || '';
      finish(
        reject,
        /not found|forbidden|not exist/i.test(msg)
          ? noBridge()
          : new ReviewError('A ponte com o Claude Code foi encerrada. ' + msg, 'cli')
      );
    });
    port.postMessage({ type: 'review', model, system, user });
  });
}

function noBridge() {
  return new ReviewError(
    'A ponte com o Claude Code não está instalada. Rode native-host/install.sh e recarregue a extensão (veja o README).',
    'no-bridge'
  );
}

async function callApi({ apiKey, model, system, user, signal, maxTokens }) {
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort);
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, TIMEOUT_MS);

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens || MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
  } catch (e) {
    if (timedOut) throw timeoutError(TIMEOUT_MS);
    if (signal.aborted) throw e;
    throw new ReviewError('Sem conexão com a API da Anthropic. Verifique sua rede.', 'network');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.error?.message || '';
    } catch (e) {
      /* corpo não é JSON */
    }
    if (res.status === 401) throw new ReviewError('Chave de API inválida. Confira nas configurações.', 'auth');
    if (res.status === 403) throw new ReviewError(`Acesso negado pela API. ${detail}`.trim(), 'forbidden');
    if (res.status === 404) throw new ReviewError(`Modelo não encontrado: ${model}. ${detail}`.trim(), 'model');
    if (res.status === 429) {
      const wait = res.headers.get('retry-after');
      throw new ReviewError(
        `Limite de requisições atingido.${wait ? ` Tente de novo em ${wait}s.` : ''}`,
        'rate-limit'
      );
    }
    if (res.status === 529) throw new ReviewError('A API está sobrecarregada. Tente de novo em instantes.', 'overloaded');
    throw new ReviewError(`Erro da API (${res.status}). ${detail}`.trim(), 'api');
  }
  return res.json();
}
