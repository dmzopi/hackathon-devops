# GCP Dev Environment Setup & Platform Launch Guide

This manual provides a step-by-step guide to provisioning the **JobMatch Development Environment** on Google Cloud Platform (GCP) and deploying the platform using GitOps (**FluxCD**) and **External Secrets Operator (ESO)** with **Google Secret Manager (GSM)**, as designed in the [High-Level Solution Design (HLD)](../HLD.md#62-development-environment-topology-dev).

---

## 📐 Architecture Overview (Dev Environment)

According to the platform architecture:
* **Compute Host:** A single cost-effective GCP VM (`e2-standard-2`, 2 vCPU, 8 GB RAM) running Ubuntu and lightweight Kubernetes (`k3s` or `k3d`), minimizing cloud costs to **~$48/month**.
* **GitOps Engine:** **FluxCD** reconciles manifests from `./platform/flux/clusters/dev` (tracking branch `dev`).
* **Secrets Management:** **External Secrets Operator (ESO)** pulls LLM credentials (`gemini-api-key`, `claude-api-key`, `openai-api-key`) from **Google Secret Manager** via service account key / Workload Identity.
* **Core Services:** `jobmatch-web`, `jobmatch-api`, `agentgateway`, Redis cache, and Qdrant vector database running in namespace `jobmatch-dev`.

---

## 📋 Prerequisites

Ensure you have the following CLI tools installed locally:
* **Google Cloud SDK (`gcloud`)**: [Install guide](https://cloud.google.com/sdk/docs/install)
* **`kubectl`**: [Install guide](https://kubernetes.io/docs/tasks/tools/)
* **`flux` CLI**: [Install guide](https://fluxcd.io/flux/installation/)
* Active GCP project with billing enabled (e.g. `happy-deploys-job-searcher` or your own `$GCP_PROJECT_ID`).

Set your project variables:
```bash
export GCP_PROJECT_ID="your-gcp-project-id"
export GCP_ZONE="us-central1-a"
export VM_NAME="jobmatch-dev-vm"

gcloud config set project $GCP_PROJECT_ID
gcloud config set compute/zone $GCP_ZONE
```

---

## Step 1: Provision the GCP Compute Host

### 1.1 Enable Required GCP APIs
```bash
gcloud services enable \
  compute.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com
```

### 1.2 Create Firewall Rules for Web & API Access
```bash
gcloud compute firewall-rules create allow-jobmatch-dev \
  --allow=tcp:80,tcp:443,tcp:8080,tcp:3001,tcp:6443 \
  --target-tags=jobmatch-dev \
  --description="Allow HTTP/API and Kube API access to dev VM"
```

### 1.3 Create the Compute VM (`e2-standard-2`)
```bash
gcloud compute instances create $VM_NAME \
  --machine-type=e2-standard-2 \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=50GB \
  --tags=jobmatch-dev
```

### 1.4 Connect to the VM and Install Lightweight Kubernetes (k3s)
SSH into your VM:
```bash
gcloud compute ssh $VM_NAME
```

Inside the VM, install `k3s` and configure `kubectl`:
```bash
# Install k3s with flannel and local path provisioner
curl -sfL https://get.k3s.io | sh -s - --write-kubeconfig-mode 644

# Verify cluster status
kubectl get nodes
```

*(Optional: If managing remotely from your local workstation, copy `/etc/rancher/k3s/k3s.yaml` to your workstation's `~/.kube/config`, replacing `127.0.0.1` with the external IP of the VM).*

---

## Step 2: Configure Google Secret Manager & Service Account

The platform uses **External Secrets Operator** to pull keys from Google Secret Manager into Kubernetes secrets.

### 2.1 Store LLM API Keys in Secret Manager
Run these commands from your workstation (or within the VM):
```bash
# 1. Google Gemini Key
echo -n "YOUR_GEMINI_API_KEY" | gcloud secrets create gemini-api-key \
  --data-file=- \
  --replication-policy="automatic"

# 2. Anthropic Claude Key
echo -n "YOUR_CLAUDE_API_KEY" | gcloud secrets create claude-api-key \
  --data-file=- \
  --replication-policy="automatic"

# 3. OpenAI Key (Optional)
echo -n "YOUR_OPENAI_API_KEY" | gcloud secrets create openai-api-key \
  --data-file=- \
  --replication-policy="automatic"
```

### 2.2 Create IAM Service Account for External Secrets Operator (ESO)
```bash
# Create dedicated Service Account
gcloud iam service-accounts create eso-sa \
  --display-name="External Secrets Operator Service Account"

# Grant Secret Manager Secret Accessor role
gcloud projects add-iam-policy-binding $GCP_PROJECT_ID \
  --member="serviceAccount:eso-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Generate credentials key JSON
gcloud iam service-accounts keys create /tmp/gcp-sa-key.json \
  --iam-account=eso-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com
```

### 2.3 Inject the SA Key Secret into Kubernetes
Create the `external-secrets` namespace and apply the credential secret expected by `platform/flux/clusters/dev/apps/jobmatch/cluster-secret-store.yaml`:
```bash
kubectl create namespace external-secrets --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic gcp-sa-key \
  -n external-secrets \
  --from-file=key.json=/tmp/gcp-sa-key.json \
  --dry-run=client -o yaml | kubectl apply -f -

# Securely remove temporary file
rm /tmp/gcp-sa-key.json
```

---

## Step 3: Launch Platform via FluxCD GitOps

### 3.1 Install Flux on the Cluster
Inside the VM (or from your machine pointing to the cluster):
```bash
curl -s https://fluxcd.io/install.sh | sudo bash

flux check --pre
flux install
```

### 3.2 Bootstrap the Dev Cluster
Bootstrap Flux pointing to the `dev` cluster directory:
```bash
# Using GitHub Personal Access Token (GITHUB_TOKEN)
export GITHUB_TOKEN="ghp_yourPersonalAccessToken"
export GITHUB_USER="your-github-username"

flux bootstrap github \
  --owner=$GITHUB_USER \
  --repository=hackathon-devops \
  --branch=dev \
  --path=./platform/flux/clusters/dev \
  --personal
```

#### Alternative: Direct Manual Apply (Without GitHub Token)
If you want to quickly deploy and test without configuring a personal GitHub token for Flux bootstrap:
```bash
# 1. Install External Secrets Operator (ESO)
kubectl apply -k platform/flux/clusters/dev/infra/eso

# 2. Deploy JobMatch Dev Stack (Apps, Ingress, AgentGateway, Redis, Qdrant)
kubectl apply -k platform/flux/clusters/dev/apps/jobmatch
```

---

## Step 4: Verify Deployment & Status

### 4.1 Check GitOps Reconciliations
```bash
flux get kustomizations
flux get helmreleases -A
```

### 4.2 Verify External Secret Synchronization
Check that ESO successfully read keys from Google Secret Manager:
```bash
kubectl get externalsecret llm-secrets -n jobmatch-dev
kubectl get secret llm-secrets -n jobmatch-dev
```
Expected status: `SecretSynced=True`.

### 4.3 Verify Workloads & Pods
```bash
kubectl get pods -n jobmatch-dev
```
Expected output:
```text
NAME                                  READY   STATUS    RESTARTS   AGE
jobmatch-dev-api-xxxxxxxxxx-xxxxx     1/1     Running   0          2m
jobmatch-dev-web-xxxxxxxxxx-xxxxx     1/1     Running   0          2m
jobmatch-dev-redis-master-0           1/1     Running   0          2m
jobmatch-dev-qdrant-0                 1/1     Running   0          2m
agentgateway-proxy-xxxxxxxxxx-xxxxx   1/1     Running   0          2m
```

---

## Step 5: Access the Platform

### 5.1 Port-Forwarding (Instant Access)
Run port-forwarding on the VM or via SSH tunnel:
```bash
# Forward Web frontend (port 8080)
kubectl port-forward svc/jobmatch-dev-web 8080:80 -n jobmatch-dev --address 0.0.0.0 &

# Forward API server (port 3001)
kubectl port-forward svc/jobmatch-dev-api 3001:3001 -n jobmatch-dev --address 0.0.0.0 &
```

### 5.2 Test API Health & AI Status
```bash
curl http://localhost:3001/api/health
```
When keys are properly synced from Google Secret Manager via `AgentGateway`, the health check responds with:
```json
{
  "status": "ok",
  "demoMode": false,
  "llm": {
    "provider": "auto",
    "jobSearchReady": true,
    "jobBoardsInCatalog": 79
  }
}
```

### 5.3 Access Web UI
Open your browser at:
* **`http://<VM_EXTERNAL_IP>:8080`** (or `http://localhost:8080` if using SSH port tunnel: `ssh -L 8080:localhost:8080 $VM_NAME`).

---

## 🛠️ Troubleshooting

| Issue | Cause | Resolution |
|---|---|---|
| `SecretSynced=False` on `llm-secrets` | ESO cannot authenticate to GSM | Verify `gcp-sa-key` secret in `external-secrets` namespace and ensure `roles/secretmanager.secretAccessor` is granted. |
| `ClusterSecretStore` error | Invalid project ID | Verify that `projectID` in `platform/flux/clusters/dev/apps/jobmatch/cluster-secret-store.yaml` matches your `$GCP_PROJECT_ID`. |
| Ingress / Port unreachable | GCP Firewall blocking traffic | Verify firewall rules with `gcloud compute firewall-rules list --filter="name=allow-jobmatch-dev"`. |
| Flux reconciliation error | Chart download or repo auth failed | Run `flux reconcile kustomization flux-system --with-source` to view detailed reconciliation logs. |
