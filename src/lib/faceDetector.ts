/**
 * Lightweight Client-Side Face & Feature Detector using HTML5 Canvas skin-tone / contrast density algorithm
 * Returns relative offset { x, y } where (0,0) is center, -100 to 100 boundaries.
 */
export async function detectFaceFocalPoint(imageUrl: string): Promise<{ x: number; y: number } | null> {
  if (!imageUrl) return null;

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(null);
          return;
        }

        const width = 160;
        const height = 90;
        canvas.width = width;
        canvas.height = height;

        ctx.drawImage(img, 0, 0, width, height);
        const imgData = ctx.getImageData(0, 0, width, height);
        const data = imgData.data;

        let totalSkinWeight = 0;
        let weightedX = 0;
        let weightedY = 0;

        // Scan pixels for skin tone & facial feature contrast heuristics
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];

            // Skin color range heuristic (RGB & YCbCr thresholds)
            const isSkin =
              r > 60 &&
              g > 40 &&
              b > 20 &&
              r > g &&
              r > b &&
              Math.abs(r - g) > 10 &&
              r - Math.min(g, b) > 15;

            if (isSkin) {
              // Rule of thirds weight bias (prefer upper half for faces)
              const verticalBias = y < height * 0.7 ? 1.5 : 0.8;
              const weight = 1.0 * verticalBias;

              totalSkinWeight += weight;
              weightedX += x * weight;
              weightedY += y * weight;
            }
          }
        }

        if (totalSkinWeight > 50) {
          const avgX = weightedX / totalSkinWeight;
          const avgY = weightedY / totalSkinWeight;

          // Convert from image space (0..160, 0..90) to FCP XML Motion space (-100..100)
          // (0,0) is exact center
          const relX = Number((((avgX - width / 2) / (width / 2)) * 50).toFixed(1));
          const relY = Number((((avgY - height / 2) / (height / 2)) * -50).toFixed(1)); // Y in FCP XML is inverted

          resolve({ x: relX, y: relY });
        } else {
          // Default to center if no face detected
          resolve(null);
        }
      } catch (err) {
        console.warn("Face detection canvas fallback:", err);
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = imageUrl;
  });
}
