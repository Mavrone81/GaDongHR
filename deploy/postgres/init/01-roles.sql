-- GaDongHR — per-schema Postgres roles (Task 13)
--
-- Runs once, automatically, the FIRST time the `postgres:16` container
-- starts against an empty data directory (docker-entrypoint-initdb.d
-- convention). It authenticates as POSTGRES_USER (the superuser configured
-- in docker-compose.yml's `postgres` service), and is executed with `psql
-- -f`, which is what makes the `\getenv` meta-commands below work even
-- though this is a plain `.sql` file, not a `.sh` wrapper: `\getenv` reads
-- an OS environment variable straight into a psql variable so each role's
-- password comes from `.env` (never hard-coded here, never committed) and
-- `:'varname'` interpolates it as a properly quoted SQL literal.
--
-- global-constraints / roadmap "Standing constraints": no cross-schema
-- access, secrets never committed. Twelve business schemas (roadmap
-- "Database conventions" + this task's brief):
--   onboarding scheduler timesheet attendance leave claims payroll
--   authz config audit notify docs
-- Every one of the twelve gets a role here even though only four services
-- (config, authz, audit, notify) plus docs exist yet — onboarding through
-- payroll are forward-provisioned so a later phase's `docker compose up`
-- for a new module service needs no Postgres-side bootstrap step, only a
-- new compose service block and a new `DB_PASSWORD_*` value in `.env`.
--
-- Ownership model (why each role owns its own schema, not just holds
-- GRANTs on it): every one of these services' `main.ts` runs its
-- node-pg-migrate migration using the SAME `DATABASE_URL` env var the
-- runtime connection pool then reuses (see e.g.
-- `services/svc-config/src/main.ts`) — there is no second, more-privileged
-- connection string available to the container. For the migration's own
-- `CREATE SCHEMA` / `CREATE TABLE` to succeed, the role that
-- `DATABASE_URL` authenticates as must already be able to create objects
-- in its own schema BEFORE that schema exists — `CREATE SCHEMA <s>
-- AUTHORIZATION <role>` grants exactly that, and nothing on any other
-- schema.
--
-- `audit` is the one schema with an extra, tighter invariant on top of
-- this (INSERT/SELECT only, never UPDATE/DELETE) — see the dedicated
-- comment on its block below for why plain schema ownership does not by
-- itself defeat that invariant, and the one gap it does not close.
--
-- Connection-limit arithmetic (packages/kernel/src/db/pool.ts
-- cross-check — Task 4 review, "the pool.ts comments claim consistency
-- with this file, a file that did not exist when they were written; now
-- it does, make the claim true"):
--   MAX_POOL_SIZE   = 10  (pool.ts: this service's own connection pool)
--   + 1                   (pool.ts: the OutboxRelay's own dedicated
--                          `withConnection` session, held across a
--                          SELECT ... FOR UPDATE / publish / UPDATE cycle)
--   + up to 9             (headroom: a migration connection at boot,
--                          plus a human `psql` session for on-call
--                          debugging, without either one being able to
--                          push a live service's pool into connection
--                          errors)
--   = 20, which is exactly the CONNECTION LIMIT set below for every
--   business-schema role. 20 > MAX_POOL_SIZE (10) holds, so pool.ts's
--   comment ("01-roles.sql grants each service's DB role a 20-connection
--   limit") is true as written — the two files are reconciled, not
--   silently changed to match after the fact.
--
-- statement_timeout: pool.ts's STATEMENT_TIMEOUT_MS = 30_000 is set again
-- here at the role level (`ALTER ROLE ... SET statement_timeout`) as the
-- belt to the pool-level client option's suspenders — pool.ts's own
-- comment says this exact thing; this file is what makes it true rather
-- than aspirational.

-- ---------- Database-wide hardening (once) ----------

-- Postgres 15+ already removes PUBLIC's default CREATE on the `public`
-- schema for newly created databases, but POSTGRES_DB here may be created
-- by an older initdb default or a restored dump — make the revocation
-- explicit rather than relying on a version-dependent default (brief §2).
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- Required by brief §2. Not exercised by any of the seven services' own
-- migrations today — `gen_random_uuid()` (used for every UUID primary key
-- across config/authz/notify/docs) is built into Postgres core since v13
-- and needs no extension. `pgcrypto` is provisioned anyway, forward-
-- looking, for any future server-side digest/HMAC use — see the roadmap's
-- blind-index normalisation note, which currently computes HMAC-SHA256 in
-- `@gadong/kernel` (Node), not in Postgres, but does not rule it out.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- Twelve business-schema roles ----------
-- Same five statements, twelve times, one block per schema: create the
-- LOGIN role from its `.env` password, cap its statement runtime and
-- connection count to match pool.ts, make it the schema's owner so its
-- own migration can create objects in it, and pin its default
-- `search_path` so an ad hoc `psql` session under this role (a migration
-- retry, an on-call debug connection) resolves unqualified names in the
-- right schema too — belt-and-suspenders alongside `createPool`'s
-- per-connection `-c search_path=<schema>` option (pool.ts).

\getenv db_password_onboarding DB_PASSWORD_ONBOARDING
CREATE ROLE onboarding LOGIN PASSWORD :'db_password_onboarding' CONNECTION LIMIT 20;
ALTER ROLE onboarding SET statement_timeout = '30s';
ALTER ROLE onboarding SET search_path = onboarding;
CREATE SCHEMA IF NOT EXISTS onboarding AUTHORIZATION onboarding;

\getenv db_password_scheduler DB_PASSWORD_SCHEDULER
CREATE ROLE scheduler LOGIN PASSWORD :'db_password_scheduler' CONNECTION LIMIT 20;
ALTER ROLE scheduler SET statement_timeout = '30s';
ALTER ROLE scheduler SET search_path = scheduler;
CREATE SCHEMA IF NOT EXISTS scheduler AUTHORIZATION scheduler;

\getenv db_password_timesheet DB_PASSWORD_TIMESHEET
CREATE ROLE timesheet LOGIN PASSWORD :'db_password_timesheet' CONNECTION LIMIT 20;
ALTER ROLE timesheet SET statement_timeout = '30s';
ALTER ROLE timesheet SET search_path = timesheet;
CREATE SCHEMA IF NOT EXISTS timesheet AUTHORIZATION timesheet;

\getenv db_password_attendance DB_PASSWORD_ATTENDANCE
CREATE ROLE attendance LOGIN PASSWORD :'db_password_attendance' CONNECTION LIMIT 20;
ALTER ROLE attendance SET statement_timeout = '30s';
ALTER ROLE attendance SET search_path = attendance;
CREATE SCHEMA IF NOT EXISTS attendance AUTHORIZATION attendance;

\getenv db_password_leave DB_PASSWORD_LEAVE
CREATE ROLE leave LOGIN PASSWORD :'db_password_leave' CONNECTION LIMIT 20;
ALTER ROLE leave SET statement_timeout = '30s';
ALTER ROLE leave SET search_path = leave;
CREATE SCHEMA IF NOT EXISTS leave AUTHORIZATION leave;

\getenv db_password_claims DB_PASSWORD_CLAIMS
CREATE ROLE claims LOGIN PASSWORD :'db_password_claims' CONNECTION LIMIT 20;
ALTER ROLE claims SET statement_timeout = '30s';
ALTER ROLE claims SET search_path = claims;
CREATE SCHEMA IF NOT EXISTS claims AUTHORIZATION claims;

\getenv db_password_payroll DB_PASSWORD_PAYROLL
CREATE ROLE payroll LOGIN PASSWORD :'db_password_payroll' CONNECTION LIMIT 20;
ALTER ROLE payroll SET statement_timeout = '30s';
ALTER ROLE payroll SET search_path = payroll;
CREATE SCHEMA IF NOT EXISTS payroll AUTHORIZATION payroll;

\getenv db_password_authz DB_PASSWORD_AUTHZ
CREATE ROLE authz LOGIN PASSWORD :'db_password_authz' CONNECTION LIMIT 20;
ALTER ROLE authz SET statement_timeout = '30s';
ALTER ROLE authz SET search_path = authz;
CREATE SCHEMA IF NOT EXISTS authz AUTHORIZATION authz;

\getenv db_password_config DB_PASSWORD_CONFIG
CREATE ROLE config LOGIN PASSWORD :'db_password_config' CONNECTION LIMIT 20;
ALTER ROLE config SET statement_timeout = '30s';
ALTER ROLE config SET search_path = config;
CREATE SCHEMA IF NOT EXISTS config AUTHORIZATION config;

\getenv db_password_notify DB_PASSWORD_NOTIFY
CREATE ROLE notify LOGIN PASSWORD :'db_password_notify' CONNECTION LIMIT 20;
ALTER ROLE notify SET statement_timeout = '30s';
ALTER ROLE notify SET search_path = notify;
CREATE SCHEMA IF NOT EXISTS notify AUTHORIZATION notify;

\getenv db_password_docs DB_PASSWORD_DOCS
CREATE ROLE docs LOGIN PASSWORD :'db_password_docs' CONNECTION LIMIT 20;
ALTER ROLE docs SET statement_timeout = '30s';
ALTER ROLE docs SET search_path = docs;
CREATE SCHEMA IF NOT EXISTS docs AUTHORIZATION docs;

-- `audit` — INSERT and SELECT only, never UPDATE, never DELETE (brief §2;
-- roadmap "Audit entry": "Append-only: the audit role holds INSERT and
-- SELECT, never UPDATE or DELETE"; `services/svc-audit/src/migration.test.ts`
-- asserts this same invariant against `1754100000000_audit-schema.js`'s
-- own SQL text).
--
-- The role is created here exactly like the eleven above — LOGIN,
-- statement_timeout, connection limit, schema ownership — because its own
-- migration (`1754100000000_audit-schema.js`) needs to run as this same
-- role (same single-`DATABASE_URL` constraint as every other service) and
-- issues `CREATE SCHEMA`/`CREATE TABLE`, which a role pre-restricted to
-- SELECT/INSERT could not do. That migration's own `DO $$ IF NOT EXISTS
-- (... rolname = 'audit') THEN CREATE ROLE audit NOLOGIN ...` finds the
-- role already exists (created here, LOGIN) and skips re-creating it — so
-- the LOGIN capability and password set here survive untouched. What the
-- migration does next is the actual lockdown: `REVOKE ALL ON audit.entry
-- FROM audit; GRANT SELECT, INSERT ON audit.entry TO audit;`.
--
-- Why that REVOKE is real and not neutered by `audit` owning the table it
-- was just revoked from: in Postgres, regular DML privileges
-- (SELECT/INSERT/UPDATE/DELETE/TRUNCATE) are ACL entries, and an owner's
-- initial "all privileges" ACL grant can be, and here is, explicitly
-- revoked — after that, the owning role is checked against the ACL like
-- any other role for DML and is genuinely denied UPDATE/DELETE. This is a
-- standard, documented pattern for a role to lock down its own table.
--
-- The one thing that revocation does NOT reach: DROP/ALTER/TRUNCATE-
-- ownership-transfer-type rights are inherent to being the object's
-- owner, not ACL-based, and cannot be revoked short of transferring
-- ownership to a different role entirely. Doing that would require a
-- second, non-login "owner" role and splitting svc-audit's single
-- `DATABASE_URL` into a migration credential and a runtime credential —
-- a service-code change (`services/svc-audit/src/main.ts`), out of scope
-- for this deploy-only task ("No service code"). Recorded here rather
-- than silently assumed closed: the residual gap is that the `audit` role
-- itself could DROP or ALTER its own table; it cannot UPDATE or DELETE a
-- row in it. The primary defence against the latter is already
-- code-level — `EntriesRepository` exposes no `updateEntry`/`deleteEntry`
-- method at all (`entries.repository.ts`) — and this GRANT is the
-- documented belt-and-suspenders on top of it, not the sole defence.
\getenv db_password_audit DB_PASSWORD_AUDIT
CREATE ROLE audit LOGIN PASSWORD :'db_password_audit' CONNECTION LIMIT 20;
ALTER ROLE audit SET statement_timeout = '30s';
ALTER ROLE audit SET search_path = audit;
CREATE SCHEMA IF NOT EXISTS audit AUTHORIZATION audit;

-- ---------- Keycloak (identity provider's own database) ----------
-- Not one of the twelve business schemas above — Keycloak (Task 13
-- compose) needs its own isolated schema in the same POSTGRES_DB, sized
-- and limited independently since it is a Java/Quarkus process, not a
-- `@gadong/kernel` consumer, so pool.ts's constants do not apply to it.
-- Same isolation shape as the business roles: LOGIN, owns exactly one
-- schema, no cross-schema grants.
\getenv kc_db_password KC_DB_PASSWORD
CREATE ROLE keycloak LOGIN PASSWORD :'kc_db_password' CONNECTION LIMIT 15;
ALTER ROLE keycloak SET search_path = keycloak;
CREATE SCHEMA IF NOT EXISTS keycloak AUTHORIZATION keycloak;
