FROM node:20-bookworm

WORKDIR /app

# Install build tools for native modules (sqlite3) and SQLite libraries
RUN apt-get update && apt-get install -y python3 make g++ gcc libsqlite3-dev && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install dependencies, forcing sqlite3 to compile from source
RUN npm install --build-from-source sqlite3

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 3001

# Start the application
CMD ["npm", "start"]
