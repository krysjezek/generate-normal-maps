# Normal Map Generator — Web App Spec

A spec for Claude Code. Build a fully client-side browser tool that converts a grayscale heightmap into a tangent-space normal map, with live controls and a lit 3D preview. No backend, images never leave the browser.

## Goal

Drop in a heightmap (e.g. a card design: white shapes on black = raised), get a tangent-space normal map out. Two primary controls: relief **strength** and **smooth radius**. Aspect ratio and resolution of the source are preserved exactly. Export as lossless PNG.

This replaces an offline numpy/Blender workflow with an interactive in-browser one. The reference implementation it must match:

```
gray   = luma(image)                      # ITU-R 601 luma
height = gaussianBlur(gray, radius)       # "smooth radius"
gx, gy = gradient(height)                 # per-pixel slope
n      = normalize(vec3(-gx*strength, +gy*strength, 1.0))   # OpenGL/+Y
rgb    = n*0.5 + 0.5                       # pack to 0..1
```

## Non-goals (scope guard)

Do not build any of this unless explicitly asked later:
- No backend, no upload server, no auth, no accounts.
- No displacement/geometry baking. This is the analytic image route, not a mesh bake.
- No batch processing, no format zoo. PNG in, PNG out. (Accept any browser-decodable image as input, but optimise for grayscale.)
- No heightmap *painting* or editing. Input only.

## Core algorithm (implement precisely)

All steps treat pixel values as **data, not color**. No sRGB decode on input, no sRGB encode on output (see Color management below).

1. **Luma.** Collapse to a single height channel with ITU-R 601 luma: `0.299*R + 0.587*G + 0.114*B`. If the source is already single-channel, use it directly.
2. **Smooth radius (pre-blur).** Separable Gaussian. Expose radius in pixels. `radius = 0` means no blur. Derive sigma as `sigma = radius/3` (kernel half-width = radius, weights from a Gaussian of that sigma), or use a true `radius`-tap box-blur stack if you prefer speed; document whichever you pick. This control sets bevel width: small radius = sharp lip, large radius = soft emboss.
3. **Gradient.** Default to a Sobel 3x3 (`Gx`, `Gy` standard kernels) on the blurred height. Sobel is the de-facto height-to-normal kernel and is less noisy than a bare central difference. Note: the numpy reference used `np.gradient` (central difference), so Sobel output differs slightly in magnitude; if exact parity with the reference is ever required, add a "central difference" gradient mode. Sobel is the default.
4. **Assemble normal.** `n = normalize(vec3(-Gx*strength, +Gy*strength, 1.0))`. The `+Gy` gives OpenGL convention (+Y up). The leading sign on X assumes the conventional handedness; verify against a known reference normal map and flip if mirrored.
5. **Pack.** `rgb = n*0.5 + 0.5`, write as 8-bit RGBA, alpha = 255. Output dimensions equal input dimensions exactly.
6. **Edges.** Clamp-to-edge sampling for both blur and Sobel. No wraparound.

## Architecture

Client-only single-page app. Two render paths off the same source texture:

**Generation (the actual product).** Do it on the GPU with WebGL2 so slider drags are real-time:
- Upload source into an `RGBA8`/`R8` texture, `UNSIGNED_BYTE`, no sRGB internal format.
- Pass 1+2: separable Gaussian (horizontal then vertical) into ping-pong float or RGBA8 FBOs.
- Pass 3: Sobel + assemble + pack, rendered to an RGBA8 FBO and blitted to the visible canvas.
- This same graph runs at full source resolution for export; only the display canvas is fit-to-viewport.

A CPU path in a Web Worker (canvas `getImageData` → typed-array math → `putImageData`) is an acceptable fallback for environments without WebGL2, but the GPU path is the target. Do not block the main thread either way.

**Lit 3D preview (judging relief).** Use three.js here, no reason to hand-roll lighting:
- A `PlaneGeometry` at the source aspect ratio.
- `MeshStandardMaterial` with `normalMap` = the generated normal map (set `.colorSpace = NoColorSpace` / non-color), `normalScale` a `Vector2`. Flipping `normalScale.y` is the OpenGL↔DirectX toggle, wire it to the same control as the generator's Y sign so preview and export agree.
- Dark matte base color (~`#050505`), mid roughness (~0.45), to read like the card.
- One directional light the user can orbit/drag. Dragging the light across the surface is how you see the emboss. `OrbitControls` for the camera.

## Recommended stack

- Vite + TypeScript. No UI framework needed; vanilla DOM is enough for a slider panel. If you reach for one, keep it to Preact/Svelte, not React + a component library.
- Raw WebGL2 for generation. three.js for the preview only.
- Zero runtime dependencies beyond three.js.

## UI / controls

Layout: source (left) | normal map (middle) | lit 3D preview (right), or tabs on narrow screens. Drop-zone + file picker for input.

Controls, with defaults and ranges:

| Control | Default | Range | Effect |
|---|---|---|---|
| Strength | 1.0 | 0 – 5 | Slope multiplier. Higher = deeper relief. |
| Smooth radius | 3 px | 0 – 24 | Gaussian pre-blur. Bevel width. |
| Y convention | OpenGL (+Y) | toggle | Flip green channel for DirectX. Drives export and preview together. |
| Invert height | off | toggle | Treat black as raised instead of white. |
| Gradient | Sobel | Sobel / Central diff | Central diff matches the numpy reference. |

Export: "Download PNG" → full source-resolution normal map, lossless. Filename derived from source (`<name>-normal.png`).

Nice-to-have, not required: a numeric readout of max normal tilt in degrees (`max(acos(n.z))`) as a feel for how pronounced the result is.

## Color management (the easy thing to get wrong)

- **Input** is height data. Sample the source texture without sRGB→linear conversion. Use a plain `RGBA8`/`R8` internal format, not `SRGB8_ALPHA8`. If using `getImageData`, those bytes are already raw, good.
- **Output** is normal data. Write the packed bytes straight to PNG. Do not apply any gamma/sRGB encode. The downstream engine is responsible for tagging it Non-Color on import.
- **WebGL readback flip:** `readPixels` returns bottom-up rows, canvas/PNG expect top-down. Flip vertically on export or you ship an upside-down map. Verify against the source orientation.

## Edge cases & limits

- Non-square and odd-dimension images must pass through with exact dimensions. Aspect ratio is never altered.
- Large images: respect `gl.MAX_TEXTURE_SIZE` (commonly ≥8192). If the source exceeds it, warn and offer to clamp, do not silently downscale a normal map.
- Non-grayscale input (a colored photo): still works via luma, but surface the fact that results assume a heightmap. A one-line hint is enough.
- Fully flat input → a uniform `#8080FF` map. That is correct, not a bug.

## Definition of done

- Drop a heightmap, see a normal map and a lit preview, with no network request after page load.
- Strength and smooth radius update the result with no perceptible lag at ~5 MP.
- Default output is OpenGL (+Y) convention; DirectX toggle verified by eye in the preview.
- Exported PNG is full source resolution, correct orientation, lossless, alpha 255.
- Flat regions are exactly `#8080FF`; a known reference heightmap produces a normal map that matches the reference math within rounding.

## Suggested structure

```
/src
  main.ts            # wiring, file load, control panel
  generator/
    gl.ts            # WebGL2 context, FBO ping-pong helpers
    passes.ts        # gaussian (separable), sobel+pack shaders
    export.ts        # full-res render, readPixels, flip, toBlob('image/png')
    cpu-fallback.ts  # Web Worker path
  preview/
    scene.ts         # three.js plane, MeshStandardMaterial, light, OrbitControls
  ui/
    controls.ts      # sliders/toggles, defaults from this spec
index.html
```
