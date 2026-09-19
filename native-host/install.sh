#!/usr/bin/env bash
# Instala a ponte entre a extensão e o Claude Code local (Linux).
# Copia o host para ~/.local/share/ai-text-revision (fora de /mnt, sem espaços no caminho)
# e registra o manifesto de Native Messaging no Brave, Chrome e/ou Chromium encontrados.
set -euo pipefail

HOST_NAME="com.caiomga.aitr_claude_bridge"
EXT_ID="ofbmhkmbmedfebogblmfpidecigdjmoa" # derivado da "key" do manifest.json

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.local/share/ai-text-revision"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "Erro: node não encontrado no PATH." >&2; exit 1; }

CLAUDE_BIN="$(command -v claude || true)"
[ -z "$CLAUDE_BIN" ] && [ -x "$HOME/.local/bin/claude" ] && CLAUDE_BIN="$HOME/.local/bin/claude"
[ -n "$CLAUDE_BIN" ] || { echo "Erro: Claude Code (claude) não encontrado. Instale-o e faça login antes." >&2; exit 1; }

mkdir -p "$DEST"
cp "$SRC_DIR/host.js" "$DEST/host.js"
printf '{"claudePath": "%s"}\n' "$CLAUDE_BIN" > "$DEST/config.json"
# Wrapper com caminhos absolutos: o navegador inicia o host com um PATH mínimo.
printf '#!/bin/sh\nexec "%s" "%s/host.js"\n' "$NODE_BIN" "$DEST" > "$DEST/run-host.sh"
chmod +x "$DEST/run-host.sh" "$DEST/host.js"

manifest() {
  cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Ponte da extensão Revisão de Texto com IA para o Claude Code local",
  "path": "$DEST/run-host.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
}

installed=0
for browser_dir in \
  "$HOME/.config/BraveSoftware/Brave-Browser" \
  "$HOME/.config/google-chrome" \
  "$HOME/.config/chromium"; do
  if [ -d "$browser_dir" ]; then
    mkdir -p "$browser_dir/NativeMessagingHosts"
    manifest > "$browser_dir/NativeMessagingHosts/$HOST_NAME.json"
    echo "Registrado em: $browser_dir/NativeMessagingHosts/$HOST_NAME.json"
    installed=$((installed + 1))
  fi
done
[ "$installed" -gt 0 ] || { echo "Nenhum navegador Chromium encontrado em ~/.config." >&2; exit 1; }

echo "node:   $NODE_BIN"
echo "claude: $CLAUDE_BIN ($("$CLAUDE_BIN" --version 2>&1 | head -1))"
echo "Pronto. Recarregue a extensão em chrome://extensions e use 'Testar ponte' nas configurações."
