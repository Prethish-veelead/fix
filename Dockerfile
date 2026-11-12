FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
RUN npm run build && mkdir -p /var/data/uploads && chown -R node:node /var/data
ENV NODE_ENV=production PORT=3000 DATABASE_FILE=/var/data/fixmitra.db UPLOAD_DIR=/var/data/uploads
EXPOSE 3000
USER node
CMD ["npm","start"]
