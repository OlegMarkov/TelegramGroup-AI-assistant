FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# /app/data is normally overlaid by a bind mount at runtime (see
# docker-compose.yml) — this chown covers the rest of the image and the
# fallback case where the app runs without that mount.
RUN mkdir -p data && chown -R node:node /app
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node healthcheck.js

CMD ["node", "--experimental-sqlite", "src/bot.js"]
