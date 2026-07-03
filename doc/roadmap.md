# Роадмап реалізації цільової архітектури (Architecture Implementation Roadmap)

Цей документ визначає різницю між поточним станом коду в репозиторії (MVP) та цільовою архітектурою (Target Architecture), яка описана в HLD та ADR для стартапу Scout. Тут наведено детальний план переходу, вимоги та кроки для впровадження відсутніх компонентів.

---

## 1. Поточний статус проекту (Current Implementation Status)

Наразі в репозиторії реалізовано повністю робочий прототип (MVP) із наступними характеристиками:

| Компонент | Поточний стан (MVP) | Рівень реалізації |
|-----------|---------------------|-------------------|
| **Frontend UI** | SPA на React + TypeScript + Vite. Дозволяє завантажувати резюме та відображати результати. | **100% готовність** |
| **Backend API** | Node.js Express сервер. Парсить CV, запускає `JobSearchAgent`, виконує LLM-ранжування вакансій. | **100% готовність** |
| **Збереження даних**| **Stateless:** резюме тимчасово зберігаються на диску сервера (`uploads/`), а вся витягнута інформація (CV skills, summary) зберігається в **LocalStorage браузера**. БД чи кеш відсутні. | **Базовий MVP** (Тимчасові файли) |
| **LLM провайдери**| Мультипровайдерний `AIClient` (OpenAI, Gemini, Anthropic) з автоматичним перемиканням (`auto`). | **100% готовність** |
| **CI/CD пайплайн**| GitHub Actions автоматично запускає лінтер, перевірку типів, Quality Gate (Evals у mock-режимі) та білдить докер-контейнери. | **100% готовність** |
| **Маніфести K8s**  | Локальний Helm-чарт з сабчартами та оверлеї `environments/` (Kustomize + HelmRelease) для FluxCD. | **100% готовність** (Маніфести-скелети) |

---

## 2. Аналіз розбіжностей (Gap Analysis vs Target Architecture)

Для досягнення повноцінної продуктової архітектури, описаної в HLD/ADR, необхідно реалізувати наступні інженерні блоки:

```
[ Поточний MVP (Stateless) ]
       │
       ▼  (Що треба додати)
 ┌───────────┐    ┌───────────┐    ┌─────────────────┐    ┌─────────────────┐
 │ Redis     │    │ Qdrant DB │    │  AgentGateway   │    │External Secrets │
 │ (Кешування│    │ (Векторний│    │ (Gateway API /  │    │  (Безпека API   │
 │ вакансій) │    │  пошук)   │    │  MCP / abox)    │    │    ключів)      │
 └───────────┘    └───────────┘    └─────────────────┘    └─────────────────┘
       │
       ▼
[ Цільова архітектура стартапу Scout (Stateful & Secured) ]
```

---

## 3. Покроковий план впровадження (Step-by-Step Implementation Plan)

### Фаза 1: Локальне Kubernetes середовище та SRE-налаштування
* **Мета:** Перенести розробку з Docker Compose в повноцінний локальний Kubernetes-кластер.
* **Що потрібно зробити:**
  1. Підняти локальний кластер **k3d**:
     ```bash
     k3d cluster create jobmatch --port 8080:80@loadbalancer
     ```
  2. Застосувати локальний Helm-чарт для тестування:
     ```bash
     helm install jobmatch platform/helm/jobmatch --namespace jobmatch-dev --create-namespace
     ```
  3. Створити Kubernetes Secret для API ключів вручну (тимчасово для Dev):
     ```bash
     kubectl create secret generic llm-secrets --from-literal=gemini-api-key="YOUR_KEY" -n jobmatch-dev
     ```

---

###  Фаза 2: Інтеграція з Agentic Sandbox (abox) та Маршрутизація
* **Мета:** Замінити базове проксіювання Nginx на сучасний Gateway API та AI-шлюз **AgentGateway** для захисту промптів та MCP-серверів.
* **Що потрібно зробити:**
  1. Використати готові модулі репозиторію [abox](https://github.com/den-vasyliev/abox) для деплою **AgentGateway** та **FluxCD** у локальний кластер.
  2. Налаштувати об'єкти `Gateway` та `HTTPRoute` замість Ingress:
     * Описати маршрут `/api/*` для перенаправлення трафіку до сервісу `jobmatch-api`.
  3. Налаштувати **Prompt Enrichment** на рівні AgentGateway: перенести статичні системні промпти на рівень Gateway, щоб API-сервер не передавав їх у відкритому вигляді.

---

### Фаза 3: Впровадження FinOps-кешування (Redis)
* **Мета:** Запобігти повторним запитам до LLM для однакових пошукових запитів вакансій.
* **Вимоги (Що написати в коді):**
  * Встановити пакет `redis` у `app/server`: `npm install redis --prefix app/server`.
  * Створити сервіс кешування `app/server/services/cache.ts`.
  * У файлі `app/server/agent/JobSearchAgent.ts` перед викликом інструментів пошуку перевіряти наявність ключа `query:country` у Redis.
* **Вимоги (Що додати в інфраструктуру):**
  * Увімкнути сабчарт Redis у `platform/helm/jobmatch/values.yaml` (`redis.enabled: true`).
  * Прописати змінну оточення `REDIS_URL` в `deployment-api.yaml` (вказує на `jobmatch-redis-master`).

---

### Фаза 4: Впровадження Векторного Пошуку (Vector DB - Qdrant)
* **Мета:** Зберігати профілі кандидатів у вигляді векторів для швидкого семантичного підбору великої кількості вакансій.
* **Вимоги (Що написати в коді):**
  * Встановити клієнт Qdrant: `npm install @qdrant/js-client-rest --prefix app/server`.
  * Додати крок генерації ембеддінгів (embeddings) для резюме при його парсингу.
  * Завантажувати вектори резюме в колекцію Qdrant.
  * Замінити повний LLM-скоринг вакансій на попередній векторний пошук у Qdrant, вибираючи лише ТОП-10 найкращих вакансій за косинусною близькістю для фінального LLM-аналізу.
* **Вимоги (Що додати в інфраструктуру):**
  * Увімкнути сабчарт Qdrant у `platform/helm/jobmatch/values.yaml` (`qdrant.enabled: true`).
  * Додати змінну оточення `QDRANT_URL` у бекенд-контейнер в `deployment-api.yaml`.

---

### Фаза 5: Безпека Secrets Management (External Secrets Operator)
* **Мета:** Прибрати ручне створення секретів у Kubernetes та інтегрувати хмарне сховище ключів.
* **Що потрібно зробити:**
  1. Розгорнути **External Secrets Operator** у кластері через Helm.
  2. Створити `SecretStore` ресурс, який підключається до **GCP Secret Manager** (або AWS Secrets Manager).
  3. Описати `ExternalSecret` маніфест, який вказує ESO автоматично зчитувати ключі `GEMINI_API_KEY` чи `OPENAI_API_KEY` з хмари та створювати локальний Kubernetes Secret `llm-secrets` у відповідному namespace.
