# Imagen para hostings que usan Docker (Fly.io, Railway, un VPS…). Se construye desde la carpeta raíz:
#   docker build -f server/Dockerfile -t videotk .
FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev
COPY index.html styles.css app.js api-client.js sw.js manifest.webmanifest ./
COPY icons ./icons
COPY server/src server/src
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
VOLUME /data
EXPOSE 3000
WORKDIR /app/server
CMD ["node", "src/index.js"]
