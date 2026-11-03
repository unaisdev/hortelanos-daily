// Descarga ROM + núcleo mGBA una vez por pack y los cachea en memoria.

const CORE = {
  coreJs: new URL('./vendor/mgba_libretro.js', import.meta.url).href,
  coreWasm: new URL('./vendor/mgba_libretro.wasm', import.meta.url).href,
};

const cache = new Map();

/** packBaseUrl: absolute or root-relative folder of the game pack (…/games/dailygold) */
export function loadGameFiles(packBaseUrl, romRelPath, onProgress = () => {}) {
  const base = packBaseUrl.endsWith('/') ? packBaseUrl : `${packBaseUrl}/`;
  const key = `${base}${romRelPath}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      download(base, romRelPath, onProgress).catch((err) => {
        cache.delete(key);
        throw err;
      }),
    );
  }
  return cache.get(key);
}

async function download(base, romRelPath, onProgress) {
  const urls = {
    rom: new URL(romRelPath, base).href,
    coreJs: CORE.coreJs,
    coreWasm: CORE.coreWasm,
  };
  const responses = await Promise.all(
    Object.values(urls).map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`No se pudo descargar ${url} (HTTP ${res.status}).`);
      return res;
    }),
  );

  const sizes = responses.map((r) =>
    (r.headers.get('Content-Encoding') ? 0 : Number(r.headers.get('Content-Length')) || 0));
  const total = sizes.every(Boolean) ? sizes.reduce((a, b) => a + b, 0) : 0;
  let loaded = 0;
  const report = (n) => {
    loaded += n;
    onProgress(loaded, total);
  };

  const [romGz, coreJs, coreWasm] = await Promise.all(responses.map((res) => readAll(res, report)));
  return {
    rom: await gunzip(romGz),
    coreJs: new Blob([coreJs], { type: 'text/javascript' }),
    coreWasm: new Blob([coreWasm], { type: 'application/wasm' }),
  };
}

async function readAll(res, report) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    report(value.length);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function gunzip(bytes) {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
