#!/usr/bin/env bash
# Print the base64 kubeconfig for the `dashboard-deployer` ServiceAccount, to
# paste into the MONITORING_KUBE_CONFIG_B64 repository secret.
#
#   kubectl --kubeconfig /path/to/admin.kubeconfig apply -f dashboards-rbac.yaml
#   ./dashboards-kubeconfig.sh | clip     # or | pbcopy, or > /tmp/kc.b64
#
# Run it with an administrator context: it reads a Secret, which the account it
# is minting a kubeconfig for cannot do itself.
#
# What comes out is scoped to one namespace and one verb set — see the Role in
# dashboards-rbac.yaml. It is still a credential: do not commit it, and do not
# paste it anywhere but the secret.
set -euo pipefail

CONTEXT="${CONTEXT:-webstudio}"
NS="${NS:-studio-monitoring}"
SA="dashboard-deployer"

k() { kubectl --context "$CONTEXT" -n "$NS" "$@"; }

server=$(kubectl --context "$CONTEXT" config view --minify --raw \
    -o jsonpath='{.clusters[0].cluster.server}')
ca=$(k get secret "${SA}-token" -o jsonpath='{.data.ca\.crt}')
token=$(k get secret "${SA}-token" -o jsonpath='{.data.token}' | base64 --decode)

if [ -z "$token" ]; then
    echo "no token in ${SA}-token — has dashboards-rbac.yaml been applied?" >&2
    exit 1
fi

cat <<YAML | base64 -w0
apiVersion: v1
kind: Config
clusters:
  - name: monitoring
    cluster:
      server: ${server}
      certificate-authority-data: ${ca}
contexts:
  - name: monitoring
    context:
      cluster: monitoring
      namespace: ${NS}
      user: ${SA}
current-context: monitoring
users:
  - name: ${SA}
    user:
      token: ${token}
YAML
echo
