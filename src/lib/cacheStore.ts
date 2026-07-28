/**
 * IndexedDB Local Image Cache Manager for Ethos Storyboard Builder
 * Resolves performance bottleneck by offloading massive base64 image strings 
 * from synchronous localStorage and React state serialization into asynchronous,
 * structured browser storage.
 */

const DB_NAME = "ethos_storyboard_cache_db";
const STORE_NAME = "image_cache";
const DB_VERSION = 1;

let dbInstance: IDBDatabase | null = null;

/**
 * Initialize and open IndexedDB connection.
 */
function getDb(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    try {
      if (!window.indexedDB) {
        throw new Error("IndexedDB não é suportado pelo seu navegador.");
      }

      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };

      request.onsuccess = () => {
        dbInstance = request.result;
        resolve(dbInstance);
      };

      request.onerror = (event) => {
        console.error("Erro ao inicializar cache de imagens (IndexedDB):", request.error);
        reject(request.error);
      };
    } catch (err) {
      console.error("IndexedDB não disponível:", err);
      reject(err);
    }
  });
}

/**
 * Retorna uma imagem cacheada (base64) a partir de uma chave única.
 */
export async function getCachedImage(key: string): Promise<string | null> {
  if (!key) return null;
  try {
    const db = await getDb();
    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);

      request.onsuccess = () => {
        if (request.result) {
          resolve(request.result.data);
        } else {
          resolve(null);
        }
      };

      request.onerror = () => {
        resolve(null);
      };
    });
  } catch (err) {
    return null;
  }
}

/**
 * Salva uma imagem (base64) no cache local IndexedDB.
 */
export async function setCachedImage(key: string, base64Data: string): Promise<void> {
  if (!key || !base64Data) return;
  try {
    const db = await getDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put({ key, data: base64Data, timestamp: Date.now() });

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn("Falha ao salvar imagem no cache local IndexedDB:", err);
  }
}

/**
 * Remove um item específico do cache.
 */
export async function deleteCachedImage(key: string): Promise<void> {
  if (!key) return;
  try {
    const db = await getDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(key);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn("Falha ao deletar do cache:", err);
  }
}

/**
 * Retorna o tamanho aproximado em megabytes do cache local ocupado.
 */
export async function getCacheSizeMB(): Promise<number> {
  try {
    const db = await getDb();
    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const items = request.result || [];
        let totalChars = 0;
        for (const item of items) {
          if (item.data && typeof item.data === "string") {
            totalChars += item.data.length;
          }
        }
        // Base64 string length is roughly equivalent to size in bytes. 1024 * 1024 = 1MB.
        const sizeInMB = totalChars / (1024 * 1024);
        resolve(parseFloat(sizeInMB.toFixed(2)));
      };

      request.onerror = () => {
        resolve(0);
      };
    });
  } catch (err) {
    return 0;
  }
}

/**
 * Limpa completamente o cache de imagens do IndexedDB.
 */
export async function clearCache(): Promise<void> {
  try {
    const db = await getDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error("Falha ao limpar cache IndexedDB:", err);
  }
}
