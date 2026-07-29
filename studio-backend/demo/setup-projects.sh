#!/usr/bin/env bash
# Register the Studio "project" Resource Group type (ADR-0002).
# Idempotent: a 409 on re-run means the type is already registered.
set -euo pipefail

BASE="http://127.0.0.1:8090/cf"
TOKEN="${1:-studio-admin-token}"

curl -s -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -X POST "${BASE}/types-registry/v1/types" -d '{
    "code": "gts.cf.core.rg.type.v1~cf.studio.project.v1~",
    "can_be_root": true,
    "allowed_parent_types": [],
    "allowed_membership_types": ["gts.cf.core.rg.type.v1~cf.core.am.user.v1~"]
  }' | jq .
