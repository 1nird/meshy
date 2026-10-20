// Decodes .meshy files into plain GLB using Meshy's loader. All further
// processing (GLB rewrite, OBJ/MTL, STL, ZIP) happens in the popup.

let modulePromise;

function signature(hostname, timestamp) {
  let hash = BigInt("14695981039346656037");
  const prime = BigInt("1099511628211");
  const mask = BigInt("0xFFFFFFFFFFFFFFFF");

  function mix(text) {
    for (let i = 0; i < text.length; i++) {
      hash ^= BigInt(text.charCodeAt(i));
      hash = (hash * prime) & mask;
    }
  }

  mix("Meshy_Crypto_Key");
  mix(`${hostname}:${timestamp}`);
  hash ^= hash >> 33n;
  hash = (hash * BigInt("0xff51afd7ed558ccd")) & mask;
  hash ^= hash >> 33n;
  hash = (hash * BigInt("0xc4ceb9fe1a85ec53")) & mask;
  hash ^= hash >> 33n;
  return hash.toString(16).padStart(16, "0");
}

async function getMeshyModule() {
  if (!modulePromise) {
    modulePromise = import("./vendor/mesh_loader.js").catch((error) => {
      throw new Error(`Decoder files are missing or could not be loaded. Run setup-vendor.ps1, then reload the extension. Details: ${error.message}`);
    }).then(({ default: Module }) => Module({
      locateFile: (path) => new URL(`./vendor/${path}`, location.href).href,
      printErr: () => {},
    })).catch((error) => {
      if (String(error.message || error).includes("mesh_loader.wasm")) {
        throw new Error(`Decoder files are missing or could not be loaded. Run setup-vendor.ps1, then reload the extension. Details: ${error.message}`);
      }
      throw error;
    }).then((mod) => {
      const hostname = "www.meshy.ai";
      const timestamp = Date.now();
      if (!mod.authorize(hostname, timestamp, signature(hostname, timestamp))) {
        throw new Error("Could not authorize the Meshy decoder.");
      }
      return mod;
    });
  }
  return modulePromise;
}

async function decodeMeshy(buffer) {
  const mod = await getMeshyModule();
  const result = mod.processMeshyFile(new Uint8Array(buffer));
  if (!result?.success) throw new Error(result?.error || "Failed to decode .meshy.");
  if (result.data instanceof Uint8Array) {
    return result.data.buffer.slice(result.data.byteOffset, result.data.byteOffset + result.data.byteLength);
  }
  if (result.data instanceof ArrayBuffer) return result.data;
  throw new Error("The decoder returned an unexpected data type.");
}

window.addEventListener("message", async (event) => {
  if (event.data?.type !== "convert") return;
  try {
    const glb = await decodeMeshy(event.data.buffer);
    event.source.postMessage({ id: event.data.id, ok: true, output: glb }, event.origin, [glb]);
  } catch (error) {
    event.source.postMessage({ id: event.data.id, ok: false, error: error.message }, event.origin);
  }
});
