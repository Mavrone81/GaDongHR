# syntax=docker/dockerfile:1
#
# svc-docs — PDF rendering (employment contracts, payslips) with embedded
# Thai (Sarabun) and Simplified Chinese (Noto Sans SC) fonts, per ADR-008
# and I18N-GUIDE.md §1 rule 6. Mirrors services/svc-config/Dockerfile, the
# template every services/* image copies: multi-stage, node:22-alpine,
# non-root, ARG GADONG_BUILD_SHA.
#
# Build context is the repository ROOT (a pnpm workspace: svc-docs depends
# on the sibling `@gadong/kernel` package via `workspace:*`), not this
# directory:
#
#   docker build -f services/svc-docs/Dockerfile -t gadonghr/svc-docs:local .

FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

# ---------- deps: resolve the workspace graph from the lockfile ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/kernel/package.json packages/kernel/package.json
COPY services/svc-docs/package.json services/svc-docs/package.json
RUN pnpm install --frozen-lockfile

# ---------- build: compile kernel then svc-docs (tsc -b project refs) ----------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/kernel packages/kernel
COPY services/svc-docs services/svc-docs
RUN npx tsc -b services/svc-docs
# Re-resolve to production-only dependencies in place — see svc-config's
# Dockerfile for why this only drops devDeps, not workspace links.
RUN pnpm install --frozen-lockfile --prod

# ---------- runtime ----------
FROM node:22-alpine AS runtime
ARG GADONG_BUILD_SHA
ENV GADONG_BUILD_SHA=${GADONG_BUILD_SHA} \
    NODE_ENV=production \
    # Playwright's own downloadable Chromium build is glibc-only and does
    # not run on this image's musl libc (a well-known Playwright/Alpine
    # incompatibility) — `ChromiumPdfRenderer` is pointed at Alpine's own
    # `chromium` package instead, installed below.
    CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Alpine's `chromium` package plus the font-rendering/shared-lib stack
# headless Chromium needs to actually paint text (harfbuzz for complex
# script shaping — Thai in particular is not a simple left-to-right glyph
# run — nss/freetype/ttf-freefont for the rest). This is what turns the
# fonts this image embeds below into pixels; `/health`'s `fonts` dependency
# (`FontRegistry.isHealthy()`) only proves the font FILES are present and
# parseable, not that Chromium can render with them — that is this
# package's job, not `svc-docs` code's.
RUN apk add --no-cache chromium nss freetype harfbuzz ttf-freefont ca-certificates

WORKDIR /app

# Copied together, from the same build stage, so every relative pnpm
# symlink between them still resolves once they land in this image (see
# svc-config's Dockerfile comment for the full explanation).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/kernel/package.json ./packages/kernel/package.json
COPY --from=build /app/packages/kernel/dist ./packages/kernel/dist
COPY --from=build /app/packages/kernel/node_modules ./packages/kernel/node_modules
COPY --from=build /app/services/svc-docs/package.json ./services/svc-docs/package.json
COPY --from=build /app/services/svc-docs/dist ./services/svc-docs/dist
COPY --from=build /app/services/svc-docs/node_modules ./services/svc-docs/node_modules
# node-pg-migrate reads migration files from disk at boot (src/main.ts).
COPY --from=build /app/services/svc-docs/migrations ./services/svc-docs/migrations
# `templates/*.html` (rendered per kind+lang, with an `en` fallback — see
# `src/templates.ts`) and `templates/fonts/*.ttf` (Sarabun, Noto Sans SC,
# Noto Sans — `src/app.module.ts`'s `FONT_DESCRIPTORS`) both ship as plain
# files read at runtime, not baked into the JS bundle, so both must be
# copied into the image explicitly. A dropped `COPY` here is exactly the
# "mis-built image" `/health`'s `fonts` dependency exists to catch.
COPY --from=build /app/services/svc-docs/templates ./services/svc-docs/templates

WORKDIR /app/services/svc-docs
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
