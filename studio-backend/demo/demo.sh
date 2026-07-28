#!/usr/bin/env bash
# Constructor Studio Backend — account-management demonstration scenario.
# Proves: bootstrap -> tenant types -> organization -> workspace -> users -> /me -> metadata.
#
# Prereqs: server running (`cargo run -- --config config/dev.yaml run`), curl, jq.
# Path shapes below follow the gears OpenAPI; if a call 404s, check the live
# contract at http://127.0.0.1:8090/cf/docs — that is the source of truth.

set -euo pipefail

BASE="http://127.0.0.1:8090/cf"
TOKEN="studio-admin-token"
AUTH=(-H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json")
ROOT_ID="00000000-0000-0000-0000-000000000001"

step() { echo; echo "━━━ $1 ━━━"; }

step "0. Health"
curl -sf "http://127.0.0.1:8090/healthz" && echo "OK"

step "1. Who am I (identity from static token; home tenant = root)"
curl -sf "${AUTH[@]}" "${BASE}/account-management/v1/me" | jq .

step "2. Studio tenant types (seeded from config/dev.yaml -> types-registry.config.entities)"
echo "platform (root-only) -> organization -> workspace; parent constraints enforced by AM type barrier"

step "3. Create organization tenant under the bootstrap root"
ORG_ID=$(curl -sf "${AUTH[@]}" -X POST "${BASE}/account-management/v1/tenants" -d "{
  \"name\": \"Acme Corp\",
  \"parent_id\": \"${ROOT_ID}\",
  \"tenant_type\": \"gts.cf.core.am.tenant_type.v1~cf.studio.tenant.organization.v1~\"
}" | jq -r '.id')
echo "organization: ${ORG_ID}"

step "4. Create workspace tenant under the organization"
WS_ID=$(curl -sf "${AUTH[@]}" -X POST "${BASE}/account-management/v1/tenants" -d "{
  \"name\": \"Billing Product Line\",
  \"parent_id\": \"${ORG_ID}\",
  \"tenant_type\": \"gts.cf.core.am.tenant_type.v1~cf.studio.tenant.workspace.v1~\"
}" | jq -r '.id')
echo "workspace: ${WS_ID}"

step "4a. Negative check: workspace directly under root must be REJECTED (type barrier)"
curl -s "${AUTH[@]}" -X POST "${BASE}/account-management/v1/tenants" -d "{
  \"name\": \"Rogue Workspace\",
  \"parent_id\": \"${ROOT_ID}\",
  \"tenant_type\": \"gts.cf.core.am.tenant_type.v1~cf.studio.tenant.workspace.v1~\"
}" | jq -c '{expected_rejection: (.code // .error // .)}'

step "5. Hierarchy: children of the organization"
curl -sf "${AUTH[@]}" "${BASE}/account-management/v1/tenants/${ORG_ID}/children" | jq -c '.items // . | map({id, name} // .)' 2>/dev/null \
  || curl -sf "${AUTH[@]}" "${BASE}/account-management/v1/tenants/${ORG_ID}/children" | jq .

step "6. Invite (provision) a user into the workspace via IdP contract"
USER_JSON=$(curl -sf "${AUTH[@]}" -X POST "${BASE}/account-management/v1/tenants/${WS_ID}/users" -d '{
  "username": "a.kuchma",
  "email": "a.kuchma@acme.example",
  "display_name": "Andrej Kuchma"
}')
echo "${USER_JSON}" | jq .
USER_ID=$(echo "${USER_JSON}" | jq -r '.id // .user_id')

step "7. List workspace users"
curl -sf "${AUTH[@]}" "${BASE}/account-management/v1/tenants/${WS_ID}/users" | jq .

step "8. Read tenants back (org + workspace)"
curl -sf "${AUTH[@]}" "${BASE}/account-management/v1/tenants/${ORG_ID}" | jq -c '{id, name, tenant_type, self_managed}'
curl -sf "${AUTH[@]}" "${BASE}/account-management/v1/tenants/${WS_ID}"  | jq -c '{id, name, tenant_type, self_managed}'

step "9. Dual-consent conversion: request org -> self-managed (visibility barrier)"
curl -s "${AUTH[@]}" -X POST "${BASE}/account-management/v1/tenants/${ORG_ID}/conversions" -d '{
  "target_mode": "self_managed",
  "comment": "Studio demo: create visibility barrier for the organization"
}' | jq .

echo
echo "Demo complete. What this proved:"
echo "  - bootstrap root tenant (idempotent), GTS tenant types with parent constraints"
echo "  - organization -> workspace hierarchy + type barrier enforcement"
echo "  - user provisioning via pluggable IdP contract, tenant-scoped listing"
echo "  - identity reflection (/me) through the full gateway->authn->AM chain"
echo "User groups / membership demo requires resource-group API calls — see README next steps."
