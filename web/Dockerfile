# syntax=docker/dockerfile:1
#
# web — the PWA (Vite SPA), Task 15. The only target in the CI image
# matrix that isn't a long-running Node service: a static build served by
# nginx, not `node dist/main.js`. No `/health` endpoint and no runtime
# read of `GADONG_BUILD_SHA` the way `packages/kernel/src/version.ts`
# gives every services/* image — a static `index.html` has no process to
# read `process.env` at request time. `GADONG_BUILD_SHA` is still accepted
# as a build arg, for parity with every other target in the CI matrix
# (Task 15) and every image built from the same job template, and is
# stamped into an OCI label so the deployed image is traceable to the
# commit that produced it; nothing asserts on it the way
# auto-deploy-gadonghr.sh does for the seven platform services.
#
# Build context is the repository ROOT (a pnpm workspace: web depends on
# the sibling `@gadong/kernel` package via `workspace:*`), not this
# directory:
#
#   docker build -f web/Dockerfile -t gadonghr/web:local .
#
# web/vite.config.ts aliases `@gadong/kernel/dist/i18n/format` straight to
# `packages/kernel/src/i18n/format.ts` (see that config's own comment for
# why — `@gadong/kernel/dist/i18n/format.js` is CommonJS and breaks in the
# browser). That alias is a plain filesystem path, resolved before any
# node_modules/package resolution, so the kernel's compiled `dist` is
# never needed here — but the kernel's TypeScript SOURCE must be present
# in this build context, or the alias target simply doesn't exist.
#
# Unlike every services/*/Dockerfile, there is no `tsc -b` in this image:
# `web`'s own `build` script is just `vite build` (package.json) — type
# errors are caught separately by the root `pnpm typecheck` project
# reference graph, not by this build. That also means the `**/*.tsbuildinfo`
# staleness trap that emptied a service's `dist` in an earlier task
# (services/svc-config/Dockerfile's own comment) cannot recur here the
# same way, since no `tsc -b` manifest is ever consulted — verified
# empirically for this image in task-15-report.md by asserting `dist` is
# non-empty after a real `docker build`, not assumed from the absence of
# `tsc -b` alone.
#
# CI (Task 15) builds this way, same as every services/*/Dockerfile.

FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

# ---------- deps: resolve the workspace graph from the lockfile ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/kernel/package.json packages/kernel/package.json
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile

# ---------- build: vite build (no tsc -b — see header) ----------
FROM deps AS build
# esbuild reads the nearest tsconfig.json for every file it transforms,
# even though nothing here runs `tsc` — that includes the aliased kernel
# source file (packages/kernel/src/i18n/format.ts), so
# packages/kernel/tsconfig.json must exist too, and both it and
# web/tsconfig.json `extend` the root tsconfig.base.json.
COPY tsconfig.base.json ./
COPY packages/kernel/tsconfig.json packages/kernel/tsconfig.json
COPY packages/kernel/src packages/kernel/src
COPY web web
# A Vite SPA bakes its config into the JS bundle at `vite build` time — there
# is no server process to read env vars at request time (see `web/src/env.ts`'s
# `required()`, called at module-evaluation time by every caller of
# `loadConfig()`). Vite's own default `envPrefix` ("VITE_") picks up any
# matching var already present in `process.env` when `vite build` runs (see
# https://vite.dev/guide/env-and-mode — process.env takes priority over
# `.env` files and is exposed the same way), and Docker's ARG mechanism
# exports each of these six as a `process.env` entry for the RUN instruction
# below, without persisting them into the built image's metadata (unlike
# ENV). Each ARG here MUST have a matching `--build-arg` in
# `.github/workflows/ci.yml`'s `web` matrix leg — an ARG with no build-arg is
# simply empty, and empty is exactly what `env.ts`'s `required()` rejects; a
# build-arg with no matching ARG here is silently discarded by Docker, which
# is the failure this comment exists to prevent from recurring silently a
# second time.
ARG VITE_OIDC_ISSUER
ARG VITE_OIDC_CLIENT_ID
ARG VITE_OIDC_AUDIENCE
ARG VITE_OIDC_REDIRECT_URI
ARG VITE_SVC_CONFIG_URL
ARG VITE_SVC_I18N_URL
# The four screens built alongside `admin/statutory-rules` (audit, documents,
# roles, notifications — `src/env.ts`'s `svcAuditUrl`/`svcDocsUrl`/
# `svcAuthzUrl`/`svcNotifyUrl`, all `required()`). These deliberately DO
# carry a default (`ARG NAME=value`, unlike the six above, which are always
# supplied by `.github/workflows/ci.yml` and would otherwise be silently
# empty) because this task's boundary is `web/` only — that workflow file is
# not — and `required()` throwing on a missing var is not scoped to the one
# screen that needs it: `loadConfig()` builds the whole `AppConfig` object in
# one call, so a single missing field fails EVERY screen at `AuthProvider`'s
# mount, not just these four. The default is exactly the value the workflow
# would pass if it were updated — the same same-origin relative path
# deploy/README.md's Traefik routing table already gives `svc-config`/
# `svc-i18n` above, just for the four newer services. If the `web` matrix
# leg is later extended with an explicit `--build-arg VITE_SVC_AUDIT_URL=...`
# etc., that takes priority the same way it does for the six ARGs above;
# until then, this default is what actually ships.
ARG VITE_SVC_AUDIT_URL=/api/audit
ARG VITE_SVC_DOCS_URL=/api/docs
ARG VITE_SVC_AUTHZ_URL=/api/authz
ARG VITE_SVC_NOTIFY_URL=/api/notify
RUN pnpm --filter @gadong/web build

# ---------- runtime: static files behind unprivileged nginx ----------
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
ARG GADONG_BUILD_SHA
LABEL org.opencontainers.image.revision=${GADONG_BUILD_SHA}

# SPA routing: try_files ... /index.html — see nginx.conf's own header.
# Without this, any deep link (e.g. /admin/statutory-rules) 404s on a
# hard refresh, because no such file exists on disk.
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html

EXPOSE 8080
