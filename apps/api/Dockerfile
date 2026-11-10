FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @bizora/api... build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /repo/apps/api/dist ./dist
COPY --from=deps /repo/apps/api/drizzle ./drizzle
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/packages ./packages
COPY --from=deps /repo/apps/api/package.json ./package.json
EXPOSE 3001
CMD ["node", "dist/main.js"]
