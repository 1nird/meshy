/*
 * gltf-utils.js — glTF/GLB helpers for Meshy To STL.
 *
 * Dependency-free utilities that let the extension export models with
 * textures and rigs intact:
 *  - parse and rebuild GLB binaries
 *  - embed external buffers and texture images into a single .glb so
 *    Blender imports geometry, materials, textures, rigs (skins) and
 *    animations without missing-file errors
 *  - export OBJ + MTL with UVs and material/texture references
 *  - export binary STL (geometry only, by nature of the format)
 *  - build a store-only ZIP entirely from local data
 *
 * Works in the extension popup (window.MeshyGltfUtils) and in Node
 * (module.exports) so it can be unit-tested outside the browser.
 */
(function (factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof self !== "undefined") self.MeshyGltfUtils = api;
})(function () {
  "use strict";

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  function align4(value) {
    return (value + 3) & ~3;
  }

  function ascii(bytes, start, end) {
    return textDecoder.decode(bytes.subarray(start, end));
  }

  function padTo4(bytes, fill) {
    const remainder = bytes.length % 4;
    if (!remainder) return bytes;
    const out = new Uint8Array(bytes.length + 4 - remainder);
    out.set(bytes);
    out.fill(fill, bytes.length);
    return out;
  }

  function toBytes(data) {
    if (typeof data === "string") return textEncoder.encode(data);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    throw new Error("Unsupported binary data type.");
  }

  // ---------------------------------------------------------------- GLB I/O

  function parseGlb(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    if (bytes.length < 12 || ascii(bytes, 0, 4) !== "glTF" || view.getUint32(4, true) !== 2) {
      throw new Error("Input is not a GLB v2 file.");
    }

    let offset = 12;
    let json = null;
    let bin = null;
    while (offset + 8 <= bytes.length) {
      const length = view.getUint32(offset, true);
      const type = ascii(bytes, offset + 4, offset + 8);
      const chunk = bytes.subarray(offset + 8, offset + 8 + length);
      if (type === "JSON") json = JSON.parse(textDecoder.decode(chunk));
      else if (type === "BIN\0") bin = chunk;
      offset += 8 + length;
    }
    if (!json) throw new Error("GLB is missing its JSON chunk.");
    return { json, bin };
  }

  function buildGlb(json, bin) {
    const jsonBytes = padTo4(textEncoder.encode(JSON.stringify(json)), 0x20);
    const binBytes = bin && bin.length ? padTo4(bin, 0) : null;
    const total = 12 + 8 + jsonBytes.length + (binBytes ? 8 + binBytes.length : 0);

    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    out.set(textEncoder.encode("glTF"), 0);
    view.setUint32(4, 2, true);
    view.setUint32(8, total, true);

    let offset = 12;
    view.setUint32(offset, jsonBytes.length, true);
    out.set(textEncoder.encode("JSON"), offset + 4);
    out.set(jsonBytes, offset + 8);
    offset += 8 + jsonBytes.length;

    if (binBytes) {
      view.setUint32(offset, binBytes.length, true);
      out.set(textEncoder.encode("BIN\0"), offset + 4);
      out.set(binBytes, offset + 8);
    }
    return out.buffer;
  }

  // ------------------------------------------------------- resource embedding

  function decodeDataUri(uri) {
    if (!/^data:/i.test(uri)) return null;
    const comma = uri.indexOf(",");
    if (comma < 0) throw new Error("Invalid data URI.");
    const meta = uri.slice(5, comma);
    const payload = uri.slice(comma + 1);
    if (/;base64/i.test(meta)) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    return textEncoder.encode(decodeURIComponent(payload));
  }

  function sniffImageMime(bytes) {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
    if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "image/gif";
    return null;
  }

  function mimeExtension(mime) {
    if (mime === "image/jpeg") return ".jpg";
    if (mime === "image/webp") return ".webp";
    if (mime === "image/gif") return ".gif";
    return ".png";
  }

  function resolveUri(uri, baseUrl) {
    try {
      return new URL(uri, baseUrl || undefined).href;
    } catch {
      return uri;
    }
  }

  async function defaultFetchBinary(url) {
    const response = await fetch(url, { credentials: "include", redirect: "follow" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.arrayBuffer();
  }

  function planOffsets(blobs) {
    const offsets = [];
    let total = 0;
    for (const blob of blobs) {
      offsets.push(total);
      total = align4(total + blob.length);
    }
    return { offsets, total };
  }

  /*
   * Rewrites the glTF JSON so that every buffer and every image lives in
   * the GLB's BIN chunk: external http(s) URLs are downloaded, data: URIs
   * are decoded, and images become bufferViews. Fetch failures are
   * collected as warnings instead of aborting the whole export, so the
   * model itself still comes through.
   */
  async function embedExternalResources(json, bin, options = {}) {
    const out = JSON.parse(JSON.stringify(json));
    const fetchBinary = options.fetchBinary || defaultFetchBinary;
    const baseUrl = options.baseUrl;
    const warnings = [];
    let embeddedBuffers = 0;
    let embeddedTextures = 0;

    // A GLB may omit buffers[] in its JSON while still carrying a BIN
    // chunk; treat that BIN chunk as buffer 0.
    if ((!Array.isArray(out.buffers) || out.buffers.length === 0) && bin) {
      out.buffers = [{ byteLength: bin.length }];
    }

    // 1. Gather the source buffers (inline BIN chunk, external files, data URIs).
    const sourceBlobs = [];
    const buffers = out.buffers || [];
    for (let i = 0; i < buffers.length; i++) {
      const buffer = buffers[i];
      if (buffer.uri) {
        let bytes;
        try {
          const decoded = decodeDataUri(buffer.uri);
          bytes = decoded || new Uint8Array(await fetchBinary(resolveUri(buffer.uri, baseUrl)));
        } catch (error) {
          throw new Error(`Could not fetch buffer ${i} (${buffer.uri}): ${error.message}`);
        }
        sourceBlobs.push(bytes);
        delete buffer.uri;
        embeddedBuffers++;
      } else if (bin) {
        sourceBlobs.push(bin);
      } else {
        throw new Error(`Buffer ${i} has no data (the GLB is missing its BIN chunk).`);
      }
    }

    const bufferOffsets = planOffsets(sourceBlobs).offsets;

    // 2. Download/decode every image that is referenced by URI.
    const imagePayloads = [];
    if (Array.isArray(out.images)) {
      for (const image of out.images) {
        if (image.uri === undefined) continue;
        try {
          const decoded = decodeDataUri(image.uri);
          const bytes = decoded || new Uint8Array(await fetchBinary(resolveUri(image.uri, baseUrl)));
          imagePayloads.push({ image, bytes });
        } catch (error) {
          warnings.push(`Could not fetch texture ${image.uri}: ${error.message}`);
        }
      }
    }

    // 3. Remap existing bufferViews onto the merged buffer.
    for (const view of out.bufferViews || []) {
      const source = view.buffer || 0;
      view.buffer = 0;
      view.byteOffset = (view.byteOffset || 0) + (bufferOffsets[source] || 0);
    }

    // 4. Append image bytes as new bufferViews.
    const allBlobs = sourceBlobs.concat(imagePayloads.map((payload) => payload.bytes));
    const { offsets, total } = planOffsets(allBlobs);
    out.bufferViews = out.bufferViews || [];
    imagePayloads.forEach((payload, i) => {
      const viewIndex = out.bufferViews.length;
      out.bufferViews.push({
        buffer: 0,
        byteOffset: offsets[sourceBlobs.length + i],
        byteLength: payload.bytes.length,
      });
      payload.image.bufferView = viewIndex;
      delete payload.image.uri;
      if (!payload.image.mimeType) {
        payload.image.mimeType = sniffImageMime(payload.bytes) || "image/png";
      }
      embeddedTextures++;
    });

    // 5. Merge everything into a single BIN chunk (GLB allows one buffer).
    const merged = new Uint8Array(total);
    allBlobs.forEach((blob, i) => merged.set(blob, offsets[i]));
    out.buffers = [{ byteLength: merged.length }];

    return { json: out, bin: merged, embeddedBuffers, embeddedTextures, warnings };
  }

  async function selfContainedGlb(buffer, options = {}) {
    const parsed = parseGlb(buffer);
    const embedded = await embedExternalResources(parsed.json, parsed.bin, options);
    const data = buildGlb(embedded.json, embedded.bin);
    return {
      data,
      json: embedded.json,
      bin: embedded.bin,
      embeddedBuffers: embedded.embeddedBuffers,
      embeddedTextures: embedded.embeddedTextures,
      warnings: embedded.warnings,
    };
  }

  // ----------------------------------------------------------- accessor math

  const readers = {
    5120: { size: 1, read: (b, o) => b.getInt8(o) },
    5121: { size: 1, read: (b, o) => b.getUint8(o) },
    5122: { size: 2, read: (b, o) => b.getInt16(o, true) },
    5123: { size: 2, read: (b, o) => b.getUint16(o, true) },
    5125: { size: 4, read: (b, o) => b.getUint32(o, true) },
    5126: { size: 4, read: (b, o) => b.getFloat32(o, true) },
  };

  const typeCounts = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

  function normalized(value, componentType) {
    if (componentType === 5120) return Math.max(value / 127, -1);
    if (componentType === 5121) return value / 255;
    if (componentType === 5122) return Math.max(value / 32767, -1);
    if (componentType === 5123) return value / 65535;
    return value;
  }

  function accessorReader(json, bin, index) {
    const accessor = json.accessors[index];
    const bufferView = json.bufferViews[accessor.bufferView];
    const reader = readers[accessor.componentType];
    const itemSize = typeCounts[accessor.type];
    if (!reader || !itemSize) throw new Error(`Unsupported GLB accessor: ${index}`);
    if (!bin) throw new Error("The GLB has no BIN chunk; geometry data is missing.");

    const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const stride = bufferView.byteStride || reader.size * itemSize;
    const start = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);

    return {
      count: accessor.count,
      get(item) {
        const values = [];
        const base = start + item * stride;
        for (let i = 0; i < itemSize; i++) {
          let value = reader.read(view, base + i * reader.size);
          if (accessor.normalized) value = normalized(value, accessor.componentType);
          values.push(value);
        }
        return values;
      },
    };
  }

  // ------------------------------------------------------------ matrix math
  // Internally matrices are row-major (m[row * 4 + col]); glTF files store
  // column-major, so node.matrix values are transposed on read.

  function identityMatrix() {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }

  function multiply(a, b) {
    const out = new Array(16).fill(0);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        for (let k = 0; k < 4; k++) out[row * 4 + col] += a[row * 4 + k] * b[k * 4 + col];
      }
    }
    return out;
  }

  function matrixFromNode(node) {
    if (node.matrix) {
      const m = node.matrix;
      return [
        m[0], m[4], m[8], m[12],
        m[1], m[5], m[9], m[13],
        m[2], m[6], m[10], m[14],
        m[3], m[7], m[11], m[15],
      ];
    }
    const t = node.translation || [0, 0, 0];
    const s = node.scale || [1, 1, 1];
    const q = node.rotation || [0, 0, 0, 1];
    const [x, y, z, w] = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    return [
      (1 - yy - zz) * s[0], (xy - wz) * s[1], (xz + wy) * s[2], t[0],
      (xy + wz) * s[0], (1 - xx - zz) * s[1], (yz - wx) * s[2], t[1],
      (xz - wy) * s[0], (yz + wx) * s[1], (1 - xx - yy) * s[2], t[2],
      0, 0, 0, 1,
    ];
  }

  function transformPoint(m, p) {
    return [
      m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
      m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
      m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
    ];
  }

  function transformDirection(m, p) {
    const x = m[0] * p[0] + m[1] * p[1] + m[2] * p[2];
    const y = m[4] * p[0] + m[5] * p[1] + m[6] * p[2];
    const z = m[8] * p[0] + m[9] * p[1] + m[10] * p[2];
    const length = Math.hypot(x, y, z) || 1;
    return [x / length, y / length, z / length];
  }

  function collectMeshNodes(json) {
    const scene = json.scenes && (json.scenes[json.scene || 0] || json.scenes[0]);
    const nodes = [];
    if (!scene) return nodes;

    function visit(index, parent) {
      const node = json.nodes && json.nodes[index];
      if (!node) return;
      const world = multiply(parent, matrixFromNode(node));
      if (node.mesh !== undefined && json.meshes[node.mesh]) {
        nodes.push({ node, mesh: json.meshes[node.mesh], world });
      }
      for (const child of node.children || []) visit(child, world);
    }

    for (const index of scene.nodes || []) visit(index, identityMatrix());
    return nodes;
  }

  // --------------------------------------------------------------- exporters

  function faceNormal(a, b, c) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    return [nx / len, ny / len, nz / len];
  }

  function glbToBinaryStl(gltf) {
    const { json, bin } = gltf;
    const meshNodes = collectMeshNodes(json);
    let triangleCount = 0;

    for (const { mesh } of meshNodes) {
      for (const primitive of mesh.primitives || []) {
        if (primitive.mode !== undefined && primitive.mode !== 4) continue;
        if (primitive.attributes?.POSITION === undefined) throw new Error("GLB is missing POSITION.");
        const indices = primitive.indices === undefined ? null : accessorReader(json, bin, primitive.indices);
        const positions = accessorReader(json, bin, primitive.attributes.POSITION);
        triangleCount += Math.floor((indices ? indices.count : positions.count) / 3);
      }
    }

    const out = new ArrayBuffer(84 + triangleCount * 50);
    const bytes = new Uint8Array(out);
    const view = new DataView(out);
    bytes.set(textEncoder.encode("Converted from Meshy GLB"));
    view.setUint32(80, triangleCount, true);

    let offset = 84;
    function writeVector(v) {
      view.setFloat32(offset, v[0], true); offset += 4;
      view.setFloat32(offset, v[1], true); offset += 4;
      view.setFloat32(offset, v[2], true); offset += 4;
    }

    for (const { world, mesh } of meshNodes) {
      for (const primitive of mesh.primitives || []) {
        if (primitive.mode !== undefined && primitive.mode !== 4) continue;
        const positions = accessorReader(json, bin, primitive.attributes.POSITION);
        const indices = primitive.indices === undefined ? null : accessorReader(json, bin, primitive.indices);
        const count = indices ? indices.count : positions.count;

        for (let i = 0; i + 2 < count; i += 3) {
          const ia = indices ? indices.get(i)[0] : i;
          const ib = indices ? indices.get(i + 1)[0] : i + 1;
          const ic = indices ? indices.get(i + 2)[0] : i + 2;
          const a = transformPoint(world, positions.get(ia));
          const b = transformPoint(world, positions.get(ib));
          const c = transformPoint(world, positions.get(ic));
          writeVector(faceNormal(a, b, c));
          writeVector(a);
          writeVector(b);
          writeVector(c);
          view.setUint16(offset, 0, true);
          offset += 2;
        }
      }
    }

    return out;
  }

  function sanitizeName(value) {
    const cleaned = String(value).replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
    return cleaned || "material";
  }

  function formatFloat(value) {
    const rounded = Number(value.toFixed(6));
    return String(rounded === 0 ? 0 : rounded);
  }

  function baseColorTextureIndex(material) {
    const pbr = material.pbrMetallicRoughness || {};
    if (pbr.baseColorTexture && pbr.baseColorTexture.index !== undefined) return pbr.baseColorTexture.index;
    const spec = material.extensions && material.extensions.KHR_materials_pbrSpecularGlossiness;
    if (spec && spec.diffuseTexture && spec.diffuseTexture.index !== undefined) return spec.diffuseTexture.index;
    return undefined;
  }

  function textureImageIndex(json, textureIndex) {
    const texture = (json.textures || [])[textureIndex];
    return texture ? texture.source : undefined;
  }

  function materialName(json, index) {
    const material = (json.materials || [])[index] || {};
    return sanitizeName(material.name || `material_${index + 1}`);
  }

  /*
   * Builds an OBJ (+ MTL and extracted texture files) from a GLTF whose
   * images already live in bufferViews (run selfContainedGlb first).
   * Returns { obj, mtl, textures } where textures is a list of
   * { name: "textures/xxx.png", bytes } ready for the ZIP package.
   */
  function buildObjMtlPackage(gltf, options = {}) {
    const { json, bin } = gltf;
    const withMaterials = options.materials !== false;
    const mtlName = options.mtlName || "model.mtl";
    const nodes = collectMeshNodes(json);
    const textures = [];
    const imageFileByIndex = new Map();

    if (withMaterials && Array.isArray(json.images)) {
      json.images.forEach((image, imageIndex) => {
        if (image.bufferView === undefined || !bin) return;
        const view = (json.bufferViews || [])[image.bufferView];
        if (!view) return;
        const start = view.byteOffset || 0;
        const bytes = bin.subarray(start, start + view.byteLength);
        const extension = mimeExtension(image.mimeType || sniffImageMime(bytes) || "image/png");
        const fileName = `texture_${imageIndex}${extension}`;
        imageFileByIndex.set(imageIndex, fileName);
        textures.push({ name: `textures/${fileName}`, bytes: new Uint8Array(bytes) });
      });
    }

    const objLines = ["# Exported from a Meshy .meshy model"];
    const mtlLines = ["# Exported from a Meshy .meshy model"];
    if (withMaterials) objLines.push(`mtllib ${mtlName}`);

    (json.materials || []).forEach((material, materialIndex) => {
      const name = materialName(json, materialIndex);
      const pbr = material.pbrMetallicRoughness || {};
      const spec = material.extensions && material.extensions.KHR_materials_pbrSpecularGlossiness;
      const factor = pbr.baseColorFactor || (spec && spec.diffuseFactor) || [0.8, 0.8, 0.8, 1];
      mtlLines.push(`newmtl ${name}`);
      mtlLines.push(`Kd ${formatFloat(factor[0])} ${formatFloat(factor[1])} ${formatFloat(factor[2])}`);
      const textureIndex = baseColorTextureIndex(material);
      const imageIndex = textureIndex === undefined ? undefined : textureImageIndex(json, textureIndex);
      if (imageIndex !== undefined && imageFileByIndex.has(imageIndex)) {
        mtlLines.push(`map_Kd textures/${imageFileByIndex.get(imageIndex)}`);
      }
      mtlLines.push("");
    });

    let vertexOffset = 0;
    let texCoordOffset = 0;
    let normalOffset = 0;
    let objectCount = 0;

    for (const { node, mesh, world } of nodes) {
      const primitives = mesh.primitives || [];
      primitives.forEach((primitive, primitiveIndex) => {
        if (primitive.mode !== undefined && primitive.mode !== 4) return;
        if (primitive.attributes === undefined || primitive.attributes.POSITION === undefined) {
          throw new Error("GLB primitive is missing POSITION.");
        }

        const positions = accessorReader(json, bin, primitive.attributes.POSITION);
        const texCoords = primitive.attributes.TEXCOORD_0 !== undefined
          ? accessorReader(json, bin, primitive.attributes.TEXCOORD_0)
          : null;
        const normals = primitive.attributes.NORMAL !== undefined
          ? accessorReader(json, bin, primitive.attributes.NORMAL)
          : null;
        const indices = primitive.indices !== undefined ? accessorReader(json, bin, primitive.indices) : null;

        const baseName = sanitizeName(mesh.name || node.name || `mesh_${objectCount + 1}`);
        objLines.push(`o ${primitives.length > 1 ? `${baseName}_${primitiveIndex + 1}` : baseName}`);

        for (let i = 0; i < positions.count; i++) {
          const p = transformPoint(world, positions.get(i));
          objLines.push(`v ${formatFloat(p[0])} ${formatFloat(p[1])} ${formatFloat(p[2])}`);
        }
        if (texCoords) {
          for (let i = 0; i < texCoords.count; i++) {
            const uv = texCoords.get(i);
            // glTF UV origin is top-left; OBJ is bottom-left, so flip V.
            objLines.push(`vt ${formatFloat(uv[0])} ${formatFloat(1 - uv[1])}`);
          }
        }
        if (normals) {
          for (let i = 0; i < normals.count; i++) {
            const n = transformDirection(world, normals.get(i));
            objLines.push(`vn ${formatFloat(n[0])} ${formatFloat(n[1])} ${formatFloat(n[2])}`);
          }
        }
        if (withMaterials && primitive.material !== undefined) {
          objLines.push(`usemtl ${materialName(json, primitive.material)}`);
        }

        const count = indices ? indices.count : positions.count;
        const corner = (i, k) => {
          const index = indices ? indices.get(i + k)[0] : i + k;
          const v = index + vertexOffset + 1;
          if (!texCoords && !normals) return `${v}`;
          if (!normals) return `${v}/${index + texCoordOffset + 1}`;
          return `${v}/${index + texCoordOffset + 1}/${index + normalOffset + 1}`;
        };
        for (let i = 0; i + 2 < count; i += 3) {
          objLines.push(`f ${corner(i, 0)} ${corner(i, 1)} ${corner(i, 2)}`);
        }

        vertexOffset += positions.count;
        if (texCoords) texCoordOffset += texCoords.count;
        if (normals) normalOffset += normals.count;
        objectCount++;
      });
    }

    if (!objectCount) throw new Error("The GLB does not contain triangle meshes.");

    return {
      obj: `${objLines.join("\n")}\n`,
      mtl: withMaterials ? `${mtlLines.join("\n")}\n` : null,
      textures,
    };
  }

  // -------------------------------------------------------------- ZIP writer

  let crcTable;
  function makeCrcTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  }

  function crc32(bytes) {
    if (!crcTable) crcTable = makeCrcTable();
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  /*
   * Builds a ZIP archive (store method, no compression) from
   * [{ name: "path/name.ext", data: Uint8Array | ArrayBuffer | string }].
   */
  function buildZip(entries) {
    const localParts = [];
    const centralParts = [];
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const dosDate = (((now.getFullYear() - 1980) & 0x7f) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    let offset = 0;

    for (const entry of entries) {
      const nameBytes = textEncoder.encode(entry.name);
      const data = toBytes(entry.data);
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); // local file header signature
      local.setUint16(4, 20, true);         // version needed
      local.setUint16(6, 0x0800, true);     // flags: UTF-8 file names
      local.setUint16(8, 0, true);          // method: store
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      localParts.push(new Uint8Array(local.buffer), nameBytes, data);

      const central = new DataView(new ArrayBuffer(46));
      central.setUint32(0, 0x02014b50, true); // central directory signature
      central.setUint16(4, 20, true);         // version made by
      central.setUint16(6, 20, true);         // version needed
      central.setUint16(8, 0x0800, true);     // flags: UTF-8 file names
      central.setUint16(10, 0, true);         // method: store
      central.setUint16(12, dosTime, true);
      central.setUint16(14, dosDate, true);
      central.setUint32(16, crc, true);
      central.setUint32(20, data.length, true);
      central.setUint32(24, data.length, true);
      central.setUint16(28, nameBytes.length, true);
      central.setUint32(42, offset, true);    // local header offset
      centralParts.push(new Uint8Array(central.buffer), nameBytes);

      offset += 30 + nameBytes.length + data.length;
    }

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true); // end of central directory signature
    eocd.setUint16(8, entries.length, true);
    eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, centralSize, true);
    eocd.setUint32(16, offset, true);

    const all = [...localParts, ...centralParts, new Uint8Array(eocd.buffer)];
    const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
    let position = 0;
    for (const part of all) {
      out.set(part, position);
      position += part.length;
    }
    return out.buffer;
  }

  return {
    parseGlb,
    buildGlb,
    embedExternalResources,
    selfContainedGlb,
    glbToBinaryStl,
    buildObjMtlPackage,
    buildZip,
    crc32,
    sanitizeName,
    sniffImageMime,
    mimeExtension,
    // exposed for tests
    accessorReader,
    multiply,
    matrixFromNode,
    transformPoint,
    transformDirection,
    collectMeshNodes,
  };
});
