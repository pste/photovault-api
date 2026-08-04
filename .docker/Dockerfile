FROM node:24-alpine

# SETUP npm
RUN npm config set engine-strict true

# INSTALL PACKAGES
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json .
RUN npm ci --omit=dev

# INSTALL APP
COPY app.js .
COPY src/ src/

# Il pool libuv di default ha 4 thread e ogni lettura su CIFS ne occupa uno per
# millisecondi: con 4 una griglia da 200 thumbnail si serializza in uno stallo,
# e blocca anche le altre chiamate fs.
ENV UV_THREADPOOL_SIZE=16

# SECURITY CHECK
RUN chown -R node:node /app
USER node

CMD ["npm","run","prod"]
