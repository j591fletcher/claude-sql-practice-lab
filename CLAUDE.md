# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

A starter SQL practice app scaffold has been created. The project now includes a Node.js backend, static frontend, and a database folder where SQLite files can be added.

## Project Goal

A web application for practicing SQL queries. Databases are loaded from local SQLite files and practice questions are generated based on SQL topics using Claude or a local prompt fallback.

## Getting Started

- Install dependencies: `npm install`
- Add SQLite database files to the `data/` folder
- Copy `.env.example` to `.env` and set `CLAUDE_API_KEY` if you want generated prompts from Claude
- Start the app: `npm start`

## Notes

- The backend serves REST APIs from `/api/` and the static UI from `public/`
- The frontend can be extended to support more advanced prompt configuration, multiple databases, and structured SQL training flows
