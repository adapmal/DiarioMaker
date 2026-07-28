/**
 * Resizes and compresses an image file using an HTML5 Canvas to prevent giant payloads.
 * Ideal for sending base64 references to generative APIs.
 * @param file The uploaded file
 * @param maxDim Maximum width or height
 * @param quality JPEG compression quality (0.0 to 1.0)
 */
export function resizeAndCompressImage(file: File, maxDim: number = 800, quality: number = 0.75): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("O arquivo fornecido não é uma imagem válida."));
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let width = img.width;
        let height = img.height;

        // Calculate aspect-ratio preserving dimensions
        if (width > height) {
          if (width > maxDim) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          }
        } else {
          if (height > maxDim) {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(e.target?.result as string);
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve(dataUrl);
      };
      img.onerror = () => {
        reject(new Error("Falha ao carregar os dados da imagem."));
      };
      img.src = e.target?.result as string;
    };
    reader.onerror = () => {
      reject(new Error("Falha ao ler o arquivo físico."));
    };
    reader.readAsDataURL(file);
  });
}
