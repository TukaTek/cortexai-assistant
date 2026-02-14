FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src

ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/server.js"]
