FROM node:18-slim

# Install dependencies
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libu2f-udev \
    libvulkan1 \
    xdg-utils \
    libgbm1 \
    wget \
    --no-install-recommends && apt-get clean && rm -rf /var/lib/apt/lists/*

# Download and install Google Chrome
RUN curl -sSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o chrome.deb \
    && apt install -y ./chrome.deb \
    && rm chrome.deb

# Puppeteer settings
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome
ENV NODE_ENV=production

# Set workdir
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy source code
COPY . .

EXPOSE 3000

# Health check (optional but helps with Railway cold starts)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s \
  CMD curl -f http://localhost:3000/test-cors || exit 1

CMD ["node", "index.js"]
