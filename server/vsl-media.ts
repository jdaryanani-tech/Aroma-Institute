import type { Express } from "express";
import { Client } from "@replit/object-storage";

const VSL_OBJECT_PREFIX = "vsl/hls/v2/";
const SEGMENT_NAME_PATTERN = /^segment-\d{5}\.ts$/;
const PLAYLIST_NAME = "index.m3u8";

let storageClient: Client | undefined;

function getStorageClient() {
  return (storageClient ??= new Client());
}

export function registerVslMediaRoutes(app: Express) {
  app.get("/api/vsl/media/:assetName", async (req, res) => {
    const assetName = req.params.assetName;
    if (assetName !== PLAYLIST_NAME && !SEGMENT_NAME_PATTERN.test(assetName)) {
      return res.status(404).end();
    }

    const objectName = `${VSL_OBJECT_PREFIX}${assetName}`;
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "public, max-age=3600");

    if (assetName === PLAYLIST_NAME) {
      try {
        const result = await getStorageClient().downloadAsText(objectName);
        if (!result.ok) {
          return res.status(503).json({ message: "The VSL video is temporarily unavailable." });
        }
        res.type("application/vnd.apple.mpegurl");
        return res.send(result.value);
      } catch {
        return res.status(503).json({ message: "The VSL video is temporarily unavailable." });
      }
    }

    res.type("video/mp2t");
    const stream = getStorageClient().downloadAsStream(objectName);
    stream.once("error", () => {
      if (!res.headersSent) {
        res.status(503).json({ message: "The VSL video is temporarily unavailable." });
      } else if (!res.destroyed) {
        res.destroy();
      }
    });
    res.once("close", () => {
      if (!res.writableEnded) stream.destroy();
    });
    stream.pipe(res);
  });
}
