import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
  },
});
