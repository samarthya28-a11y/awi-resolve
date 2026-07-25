# AWI Resolve orchestrator (the "connector") — always-on host image.
# Small Node image; installs only production deps (ws + @anthropic-ai/sdk).
FROM node:22-alpine

WORKDIR /app

# Install prod dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Only the orchestrator runs in the cloud (the agent ships to customers separately)
COPY orchestrator ./orchestrator

# The app reads PORT from the environment (host injects it); default 8787.
ENV PORT=8787
EXPOSE 8787

CMD ["node", "orchestrator/server.js"]
