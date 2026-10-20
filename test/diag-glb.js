/* Offline GLB diagnostic — dump the glTF JSON chunk summary. */
const fs = require("fs");
const p = process.argv[2] || "C:/Users/nirde/Music/WolverineInBackrooms/wolverine2.glb";
const buf = fs.readFileSync(p);
console.log("file:", p);
console.log("file bytes:", buf.length);
console.log("GLB magic ok:", buf.readUInt32LE(0) === 0x46546c67);
let off = 12, chunkIndex = 0, gltf = null, bin = null;
while (off + 8 <= buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  const data = buf.slice(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) gltf = JSON.parse(data.toString("utf8"));
  if (type === 0x004e4942) bin = data;
  console.log("chunk", chunkIndex, "type", type.toString(16), "len", len);
  off += 8 + len;
  chunkIndex++;
}
const j = gltf || {};
console.log("generator:", j.asset && j.asset.generator, "| glTF version:", j.asset && j.asset.version);
const sum = (k) => (j[k] || []).length;
console.log("counts: scenes", sum("scenes"), "nodes", sum("nodes"), "meshes", sum("meshes"),
  "materials", sum("materials"), "textures", sum("textures"), "images", sum("images"),
  "accessors", sum("accessors"), "bufferViews", sum("bufferViews"), "buffers", sum("buffers"),
  "skins", sum("skins"), "animations", sum("animations"));
console.log("buffers:", JSON.stringify(j.buffers));
console.log("images:", JSON.stringify(j.images, null, 2));
console.log("textures:", JSON.stringify(j.textures));
console.log("materials:", JSON.stringify(j.materials, null, 2).slice(0, 5000));
let tris = 0;
(j.meshes || []).forEach((m) => (m.primitives || []).forEach((prim) => {
  const posAcc = j.accessors[prim.attributes.POSITION];
  tris += prim.indices != null ? Math.floor(j.accessors[prim.indices].count / 3) : Math.floor((posAcc ? posAcc.count : 0) / 3);
}));
console.log("total triangles:", tris);
console.log("extensionsUsed:", JSON.stringify(j.extensionsUsed));
console.log("extensionsRequired:", JSON.stringify(j.extensionsRequired));
console.log("BIN chunk bytes:", bin ? bin.length : "none");
