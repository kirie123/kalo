/**
 * Minimal ZIP reader, enough to open the OOXML containers (`.docx`, `.xlsx`)
 * that the file preview renders.
 *
 * Hand-rolled rather than pulled from npm: the app ships offline-installable
 * and a preview feature is not worth a dependency. Inflate comes from the
 * platform's `DecompressionStream("deflate-raw")`, so there is no bundled
 * codec either.
 *
 * Deliberately partial — a *reader* for well-formed archives written by Word
 * and Excel, not a general ZIP implementation:
 *   - central directory only (the local headers are used just to locate data),
 *   - store (0) and deflate (8); anything else throws by name,
 *   - no ZIP64, no encryption, no multi-disk, no CRC verification.
 * Every unsupported case throws with a message the preview can show as-is.
 */

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** EOCD is 22 bytes plus a comment of at most 64 KB. */
const EOCD_MAX_SEARCH = 22 + 0xffff;

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Offset of this entry's local file header. */
  localOffset: number;
}

export class ZipArchive {
  private readonly bytes: Uint8Array;
  private readonly entries: Map<string, ZipEntry>;

  constructor(bytes: Uint8Array, entries: Map<string, ZipEntry>) {
    this.bytes = bytes;
    this.entries = entries;
  }

  get names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** First entry whose name matches, in central-directory order. */
  find(pred: (name: string) => boolean): string | undefined {
    return this.names.find(pred);
  }

  async bytesOf(name: string): Promise<Uint8Array> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`压缩包内缺少 ${name}`);
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    if (entry.localOffset + 30 > this.bytes.length) throw new Error("压缩包已损坏（局部头越界）");
    if (view.getUint32(entry.localOffset, true) !== LOCAL_SIG) {
      throw new Error("压缩包已损坏（局部头签名不符）");
    }
    // The local header repeats the name/extra lengths, and they may differ
    // from the central directory's, so the data offset must come from here.
    const nameLen = view.getUint16(entry.localOffset + 26, true);
    const extraLen = view.getUint16(entry.localOffset + 28, true);
    const start = entry.localOffset + 30 + nameLen + extraLen;
    const end = start + entry.compressedSize;
    if (end > this.bytes.length) throw new Error("压缩包已损坏（数据越界）");
    const raw = this.bytes.subarray(start, end);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateRaw(raw);
    throw new Error(`不支持的压缩方式（method ${entry.method}）`);
  }

  async textOf(name: string): Promise<string> {
    return new TextDecoder("utf-8").decode(await this.bytesOf(name));
  }
}

/** Parse the central directory. Throws on anything this reader cannot handle. */
export function openZip(bytes: Uint8Array): ZipArchive {
  if (bytes.length < 22) throw new Error("不是有效的压缩包（文件过小）");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Scan backwards for the EOCD signature. Starting from the end (rather than
  // at length-22) matters because the comment field is variable-length.
  const floor = Math.max(0, bytes.length - EOCD_MAX_SEARCH);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的压缩包（找不到目录结尾）");

  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new Error("不支持 ZIP64 压缩包");
  }
  if (cdOffset >= bytes.length) throw new Error("压缩包已损坏（目录偏移越界）");

  const entries = new Map<string, ZipEntry>();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length) throw new Error("压缩包已损坏（目录项越界）");
    if (view.getUint32(p, true) !== CENTRAL_SIG) throw new Error("压缩包已损坏（目录项签名不符）");
    const flags = view.getUint16(p + 8, true);
    // Bit 0 = encrypted. Fail loudly: a password-protected document would
    // otherwise inflate into garbage.
    if (flags & 0x1) throw new Error("压缩包已加密，无法预览");
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("不支持 ZIP64 压缩包");
    }
    const nameStart = p + 46;
    // Bit 11 = the name is UTF-8. Word and Excel set it for non-ASCII names;
    // legacy names are CP437, but UTF-8 decoding of ASCII is identical and
    // OOXML part names inside these containers are ASCII anyway.
    const name = new TextDecoder("utf-8").decode(bytes.subarray(nameStart, nameStart + nameLen));
    entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
    p = nameStart + nameLen + extraLen + commentLen;
  }
  return new ZipArchive(bytes, entries);
}

/** Raw-deflate inflate via the platform codec. */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("当前运行环境不支持解压（缺少 DecompressionStream）");
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}
