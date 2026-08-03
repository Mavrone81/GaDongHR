# syntax=docker/dockerfile:1
#
# retention-job — nightly PDPA retention & crypto-erasure worker (Task 14).
# Mirrors services/svc-config/Dockerfile, the template every services/*
# image copies: multi-stage, node:22-alpine, non-root, ARG GADONG_BUILD_SHA.
#
# ONE deliberate difference from every other service's Dockerfile: no
# `EXPOSE 3000`. This container opens no port — `src/main.ts` runs
# migrations, does its (Phase 5) work, and exits; there is nothing here for
# `deploy/docker-compose.yml`'s `http-health` healthcheck to route to (Task
# 14 brief — "not a service with an HTTP API"). Do not add `EXPOSE 3000`
# back to match the other services; that would misrepresent this image as
# having something to serve.
#
# Build context is the repository ROOT (a pnpm workspace: retention-job
# depends on the sibling `@gadong/kernel` package via `workspace:*`), not
# this directory:
#
#   docker build -f services/retention-job/Dockerfile -t gadonghr/retention-job:local .

FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

# ---------- deps: resolve the workspace graph from the lockfile ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/kernel/package.json packages/kernel/package.json
COPY services/retention-job/package.json services/retention-job/package.json
RUN pnpm install --frozen-lockfile

# ---------- build: compile kernel then retention-job (tsc -b project refs) ----------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/kernel packages/kernel
COPY services/retention-job services/retention-job
RUN npx tsc -b services/retention-job
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
COPY --from=build /app/services/retention-job/package.json ./services/retention-job/package.json
COPY --from=build /app/services/retention-job/dist ./services/retention-job/dist
COPY --from=build /app/services/retention-job/node_modules ./services/retention-job/node_modules
# node-pg-migrate reads migration files from disk at boot (src/main.ts).
COPY --from=build /app/services/retention-job/migrations ./services/retention-job/migrations

WORKDIR /app/services/retention-job
USER node
# No EXPOSE — see file header. This container is invoked on a schedule
# (external cron, matching the roadmap's existing image-prune cron
# pattern), runs one cycle, and exits; it never listens for a connection.
CMD ["node", "dist/main.js"]
