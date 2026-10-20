FROM node:24-alpine
WORKDIR /app
COPY . .
ENV PORT=3000 DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 3000
CMD ["node", "server.js"]
