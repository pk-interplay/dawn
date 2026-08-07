/** @type {import('next').NextConfig} */
const nextConfig = {
  // The rail lives on the left edge now, and Next's dev-tools indicator defaults
  // to bottom-left — right on top of the rail's bottom icons. Move it to the
  // bottom-right so the two stop fighting. Dev-only; no effect on production.
  devIndicators: { position: "bottom-right" },

  // The agentmail SDK dynamically imports an optional payment dependency
  // (@x402/fetch) that we don't install or use. Keeping agentmail external to
  // the server bundle means Next doesn't try to statically resolve that import;
  // it stays a runtime require that never executes on our code paths.
  serverExternalPackages: ["agentmail"],
};

export default nextConfig;
