FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json /app/
COPY tsconfig.base.json /app/tsconfig.base.json
COPY packages/contracts /app/packages/contracts
COPY apps/web /app/apps/web

RUN npm ci
RUN npm run build --workspace @the-council/contracts
RUN npm run build --workspace @the-council/web

WORKDIR /app/apps/web

EXPOSE 3000

CMD ["npm", "run", "dev"]
