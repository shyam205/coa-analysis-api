// Local API server:  npm run api   (reads .env, restarts when server/ or shared/ changes)
// Endpoints: see server/http.js
import http from 'node:http'
import { createApi } from './http.js'

const PORT = Number(process.env.PORT || 8787)

if (!process.env.GEMINI_API_KEY) {
  console.warn('[api] GEMINI_API_KEY is missing. Add it to COA_analysis/.env and restart; scans are refused until then.')
}

http.createServer(createApi()).listen(PORT, () => console.log(`[api] listening on http://localhost:${PORT}/api`))
