import type { NextConfig } from "next";
import path from "node:path";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: [
    "better-sqlite3",
    // Dynamic require() paths inside installers — must not be bundled
    "@ffmpeg-installer/ffmpeg",
    "@ffprobe-installer/ffprobe",
  ],
  turbopack: {
    root: path.resolve(process.cwd()),
  },
};

export default withNextIntl(nextConfig);
