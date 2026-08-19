export type NormalMapSettings = {
  strength: number;
  radius: number;
  flipY: boolean;
  gradientMode: 0 | 1;
  invert: boolean;
};

export type SourceImage = {
  name: string;
  width: number;
  height: number;
  imageData: ImageData;
};

type RenderTarget = {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
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
    const message = gl.getShaderInfoLog(shader) ?? "Shader compile failed.";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, fragmentSource: string) {
  const vertex = createShader(gl, gl.VERTEX_SHADER, vertexShader);
  const fragment = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to create program.");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? "Program link failed.";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function uniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string) {
  const location = gl.getUniformLocation(program, name);
  if (location === null) throw new Error(`Shader uniform ${name} is unavailable.`);
  return location;
}

function createInputTexture(gl: WebGL2RenderingContext, data: ImageData) {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Unable to create texture.");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  return texture;
}

function createTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  highPrecision: boolean,
): RenderTarget {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) throw new Error("Unable to create render target.");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    highPrecision ? gl.RGBA16F : gl.RGBA8,
    width,
    height,
    0,
    gl.RGBA,
    highPrecision ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
    null,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteTexture(texture);
    gl.deleteFramebuffer(framebuffer);
    throw new Error("Framebuffer is incomplete.");
  }
  return { texture, framebuffer };
}

export class NormalMapPipeline {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly lumaProgram: WebGLProgram;
  private readonly blurProgram: WebGLProgram;
  private readonly normalProgram: WebGLProgram;
  private inputTexture: WebGLTexture | null = null;
  private targetA: RenderTarget | null = null;
  private targetB: RenderTarget | null = null;
  private sourceData: ImageData | null = null;
  private width = 0;
  private height = 0;
  private highPrecision: boolean;

  constructor() {
    this.canvas = document.createElement("canvas");
    const gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error("WebGL2 is unavailable in this browser.");
    this.gl = gl;
    this.highPrecision = Boolean(gl.getExtension("EXT_color_buffer_float"));
    this.lumaProgram = createProgram(gl, lumaShader);
    this.blurProgram = createProgram(gl, blurShader);
    this.normalProgram = createProgram(gl, normalShader);
  }

  get precisionLabel() {
    return this.highPrecision ? "FP16" : "RGBA8";
  }

  setSource(data: ImageData) {
    if (this.sourceData === data) return;
    const gl = this.gl;
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (data.width > maxTextureSize || data.height > maxTextureSize) {
      throw new Error(`Image is ${data.width}×${data.height}, above this GPU limit of ${maxTextureSize}px.`);
    }

    this.releaseImageResources();
    this.canvas.width = data.width;
    this.canvas.height = data.height;
    this.width = data.width;
    this.height = data.height;
    this.sourceData = data;
    this.inputTexture = createInputTexture(gl, data);

    try {
      this.targetA = createTarget(gl, data.width, data.height, this.highPrecision);
      this.targetB = createTarget(gl, data.width, data.height, this.highPrecision);
    } catch (targetError) {
      if (!this.highPrecision) throw targetError;
      this.releaseTargets();
      this.highPrecision = false;
      this.targetA = createTarget(gl, data.width, data.height, false);
      this.targetB = createTarget(gl, data.width, data.height, false);
    }
  }

  render(settings: NormalMapSettings) {
    if (!this.inputTexture || !this.targetA || !this.targetB) {
      throw new Error("Load a source before rendering.");
    }
    const gl = this.gl;
    gl.viewport(0, 0, this.width, this.height);
    gl.activeTexture(gl.TEXTURE0);

    gl.useProgram(this.lumaProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targetA.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, this.inputTexture);
    gl.uniform1i(uniform(gl, this.lumaProgram, "uImage"), 0);
    gl.uniform1i(uniform(gl, this.lumaProgram, "uInvert"), settings.invert ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(this.blurProgram);
    gl.uniform1i(uniform(gl, this.blurProgram, "uImage"), 0);
    gl.uniform2f(uniform(gl, this.blurProgram, "uTexel"), 1 / this.width, 1 / this.height);
    gl.uniform1i(uniform(gl, this.blurProgram, "uRadius"), settings.radius);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targetB.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, this.targetA.texture);
    gl.uniform2f(uniform(gl, this.blurProgram, "uDirection"), 1, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targetA.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, this.targetB.texture);
    gl.uniform2f(uniform(gl, this.blurProgram, "uDirection"), 0, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(this.normalProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, this.targetA.texture);
    gl.uniform1i(uniform(gl, this.normalProgram, "uImage"), 0);
    gl.uniform2f(uniform(gl, this.normalProgram, "uTexel"), 1 / this.width, 1 / this.height);
    gl.uniform1f(uniform(gl, this.normalProgram, "uStrength"), settings.strength);
    gl.uniform1i(uniform(gl, this.normalProgram, "uFlipY"), settings.flipY ? 1 : 0);
    gl.uniform1i(uniform(gl, this.normalProgram, "uGradientMode"), settings.gradientMode);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  copyTo(output: HTMLCanvasElement) {
    output.width = this.width;
    output.height = this.height;
    const context = output.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas 2D is unavailable.");
    context.clearRect(0, 0, this.width, this.height);
    context.drawImage(this.canvas, 0, 0);
  }

  dispose() {
    this.releaseImageResources();
    this.gl.deleteProgram(this.lumaProgram);
    this.gl.deleteProgram(this.blurProgram);
    this.gl.deleteProgram(this.normalProgram);
  }

  private releaseTargets() {
    const gl = this.gl;
    for (const target of [this.targetA, this.targetB]) {
      if (!target) continue;
      gl.deleteTexture(target.texture);
      gl.deleteFramebuffer(target.framebuffer);
    }
    this.targetA = null;
    this.targetB = null;
  }

  private releaseImageResources() {
    if (this.inputTexture) this.gl.deleteTexture(this.inputTexture);
    this.inputTexture = null;
    this.releaseTargets();
    this.sourceData = null;
  }
}

export function createPreviewSource(source: SourceImage, maxDimension = 2048): SourceImage {
  const largestDimension = Math.max(source.width, source.height);
  if (largestDimension <= maxDimension) return source;
  const scale = maxDimension / largestDimension;
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const input = document.createElement("canvas");
  input.width = source.width;
  input.height = source.height;
  const inputContext = input.getContext("2d");
  if (!inputContext) throw new Error("Canvas 2D is unavailable.");
  inputContext.putImageData(source.imageData, 0, 0);

  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  const outputContext = output.getContext("2d", { willReadFrequently: true });
  if (!outputContext) throw new Error("Canvas 2D is unavailable.");
  outputContext.imageSmoothingEnabled = true;
  outputContext.imageSmoothingQuality = "high";
  outputContext.drawImage(input, 0, 0, width, height);
  return {
    ...source,
    width,
    height,
    imageData: outputContext.getImageData(0, 0, width, height),
  };
}

export function estimateMaxTilt(canvas: HTMLCanvasElement, sampleSize = 256) {
  const scale = Math.min(1, sampleSize / Math.max(canvas.width, canvas.height));
  const width = Math.max(1, Math.round(canvas.width * scale));
  const height = Math.max(1, Math.round(canvas.height * scale));
  const sample = document.createElement("canvas");
  sample.width = width;
  sample.height = height;
  const context = sample.getContext("2d", { willReadFrequently: true });
  if (!context) return 0;
  context.drawImage(canvas, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  let maxTilt = 0;
  for (let index = 2; index < pixels.length; index += 4) {
    const nz = pixels[index] / 255 * 2 - 1;
    maxTilt = Math.max(maxTilt, Math.acos(Math.max(-1, Math.min(1, nz))));
  }
  return maxTilt * 180 / Math.PI;
}
