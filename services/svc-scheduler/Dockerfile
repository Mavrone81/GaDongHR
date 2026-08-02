# syntax=docker/dockerfile:1
#
# svc-scheduler — shifts, rosters, Thai public-holiday calendar, OT
# pre-approval (M2). Mirrors services/svc-config/Dockerfile (Task 7), the
# template every services/* image copies: multi-stage, node:22-alpine,
# non-root, ARG GADONG_BUILD_SHA. The root `.dockerignore`'s
# `**/*.tsbuildinfo` rule is what makes `tsc -b` actually emit `dist` into
# this image instead of silently treating it as already-built.
#
# Build context is the repository ROOT (a pnpm workspace: svc-scheduler
# depends on the sibling `@gadong/kernel` package via `workspace:*`), not
# this directory:
#
#   docker build -f services/svc-scheduler/Dockerfile -t gadonghr/svc-scheduler:local .

FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

# ---------- deps: resolve the workspace graph from the lockfile ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/kernel/package.json packages/kernel/package.json
COPY services/svc-scheduler/package.json services/svc-scheduler/package.json
RUN pnpm install --frozen-lockfile

# ---------- build: compile kernel then svc-scheduler (tsc -b project refs) ----------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/kernel packages/kernel
COPY services/svc-scheduler services/svc-scheduler
RUN npx tsc -b services/svc-scheduler
# Re-resolve to production-only dependencies in place — see svc-config's
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
# svc-config's Dockerfile comment for the full explanation).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/kernel/package.json ./packages/kernel/package.json
COPY --from=build /app/packages/kernel/dist ./packages/kernel/dist
COPY --from=build /app/packages/kernel/node_modules ./packages/kernel/node_modules
COPY --from=build /app/services/svc-scheduler/package.json ./services/svc-scheduler/package.json
COPY --from=build /app/services/svc-scheduler/dist ./services/svc-scheduler/dist
COPY --from=build /app/services/svc-scheduler/node_modules ./services/svc-scheduler/node_modules
# node-pg-migrate reads migration files from disk at boot (src/main.ts).
COPY --from=build /app/services/svc-scheduler/migrations ./services/svc-scheduler/migrations

WORKDIR /app/services/svc-scheduler
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
