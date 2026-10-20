/* Rebuild a GLB for Roblox Studio:
 *  - WebP -> PNG images (already converted by convert-webp.py)
 *  - bake KHR_texture_transform (offset/scale) into TEXCOORD_0
 *  - plain texture refs (no EXT_texture_webp)
 *  - drop metallicRoughnessTexture (Roblox SurfaceAppearance has no slot)
 *  - no extensionsUsed / extensionsRequired
 * Usage: node rebuild-glb.js <src.glb> <pngDir> <out.glb>
 */
const fs = require("fs");
const path = require("path");
const MeshyGltfUtils = require("../chrome-extension/gltf-utils");

const [src, pngDir, out] = process.argv.slice(2);
const { json: j, bin } = MeshyGltfUtils.parseGlb(new Uint8Array(fs.readFileSync(src)).buffer);

const align4 = (v) => (v + 3) & ~3;

// --- 1. Bake the texture transform into TEXCOORD_0 -------------------------
const mat = (j.meshes && j.meshes[0] && j.meshes[0].primitives[0].material != null)
  ? j.materials[j.meshes[0].primitives[0].material] : null;
let tf = null;
if (mat) {
  tf = (mat.pbrMetallicRoughness && mat.pbrMetallicRoughness.baseColorTexture
    && mat.pbrMetallicRoughness.baseColorTexture.extensions
    && mat.pbrMetallicRoughness.baseColorTexture.extensions.KHR_texture_transform)
    || (mat.normalTexture && mat.normalTexture.extensions && mat.normalTexture.extensions.KHR_texture_transform)
    || null;
}
if (tf) {
  const prim = j.meshes[0].primitives[0];
  const accIdx = prim.attributes.TEXCOORD_0;
  if (accIdx != null) {
    const acc = j.accessors[accIdx];
    const bv = j.bufferViews[acc.bufferView];
    const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const n = acc.count;
    const scaleX = tf.scale ? tf.scale[0] : 1;
    const scaleY = tf.scale ? tf.scale[1] : 1;
    const offX = tf.offset ? tf.offset[0] : 0;
    const offY = tf.offset ? tf.offset[1] : 0;
    const dv = new DataView(bin.buffer, bin.byteOffset + start, n * 8);
    let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
    for (let i = 0; i < n; i++) {
      const u = dv.getFloat32(i * 8, true) * scaleX + offX;
      const v = dv.getFloat32(i * 8 + 4, true) * scaleY + offY;
      dv.setFloat32(i * 8, u, true);
      dv.setFloat32(i * 8 + 4, v, true);
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    if (acc.min) acc.min = [minU, minV];
    if (acc.max) acc.max = [maxU, maxV];
    console.log(`baked transform scale=(${scaleX},${scaleY}) offset=(${offX},${offY}) into ${n} UVs -> u[${minU.toFixed(3)},${maxU.toFixed(3)}] v[${minV.toFixed(3)},${maxV.toFixed(3)}]`);
  }
} else {
  console.log("no KHR_texture_transform found, UVs untouched");
}

// --- 2. Assemble a new BIN chunk: geometry bufferViews, then PNGs ---------
const imageBvs = new Set((j.images || []).map((im) => im.bufferView));
const pngFiles = (j.images || []).map((im, i) => path.join(pngDir, `img${i}.png`));
const segments = []; // { data: Buffer, isImage: bool, imageIndex: int }
j.bufferViews.forEach((bv, i) => {
  if (imageBvs.has(i)) return;
  segments.push({ data: Buffer.from(bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength)), isImage: false, bvIndex: i });
});
(j.images || []).forEach((im, i) => {
  segments.push({ data: fs.readFileSync(pngFiles[i]), isImage: true, imageIndex: i, bvIndex: im.bufferView });
});

let pos = 0;
const newBinParts = [];
for (const seg of segments) {
  const aligned = align4(pos);
  if (aligned > pos) newBinParts.push(Buffer.alloc(aligned - pos));
  seg.newOffset = aligned;
  newBinParts.push(seg.data);
  pos = aligned + seg.data.length;
}
const newBin = Buffer.concat(newBinParts);

// Update bufferView offsets/lengths in place (same indices as before).
for (const seg of segments) {
  const bv = j.bufferViews[seg.bvIndex];
  bv.byteOffset = seg.newOffset;
  bv.byteLength = seg.data.length;
  if (seg.isImage && bv.target !== undefined) delete bv.target;
}
j.buffers[0].byteLength = newBin.length;

// --- 3. Plain texture refs, PNG images, simplified material ---------------
j.textures = (j.textures || []).map((t) => ({
  source: t.extensions && t.extensions.EXT_texture_webp ? t.extensions.EXT_texture_webp.source : t.source,
  sampler: t.sampler !== undefined ? t.sampler : 0,
}));
j.images = (j.images || []).map((im, i) => ({ bufferView: im.bufferView, mimeType: "image/png", name: im.name || `img${i}` }));

for (const m of j.materials || []) {
  const pbr = m.pbrMetallicRoughness;
  if (pbr) {
    if (pbr.baseColorTexture && pbr.baseColorTexture.extensions) {
      const clean = { index: pbr.baseColorTexture.index };
      if (pbr.baseColorTexture.texCoord) clean.texCoord = pbr.baseColorTexture.texCoord;
      pbr.baseColorTexture = clean;
    }
    if (pbr.metallicRoughnessTexture) delete pbr.metallicRoughnessTexture; // no Roblox slot
    if (pbr.baseColorFactor === undefined) pbr.baseColorFactor = [1, 1, 1, 1];
  }
  if (m.normalTexture && m.normalTexture.extensions) {
    const clean = { index: m.normalTexture.index };
    if (m.normalTexture.texCoord) clean.texCoord = m.normalTexture.texCoord;
    m.normalTexture = clean;
  }
}
delete j.extensionsUsed;
delete j.extensionsRequired;
if (j.asset) j.asset.generator = "roblox-glbfix (webp->png, uv baked)";

// --- 4. Rebuild and write --------------------------------------------------
const fixed = MeshyGltfUtils.buildGlb(j, newBin);
fs.writeFileSync(out, Buffer.from(fixed));
console.log("wrote", out, fs.statSync(out).size, "bytes");
