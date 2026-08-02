# syntax=docker/dockerfile:1
#
# svc-authz — the RBAC decision service (Task 8). Every request in every
# other service asks this service's POST /decide whether the caller may
# proceed and within which org-unit scope. Mirrors services/svc-config's
# Dockerfile (Task 7), itself copied from services/svc-crypto (Task 6): the
# template every services/* image follows — multi-stage, node:22-alpine,
# non-root, ARG GADONG_BUILD_SHA.
#
# Build context is the repository ROOT (a pnpm workspace: svc-authz depends
# on the sibling `@gadong/kernel` package via `workspace:*`), not this
# directory:
#
#   docker build -f services/svc-authz/Dockerfile -t gadonghr/svc-authz:local .

FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

# ---------- deps: resolve the workspace graph from the lockfile ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/kernel/package.json packages/kernel/package.json
COPY services/svc-authz/package.json services/svc-authz/package.json
RUN pnpm install --frozen-lockfile

# ---------- build: compile kernel then svc-authz (tsc -b project refs) ----------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/kernel packages/kernel
COPY services/svc-authz services/svc-authz
RUN npx tsc -b services/svc-authz
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
COPY --from=build /app/services/svc-authz/package.json ./services/svc-authz/package.json
COPY --from=build /app/services/svc-authz/dist ./services/svc-authz/dist
COPY --from=build /app/services/svc-authz/node_modules ./services/svc-authz/node_modules
# node-pg-migrate reads migration files from disk at boot (src/main.ts).
COPY --from=build /app/services/svc-authz/migrations ./services/svc-authz/migrations

WORKDIR /app/services/svc-authz
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
