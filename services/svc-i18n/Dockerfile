# syntax=docker/dockerfile:1
#
# svc-i18n — trilingual (th/en/zh) UI-string bundles, fallback, and the HR
# glossary (Task 10). Mirrors services/svc-config/Dockerfile's multi-stage
# shape (node:22-alpine, non-root, ARG GADONG_BUILD_SHA), but simpler: this
# service owns no database schema, so there is no migrations stage and no
# DATABASE_URL at boot — see src/bundle-loader.ts. In place of svc-config's
# `seed/` directory (imported over HTTP after boot), svc-i18n's `bundles/`
# directory is read directly off disk at boot, so it ships next to `dist/`
# the same way `seed/` ships next to svc-config's.
#
# Build context is the repository ROOT (a pnpm workspace: svc-i18n depends
# on the sibling `@gadong/kernel` package via `workspace:*`), not this
# directory:
#
#   docker build -f services/svc-i18n/Dockerfile -t gadonghr/svc-i18n:local .

FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

# ---------- deps: resolve the workspace graph from the lockfile ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/kernel/package.json packages/kernel/package.json
COPY services/svc-i18n/package.json services/svc-i18n/package.json
RUN pnpm install --frozen-lockfile

# ---------- build: compile kernel then svc-i18n (tsc -b project refs) ----------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/kernel packages/kernel
COPY services/svc-i18n services/svc-i18n
RUN npx tsc -b services/svc-i18n
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
COPY --from=build /app/services/svc-i18n/package.json ./services/svc-i18n/package.json
COPY --from=build /app/services/svc-i18n/dist ./services/svc-i18n/dist
COPY --from=build /app/services/svc-i18n/node_modules ./services/svc-i18n/node_modules
# Bundles are read straight off disk at boot (src/bundle-loader.ts), not
# baked into a migration or fetched over HTTP — so the raw JSON has to
# actually be in the image, sitting next to dist/ the way svc-config's
# seed/ sits next to its dist/.
COPY --from=build /app/services/svc-i18n/bundles ./services/svc-i18n/bundles

WORKDIR /app/services/svc-i18n
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
