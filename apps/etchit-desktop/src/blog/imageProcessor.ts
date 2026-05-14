// Image processor — every image that enters a Blogger slot goes through
// this pipeline before it touches state, the preview, or the network.
//
// The mechanism is a canvas re-encode: decode the file into an HTMLImageElement,
// draw it onto a canvas at a resized scale, then read the canvas back as a
// WebP blob. Canvas only carries pixel data, so EXIF / GPS / camera-serial /
// timestamp metadata cannot survive the round trip — re-encoding *is* the
// strip. That's the privacy guarantee: the user doesn't have to know what
// EXIF is, and the bytes they publish carry none of it.
//
// Why also resize and re-encode?
// - Resize: phone photos are typically 4032×3024 ≈ 4-12 MB. A blog post
//   reads at most ~1200px wide. Anything bigger is wasted bytes and
//   wasted gas — the user pays per chunk to publish.
// - WebP: typically 25-40% smaller than JPEG at equivalent quality.
//   Universally supported in the Tauri WebView and in fetchit's renderer.
//
// Animated GIFs collapse to a single frame here (the canvas only draws the
// current frame). For animated content the user can route through Etch's
// file mode, which is a raw passthrough.

const MAX_DIMENSION_PX = 1920;
const WEBP_QUALITY = 0.85;
const OUTPUT_TYPE = "image/webp";

export interface ProcessedImage {
  dataUrl: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  originalSizeBytes: number;
}

export async function processImage(file: File): Promise<ProcessedImage> {
  if (!file.type.startsWith("image/")) {
    throw new Error("not an image");
  }
  const originalSize = file.size;
  const img = await decodeFile(file);
  const { width, height } = fitDimensions(
    img.naturalWidth || img.width,
    img.naturalHeight || img.height,
    MAX_DIMENSION_PX,
  );
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2D context unavailable");
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await canvasToBlob(canvas, OUTPUT_TYPE, WEBP_QUALITY);
  const dataUrl = await blobToDataUrl(blob);
  return {
    dataUrl,
    mimeType: blob.type,
    sizeBytes: blob.size,
    width,
    height,
    originalSizeBytes: originalSize,
  };
}

function decodeFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("couldn't decode image — unsupported format?"));
    };
    img.src = url;
  });
}

export function fitDimensions(
  srcW: number,
  srcH: number,
  maxDim: number,
): { width: number; height: number } {
  if (srcW <= maxDim && srcH <= maxDim) return { width: srcW, height: srcH };
  const scale = srcW > srcH ? maxDim / srcW : maxDim / srcH;
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("canvas.toBlob returned null"))),
      type,
      quality,
    );
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}
