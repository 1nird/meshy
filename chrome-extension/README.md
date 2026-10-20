# Meshy To STL

Local Chrome extension that finds `.meshy` files loaded by the current tab and exports them as GLB, OBJ + MTL, or STL — with textures and rigs preserved where the format allows.

## Install

Before loading the extension, download the local decoder files:

### Windows

```powershell
cd C:\path\to\meshy-to-stl
powershell -ExecutionPolicy Bypass -File .\setup-vendor.ps1
```

### macOS or Linux

Open Terminal in the project root (the folder above `chrome-extension`) and run:

```bash
sh ./setup-vendor.sh
```

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the project's `chrome-extension` folder.

## Use

1. Open the page where the `.meshy` model is hosted.
2. Reload the page so the extension can capture network activity.
3. Click the extension icon.
4. Select the detected `.meshy` file.
5. Choose the output format (GLB keeps textures and rig).
6. Click the download button.

## Blender import

- **GLB (recommended):** `File ▸ Import ▸ glTF 2.0` — textures, materials, armature (rig), weights and animations come in automatically.
- **OBJ:** extract the ZIP, then `File ▸ Import ▸ Wavefront (.obj)` and pick `model.obj`; the MTL and textures are found automatically.
- **STL:** geometry only, by nature of the format.

## Notes

- Conversion runs locally in the browser.
- `vendor/mesh_loader.js` and `vendor/mesh_loader.wasm` are not versioned in this repository; run the setup script for your operating system to download local copies.
- If the extension says decoder files are missing, run `setup-vendor.ps1` on Windows or `sh ./setup-vendor.sh` on macOS/Linux, then reload the extension in `chrome://extensions`.
- The extension requires Google Chrome or a compatible Chromium browser; Safari is not supported.
- GLB output embeds every texture into the file, so Blender shows no missing-texture errors. STL output is binary and contains geometry only; OBJ output contains geometry with UVs, a material library, and texture files.
- The extension also checks `performance.getEntriesByType("resource")`, so many files visible in the Network panel will automatically appear in the popup.
- Sites with login, temporary URLs, or strict download permissions may require you to be logged in with the same Chrome session.
