############################################
# Stage 1: Build Go healthcheck binary
############################################
FROM golang:1.21-bookworm AS build_healthcheck
WORKDIR /app
COPY ./extra/healthcheck.go ./extra/healthcheck.go
RUN go build -o ./extra/healthcheck ./extra/healthcheck.go

############################################
# Stage 2: Build frontend
# esbuild (used by Vite) requires its postinstall to run so the native binary
# is downloaded. node-pty also compiles here, so install a C++ toolchain.
############################################
FROM node:22-bookworm-slim AS build_frontend
WORKDIR /app
RUN apt-get update && apt-get install --yes --no-install-recommends \
        python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:frontend

############################################
# Stage 3: Install production dependencies
# node-pty must be compiled, so install build tools first.
############################################
FROM node:22-bookworm-slim AS build_deps
WORKDIR /app
RUN apt-get update && apt-get install --yes --no-install-recommends \
        python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

############################################
# Stage 4: Final release image
############################################
FROM node:22-bookworm-slim AS release

# Install Docker CLI + compose plugin + dumb-init
RUN apt-get update && apt-get install --yes --no-install-recommends \
        curl \
        ca-certificates \
        gnupg \
        unzip \
        dumb-init \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg \
         | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
         https://download.docker.com/linux/debian \
         $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
         | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update && apt-get install --yes --no-install-recommends \
         docker-ce-cli \
         docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g tsx

WORKDIR /app

COPY --chown=node:node --from=build_healthcheck /app/extra/healthcheck ./extra/healthcheck
COPY --from=build_deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build_frontend /app/frontend-dist ./frontend-dist
COPY --chown=node:node . .

RUN mkdir -p ./data

# Disable io_uring to avoid node-pty issues on kernels that restrict it
ENV UV_USE_IO_URING=0

VOLUME /app/data
EXPOSE 5001
HEALTHCHECK --interval=60s --timeout=30s --start-period=60s --retries=5 CMD extra/healthcheck
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["tsx", "./backend/index.ts"]
