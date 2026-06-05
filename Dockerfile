# AIO-Survey — Node/Express + better-sqlite3 (native module, needs a build toolchain)
FROM node:20-bookworm-slim

# better-sqlite3 compiles a native addon on install -> needs python3 + a C/C++ toolchain.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# Data lives here; mounted as a persistent volume in docker-compose.
ENV DATA_DIR=/app/data
EXPOSE 3000

CMD ["node", "server.js"]
