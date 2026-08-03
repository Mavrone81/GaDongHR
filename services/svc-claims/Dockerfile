# syntax=docker/dockerfile:1
#
# svc-claims — M6 expense reimbursement: schema, migrations, and GET
# /health only (Task 14). Submission, approval banding, limit enforcement
# and reimbursement routing are Phase 4 — this image exists so the service
# deploys and has a correct database shape before any of that lands.
# Mirrors services/svc-leave/Dockerfile (Task 14), which itself mirrors
# services/svc-config/Dockerfile (Task 7), the template every services/*
# image copies: multi-stage, node:22-alpine, non-root, ARG
# GADONG_BUILD_SHA. The root `.dockerignore`'s `**/*.tsbuildinfo` rule is
# what makes `tsc -b` actually emit `dist` into this image instead of
# silently treating it as already-built.
#
# Build context is the repository ROOT (a pnpm workspace: svc-claims
# depends on the sibling `@gadong/kernel` package via `workspace:*`), not
# this directory:
#
#   docker build -f services/svc-claims/Dockerfile -t gadonghr/svc-claims:local .

FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

# ---------- deps: resolve the workspace graph from the lockfile ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/kernel/package.json packages/kernel/package.json
COPY services/svc-claims/package.json services/svc-claims/package.json
RUN pnpm install --frozen-lockfile

# ---------- build: compile kernel then svc-claims (tsc -b project refs) ----------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/kernel packages/kernel
COPY services/svc-claims services/svc-claims
RUN npx tsc -b services/svc-claims
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
COPY --from=build /app/services/svc-claims/package.json ./services/svc-claims/package.json
COPY --from=build /app/services/svc-claims/dist ./services/svc-claims/dist
COPY --from=build /app/services/svc-claims/node_modules ./services/svc-claims/node_modules
# node-pg-migrate reads migration files from disk at boot (src/main.ts) —
# shipped alongside dist so a fresh container can migrate itself on first
# start with nothing else mounted in.
COPY --from=build /app/services/svc-claims/migrations ./services/svc-claims/migrations

WORKDIR /app/services/svc-claims
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
