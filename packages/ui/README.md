# Symphony Studio

Visual editor and live debugger for symphony-core patterns. Start it from the repository root with
`npm start` (see the root [README](../../README.md)).

- `src/Studio.tsx`: app shell, run lifecycle, editing
- `src/canvas/`: React Flow node and edge renderers (status, data packets)
- `src/panels/`: toolbar, library, inspector (gates, approvals, AI output, state), timeline
- `src/lib/`: API client and the pure view model (frames, AI streams, canvas decoration)
- `server/api.ts`: REST + Server-Sent Events over the runtime, mounted by `server/plugin.ts`

Tests: `npm test` (unit, integration, API) and `npx playwright test` (browser e2e).
