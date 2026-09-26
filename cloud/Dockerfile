# AgentDash: cloud-control (self-serve cloud control plane, GH #762).
# Build context is the REPO ROOT: `docker build -f cloud/Dockerfile .`
# (Railway: service root "/", config file cloud/railway.json).
FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /repo
COPY . .
# Only this package and its dependencies; the lockfile is authoritative.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @agentdash/cloud-control...
RUN pnpm --filter @agentdash/cloud-control build \
 && pnpm --filter @agentdash/cloud-control deploy --prod /out

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/cloud/dist ./dist
USER node
EXPOSE 3200
CMD ["node", "dist/index.js"]
