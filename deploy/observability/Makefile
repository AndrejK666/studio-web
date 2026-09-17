# Observability stack for the studio cluster.
#
# Every release is `helm upgrade --install` with a pinned chart version and the
# values file next to this Makefile, so re-running a target is idempotent and a
# chart bump is a reviewable one-line diff — never a flag typed into a shell.
#
#   make all                      # namespace + the three releases
#   make status                   # what is running, what is being scraped
#   make CONTEXT=webstudio all    # a different cluster
#
# Chart versions are the ones Insight runs on its dev stand, with the exception
# of victoria-metrics-single (0.45.0 there as well). Bump deliberately: a chart
# major can rename the Service that Alloy remote-writes to.

CONTEXT ?= webstudio
NS      ?= studio-monitoring

VM_CHART_VERSION      ?= 0.45.0
KSM_CHART_VERSION     ?= 8.4.1
ALLOY_CHART_VERSION   ?= 1.12.1
GRAFANA_CHART_VERSION ?= 10.5.15

HELM    := helm --kube-context $(CONTEXT) --namespace $(NS)
KUBECTL := kubectl --context $(CONTEXT) --namespace $(NS)

.PHONY: all repos namespace netpol victoriametrics kube-state-metrics alloy-metrics dashboards grafana status targets uninstall

all: namespace netpol victoriametrics kube-state-metrics alloy-metrics grafana

repos:
	helm repo add vm https://victoriametrics.github.io/helm-charts/ >/dev/null
	helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null
	helm repo add grafana https://grafana.github.io/helm-charts >/dev/null
	helm repo update >/dev/null

namespace:
	kubectl --context $(CONTEXT) apply -f namespace.yaml

# Punches one hole per application namespace: studio-monitoring -> the container
# port named `metrics`. Without it the application namespaces' default-deny
# ingress drops every scrape, and the targets show as down rather than absent.
netpol:
	kubectl --context $(CONTEXT) apply -f scrape-netpol.yaml

victoriametrics: namespace
	$(HELM) upgrade --install vm vm/victoria-metrics-single \
		--version $(VM_CHART_VERSION) \
		--values victoriametrics/values.yaml \
		--wait --timeout 10m

kube-state-metrics: namespace
	$(HELM) upgrade --install kube-state-metrics prometheus-community/kube-state-metrics \
		--version $(KSM_CHART_VERSION) \
		--values kube-state-metrics/values.yaml \
		--wait --timeout 5m

# Last: it remote-writes to VictoriaMetrics and scrapes kube-state-metrics, so
# both must exist before it starts or the first scrape cycle logs failures.
alloy-metrics: namespace
	$(HELM) upgrade --install alloy-metrics grafana/alloy \
		--version $(ALLOY_CHART_VERSION) \
		--values alloy-metrics/values.yaml \
		--wait --timeout 5m

# Dashboards ship as one ConfigMap built from the JSON files, labelled for
# Grafana's sidecar to pick up. Adding a dashboard is adding a file here —
# no values edit, no chart bump, and no Helm templating over the JSON, which
# is what lets `{{ pod }}` legend formats stay written the way Grafana wants
# them rather than helm-escaped.
dashboards:
	kubectl --context $(CONTEXT) -n $(NS) create configmap studio-dashboards \
		--from-file=grafana/dashboards \
		--dry-run=client -o yaml \
		| kubectl label --local -f - grafana_dashboard=1 -o yaml \
		| kubectl --context $(CONTEXT) -n $(NS) apply -f -

grafana: namespace dashboards
	$(HELM) upgrade --install grafana grafana/grafana \
		--version $(GRAFANA_CHART_VERSION) \
		--values grafana/values.yaml \
		--wait --timeout 5m
	@echo
	@echo "  kubectl -n $(NS) port-forward svc/grafana 3000:80"
	@echo "  user admin / password:"
	@echo "  kubectl -n $(NS) get secret grafana -o jsonpath='{.data.admin-password}' | base64 -d"

status:
	$(HELM) list
	$(KUBECTL) get pods,pvc

# The collector's own view of its targets — the first thing to read when a
# dashboard panel is empty. Answers "is it being scraped" before "is the query
# wrong", which is the cheaper question.
targets:
	$(KUBECTL) port-forward svc/alloy-metrics 12345:12345 & \
		sleep 3; curl -s localhost:12345/api/v0/web/components | head -c 2000; kill %1

uninstall:
	-$(HELM) uninstall alloy-metrics
	-$(HELM) uninstall kube-state-metrics
	-$(HELM) uninstall vm
	@echo "Namespace and the VictoriaMetrics PVC are left in place on purpose."
