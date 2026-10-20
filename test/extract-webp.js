/* Extract embedded images + texture/UV metadata from a GLB. Usage: node extract-webp.js <glb> <outDir> */
const fs = require("fs");
const path = require("path");
const src = process.argv[2];
const outDir = process.argv[3];
fs.mkdirSync(outDir, { recursive: true });
const buf = fs.readFileSync(src);
const jsonLen = buf.readUInt32LE(12);
const j = JSON.parse(buf.slice(20, 20 + jsonLen).toString("utf8"));
const binOff = 20 + jsonLen + 8;
console.log("samplers:", JSON.stringify(j.samplers || []));
(j.images || []).forEach((img, i) => {
  const bv = j.bufferViews[img.bufferView];
  const bytes = buf.slice(binOff + bv.byteOffset, binOff + bv.byteOffset + bv.byteLength);
  const ext = (img.mimeType || "image/webp").split("/")[1];
  const file = path.join(outDir, `img${i}.${ext}`);
  fs.writeFileSync(file, bytes);
  console.log(`image[${i}] name=${img.name} mimeType=${img.mimeType} bytes=${bytes.length} -> ${file}`);
});
(j.meshes || []).forEach((m, mi) => (m.primitives || []).forEach((prim, pi) => {
  const tc = prim.attributes.TEXCOORD_0;
  if (tc != null) {
    const acc = j.accessors[tc];
    console.log(`mesh[${mi}].prim[${pi}] TEXCOORD_0 accessor=${tc} count=${acc.count} componentType=${acc.componentType} type=${acc.type} bufferView=${acc.bufferView}`);
  }
}));
fs.writeFileSync(path.join(outDir, "gltf.json"), JSON.stringify(j, null, 2));
console.log("wrote gltf.json");
