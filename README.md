# Upward Investments Backend

This folder contains the Node.js/Express backend for the Upward Investments application.

## Run locally

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the example environment file and update values:
   ```bash
   cp .env.example .env.local
   ```
3. Start the server:
   ```bash
   npm start
   ```

## Notes

- The backend expects a MySQL database configured via the `DATABASE_URL` environment variable.
- Prisma migrations should be applied from this folder when the database is ready.
