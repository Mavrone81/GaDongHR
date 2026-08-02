# syntax=docker/dockerfile:1
#
# svc-onboarding — M1 system of record for people: employees, documents,
# PDPA consent records, onboarding checklist, probation (Task 14). Mirrors
# services/svc-config/Dockerfile exactly (itself mirroring
# services/svc-crypto/Dockerfile, Task 6): multi-stage, node:22-alpine,
# non-root, ARG GADONG_BUILD_SHA. The root `.dockerignore`'s
# `**/*.tsbuildinfo` rule is what makes `tsc -b` actually emit `dist` into
# this image instead of silently treating it as already-built.
#
# Build context is the repository ROOT (a pnpm workspace: svc-onboarding
# depends on the sibling `@gadong/kernel` package via `workspace:*`), not
# this directory:
#
#   docker build -f services/svc-onboarding/Dockerfile -t gadonghr/svc-onboarding:local .

FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

# ---------- deps: resolve the workspace graph from the lockfile ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/kernel/package.json packages/kernel/package.json
COPY services/svc-onboarding/package.json services/svc-onboarding/package.json
RUN pnpm install --frozen-lockfile

# ---------- build: compile kernel then svc-onboarding (tsc -b project refs) ----------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/kernel packages/kernel
COPY services/svc-onboarding services/svc-onboarding
RUN npx tsc -b services/svc-onboarding
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
COPY --from=build /app/services/svc-onboarding/package.json ./services/svc-onboarding/package.json
COPY --from=build /app/services/svc-onboarding/dist ./services/svc-onboarding/dist
COPY --from=build /app/services/svc-onboarding/node_modules ./services/svc-onboarding/node_modules
# node-pg-migrate reads migration files from disk at boot (src/main.ts).
COPY --from=build /app/services/svc-onboarding/migrations ./services/svc-onboarding/migrations

WORKDIR /app/services/svc-onboarding
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
