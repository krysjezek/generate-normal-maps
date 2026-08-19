# Normal Map Generator

Generate tangent-space normal maps from grayscale heightmaps directly in your browser. Adjust the relief in real time, inspect it under movable lighting, and export the result at the source image's full resolution.

**[Open the live Normal Map Generator](https://generate-normal-maps-production.up.railway.app/)**

## What it does

Normal Map Generator turns the brightness of an image into surface direction data:

- White areas are raised and black areas are recessed by default.
- **Strength** controls how pronounced the relief appears.
- **Smooth radius** softens hard height transitions into wider bevels.
- **OpenGL (+Y)** and **DirectX (-Y)** output work with different 3D engines.
- **Sobel** and **central-difference** gradient modes offer smooth or reference-friendly conversion.
- **Invert height** swaps raised and recessed areas.

The source image, generated normal map, and a lit 3D preview are displayed together so you can judge the result before downloading it.

## Why use it

- **Private by design.** Images are processed locally and are not uploaded to a server.
- **Immediate feedback.** WebGL2 performs the conversion on the GPU while you adjust the controls.
- **Visual verification.** Orbit the preview and drag its light to check whether fine details and bevels read correctly.
- **Pipeline-ready output.** Choose OpenGL or DirectX orientation instead of fixing an inverted green channel later.
- **Full-resolution export.** The output keeps the source image's dimensions and aspect ratio.
- **No installation.** It runs in a modern browser without a desktop graphics package or command-line conversion step.

## Quick tutorial

1. [Open the live app](https://generate-normal-maps-production.up.railway.app/) in a WebGL2-compatible browser.
2. Drop a heightmap onto the upload area, or select **Open image**. Grayscale images give the most predictable results.
3. Set **Height** to **White raised** or **Black raised**, depending on your source.
4. Adjust **Strength** to control the depth of the effect.
5. Adjust **Smooth radius** to change the edge profile. Lower values create sharper edges; higher values create softer, wider bevels.
6. Inspect the **Lit preview**. Drag over it to move the light and drag to orbit the camera.
7. Select **OpenGL +Y** for Blender and most OpenGL workflows, or **DirectX -Y** if your target engine expects it.
8. Choose an export format and select **Download**.

### Input tips

- Use high-contrast grayscale artwork for embossed logos, text, panels, and graphic details.
- Use smooth gradients for rounded or gently sloped forms.
- Start with the default Sobel mode. Try central difference when matching a conversion pipeline based on per-pixel central gradients.
- A flat image correctly produces a flat normal map close to `#8080FF`.

## Export formats

The app exports PNG, TGA, TIFF, WebP, and JPEG. Use PNG, TGA, or TIFF for production texture data; JPEG is lossy and is better suited to quick previews.

Generated files use the source filename followed by `-normal`, for example:

```text
brushed-metal.png -> brushed-metal-normal.png
```

## How it works

The conversion runs in a WebGL2 shader pipeline:

1. Convert the source image to ITU-R BT.601 luma.
2. Apply a separable Gaussian blur using the selected smooth radius.
3. Calculate horizontal and vertical height gradients with Sobel or central differences.
4. Assemble and normalize a tangent-space normal vector.
5. Pack the vector into RGB color channels for export.

Processing uses clamp-to-edge sampling and preserves the input dimensions. Images larger than the browser's reported `MAX_TEXTURE_SIZE` cannot be processed on that device.

## Run locally

Requirements:

- Node.js 20.9 or newer
- A browser with WebGL2 support

```bash
git clone https://github.com/krysjezek/generate-normal-maps.git
cd generate-normal-maps
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

To create and run a production build:

```bash
npm run build
npm start
```

## Built with

- [Next.js](https://nextjs.org/)
- [React](https://react.dev/)
- [Three.js](https://threejs.org/)
- WebGL2 and GLSL
- TypeScript
