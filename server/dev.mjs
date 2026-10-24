import { app } from "./app.mjs";
import express from "express";
import path from "node:path";
const port = Number(process.env.PORT || 3001);
if (process.env.SERVE_DIST === "true") {
  app.use(express.static(path.resolve("dist")));
  app.get("/{*splat}", (_, res) =>
    res.sendFile(path.resolve("dist/index.html")),
  );
}
app.listen(port, "127.0.0.1", () =>
  console.log(`Escala API ready at http://127.0.0.1:${port}`),
);
