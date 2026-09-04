# syntax=docker/dockerfile:1
#
# Trilha API — production image.
#
# Multi-stage: the TypeScript toolchain never reaches the runtime layer, which
# carries only production node_modules plus compiled JavaScript.

# ---- Stage 1: install full dependency tree (needed to compile) ----------------
FROM node:24.20.0-alpine3.24 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` is reproducible and fails on a lockfile mismatch. Install scripts are
# skipped: `nest build` compiles with tsc and needs no native postinstall artefacts.
RUN npm ci --include=dev --ignore-scripts

# ---- Stage 2: compile ---------------------------------------------------------
FROM node:24.20.0-alpine3.24 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---- Stage 3: production dependencies only ------------------------------------
FROM node:24.20.0-alpine3.24 AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- Stage 4: runtime ---------------------------------------------------------
FROM node:24.20.0-alpine3.24 AS runtime
ENV NODE_ENV=production
WORKDIR /app

# `dumb-init` reaps zombies and forwards SIGTERM so shutdown hooks actually run.
RUN apk add --no-cache dumb-init=~1.2

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# The `node` user ships with the base image; never run as root (§30).
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.APP_PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
