FROM node:22-alpine

# Claude Code needs git and a writable home
RUN apk add --no-cache git
ENV HOME=/home/node
RUN mkdir -p /home/node/.claude && chown -R node:node /home/node

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY dashboard/ ./dashboard/

# Create state and output dirs with write permissions
RUN mkdir -p state output && chown -R node:node /app/state /app/output

# Claude Code needs to accept ToS non-interactively
ENV CLAUDE_CODE_ACCEPT_TOS=true

EXPOSE 3000

# Run as non-root (Claude Code preference)
USER node

CMD ["npx", "tsx", "dashboard/server.ts"]
