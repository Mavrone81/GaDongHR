# syntax=docker/dockerfile:1
#
# svc-crypto — the only Vault client in the system (Task 6). First service in
# the repo, so this file is the template `services/*` copies for the other
# fourteen: multi-stage, node:22-alpine, non-root, ARG GADONG_BUILD_SHA.
#
# Build context is the repository ROOT (a pnpm workspace: svc-crypto depends
# on the sibling `@gadong/kernel` package via `workspace:*`), not this
# directory:
#
#   docker build -f services/svc-crypto/Dockerfile -t gadonghr/svc-crypto:local .
#
# CI (Task 15) builds this way for every service.

FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

# ---------- deps: resolve the workspace graph from the lockfile ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/kernel/package.json packages/kernel/package.json
COPY services/svc-crypto/package.json services/svc-crypto/package.json
RUN pnpm install --frozen-lockfile

# ---------- build: compile kernel then svc-crypto (tsc -b project refs) ----------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/kernel packages/kernel
COPY services/svc-crypto services/svc-crypto
RUN npx tsc -b services/svc-crypto
# Re-resolve to production-only dependencies in place. Declared
# `peerDependencies` (e.g. kernel's `@nestjs/common`) stay linked because
# svc-crypto itself depends on them for real — this only drops devDeps
# (typescript, jest, eslint, ...) that the runtime image never needs.
RUN pnpm install --frozen-lockfile --prod

# ---------- runtime ----------
FROM node:22-alpine AS runtime
ARG GADONG_BUILD_SHA
ENV GADONG_BUILD_SHA=${GADONG_BUILD_SHA} \
    NODE_ENV=production
WORKDIR /app

# The three directories below are copied together, from the same build
# stage, so every relative pnpm symlink between them (root node_modules'
# content store, kernel's own node_modules, svc-crypto's own node_modules,
# and the workspace symlink from svc-crypto's node_modules to
# ../../../packages/kernel) still resolves once they land in this image.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/kernel/package.json ./packages/kernel/package.json
COPY --from=build /app/packages/kernel/dist ./packages/kernel/dist
COPY --from=build /app/packages/kernel/node_modules ./packages/kernel/node_modules
COPY --from=build /app/services/svc-crypto/package.json ./services/svc-crypto/package.json
COPY --from=build /app/services/svc-crypto/dist ./services/svc-crypto/dist
COPY --from=build /app/services/svc-crypto/node_modules ./services/svc-crypto/node_modules

WORKDIR /app/services/svc-crypto
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
