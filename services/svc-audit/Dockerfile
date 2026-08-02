# syntax=docker/dockerfile:1
#
# svc-audit — the hash-chained append-only audit log (Task 9). This
# Dockerfile did not exist before Task 13: every other services/* image had
# one, svc-audit did not, which would have made it silently undeployable
# despite being one of the seven tested platform services. It mirrors
# services/svc-authz/Dockerfile exactly — same shape (just a `migrations`
# stage, no extra asset directory like svc-config's `seed/` or svc-notify's
# `templates/`) — which itself mirrors services/svc-config's Dockerfile
# (Task 7), itself copied from services/svc-crypto (Task 6): the template
# every services/* image follows — multi-stage, node:22-alpine, non-root,
# ARG GADONG_BUILD_SHA.
#
# Build context is the repository ROOT (a pnpm workspace: svc-audit depends
# on the sibling `@gadong/kernel` package via `workspace:*`), not this
# directory:
#
#   docker build -f services/svc-audit/Dockerfile -t gadonghr/svc-audit:local .

FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

# ---------- deps: resolve the workspace graph from the lockfile ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/kernel/package.json packages/kernel/package.json
COPY services/svc-audit/package.json services/svc-audit/package.json
RUN pnpm install --frozen-lockfile

# ---------- build: compile kernel then svc-audit (tsc -b project refs) ----------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/kernel packages/kernel
COPY services/svc-audit services/svc-audit
RUN npx tsc -b services/svc-audit
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
COPY --from=build /app/services/svc-audit/package.json ./services/svc-audit/package.json
COPY --from=build /app/services/svc-audit/dist ./services/svc-audit/dist
COPY --from=build /app/services/svc-audit/node_modules ./services/svc-audit/node_modules
# node-pg-migrate reads migration files from disk at boot (src/main.ts).
COPY --from=build /app/services/svc-audit/migrations ./services/svc-audit/migrations

WORKDIR /app/services/svc-audit
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
