# Reproducible test runner image. Browser versions match @playwright/test 1.65.1.
#   docker build -t pw-framework .
#   docker run --rm -e TEST_ENV=local pw-framework                      # full local suite
#   docker run --rm -e TEST_ENV=qa --env-file .env.qa pw-framework npm run test:api
FROM mcr.microsoft.com/playwright:v1.65.1-noble

WORKDIR /app
ENV CI=true

COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

COPY . .
RUN npm run build

# Run as the non-root user provided by the Playwright image.
RUN chown -R pwuser:pwuser /app
USER pwuser

CMD ["npm", "test"]
