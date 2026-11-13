import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";

export interface ZoneStore {
  appendEvents(events: unknown[]): void;
  appendArchive(name: string, records: unknown[]): void;
  saveCheckpoint(data: unknown): void;
  loadCheckpoint<T>(): T | undefined;
  loadCheckpointCandidates?<T>(): T[];
  close?(): void;
  readEvents<T = unknown>(): T[];
}

export interface FileZoneStoreOptions {
  maxEventBytes?: number;
  eventGenerations?: number;
}

interface CheckpointEnvelope {
  format: "swarms.checkpoint.v2";
  savedAt: string;
  checksum: string;
  payload: unknown;
}

interface DirectoryLock {
  fd: number;
  count: number;
}

const directoryLocks = new Map<string, DirectoryLock>();

export class FileZoneStore implements ZoneStore {
  private readonly eventsPath: string;
  private readonly checkpointPath: string;
  private readonly previousCheckpointPath: string;
  private readonly lockPath: string;
  private readonly lockKey: string;
  private closed = false;
  private readonly archiveDir: string;
  private readonly maxEventBytes: number;
  private readonly eventGenerations: number;
  private readonly archiveIds = new Map<string, Set<string>>();

  constructor(
    readonly dir: string,
    options: FileZoneStoreOptions = {},
  ) {
    mkdirSync(dir, { recursive: true });
    this.eventsPath = join(dir, "events.jsonl");
    this.checkpointPath = join(dir, "checkpoint.json");
    this.previousCheckpointPath = join(dir, "checkpoint.prev.json");
    this.lockPath = join(dir, "zone.lock");
    this.lockKey = resolve(dir);
    this.archiveDir = join(dir, "archive");
    this.maxEventBytes = Math.max(0, Math.floor(options.maxEventBytes ?? 8 * 1024 * 1024));
    this.eventGenerations = Math.max(0, Math.floor(options.eventGenerations ?? 3));
    this.acquireLock();
    if (!existsSync(this.eventsPath)) writeFileSync(this.eventsPath, "");
  }

  private static isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private acquireLock(): void {
    const existing = directoryLocks.get(this.lockKey);
    if (existing) {
      existing.count++;
      return;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.lockPath, "wx");
        try {
          this.writeAll(
            fd,
            JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
          );
          fsyncSync(fd);
        } catch (error) {
          closeSync(fd);
          rmSync(this.lockPath, { force: true });
          throw error;
        }
        directoryLocks.set(this.lockKey, { fd, count: 1 });
        this.fsyncDir(this.dir);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let pid = 0;
        try {
          const parsed = JSON.parse(readFileSync(this.lockPath, "utf8")) as { pid?: unknown };
          pid = Number(parsed.pid ?? 0);
        } catch {
          pid = 0;
        }
        if (pid > 0 && pid !== process.pid && FileZoneStore.isProcessAlive(pid)) {
          throw new Error("zone_store_locked");
        }
        rmSync(this.lockPath, { force: true });
      }
    }
    throw new Error("zone_store_locked");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const lock = directoryLocks.get(this.lockKey);
    if (!lock) return;
    lock.count--;
    if (lock.count > 0) return;
    directoryLocks.delete(this.lockKey);
    closeSync(lock.fd);
    let pid = 0;
    try {
      const parsed = JSON.parse(readFileSync(this.lockPath, "utf8")) as { pid?: unknown };
      pid = Number(parsed.pid ?? 0);
    } catch {
      pid = 0;
    }
    if (pid === process.pid) {
      rmSync(this.lockPath, { force: true });
      this.fsyncDir(this.dir);
    }
  }

  private writeAll(fd: number, text: string): void {
    const buffer = Buffer.from(text);
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(fd, buffer, offset, buffer.length - offset);
      if (written <= 0) throw new Error("short_write");
      offset += written;
    }
  }

  private fsyncDir(path: string): void {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private appendText(path: string, text: string): void {
    const fd = openSync(path, "a");
    try {
      this.writeAll(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private archiveRecordId(record: unknown): string | undefined {
    if (!record || typeof record !== "object") return undefined;
    const source = record as { id?: unknown; record?: { id?: unknown } };
    const id = source.id ?? source.record?.id;
    return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
  }

  private archiveIdSet(name: string, path: string): Set<string> {
    const cached = this.archiveIds.get(name);
    if (cached) return cached;
    const ids = new Set<string>();
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          parsed = undefined;
        }
        const id = this.archiveRecordId(parsed);
        if (id) ids.add(id);
      }
    }
    this.archiveIds.set(name, ids);
    return ids;
  }

  private eventGenerationPath(generation: number): string {
    return join(this.dir, `events.${generation}.jsonl`);
  }

  private rotateEventsIfNeeded(nextBytes: number): void {
    if (this.maxEventBytes <= 0 || !existsSync(this.eventsPath)) return;
    const size = statSync(this.eventsPath).size;
    if (size === 0 || size + nextBytes <= this.maxEventBytes) return;
    if (this.eventGenerations <= 0) {
      writeFileSync(this.eventsPath, "");
      return;
    }
    for (let generation = this.eventGenerations - 1; generation >= 1; generation--) {
      const source = this.eventGenerationPath(generation);
      if (!existsSync(source)) continue;
      const destination = this.eventGenerationPath(generation + 1);
      rmSync(destination, { force: true });
      renameSync(source, destination);
    }
    const firstGeneration = this.eventGenerationPath(1);
    rmSync(firstGeneration, { force: true });
    renameSync(this.eventsPath, firstGeneration);
    writeFileSync(this.eventsPath, "");
    this.fsyncDir(this.dir);
  }

  appendEvents(events: unknown[]): void {
    if (events.length === 0) return;
    const text = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    this.rotateEventsIfNeeded(Buffer.byteLength(text));
    this.appendText(this.eventsPath, text);
  }

  appendArchive(name: string, records: unknown[]): void {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error("invalid_archive_name");
    if (records.length === 0) return;
    mkdirSync(this.archiveDir, { recursive: true });
    const path = join(this.archiveDir, `${name}.jsonl`);
    const knownIds = this.archiveIdSet(name, path);
    const freshIds = new Set<string>();
    const fresh = records.filter((record) => {
      const id = this.archiveRecordId(record);
      if (!id) return true;
      if (knownIds.has(id) || freshIds.has(id)) return false;
      freshIds.add(id);
      return true;
    });
    if (fresh.length === 0) return;
    const text = `${fresh.map((record) => JSON.stringify(record)).join("\n")}\n`;
    this.appendText(path, text);
    this.fsyncDir(this.archiveDir);
    for (const id of freshIds) knownIds.add(id);
  }

  saveCheckpoint(data: unknown): void {
    const payloadText = JSON.stringify(data);
    if (payloadText === undefined) throw new Error("invalid_checkpoint");
    const envelope: CheckpointEnvelope = {
      format: "swarms.checkpoint.v2",
      savedAt: new Date().toISOString(),
      checksum: createHash("sha256").update(payloadText).digest("hex"),
      payload: JSON.parse(payloadText) as unknown,
    };
    const tmp = `${this.checkpointPath}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      this.writeAll(fd, JSON.stringify(envelope));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (existsSync(this.checkpointPath)) {
      rmSync(this.previousCheckpointPath, { force: true });
      renameSync(this.checkpointPath, this.previousCheckpointPath);
      this.fsyncDir(this.dir);
    }
    renameSync(tmp, this.checkpointPath);
    this.fsyncDir(this.dir);
  }

  private readCheckpointCandidate(path: string): { exists: boolean; value?: unknown } {
    if (!existsSync(path)) return { exists: false };
    const text = readFileSync(path, "utf8").trim();
    if (!text) return { exists: true };
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && "format" in parsed) {
        const envelope = parsed as Partial<CheckpointEnvelope>;
        if (
          envelope.format !== "swarms.checkpoint.v2" ||
          typeof envelope.checksum !== "string" ||
          !("payload" in envelope)
        ) {
          return { exists: true };
        }
        const payloadText = JSON.stringify(envelope.payload);
        if (
          payloadText === undefined ||
          createHash("sha256").update(payloadText).digest("hex") !== envelope.checksum
        ) {
          return { exists: true };
        }
        return { exists: true, value: envelope.payload };
      }
      return { exists: true, value: parsed };
    } catch {
      return { exists: true };
    }
  }

  loadCheckpointCandidates<T>(): T[] {
    const values: T[] = [];
    let sawExisting = false;
    for (const path of [
      this.checkpointPath,
      this.previousCheckpointPath,
      `${this.checkpointPath}.tmp`,
    ]) {
      const candidate = this.readCheckpointCandidate(path);
      sawExisting ||= candidate.exists;
      if ("value" in candidate) values.push(candidate.value as T);
    }
    if (values.length > 0) return values;
    if (sawExisting) throw new Error("checkpoint_unrecoverable");
    return [];
  }

  loadCheckpoint<T>(): T | undefined {
    return this.loadCheckpointCandidates<T>()[0];
  }

  readEvents<T = unknown>(): T[] {
    if (!existsSync(this.eventsPath)) return [];
    return readFileSync(this.eventsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  }
}
