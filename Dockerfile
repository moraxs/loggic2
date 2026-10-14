FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=18789 \
    LOGICC_HOST=0.0.0.0 \
    LOGICC_DATA_FILE=/app/data/state.json

WORKDIR /app
COPY package.json server.mjs pool.mjs auth.mjs LICENSE ./
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 18789

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "--input-type=module", "-e", "const response = await fetch('http://127.0.0.1:' + process.env.PORT + '/health'); if (!response.ok) process.exit(1);"]

CMD ["node", "server.mjs"]
