import { execSync } from "node:child_process";
import { defineConfig } from "vite";

const buildBranch = (() => {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unbekannt";
  }
})();

const buildTimestamp = (() => {
  const now = new Date();
  const datePart = now.toLocaleDateString("de-DE");
  const timePart = now.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  return `${datePart} ${timePart}`;
})();

export default defineConfig({
  base: "./",
  define: {
    __BUILD_BRANCH__: JSON.stringify(buildBranch),
    __BUILD_TIME__: JSON.stringify(buildTimestamp),
  },
});
