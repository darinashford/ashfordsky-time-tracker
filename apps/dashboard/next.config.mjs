/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Run workspace TS packages straight from source.
  transpilePackages: ['@tt/db', '@tt/shared', '@tt/resolvers'],
  // Keep the native pg driver out of the server bundle.
  experimental: {
    serverComponentsExternalPackages: ['pg'],
  },
};

export default nextConfig;
