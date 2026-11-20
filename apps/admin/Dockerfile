FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/admin ./apps/admin
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
RUN pnpm install --frozen-lockfile
# Next.js compiles rewrites from API_ORIGIN at build time. CI passes the same
# origin Terraform sets on the Cloud Run service.
ARG API_ORIGIN=http://localhost:3001
ENV API_ORIGIN=$API_ORIGIN
RUN pnpm --filter @bizora/admin... build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /repo/apps/admin/.next/standalone ./
COPY --from=deps /repo/apps/admin/.next/static ./apps/admin/.next/static
COPY --from=deps /repo/apps/admin/public ./apps/admin/public
EXPOSE 3002
ENV PORT=3002
CMD ["node", "apps/admin/server.js"]
