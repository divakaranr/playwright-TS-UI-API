import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const MAX_ENTRY_BYTES = 50 * 1024 * 1024;

/**
 * Minimal, dependency-free ZIP reader (stored + deflate entries) sufficient for
 * Playwright trace archives. Reads the central directory for reliable sizes.
 */
export class ZipReader {
  private constructor(
    private readonly buffer: Buffer,
    readonly entries: ZipEntry[],
  ) {}

  static async open(file: string): Promise<ZipReader> {
    const buffer = await readFile(file);
    return new ZipReader(buffer, ZipReader.readCentralDirectory(buffer));
  }

  private static readCentralDirectory(buffer: Buffer): ZipEntry[] {
    // End of central directory record: signature 0x06054b50, search backwards (comment up to 64KB).
    let eocd = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) throw new Error('not a zip archive (end of central directory not found)');
    const count = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    if (offset === 0xffffffff) throw new Error('ZIP64 archives are not supported');

    const entries: ZipEntry[] = [];
    for (let i = 0; i < count; i++) {
      if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt central directory');
      const nameLength = buffer.readUInt16LE(offset + 28);
      const extraLength = buffer.readUInt16LE(offset + 30);
      const commentLength = buffer.readUInt16LE(offset + 32);
      entries.push({
        method: buffer.readUInt16LE(offset + 10),
        compressedSize: buffer.readUInt32LE(offset + 20),
        uncompressedSize: buffer.readUInt32LE(offset + 24),
        localHeaderOffset: buffer.readUInt32LE(offset + 42),
        name: buffer.toString('utf8', offset + 46, offset + 46 + nameLength),
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  read(name: string): Buffer {
    const entry = this.entries.find((e) => e.name === name);
    if (!entry) throw new Error(`entry not found: ${name}`);
    if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`entry too large: ${name}`);
    const header = entry.localHeaderOffset;
    if (this.buffer.readUInt32LE(header) !== 0x04034b50) throw new Error('corrupt local header');
    const start = header + 30 + this.buffer.readUInt16LE(header + 26) + this.buffer.readUInt16LE(header + 28);
    const data = this.buffer.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return Buffer.from(data);
    if (entry.method === 8) return inflateRawSync(data);
    throw new Error(`unsupported compression method ${entry.method}`);
  }
}

export interface TraceAction {
  title: string;
  durationMs?: number;
  error?: string;
}

export interface TraceMetadata {
  file: string;
  sizeBytes: number;
  entryCount: number;
  resourceCount: number;
  screenshotCount: number;
  browserName?: string;
  platform?: string;
  playwrightVersion?: string;
  actions: TraceAction[];
  failedActions: TraceAction[];
  showTraceCommand: string;
}

/** Extracts a compact, LLM-friendly summary of a Playwright trace archive. */
export async function readTraceMetadata(file: string, maxActions = 150): Promise<TraceMetadata> {
  const zip = await ZipReader.open(file);
  const starts = new Map<string, { title: string; startTime?: number }>();
  const actions: TraceAction[] = [];
  const meta: Partial<TraceMetadata> = {};

  for (const entry of zip.entries.filter((e) => e.name.endsWith('.trace'))) {
    for (const line of zip.read(entry.name).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.type === 'context-options') {
        if (typeof event.browserName === 'string' && event.browserName) meta.browserName = event.browserName;
        if (typeof event.platform === 'string') meta.platform = event.platform;
        if (typeof event.playwrightVersion === 'string') meta.playwrightVersion = event.playwrightVersion;
      } else if (event.type === 'before' && typeof event.callId === 'string') {
        const title =
          (typeof event.title === 'string' && event.title) ||
          (typeof event.apiName === 'string' && event.apiName) ||
          `${typeof event.class === 'string' ? event.class : ''}.${typeof event.method === 'string' ? event.method : ''}`;
        starts.set(event.callId, {
          title,
          ...(typeof event.startTime === 'number' ? { startTime: event.startTime } : {}),
        });
      } else if (event.type === 'after' && typeof event.callId === 'string') {
        const start = starts.get(event.callId);
        if (!start) continue;
        const error = (event.error as { message?: string } | undefined)?.message;
        actions.push({
          title: start.title,
          ...(typeof event.endTime === 'number' && start.startTime !== undefined
            ? { durationMs: Math.round(event.endTime - start.startTime) }
            : {}),
          ...(error ? { error: error.split('\n')[0] } : {}),
        });
      }
    }
  }

  const stat = (await readFile(file)).length;
  return {
    file,
    sizeBytes: stat,
    entryCount: zip.entries.length,
    resourceCount: zip.entries.filter((e) => e.name.startsWith('resources/')).length,
    screenshotCount: zip.entries.filter((e) => /\.(jpe?g|png)$/i.test(e.name)).length,
    ...meta,
    actions: actions.slice(-maxActions),
    failedActions: actions.filter((a) => a.error),
    showTraceCommand: `npx playwright show-trace "${file}"`,
  };
}
