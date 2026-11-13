FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
RUN pnpm install --frozen-lockfile
# Next.js compiles rewrites from API_ORIGIN at build time. CI passes the same
# origin Terraform sets on the Cloud Run service.
ARG API_ORIGIN=http://localhost:3001
ENV API_ORIGIN=$API_ORIGIN
RUN pnpm --filter @bizora/web... build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /repo/apps/web/.next/standalone ./
COPY --from=deps /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=deps /repo/apps/web/public ./apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
