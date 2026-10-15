FROM node:24-alpine

ENV CI=true
RUN npm install --global pnpm@12.11.2

WORKDIR /app
# Manifests first, so dependency layers are reused while only sources change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/bot/package.json packages/bot/package.json
COPY modules/sticky/package.json modules/sticky/package.json
COPY examples/notes/package.json examples/notes/package.json
RUN pnpm install --frozen-lockfile --prod

COPY tsconfig.base.json ./
COPY packages packages
COPY modules modules
COPY examples examples
COPY docker/bronto /usr/local/bin/bronto
RUN chmod 755 /usr/local/bin/bronto

ENV NODE_ENV=production
USER node
CMD ["bronto", "start"]
