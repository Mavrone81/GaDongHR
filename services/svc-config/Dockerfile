# syntax=docker/dockerfile:1
#
# svc-config — effective-dated statutory rules, governance, and seed packs
# (Task 7). Mirrors services/svc-crypto/Dockerfile (Task 6), the template
# every services/* image copies: multi-stage, node:22-alpine, non-root,
# ARG GADONG_BUILD_SHA. The root `.dockerignore`'s `**/*.tsbuildinfo` rule
# is what makes `tsc -b` actually emit `dist` into this image instead of
# silently treating it as already-built (Task 6 fix round 1) — confirmed
# for this service in task-7-report.md, not assumed.
#
# Build context is the repository ROOT (a pnpm workspace: svc-config
# depends on the sibling `@gadong/kernel` package via `workspace:*`), not
# this directory:
#
#   docker build -f services/svc-config/Dockerfile -t gadonghr/svc-config:local .

FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

# ---------- deps: resolve the workspace graph from the lockfile ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/kernel/package.json packages/kernel/package.json
COPY services/svc-config/package.json services/svc-config/package.json
RUN pnpm install --frozen-lockfile

# ---------- build: compile kernel then svc-config (tsc -b project refs) ----------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/kernel packages/kernel
COPY services/svc-config services/svc-config
RUN npx tsc -b services/svc-config
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
COPY --from=build /app/services/svc-config/package.json ./services/svc-config/package.json
COPY --from=build /app/services/svc-config/dist ./services/svc-config/dist
COPY --from=build /app/services/svc-config/node_modules ./services/svc-config/node_modules
# node-pg-migrate reads migration files from disk at boot (src/main.ts),
# and packs.service.ts's seed packs are imported over HTTP, not baked into
# a migration — but the raw seed JSON ships in the image too so
# `scripts/seed.sh` (a later task) can POST them to a running container
# without a separate artifact.
COPY --from=build /app/services/svc-config/migrations ./services/svc-config/migrations
COPY --from=build /app/services/svc-config/seed ./services/svc-config/seed

WORKDIR /app/services/svc-config
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
