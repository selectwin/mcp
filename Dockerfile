# Selectwin MCP — the hosted Streamable HTTP server (mcp.selectwin.io). Built by .github/workflows/image.yml and
# pulled by the Swarm stack in docker/stack/app.yml; nothing secret goes in the image or the stack (the SelectKey
# arrives with each request).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsup.config.ts openapi.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/selectwin/mcp" \
      org.opencontainers.image.description="Selectwin MCP server (Streamable HTTP)" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1
CMD ["node", "dist/http.js"]
