# SQL Practice Web App

A web app for practicing SQL against local SQLite databases. The UI lets you choose downloaded database files, inspect tables, generate SQL practice problems, and validate queries.

## Features

- Browse SQLite database files placed in `data/`
- Select a table and SQL topic
- Generate practice problems using Claude (when configured)
- Run and validate SQL queries directly against the database

## Getting started

1. Copy `.env.example` to `.env` and optionally set `CLAUDE_API_KEY`.
2. Add `.db`, `.sqlite`, or `.sqlite3` files to the `data/` folder.
3. Install dependencies:

   ```bash
   npm install
   ```

4. Start the app:

   ```bash
   npm start
   ```

5. Open `http://localhost:4000` in your browser.

## Notes

- If `CLAUDE_API_KEY` is not configured, the app falls back to a local prompt description instead of calling the Claude API.
- The backend serves static frontend files from `public/` and exposes REST APIs under `/api/`.
