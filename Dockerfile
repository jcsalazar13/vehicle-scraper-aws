# Base de Playwright (Chromium + deps del sistema + Node) servida desde un ESPEJO en TU
# ECR, no desde mcr.microsoft.com — porque MCR throttlea los pulls anónimos (HTTP 429) y
# rompe el build del CI. El espejo lo crea terraform (ecr_base.tf) y se siembra una vez
# (ver AWS-DEPLOY.md). El CI ya hace `ecr-login`, así que jala esta base autenticado.
# IMPORTANTE: el tag del espejo (1.47.0-jammy) debe coincidir con "playwright" en package.json.
ARG PW_BASE=767397788051.dkr.ecr.us-east-1.amazonaws.com/vehicle-scraper-playwright-base:1.47.0-jammy
FROM ${PW_BASE}

WORKDIR /app

# Los browsers ya están en la imagen base: no volver a descargarlos
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# Usuario sin privilegios que ya existe en la imagen de Playwright
USER pwuser

CMD ["node", "src/worker.js"]
