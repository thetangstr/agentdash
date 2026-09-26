# AgentDash: cloud-control (self-serve cloud control plane, GH #762).
# Build context is the REPO ROOT: `docker build -f cloud/Dockerfile .`
# (Railway: service root "/", config file cloud/railway.json).
# The base is pinned by digest (the multi-arch index for node:22-bookworm-slim,
# resolved 2026-09-25) so a retagged upstream image cannot change what ships
# (GH #778). Both stages use the same digest; to move it, run
# `docker buildx imagetools inspect node:22-bookworm-slim` and update both.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS build
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /repo
COPY . .
# Only this package and its dependencies; the lockfile is authoritative.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @agentdash/cloud-control...
RUN pnpm --filter @agentdash/cloud-control build \
 && pnpm --filter @agentdash/cloud-control deploy --prod /out

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/cloud/dist ./dist
USER node
EXPOSE 3200
CMD ["node", "dist/index.js"]
