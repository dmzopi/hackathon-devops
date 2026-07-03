# Інтеграція з Agentic Sandbox (abox) & GitOps у GCP

Цей документ містить аналіз ідеї розгортання кластера на базі **abox** на віртуальній машині в GCP, інструкцію з розгортання та детальний опис структури папки FluxCD для ізоляції середовищ на рівні Namespace.

---

## 1. Аналіз ідеї (Оцінка рішення)

Ідея розгорнути Kubernetes-кластер за допомогою **abox** на віртуальній машині (Compute Engine) в GCP з ізоляцією середовищ на рівні Namespace є **надзвичайно вдалою та оптимальною для стартапу Scout** з кількох причин:

### 👍 Чому це гарна ідея (Плюси):
1. **Економічність (Cost Efficiency):** Замість створення 2-3 окремих керованих кластерів GKE (що коштує дорого та довго розгортається), ви використовуєте одну потужну віртуальну машину (наприклад, `e2-standard-4` або `e2-standard-8`), яка хостить локальний KinD-кластер. Це економить бюджет стартапу Scout та дозволяє вкластися у безкоштовні ліміти.
2. **Все включено з коробки (Out-of-the-Box AI Infra):** `abox` автоматично ставить **AgentGateway** (Gateway API) та **kagent**, що закриває вимоги стартапу Scout щодо AI-інфраструктури та безпеки промптів.
3. **Швидкість розгортання:** Створення кластера через KinD/k3d у VM триває менше 3 хвилин. Будь-які помилки лікуются простим видаленням та перестворенням VM.
4. **Namespace-ізоляція:** Спільний кластер з різними Namespace (`jobmatch-dev`, `jobmatch-staging`, `jobmatch-prod`) є класичним патерном для невеликих команд. Він забезпечує швидкий мережевий зв'язок та спільне використання ресурсів (наприклад, одна інстанція Qdrant або Redis може хостити різні бази для dev/prod).

### ⚠️ На що звернути увагу (Ризики):
* **Обмеження ресурсів VM:** Потрібно обрати VM з достатньою кількістю ресурсів. Рекомендовано мінімум **4 vCPU, 16 GB RAM (e2-standard-4)** та 50-100 GB SSD диском.
* **Вкладена віртуалізація:** KinD працює в Docker, тому VM повинна мати встановлений Docker. Вкладена віртуалізація (nested virtualization) не обов'язкова для KinD, що спрощує вибір типу VM в GCP.

---

## 2. Як правильно розгортати цей кластер у GCP

### Крок 1: Створення VM в GCP Compute Engine
Створіть віртуальну машину через gcloud CLI або консоль GCP:
```bash
gcloud compute instances create abox-sandbox \
    --zone=us-central1-a \
    --machine-type=e2-standard-4 \
    --image-family=ubuntu-2204-lts \
    --image-project=ubuntu-os-cloud \
    --boot-disk-size=50GB \
    --boot-disk-type=pd-ssd \
    --tags=http-server,https-server
```
*Важливо: переконайтеся, що у## 4. Структура папки Flux з маніфестами (GitOps Repository Layout)

Для керування середовищами через FluxCD, папка `platform/` у нашому репозиторії структурується наступним чином:

```
platform/
├── flux/
│   ├── gotk-sync.yaml             # Конфігурація підключення Flux до Git
│   └── kustomizations.yaml        # Опис Kustomizations для dev та prod
├── helm/
│   └── jobmatch/                  # Наш Umbrella Helm Chart
│       ├── Chart.yaml             # Визначення чарту та залежностей (Redis, Qdrant)
│       ├── values.yaml            # Значення за замовчуванням
│       ├── skills/                # Синхронізовані файли промптів
│       └── templates/             # Шаблони Web, API та ConfigMap
│           ├── deployment-api.yaml
│           ├── deployment-web.yaml
│           ├── configmap-skills.yaml
│           └── ...
└── environments/
    ├── dev/
    │   ├── kustomization.yaml     # Оверлей для dev (Namespace: jobmatch-dev)
    │   └── helm-release.yaml      # FluxCD HelmRelease з параметрами для dev
    └── prod/
        ├── kustomization.yaml     # Оверлей для prod (Namespace: jobmatch-prod)
        └── helm-release.yaml      # FluxCD HelmRelease з параметрами для prod
```

### Приклади ключових маніфестів Flux:

#### 📂 `platform/flux/kustomizations.yaml`
Цей файл описує, як FluxCD повинен застосовувати наші конфігурації в різні Namespace.
```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: jobmatch-dev
  namespace: flux-system
spec:
  interval: 2m0s
  path: ./platform/environments/dev
  prune: true
  sourceRef:
    kind: GitRepository
    name: flux-system
  timeout: 1m
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: jobmatch-prod
  namespace: flux-system
spec:
  interval: 5m0s
  path: ./platform/environments/prod
  prune: true
  sourceRef:
    kind: GitRepository
    name: flux-system
  timeout: 2m
```

#### 📂 `platform/environments/dev/kustomization.yaml`
Оверлей для розробки. Встановлює цільовий namespace та підключає Helm-реліз.
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: jobmatch-dev

resources:
  - helm-release.yaml

labels:
  - includeSelectors: true
    pairs:
      environment: development
```

#### 📂 `platform/environments/dev/helm-release.yaml`
Конфігурація деплойменту в dev за допомогою FluxCD `HelmRelease`.
```yaml
apiVersion: helm.toolkit.fluxcd.io/v2beta1
kind: HelmRelease
metadata:
  name: jobmatch-dev
  namespace: jobmatch-dev
spec:
  interval: 5m
  chart:
    spec:
      chart: ./platform/helm/jobmatch
      sourceRef:
        kind: GitRepository
        name: flux-system
        namespace: flux-system
  install:
    remediation:
      retries: 3
  values:
    global:
      environment: dev
    api:
      replicaCount: 1
      image:
        tag: v1.0.0-dev # {"$imagepolicy": "flux-system:jobmatch-api-dev"}
    web:
      replicaCount: 1
      image:
        tag: v1.0.0-dev # {"$imagepolicy": "flux-system:jobmatch-web-dev"}
    redis:
      enabled: true
      architecture: standalone
      master:
        persistence:
          enabled: false
    qdrant:
      enabled: true
      persistence:
        enabled: false
```

---

## 5. Управління промптами (PromptOps) & Синхронізація

Використання Kustomize `configMapGenerator` для файлів скілів, розташованих вище папки оверлею, блокується правилами безпеки Kustomize Load Restrictors, які FluxCD не дозволяє обійти. 

Ми вирішили цю проблему, перенісши генерацію `ConfigMap` на рівень **Helm**:

1. **Динамічний імпорт у Helm:** У нашому Helm-чарті створено шаблон `templates/configmap-skills.yaml`, який використовує вбудовану функцію Helm `.Files.Glob`, автоматично зчитуючи всі markdown-файли з папки `skills/` всередині чарту і монтуючи їх як окремі ключі ConfigMap.
2. **Скрипт локального копіювання:** Створено скрипт `scripts/sync-skills.sh`, який копіює актуальні файли з `app/skills` до `platform/helm/jobmatch/skills/` перед комітом.
3. **Контроль в CI:** Крок `Verify Skills Sync` у GitHub Actions перевіряє, чи скіли в репозиторії Helm-чарту синхронізовані з кодом. Це гарантує цілісність промптів і запобігає розбіжностям у конфігураціях.

---

## 6. Доступ до AgentGateway ззовні кластера в GCP

Оскільки `abox` розгортає `KinD` у Docker всередині VM, IP-адреса типу `LoadBalancer`, яку надає `cloud-provider-kind` для `AgentGateway`, є локальною для віртуальної машини (наприклад, `172.19.0.2`). 

Щоб зробити API-шлюз доступним із публічного інтернету:

### Варіант А: Прокидання портів через `socat` (Найпростіший для стартапу Scout)
Запустіть утиліту `socat` як фонову службу на VM, щоб перенаправляти вхідний трафік на порти `80` та `443` VM на IP-адресу LoadBalancer кластера:
```bash
# Отримайте IP LoadBalancer AgentGateway
GATEWAY_IP=$(kubectl get svc -n agentgateway-system agentgateway -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

# Запустіть перенаправлення трафіку
sudo apt-get install -y socat
nohup sudo socat TCP-LISTEN:80,fork,reuseaddr TCP:$GATEWAY_IP:80 > /dev/null 2>&1 &
nohup sudo socat TCP-LISTEN:443,fork,reuseaddr TCP:$GATEWAY_IP:443 > /dev/null 2>&1 &
```

### Варіант Б: Nginx як Reverse Proxy на VM
Встановіть Nginx безпосередньо на VM та налаштуйте проксіювання:
```nginx
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://172.18.0.X:80; # Вкажіть IP LoadBalancer AgentGateway
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```
