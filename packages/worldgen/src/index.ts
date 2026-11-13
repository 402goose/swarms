export interface Room {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  tag: "entry" | "monster" | "pvp" | "shrine" | "boss" | "extraction";
}

export interface DungeonMap {
  seed: number;
  widthTiles: number;
  heightTiles: number;
  tileSize: number;
  width: number;
  height: number;
  walls: string[];
  wallSet: Set<string>;
  rooms: Room[];
  spawnPoints: Array<{ x: number; y: number }>;
  monsterSpawns: Array<{ x: number; y: number; tag: string }>;
  relicSpawn: { x: number; y: number };
  bossSpawn: { x: number; y: number };
  extraction: { x: number; y: number; w: number; h: number };
  shrine: { x: number; y: number; w: number; h: number };
  hash: string;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function key(x: number, y: number): string {
  return `${x},${y}`;
}

function roomCenter(room: Room, tileSize: number): { x: number; y: number } {
  return {
    x: (room.x + room.w / 2) * tileSize,
    y: (room.y + room.h / 2) * tileSize,
  };
}

function hashWalls(walls: string[], seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  const text = walls.join(";");
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
}

export function generateDungeon(seed = 1337): DungeonMap {
  const widthTiles = 56;
  const heightTiles = 40;
  const tileSize = 32;
  const rooms: Room[] = [
    { id: "entry", x: 2, y: 16, w: 10, h: 8, tag: "entry" },
    { id: "crypt-west", x: 15, y: 5, w: 12, h: 10, tag: "monster" },
    { id: "crypt-south", x: 15, y: 25, w: 12, h: 10, tag: "monster" },
    { id: "arena", x: 29, y: 14, w: 12, h: 12, tag: "pvp" },
    { id: "shrine", x: 43, y: 4, w: 10, h: 8, tag: "shrine" },
    { id: "extraction", x: 46, y: 16, w: 8, h: 8, tag: "extraction" },
    { id: "bone-choir", x: 42, y: 27, w: 12, h: 10, tag: "boss" },
  ];
  const floor = new Set<string>();
  const carve = (x: number, y: number) => {
    if (x > 0 && y > 0 && x < widthTiles - 1 && y < heightTiles - 1) floor.add(key(x, y));
  };
  for (const room of rooms) {
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) carve(x, y);
    }
  }
  const centers = new Map(
    rooms.map((room) => [
      room.id,
      {
        x: Math.floor(room.x + room.w / 2),
        y: Math.floor(room.y + room.h / 2),
      },
    ]),
  );
  const connect = (aId: string, bId: string) => {
    const a = centers.get(aId)!;
    const b = centers.get(bId)!;
    let x = a.x;
    let y = a.y;
    while (x !== b.x) {
      carve(x, y - 1);
      carve(x, y);
      carve(x, y + 1);
      x += Math.sign(b.x - x);
    }
    while (y !== b.y) {
      carve(x - 1, y);
      carve(x, y);
      carve(x + 1, y);
      y += Math.sign(b.y - y);
    }
    carve(x - 1, y - 1);
    carve(x, y - 1);
    carve(x + 1, y - 1);
    carve(x - 1, y);
    carve(x, y);
    carve(x + 1, y);
    carve(x - 1, y + 1);
    carve(x, y + 1);
    carve(x + 1, y + 1);
  };
  connect("entry", "crypt-west");
  connect("entry", "crypt-south");
  connect("crypt-west", "arena");
  connect("crypt-south", "arena");
  connect("arena", "shrine");
  connect("arena", "extraction");
  connect("arena", "bone-choir");
  connect("shrine", "extraction");
  const rng = mulberry32(seed);
  const walls: string[] = [];
  const wallSet = new Set<string>();
  for (let y = 0; y < heightTiles; y++) {
    for (let x = 0; x < widthTiles; x++) {
      if (!floor.has(key(x, y))) {
        const k = key(x, y);
        walls.push(k);
        wallSet.add(k);
      }
    }
  }
  const roomById = new Map(rooms.map((room) => [room.id, room]));
  const entry = roomById.get("entry")!;
  const spawnPoints = [0, 1, 2, 3].map((i) => ({
    x: (entry.x + 2.5 + (i % 2) * 4) * tileSize,
    y: (entry.y + 4 + Math.floor(i / 2)) * tileSize,
  }));
  const monsterSpawns: DungeonMap["monsterSpawns"] = [];
  for (const room of rooms.filter((r) => ["monster", "pvp", "boss"].includes(r.tag))) {
    const count = room.tag === "boss" ? 8 : room.tag === "pvp" ? 10 : 16;
    for (let i = 0; i < count; i++) {
      monsterSpawns.push({
        x: (room.x + 1 + rng() * (room.w - 2)) * tileSize,
        y: (room.y + 1 + rng() * (room.h - 2)) * tileSize,
        tag: room.tag === "boss" ? "bone-warden" : "skeleton",
      });
    }
  }
  const extractionRoom = roomById.get("extraction")!;
  const shrineRoom = roomById.get("shrine")!;
  const bossRoom = roomById.get("bone-choir")!;
  return {
    seed,
    widthTiles,
    heightTiles,
    tileSize,
    width: widthTiles * tileSize,
    height: heightTiles * tileSize,
    walls,
    wallSet,
    rooms,
    spawnPoints,
    monsterSpawns,
    relicSpawn: roomCenter(bossRoom, tileSize),
    bossSpawn: roomCenter(bossRoom, tileSize),
    extraction: {
      x: extractionRoom.x * tileSize,
      y: extractionRoom.y * tileSize,
      w: extractionRoom.w * tileSize,
      h: extractionRoom.h * tileSize,
    },
    shrine: {
      x: shrineRoom.x * tileSize,
      y: shrineRoom.y * tileSize,
      w: shrineRoom.w * tileSize,
      h: shrineRoom.h * tileSize,
    },
    hash: hashWalls(walls, seed),
  };
}

export function isWall(map: DungeonMap, worldX: number, worldY: number): boolean {
  const tx = Math.floor(worldX / map.tileSize);
  const ty = Math.floor(worldY / map.tileSize);
  if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return true;
  return map.wallSet.has(key(tx, ty));
}

export function insideRect(
  point: { x: number; y: number },
  rect: { x: number; y: number; w: number; h: number },
): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h
  );
}
