# syntax=docker/dockerfile:1.24

FROM node:26.8.1-alpine AS builder
WORKDIR /build

# Node.js images do not bundle corepack, so install it explicitly.
RUN npm install -g corepack@latest && corepack enable

# Install dependencies first for better layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Bring in the rest of the sources (incl. vendor/livesync-bridge submodule contents)
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY vendor ./vendor

RUN pnpm run build

# Trim devDependencies for the runtime image
RUN pnpm prune --prod

FROM node:26.8.1-alpine AS runtime
WORKDIR /app

# git is required by simple-git
RUN apk add --no-cache git ca-certificates

ENV NODE_ENV=production
ENV TMPDIR=/tmp

COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/vendor-dist ./vendor-dist

# Run as a non-root user. Avoid pinning a specific uid so PodSecurity
# restricted policies can override `runAsUser` freely.
USER node

ENTRYPOINT ["node", "dist/main.js"]
