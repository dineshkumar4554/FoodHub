# One image, eight services: pick the service with the SERVICE env var (docker-compose does this).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY shared ./shared
COPY services ./services
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV SERVICE=gateway
EXPOSE 3000 4000 4001 4002 4003 4004 4005 4006
CMD ["sh", "-c", "node services/$SERVICE/index.js"]
