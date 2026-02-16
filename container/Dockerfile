# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux container with browser automation

FROM docker.io/oven/bun:latest AS base

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code to a shared location (not root's home)
ENV BUN_INSTALL=/opt/bun-global
RUN bun install -g agent-browser @anthropic-ai/claude-code
ENV PATH="/opt/bun-global/bin:$PATH"
RUN chmod -R a+rX /opt/bun-global
# Claude Code CLI has #!/usr/bin/env node shebang — symlink bun as node
RUN ln -s /usr/local/bin/bun /usr/local/bin/node

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./
# Install dependencies
RUN bun install

# Copy source code
COPY agent-runner/ ./

# Create workspace and home directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input /nanoclaw-home
RUN chmod -R 777 /workspace /nanoclaw-home

# Set HOME to a writable location that works with any UID
ENV HOME=/nanoclaw-home

# Create entrypoint script
# Bun runs TypeScript directly — no compile step needed
# Secrets are passed via stdin JSON — temp file is deleted immediately after Bun reads it
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ncat > /tmp/input.json\nbun run /app/src/index.ts < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
