FROM node:24-alpine

ENV CI=true
RUN npm install --global pnpm@12.11.2

WORKDIR /app
# Downloads depend on the lockfile alone, so this layer is reused while only sources change.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --prod

# .dockerignore keeps secrets, configs and tests out.
COPY . .
RUN pnpm install --frozen-lockfile --offline --prod
COPY docker/bronto /usr/local/bin/bronto
RUN chmod 755 /usr/local/bin/bronto
# Fails the build when a module in the root package.json can't resolve its imports from the production install.
RUN node --import tsx --input-type=module -e "const { dependencies } = JSON.parse(await (await import('node:fs/promises')).readFile('package.json', 'utf8')); for (const name of Object.keys(dependencies).filter((name) => name.startsWith('@bronto/'))) await import(name)"

ENV NODE_ENV=production
USER node
CMD ["bronto", "start"]
