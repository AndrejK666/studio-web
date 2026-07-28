#!/usr/bin/env bash
# User groups via Resource Group (AM delegates groups to RG — PRD §5.6).
# AM registered the RG types at init: container `…cf.core.am.user_group.v1~`
# (self-parent allowed => nested groups), member handle `…cf.core.am.user.v1~`.
#
# Usage: ./demo/demo-groups.sh [USER_ID]
#   USER_ID — id of a user provisioned by demo.sh step 6 (default: none -> a
#   deterministic demo UUID is used; RG stores (resource_type, resource_id)
#   opaquely, user existence validation is the caller's job per AM PRD §5.6).

set -euo pipefail

BASE="http://127.0.0.1:8090/cf"
TOKEN="studio-admin-token"
AUTH=(-H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json")
USER_GROUP_TYPE="gts.cf.core.rg.type.v1~cf.core.am.user_group.v1~"
# Membership resource_type = the RG "member handle" type AM registered at init
# (container's allowed_membership_types lists it), NOT the bare AM user schema.
USER_TYPE="gts.cf.core.rg.type.v1~cf.core.am.user.v1~"
USER_ID="${1:-ac6ae8e2-b765-541b-8ecd-405addfaef21}"

step() { echo; echo "━━━ $1 ━━━"; }

step "1. Create root user group 'Workspace Members'"
GROUP_ID=$(curl -sf "${AUTH[@]}" -X POST "${BASE}/resource-group/v1/groups" -d "{
  \"type\": \"${USER_GROUP_TYPE}\",
  \"name\": \"Workspace Members\",
  \"parent_id\": null
}" | jq -r '.id')
echo "group: ${GROUP_ID}"

step "2. Create NESTED group 'Reviewers' under it (self-parent rule from AM init)"
CHILD_ID=$(curl -sf "${AUTH[@]}" -X POST "${BASE}/resource-group/v1/groups" -d "{
  \"type\": \"${USER_GROUP_TYPE}\",
  \"name\": \"Reviewers\",
  \"parent_id\": \"${GROUP_ID}\"
}" | jq -r '.id')
echo "nested group: ${CHILD_ID}"

step "3. Add user to 'Reviewers' (membership = group × resource_type × resource_id)"
curl -sf "${AUTH[@]}" -X POST \
  "${BASE}/resource-group/v1/memberships/${CHILD_ID}/${USER_TYPE}/${USER_ID}" | jq .

step "4. List memberships"
curl -sf "${AUTH[@]}" "${BASE}/resource-group/v1/memberships" | jq .

step "5. Hierarchy: descendants of 'Workspace Members'"
curl -sf "${AUTH[@]}" "${BASE}/resource-group/v1/groups/${GROUP_ID}/descendants" | jq .

step "6. Negative: cycle attempt — reparent 'Workspace Members' under 'Reviewers'"
curl -s "${AUTH[@]}" -X PUT "${BASE}/resource-group/v1/groups/${GROUP_ID}" -d "{
  \"name\": \"Workspace Members\",
  \"parent_id\": \"${CHILD_ID}\",
  \"metadata\": null
}" | jq -c '{expected_rejection: (.title // .code // .)}'

echo
echo "Groups demo complete: user-group container + nested group + membership +"
echo "hierarchy traversal + cycle prevention — all delegated to Resource Group,"
echo "exactly as AM PRD §5.6 prescribes (AM proxies nothing)."
