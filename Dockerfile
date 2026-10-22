FROM node:24-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

# Install deps first so code changes don't invalidate this layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

USER node

CMD ["node", "src/server.js"]
