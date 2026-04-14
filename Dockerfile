FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY dashboard/ ./dashboard/

# Create state and output dirs
RUN mkdir -p state output

EXPOSE 3000

CMD ["npx", "tsx", "dashboard/server.ts"]
