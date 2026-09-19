#!/usr/bin/env bash
# Remove a ponte instalada por install.sh.
set -euo pipefail
HOST_NAME="com.caiomga.aitr_claude_bridge"
for browser_dir in \
  "$HOME/.config/BraveSoftware/Brave-Browser" \
  "$HOME/.config/google-chrome" \
  "$HOME/.config/chromium"; do
  rm -f "$browser_dir/NativeMessagingHosts/$HOST_NAME.json"
done
rm -rf "$HOME/.local/share/ai-text-revision"
echo "Ponte removida."
