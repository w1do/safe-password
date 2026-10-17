# Project Vault — хранилище доступов к проектам

Сервис для хранения ключей, паролей, токенов и SSH-ключей, сгруппированных по проектам.

- **Панель управления**: React + TypeScript + [shadcn/ui](https://ui.shadcn.com) (Radix UI + Tailwind CSS).
- **Агенты**: работают через HTTP MCP endpoint `/mcp` с bearer-токеном.
- **Backend**: Node.js + TypeScript (Express 5), SQLite (better-sqlite3), шифрование AES-256-GCM.

```
┌──────────────┐  cookie-сессия   ┌────────────────────────────┐
│ Панель React │ ───────────────► │ /api   (Express)           │
└──────────────┘                  │                            │   ┌──────────────────┐
┌──────────────┐  Bearer-токен    │ /mcp   (Streamable HTTP)   │──►│ SQLite (vault-db) │  секреты: AES-256-GCM
│ MCP-агент    │ ───────────────► │                            │   └──────────────────┘
└──────────────┘                  └─────────────┬──────────────┘   ┌──────────────────────────┐
                                                └─────────────────►│ master.key (vault-config) │
                                                                   └──────────────────────────┘
```

## Быстрый старт

```bash
cp .env.example .env        # необязательно: все значения имеют значения по умолчанию
docker compose up -d --build
```

Панель: <http://127.0.0.1:8080>. Сервис публикуется **только на 127.0.0.1**.

При первом запуске сервис сам создаёт базу, ключ шифрования и учётные данные администратора.
Если `VAULT_ADMIN_EMAIL`, `VAULT_ADMIN_PASSWORD`, `VAULT_ACCESS_TOKEN` не заданы, сгенерированные значения
записываются в защищённый файл (права `600`) в volume `vault-config`. В логах этих значений нет.

**Как прочитать файл с учётными данными:**

```bash
docker compose exec vault cat /data/config/initial-credentials.txt
```

Сохраните значения в менеджере паролей и удалите файл:

```bash
docker compose exec vault rm /data/config/initial-credentials.txt
```

Для входа нужны **все три значения**: email, пароль и токен доступа.

Повторные `docker compose up -d --build`, перезапуски и пересборки образа не меняют учётные данные, токен
и ключ шифрования и не удаляют записи. Данные хранятся в именованных volume `vault-db` и `vault-config`.
Если после первого запуска поменять ENV, новые значения не применятся: в логе будет предупреждение, что они проигнорированы.

> ⚠️ `docker compose down -v` удаляет volume, а значит все данные и ключ. Не используйте `-v` без резервной копии.

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `VAULT_BIND` | `127.0.0.1` | Интерфейс хоста, на котором публикуется порт |
| `VAULT_PORT` | `8080` | Порт на хосте |
| `VAULT_ADMIN_EMAIL` | `admin@vault.local` | Email администратора (только первый запуск) |
| `VAULT_ADMIN_PASSWORD` | генерируется | Пароль, минимум 12 символов (только первый запуск) |
| `VAULT_ACCESS_TOKEN` | генерируется (`vlt_…`) | Токен доступа, минимум 32 символа (только первый запуск) |
| `TRUST_PROXY` | `false` | Число прокси перед сервисом (`1` за reverse proxy) — для корректного IP и HTTPS |
| `COOKIE_SECURE` | `auto` | `auto` — флаг `Secure`, если запрос пришёл по HTTPS; `true` — всегда |
| `SESSION_TTL_HOURS` | `12` | Время жизни сессии панели |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |

## Панель управления

- слева — список проектов, кнопка «Создать проект», переименование (иконка карандаша при наведении);
- справа — таблица доступов выбранного проекта: **Сервис · Название ключа · Секрет · Статус · Действия**;
- секреты скрыты по умолчанию. Кнопка 👁 запрашивает **один** секрет отдельным запросом и через 30 секунд снова его скрывает. Кнопка «Копировать» копирует секрет, не показывая его на экране;
- поиск в шапке ищет по названию проекта, сервису и названию ключа во всех проектах;
- переключатель статуса «Активен / Неактивен»;
- удаление записи и «Удалить неактивные» — только после подтверждения; активные записи не затрагиваются;
- при редактировании пустое поле «Секрет» сохраняет прежний секрет;
- «Сменить токен» — после подтверждения паролем старый токен сразу перестаёт работать, **все** сессии панели завершаются, новый токен показывается один раз.

В одном проекте может быть несколько ключей одного сервиса. Пара «сервис + название ключа» внутри проекта уникальна
(без учёта регистра): по ней `upsert_credential` находит существующую запись.

## MCP для агентов

Endpoint: `POST http://127.0.0.1:8080/mcp` (Streamable HTTP, stateless, JSON-ответы).
Каждый запрос должен содержать заголовок:

```
Authorization: Bearer <token>
```

> ⚠️ **В первой версии MCP-токен даёт полный доступ ко всем проектам и всем секретам** — на чтение, изменение и удаление.
> Разграничения доступа по проектам нет. Этот же токен нужен для входа в панель. Выдавайте его только доверенным агентам.

### Инструменты

| Инструмент | Параметры | Результат |
|---|---|---|
| `list_projects` | — | Список проектов с количеством записей |
| `create_project` | `name` | Созданный проект |
| `list_credentials` | `project`, `query?`, `status?` (`active`/`inactive`/`all`) | Записи проекта **без секретов** |
| `get_credential` | `id` **или** `project` + `service` + `name` | Одна запись **с секретом** |
| `upsert_credential` | `project`, `service`, `name`, `secret?`, `status?`, `id?` | `{ created, credential }` без секрета |
| `set_credential_status` | `id`, `status` (`active`/`inactive`) | Обновлённая запись |
| `delete_credential` | `id` | Удалённая запись |
| `delete_inactive_credentials` | `project` | `{ project, deleted }` — число удалённых записей |

`project` — имя проекта (без учёта регистра) или его id.

Логика `upsert_credential`: если передан `id` — обновляется эта запись; иначе ищется запись с тем же
проектом + сервисом + названием ключа; найдена — обновляется, нет — создаётся (тогда `secret` обязателен).
Если `secret` не передан или пустой, прежний секрет сохраняется.

Ошибки:

- неверный или отсутствующий токен → HTTP `401`, JSON-RPC ошибка `-32001` с текстом
  `Unauthorized: invalid or missing access token…`. После 20 неудачных попыток с одного IP за 15 минут → `429`;
- ошибки инструментов возвращаются как результат с `isError: true` и кодом в начале текста:
  `PROJECT_NOT_FOUND`, `CREDENTIAL_NOT_FOUND`, `PROJECT_EXISTS`, `CREDENTIAL_EXISTS`, `VALIDATION_ERROR`;
- неверные типы параметров отклоняются схемой с описанием проблемного поля.

### Подключение MCP-клиента через ENV

Токен **нельзя** помещать в URL, исходный код и файлы, попадающие в Git. Клиент берёт его из переменной окружения.

1. Задайте переменную в окружении агента (shell profile, systemd unit, секреты CI и т. п.):

   ```bash
   export VAULT_TOKEN='vlt_...'
   ```

2. **Claude Code**: скопируйте `.mcp.json.example` в `.mcp.json` в корне вашего проекта. В файле есть только
   ссылка `${VAULT_TOKEN}`, сам токен Claude Code подставляет из окружения при запуске:

   ```json
   {
     "mcpServers": {
       "vault": {
         "type": "http",
         "url": "http://127.0.0.1:8080/mcp",
         "headers": { "Authorization": "Bearer ${VAULT_TOKEN}" }
       }
     }
   }
   ```

   Проверка: `claude mcp list`.

3. **Другие клиенты** с поддержкой Streamable HTTP и собственных заголовков настраиваются так же: URL `…/mcp`,
   заголовок `Authorization: Bearer <значение из ENV>`. Синтаксис подстановки переменных зависит от клиента
   (например, `${env:VAULT_TOKEN}` в Cursor). Если клиент не умеет подставлять переменные, не вписывайте токен
   в конфигурацию в репозитории.

4. **Собственный агент на TypeScript** (`@modelcontextprotocol/sdk`):

   ```ts
   import { Client } from '@modelcontextprotocol/sdk/client/index.js';
   import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

   const token = process.env.VAULT_TOKEN;
   if (!token) throw new Error('VAULT_TOKEN is not set');

   const client = new Client({ name: 'my-agent', version: '1.0.0' });
   await client.connect(
     new StreamableHTTPClientTransport(new URL(process.env.VAULT_MCP_URL ?? 'http://127.0.0.1:8080/mcp'), {
       requestInit: { headers: { Authorization: `Bearer ${token}` } },
     }),
   );
   const res = await client.callTool({ name: 'get_credential', arguments: { project: 'CRM', service: 'GitHub', name: 'Production API' } });
   ```

5. **Проверка через curl**:

   ```bash
   curl -s http://127.0.0.1:8080/mcp \
     -H "Authorization: Bearer $VAULT_TOKEN" \
     -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_projects","arguments":{}}}'
   ```

После смены токена в панели обновите `VAULT_TOKEN` у всех агентов: старый токен отклоняется сразу.

## Безопасность

- **Шифрование секретов**: AES-256-GCM до записи в базу; для каждой операции шифрования — новый случайный 96-битный nonce.
  ID записи используется как AAD, поэтому зашифрованный секрет нельзя переставить в другую запись.
- **Ключ шифрования** хранится отдельно от базы: `/data/config/master.key` в volume `vault-config`, права `600`, каталог `700`.
  При старте ключ проверяется по контрольному значению. Если ключ не подходит к базе или отсутствует при непустой базе,
  сервис не запустится и не сгенерирует новый ключ поверх данных.
- **Пароль администратора** хранится как хеш scrypt (N=2¹⁵, r=8, p=1, соль 16 байт).
- **Токен доступа** в базе хранится только как SHA-256-хеш (токен — 256 бит случайных данных). Сравнение выполняется за постоянное время.
- **Сессии**: случайный идентификатор в cookie `HttpOnly; SameSite=Strict` (`Secure` при HTTPS), в базе хранится только его хеш.
  Смена токена удаляет все сессии.
- **CSRF**: изменяющие запросы панели требуют заголовок `X-Vault-Request: 1`, CORS не включён.
- **Списки никогда не содержат секретов.** Секрет возвращают только `GET /api/credentials/:id/secret` и MCP `get_credential`.
  Ответы API идут с `Cache-Control: no-store`.
- **Логи** содержат только метод, путь без query, статус и длительность. Тела запросов, заголовки, cookie, токены, пароли и секреты не логируются.
- **Перебор**: не более 5 неудачных входов с одного IP за 15 минут и 50 суммарно; для MCP — 20 с IP и 200 суммарно.
- `PRAGMA secure_delete=ON` — удалённые записи перезаписываются нулями в файле БД.
- Контейнер: непривилегированный пользователь `node`, read-only root FS, `cap_drop: ALL`, `no-new-privileges`, CSP и защитные заголовки.

### HTTPS: доступ извне через reverse proxy

Порт сервиса остаётся на `127.0.0.1`, наружу смотрит только HTTPS-прокси. Пример для [Caddy](https://caddyserver.com) на том же хосте
(сертификат Let's Encrypt выпускается автоматически):

```caddyfile
vault.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

В `.env`:

```env
TRUST_PROXY=1
COOKIE_SECURE=true
```

Затем `docker compose up -d`. Агенты подключаются к `https://vault.example.com/mcp`.
Не публикуйте порт 8080 наружу без HTTPS (`VAULT_BIND=0.0.0.0` без прокси передаёт токен в открытом виде).

## Резервное копирование

> Резервная копия должна содержать **базу и ключ шифрования вместе**. Без `master.key` база бесполезна: секреты не расшифровать.
> Храните копию в зашифрованном виде: в ней ключ, который расшифровывает все секреты.

```bash
scripts/backup.sh                 # → ./backups/vault-YYYYmmdd-HHMMSS/{vault.sqlite,master.key}
scripts/backup.sh /secure/place   # в свой каталог
```

Бэкап делается без остановки сервиса (online backup SQLite с учётом WAL). То же вручную:

```bash
mkdir -m 700 -p backup
docker compose exec -T vault node server/dist/backup.js > backup/vault.sqlite
docker compose exec -T vault cat /data/config/master.key > backup/master.key
```

## Восстановление

```bash
scripts/restore.sh ./backups/vault-20261017-120000
```

Скрипт останавливает сервис, заменяет базу и ключ в volume и запускает сервис заново. Вручную:

```bash
docker compose stop vault
docker compose run --rm --no-deps -T -v "$PWD/backup:/backup:ro" --entrypoint sh vault -c '
  rm -f /data/db/vault.sqlite /data/db/vault.sqlite-wal /data/db/vault.sqlite-shm
  cp /backup/vault.sqlite /data/db/vault.sqlite
  cp /backup/master.key  /data/config/master.key
  chmod 600 /data/db/vault.sqlite /data/config/master.key'
docker compose up -d
```

После восстановления действуют email, пароль и токен, которые были на момент создания копии.
На новом сервере сначала выполните `docker compose up -d --build`, а потом восстановление.

## Разработка

Требуется Node.js 20+.

```bash
npm install
npm test             # тесты сервера (API, MCP, шифрование, хранение) и панели
npm run typecheck
npm run dev:server   # API + MCP на 127.0.0.1:8080; данные в ./.data
npm run dev:web      # Vite на :5173, проксирует /api и /mcp на :8080
```

Учётные данные для входа в dev-режиме — в `./.data/config/initial-credentials.txt`.

UI-компоненты лежат в `web/src/components/ui` в формате shadcn/ui (`components.json` настроен), поэтому новые
компоненты добавляются командой `npx shadcn@latest add <component>` из каталога `web`.

### Автоматические проверки

| Критерий | Тесты |
|---|---|
| Вход по email + паролю + токену, лимит попыток | `server/test/api.test.ts` › authentication, `web/src/test/panel.test.tsx` › login |
| Проект `CRM` с несколькими доступами | `api.test.ts`, `panel.test.tsx` › creates a project… |
| Секретов нет в списках и таблице | `api.test.ts`, `mcp.test.ts`, `panel.test.tsx` |
| Показ и копирование конкретного секрета | `api.test.ts` › reveals…, `panel.test.tsx` › reveals and copies… |
| Агент получает, добавляет, обновляет и отключает запись | `mcp.test.ts` › lets an agent… |
| Смена токена: старый отклоняется, новый работает | `api.test.ts` › access token rotation, `mcp.test.ts` › stops accepting…, `panel.test.tsx` › rotates… |
| Массовое удаление удаляет только неактивные | `api.test.ts`, `mcp.test.ts`, `panel.test.tsx` |
| Секретов нет в файле БД и логах | `persistence.test.ts` › stores no plaintext… |
| Данные переживают перезапуск и расшифровываются | `persistence.test.ts` › keeps data…, backup and restore |

## Структура

```
server/src
  index.ts       точка входа
  bootstrap.ts   первый запуск: ключ, администратор, файл с учётными данными
  vault.ts       бизнес-логика: проекты, записи, сессии, токен
  crypto.ts      AES-256-GCM, scrypt, токены
  api.ts         REST API панели
  mcp.ts         MCP endpoint и инструменты
  backup.ts      online-бэкап базы
web/src
  components/ui  shadcn/ui компоненты
  components     экраны панели
  lib/api.ts     клиент API
```

## Ограничения первой версии

- один администратор и один токен, который даёт доступ ко всем проектам;
- счётчики неудачных попыток хранятся в памяти и сбрасываются при перезапуске;
- SQLite рассчитан на один экземпляр сервиса;
- удаление проектов не реализовано (по ТЗ не требуется).
