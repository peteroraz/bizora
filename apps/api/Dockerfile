FROM node:22-alpine AS build
WORKDIR /repo
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @bizora/api... build
# Production dependencies only. The migrate job runs with node, not tsx.
RUN pnpm --filter @bizora/api deploy --legacy --prod /out
# dist/ is gitignored, so copy the compiler output explicitly. sql.js resolves
# drizzle at ../../drizzle relative to dist/db/sql.js, which is /app/drizzle.
RUN cp -R /repo/apps/api/dist /out/dist && cp -R /repo/apps/api/drizzle /out/drizzle
RUN for pkg in config auth contracts; do \
      dest="/out/node_modules/@bizora/${pkg}"; \
      test -d "$dest"; \
      rm -rf "${dest}/dist"; \
      cp -R "/repo/packages/${pkg}/dist" "${dest}/dist"; \
    done
RUN test -f /out/dist/main.js && test -f /out/dist/db/migrate.js
RUN node -e "const fs=require('node:fs'); if (fs.existsSync('/out/node_modules/tsx')) { console.error('production image must not include tsx'); process.exit(1); } for (const spec of ['postgres','@bizora/config','@bizora/auth','@bizora/contracts']) { const root='/out/node_modules/'+spec; const resolved=fs.realpathSync(root); if (!resolved.startsWith('/out/')) { console.error(root+' resolves outside the image: '+resolved); process.exit(1); } }"
RUN cd /out && node --input-type=module -e "await import('postgres'); await import('@bizora/config/env'); await import('@bizora/auth'); await import('@bizora/contracts')"

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out ./
EXPOSE 3001
# Service command. The bizora-migrate job overrides this with:
# node dist/db/migrate.js
# Never run dist/db/seed.js in a cloud environment.
CMD ["node", "dist/main.js"]
