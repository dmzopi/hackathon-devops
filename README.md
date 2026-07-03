# JobMatch Platform — AI-Powered Job Matching Engine

Ласкаво просимо до репозиторію платформи **JobMatch** — інтелектуальної системи підбору вакансій на основі AI-агентів, розробленої для демонстрації передових практик DevOps, SRE, GitOps та безпеки штучного інтелекту (Prompt Security & Evals).

---

## 📂 Структура монорепозиторію

Репозиторій побудований за принципом монорепозиторію з чітким розділенням зон відповідальності:

```
├── app/                      # Контур застосунку
│   ├── src/                  # React/Vite SPA frontend
│   ├── server/               # Node.js Express API & Worker (JobSearchAgent)
│   ├── skills/               # Версіоновані вміння агента (SKILL.md)
│   └── prompts/              # Системні промпти та шаблони ролей LLM
├── platform/                 # Контур інфраструктури (GitOps)
│   ├── flux/                 # Налаштування FluxCD (gotk-sync, kustomizations)
│   ├── environments/         # Окремі оверлеї для середовищ
│   │   ├── dev/              # Конфігурація dev (helm-release.yaml)
│   │   └── prod/             # Конфігурація prod (helm-release.yaml)
│   ├── helm/                 # Наш Umbrella Helm Chart (Redis, Qdrant)
│   └── flux-image-policy.yaml# Конфігурація автоматизації FluxCD
├── evals/                    # Контур оцінки моделей (Quality Gate)
│   ├── dataset.json          # Золотий набір тест-кейсів
│   └── run-evals.mjs         # Скрипт запуску LLM-as-a-Judge евалюації
├── doc/                      # Документація проекту
│   ├── ADR.md                # Architectural Decision Records (Рішення)
│   ├── HLD.md                # High-Level Solution Design (Архітектура)
│   └── cicd.md               # Детальний опис CI/CD & GitOps
```

---

## 🚀 Швидкий старт локально

### 1. Передумови (Prerequisites)
Вам знадобиться встановлений **Node.js v20+** та **Docker / Docker Compose**.

### 2. Встановлення залежностей
```bash
# Встановлення залежностей для frontend та backend
npm install
npm install --prefix app/server
```

### 3. Конфігурація змінних середовища
Створіть файл `.env` у каталозі `app/` на основі `.env.example`:
```bash
cp app/.env.example app/.env
```
Відкрийте `app/.env` та додайте хоча б один API-ключ LLM-провайдера (наприклад, `GEMINI_API_KEY`, `OPENAI_API_KEY` або `ANTHROPIC_API_KEY`).

### 4. Запуск у режимі розробки
```bash
npm run dev
```
* **Frontend UI:** http://localhost:5173
* **Backend API Health:** http://localhost:3001/api/health

---

## 🛠️ Docker розгортання
Для запуску всього стеку в Docker контейнерах локально:
```bash
cd app
docker compose up --build
```
Веб-інтерфейс буде доступний за адресою http://localhost:8080.

---

## 🧪 Запуск Evals (Quality Gate)
Контур Evals оцінює якість підбору вакансій та генерації супровідних листів за допомогою паттерну LLM-as-a-Judge.

```bash
# Перехід до каталогу evals та запуск
cd evals
npm install
node run-evals.mjs
```
Скрипт оцінить тестові кейси з `dataset.json`, використовуючи метрики:
* **Relevance** (Релевантність)
* **Tone** (Тональність листа)
* **Hallucination-free** (Відсутність галюцинацій)

*Примітка: У CI-пайплайні цей скрипт виступає в ролі Gate. Якщо середній бал падає нижче `4.2/5.0` або виявляється Prompt Injection / витік PII, збірка завершується помилкою.*

---

## 🛡️ Контур безпеки (Security Controls)
* **Маскування PII:** Конфіденційні дані користувача (імена, пошта, телефони) автоматично видаляються з резюме локально перед передачею в хмару.
* **Prompt Injection Shield:** XML-тегування відокремлює інструкції системи від даних користувача. Регресійний набір тестів перевіряє стійкість до ін'єкцій.
* **Secrets Management:** Усі ключі вилучено з коду та Git, вони доставляються в Kubernetes через K8s Secrets / External Secrets Operator.

---

## 📖 Детальні архітектурні документи

* 📑 **[Architectural Decision Records (ADR)](doc/ADR.md)** — Чому саме так побудована система, FinOps аналіз та розрахунки Unit-економіки.
* 📐 **[High-Level Solution Design (HLD)](doc/HLD.md)** — Схеми архітектури, життєвого циклу Агента та діаграми розгортання в Kubernetes.
* 🔄 **[CI/CD & GitOps Guide](doc/cicd.md)** — Детальний опис налаштування FluxCD, тегування образів та автоматичного оновлення релізів.
* 🏗️ **[Deployment Infrastructure Guide](doc/deployment_infrastructure.md)** — Стратегія розгортання для всіх середовищ (Dev, Staging, Prod), мережева топологія та забезпечення високої доступності.
* 🗺️ **[Architecture Implementation Roadmap](doc/roadmap.md)** — Роадмап реалізації цільової архітектури, аналіз розбіжностей MVP та кроки впровадження БД/кешування.