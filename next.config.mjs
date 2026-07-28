/** @type {import('next').NextConfig} */
const nextConfig = {
  // The agentmail SDK dynamically imports an optional payment dependency
  // (@x402/fetch) that we don't install or use. Keeping agentmail external to
  // the server bundle means Next doesn't try to statically resolve that import;
  // it stays a runtime require that never executes on our code paths.
  serverExternalPackages: ["agentmail"],
};

export default nextConfig;
