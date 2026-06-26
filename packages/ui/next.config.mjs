/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ['100.105.11.84'],
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:4001/api/:path*',
      },
    ]
  },
}
export default nextConfig
