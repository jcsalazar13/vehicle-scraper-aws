# Imagen oficial de Playwright: trae Chromium y todas sus dependencias del sistema.
# IMPORTANTE: la versión de la imagen debe coincidir con la de "playwright" en package.json.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

# Los browsers ya están en la imagen: no volver a descargarlos
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# Usuario sin privilegios que ya existe en la imagen de Playwright
USER pwuser

CMD ["node", "src/worker.js"]
