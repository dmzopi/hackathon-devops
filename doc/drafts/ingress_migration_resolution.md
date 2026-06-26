# Draft: Resolution of Ingress 404 & Port Conflict Issues

This document outlines the troubleshooting and resolution steps taken to fix the `404 page not found` error and complete the Gateway API (`HTTPRoute` resources) migration for the application web/API, Grafana, and Prometheus.

---

## 🛠️ Actions Taken

### 1. Port Conflict Resolution (Traefik converted to ClusterIP)
- **Problem:** K3s's built-in Traefik LoadBalancer service was binding to host ports 80/443 on the cluster nodes, leaving the new Envoy-based Gateway `agentgateway-external` load balancer pods in a `Pending` state. Because of this, traffic targeting `job.scout.local` on port 80 hit Traefik instead of Envoy, which returned `404 page not found`.
- **Solution:** Patched the `traefik` HelmChart in the `kube-system` namespace to set `service.type: ClusterIP`. This immediately released the host ports, allowing the `svclb-agentgateway-external` daemonset pods to schedule, bind to port 80, and successfully proxy traffic.

### 2. GitOps & Observability Reorganization
- **observability-config-bootstrap:** Declared a new Flux Kustomization in both `dev/flux-system/components.yaml` and `prod/flux-system/components.yaml` that applies the CRD-dependent resources (observability HTTPRoute, PodMonitor, and Prometheus RBAC) in a decoupled namespace, resolving race conditions.
- **Production Kustomization Cleanup:** Updated `/platform/flux/clusters/prod/observability/kustomization.yaml` to remove references to the deleted/moved files, ensuring that production Kustomize builds compile cleanly.

### 3. Grafana & Prometheus Routing Fixes
- **Loki Datasource Default Flag:** Set `loki.isDefault` to `false` in `loki.yaml` for both environments to resolve the Grafana startup conflict where multiple default datasources were provisioned. Grafana now starts up successfully.
- **Prometheus Route Prefix:** Configured `prometheus.prometheusSpec.routePrefix` to `/prometheus` and `externalUrl` to `http://grafana.scout.local/prometheus/` in both dev and prod environments. This resolves the 404 error when navigating to `/prometheus`.

---

## 🧪 Verification Results

We verified routing by launching a test curl pod in the cluster:

### Application Routing (`job.scout.local`)
```http
HTTP/1.1 200 OK
server: nginx/1.31.2
content-type: text/html

<!doctype html>
<html lang="en">
...
```

### Grafana Routing (`grafana.scout.local/`)
```http
HTTP/1.1 302 Found
cache-control: no-store
location: /login
```

### Prometheus Routing (`grafana.scout.local/prometheus/`)
```http
HTTP/1.1 200 OK
content-type: text/html; charset=utf-8
...
<title>Prometheus Time Series Collection and Processing Server</title>
```
