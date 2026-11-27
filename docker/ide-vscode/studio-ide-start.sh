#!/bin/bash
# Start the IDE of a VS Code session behind the session gate (ADR-0080 §3):
# the bridge's control server on 127.0.0.1:$STUDIO_IDE_CONTROL_PORT, then
# openvscode-server on 127.0.0.1:3004. The gate (port 3003) is what the browser
# and the backend reach; it guards the IDE with the session cookie, so the
# server runs without a connection token of its own.
set -euo pipefail

SERVER=/opt/openvscode-server
DATA="${HOME}/.openvscode-server"

node "$SERVER/extensions/constructorfabric.studio-bridge/server.js" &

# Machine settings, only when absent: the checkout is trusted (it is the
# person's own project), and nothing is reported to anyone.
MACHINE="$DATA/data/Machine"
if [ ! -f "$MACHINE/settings.json" ]; then
  mkdir -p "$MACHINE"
  cat > "$MACHINE/settings.json" <<'SETTINGS'
{
  "security.workspace.trust.enabled": false,
  "telemetry.telemetryLevel": "off",
  "update.mode": "none"
}
SETTINGS
fi

exec "$SERVER/bin/openvscode-server" \
  --host 127.0.0.1 \
  --port 3004 \
  --without-connection-token \
  --server-data-dir "$DATA" \
  --default-folder /workspace \
  --telemetry-level off
