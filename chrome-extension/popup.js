const linksSelect = document.getElementById("links");
const formatSelect = document.getElementById("format");
const scanButton = document.getElementById("scan");
const convertButton = document.getElementById("convert");
const statusEl = document.getElementById("status");
const progress = document.getElementById("progress");
const sandboxFrame = document.getElementById("sandbox");

let jobId = 0;

function setBusy(isBusy, text) {
  scanButton.disabled = isBusy;
  convertButton.disabled = isBusy;
  progress.hidden = !isBusy;
  statusEl.textContent = text;
}

function isMeshyUrl(value) {
  if (!value || typeof value !== "string") return false;
  const clean = value.split("#")[0];
  return /\.meshy(?:$|[?&])/i.test(clean) || clean.includes("misc/cdn-models");
}

function baseNameFromUrl(value) {
  try {
    const path = new URL(value).pathname.split("/").pop() || "model.meshy";
    const decoded = decodeURIComponent(path).replace(/\.meshy$/i, "");
    return decoded.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "") || "model";
  } catch {
    return "model";
  }
}

function scanPageForMeshyLinks() {
  const urls = new Set();
  const add = (value) => {
    if (!value || typeof value !== "string") return;
    try {
      const url = new URL(value, location.href);
      const clean = url.href.split("#")[0];
      if (/\.meshy(?:$|[?&])/i.test(clean) || clean.includes("misc/cdn-models")) urls.add(url.href);
    } catch {
      // Ignore invalid URLs.
    }
  };

  performance.getEntriesByType("resource").forEach((entry) => add(entry.name));
  document.querySelectorAll("a[href]").forEach((el) => add(el.getAttribute("href")));
  document.querySelectorAll("[src]").forEach((el) => add(el.getAttribute("src")));
  document.querySelectorAll("[data-src],[data-url],[data-model-url]").forEach((el) => {
    add(el.getAttribute("data-src"));
    add(el.getAttribute("data-url"));
    add(el.getAttribute("data-model-url"));
  });
  for (const match of document.documentElement.innerHTML.matchAll(/https?:\/\/[^"'<>\\\s]+(?:\.meshy|misc\/cdn-models)[^"'<>\\\s]*/gi)) {
    add(match[0]);
  }

  return [...urls].slice(0, 50);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Could not access the current tab.");
  return tab;
}

async function getLinksFromActiveTab() {
  const tab = await getActiveTab();
  const all = new Set();

  const remembered = await chrome.runtime.sendMessage({ type: "get-meshy-requests", tabId: tab.id }).catch(() => null);
  for (const link of remembered?.links || []) all.add(link);

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "scan-meshy-links" });
    for (const link of response?.links || []) all.add(link);
  } catch {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scanPageForMeshyLinks,
    });
    for (const link of result?.result || []) all.add(link);
  }

  return [...all].filter(isMeshyUrl).slice(0, 50);
}

function fillLinks(links) {
  linksSelect.replaceChildren();
  for (const link of links) {
    const option = document.createElement("option");
    option.value = link;
    option.textContent = link;
    linksSelect.append(option);
  }
  if (linksSelect.options.length) linksSelect.selectedIndex = 0;
}

function downloadBlob(blob, filename) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    chrome.downloads.download({ url: objectUrl, filename, conflictAction: "uniquify", saveAs: false }, (downloadId) => {
      const error = chrome.runtime.lastError;
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      if (error) reject(new Error(error.message));
      else resolve(downloadId);
    });
  });
}

function convertInSandbox(buffer) {
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    const onMessage = (event) => {
      if (event.source !== sandboxFrame.contentWindow || event.data?.id !== id) return;
      window.removeEventListener("message", onMessage);
      if (event.data.ok) resolve(event.data.output);
      else reject(new Error(event.data.error || "Conversion failed"));
    };
    window.addEventListener("message", onMessage);
    sandboxFrame.contentWindow.postMessage({ type: "convert", id, buffer }, "*", [buffer]);
  });
}

async function fetchArrayBuffer(url) {
  const response = await fetch(url, { credentials: "include", redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  return response.arrayBuffer();
}

/*
 * Texture/sidecar URLs live at the same CDN and reuse the .meshy asset ID,
 * e.g. <cdn>/<assetId>.meshy, <cdn>/<assetId>.glb, <cdn>/<assetId>.bin,
 * <cdn>/<assetId>.ktx2 / .png / .jpg. The file lists from Meshy pages
 * (model.json / <assetId>.meshy.json) enumerate these companions.
 */
function companionsFor(url) {
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split("/").pop() || "";
    const fileName = decodeURIComponent(lastSegment);
    const dot = fileName.lastIndexOf(".");
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    const directory = parsed.origin + parsed.pathname.slice(0, parsed.pathname.length - lastSegment.length);
    // Keep the query string so signed CDN URLs stay authorized.
    const search = parsed.search;
    const names = [
      `${stem}.bin`,
      `${stem}.glb`,
      `${stem}.gltf`,
      `${stem}.meshy.json`,
      `${stem}.json`,
      "model.json",
      `${stem}.png`,
      `${stem}.jpg`,
      `${stem}.jpeg`,
      `${stem}.webp`,
      `${stem}.ktx2`,
    ];
    return names.map((name) => directory + encodeURIComponent(name) + search);
  } catch {
    return [];
  }
}

async function fetchOptionalBinary(url) {
  try {
    const response = await fetch(url, { credentials: "include", redirect: "follow" });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength) return null;
    return buffer;
  } catch {
    return null;
  }
}

/*
 * Downloads likely texture/sidecar files that share the model's asset ID
 * so they can be bundled in the ZIP for OBJ workflows or reused when the
 * GLB references files by URL.
 */
async function collectCompanionFiles(url, status) {
  const found = [];
  for (const companionUrl of companionsFor(url)) {
    const buffer = await fetchOptionalBinary(companionUrl);
    if (!buffer) continue;
    const name = decodeURIComponent(new URL(companionUrl).pathname.split("/").pop());
    const isImage = MeshyGltfUtils.sniffImageMime(new Uint8Array(buffer)) !== null;
    found.push({
      name: isImage ? `textures/${name}` : name,
      bytes: new Uint8Array(buffer),
    });
    if (isImage) {
      status.textContent = `Downloaded ${name}...`;
    }
  }
  return found;
}

function buildResourceBaseUrl(url) {
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split("/").pop() || "";
    return parsed.origin + parsed.pathname.slice(0, parsed.pathname.length - lastSegment.length);
  } catch {
    return undefined;
  }
}

async function scan() {
  try {
    setBusy(true, "Searching for .meshy files in the current tab network activity...");
    const links = await getLinksFromActiveTab();
    fillLinks(links);
    statusEl.textContent = links.length
      ? `${links.length} .meshy file(s) found.`
      : "No .meshy file found. Reload the page with the extension installed and try again.";
  } catch (error) {
    statusEl.textContent = `Scan error: ${error.message}`;
  } finally {
    setBusy(false, statusEl.textContent);
  }
}

scanButton.addEventListener("click", scan);

const buttonLabels = { glb: "Download GLB", obj: "Download OBJ", zip: "Download ZIP", stl: "Download STL" };

formatSelect.addEventListener("change", () => {
  convertButton.textContent = buttonLabels[formatSelect.value] || "Download";
});
convertButton.textContent = buttonLabels[formatSelect.value] || "Download";

convertButton.addEventListener("click", async () => {
  const url = linksSelect.value;
  if (!url) {
    statusEl.textContent = "No .meshy file selected.";
    return;
  }

  const format = formatSelect.value;
  const baseName = baseNameFromUrl(url);
  try {
    setBusy(true, "Downloading .meshy...");
    const buffer = await fetchArrayBuffer(url);

    setBusy(true, "Decoding .meshy to GLB...");
    const decodedGlb = await convertInSandbox(buffer);
    const { json, bin } = MeshyGltfUtils.parseGlb(decodedGlb);

    if (format === "stl") {
      setBusy(true, "Converting to STL...");
      // STL carries geometry only; skip texture work entirely.
      const stl = MeshyGltfUtils.glbToBinaryStl({ json, bin });
      await downloadBlob(new Blob([stl], { type: "model/stl" }), `${baseName}.stl`);
      statusEl.textContent = "STL generated. STL never includes textures or rigs — use GLB to keep them.";
      return;
    }

    setBusy(true, "Preparing model with textures...");
    const embedded = await MeshyGltfUtils.embedExternalResources(json, bin, {
      baseUrl: buildResourceBaseUrl(url),
    });
    for (const warning of embedded.warnings) console.warn("[Meshy To STL]", warning);
    const embeddedGltf = { json: embedded.json, bin: embedded.bin };

    if (format === "glb") {
      const glb = MeshyGltfUtils.buildGlb(embedded.json, embedded.bin);
      await downloadBlob(new Blob([glb], { type: "model/gltf-binary" }), `${baseName}.glb`);
      const parts = [];
      if (embedded.embeddedTextures) parts.push(`${embedded.embeddedTextures} texture(s) embedded`);
      if (embedded.warnings.length) parts.push(`${embedded.warnings.length} texture(s) could not be fetched`);
      statusEl.textContent = parts.length
        ? `GLB saved — ${parts.join(", ")}.`
        : "GLB saved. Geometry, materials, textures, rig and animations included.";
      return;
    }

    // obj (+mtl/textures) or zip bundle
    setBusy(true, "Building OBJ/MTL package...");
    const package_ = MeshyGltfUtils.buildObjMtlPackage(embeddedGltf, {
      materials: format !== "obj",
    });
    const companions = format === "zip" ? await collectCompanionFiles(url, statusEl) : [];
    const fileBase = format === "zip" ? baseName : undefined;
    const zipEntries = [
      { name: fileBase ? `${fileBase}/model.obj` : "model.obj", data: package_.obj },
    ];
    if (package_.mtl) {
      zipEntries.push({ name: fileBase ? `${fileBase}/model.mtl` : "model.mtl", data: package_.mtl });
    }
    zipEntries.push(
      ...package_.textures.map((texture) => ({
        name: fileBase ? `${fileBase}/${texture.name}` : texture.name.replace(/^textures\//, "texture_"),
        data: texture.bytes,
      })),
      ...companions.map((companion) => ({
        name: fileBase ? `${fileBase}/${companion.name}` : companion.name.replace(/\//g, "_"),
        data: companion.bytes,
      }))
    );
    await downloadBlob(new Blob([MeshyGltfUtils.buildZip(zipEntries)], { type: "application/zip" }), `${baseName}_zip.zip`);
    const textureCount = package_.textures.length + companions.filter((c) => c.name.startsWith("textures/")).length;
    if (!package_.mtl && !textureCount) {
      statusEl.textContent = "OBJ saved (geometry + UVs). Use GLB to keep textures, rig and animations.";
    } else if (textureCount) {
      statusEl.textContent = `ZIP saved with model.obj, model.mtl and ${textureCount} texture file(s).`;
    } else {
      statusEl.textContent = "ZIP saved with model.obj and model.mtl (the GLB had no separate texture files).";
    }
  } catch (error) {
    statusEl.textContent = `Error: ${error.message}`;
  } finally {
    setBusy(false, statusEl.textContent);
  }
});

document.addEventListener("DOMContentLoaded", scan);
