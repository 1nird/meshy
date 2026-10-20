/*
 * Offline test harness for chrome-extension/gltf-utils.js.
 * Builds a synthetic textured GLB in memory, embeds external resources,
 * and verifies the GLB / OBJ+MTL / STL / ZIP outputs.
 * Run: node test/gltf-utils.test.js
 */
const fs = require("fs");
const path = require("path");
const MeshyGltfUtils = require("../chrome-extension/gltf-utils");

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------- fixtures

// Minimal valid 1x1 red PNG.
const redPng = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108020000009077" +
    "53de0000000c4944415408d763f8cfc00000030101" +
    "00cf8ff1ea0000000049454e44ae426082",
  "hex"
);

function buildTexturedGlb({ externalTextureUri }) {
  // Geometry: one triangle, positions + UVs + indices, identity node.
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  const indices = new Uint16Array([0, 1, 2]);

  const parts = [
    { bytes: new Uint8Array(positions.buffer), length: positions.byteLength },
    { bytes: new Uint8Array(uvs.buffer), length: uvs.byteLength },
    { bytes: new Uint8Array(indices.buffer), length: indices.byteLength },
  ];
  const binParts = [];
  let offset = 0;
  for (const part of parts) {
    binParts.push(part.bytes);
    offset += part.length;
  }
  const bin = new Uint8Array(offset);
  offset = 0;
  for (const part of binParts) {
    bin.set(part, offset);
    offset += part.length;
  }

  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "Tri" }],
    meshes: [{ name: "TriMesh", primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    materials: [
      {
        name: "Red Mat",
        pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], baseColorTexture: { index: 0 } },
      },
    ],
    textures: [{ source: 0 }],
    images: [externalTextureUri ? { uri: externalTextureUri } : { bufferView: 3, mimeType: "image/png" }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC2" },
      { bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 24 },
      { buffer: 0, byteOffset: 60, byteLength: 6 },
    ],
  };

  if (externalTextureUri) {
    // External textures mean the GLB carries no image bytes; BIN has only geometry.
    return MeshyGltfUtils.buildGlb(json, bin);
  }

  // Inline-texture variant: append the PNG as bufferView 3.
  const withImage = new Uint8Array(bin.length + redPng.length);
  withImage.set(bin, 0);
  withImage.set(redPng, bin.length);
  json.bufferViews[3] = { buffer: 0, byteOffset: bin.length, byteLength: redPng.length };
  json.images[0] = { bufferView: 3, mimeType: "image/png" };
  return MeshyGltfUtils.buildGlb(json, withImage);
}

// ------------------------------------------------------------------ tests

async function run() {
  const outDir = path.join(__dirname, "out");
  fs.mkdirSync(outDir, { recursive: true });

  // 1. GLB with inline texture round-trips.
  console.log("GLB round-trip:");
  const inlineGlb = buildTexturedGlb({});
  const parsedInline = MeshyGltfUtils.parseGlb(inlineGlb);
  check("parse keeps image bufferView", parsedInline.json.images[0].bufferView === 3);
  const rebuilt = MeshyGltfUtils.buildGlb(parsedInline.json, parsedInline.bin);
  check("rebuilt GLB parses identically", MeshyGltfUtils.parseGlb(rebuilt).json.images[0].bufferView === 3);

  // 2. Embedding an external http texture downloads it and rewrites images.
  console.log("External texture embedding:");
  const externalGlb = buildTexturedGlb({ externalTextureUri: "https://cdn.example.test/tex/red.png" });
  const parsedExternal = MeshyGltfUtils.parseGlb(externalGlb);
  const fakeFetch = async (url) => {
    check("fetch called with resolved texture URL", url === "https://cdn.example.test/tex/red.png", url);
    return redPng.buffer.slice(redPng.byteOffset, redPng.byteOffset + redPng.byteLength);
  };
  const embedded = await MeshyGltfUtils.embedExternalResources(parsedExternal.json, parsedExternal.bin, { fetchBinary: fakeFetch });
  check("one texture embedded", embedded.embeddedTextures === 1, String(embedded.embeddedTextures));
  check("no image URIs remain", embedded.json.images.every((image) => image.uri === undefined));
  check("image now uses bufferView", embedded.json.images[0].bufferView !== undefined);
  check("image mime detected", embedded.json.images[0].mimeType === "image/png");
  check("single merged buffer", embedded.json.buffers.length === 1);
  check("no warnings", embedded.warnings.length === 0, embedded.warnings.join("; "));

  const embeddedGlb = MeshyGltfUtils.buildGlb(embedded.json, embedded.bin);
  fs.writeFileSync(path.join(outDir, "embedded.glb"), Buffer.from(embeddedGlb));
  const reparsed = MeshyGltfUtils.parseGlb(embeddedGlb);
  const imageView = reparsed.json.bufferViews[reparsed.json.images[0].bufferView];
  const imageBytes = reparsed.bin.subarray(imageView.byteOffset, imageView.byteOffset + imageView.byteLength);
  check("embedded image bytes are the PNG", Buffer.from(imageBytes).equals(redPng));

  // 3. Failed texture fetch becomes a warning, not an error.
  console.log("Fetch failure handling:");
  const failing = await MeshyGltfUtils.embedExternalResources(
    JSON.parse(JSON.stringify(parsedExternal.json)),
    parsedExternal.bin,
    { fetchBinary: async () => { throw new Error("404"); } }
  );
  check("warning recorded", failing.warnings.length === 1 && failing.warnings[0].includes("404"));
  check("geometry still embedded", failing.json.buffers.length === 1);

  // 4. OBJ + MTL export with UVs and material references.
  console.log("OBJ/MTL export:");
  const pkg = MeshyGltfUtils.buildObjMtlPackage(reparsed, { materials: true });
  check("obj has 3 vertices", (pkg.obj.match(/^v /gm) || []).length === 3);
  check("obj has 3 UVs", (pkg.obj.match(/^vt /gm) || []).length === 3);
  check("obj has 1 face", (pkg.obj.match(/^f /gm) || []).length === 1);
  check("face uses v/vt indices", /^f 1\/1\/? 2\/2\/? 3\/3\/?$/m.test(pkg.obj), pkg.obj.split("\n").find((l) => l.startsWith("f ")));
  check("obj references mtl file", pkg.obj.includes("mtllib model.mtl"));
  check("obj uses material", pkg.obj.includes("usemtl Red_Mat"));
  check("mtl has material", pkg.mtl.includes("newmtl Red_Mat"));
  check("mtl keeps base color", pkg.mtl.includes("Kd 1 0 0"));
  check("mtl maps texture", pkg.mtl.includes("map_Kd textures/texture_0.png"));
  check("texture extracted", pkg.textures.length === 1 && pkg.textures[0].name === "textures/texture_0.png");
  check("texture bytes are PNG", Buffer.from(pkg.textures[0].bytes).equals(redPng));
  check("UV flipped to OBJ convention", pkg.obj.includes("vt 0 1") || pkg.obj.includes("vt 1 0"));

  // 5. STL export has correct triangle count.
  console.log("STL export:");
  const stl = Buffer.from(MeshyGltfUtils.glbToBinaryStl(reparsed));
  check("stl header", stl.subarray(0, 5).toString("ascii") === "Conve");
  check("stl triangle count", stl.readUInt32LE(80) === 1, String(stl.readUInt32LE(80)));
  check("stl size exact", stl.length === 84 + 50, String(stl.length));

  // 6. ZIP builds a readable archive (Node can open it via zlib-free check).
  console.log("ZIP export:");
  const zip = Buffer.from(MeshyGltfUtils.buildZip([
    { name: "model.obj", data: pkg.obj },
    { name: "model.mtl", data: pkg.mtl },
    { name: "textures/texture_0.png", data: pkg.textures[0].bytes },
  ]));
  fs.writeFileSync(path.join(outDir, "bundle.zip"), zip);
  check("zip signature", zip.subarray(0, 4).toString("ascii") === "PK\u0003\u0004");
  check("zip eocd signature", zip.subarray(zip.length - 22, zip.length - 18).toString("ascii") === "PK\u0005\u0006");
  check("zip entry count", zip.readUInt16LE(zip.length - 22 + 10) === 3, String(zip.readUInt16LE(zip.length - 22 + 10)));
  const objEntry = "model.obj";
  const objIndex = zip.indexOf(Buffer.from(objEntry));
  check("zip contains model.obj", objIndex > 0);
  const objDataIndex = zip.indexOf(Buffer.from("# Exported from a Meshy .meshy model"));
  check("zip obj content present", objDataIndex > objIndex);

  // 7. Column-major node matrix handling (translate + scale on the node).
  console.log("Node transforms:");
  const transformedJson = JSON.parse(JSON.stringify(reparsed.json));
  transformedJson.nodes[0] = { mesh: 0, translation: [5, 0, 0], scale: [2, 2, 2] };
  const transformedGltf = { json: transformedJson, bin: reparsed.bin };
  const transformedStl = Buffer.from(MeshyGltfUtils.glbToBinaryStl(transformedGltf));
  // Vertex layout per triangle: normal (12B), v1 (12B), v2 (12B)…
  // v1 = (5,0,0); v2 = scaled (1,0,0) → (7,0,0).
  check("transformed vertex x", Math.abs(transformedStl.readFloatLE(84 + 12) - 5) < 1e-5, String(transformedStl.readFloatLE(84 + 12)));
  check("scaled second vertex x", Math.abs(transformedStl.readFloatLE(84 + 24) - 7) < 1e-5, String(transformedStl.readFloatLE(84 + 24)));

  // 8. Column-major matrix node (glTF stores transposed).
  const matrixJson = JSON.parse(JSON.stringify(reparsed.json));
  // glTF column-major matrix for translation (3,0,0):
  matrixJson.nodes[0] = { mesh: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1] };
  const matrixStl = Buffer.from(MeshyGltfUtils.glbToBinaryStl({ json: matrixJson, bin: reparsed.bin }));
  check("matrix node translated", Math.abs(matrixStl.readFloatLE(84 + 12) - 3) < 1e-5, String(matrixStl.readFloatLE(84 + 12)));

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
