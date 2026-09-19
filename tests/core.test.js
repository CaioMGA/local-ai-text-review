const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../lib/core.js');

test('parseWordList remove vazios e duplicados (sem distinguir caixa)', () => {
  assert.deepEqual(Core.parseWordList(' idéia \n\nVôo\nidéia\r\nIDÉIA\na nível de'), ['idéia', 'Vôo', 'a nível de']);
});

test('normalizeSite e siteMatches', () => {
  assert.equal(Core.normalizeSite('https://www.Substack.com/inbox?x=1'), 'substack.com');
  assert.equal(Core.normalizeSite('*.caiomga.com'), 'caiomga.com');
  assert.equal(Core.normalizeSite('lixo'), '');
  assert.ok(Core.siteMatches('foo.substack.com', ['substack.com']));
  assert.ok(Core.siteMatches('substack.com', ['substack.com']));
  assert.ok(!Core.siteMatches('notsubstack.com', ['substack.com']));
});

test('parseModelResponse aceita bloco de código e texto ao redor', () => {
  const r = Core.parseModelResponse('Claro!\n```json\n{"language":"pt-BR","changes":[]}\n```');
  assert.deepEqual(r.changes, []);
  assert.throws(() => Core.parseModelResponse('sem json'));
  assert.throws(() => Core.parseModelResponse('{"language":"en"}'));
});

test('validateChanges descarta trechos inexistentes, idênticos e sobrepostos', () => {
  const text = 'Eu vou a escola. A escola é boa. Ele fez um erro erro.';
  const out = Core.validateChanges(text, [
    { original: 'a escola', replacement: 'à escola', category: 'gramática', explanation: 'crase' },
    { original: 'inexistente', replacement: 'x' },
    { original: 'boa', replacement: 'boa' },
    { original: 'a escola', replacement: 'à escola' }, // sobrepõe? não: segunda ocorrência é "A escola" (caixa diferente)
    { original: 'erro erro', replacement: 'erro', category: 'ORTOGRAFIA' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].start, text.indexOf('a escola'));
  assert.equal(out[0].category, 'gramatica');
  assert.equal(out[1].category, 'ortografia');
  assert.equal(Core.applyChanges(text, out), 'Eu vou à escola. A escola é boa. Ele fez um erro.');
});

test('validateChanges usa ocorrências repetidas em ordem', () => {
  const text = 'casa casa casa';
  const out = Core.validateChanges(text, [
    { original: 'casa', replacement: 'Casa' },
    { original: 'casa', replacement: 'Casa' },
  ]);
  assert.deepEqual(out.map((c) => c.start), [0, 5]);
});

test('filterWhitelist descarta mudanças sobre termos da lista', () => {
  const text = 'Que idéia boa! Essa ideia também. Um vôo direto, sem voo.';
  const changes = Core.validateChanges(text, [
    { original: 'idéia', replacement: 'ideia' },
    { original: 'vôo direto', replacement: 'voo direto' },
    { original: 'ideia', replacement: 'ideía' },
  ]);
  const { kept, dropped } = Core.filterWhitelist(text, changes, ['IDÉIA', 'vôo']);
  assert.deepEqual(dropped.map((c) => c.original), ['idéia', 'vôo']);
  assert.deepEqual(kept.map((c) => c.original), ['ideia']); // acentos contam: "ideia" ≠ "idéia"
});

test('filterWhitelist só casa palavra inteira e expressões', () => {
  const text = 'Isso ocorre a nível de empresa. Anível não.';
  const changes = Core.validateChanges(text, [
    { original: 'a nível de', replacement: 'em nível de' },
    { original: 'Anível', replacement: 'Nível' },
  ]);
  const { kept, dropped } = Core.filterWhitelist(text, changes, ['a nível de', 'nível']);
  assert.deepEqual(dropped.map((c) => c.original), ['a']); // 'a' → 'em' ainda toca a expressão 'a nível de'
  assert.deepEqual(kept.map((c) => c.original), ['Anível']);
});

test('buildSystemPrompt inclui lista e instruções só quando ligadas', () => {
  const on = Core.buildSystemPrompt({ whitelistEnabled: true, whitelist: ['idéia'], styleInstructions: 'Mantenha o trema.' });
  assert.match(on, /- idéia/);
  assert.match(on, /Mantenha o trema\./);
  const off = Core.buildSystemPrompt({ whitelistEnabled: false, whitelist: ['idéia'], styleInstructions: '' });
  assert.doesNotMatch(off, /idéia/);
  assert.doesNotMatch(off, /Instruções de estilo do autor/);
});

test('countWords e checkLength', () => {
  assert.equal(Core.countWords("Olá, mundo! It's a bem-vindo 42"), 6);
  const s = { warnChars: 10, blockChars: 20 };
  assert.equal(Core.checkLength(10, s), 'ok');
  assert.equal(Core.checkLength(11, s), 'warn');
  assert.equal(Core.checkLength(21, s), 'block');
});

test('buildSeries agrupa por dia/semana/mês/ano (semana começa na segunda)', () => {
  const now = new Date(2026, 8, 18, 15).getTime(); // sex 18/09/2026
  const rec = (d, i, o) => ({ ts: new Date(...d).getTime(), inputTokens: i, outputTokens: o });
  const records = [
    rec([2026, 8, 18, 9], 100, 10),
    rec([2026, 8, 18, 20], 50, 5),
    rec([2026, 8, 14, 12], 30, 3), // segunda da mesma semana
    rec([2026, 8, 13, 12], 7, 1), // domingo: semana anterior
    rec([2025, 8, 1, 12], 1000, 100),
  ];
  const day = Core.buildSeries(records, 'day', 3, now);
  assert.deepEqual(day.map((b) => b.total), [0, 0, 165]);
  const week = Core.buildSeries(records, 'week', 2, now);
  assert.deepEqual(week.map((b) => b.total), [8, 198]);
  const month = Core.buildSeries(records, 'month', 13, now);
  assert.equal(month[0].total, 1100); // set/2025
  assert.equal(month[12].total, 206);
  const year = Core.buildSeries(records, 'year', 2, now);
  assert.deepEqual(year.map((b) => b.total), [1100, 206]);
});

test('toCSV gera cabeçalho e linhas', () => {
  const csv = Core.toCSV([{ ts: 0, inputTokens: 1, outputTokens: 2, chars: 3, words: 4 }]);
  assert.equal(csv.split('\n')[0], 'data_hora,tokens_entrada,tokens_saida,caracteres,palavras');
  assert.match(csv, /1970-01-01T00:00:00.000Z,1,2,3,4/);
});

test('validateChanges reduz cada mudança ao trecho que realmente muda', () => {
  const text = 'Ontem eu vou a escola com os meus amigos, e depois fomos embora.';
  const out = Core.validateChanges(text, [
    { original: 'eu vou a escola com os meus amigos', replacement: 'eu vou à escola com os meus amigos', category: 'gramatica' },
    { original: 'amigos, e depois', replacement: 'amigos e depois', category: 'gramatica' },
  ]);
  assert.deepEqual(out.map((c) => [c.original, c.replacement]), [['a', 'à'], [',', '']]);
  for (const c of out) assert.equal(text.slice(c.start, c.end), c.original); // posições coerentes
  assert.equal(Core.applyChanges(text, out), 'Ontem eu vou à escola com os meus amigos e depois fomos embora.');
});

test('inserções mantêm uma palavra vizinha para marcar', () => {
  const text = 'Nós fomos ao mercado ontem.';
  const [c] = Core.validateChanges(text, [{ original: 'fomos ao mercado', replacement: 'fomos ao grande mercado' }]);
  assert.equal(text.slice(c.start, c.end), c.original);
  assert.equal(Core.applyChanges(text, [c]), 'Nós fomos ao grande mercado ontem.');
  assert.ok(c.original.length < 'fomos ao mercado'.length);
});

test('frase reescrita inteira continua válida e aplicável', () => {
  const text = 'Isso é muito bom. Fim.';
  const [c] = Core.validateChanges(text, [{ original: 'Isso é muito bom.', replacement: 'Isso é excelente.' }]);
  assert.equal(Core.applyChanges(text, [c]), 'Isso é excelente. Fim.');
  assert.equal(c.original, 'muito bom');
});
