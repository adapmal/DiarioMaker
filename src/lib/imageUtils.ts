import { getCachedImage } from "./cacheStore";

/**
 * Converts any image URL (idb://, data:image/svg+xml, data:image/png, http://, etc.)
 * into a clean, proper Blob and extension (e.g. png/jpg) for download or ZIP archiving.
 * 
 * SVG images are rendered onto a 16:9 1920x1080 canvas to guarantee a true PNG binary image
 * without distortion, ratio stretching, or file corruption.
 */
export async function prepareImageBlobForDownload(
  rawUrl: string,
  targetWidth = 1920,
  targetHeight = 1080
): Promise<{ blob: Blob; ext: string }> {
  let url = rawUrl;
  if (!url) {
    throw new Error("URL da imagem está vazia.");
  }

  // 1. Resolve IndexedDB cache if URL uses idb:// scheme
  if (url.startsWith("idb://")) {
    const key = url.replace("idb://", "");
    const cachedData = await getCachedImage(key);
    if (cachedData) {
      url = cachedData;
    } else {
      throw new Error("Imagem não encontrada no cache local (IndexedDB).");
    }
  }

  // 2. SVG Data URL -> Render to 16:9 Canvas (1920x1080) for real 100% PNG conversion
  if (url.startsWith("data:image/svg+xml")) {
    return renderSvgToPngBlob(url, targetWidth, targetHeight);
  }

  // 3. Base64 Data URL (data:image/png;base64,... data:image/jpeg;base64,...)
  if (url.startsWith("data:")) {
    const commaIndex = url.indexOf(",");
    if (commaIndex !== -1) {
      const mimeMatch = url.match(/data:image\/([a-zA-Z0-9+.-]+);/);
      let ext = "png";
      let mimeType = "image/png";
      if (mimeMatch && mimeMatch[1]) {
        const rawExt = mimeMatch[1].toLowerCase();
        if (rawExt.includes("jpeg") || rawExt.includes("jpg")) ext = "jpg";
        else if (rawExt.includes("webp")) ext = "webp";
        else if (rawExt.includes("gif")) ext = "gif";
        else if (rawExt.includes("svg")) {
          return renderSvgToPngBlob(url, targetWidth, targetHeight);
        }
        mimeType = mimeMatch[0].replace(";", "");
      }

      const base64Data = url.substring(commaIndex + 1);
      const binaryStr = atob(base64Data);
      const len = binaryStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: mimeType });
      return { blob, ext };
    }
  }

  // 4. Remote HTTP/HTTPS URL
  try {
    const response = await fetch(url, { referrerPolicy: "no-referrer" });
    if (!response.ok) {
      throw new Error(`Status de rede inválido (${response.status}) ao baixar imagem.`);
    }
    const blob = await response.blob();
    let ext = "jpg";
    if (blob.type.includes("png")) ext = "png";
    else if (blob.type.includes("webp")) ext = "webp";
    else if (blob.type.includes("svg")) {
      const svgTextUrl = URL.createObjectURL(blob);
      try {
        const result = await renderSvgToPngBlob(svgTextUrl, targetWidth, targetHeight);
        return result;
      } finally {
        URL.revokeObjectURL(svgTextUrl);
      }
    }
    return { blob, ext };
  } catch (err: any) {
    throw new Error(`Erro ao buscar imagem remota: ${err.message || err}`);
  }
}

/**
 * Helper to render an SVG data/blob URL onto an offscreen canvas and export as PNG Blob
 */
function renderSvgToPngBlob(
  svgUrl: string,
  targetWidth: number,
  targetHeight: number
): Promise<{ blob: Blob; ext: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const naturalW = img.naturalWidth || img.width || 1200;
        const naturalH = img.naturalHeight || img.height || 675;

        // Use natural aspect ratio or target 16:9 while preserving exact proportions
        let renderW = targetWidth;
        let renderH = targetHeight;

        if (naturalW > 0 && naturalH > 0) {
          const aspectRatio = naturalW / naturalH;
          // Maintain original resolution if larger than 1200px, otherwise scale up to 1920x1080 proportionally
          renderW = Math.max(naturalW, 1920);
          renderH = Math.round(renderW / aspectRatio);
        }

        const canvasW = targetWidth || 1920;
        const canvasH = targetHeight || 1080;

        const canvas = document.createElement("canvas");
        canvas.width = canvasW;
        canvas.height = canvasH;

        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Contexto 2D do Canvas indisponível"));
          return;
        }

        // Fill solid dark background to prevent transparency holes
        ctx.fillStyle = "#111827";
        ctx.fillRect(0, 0, canvasW, canvasH);

        // Calculate center-crop cover math to prevent any distortion/stretching
        const imgRatio = naturalW / naturalH;
        const canvasRatio = canvasW / canvasH;

        let drawW = canvasW;
        let drawH = canvasH;
        let offsetX = 0;
        let offsetY = 0;

        if (imgRatio > canvasRatio) {
          drawW = canvasH * imgRatio;
          offsetX = (canvasW - drawW) / 2;
        } else {
          drawH = canvasW / imgRatio;
          offsetY = (canvasH - drawH) / 2;
        }

        // Draw image perfectly center-cropped into 16:9 canvas
        ctx.drawImage(img, offsetX, offsetY, drawW, drawH);

        canvas.toBlob((blob) => {
          if (blob) {
            resolve({ blob, ext: "png" });
          } else {
            reject(new Error("Falha ao exportar Canvas para Blob PNG"));
          }
        }, "image/png", 0.95);
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => {
      reject(new Error("Não foi possível carregar a imagem para renderização em PNG."));
    };
    img.src = svgUrl;
  });
}

/**
 * Helper to trigger a direct file download in browser
 */
export async function downloadSingleImageFile(
  imageUrl: string,
  filename: string
): Promise<void> {
  const { blob, ext } = await prepareImageBlobForDownload(imageUrl);
  const cleanFilename = filename.endsWith(`.${ext}`) ? filename : `${filename}.${ext}`;
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = cleanFilename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(objectUrl);
}
