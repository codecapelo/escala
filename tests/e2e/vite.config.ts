import { defineConfig } from "vite";
import appConfig from "../../vite.config";
// Reuse the application's filesystem security policy; only the test ports differ.
export default defineConfig({
  ...appConfig,
  server: {
    ...appConfig.server,
    host: "127.0.0.1",
    port: 5273,
    proxy: { "/api": "http://127.0.0.1:3101" },
  },
});
