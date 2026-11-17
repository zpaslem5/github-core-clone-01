// Git wire helpers: pkt-line framing and packfile read/write (SHA-1, no deltas on write).
import { inflateSync, deflateSync, createInflate } from 'node:zlib';
import { sha1Hex, hashObject, type GitObjectType } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Encode one pkt-line. `null` encodes a flush (0000). */
export function pktLine(data: string | Buffer | null): Buffer {
  if (data === null) return Buffer.from('0000', 'ascii');
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

/** A flush packet. */
export const pktFlush: Buffer = Buffer.from('0000', 'ascii');
/** A delim packet. */
export const pktDelim: Buffer = Buffer.from('0001', 'ascii');

/** Decode pkt-lines from a buffer. Returns lines (payloads) and the byte offset where the
 *  trailing non-pkt-line data (a packfile) begins. A line payload is a string; flush/delim
 *  are returned as null with a marker. */
export interface PktLine {
  kind: 'data' | 'flush' | 'delim' | 'end';
  text: string;
}

export function decodePktLines(buf: Buffer): { lines: PktLine[]; restOffset: number } {
  const lines: PktLine[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const header = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const len = parseInt(header, 16);
    if (len === 0) {
      lines.push({ kind: 'flush', text: '' });
      i += 4;
      continue;
    }
    if (len === 1) {
      lines.push({ kind: 'delim', text: '' });
      i += 4;
      continue;
    }
    if (len === 2) {
      lines.push({ kind: 'end', text: '' });
      i += 4;
      continue;
    }
    if (len < 4 || i + len > buf.length) break;
    const payload = buf.subarray(i + 4, i + len);
    lines.push({ kind: 'data', text: payload.toString('utf8') });
    i += len;
  }
  return { lines, restOffset: i };
}

/** A sideband packet: band byte (1 data, 2 progress, 3 error) + payload, pkt-line framed. */
export function sidebandPacket(band: 1 | 2 | 3, payload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from([band]), payload]);
  return pktLine(body);
}

/** Split a sideband-framed buffer into the raw pack bytes (band 1) plus plain text lines. */
export function demuxSideband(buf: Buffer): { pack: Buffer; texts: string[] } {
  const packParts: Buffer[] = [];
  const texts: string[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const header = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const len = parseInt(header, 16);
    if (len === 0 || len < 4 || i + len > buf.length) break;
    const payload = buf.subarray(i + 4, i + len);
    if (payload.length === 0) break;
    const band = payload[0] as number;
    if (band === 1) packParts.push(Buffer.from(payload.subarray(1)));
    else if (band === 2 || band === 3) texts.push(payload.subarray(1).toString('utf8'));
    else texts.push(payload.toString('utf8'));
    i += len;
  }
  return { pack: Buffer.concat(packParts), texts };
}

// ---------------------------------------------------------------- packfile

export interface PackEntry {
  type: GitObjectType;
  data: Buffer;
}

const PACK_TYPE_IDS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_ID_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Write a packfile (version 2, full objects, no deltas). */
export function writePack(entries: PackEntry[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const entry of entries) {
    const typeId = PACK_TYPE_IDS[entry.type];
    const size = entry.data.length;
    // varint header: first byte holds 4 size bits + type in bits 4-6, continuation bit 7.
    const head: number[] = [];
    let s = size;
    let first = (typeId << 4) | (s & 0x0f);
    s >>= 4;
    if (s > 0) first |= 0x80;
    head.push(first);
    while (s > 0) {
      let b = s & 0x7f;
      s >>= 7;
      if (s > 0) b |= 0x80;
      head.push(b);
    }
    parts.push(Buffer.from(head));
    parts.push(deflateSync(entry.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

function readVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = pos;
  while (i < buf.length) {
    const b = buf[i] as number;
    value |= (b & 0x7f) << shift;
    shift += 7;
    i += 1;
    if ((b & 0x80) === 0) break;
  }
  return { value, next: i };
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const src = readVarint(delta, pos);
  pos = src.next;
  const tgt = readVarint(delta, pos);
  pos = tgt.next;
  if (src.value !== base.length) throw new Error('delta source size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if (op === 0) throw new Error('delta opcode 0');
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          offset |= (delta[pos] as number) << (bit * 8);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          size |= (delta[pos] as number) << (bit * 8);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else {
      const size = op;
      out.push(delta.subarray(pos, pos + size));
      outLen += size;
      pos += size;
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== tgt.value || outLen !== tgt.value) throw new Error('delta target size mismatch');
  return result;
}

export interface ReadPackResult {
  entries: PackEntry[];
  count: number;
}

/** Read a packfile (full objects and OFS/REF deltas). Returns entries in pack order. */
export function readPack(buf: Buffer): ReadPackResult {
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const expect = sha1Hex(buf.subarray(0, buf.length - 20));
  if (trailer.toString('hex') !== expect) throw new Error('pack checksum mismatch');
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  const bySha = new Map<string, PackEntry>();
  let pos = 12;
  for (let n = 0; n < count; n += 1) {
    const entryStart = pos;
    let b = buf[pos] as number;
    pos += 1;
    const typeId = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while ((b & 0x80) !== 0) {
      b = buf[pos] as number;
      pos += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let type: GitObjectType | null = PACK_ID_TYPES[typeId] ?? null;
    let data: Buffer;
    if (typeId === 6) {
      // OFS_DELTA: offset varint (negative offset from this entry's start).
      let ofs = buf[pos] as number;
      pos += 1;
      let offset = ofs & 0x7f;
      while ((ofs & 0x80) !== 0) {
        ofs = buf[pos] as number;
        pos += 1;
        offset = ((offset + 1) << 7) | (ofs & 0x7f);
      }
      const base = byOffset.get(entryStart - offset);
      if (base === undefined) throw new Error('ofs-delta base missing');
      const inflated = inflateAt(buf, pos);
      pos = inflated.next;
      data = applyDelta(base.data, inflated.data);
      type = base.type;
    } else if (typeId === 7) {
      const baseSha = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const base = bySha.get(baseSha);
      if (base === undefined) throw new Error('ref-delta base missing');
      const { data: raw, next } = inflateAt(buf, pos);
      pos = next;
      data = applyDelta(base.data, raw);
      type = base.type;
    } else {
      if (type === null) throw new Error(`unknown pack type ${typeId}`);
      const inflated = inflateAt(buf, pos);
      pos = inflated.next;
      data = inflated.data;
      if (data.length !== size) throw new Error('pack object size mismatch');
    }
    const entry: PackEntry = { type: type as GitObjectType, data };
    entries.push(entry);
    byOffset.set(entryStart, entry);
    bySha.set(hashObject(entry.type, entry.data), entry);
  }
  return { entries, count };
}

// Inflate one zlib stream starting at `pos`, returning the data and the offset just past the stream.
// inflateSync tolerates trailing bytes (it returns the first stream's output), so success is
// monotonic in the slice end: binary-search the smallest end offset that inflates.
export function inflateAt(buf: Buffer, pos: number): { data: Buffer; next: number } {
  const trySlice = (end: number): Buffer | null => {
    try {
      return inflateSync(buf.subarray(pos, end));
    } catch {
      return null;
    }
  };
  let lo = pos + 1;
  let hi = buf.length;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (trySlice(mid) !== null) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (found === null) throw new Error('cannot inflate pack entry');
  return { data: trySlice(found) as Buffer, next: found };
}

/** Async inflate of one stream: a single Inflate stream reports exactly how many input
 *  bytes it consumed (bytesWritten stops at the stream end), so this is one inflate
 *  per entry instead of a binary search. */
export function inflateAtAsync(buf: Buffer, pos: number): Promise<{ data: Buffer; next: number }> {
  return new Promise((resolve, reject) => {
    const infl = createInflate();
    const chunks: Buffer[] = [];
    infl.on('data', (c: Buffer) => chunks.push(c));
    infl.on('error', reject);
    infl.on('end', () => {
      resolve({
        data: Buffer.concat(chunks),
        next: pos + (infl as unknown as { bytesWritten: number }).bytesWritten,
      });
    });
    infl.write(buf.subarray(pos));
    infl.end();
  });
}

/** Async version of readPack using inflateAtAsync (same result, fewer inflations). */
export async function readPackAsync(buf: Buffer): Promise<ReadPackResult> {
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const expect = sha1Hex(buf.subarray(0, buf.length - 20));
  if (trailer.toString('hex') !== expect) throw new Error('pack checksum mismatch');
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  const bySha = new Map<string, PackEntry>();
  let pos = 12;
  for (let n = 0; n < count; n += 1) {
    const entryStart = pos;
    let b = buf[pos] as number;
    pos += 1;
    const typeId = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while ((b & 0x80) !== 0) {
      b = buf[pos] as number;
      pos += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let type: GitObjectType | null = PACK_ID_TYPES[typeId] ?? null;
    let data: Buffer;
    if (typeId === 6) {
      let ofs = buf[pos] as number;
      pos += 1;
      let offset = ofs & 0x7f;
      while ((ofs & 0x80) !== 0) {
        ofs = buf[pos] as number;
        pos += 1;
        offset = ((offset + 1) << 7) | (ofs & 0x7f);
      }
      const base = byOffset.get(entryStart - offset);
      if (base === undefined) throw new Error('ofs-delta base missing');
      const inflated = await inflateAtAsync(buf, pos);
      pos = inflated.next;
      data = applyDelta(base.data, inflated.data);
      type = base.type;
    } else if (typeId === 7) {
      const baseSha = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const base = bySha.get(baseSha);
      if (base === undefined) throw new Error('ref-delta base missing');
      const inflated = await inflateAtAsync(buf, pos);
      pos = inflated.next;
      data = applyDelta(base.data, inflated.data);
      type = base.type;
    } else {
      if (type === null) throw new Error(`unknown pack type ${typeId}`);
      const inflated = await inflateAtAsync(buf, pos);
      pos = inflated.next;
      data = inflated.data;
      if (data.length !== size) throw new Error('pack object size mismatch');
    }
    const entry: PackEntry = { type: type as GitObjectType, data };
    entries.push(entry);
    byOffset.set(entryStart, entry);
    bySha.set(hashObject(entry.type, entry.data), entry);
  }
  return { entries, count };
}
