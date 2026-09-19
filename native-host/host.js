#!/usr/bin/env node
// Ponte (Native Messaging) entre a extensão e o Claude Code local.
// Roda `claude -p` no modo não interativo, que usa o login da sua assinatura.
// Protocolo: mensagens JSON com prefixo de 4 bytes (little-endian) em stdin/stdout.
// Uma conexão = uma revisão; se a extensão desconectar, o processo do CLI é encerrado.
'use strict';

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REVIEW_TIMEOUT_MS = 210000;
let child = null;
let buf = Buffer.alloc(0);

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

function findClaude() {
  const home = os.homedir();
  const candidates = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    if (cfg.claudePath) candidates.push(cfg.claudePath);
  } catch (e) {
    /* sem config */
  }
  candidates.push(path.join(home, '.local/bin/claude'), '/usr/local/bin/claude', '/usr/bin/claude');
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'claude'));
  }
  return candidates.find((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch (e) {
      return false;
    }
  });
}

function ping() {
  const claude = findClaude();
  if (!claude) {
    return send({ type: 'error', code: 'no-claude', message: 'Claude Code não encontrado. Instale-o e rode o install.sh de novo.' });
  }
  execFile(claude, ['--version'], { timeout: 8000 }, (err, stdout) => {
    if (err) return send({ type: 'error', code: 'cli', message: 'Falha ao executar o Claude Code: ' + err.message });
    send({ type: 'pong', claudePath: claude, version: String(stdout).trim() });
  });
}

function review(msg) {
  if (child) return send({ type: 'error', code: 'busy', message: 'Já há uma revisão em andamento.' });
  const claude = findClaude();
  if (!claude) {
    return send({ type: 'error', code: 'no-claude', message: 'Claude Code não encontrado. Instale-o e rode o install.sh de novo.' });
  }
  const args = [
    '-p',
    '--output-format', 'json',
    '--tools', '',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--setting-sources', '',
    '--strict-mcp-config', // sem isso o CLI carrega os conectores MCP da conta: ~7 mil tokens de entrada por chamada
    '--effort', 'low',
    '--system-prompt', String(msg.system || ''),
  ];
  if (msg.model) args.push('--model', String(msg.model));

  let out = '';
  let err = '';
  let timedOut = false;
  // Sem "raciocínio": ele multiplicava os tokens de saída por 3 a 10 para uma tarefa que não precisa dele.
  const env = { ...process.env, MAX_THINKING_TOKENS: '0', CLAUDE_CODE_DISABLE_THINKING: '1' };
  child = spawn(claude, args, { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, REVIEW_TIMEOUT_MS);

  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.on('error', (e) => {
    clearTimeout(timer);
    child = null;
    send({ type: 'error', code: e.code === 'ENOENT' ? 'no-claude' : 'cli', message: 'Não foi possível iniciar o Claude Code: ' + e.message });
  });
  child.on('close', () => {
    clearTimeout(timer);
    child = null;
    if (timedOut) return send({ type: 'error', code: 'timeout', message: 'O Claude Code demorou demais e foi interrompido.' });
    let j;
    try {
      j = JSON.parse(out);
    } catch (e) {
      const detail = (err || out).trim().slice(0, 300);
      return send({ type: 'error', code: 'cli', message: 'Resposta inesperada do Claude Code. ' + detail });
    }
    if (j.is_error) {
      const text = String(j.result || err || 'erro desconhecido');
      const auth = /log ?in|auth|credential|token|subscription|limit|quota/i.test(text);
      return send({ type: 'error', code: auth ? 'cli-auth' : 'cli', message: text.slice(0, 400) });
    }
    const u = j.usage || {};
    send({
      type: 'result',
      text: String(j.result || ''),
      stopReason: j.stop_reason || '',
      usage: {
        input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
        output: u.output_tokens || 0,
      },
    });
  });
  child.stdin.on('error', () => {});
  child.stdin.end(String(msg.user || ''));
}

function handle(msg) {
  if (msg && msg.type === 'ping') ping();
  else if (msg && msg.type === 'review') review(msg);
}

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) return;
    let msg = null;
    try {
      msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
    } catch (e) {
      /* mensagem inválida: ignora */
    }
    buf = buf.subarray(4 + len);
    if (msg) handle(msg);
  }
});

// A extensão desconectou (cancelou ou fechou): encerra o CLI e sai.
process.stdin.on('end', () => {
  if (child) child.kill('SIGKILL');
  process.exit(0);
});
