// packages/observe/server.js
'use strict'

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env.local') })

const express = require('express')
const path    = require('path')
const db      = require('@secondbrain/db')
const alerts  = require('./alerts')
const { createObserveRouter } = require('./routes')

const PORT = process.env.OBSERVE_PORT || 4002
const app  = express()

app.use(express.json())
app.use('/api', createObserveRouter(db))
app.use(express.static(path.join(__dirname, 'public')))

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' })
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// ── Start ─────────────────────────────────────────────────────────────────────
alerts.start(db)

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[observe] dashboard at http://localhost:${PORT}`)
})

process.on('SIGINT', () => { alerts.stop(); db.end(); process.exit(0) })
process.on('SIGTERM', () => { alerts.stop(); db.end(); process.exit(0) })
