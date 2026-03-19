# Use lightweight Node.js 20 image
FROM node:20-alpine

# Set the working directory
WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install ONLY production dependencies to keep the image compact
RUN npm ci --omit=dev

# Bundle remaining app source code
COPY . .

# Expose server port (Matches index.js default if PORT isn't passed)
EXPOSE 3000

# Start server
CMD [ "npm", "start" ]
