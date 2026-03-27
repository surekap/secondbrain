import './globals.css'
import Navigation from '../components/Navigation'
import SearchOverlay from '../components/SearchOverlay'

export const metadata = {
  title: 'secondbrain',
  icons: {
    icon: '/logo.svg',
    shortcut: '/logo.svg',
    apple: '/logo.svg',
  },
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <Navigation />
        <main>{children}</main>
        <SearchOverlay />
      </body>
    </html>
  )
}
