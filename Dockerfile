############################################
# Stage 1: Build healthcheck binary (Go)
# ─── runs in parallel with the base stage
############################################
FROM golang:1.26-alpine3.22 AS build_healthcheck
WORKDIR /app
COPY ./extra/healthcheck.go ./extra/healthcheck.go
RUN CGO_ENABLED=0 go build -x -o ./extra/healthcheck ./extra/healthcheck.go

############################################
# Stage 2: Base image with system deps
# ─── rarely changes → excellent cache hit
############################################
FROM node:24-alpine3.22 AS base
RUN apk add --no-cache \
        dumb-init \
        docker-cli \
        docker-cli-compose \
    && npm install -g tsx

############################################
# Stage 3: Install deps, build, then prune
# ─── single npm ci instead of two
############################################
FROM base AS build
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci
COPY --chown=node:node . .
RUN npm run build:frontend \
    && npm prune --omit=dev

############################################
# Stage 4: ⭐ Release image
############################################
FROM base AS release
WORKDIR /app

# Bring in the Go healthcheck binary
COPY --chown=node:node --from=build_healthcheck /app/extra/healthcheck /app/extra/healthcheck

# Bring in production-only node_modules (devDeps already pruned)
COPY --from=build /app/node_modules /app/node_modules

# Copy application source
COPY --chown=node:node . .

# Overlay built frontend assets AFTER source copy to avoid overwrite
COPY --chown=node:node --from=build /app/frontend-dist /app/frontend-dist

RUN mkdir -p ./data

ENV UV_USE_IO_URING=0

VOLUME /app/data
EXPOSE 5001
HEALTHCHECK --interval=60s --timeout=30s --start-period=60s --retries=5 CMD extra/healthcheck
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["tsx", "./backend/index.ts"]
