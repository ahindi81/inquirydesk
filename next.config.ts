import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Uploaded inquiry files can be up to 25 MB each.
  experimental: { serverActions: { bodySizeLimit: "30mb" } },
  serverExternalPackages: ["pdfkit", "exceljs", "unpdf"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
