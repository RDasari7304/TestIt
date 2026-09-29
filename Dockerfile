# test.it production image: Node 22 + Chromium for real-browser testing.
# All three modes work here; Build mode only downloads and reads source code
# (it never runs it), so no Docker is needed.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-color-emoji ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    CHROME_PATH=/usr/bin/chromium \
    CHROME_NO_SANDBOX=1

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
RUN mkdir -p /app/data /app/reports && chown -R node:node /app

USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
