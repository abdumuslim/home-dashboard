# Home Environmental Monitoring Dashboard — Gemini Context

## Project Overview

This project is a self-hosted environmental monitoring dashboard accessible at **https://home.altijwal.com**. It unifies and visualizes data from multiple physical sensors using two distinct APIs:

1.  **Ambient Weather WS-2000**: An outdoor weather station (temperature, humidity, wind, rain, pressure, UV, solar radiation) and indoor sensors (console and channel 8). Data updates roughly every 5 minutes.
2.  **Qingping Air Monitor 2 (CGS1)**: An indoor air quality monitor (CO2, PM2.5, PM10, tVOC, noise, temperature, humidity). Data updates roughly every 15 minutes.

The project is structured as a monolithic repository containing a **Node.js (Express) + TypeScript backend** (`server/`) and a **React + TypeScript + Vite frontend** (`client/`).

## Architecture

*   **Backend (`server/`)**: Express 5 application written in TypeScript. It serves the REST API (`/api/current`, `/api/history`, `/api/status`), serves the built static frontend files, and runs a background collector task that polls the sensor APIs and writes to the database.
*   **Frontend (`client/`)**: A Single Page Application (SPA) built with React, TypeScript, and Vite. It uses Tailwind CSS v4 for styling, `lucide-react` for icons, and Chart.js for historical data visualization. The dashboard features a responsive, dark-themed UI.
*   **Database**: PostgreSQL (with pgvector), hosted in a separate container on the VPS. The application auto-creates the `home` database and uses two main tables: `weather_readings` and `air_readings`.
*   **Deployment**: A multi-stage Docker build process creates a single container that runs the Node.js backend (which serves the pre-built Vite frontend). The stack is managed via Docker Compose and sits behind a Traefik reverse proxy on an Ubuntu VPS.

## Building and Running

### Prerequisites
*   Node.js (v22+)
*   npm

### Frontend (Client)
The Vite dev server is configured to proxy `/api/*` requests to the live production server (`https://home.altijwal.com`), so a local backend is not strictly required for purely frontend UI work.

```bash
cd client
npm install

# Start the development server (with proxy to live API)
npm run dev

# Type-check the client
npm run build # runs tsc -b and vite build

# Lint the client
npm run lint
```

### Backend (Server)
```bash
cd server
npm install

# Start the development server (auto-reloads on changes)
npm run dev

# Build the server (compiles TypeScript to dist/)
npm run build

# Start the production server
npm run start
```

## Development Conventions

*   **Language**: Strict TypeScript is used across both the frontend and backend.
*   **Styling**: Use Tailwind CSS (v4) utility classes for styling components.
*   **Database**:
    *   Time-series data is stored with UTC timestamps (`ts TIMESTAMPTZ`).
    *   Deduplication is handled at the database level using `ON CONFLICT (ts) DO NOTHING`.
    *   All unit conversions (e.g., Fahrenheit to Celsius) are performed in the backend collector before saving to the database.
*   **Deployment & SSH**: 
    *   Deployment is done via an archive transfer to the VPS followed by a `docker compose up -d --build`.
    *   When running SSH commands via the CLI, standard output is not automatically captured. Always redirect the output to a local file and read it (e.g., `ssh ... "command" > D:/dev/home/ssh_out.txt 2>&1`).

## API Endpoints

*   `GET /api/current`: Returns the latest readings from all configured sources.
*   `GET /api/history?source=<weather|air>&range=<6h|24h|48h|1w|30d>`: Returns historical data points for charting.
*   `GET /api/status`: Returns system health and last update timestamps.
