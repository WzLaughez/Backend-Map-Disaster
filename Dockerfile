# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies untuk native modules (jika diperlukan)
RUN apk add --no-cache python3 make g++

# Copy package files dan prisma schema
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY tsconfig.json ./

# Set dummy DATABASE_URL untuk prisma generate saat build
# Prisma generate hanya butuh schema, tidak perlu koneksi DB aktual
ENV DATABASE_URL="mysql://dummy:dummy@localhost:3306/dummy"

# Install dependencies (akan trigger postinstall -> prisma generate)
RUN npm ci

# Copy source code dan data yang diperlukan
COPY src ./src
COPY uploads ./uploads
COPY auth ./auth

# Build TypeScript
RUN npm run build

# Stage 2: Production
FROM node:20-alpine AS production

WORKDIR /app

# Install dumb-init untuk proper signal handling
RUN apk add --no-cache dumb-init

# Copy only production dependencies
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./

# Set dummy DATABASE_URL lagi untuk postinstall di production stage
ENV DATABASE_URL="mysql://dummy:dummy@localhost:3306/dummy"
RUN npm ci --omit=dev && npm cache clean --force

# Copy built files dan data dari builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/uploads ./uploads
COPY --from=builder /app/auth ./auth

# Pastikan uploads folder writable
RUN mkdir -p /app/uploads && chmod 755 /app/uploads

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))" || exit 1

# Gunakan dumb-init sebagai PID 1
ENTRYPOINT ["dumb-init", "--"]

# Jalankan migrasi lalu start server
# DATABASE_URL diisi via environment variable saat runtime
CMD ["sh", "-c", "npx prisma db push && node dist/src/server.js"]
