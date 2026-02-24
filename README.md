# Luma

Luma is a collaborative web editor for design, illustration, and rapid visual prototyping.

## Highlights

- Icon-based tool rail for Select, Marquee, Rectangle, Ellipse, Text, Brush, Line, and Eraser
- Layer manager with rename, hide/show, lock/unlock, and reordering
- Inspector controls: fills/strokes, blend modes, drop shadows, alignment, image adjustments
- Undo/Redo, duplicate, delete, clear canvas, and keyboard shortcuts
- Real-time room collaboration by link/code with live collaborator cursors
- Composition and workflow overlays: rulers, guides, rule-of-thirds, safe area
- Advanced composition tools: smart guides, clipping, adjustment layers, draw-layer reuse
- Creative automation: one-click “masterpiece” presets and image auto-polish
- PNG export plus JSON scene import/export
- Local room draft autosave/restore and persistent room storage on disk (`data/rooms.json`)

## Tech Stack

- Next.js App Router + TypeScript
- Tailwind CSS
- react-konva / konva for canvas editing
- lucide-react for iconography
- File-persisted room state API (`/api/rooms/[roomId]`)

## Run Locally

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## How Collaboration Works

- Opening the app creates a room code automatically in the URL.
- Use **Copy Link** to invite someone directly to the same room.
- Or share the room code and they can join via the **Join** input.
- All clients in the same room sync canvas state, layer updates, and cursor presence.

## Build Check

```bash
npm run build
```

## Notes

- Room data persists to `data/rooms.json`.
- For production, replace file persistence with a managed database.

## Portfolio Usage

- Use this project as a full-stack portfolio piece demonstrating collaborative UX, canvas rendering, state management, and API-backed synchronization.
