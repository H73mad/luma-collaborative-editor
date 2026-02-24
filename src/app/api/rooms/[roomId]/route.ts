import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { NextRequest, NextResponse } from "next/server";
import type { EditorShape } from "@/lib/editor-types";

export const dynamic = "force-dynamic";

const PRESENCE_TTL_MS = 15_000;
const HISTORY_LIMIT = 300;
const ROOMS_FILE_PATH = path.join(process.cwd(), "data", "rooms.json");

type Presence = {
  clientId: string;
  name: string;
  color: string;
  x?: number;
  y?: number;
  lastSeen: number;
};

type HistoryEntry = {
  id: string;
  timestamp: number;
  version: number;
  actorId: string;
  actorName: string;
  action: string;
  targetId?: string;
  targetName?: string;
};

type RoomState = {
  version: number;
  state: EditorShape[];
  updatedBy: string | null;
  updatedAt: number;
  presences: Record<string, Presence>;
  history: HistoryEntry[];
};

type PersistedRooms = Record<string, RoomState>;

type RoomsContainer = {
  rooms?: Map<string, RoomState>;
  roomsLoaded?: boolean;
};

const globalForRooms = globalThis as unknown as RoomsContainer;
const rooms = globalForRooms.rooms ?? new Map<string, RoomState>();
globalForRooms.rooms = rooms;

async function ensureRoomsLoaded() {
  if (globalForRooms.roomsLoaded) {
    return;
  }

  try {
    const raw = await readFile(ROOMS_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw) as PersistedRooms;

    Object.entries(parsed).forEach(([roomId, room]) => {
      rooms.set(roomId, {
        ...room,
        presences: room.presences ?? {},
        history: room.history ?? [],
      });
    });
  } catch {
    await mkdir(path.dirname(ROOMS_FILE_PATH), { recursive: true });
    await writeFile(ROOMS_FILE_PATH, JSON.stringify({}, null, 2), "utf8");
  }

  globalForRooms.roomsLoaded = true;
}

async function persistRooms() {
  await mkdir(path.dirname(ROOMS_FILE_PATH), { recursive: true });
  const serializable: PersistedRooms = Object.fromEntries(rooms.entries());
  await writeFile(ROOMS_FILE_PATH, JSON.stringify(serializable, null, 2), "utf8");
}

function getOrCreateRoom(roomId: string) {
  const existing = rooms.get(roomId);
  if (existing) {
    return existing;
  }

  const created: RoomState = {
    version: 0,
    state: [],
    updatedBy: null,
    updatedAt: Date.now(),
    presences: {},
    history: [],
  };
  rooms.set(roomId, created);
  return created;
}

function activeCollaborators(room: RoomState) {
  const now = Date.now();
  const active: Presence[] = [];

  Object.entries(room.presences).forEach(([clientId, presence]) => {
    if (now - presence.lastSeen > PRESENCE_TTL_MS) {
      delete room.presences[clientId];
      return;
    }
    active.push({ ...presence, clientId });
  });

  return active;
}

function pushHistory(room: RoomState, entry: Omit<HistoryEntry, "id" | "timestamp">) {
  room.history.push({
    id: nanoid(),
    timestamp: Date.now(),
    ...entry,
  });

  if (room.history.length > HISTORY_LIMIT) {
    room.history = room.history.slice(-HISTORY_LIMIT);
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  await ensureRoomsLoaded();
  const { roomId } = await params;

  const room = getOrCreateRoom(roomId);
  const collaborators = activeCollaborators(room);
  await persistRooms();

  return NextResponse.json({
    version: room.version,
    state: room.state,
    updatedBy: room.updatedBy,
    updatedAt: room.updatedAt,
    collaborators,
    history: room.history,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  await ensureRoomsLoaded();
  const { roomId } = await params;

  const body = (await request.json()) as {
    clientId?: string;
    version?: number;
    state?: EditorShape[];
    stateChanged?: boolean;
    presence?: {
      x?: number;
      y?: number;
      color?: string;
      name?: string;
    };
    action?: {
      action?: string;
      targetId?: string;
      targetName?: string;
    };
  };

  if (!body.clientId) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const room = getOrCreateRoom(roomId);
  const previousPresence = room.presences[body.clientId];
  const actorName = body.presence?.name || previousPresence?.name || "Artist";

  room.presences[body.clientId] = {
    clientId: body.clientId,
    name: actorName,
    color: body.presence?.color || previousPresence?.color || "#2563eb",
    x: body.presence?.x,
    y: body.presence?.y,
    lastSeen: Date.now(),
  };

  let applied = true;
  if (body.stateChanged) {
    if (typeof body.version !== "number" || !Array.isArray(body.state)) {
      return NextResponse.json({ error: "Invalid state payload" }, { status: 400 });
    }

    if (body.version < room.version) {
      applied = false;
    } else {
      room.version += 1;
      room.state = body.state;
      room.updatedBy = body.clientId;
      room.updatedAt = Date.now();

      pushHistory(room, {
        version: room.version,
        actorId: body.clientId,
        actorName,
        action: body.action?.action || "Updated canvas",
        targetId: body.action?.targetId,
        targetName: body.action?.targetName,
      });
    }
  }

  const collaborators = activeCollaborators(room);
  await persistRooms();

  return NextResponse.json({
    applied,
    version: room.version,
    state: room.state,
    updatedBy: room.updatedBy,
    updatedAt: room.updatedAt,
    collaborators,
    history: room.history,
  });
}
