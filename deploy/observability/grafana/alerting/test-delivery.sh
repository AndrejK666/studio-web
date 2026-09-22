#!/usr/bin/env bash
# Post one message shaped like a real firing alert to the webhook URL.
#
#   ./test-delivery.sh 'https://chat.constr.dev/api/v1/external/grafana?api_key=…&stream=CF-Studio-web-alerts'
#
# WHY THIS EXISTS
#
# An alert channel that silently fails is worse than no channel: the rules
# evaluate, Grafana says `health=ok`, and the room stays quiet for the one
# reason nobody checks. Nothing proves the URL works until something fires, and
# by then it is too late to find out it does not.
#
# So this fires on demand. What lands in the stream is what an incident will
# look like, which is also worth seeing once before relying on it.
#
# It talks to the destination directly rather than through Grafana. That is the
# risky half — whether the URL is right, whether the bot may post to the
# stream, whether Zulip renders Grafana's payload — and it needs no Grafana
# credentials to answer.
set -euo pipefail

url="${1:?usage: test-delivery.sh <webhook url>}"

# Shaped like Grafana's unified alerting payload, using this deployment's own
# rule so the rendering is representative rather than a "hello world".
payload=$(cat <<'JSON'
{
  "receiver": "studio-oncall",
  "status": "firing",
  "orgId": 1,
  "title": "[FIRING:1] Container restarting repeatedly (studio-dev)",
  "state": "alerting",
  "message": "Delivery test from deploy/observability/grafana/alerting/test-delivery.sh — no container is actually restarting.",
  "alerts": [
    {
      "status": "firing",
      "labels": {
        "alertname": "Container restarting repeatedly",
        "grafana_folder": "Studio",
        "namespace": "studio-dev",
        "pod": "delivery-test",
        "container": "delivery-test",
        "severity": "page"
      },
      "annotations": {
        "summary": "delivery-test/delivery-test restarted more than 3 times in an hour",
        "description": "This is a test of the alert channel, sent by hand. If you are reading it in the stream, the webhook URL works."
      },
      "startsAt": "2026-01-01T00:00:00Z",
      "endsAt": "0001-01-01T00:00:00Z",
      "generatorURL": "https://monitoring.cfabric.org/alerting/list",
      "fingerprint": "deliverytest0000"
    }
  ],
  "groupLabels": { "alertname": "Container restarting repeatedly", "namespace": "studio-dev" },
  "commonLabels": { "severity": "page" },
  "externalURL": "https://monitoring.cfabric.org/"
}
JSON
)

code=$(curl -sS -o /tmp/alert-test-response -w '%{http_code}' -m 20 \
    -X POST -H 'Content-Type: application/json' \
    --data "$payload" "$url")

echo "HTTP $code"
echo "--- response ---"
cat /tmp/alert-test-response 2>/dev/null || true
echo
rm -f /tmp/alert-test-response

case "$code" in
    2*) echo "delivered — check the stream for the message" ;;
    *)  echo "NOT delivered. A 400 usually means the payload shape; a 401/403 the api_key or the bot's stream access; a 404 the stream name." >&2
        exit 1 ;;
esac
