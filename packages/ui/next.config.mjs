/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:4001/api/:path*',
      },
      {
        source: '/observe-api/:path*',
        destination: 'http://localhost:4002/:path*',
      },
    ]
  },
}
export default nextConfig
