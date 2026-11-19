#!/usr/bin/env bash
# Keeps the `constructor` identity provider of the Studio realm in step with
# its configuration: signing in to Studio with a Constructor IdP account
# (keycloak/CONSTRUCTOR_SSO.md).
#
# Runs in the Keycloak image (it needs kcadm.sh and bash, nothing else), as
# the Helm chart's keycloak-constructor-idp Job and as the compose stand's
# keycloak-constructor-idp service. Idempotent: every run writes the same
# broker from the same inputs.
#
#   Configured (issuer, client id and secret all present):
#     reads the issuer's discovery document through Keycloak's own importer,
#     then creates the broker or updates it in place, enabled.
#   Not configured (any of the three missing):
#     switches an existing broker off and leaves it there; creates nothing.
#   CONSTRUCTOR_IDP_REMOVE=1:
#     deletes the broker and its mappers (the way back to before it existed).
#
# Environment:
#   KC_SERVER                    Keycloak base URL, e.g. http://keycloak:8080
#                                or http://<release>-keycloak:8080/auth
#   KC_ADMIN_USER, KC_ADMIN_PASSWORD   a master-realm admin
#   KC_REALM                     default: studio
#   CONSTRUCTOR_IDP_ISSUER       the IdP's issuer, discovery is read from
#                                <issuer>/.well-known/openid-configuration
#   CONSTRUCTOR_IDP_CLIENT_ID    the client registered at the IdP
#   CONSTRUCTOR_IDP_CLIENT_SECRET   the secret itself (the compose stand), or
#   CONSTRUCTOR_IDP_VAULT_DIR    Keycloak's files-plaintext vault directory
#                                (Kubernetes): when it holds
#                                <realm>_constructor-client-secret, the broker
#                                stores ${vault.constructor-client-secret} and
#                                Keycloak resolves it at sign-in. The secret
#                                never passes through this script.
#   CONSTRUCTOR_IDP_DISPLAY_NAME default: Constructor
#   KC_WAIT_SECONDS              how long to wait for Keycloak, default 300
set -euo pipefail

realm=${KC_REALM:-studio}
alias=constructor
kcadm=/opt/keycloak/bin/kcadm.sh
# kcadm keeps its session in a file; never in the image's home directory.
cfg=(--config "$(mktemp -d)/kcadm.config")
say() { echo "[constructor-idp] $*"; }

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

if [ "${CONSTRUCTOR_IDP_REMOVE:-0}" = 1 ]; then
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
issuer=${CONSTRUCTOR_IDP_ISSUER:-}
issuer=${issuer%/}
client_id=${CONSTRUCTOR_IDP_CLIENT_ID:-}
secret_ref=""
if [ -n "${CONSTRUCTOR_IDP_CLIENT_SECRET:-}" ]; then
    secret_ref=$CONSTRUCTOR_IDP_CLIENT_SECRET
elif [ -n "${CONSTRUCTOR_IDP_VAULT_DIR:-}" ] \
        && [ -s "${CONSTRUCTOR_IDP_VAULT_DIR}/${realm}_constructor-client-secret" ]; then
    secret_ref='${vault.constructor-client-secret}'
fi

if [ -z "$issuer" ] || [ -z "$client_id" ] || [ -z "$secret_ref" ]; then
    missing=()
    [ -n "$issuer" ] || missing+=(issuer)
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
# admin console would store from the same issuer.
discovery=$("$kcadm" create identity-provider/import-config "${cfg[@]}" -r "$realm" \
    -s providerId=oidc -s "fromUrl=$issuer/.well-known/openid-configuration" -o)
field() { printf '%s\n' "$discovery" | sed -n "s/^ *\"$1\" *: *\"\(.*\)\",\{0,1\} *$/\1/p" | head -n1; }
found_issuer=$(field issuer)
if [ "${found_issuer%/}" != "$issuer" ]; then
    say "discovery at $issuer names issuer '$found_issuer'; refusing to broker it"
    exit 1
fi
for f in authorizationUrl tokenUrl jwksUrl; do
    [ -n "$(field "$f")" ] || { say "discovery at $issuer has no $f"; exit 1; }
done

# ------------------------------------------------------------------- the broker
set_args=(
    -s "alias=$alias"
    -s providerId=oidc
    -s "displayName=${CONSTRUCTOR_IDP_DISPLAY_NAME:-Constructor}"
    -s enabled=true
    # Signing in proves who a person is and grants nothing (ADR-0011): no
    # mapper sets a tenant, a role or a group.
    #
    # trustEmail: Keycloak's OIDC broker then takes the IdP's email_verified
    # claim as the user's emailVerified, and falls back to "verified" only
    # when the claim is absent. Invitations are accepted only for a verified
    # address, so an unverified Constructor address claims nothing.
    -s trustEmail=true
    -s storeToken=false
    -s addReadTokenRoleOnCreate=false
    -s linkOnly=false
    -s hideOnLogin=false
    # The stock flow, as for github: a new address makes a user; an address
    # an existing user already has asks that user to confirm the link by
    # signing in as themselves first.
    -s "firstBrokerLoginFlowAlias=first broker login"
    -s "config.issuer=$issuer"
    -s "config.authorizationUrl=$(field authorizationUrl)"
    -s "config.tokenUrl=$(field tokenUrl)"
    -s "config.jwksUrl=$(field jwksUrl)"
    -s "config.userInfoUrl=$(field userInfoUrl)"
    -s "config.logoutUrl=$(field logoutUrl)"
    -s config.useJwksUrl=true
    -s config.validateSignature=true
    -s config.pkceEnabled=true
    -s config.pkceMethod=S256
    -s "config.defaultScope=openid email profile"
    -s "config.clientId=$client_id"
    -s "config.clientSecret=$secret_ref"
    -s config.clientAuthMethod=client_secret_post
    -s config.syncMode=IMPORT
    -s config.backchannelSupported=false
)
if [ "$exists" = 1 ]; then
    "$kcadm" update "identity-provider/instances/$alias" "${cfg[@]}" -r "$realm" "${set_args[@]}"
    say "updated '$alias' in realm $realm: issuer $issuer, client $client_id"
else
    "$kcadm" create identity-provider/instances "${cfg[@]}" -r "$realm" "${set_args[@]}"
    say "created '$alias' in realm $realm: issuer $issuer, client $client_id"
fi
