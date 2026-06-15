"use client";

import { ChangeEvent, DragEvent, useCallback, useEffect, useRef, useState } from "react";

type GradientMode = "sobel" | "central";
type YConvention = "opengl" | "directx";
type ExportFormat = "png" | "tga" | "tiff" | "webp" | "jpeg";

type SourceImage = {
  name: string;
  width: number;
  height: number;
  imageData: ImageData;
};

const exportTypes: Record<ExportFormat, { label: string; extension: string; mime: string }> = {
  png: { label: "PNG", extension: "png", mime: "image/png" },
  tga: { label: "TGA", extension: "tga", mime: "image/x-tga" },
  tiff: { label: "TIFF", extension: "tif", mime: "image/tiff" },
  webp: { label: "WebP", extension: "webp", mime: "image/webp" },
  jpeg: { label: "JPEG", extension: "jpg", mime: "image/jpeg" },
};

const vertexShader = `#version 300 es
precision highp float;
const vec2 positions[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2(3.0, -1.0),
  vec2(-1.0, 3.0)
);
out vec2 vUv;
void main() {
  vec2 p = positions[gl_VertexID];
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const lumaShader = `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform bool uInvert;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 c = texture(uImage, vUv).rgb;
  float h = dot(c, vec3(0.299, 0.587, 0.114));
  if (uInvert) h = 1.0 - h;
  outColor = vec4(h, h, h, 1.0);
}`;

const blurShader = `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform vec2 uTexel;
uniform vec2 uDirection;
uniform int uRadius;
in vec2 vUv;
out vec4 outColor;
void main() {
  if (uRadius == 0) {
    outColor = texture(uImage, vUv);
    return;
  }
  float sigma = max(float(uRadius) / 3.0, 0.001);
  float total = 0.0;
  float h = 0.0;
  for (int i = -24; i <= 24; i++) {
    if (abs(i) <= uRadius) {
      float x = float(i);
      float w = exp(-(x * x) / (2.0 * sigma * sigma));
      vec2 uv = clamp(vUv + uDirection * uTexel * x, vec2(0.0), vec2(1.0));
      h += texture(uImage, uv).r * w;
      total += w;
    }
  }
  float blurred = h / max(total, 0.00001);
  outColor = vec4(blurred, blurred, blurred, 1.0);
}`;

const normalShader = `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform vec2 uTexel;
uniform float uStrength;
uniform bool uFlipY;
uniform int uGradientMode;
in vec2 vUv;
out vec4 outColor;
float h(vec2 offset) {
  return texture(uImage, clamp(vUv + offset * uTexel, vec2(0.0), vec2(1.0))).r;
}
void main() {
  float gx;
  float gy;
  if (uGradientMode == 0) {
    float tl = h(vec2(-1.0, -1.0));
    float t = h(vec2(0.0, -1.0));
    float tr = h(vec2(1.0, -1.0));
    float l = h(vec2(-1.0, 0.0));
    float r = h(vec2(1.0, 0.0));
    float bl = h(vec2(-1.0, 1.0));
    float b = h(vec2(0.0, 1.0));
    float br = h(vec2(1.0, 1.0));
    gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
    gy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
  } else {
    gx = h(vec2(1.0, 0.0)) - h(vec2(-1.0, 0.0));
    gy = h(vec2(0.0, 1.0)) - h(vec2(0.0, -1.0));
  }
  float ySign = uFlipY ? -1.0 : 1.0;
  vec3 n = normalize(vec3(-gx * uStrength, gy * uStrength * ySign, 1.0));
  outColor = vec4(n * 0.5 + 0.5, 1.0);
}`;

function createShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "Shader compile failed.");
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, fragment: string) {
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to create program.");
  gl.attachShader(program, createShader(gl, gl.VERTEX_SHADER, vertexShader));
  gl.attachShader(program, createShader(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "Program link failed.");
  }
  return program;
}

function makeTexture(gl: WebGL2RenderingContext, width: number, height: number, data?: ImageData) {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Unable to create texture.");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (data) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  } else {
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
  }
  return texture;
}

function makeTarget(gl: WebGL2RenderingContext, width: number, height: number) {
  const texture = makeTexture(gl, width, height);
  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) throw new Error("Unable to create framebuffer.");
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error("Framebuffer is incomplete.");
  }
  return { texture, framebuffer };
}

function createSampleHeightmap(): SourceImage {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 640;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D is unavailable.");
  ctx.fillStyle = "#050505";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#f5f5f5";
  ctx.roundRect(116, 116, 792, 408, 36);
  ctx.fill();
  ctx.fillStyle = "#1a1a1a";
  ctx.roundRect(180, 180, 664, 280, 24);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 118px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("NORMAL", canvas.width / 2, canvas.height / 2 - 16);
  ctx.fillStyle = "#b8b8b8";
  ctx.font = "700 42px Arial";
  ctx.fillText("HEIGHTMAP", canvas.width / 2, canvas.height / 2 + 92);
  return {
    name: "sample-heightmap",
    width: canvas.width,
    height: canvas.height,
    imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
  };
}

function downloadBlob(blob: Blob, filename: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Export failed."));
    }, mime, quality);
  });
}

function encodeTga(imageData: ImageData) {
  const { width, height, data } = imageData;
  const header = new Uint8Array(18);
  header[2] = 2;
  header[12] = width & 255;
  header[13] = (width >> 8) & 255;
  header[14] = height & 255;
  header[15] = (height >> 8) & 255;
  header[16] = 32;
  header[17] = 0x28;
  const body = new Uint8Array(width * height * 4);
  for (let src = 0, dst = 0; src < data.length; src += 4, dst += 4) {
    body[dst] = data[src + 2];
    body[dst + 1] = data[src + 1];
    body[dst + 2] = data[src];
    body[dst + 3] = data[src + 3];
  }
  return new Blob([header, body], { type: exportTypes.tga.mime });
}

function writeAscii(buffer: Uint8Array, offset: number, value: string) {
  for (let i = 0; i < value.length; i++) buffer[offset + i] = value.charCodeAt(i);
}

function encodeTiff(imageData: ImageData) {
  const { width, height, data } = imageData;
  const entries = 12;
  const ifdOffset = 8;
  const ifdSize = 2 + entries * 12 + 4;
  const bitsOffset = ifdOffset + ifdSize;
  const softwareOffset = bitsOffset + 8;
  const software = "Normal Map Generator\0";
  const pixelOffset = softwareOffset + software.length;
  const pixelBytes = width * height * 4;
  const buffer = new ArrayBuffer(pixelOffset + pixelBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  writeAscii(bytes, 0, "II");
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, entries, true);

  let entry = ifdOffset + 2;
  const add = (tag: number, type: number, count: number, value: number) => {
    view.setUint16(entry, tag, true);
    view.setUint16(entry + 2, type, true);
    view.setUint32(entry + 4, count, true);
    if (type === 3 && count === 1) view.setUint16(entry + 8, value, true);
    else view.setUint32(entry + 8, value, true);
    entry += 12;
  };

  add(256, 4, 1, width);
  add(257, 4, 1, height);
  add(258, 3, 4, bitsOffset);
  add(259, 3, 1, 1);
  add(262, 3, 1, 2);
  add(273, 4, 1, pixelOffset);
  add(277, 3, 1, 4);
  add(278, 4, 1, height);
  add(279, 4, 1, pixelBytes);
  add(284, 3, 1, 1);
  add(305, 2, software.length, softwareOffset);
  add(338, 3, 1, 2);
  view.setUint32(entry, 0, true);

  for (let i = 0; i < 4; i++) view.setUint16(bitsOffset + i * 2, 8, true);
  writeAscii(bytes, softwareOffset, software);
  bytes.set(data, pixelOffset);
  return new Blob([buffer], { type: exportTypes.tiff.mime });
}

async function loadFile(file: File): Promise<SourceImage> {
  const bitmap = await createImageBitmap(file, { colorSpaceConversion: "none" });
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D is unavailable.");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return {
    name: file.name.replace(/\.[^.]+$/, ""),
    width: canvas.width,
    height: canvas.height,
    imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
  };
}

export function NormalMapApp() {
  const sourceCanvasRef = useRef<HTMLCanvasElement>(null);
  const normalCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cleanupPreviewRef = useRef<(() => void) | null>(null);
  const rafRef = useRef<number | null>(null);

  const [source, setSource] = useState<SourceImage | null>(null);
  const [strength, setStrength] = useState(1);
  const [radius, setRadius] = useState(3);
  const [convention, setConvention] = useState<YConvention>("opengl");
  const [invert, setInvert] = useState(false);
  const [gradient, setGradient] = useState<GradientMode>("sobel");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("png");
  const [error, setError] = useState("");
  const [tilt, setTilt] = useState(0);
  const [normalVersion, setNormalVersion] = useState(0);
  const hasNormalMap = normalVersion > 0;

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setSource(createSampleHeightmap());
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const renderNormalMap = useCallback(() => {
    if (!source || !normalCanvasRef.current || !sourceCanvasRef.current) return;
    const maxTextureSizeCanvas = glCanvasRef.current ?? document.createElement("canvas");
    glCanvasRef.current = maxTextureSizeCanvas;
    const gl = maxTextureSizeCanvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      setError("WebGL2 is unavailable in this browser.");
      return;
    }
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (source.width > maxTextureSize || source.height > maxTextureSize) {
      setError(`Image is ${source.width}x${source.height}, above this GPU limit of ${maxTextureSize}px.`);
      return;
    }

    setError("");
    maxTextureSizeCanvas.width = source.width;
    maxTextureSizeCanvas.height = source.height;
    gl.viewport(0, 0, source.width, source.height);

    const sourceCanvas = sourceCanvasRef.current;
    sourceCanvas.width = source.width;
    sourceCanvas.height = source.height;
    const sourceCtx = sourceCanvas.getContext("2d");
    sourceCtx?.putImageData(source.imageData, 0, 0);

    const normalCanvas = normalCanvasRef.current;
    normalCanvas.width = source.width;
    normalCanvas.height = source.height;

    const lumaProgram = createProgram(gl, lumaShader);
    const blurProgram = createProgram(gl, blurShader);
    const normalProgram = createProgram(gl, normalShader);
    const inputTexture = makeTexture(gl, source.width, source.height, source.imageData);
    const targetA = makeTarget(gl, source.width, source.height);
    const targetB = makeTarget(gl, source.width, source.height);

    gl.activeTexture(gl.TEXTURE0);

    gl.useProgram(lumaProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetA.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, inputTexture);
    gl.uniform1i(gl.getUniformLocation(lumaProgram, "uImage"), 0);
    gl.uniform1i(gl.getUniformLocation(lumaProgram, "uInvert"), invert ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(blurProgram);
    gl.uniform1i(gl.getUniformLocation(blurProgram, "uImage"), 0);
    gl.uniform2f(gl.getUniformLocation(blurProgram, "uTexel"), 1 / source.width, 1 / source.height);
    gl.uniform1i(gl.getUniformLocation(blurProgram, "uRadius"), radius);

    gl.bindFramebuffer(gl.FRAMEBUFFER, targetB.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, targetA.texture);
    gl.uniform2f(gl.getUniformLocation(blurProgram, "uDirection"), 1, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, targetA.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, targetB.texture);
    gl.uniform2f(gl.getUniformLocation(blurProgram, "uDirection"), 0, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(normalProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, targetA.texture);
    gl.uniform1i(gl.getUniformLocation(normalProgram, "uImage"), 0);
    gl.uniform2f(gl.getUniformLocation(normalProgram, "uTexel"), 1 / source.width, 1 / source.height);
    gl.uniform1f(gl.getUniformLocation(normalProgram, "uStrength"), strength);
    gl.uniform1i(gl.getUniformLocation(normalProgram, "uFlipY"), convention === "directx" ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(normalProgram, "uGradientMode"), gradient === "sobel" ? 0 : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.finish();

    const normalCtx = normalCanvas.getContext("2d", { willReadFrequently: true });
    if (normalCtx) {
      normalCtx.clearRect(0, 0, source.width, source.height);
      normalCtx.drawImage(maxTextureSizeCanvas, 0, 0);
      const sample = normalCtx.getImageData(0, 0, source.width, source.height).data;
      let maxTilt = 0;
      for (let i = 0; i < sample.length; i += 4) {
        const nz = sample[i + 2] / 255 * 2 - 1;
        maxTilt = Math.max(maxTilt, Math.acos(Math.max(-1, Math.min(1, nz))));
      }
      setTilt(maxTilt * 180 / Math.PI);
    }

    gl.deleteTexture(inputTexture);
    gl.deleteTexture(targetA.texture);
    gl.deleteTexture(targetB.texture);
    gl.deleteFramebuffer(targetA.framebuffer);
    gl.deleteFramebuffer(targetB.framebuffer);
    gl.deleteProgram(lumaProgram);
    gl.deleteProgram(blurProgram);
    gl.deleteProgram(normalProgram);

    setNormalVersion((version) => version + 1);
    window.dispatchEvent(new CustomEvent("normal-map-updated"));
  }, [convention, gradient, invert, radius, source, strength]);

  useEffect(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(renderNormalMap);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [renderNormalMap]);

  useEffect(() => {
    let disposed = false;
    async function setupPreview() {
      if (!previewRef.current || !normalCanvasRef.current || !source || !hasNormalMap) return;
      cleanupPreviewRef.current?.();
      const [THREE, { OrbitControls }] = await Promise.all([
        import("three"),
        import("three/examples/jsm/controls/OrbitControls.js"),
      ]);
      if (disposed || !previewRef.current || !normalCanvasRef.current) return;
      const host = previewRef.current;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setClearColor(0x07080b, 1);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      host.innerHTML = "";
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
      camera.position.set(0, 0, 3.2);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.minDistance = 1.5;
      controls.maxDistance = 8;
      controls.minPolarAngle = Math.PI / 2 - THREE.MathUtils.degToRad(70);
      controls.maxPolarAngle = Math.PI / 2 + THREE.MathUtils.degToRad(70);
      controls.minAzimuthAngle = -THREE.MathUtils.degToRad(70);
      controls.maxAzimuthAngle = THREE.MathUtils.degToRad(70);

      const normalTexture = new THREE.CanvasTexture(normalCanvasRef.current);
      normalTexture.colorSpace = THREE.NoColorSpace;
      normalTexture.needsUpdate = true;
      const aspect = source.width / source.height;
      const planeWidth = aspect >= 1 ? aspect : 1;
      const planeHeight = aspect >= 1 ? 1 : 1 / aspect;
      const group = new THREE.Group();
      scene.add(group);

      const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight, 160, 100);
      const material = new THREE.MeshStandardMaterial({
        color: 0x1f2227,
        roughness: 0.5,
        metalness: 0.02,
        normalMap: normalTexture,
        normalScale: new THREE.Vector2(1, convention === "directx" ? -1 : 1),
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.z = 0.01;
      group.add(mesh);

      scene.add(new THREE.HemisphereLight(0xd9e2ff, 0x050609, 0.65));
      const light = new THREE.DirectionalLight(0xffffff, 4.75);
      light.position.set(1.6, 1.3, 2.6);
      scene.add(light);
      const fillLight = new THREE.DirectionalLight(0x80c7ff, 1.25);
      fillLight.position.set(-2.4, -1.1, 2.2);
      scene.add(fillLight);
      const rimLight = new THREE.DirectionalLight(0xe6fff2, 1.9);
      rimLight.position.set(-1.4, 2.0, 1.5);
      scene.add(rimLight);

      const resize = () => {
        const rect = host.getBoundingClientRect();
        renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), true);
        camera.aspect = Math.max(1, rect.width) / Math.max(1, rect.height);
        const verticalFov = camera.fov * Math.PI / 180;
        const fitHeightDistance = (planeHeight * 1.18) / (2 * Math.tan(verticalFov / 2));
        const fitWidthDistance = (planeWidth * 1.18) / (2 * Math.tan(verticalFov / 2) * camera.aspect);
        camera.position.z = Math.max(fitHeightDistance, fitWidthDistance) * 1.25;
        camera.updateProjectionMatrix();
        controls.update();
      };
      const moveLight = (event: PointerEvent) => {
        const rect = renderer.domElement.getBoundingClientRect();
        const x = (event.clientX - rect.left) / Math.max(rect.width, 1) * 2 - 1;
        const y = -((event.clientY - rect.top) / Math.max(rect.height, 1) * 2 - 1);
        light.position.set(x * 3, y * 3, 2.4);
      };
      const updateTexture = () => {
        normalTexture.needsUpdate = true;
        material.needsUpdate = true;
        material.normalScale.y = convention === "directx" ? -1 : 1;
      };
      window.addEventListener("resize", resize);
      window.addEventListener("normal-map-updated", updateTexture);
      renderer.domElement.addEventListener("pointermove", moveLight);
      resize();
      let frame = 0;
      const animate = () => {
        frame = requestAnimationFrame(animate);
        normalTexture.needsUpdate = true;
        material.normalMap = normalTexture;
        controls.update();
        renderer.render(scene, camera);
      };
      animate();
      cleanupPreviewRef.current = () => {
        cancelAnimationFrame(frame);
        window.removeEventListener("resize", resize);
        window.removeEventListener("normal-map-updated", updateTexture);
        renderer.domElement.removeEventListener("pointermove", moveLight);
        controls.dispose();
        geometry.dispose();
        material.dispose();
        normalTexture.dispose();
        renderer.dispose();
      };
    }
    setupPreview();
    return () => {
      disposed = true;
    };
  }, [convention, hasNormalMap, source]);

  useEffect(() => {
    return () => cleanupPreviewRef.current?.();
  }, []);

  const handleFile = async (file?: File) => {
    if (!file) return;
    try {
      setNormalVersion(0);
      setSource(await loadFile(file));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Image could not be loaded.");
    }
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    void handleFile(event.dataTransfer.files[0]);
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    void handleFile(event.target.files?.[0]);
    event.target.value = "";
  };

  const download = async () => {
    if (!normalCanvasRef.current || !source) return;
    const canvas = normalCanvasRef.current;
    const type = exportTypes[exportFormat];
    const filename = `${source.name}-normal.${type.extension}`;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    try {
      if (exportFormat === "tga") {
        downloadBlob(encodeTga(context.getImageData(0, 0, canvas.width, canvas.height)), filename);
      } else if (exportFormat === "tiff") {
        downloadBlob(encodeTiff(context.getImageData(0, 0, canvas.width, canvas.height)), filename);
      } else {
        downloadBlob(await canvasToBlob(canvas, type.mime, 1), filename);
      }
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "Export failed.");
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <h1>Normal Map Generator</h1>
          <p>Client-side heightmap to tangent-space normal map conversion.</p>
        </div>
        <div className="actions">
          <label className="button secondary">
            Open image
            <input className="sr-input" type="file" accept="image/*" onChange={handleChange} />
          </label>
          <button className="button" type="button" onClick={download} disabled={!source}>
            Download {exportTypes[exportFormat].label}
          </button>
        </div>
      </header>

      <section className="workspace">
        <aside className="controls">
          <label
            className="dropzone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
          >
            <span>
              <strong>Drop a heightmap</strong>
              PNG and other browser-decodable images are converted locally.
            </span>
            <input className="sr-input" type="file" accept="image/*" onChange={handleChange} />
          </label>

          <div className="control-group">
            <div className="field">
              <div className="field-row">
                <label htmlFor="strength">Strength</label>
                <span>{strength.toFixed(2)}</span>
              </div>
              <input id="strength" type="range" min="0" max="5" step="0.05" value={strength} onChange={(event) => setStrength(Number(event.target.value))} />
            </div>

            <div className="field">
              <div className="field-row">
                <label htmlFor="radius">Smooth radius</label>
                <span>{radius}px</span>
              </div>
              <input id="radius" type="range" min="0" max="24" step="1" value={radius} onChange={(event) => setRadius(Number(event.target.value))} />
              <p className="hint">Gaussian pre-blur uses sigma = radius / 3 with clamp-to-edge sampling.</p>
            </div>

            <div className="field">
              <div className="field-row">
                <label>Y convention</label>
              </div>
              <div className="segmented">
                <button className={convention === "opengl" ? "active" : ""} type="button" onClick={() => setConvention("opengl")}>OpenGL +Y (Blender)</button>
                <button className={convention === "directx" ? "active" : ""} type="button" onClick={() => setConvention("directx")}>DirectX -Y</button>
              </div>
            </div>

            <div className="field">
              <div className="field-row">
                <label>Height</label>
              </div>
              <div className="segmented">
                <button className={!invert ? "active" : ""} type="button" onClick={() => setInvert(false)}>White raised</button>
                <button className={invert ? "active" : ""} type="button" onClick={() => setInvert(true)}>Black raised</button>
              </div>
            </div>

            <div className="field">
              <div className="field-row">
                <label>Gradient</label>
              </div>
              <div className="segmented">
                <button className={gradient === "sobel" ? "active" : ""} type="button" onClick={() => setGradient("sobel")}>Sobel</button>
                <button className={gradient === "central" ? "active" : ""} type="button" onClick={() => setGradient("central")}>Central diff</button>
              </div>
            </div>

            <div className="field">
              <div className="field-row">
                <label htmlFor="export-format">Export</label>
              </div>
              <select id="export-format" className="select" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)}>
                {Object.entries(exportTypes).map(([value, type]) => (
                  <option key={value} value={value}>{type.label}</option>
                ))}
              </select>
              <p className="hint">PNG, TGA, and TIFF preserve alpha; JPEG and WebP are RGB-friendly preview formats.</p>
            </div>

            <div className="stat">
              <span>Source</span>
              <strong>{source ? `${source.width} x ${source.height}` : "No image"}</strong>
            </div>
            <div className="stat">
              <span>Max tilt</span>
              <strong>{tilt.toFixed(1)} deg</strong>
            </div>
            {error ? <p className="hint">{error}</p> : null}
          </div>
        </aside>

        <div className="panes">
          <section className="pane">
            <div className="pane-header"><strong>Source height</strong><span>{source?.name}</span></div>
            <div className="canvas-wrap"><canvas ref={sourceCanvasRef} className="fit-canvas" /></div>
          </section>
          <section className="pane">
            <div className="pane-header"><strong>Normal map</strong><span>RGBA PNG</span></div>
            <div className="canvas-wrap"><canvas ref={normalCanvasRef} className="fit-canvas" /></div>
          </section>
          <section className="pane">
            <div className="pane-header"><strong>Lit preview</strong><span>Drag light, orbit camera</span></div>
            <div className="preview-host" ref={previewRef} />
          </section>
        </div>
      </section>
    </main>
  );
}
