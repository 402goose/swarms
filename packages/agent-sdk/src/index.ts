import type {
  ClientMessage,
  ContractDraft,
  GameCommand,
  ServerMessage,
  ZoneSnapshot,
  ZoneWorldSnapshot,
} from "@swarms/protocol";
import { SCHEMA_VERSION } from "@swarms/protocol";
import WebSocket from "ws";

export interface Welcome {
  sessionId: string;
  commanderId: string;
  resumeToken: string;
}

export class SwarmClient {
  private ws: WebSocket | undefined;
  private seq = 0;
  private snapshotHandlers = new Set<(snapshot: ZoneSnapshot) => void>();
  private messageHandlers = new Set<(message: ServerMessage) => void>();
  private staticWorld?: ZoneWorldSnapshot;
  private staticWorldHash = "";
  private worldRequested = false;
  welcome?: Welcome;
  lastSnapshot?: ZoneSnapshot;

  constructor(private readonly url: string) {}

  async connect(input: {
    name: string;
    kind?: "human" | "agent";
    resumeToken?: string;
  }): Promise<Welcome> {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    const welcomed = new Promise<Welcome>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("welcome_timeout")), 10_000);
      ws.once("open", () => {
        this.raw({
          type: "hello",
          schemaVersion: SCHEMA_VERSION,
          name: input.name,
          kind: input.kind ?? "agent",
          ...(input.resumeToken ? { resumeToken: input.resumeToken } : {}),
        });
      });
      ws.on("message", (data) => {
        const message = JSON.parse(String(data)) as ServerMessage;
        for (const handler of this.messageHandlers) handler(message);
        if (message.type === "welcome") {
          this.welcome = {
            sessionId: message.sessionId,
            commanderId: message.commanderId,
            resumeToken: message.resumeToken,
          };
          clearTimeout(timer);
          resolve(this.welcome);
        }
        if (message.type === "snapshot") {
          if (message.snapshot.world) {
            this.staticWorld = message.snapshot.world;
            this.staticWorldHash = message.snapshot.worldHash;
            this.worldRequested = false;
          }
          if (!this.staticWorld || message.snapshot.worldHash !== this.staticWorldHash) {
            if (!this.worldRequested) {
              this.worldRequested = true;
              this.raw({ type: "requestWorld" });
            }
          } else {
            const snapshot = { ...message.snapshot, world: this.staticWorld };
            this.lastSnapshot = snapshot;
            for (const handler of this.snapshotHandlers) handler(snapshot);
          }
        }
        if (message.type === "error") {
          clearTimeout(timer);
          reject(new Error(`${message.code}: ${message.message}`));
        }
      });
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return welcomed;
  }

  onSnapshot(handler: (snapshot: ZoneSnapshot) => void): () => void {
    this.snapshotHandlers.add(handler);
    return () => this.snapshotHandlers.delete(handler);
  }

  onMessage(handler: (message: ServerMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  command(command: GameCommand): void {
    this.raw({ type: "command", seq: this.seq++, command });
  }

  postContract(idempotencyKey: string, draft: ContractDraft): void {
    this.raw({ type: "postContract", idempotencyKey, draft });
  }

  acceptContract(idempotencyKey: string, contractId: string): void {
    this.raw({ type: "acceptContract", idempotencyKey, contractId });
  }

  ping(): void {
    this.raw({ type: "ping", at: Date.now() });
  }

  requestWorld(): void {
    this.worldRequested = true;
    this.raw({ type: "requestWorld" });
  }

  close(): void {
    this.ws?.close();
    this.ws = undefined;
  }

  private raw(message: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // hello is sent from the open handler before callers can use the client.
      if (message.type !== "hello") throw new Error("not_connected");
    }
    this.ws?.send(JSON.stringify(message));
  }
}
