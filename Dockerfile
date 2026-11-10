FROM node:24-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

# Install deps first so code changes don't invalidate this layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# The bot's allowlist lives here; a named volume mounted on it inherits this owner.
RUN mkdir data && chown node:node data

USER node

# The MCP server; the bot service overrides this with src/bot.js.
CMD ["node", "src/server.js"]
