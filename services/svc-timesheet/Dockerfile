# syntax=docker/dockerfile:1
#
# svc-timesheet — M3: day records, OT classification, exceptions, period
# locks (Task 14). Mirrors services/svc-config/Dockerfile (Task 7), which
# mirrors services/svc-crypto/Dockerfile (Task 6), the template every
# services/* image copies: multi-stage, node:22-alpine, non-root,
# ARG GADONG_BUILD_SHA. The root `.dockerignore`'s `**/*.tsbuildinfo` rule
# is what makes `tsc -b` actually emit `dist` into this image instead of
# silently treating it as already-built (Task 6 fix round 1).
#
# Build context is the repository ROOT (a pnpm workspace: svc-timesheet
# depends on the sibling `@gadong/kernel` package via `workspace:*`), not
# this directory:
#
#   docker build -f services/svc-timesheet/Dockerfile -t gadonghr/svc-timesheet:local .

FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

# ---------- deps: resolve the workspace graph from the lockfile ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/kernel/package.json packages/kernel/package.json
COPY services/svc-timesheet/package.json services/svc-timesheet/package.json
RUN pnpm install --frozen-lockfile

# ---------- build: compile kernel then svc-timesheet (tsc -b project refs) ----------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/kernel packages/kernel
COPY services/svc-timesheet services/svc-timesheet
RUN npx tsc -b services/svc-timesheet
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
COPY --from=build /app/services/svc-timesheet/package.json ./services/svc-timesheet/package.json
COPY --from=build /app/services/svc-timesheet/dist ./services/svc-timesheet/dist
COPY --from=build /app/services/svc-timesheet/node_modules ./services/svc-timesheet/node_modules
# node-pg-migrate reads migration files from disk at boot (src/main.ts).
COPY --from=build /app/services/svc-timesheet/migrations ./services/svc-timesheet/migrations

WORKDIR /app/services/svc-timesheet
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
