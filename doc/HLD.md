# High-Level Solution Design (HLD) — JobMatch Platform

This document defines the high-level architecture of the **JobMatch** platform, including component design, request lifecycle, CI/CD automation workflows, and the evaluation loop (Evals) for the Scout startup.

---

## 1. System Architecture Diagram

To ensure security, FinOps control, and scalability, the architecture is implemented in two phases:

### Phase 1: Agent Gateway Integration (Current State)
Local scraping and job search orchestration ([JobSearchAgent.ts](../app/server/agent/JobSearchAgent.ts)) remain on the Node.js API server, but all LLM calls are proxied through **AgentGateway** (powered by Envoy). The gateway performs PII masking, filters prompt injections, and injects API credentials.

```mermaid
graph TD
    UI["React Frontend / Web UI"] -->|1. Upload CV & Search Query| API[jobmatch-api Pod]
    
    subgraph "Application Backend (jobmatch-dev)"
        API -->|2. Scrape job boards locally| Scrapers[Job Boards Scrapers]
        API -->|3. Route LLM scoring requests| AIClient[AIClient.ts]
    end

    subgraph "Platform Security (agentgateway-system)"
        AIClient -->|4. Request with x-gateway-task-name header| AGW[AgentGateway]
        AGW -->|5. PII Masking & Prompt Guard| AGW
        Secret[("claude-auth-secret / gemini-auth-secret / openai-auth-secret")] -->|6. Inject API Keys| AGW
    end

    AGW -->|7. Route based on task type to primary models| LLM["Claude Haiku 4.5 / Gemini 2.5 Flash-Lite"]
    LLM -->|8. Structured Job Score JSON| AGW
    AGW -->|9. Forward response| API
    API -->|10. Return ranked job list| UI
```

---

### Phase 2: Declarative Agent & Vector DB (Target Architecture)
Local orchestration logic is completely removed from the API server and migrated to declarative agent pods **kagent**, which interact with remote **MCP** servers for vectorization and semantic search inside **Qdrant Vector DB**.

```mermaid
graph TD
    UI["React Frontend / Web UI"] -->|1. Upload CV & Search Query| API[jobmatch-api Pod]
    
    subgraph "Agentic Pods (kagent namespace)"
        API -->|"2. Delegate matching task (A2A)"| KA["kagent (Declarative jobmatch-agent)"]
        KA -->|3. Vector query CV / vacancies| MCP[Remote MCP Server]
        MCP -->|4. Query cosine similarity| DB[("Qdrant Vector DB")]
        KA -->|5. Forward reasoning prompt with x-gateway-task-name| AGW[AgentGateway]
    end

    subgraph "Platform Security (agentgateway-system)"
        AGW -->|6. Redact PII & Filter injection| AGW
        AGW -->|7. Route based on task type & forward request| LLM["Anthropic Claude / Google Gemini"]
    end

    LLM -->|8. Response| KA
    KA -->|9. Final Match Report| API
    API -->|10. Return match results| UI
```

---

### Core System Components:
1. **React/Vite Frontend (Web):** Client application for uploading CVs and entering search queries.
2. **Backend API (Express):** Processes requests, runs local job board scrapers (Phase 1), and delegates matching tasks to agent pods via A2A (Phase 2).
3. **AI Client Layer ([AIClient.ts](../app/server/ai/AIClient.ts)):** Unified LLM client mapping all requests through `AgentGateway`.
4. **Agent Gateway ([AgentGateway](../platform/flux/clusters/dev/apps/jobmatch/agentgateway-policy.yaml)):** Envoy-based proxy for prompt injection filtering, data anonymization (masking emails, phones, SSNs, LinkedIn/GitHub links), and dynamic FinOps routing based on task names (routing simple matching to `gemini-2.5-flash-lite` / `gpt-5.4-nano`, and complex extraction tasks to `claude-haiku-4-5` / `gemini-3.5-flash`).
5. **Declarative Agent (jobmatch-agent) (Phase 2):** Specialized agent execution environment for prompt processing and MCP interactions.
6. **Memory (MCP + Qdrant) (Phase 2):** MCP server executing vector lookups against the Qdrant database.

---

## 2. CI/CD Pipeline and GitOps Release Process

Deployments are fully declarative, managed by the FluxCD GitOps controller, separated by cluster directories and Git branches.

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant Git as GitHub (Git repo)
    participant CI as GitHub Actions
    participant Registry as GHCR (Container Registry)
    participant DevCluster as Dev Cluster (Flux tracking 'dev')
    participant ProdCluster as Prod Cluster (Flux tracking 'main')

    Dev->>Git: Push to dev branch
    Git->>CI: Trigger Workflow (cicd.yml on dev)
    CI->>CI: Run Linter, Unit Tests & Evals
    CI->>Registry: Build & Push images (tag: v1.0.0-SHA, latest)
    CI->>Git: Auto-commit updated tag to clusters/dev/.../helm-release.yaml
    Git->>DevCluster: Reconcile (reconcileStrategy: Revision)
    DevCluster->>DevCluster: Deploy to namespace jobmatch-dev

    Note over Dev, ProdCluster: Promotion to Production (Promotion)
    Dev->>Git: Update tag in clusters/prod/.../helm-release.yaml on dev branch
    Dev->>Git: Create PR from dev to main & Merge
    Git->>ProdCluster: Reconcile (reconcileStrategy: ChartVersion)
    ProdCluster->>ProdCluster: Deploy to namespace jobmatch-prod
```

### Promotion Strategy:
* **Dev Cluster (branch `dev`):** Syncs with `platform/flux/clusters/dev`. On every push to `dev`, GHA builds container images with tag `v1.0.0-<git-sha>` and updates it in `dev/apps/jobmatch/helm-release.yaml`.
* **Prod Cluster (branch `main`):** Syncs with `platform/flux/clusters/prod`. Promotion is done by updating the image tag in `prod/apps/jobmatch/helm-release.yaml` on the `dev` branch, testing it, creating a PR to `main`, and merging it.

> [!NOTE]
> For the detailed CI/CD configuration files, path filters, and ConfigMap rolling update annotation triggers, see the [LLD — CI/CD & GitOps Operations](LLD.md#6-cicd-pipeline--gitops-operations).

---

### Comparison of Reconcile Strategies (reconcileStrategy)

To balance speed of development in Dev and stability in Prod, different reconcile strategies are configured:

1. **Dev Environment: reconcileStrategy: Revision**
   - **Mechanism:** Flux immediately reacts to any Git commits (image tag updates, value shifts, prompt files), tracking Git revisions.
   - **Advantage:** Maximum speed of delivery without the need to bump Helm chart version in `Chart.yaml` for every iteration.

2. **Prod Environment: reconcileStrategy: ChartVersion**
   - **Mechanism:** Flux performs production updates only when the Helm chart version (`spec.chart.spec.version` in `HelmRelease`) is explicitly changed.
   - **Advantage:** Protects against accidental changes. Value modifications or prompt updates will not take effect on production until the SRE engineer explicitly increases the chart version. This guarantees release control and prevents human errors.

---

## 3. LLM-as-a-Judge Evaluation Loop (Evaluation Engine)

An LLM Judge evaluates the quality of agent results upon prompt or code changes.

```mermaid
graph LR
    Dataset[(evals/dataset.json)] -->|Input CV + Job| Agent[JobSearchAgent]
    Agent -->|Output Ranking / Cover Letter| Judge[LLM-as-a-Judge]
    Dataset -->|Expected expected.md| Judge
    Judge -->|Evaluate Metrics: Relevance, Tone, Hallucination| Score[Scoring Engine]
    Score -->|Validate Threshold| Gate{CI Gate}
    Gate -->|Score >= 4.2| Pass[Pass Pipeline]
    Gate -->|Score < 4.2| Fail[Fail & Block PR]
```

### Metrics Framework:
1. **Relevance (1-5):** Scores how well matched vacancies correspond to the candidate's skills and experience.
2. **Tone (1-5):** Evaluates if the generated cover letter conforms to a professional tone.
3. **Hallucination-free (1-5):** Checks if the agent generated skills, credentials, or vacancy parameters not found in the input sources.
4. **Safety Score (1-5):** Evaluates if the output contains prompt leaks or signs of age/gender discrimination. Any violation drops the safety score to `1.0`.

> [!NOTE]
> For the golden dataset JSON schemas, test cases definitions, and evals runner logic, see the [LLD — Evaluation Engine](LLD.md#5-llm-as-a-judge-evaluation-engine).

---

## 4. Security Architecture

Multi-level security guards sensitive data and protects against input injections.

```mermaid
flowchart TD
    RawInput[Input CV / Job Description] -->|Upload| API[Express API]
    API -->|1. PII Redaction| Masker[Masker: removes names, emails, phones]
    Masker -->|Anonymized Text| Struct[XML Tagging wrapper: <cv_data>]
    Struct -->|2. Prompt Injection Shield| PromptBuilder[Prompt Builder]
    PromptBuilder -->|System instructions separate from data| AgentLoop[Agent loop & tools validation]
    AgentLoop -->|3. Allow-list check| Tools[Only white-listed tools executed]
    AgentLoop -->|4. Secrets Management| K8sSecrets[API keys via External Secrets / SOPS]
    AgentLoop -->|5. Output Guardrail| ContentFilter[Filter: prompt leakage / toxicity]
    ContentFilter --> Output[Final response to user]
```

### Key Security Mechanisms:
* **PII Redaction:** CVs are anonymized on the API server (or via AgentGateway policy) before sending data to cloud providers.
* **Structural Tagging:** XML wrappers separate instructions from candidate content to mitigate jailbreaks.
* **Tool Allow-listing:** The agent is restricted to calling validated domains.
* **Externalized Secrets:** All API keys are isolated from the application containers. They are injected centrally at the **AgentGateway** level from secrets in `agentgateway-system`.
* **Output Guardrails:** Regex check on the response stream inside **AgentGateway**. Blocks output containing prompt leakage indicators or discrimination filters (e.g. "only men", "under 35") with a policy violation response. webhook-based toxicity filters are proposed for future integration.

> [!NOTE]
> For the Cheerio HTML selectors, CV parsing libraries, and LLM output hallucination filters, see the [LLD — Core Service & Agent Execution Blueprint](LLD.md#2-core-service--agent-execution-blueprint).

---

## 5. Secrets Management

LLM API credentials are proxy-injected at the **AgentGateway** level. External Secrets Operator (ESO) automates synchronization.

### GCP Secret Manager Integration

Dev and Prod environments use **Google Secret Manager (GCP SM)** for secrets management, aligning configurations.

---

### Secret Lifecycle in the Cloud (Dev & Prod)

```mermaid
graph TD
    subgraph "Google Cloud Platform"
        GSM[("Google Secret Manager <br> (secrets: openai-api-key, ...)")]
    end

    subgraph "External Secrets Operator"
        CSS["ClusterSecretStore: gcp-secret-manager <br> (uses gcpsm provider)"] -->|1. Authenticates & pulls keys| GSM
    end

    subgraph "Namespace: agentgateway-system"
        ES_Claude["ExternalSecret: claude-auth-secret"] -->|2. Requests sync| CSS
        ES_Gemini["ExternalSecret: gemini-auth-secret"] -->|2. Requests sync| CSS
        
        CSS -->|3. Replicates & maps| TargetSecretClaude[("Secret: claude-auth-secret <br> (format: Authorization: Bearer ...)")]
        CSS -->|3. Replicates & maps| TargetSecretGemini[("Secret: gemini-auth-secret <br> (format: Authorization: Bearer ...)")]

        AGW["AgentGateway (Envoy)"] -->|4. Mounts & injects keys| TargetSecretClaude
        AGW["AgentGateway (Envoy)"] -->|4. Mounts & injects keys| TargetSecretGemini
    end
```

#### Sync Flow:
1. **Source of Truth:** Credentials live in GCP Secret Manager.
2. **Authorization:** ClusterSecretStore authenticates with GCP via Workload Identity.
3. **Mapping:** ExternalSecret resources retrieve keys and map them into destination K8s secrets formatted for AgentGateway.
4. **GitOps Integration:** YAML configurations are tracked in Git, whereas raw secret keys are never committed.

> [!NOTE]
> For the credentials injection setups, HTTP header passing code, and mock-llm verification rules, see the [LLD — FinOps & Gateway Routing](LLD.md#3-finops--gateway-routing-implementation).

---

## Local Development & Testing

For running the cluster locally:

### 1. Local Secrets
Developers configure local secrets or mock credentials using files. Detailed guide:
* [Local Secrets Management (local-development-secrets.md)](manuals/local-development-secrets.md)

### 2. Mock LLM Service
For local verification of masking and routing rules without incurring API costs, a **`mock-llm`** Node.js service is deployed at port `8089` in `jobmatch-dev` namespace.
* [Testing Prompt Masking & PII Redaction (testing-security-masking.md)](manuals/testing-security-masking.md)

> [!NOTE]
> For local mock-llm logging tests and Vitest unit testing mock scripts, see the [LLD — Testing Suite & Mocking Framework](LLD.md#4-testing-suite--mocking-framework).

---

## 6. Infrastructure Architecture

The infrastructure architecture of the JobMatch platform is designed to optimize operational simplicity (Ops-wise), financial efficiency (FinOps), reliability, and scalability to handle up to 100,000 monthly requests.

### 6.1 Infrastructure Environments Overview

| Parameter | Development Environment (Dev) | Production Environment (Prod) |
| :--- | :--- | :--- |
| **Compute VM** | GCP VM `e2-standard-2` (2 vCPUs, 8 GB RAM) | **GKE Autopilot** (Multi-zonal cluster node capacity) |
| **K8s Runtime** | Local `k3d` cluster inside VM | **GKE Autopilot** managed environment |
| **Relational Database** | PostgreSQL (local pod inside VM) | **GCP Cloud SQL for PostgreSQL** (managed, HA with replica) |
| **Vector DB** | Qdrant (local pod inside VM) | Qdrant (ephemeral memory index pod / Qdrant Cloud) |
| **Cache & DB** | Redis (local pod inside VM) | **GCP Memorystore for Redis** (managed basic tier) |
| **Traffic Router** | Nginx Ingress Controller (local) | **Google Cloud Load Balancing (GCLB)** |
| **Edge Security** | Local TLS (Self-signed) | **Google Cloud Armor** (WAF & DDoS) |
| **Secret Provisioning**| Local Secrets files / K8s Secrets | **Google Secret Manager** + ESO |
| **Monthly Estimate**| **~$48.00 / month** | **~$138.26 / month** |

### 6.2 Development Environment Topology (Dev)

To minimize developer workstation resource load and cloud expenditures:
- A single GCP `e2-standard-2` VM runs a standard Docker runtime.
- A local lightweight `k3d` cluster runs in Docker, mirroring Kubernetes API schemas.
- All development services (`jobmatch-api`, `jobmatch-web`, `agentgateway`, `mock-llm`, local PostgreSQL, Redis, and Qdrant) are deployed as pods within the `jobmatch-dev` namespace.

### 6.3 Production Environment Topology (Prod)

The production infrastructure is built on managed Google Cloud Platform (GCP) services for maximum availability, scaling, and security.

#### Production Architecture Diagram

![Production Architecture](drafts/gcp_production_architecture.png)

#### Traffic & Data Interaction Flow (Mermaid)

```mermaid
graph TD
    %% External Clients and DNS
    Internet["🌐 Internet (Users / API Clients)"] -->|HTTPS / DNS| DNS["DNS (Google Cloud DNS)"]
    DNS -->|Request| WAF["🛡️ Google Cloud Armor (WAF / DDoS protection)"]
    WAF -->|Clean Traffic| GCLB["🔀 External HTTP(S) Load Balancer (GCLB)"]

    %% VPC Network
    subgraph VPC ["VPC: jobmatch-prod-vpc (10.0.0.0/16)"]
        
        %% Public Subnet for Ingress
        subgraph PublicSubnet ["Public Subnet (10.0.1.0/24)"]
            GCLB -->|Ingress Traffic| NGINX["Ingress Nginx Controller"]
        end

        %% Private Subnet for Compute & DBs
        subgraph PrivateSubnet ["Private Subnet (10.0.2.0/19)"]
            
            %% Application Namespace
            subgraph NamespaceApp ["Namespace: jobmatch-prod"]
                NGINX -->|HTTP Route| Frontend["jobmatch-web (Pods)"]
                NGINX -->|API Route| Backend["jobmatch-api (Pods)"]
                Backend -->|Semantic Search| Qdrant["Qdrant Vector DB (Pods)"]
                Backend -->|Transactional Data| DB["GCP Cloud SQL for PostgreSQL"]
                DB <-->|Replication| DBReplica["PostgreSQL Replica (HA)"]
            end

            %% Security Gateway Namespace
            subgraph NamespaceGW ["Namespace: agentgateway-system"]
                Backend -->|LLM Requests (x-gateway-task-name)| EnvoyGW["AgentGateway (Envoy Pods)"]
                EnvoyGW -->|Mask Name Webhook| Masker["pii-masker (Presidio API Pods)"]
                ESO["External Secrets Operator"] -->|Syncs Keys| K8sSecrets["Target K8s Secrets"]
            end

            %% Caching
            Backend -->|Read/Write Cache| Redis["Managed GCP Memorystore (Redis)"]
            EnvoyGW -->|Mounts Keys| K8sSecrets
        end
    end

    %% External GCP Resources
    SecretManager["🔑 Google Secret Manager (GSM)"] -->| ESO Pulls Keys| ESO
    Backend -->|Uploads Resumes| GCS["🗄️ Google Cloud Storage (Secure Bucket)"]

    %% Outbound LLM Traffic
    EnvoyGW -->|6. HTTPS Outbound with credentials| PublicNAT["Cloud NAT / Cloud Router"]
    PublicNAT -->|7. API Call| CloudLLMs["Anthropic Claude / Google Gemini / OpenAI"]

    classDef gcp fill:#1a73e8,stroke:#fff,stroke-width:2px,color:#fff;
    classDef sec fill:#d93025,stroke:#fff,stroke-width:2px,color:#fff;
    classDef k8s fill:#34a853,stroke:#fff,stroke-width:2px,color:#fff;
    class GCLB,Redis,GCS,SecretManager,DNS,DB,DBReplica gcp;
    class WAF,EnvoyGW,Masker sec;
    class Frontend,Backend,Qdrant,ESO k8s;
```

#### Key Infrastructure Components:

1. **Google Cloud Load Balancing (GCLB):** Public traffic lands on GCLB, terminating client SSL/TLS connections using managed certificates (TLS 1.2/1.3 only, weak ciphers disabled).
2. **Google Cloud Armor:** Placed at the Load Balancer level, Cloud Armor provides L7 DDoS mitigation and WAF protections against exploit payloads.
3. **GKE Autopilot:** A fully managed, multi-zonal Kubernetes runtime. GKE Autopilot manages node provisioning, configuration, upgrades, and operating system patching. Pods are running with at least 2 replicas spread across multiple availability zones.
4. **GCP Memorystore for Redis:** Provides a reliable, managed in-memory cache for job search session data and API request caching.
5. **Qdrant Vector DB:** Deployed as an ephemeral/stateless vector database on GKE (or Qdrant Cloud). Vector index data is rebuilt on startup from source stores, bypassing the operational complexity of GKE persistent disks.
6. **GCP Cloud SQL for PostgreSQL:** A fully managed relational database service configured in High Availability (HA) mode with synchronous replication to a standby instance in a different availability zone, ensuring zero data loss and automated failover.

### 6.4 Scalability and Resource Limits

Under GKE Autopilot, billing is based on resource requests. Pod allocations are restricted to minimum stable baselines to maintain high cost-efficiency while permitting dynamic horizontal scaling (HPA) when CPU utilization exceeds 70%:

- `jobmatch-api`: 2 replicas, request limits `0.5 vCPU`, `1 GB RAM` each.
- `jobmatch-web`: 2 replicas, request limits `0.25 vCPU`, `256 MB RAM` each.
- `agentgateway` (Envoy proxy): 2 replicas, request limits `0.5 vCPU`, `512 MB RAM` each.

### 6.5 Production Infrastructure FinOps Cost Breakdown

Monthly infrastructure cost calculations based on 100,000 requests/month peak load in the `us-central1` region (assuming 730 monthly hours):
- **GKE Autopilot Pod Compute:**
  - `jobmatch-api` pods: $2 \times 0.5\text{ vCPU} \times \$0.0445/\text{vCPU-hr} \times 730 = \$32.49/\text{month}$
  - `jobmatch-api` memory: $2 \times 1.0\text{ GB} \times \$0.0049/\text{GB-hr} \times 730 = \$7.15/\text{month}$
  - `jobmatch-web` pods: $2 \times 0.25\text{ vCPU} \times \$0.0445/\text{vCPU-hr} \times 730 = \$16.24/\text{month}$
  - `jobmatch-web` memory: $2 \times 0.25\text{ GB} \times \$0.0049/\text{GB-hr} \times 730 = \$1.79/\text{month}$
  - `agentgateway` pods: $2 \times 0.5\text{ vCPU} \times \$0.0445/\text{vCPU-hr} \times 730 = \$32.49/\text{month}$
  - `agentgateway` memory: $2 \times 0.5\text{ GB} \times \$0.0049/\text{GB-hr} \times 730 = \$3.58/\text{month}$
  - **GKE Compute Subtotal:** **~$93.74/month** (The $73.00/month flat GKE cluster fee is completely offset by GCP's free tier cluster credit).
- **GCP Memorystore for Redis (Basic Tier, 1 GB):**
  - $1\text{ GB} \times 730\text{ hours} \times \$0.0127/\text{hour} = \mathbf{\$9.27/\text{month}}$
- **Google Cloud Load Balancer (GCLB):**
  - Base forwarding rules: $730\text{ hours} \times \$0.025/\text{hour} = \mathbf{\$18.25/\text{month}}$
- **Google Cloud Armor Standard + WAF rules:**
  - Rules, policy overhead, and query fees: **~$7.00/month**
- **Egress & Cloud Storage (Logs/Backups):**
  - Storage allocation and network egress: **~$10.00/month**
- **TOTAL INFRASTRUCTURE MONTHLY COST:** **~$138.26/month**

### 6.6 Security Mapping: GCP Services for OWASP Protections

| GCP Service | Target OWASP Vulnerability | Mitigation Details |
| :--- | :--- | :--- |
| **Google Cloud Armor** (WAF & DDoS) | • **OWASP Web A03: Injection** (SQLi, XSS)<br>• **OWASP Web A04: Insecure Design**<br>• **OWASP LLM01: Prompt Injection** | • Uses pre-configured WAF rule sets (CRS) to block SQLi, XSS, and command injections at the edge proxy layer.<br>• Mitigates L7 application DDoS and enforces rate limiting per client IP.<br>• Inspects payloads via custom expression filters to block prompt injection patterns prior to reaching GKE pods. |
| **Google Kubernetes Engine (GKE) Autopilot** | • **OWASP Web A01: Broken Access Control**<br>• **OWASP Web A05: Security Misconfiguration** | • **Network Isolation:** Built-in NetworkPolicies (via Dataplane V2) enforce micro-segmentation, ensuring only authorized namespaces/pods talk to each other.<br>• **Hardened Nodes:** Node configurations, OS patches, and updates are entirely managed by Google with SSH access blocked.<br>• **Pod Security Standards:** Rejects root containers, enforcing restricted profiles (read-only root filesystems). |
| **Google Secret Manager** (with Workload Identity) | • **OWASP Web A02: Cryptographic Failures**<br>• **OWASP LLM10: Model Theft / Excess Agency** | • Stores all API credentials encrypted at rest and in transit.<br>• **Workload Identity:** Maps K8s Service Accounts directly to GCP IAM roles, eliminating the need to compile or save long-lived credential JSONs in pods.<br>• Restricts key access solely to the `agentgateway` proxy in `agentgateway-system` namespace. |
| **Artifact Registry** & **Container Analysis** | • **OWASP Web A06: Vulnerable Components** | • Scans container images for CVEs automatically upon container push, blocking deployments of vulnerable containers. |
| **Google Cloud Load Balancing (GCLB)** | • **OWASP Web A02: Cryptographic Failures** | • Terminates external TLS using Google-managed certificates, enforcing TLS 1.2 or TLS 1.3 only. |
| **Cloud Logging** & **Cloud Monitoring** | • **OWASP Web A09: Logging & Monitoring Failures** | • Aggregates and alerts on GKE Audit Logs, VPC flow logs, Load Balancer access logs, and Secret Manager access metrics to detect security events. |

### 6.7 GCP Network Security Zoning

To prevent boundary crossings and secure communications, the production environment is partitioned into four logical security zones:

```mermaid
graph TD
    subgraph "Zone A: Public Internet Edge"
        DNS[Google Cloud DNS] -->|Encrypted DNS Queries| GCLB[Google Cloud Load Balancer]
    end

    subgraph "Zone B: Perimeter Security WAF"
        GCLB <-->|Inspect Traffic| Armor[Google Cloud Armor]
    end

    subgraph "Zone C: Isolated Compute Cluster"
        GCLB -->|TLS 1.3 Routing| Ingress[Kubernetes Ingress]
        Ingress -->|Namespace NetPolicy| App[jobmatch-api Pods]
        App <-->|Local mTLS| Gateway[AgentGateway Proxy Pods]
    end

    subgraph "Zone D: Private Storage Tier"
        App <-->|PSC / VPC Peering| Redis[(Memorystore Redis)]
        Gateway <-->|VPC Peering| Secret[(Google Secret Manager)]
    end
```

- **Zone A (Public Internet Edge):** Serves as the public entry-point. Resolves traffic via Cloud DNS and terminates SSL/TLS connections at the external Google Cloud Load Balancer (GCLB) using Google-managed certificates.
- **Zone B (Perimeter Security / WAF):** Google Cloud Armor integrates directly with GCLB to filter SQL injection, XSS, and layer 7 DDoS floods. It acts as the perimeter shield before any packets enter the internal network.
- **Zone C (Isolated Compute Cluster - GKE Autopilot):** Virtual machines and nodes run in private subnets with no public IP addresses. Cluster boundaries are secured using GKE Dataplane V2 NetworkPolicies, which isolate the `jobmatch-prod` namespace from other workloads and ensure that only the Ingress controller can route traffic to internal application pods.
- **Zone D (Private Storage Tier):** Contains managed storage services. GCP Memorystore for Redis and GCP Secret Manager are reached only through Private Service Connect (PSC) or VPC Peering endpoints from within Zone C. Direct public access to the storage tier is entirely blocked at the GCP VPC firewall layer.

### 6.8 Observability & Monitoring Architecture

To monitor the performance, cost, and safety of the AI-powered search, the platform implements a standardized observability stack using Prometheus, Loki, Promtail, and Grafana.

#### Observability & Traffic Flow Diagram
The observability infrastructure monitors metrics and logs, and exposes the Grafana UI under a secured subpath:
1. **Metrics:** Scraped from the Envoy-based `AgentGateway` proxy namespace into Prometheus.
2. **Logs:** Collected by a Promtail DaemonSet from all containers across namespaces and forwarded to Loki.
3. **Ingress & Routing:** Public HTTP requests hitting `/grafana` pass through a Traefik Ingress, where a subpath stripping middleware intercepts and rewrites requests before forwarding them to Grafana.
4. **Traffic Mirroring:** Asynchronous request shadowing copies 100% of LLM traffic from `AgentGateway` to `mock-llm` for continuous payload auditing without impact on client latency.

```mermaid
graph TD
    User([Browser User]) -->|1. HTTP request to /grafana| Ingress["Traefik Ingress <br> (kube-prometheus-stack-grafana)"]
    Ingress -->|2. Intercepts and strips prefix| Middleware["Traefik Middleware <br> (grafana-stripprefix)"]
    Middleware -->|3. Routes to port 80| Grafana["Grafana Pod"]

    subgraph "Namespace: agentgateway-system"
        AGW["AgentGateway Proxy Pods <br> (app: agentgateway-external)"] -->|Exposes Envoy stats| Endpoint["/stats/prometheus <br> (Port: metrics)"]
        AGW -->|StdOut/Err Logs| K8sLogs["K8s Container Log Engine"]
    end

    subgraph "Namespace: jobmatch-dev"
        Prom["Prometheus Operator <br> (kube-prometheus-stack)"] -->|Discovers via selector| PM["PodMonitor <br> (agentgateway-external-monitor)"]
        PM -->|Scrapes metrics every 15s| Endpoint
        Prom -->|Provides Metrics Datasource| Grafana
        
        Loki["Loki Stack <br> (Loki 5Gi Persistence)"] -->|Provides Logs Datasource isDefault: false| Grafana
        Promtail["Promtail DaemonSet"] -->|Scrapes container logs| K8sLogs
        Promtail -->|Pushes log streams| Loki
        
        Kust["Kustomize configMapGenerator"] -->|Generates with label grafana_dashboard: '1'| CM[("ConfigMap: jobmatch-llm-dashboard <br> (contains dashboard.json)")]
        GrafanaSidecar["Grafana Dashboard Sidecar"] -->|Auto-detects label & imports| CM
        GrafanaSidecar -->|Loads dashboard| Grafana
        
        MockLLM["Mock LLM Deployment <br> (mock-llm:8089)"] -->|Logs mirrored request bodies| MockLogs["Container logs"]
    end
    
    AGW -->|4. Mirrors 100% request traffic asynchronously| MockLLM
    RefGrant["ReferenceGrant: allow-gateway-to-mock-llm"] -.->|Authorizes cross-namespace mirroring| AGW
    
    PromSA["Prometheus ServiceAccount <br> (kube-prometheus-stack-prometheus)"] -.->|RBAC: RoleBinding| Role["Role: prometheus-k8s-allow-gateway <br> (in agentgateway-system)"]
    PM -.->|Authorizes scraping| PromSA
```


#### Key Monitored Metrics
The following metrics are collected from Envoy's Prometheus stats and visualized on the dashboard:

| Metric Group | Envoy Metric Name | Description / Dashboard Panel |
| :--- | :--- | :--- |
| **Request Volume** | `agentgateway_requests_total` | Tracks total requests routed through the gateway (visualized as request rate over 5m). |
| **LLM Latency** | `agentgateway_gen_ai_server_request_duration_sum` <br> `agentgateway_gen_ai_server_request_duration_count` | Calculates average LLM response time over 5m (`sum / count`). |
| **Token Consumption** | `agentgateway_gen_ai_client_token_usage_sum` | Tracks volume of input/output tokens consumed by LLM interactions. |
| **Prompt Injection Blocks**| `agentgateway_guardrail_checks_total` | Monitors the count of blocked malicious prompt injections or guardrail policy violations. |


### 6.9 Multi-Provider Failover & High Availability (HA)

To ensure high availability and protect against API rate limits or cloud outages, the platform implements a dual-tiered multi-provider failover architecture:

1. **Gateway-Level Priority Groups & Eviction (Passive Health Checks):**
   - In `AgentgatewayBackend` (both dev and prod overlays), LLM providers are divided into ordered priority groups representing primary and fallback options.
   - Passive health check policies (`spec.policies.health`) monitor connection timeouts and response codes. If a provider fails to resolve/connect or returns `>= 500`, `429`, or `401` status codes, it is evicted for `90s` (based on `consecutiveFailures: 1`).
   - Subsequent client requests are automatically routed to the next healthy provider group. `modelAliases` (e.g. `claude-haiku-4-5: gemini-3.5-flash`) translate model names and request formats dynamically.

2. **Application-Tier Client Fallback Retry:**
   - In [openai.ts](../app/server/ai/providers/openai.ts), LLM completion requests are wrapped in try/catch blocks.
   - If the primary gateway call fails (e.g., during active failover before the gateway eviction state propagates to all endpoints), the client intercepts the exception and issues a retry using the fallback model:
     - **Complex Tasks:** `claude-haiku-4-5` $\rightarrow$ fallback to `gemini-3.5-flash`
     - **Simple Tasks:** `gemini-2.5-flash-lite` $\rightarrow$ fallback to `gpt-5.4-nano`
   - The retry request goes directly to the secondary provider group configured at the gateway level.



