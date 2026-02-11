FROM node:22-slim

WORKDIR /app

# Install deps
COPY package.json package-lock.json ./
RUN npm ci --production=false

# Copy source and build frontend
COPY . .
RUN npm run build

# Prune devDependencies after build
RUN npm prune --production

# Persist session data outside the container
VOLUME /app/data

EXPOSE 3062

CMD ["node", "server.js"]
