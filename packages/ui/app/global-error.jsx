'use client'

import { useEffect } from 'react'

function isChunkError(message = '') {
  return /ChunkLoadError|Loading chunk|dynamically imported module|Failed to fetch dynamically imported module/i.test(message)
}

export default function GlobalError({ error, reset }) {
  useEffect(() => {
    console.error('[secondbrain-ui:global-error]', error)
  }, [error])

  const chunkError = isChunkError(error?.message || '')

  return (
    <html lang="en">
      <body style={{ margin: 0, background: 'var(--bg)', color: 'var(--text)', fontFamily: 'Inter, system-ui, sans-serif' }}>
        <main style={{ maxWidth: 900, margin: '0 auto', padding: '4rem 1.5rem' }}>
          <h1 style={{ fontFamily: 'Fraunces, serif', fontWeight: 300, fontSize: '2rem', margin: '0 0 .75rem' }}>SecondBrain crashed</h1>
          <p style={{ color: 'var(--text-3)', lineHeight: 1.5, marginBottom: '1rem' }}>
            The root UI shell failed. This is usually a stale bundle or a client exception that escaped the route boundary.
          </p>
          {chunkError && (
            <div style={{ border: '1px solid var(--amber-border)', background: 'var(--amber-bg)', color: 'var(--amber)', borderRadius: 12, padding: '1rem', marginBottom: '1rem' }}>
              Missing JS chunk suspected. Hard refresh first; if that fails, restart the UI process so the bundle is rebuilt.
            </div>
          )}
          <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '1rem', color: 'var(--text-2)', overflowX: 'auto' }}>
            {error?.message || 'Unknown global error'}
          </pre>
          <div style={{ display: 'flex', gap: '.75rem', marginTop: '1rem' }}>
            <button
              onClick={reset}
              style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', borderRadius: 8, padding: '.55rem .85rem', cursor: 'pointer' }}
            >
              Retry
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{ border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', borderRadius: 8, padding: '.55rem .85rem', cursor: 'pointer' }}
            >
              Hard refresh
            </button>
          </div>
        </main>
      </body>
    </html>
  )
}
