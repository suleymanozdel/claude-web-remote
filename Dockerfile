FROM node:20-slim

RUN apt-get update && apt-get install -y python3 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js pty-helper.py ./
COPY public/ ./public/

EXPOSE 3000

CMD ["node", "server.js"]
