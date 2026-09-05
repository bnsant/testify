FROM node:22-alpine AS build
WORKDIR /app
# O client ID é embutido no bundle do cliente pelo Vite em tempo de build. O
# Railway injeta como build-arg qualquer ARG com o mesmo nome de uma variável do
# serviço; declarar aqui também garante que mudar o valor invalide o cache da
# camada `npm run build`.
ARG VITE_DISCORD_CLIENT_ID
ARG DISCORD_CLIENT_ID
ENV VITE_DISCORD_CLIENT_ID=$VITE_DISCORD_CLIENT_ID
ENV DISCORD_CLIENT_ID=$DISCORD_CLIENT_ID
COPY package*.json ./
RUN npm ci
COPY client ./client
COPY shared ./shared
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Em container tem que escutar em todas as interfaces; o default 127.0.0.1 do
# server só serve para desenvolvimento local.
ENV HOST=0.0.0.0
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3001
CMD ["node", "server/index.js"]
