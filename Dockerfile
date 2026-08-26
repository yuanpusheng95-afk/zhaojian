FROM oven/bun:1.3.10
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY dist/public ./dist/public
COPY scripts ./scripts
COPY migrations ./migrations
COPY tsconfig.json ./

ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "run", "src/api/main.ts"]
