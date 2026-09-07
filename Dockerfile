# ---- build stage ----
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
# Tesseract language data (so OCR works without a cold-start CDN download)
COPY eng.traineddata ./eng.traineddata
# Hebrew font for the PDF reports: pdfkit embeds it, no system font exists
COPY assets ./assets
EXPOSE 3000
CMD ["node", "dist/index.js"]
