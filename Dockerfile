FROM node:24-alpine AS deps
WORKDIR /app
# better-sqlite3 has no prebuilt binary for this platform and compiles here; the toolchain stays in this stage and never reaches the runner.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
FROM deps AS prod-deps
# The running image does not need the build toolchain or the development packages.
RUN npm prune --omit=dev --ignore-scripts
FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/package.json /app/package-lock.json ./
COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules
RUN mkdir -p /app/.data && chown nextjs:nodejs /app/.data
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
