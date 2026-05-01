############################################
# Build Healthcheck Binary (Go)
############################################
FROM golang:1.26-alpine AS build_healthcheck
WORKDIR /app
ARG TARGETPLATFORM
COPY ./extra/healthcheck.go ./extra/healthcheck.go
RUN go build -x -o ./extra/healthcheck ./extra/healthcheck.go

############################################
# Base (Node + Docker CLI)
############################################
FROM node:24-bookworm-slim AS base
RUN apt update && apt install --yes --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    unzip \
    dumb-init \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo \
         "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
         "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | \
         tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt update \
    && apt --yes --no-install-recommends install \
         docker-ce-cli \
         docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g tsx

############################################
# Build (npm dependencies)
############################################
FROM base AS build
WORKDIR /app
COPY --chown=node:node ./package.json ./package.json
COPY --chown=node:node ./package-lock.json ./package-lock.json
RUN npm ci --omit=dev

############################################
# ⭐ Main Image
############################################
FROM base AS release
WORKDIR /app
COPY --chown=node:node --from=build_healthcheck /app/extra/healthcheck /app/extra/healthcheck
COPY --from=build /app/node_modules /app/node_modules
COPY --chown=node:node . .
RUN mkdir ./data

# Disable io_uring — causes issues with some Node.js native modules (e.g. node-pty)
# https://github.com/sagemathinc/cocalc/issues/6963
ENV UV_USE_IO_URING=0

VOLUME /app/data
EXPOSE 5001
HEALTHCHECK --interval=60s --timeout=30s --start-period=60s --retries=5 CMD extra/healthcheck
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["tsx", "./backend/index.ts"]
