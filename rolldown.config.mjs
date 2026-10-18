// Fast fallback build used when the local tsc bootstrap stalls on this host.
// The desktop app loads lib/index.js, so bundling the public entry keeps the
// runtime behavior identical while avoiding a platform-specific tsc hang.
export default {
  input: "src/index.ts",
  platform: "node",
  external: [/^@deepseek-ai\//, /^node:/],
  output: {
    file: "lib/index.js",
    format: "esm",
  },
};
