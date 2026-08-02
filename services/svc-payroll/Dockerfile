# syntax=docker/dockerfile:1
#
# svc-payroll — M7 payroll: schema, migrations, and GET /health only
# (Task 14). Gross-to-net, the tax engine, payslip rendering and exports are
# Phase 5, gated on statutory verification items that are still open — this
# image exists so the service deploys and has a correct, encryption-shaped
# database before any of that lands. Mirrors services/svc-config/Dockerfile
# (Task 7) and services/svc-attendance/Dockerfile (Task 14), the template
# every services/* image copies: multi-stage, node:22-alpine, non-root,
# ARG GADONG_BUILD_SHA. The root `.dockerignore`'s `**/*.tsbuildinfo` rule
# is what makes `tsc -b` actually emit `dist` into this image instead of
# silently treating it as already-built.
#
# Build context is the repository ROOT (a pnpm workspace: svc-payroll
# depends on the sibling `@gadong/kernel` package via `workspace:*`), not
# this directory:
#
#   docker build -f services/svc-payroll/Dockerfile -t gadonghr/svc-payroll:local .

FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

# ---------- deps: resolve the workspace graph from the lockfile ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/kernel/package.json packages/kernel/package.json
COPY services/svc-payroll/package.json services/svc-payroll/package.json
RUN pnpm install --frozen-lockfile

# ---------- build: compile kernel then svc-payroll (tsc -b project refs) ----------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/kernel packages/kernel
COPY services/svc-payroll services/svc-payroll
RUN npx tsc -b services/svc-payroll
# Re-resolve to production-only dependencies in place — see svc-crypto's
# Dockerfile for why this only drops devDeps, not workspace links.
RUN pnpm install --frozen-lockfile --prod

# ---------- runtime ----------
FROM node:22-alpine AS runtime
ARG GADONG_BUILD_SHA
ENV GADONG_BUILD_SHA=${GADONG_BUILD_SHA} \
    NODE_ENV=production
WORKDIR /app

# Copied together, from the same build stage, so every relative pnpm
# symlink between them still resolves once they land in this image (see
# svc-crypto's Dockerfile comment for the full explanation).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/kernel/package.json ./packages/kernel/package.json
COPY --from=build /app/packages/kernel/dist ./packages/kernel/dist
COPY --from=build /app/packages/kernel/node_modules ./packages/kernel/node_modules
COPY --from=build /app/services/svc-payroll/package.json ./services/svc-payroll/package.json
COPY --from=build /app/services/svc-payroll/dist ./services/svc-payroll/dist
COPY --from=build /app/services/svc-payroll/node_modules ./services/svc-payroll/node_modules
# node-pg-migrate reads migration files from disk at boot (src/main.ts) —
# shipped alongside dist so a fresh container can migrate itself on first
# start with nothing else mounted in.
COPY --from=build /app/services/svc-payroll/migrations ./services/svc-payroll/migrations

WORKDIR /app/services/svc-payroll
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
