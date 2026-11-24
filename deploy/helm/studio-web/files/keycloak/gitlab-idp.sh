#!/usr/bin/env bash
# Keeps the `gitlab` identity provider of the Studio realm in step with its
# configuration: signing in to Studio with a GitLab account, on gitlab.com or a
# self-hosted GitLab (keycloak/GITLAB_SSO.md).
#
# Runs in the Keycloak image (it needs kcadm.sh and bash, nothing else), as
# the Helm chart's keycloak-gitlab-idp Job and as the compose stand's
# keycloak-gitlab-idp service. Idempotent: every run writes the same broker
# from the same inputs.
#
# A generic OIDC broker against the GitLab's own discovery document, not
# Keycloak's stock `gitlab` provider type: that one has gitlab.com's
# addresses built in and cannot point at a self-hosted GitLab.
#
#   Configured (base URL, client id and secret all present):
#     reads <base>/.well-known/openid-configuration through Keycloak's own
#     importer, then creates the broker or updates it in place, enabled.
#   Not configured (any of the three missing):
#     switches an existing broker off and leaves it there; creates nothing.
#   GITLAB_IDP_REMOVE=1:
#     deletes the broker and its mappers (the way back to before it existed).
#
# Environment:
#   KC_SERVER                    Keycloak base URL, e.g. http://keycloak:8080
#                                or http://<release>-keycloak:8080/auth
#   KC_ADMIN_USER, KC_ADMIN_PASSWORD   a master-realm admin
#   KC_REALM                     default: studio
#   GITLAB_IDP_BASE_URL          the GitLab's address, e.g. https://gitlab.com
#                                or https://gitlab.example.com; GitLab's OIDC
#                                issuer is this address
#   GITLAB_IDP_CLIENT_ID         the Application ID of the GitLab OAuth app
#   GITLAB_IDP_CLIENT_SECRET     the secret itself (the compose stand), or
#   GITLAB_IDP_VAULT_DIR         Keycloak's files-plaintext vault directory
#                                (Kubernetes): when it holds
#                                <realm>_gitlab-client-secret, the broker
#                                stores ${vault.gitlab-client-secret} and
#                                Keycloak resolves it at sign-in. The secret
#                                never passes through this script.
#   GITLAB_IDP_DISPLAY_NAME      default: GitLab
#   GITLAB_IDP_TENANT_ID         the tenant_id a new user gets, default the
#                                sandbox tenant the github broker assigns
#   KC_WAIT_SECONDS              how long to wait for Keycloak, default 300
set -euo pipefail

realm=${KC_REALM:-studio}
# studio-user looks a brokered `gitlab` account's photo up by this alias
# (user_profile/gitlab_avatar.rs), and the alias it confirms is
# `gitlab:<username>` (ADR-0015). Not configurable on purpose.
alias=gitlab
kcadm=/opt/keycloak/bin/kcadm.sh
# kcadm keeps its session in a file; never in the image's home directory.
cfg=(--config "$(mktemp -d)/kcadm.config")
say() { echo "[gitlab-idp] $*"; }

: "${KC_SERVER:?KC_SERVER is required}"
: "${KC_ADMIN_USER:?KC_ADMIN_USER is required}"
: "${KC_ADMIN_PASSWORD:?KC_ADMIN_PASSWORD is required}"

# --------------------------------------------------- wait for Keycloak, sign in
deadline=$(( $(date +%s) + ${KC_WAIT_SECONDS:-300} ))
until "$kcadm" config credentials "${cfg[@]}" --server "$KC_SERVER" --realm master \
        --user "$KC_ADMIN_USER" --password "$KC_ADMIN_PASSWORD" >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
        say "Keycloak at $KC_SERVER did not accept the admin sign-in in time"
        exit 1
    fi
    sleep 5
done

exists=0
if "$kcadm" get "identity-provider/instances/$alias" "${cfg[@]}" -r "$realm" >/dev/null 2>&1; then
    exists=1
fi

if [ "${GITLAB_IDP_REMOVE:-0}" = 1 ]; then
    if [ "$exists" = 1 ]; then
        # Deleting the provider deletes its mappers and every user's link to it;
        # the users themselves stay.
        "$kcadm" delete "identity-provider/instances/$alias" "${cfg[@]}" -r "$realm"
        say "removed '$alias' from realm $realm"
    else
        say "'$alias' is not in realm $realm; nothing to remove"
    fi
    exit 0
fi

# ------------------------------------------------------------ what is configured
base=${GITLAB_IDP_BASE_URL:-}
base=${base%/}
# Tolerated, as studio-user tolerates it: the API root is not the issuer.
base=${base%/api/v4}
client_id=${GITLAB_IDP_CLIENT_ID:-}
secret_ref=""
if [ -n "${GITLAB_IDP_CLIENT_SECRET:-}" ]; then
    secret_ref=$GITLAB_IDP_CLIENT_SECRET
elif [ -n "${GITLAB_IDP_VAULT_DIR:-}" ] \
        && [ -s "${GITLAB_IDP_VAULT_DIR}/${realm}_gitlab-client-secret" ]; then
    secret_ref='${vault.gitlab-client-secret}'
fi

if [ -z "$base" ] || [ -z "$client_id" ] || [ -z "$secret_ref" ]; then
    missing=()
    [ -n "$base" ] || missing+=("base URL")
    [ -n "$client_id" ] || missing+=("client id")
    [ -n "$secret_ref" ] || missing+=("client secret")
    if [ "$exists" = 1 ]; then
        "$kcadm" update "identity-provider/instances/$alias" "${cfg[@]}" -r "$realm" -s enabled=false
        say "not configured (no ${missing[*]}): '$alias' switched off"
    else
        say "not configured (no ${missing[*]}): '$alias' stays absent"
    fi
    exit 0
fi

# ----------------------------------------------------------------- discovery
# Keycloak's own importer reads the document, so what it stores is what its
# admin console would store from the same address. GitLab's issuer is its
# external URL, so the base URL is the issuer.
discovery=$("$kcadm" create identity-provider/import-config "${cfg[@]}" -r "$realm" \
    -s providerId=oidc -s "fromUrl=$base/.well-known/openid-configuration" -o)
field() { printf '%s\n' "$discovery" | sed -n "s/^ *\"$1\" *: *\"\(.*\)\",\{0,1\} *$/\1/p" | head -n1; }
found_issuer=$(field issuer)
if [ "${found_issuer%/}" != "$base" ]; then
    say "discovery at $base names issuer '$found_issuer'; set GITLAB_IDP_BASE_URL to the GitLab's external URL"
    exit 1
fi
for f in authorizationUrl tokenUrl jwksUrl; do
    [ -n "$(field "$f")" ] || { say "discovery at $base has no $f"; exit 1; }
done

# ------------------------------------------------------------------- the broker
set_args=(
    -s "alias=$alias"
    -s providerId=oidc
    -s "displayName=${GITLAB_IDP_DISPLAY_NAME:-GitLab}"
    -s enabled=true
    # Signing in proves who a person is and grants nothing (ADR-0011): no
    # mapper sets a role or a group. The one mapper below gives a new user the
    # tenant_id attribute every Studio token must carry, as github's does.
    #
    # trustEmail: Keycloak's OIDC broker then takes GitLab's email_verified
    # claim as the user's emailVerified. GitLab sends it with the `email`
    # scope, true only for a confirmed address, so an unconfirmed GitLab
    # address stays unverified in the realm and claims no invitation.
    -s trustEmail=true
    -s storeToken=false
    -s addReadTokenRoleOnCreate=false
    -s linkOnly=false
    -s hideOnLogin=false
    # The stock flow, as for github: a new address makes a user; an address
    # an existing user already has asks that user to confirm the link by
    # signing in as themselves first (keycloak/tests/account-takeover.test.mjs).
    -s "firstBrokerLoginFlowAlias=first broker login"
    -s "config.issuer=$base"
    -s "config.authorizationUrl=$(field authorizationUrl)"
    -s "config.tokenUrl=$(field tokenUrl)"
    -s "config.jwksUrl=$(field jwksUrl)"
    -s "config.userInfoUrl=$(field userInfoUrl)"
    -s "config.logoutUrl=$(field logoutUrl)"
    -s config.useJwksUrl=true
    -s config.validateSignature=true
    -s config.pkceEnabled=true
    -s config.pkceMethod=S256
    # read_user: GitLab's own `/api/v4/user`, the same account the ID token
    # names; nothing here reads a repository.
    -s "config.defaultScope=openid profile email read_user"
    -s "config.clientId=$client_id"
    -s "config.clientSecret=$secret_ref"
    -s config.clientAuthMethod=client_secret_post
    -s config.syncMode=IMPORT
    -s config.backchannelSupported=false
)
if [ "$exists" = 1 ]; then
    "$kcadm" update "identity-provider/instances/$alias" "${cfg[@]}" -r "$realm" "${set_args[@]}"
    say "updated '$alias' in realm $realm: GitLab $base, client $client_id"
else
    "$kcadm" create identity-provider/instances "${cfg[@]}" -r "$realm" "${set_args[@]}"
    say "created '$alias' in realm $realm: GitLab $base, client $client_id"
fi

# ------------------------------------------------------------------ the mapper
# Studio's authentication refuses a token without a `tenant_id` claim
# ("missing claim"), and the realm user is where the portal client's mapper
# reads it from. The github, google, microsoft and constructor brokers set it
# the same way: the sandbox tenant, on the first sign-in only (INHERIT = the
# broker's IMPORT). It is not an organization: membership is Studio's
# (ADR-0011).
tenant=${GITLAB_IDP_TENANT_ID:-00000000-0000-0000-0000-000000000002}
mapper=gitlab-tenant-id
mapper_id=$("$kcadm" get "identity-provider/instances/$alias/mappers" "${cfg[@]}" -r "$realm" \
    --fields id,name --format csv --noquotes | sed -n "s/^\([^,]*\),$mapper$/\1/p" | head -n1)
mapper_args=(
    -s "name=$mapper"
    -s "identityProviderAlias=$alias"
    -s identityProviderMapper=hardcoded-attribute-idp-mapper
    -s config.syncMode=INHERIT
    -s config.attribute=tenant_id
    -s "config.\"attribute.value\"=$tenant"
)
if [ -n "$mapper_id" ]; then
    "$kcadm" update "identity-provider/instances/$alias/mappers/$mapper_id" "${cfg[@]}" -r "$realm" "${mapper_args[@]}"
else
    "$kcadm" create "identity-provider/instances/$alias/mappers" "${cfg[@]}" -r "$realm" "${mapper_args[@]}" >/dev/null
fi
say "mapper $mapper: a new user's tenant_id is $tenant"
