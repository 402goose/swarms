import { SwarmClient } from "@swarms/agent-sdk";
import { generateDungeon } from "@swarms/worldgen";

const url = process.env.SWARMS_WS_URL ?? "ws://127.0.0.1:18787/ws";
const name = process.env.SWARMS_BOT_NAME ?? "SDK Bot";
const client = new SwarmClient(url);
const map = generateDungeon(Number(process.env.SWARMS_SEED ?? 1337));
const shrine = {
  x: map.shrine.x + map.shrine.w / 2,
  y: map.shrine.y + map.shrine.h / 2,
};
const accepted = new Set<string>();
let lastCommandAt = 0;

const welcome = await client.connect({ name, kind: "agent" });
console.log(`${name} connected as ${welcome.commanderId}`);

client.onSnapshot((snapshot) => {
  const now = Date.now();
  if (now - lastCommandAt < 550) return;
  lastCommandAt = now;
  const self = snapshot.commanders.find((c) => c.id === snapshot.selfCommanderId);
  if (!self?.alive) return;

  for (const contract of snapshot.contracts) {
    if (contract.status !== "open" || accepted.has(contract.id)) continue;
    accepted.add(contract.id);
    client.acceptContract(`sdk-accept:${welcome.commanderId}:${contract.id}:v1`, contract.id);
    console.log(`accepted ${contract.id}: ${contract.title}`);
    break;
  }

  if (self.carryingItemId) {
    client.command({ type: "move", target: shrine });
    return;
  }
  const relic = snapshot.pickups.find((p) => p.templateId === "relic");
  const boss = snapshot.entities.find((e) => e.id === "boss-bone-choir");
  const monsters = snapshot.entities
    .filter((e) => e.kind === "monster")
    .sort(
      (a, b) => Math.hypot(a.x - self.x, a.y - self.y) - Math.hypot(b.x - self.x, b.y - self.y),
    );
  const target = monsters[0] ?? boss ?? relic;
  if (target) client.command({ type: "attackMove", target: { x: target.x, y: target.y } });
  const nearby = snapshot.entities.filter(
    (e) => e.kind === "monster" && Math.hypot(e.x - self.x, e.y - self.y) < 140,
  ).length;
  if (self.command >= 45 && nearby >= 3) {
    client.command({ type: "cast", spell: "nova", target: { x: self.x, y: self.y } });
  }
});

setInterval(() => client.ping(), 5000);
process.on("SIGINT", () => {
  client.close();
  process.exit(0);
});
