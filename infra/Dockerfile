FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY server/src ./server/src
COPY scripts/build-server.mjs ./scripts/build-server.mjs
RUN node scripts/build-server.mjs

FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist/server ./dist/server
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100
USER node
EXPOSE 3100
CMD ["node", "dist/server/index.mjs"]
