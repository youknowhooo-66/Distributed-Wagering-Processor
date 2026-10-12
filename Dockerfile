# ── Build: needs devDependencies (@nestjs/cli, typescript, bun-types) ──
FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN bun run build

# ── Runtime dependencies only ──
FROM oven/bun:1.4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ── Production ──
FROM oven/bun:1.4-slim AS production
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun package.json ./
USER bun

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "dist/main.js"]
