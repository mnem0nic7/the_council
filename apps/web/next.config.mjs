/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    optimizePackageImports: ["framer-motion", "@react-three/drei"]
  },
  transpilePackages: ["@the-council/contracts"]
};

export default nextConfig;
