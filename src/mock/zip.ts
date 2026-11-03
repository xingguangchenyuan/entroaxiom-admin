/**
 * 开发替身用的极简 ZIP 读写。
 *
 * 为什么自己写：替身只在 dev 里跑，为它引入 jszip 之类的依赖不值得；
 * 而“导入 zip”和“导出 zip”两个流程恰恰需要真的读写 zip 才能试出手感。
 *
 * 写：只用 STORED（不压缩）——体积不重要，重要的是能被任何解压工具打开。
 * 读：扫描本地文件头；deflate 的条目用浏览器自带的 DecompressionStream 解压。
 * 局限：流式写入（数据描述符）的条目读不了，遇到就跳过并记一条警告。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInput {
  /** 包内路径，用正斜杠 */
  path: string;
  data: Uint8Array;
}

/** 打包成 STORED 模式的 zip */
export function createZip(entries: ZipEntryInput[]): Blob {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const now = new Date();
  const dosTime =
    (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate =
    ((now.getFullYear() - 1980) << 9) |
    ((now.getMonth() + 1) << 5) |
    now.getDate();

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // 需要的版本
    lv.setUint16(6, 0, true); // 标志位
    lv.setUint16(8, 0, true); // 压缩方式：0=STORED
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, entry.data.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    chunks.push(local, entry.data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + entry.data.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, end] as BlobPart[], {
    type: "application/zip"
  });
}

export interface ZipEntryOutput {
  path: string;
  data: Uint8Array;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 读 zip：顺序扫描本地文件头。
 * 返回读到的条目和没能读到的路径名，调用方据此给站长提示。
 */
export async function readZip(
  buffer: ArrayBuffer
): Promise<{ entries: ZipEntryOutput[]; skipped: string[] }> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();
  const entries: ZipEntryOutput[] = [];
  const skipped: string[] = [];
  let offset = 0;

  while (offset + 30 <= bytes.length) {
    if (view.getUint32(offset, true) !== 0x04034b50) break;
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;

    // 数据描述符（bit 3）表示长度写在数据之后，这里不猜
    if (flags & 0x08 || compressedSize === 0) {
      skipped.push(name);
      // 长度未知，无法继续往下扫描
      break;
    }

    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    try {
      if (method === 0) {
        entries.push({ path: name, data: raw.slice() });
      } else if (method === 8) {
        entries.push({ path: name, data: await inflateRaw(raw) });
      } else {
        skipped.push(name);
      }
    } catch {
      skipped.push(name);
    }
    offset = dataStart + compressedSize;
  }

  return {
    entries: entries.filter(entry => !entry.path.endsWith("/")),
    skipped
  };
}
