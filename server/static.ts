import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(
  app: Express,
  publicDir = path.resolve(__dirname, "public"),
) {
  const distPath = publicDir;
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath));

  // Do not let the SPA fallback disguise a missing API route as a successful
  // HTML response. API clients should receive an explicit, machine-readable
  // 404 when a route is not registered in this server revision.
  app.use((req, res, next) => {
    if (req.path === "/api" || req.path.startsWith("/api/")) {
      return void res.status(404).json({ code: "api_route_not_found" });
    }
    return next();
  });

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
