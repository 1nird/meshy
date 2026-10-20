# Meshy To STL

Meshy To STL is a Chrome extension that finds `.meshy` files loaded by the current browser tab and exports them as GLB, OBJ + MTL (optionally with textures), or STL — with textures and rigs preserved where the format allows.

## Features

- Detects `.meshy` files from the current page network activity.
- Also checks browser resource entries from `performance.getEntriesByType("resource")`.
- Converts Meshy encrypted model files locally in the browser.
- Exports:
  - **GLB** — a self-contained binary glTF with every texture embedded, plus skeleton (rig), skinning and animations. This is the best format for Blender.
  - **OBJ + MTL (ZIP)** — geometry with UV coordinates, plus an MTL material library and extracted texture files.
  - **OBJ + MTL** — same, without external texture files.
  - **STL** — binary STL for 3D printing (geometry only, by nature of the format).
- Textures referenced by URL are downloaded and embedded into the GLB automatically; failed texture downloads are reported as warnings instead of aborting the export.
- Does not commit Meshy's loader files to this repository.

## Installation

Before loading the extension, download the local decoder files:

### Windows

```powershell
cd C:\path\to\meshy-to-stl
powershell -ExecutionPolicy Bypass -File .\setup-vendor.ps1
```

### macOS or Linux

Open Terminal in the extracted project folder and run:

```bash
sh ./setup-vendor.sh
```

Then load the extension in Chrome:

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the project's `chrome-extension` folder.

## Usage

1. Open the page where the Meshy model is hosted.
2. Reload the page so the extension can capture network requests.
3. Click the Meshy To STL extension icon.
4. Select the detected `.meshy` file.
5. Choose the output format (GLB keeps textures and rig).
6. Click the download button.

## Importing into Blender

- **GLB (recommended):** `File ▸ Import ▸ glTF 2.0 (.glb/.gltf)`. Textures, materials, armature (rig), weights and animations all come in automatically.
- **OBJ:** extract the ZIP first, then `File ▸ Import ▸ Wavefront (.obj)` and pick `model.obj`. Blender finds `model.mtl` and the texture files next to it.
- **STL:** `File ▸ Import ▸ STL (.stl)` — geometry only, no materials or rig.

## Notes

- Conversion runs locally in your browser.
- `chrome-extension/vendor/mesh_loader.js` and `chrome-extension/vendor/mesh_loader.wasm` are intentionally not versioned.
- On Windows, run `setup-vendor.ps1` after cloning or extracting the project.
- On macOS or Linux, run `sh ./setup-vendor.sh` after cloning or extracting the project.
- If the extension says decoder files are missing, run the setup script for your operating system and reload the extension in `chrome://extensions`.
- The extension requires Google Chrome or a compatible Chromium browser; Safari is not supported.
- Sites with login, temporary URLs, or strict download permissions may require you to be logged in with the same Chrome session.
- STL files cannot contain textures or rigs — that is a limitation of the STL format itself. Use GLB when you need textures or armatures in Blender.

## Development

Run the offline logic tests (no browser needed):

```bash
node test/gltf-utils.test.js
```

They build a synthetic textured GLB, embed external textures, and verify the GLB, OBJ + MTL, STL, and ZIP outputs.
