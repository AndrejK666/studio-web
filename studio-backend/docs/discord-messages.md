# Discord-сообщения для команды gears (готовы к копипасте)

Тон: «первый адоптер, возможно, что-то делаем не так — поправьте». Каждое сообщение
влезает в лимит Discord (2000 символов). Отправлять тредом: №1 — открывающее,
№2–5 — по одному на тему.

---

## Сообщение 1 — открывающее

Привет! Мы собираем бэкенд Constructor Studio на gears-rust — свой сервер по образцу
`cf-gears-example-server` (13 гиров: gateway, authn/authz static, types-registry,
tenant-resolver, resource-group, **account-management** + static-idp). Прогнали сквозной
сценарий целиком: bootstrap root → свои tenant-типы через GTS → org/workspace с
type-барьером → пользователи через IdP-контракт → user groups в RG → dual-consent
конверсия в self-managed → tenant metadata. Работает и на SQLite, и на Postgres, поверх
уже живёт React-портал. Впечатления отличные — весь слой тенантности мы получили
вообще без своего Rust-кода 👍

По дороге собрали 4 места, где споткнулись. **Вполне допускаем, что часть из них — мы
неправильно готовим, а не баги** — будем благодарны, если ткнёте в правильный способ.
Ниже по одному сообщению на тему, с логами и тем, как мы пытались. Код нашей сборки
могу показать/пошарить (studio-web/studio-backend), там всё воспроизводится
детерминированно.

---

## Сообщение 2 — types-registry: не видно причину ошибки регистрации

**Тема:** сеем свои GTS-типы через `types-registry.config.entities`, при ошибке в лог
падает только:

```
ERROR types_registry::gear: Failed to register static GTS entity
  gts_id="gts.cf.core.am.tenant_type.v1~cf.studio.organization.v1~"
  error=invalid_argument: Request validation failed
```

Реальная причина (у нас был 4-частный сегмент `cf.studio.organization.v1` без
namespace) лежит в `InvalidArgument::FieldViolations`, но `Display` сворачивает её в
фиксированную строку (`toolkit-canonical-errors/src/error.rs:154`), а гир логирует
`error = %error`. Диагностировали чтением исходников gts-id.

**Вопрос/предложение:** можно ли в static-entity цикле (и в `ReadyCommitFailed`)
логировать field violations целиком? Или есть флаг/уровень логов, который мы не нашли?

---

## Сообщение 3 — account-management: пути в OpenAPI-артефакте

**Тема:** сгенерировали клиент по `docs/account-management-v1.yaml` — все вызовы 404.
В артефакте пути `/api/account-management/v1/...`, в коде роуты без `/api`:
`src/api/rest/routes/me.rs:17` → `/account-management/v1/me`. За gateway с
`prefix_path: /cf` реальный URL — `/cf/account-management/v1/...`. Живой `/cf/docs`
правильный, расходится только закоммиченный артефакт.

**Вопрос/предложение:** артефакт — источник истины или just docs? Если второе, может,
перегенерировать + добавить diff-проверку в `api_contracts` workflow? Готовы прислать PR.

---

## Сообщение 4 — PRD §5.6: какой resource_type у membership?

**Тема:** по PRD §5.6 в `allowed_memberships` — «platform user resource type
`gts.cf.core.am.user.v1~`». Делаем как написано:

```
POST /resource-group/v1/memberships/{group}/gts.cf.core.am.user.v1~/{user}
→ 400 invalid_argument
```

С member-handle типом `gts.cf.core.rg.type.v1~cf.core.am.user.v1~`
(`account-management-sdk/src/gts.rs:99`) — работает. Похоже, код прав, PRD отстаёт.

**Вопрос/предложение:** подтвердите, что member-handle — правильный тип, и поправьте
§5.6 (и описание в `docs/schemas/user_group.v1.schema.json`, если там то же).

---

## Сообщение 5 — ГЛАВНЫЙ вопрос: как объявить типизированную tenant-metadata схему?

**Тема:** хотим «Studio workspace settings» как derived metadata-схему (PRD §5.7
обещает GTS-валидируемый payload — «branding, contacts»). Не смогли зарегистрировать
типизированную схему **ни одним способом**:

Попытка 1 — `$schema: draft-07` + properties:

```
Schema '...workspace.settings.v1~' is not compatible with base
'gts.cf.core.am.tenant_metadata.v1~': property 'automation_level': derived schema
adds new property but base has additionalProperties: false
```

(база — пустой конверт без properties; OP#12 трактует её как закрытую → наследнику
нельзя добавить НИ ОДНОГО поля)

Попытка 2 — `$schema: "gts://gts.cf.core.am.tenant_metadata.v1~"` (конвенция из
комментария в `metadata_schema_registry.rs`):

```
failed to compile trait schema: Unknown meta-schema:
'gts://gts.cf.core.am.tenant_metadata.v1~'. Custom meta-schemas must be registered...
```

Сейчас живём на free-form `type: object` (валидация формы на клиенте), но это
обесценивает фичу. **Как правильно?** Если правильного способа пока нет — предложения:
ослабить базовый конверт (`additionalProperties: true` на payload-уровне) или исключить
`x-gts-abstract`-базы из property-narrowing в OP#12 + рабочий пример в доки. Репро:
одна запись в `types-registry.config.entities` → `switch_to_ready` падает.
