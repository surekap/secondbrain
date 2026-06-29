'use client'

import { useEffect } from 'react'

function isChunkError(message = '') {
  return /ChunkLoadError|Loading chunk|dynamically imported module|Failed to fetch dynamically imported module/i.test(message)
}

export default function Error({ error, reset }) {
  useEffect(() => {
    console.error('[secondbrain-ui:error]', error)
  }, [error])

  const chunkError = isChunkError(error?.message || '')

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', padding: '3rem 1.5rem 4rem', color: 'var(--text)' }}>
      <h1 style={{ fontFamily: 'Fraunces, serif', fontWeight: 300, fontSize: '2rem', margin: '0 0 .75rem' }}>SecondBrain hit a client error</h1>
      <p style={{ color: 'var(--text-3)', marginBottom: '1rem', lineHeight: 1.5 }}>
        The page failed to render. This is usually a stale browser chunk, a hydration problem, or a bad client-side exception.
      </p>
      {chunkError && (
        <div style={{ border: '1px solid var(--amber-border)', background: 'var(--amber-bg)', color: 'var(--amber)', borderRadius: 12, padding: '1rem', marginBottom: '1rem' }}>
          It looks like a missing or stale JS chunk. Hard refresh the page first; if it still fails, restart the UI process so Next rebuilds the client bundle.
        </div>
      )}
      <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '1rem', color: 'var(--text-2)', overflowX: 'auto' }}>
        {error?.message || 'Unknown client error'}
      </pre>
      <div style={{ display: 'flex', gap: '.75rem', marginTop: '1rem' }}>
        <button
          onClick={reset}
          style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', borderRadius: 8, padding: '.55rem .85rem', cursor: 'pointer' }}
        >
          Try again
        </button>
        <button
          onClick={() => window.location.reload()}
          style={{ border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', borderRadius: 8, padding: '.55rem .85rem', cursor: 'pointer' }}
        >
          Hard refresh
        </button>
      </div>
    </div>
  )
}
