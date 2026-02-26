# Stage 1: Build client
FROM node:22-slim AS client-build
WORKDIR /build/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: Build server
FROM node:22-slim AS server-build
WORKDIR /build/server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npx tsc

# Stage 3: Production
FROM node:22-slim
WORKDIR /app
COPY --from=server-build /build/server/dist ./dist
COPY --from=server-build /build/server/node_modules ./node_modules
COPY --from=server-build /build/server/package.json ./
COPY --from=client-build /build/client/dist ./static
EXPOSE 8000
CMD ["node", "dist/index.js"]
