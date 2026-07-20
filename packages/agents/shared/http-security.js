'use strict'

const crypto = require('node:crypto')

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const LOCAL_UI_ORIGINS = new Set([
  'http://localhost:4000',
  'http://127.0.0.1:4000',
  'http://[::1]:4000',
])

function normalizedOrigin(value) {
  if (!value) return null
  try {
    const url = new URL(String(value).trim())
    if (!['http:', 'https:'].includes(url.protocol)) return null
    return url.origin
  } catch (_) {
    return null
  }
}

function configuredOrigins(value = process.env.SECOND_BRAIN_ALLOWED_ORIGINS) {
  const origins = new Set(LOCAL_UI_ORIGINS)
  for (const candidate of String(value || '').split(',')) {
    const origin = normalizedOrigin(candidate)
    if (origin) origins.add(origin)
  }
  return origins
}

function firstForwardedValue(value) {
  return String(value || '').split(',')[0].trim()
}

function isSameOriginMutation(req, options = {}) {
  if (SAFE_METHODS.has(String(req.method || 'GET').toUpperCase())) return true

  const fetchSite = String(req.get?.('sec-fetch-site') || '').toLowerCase()
  if (fetchSite === 'cross-site') return false

  const rawOrigin = req.get?.('origin')
  // Non-browser callers such as local maintenance scripts normally omit Origin.
  // The network listener is loopback-only; browser requests always send Origin
  // for the JSON mutations used by this application.
  if (!rawOrigin) return true

  const origin = normalizedOrigin(rawOrigin)
  if (!origin) return false

  const allowed = options.allowedOrigins || configuredOrigins(options.allowedOriginsValue)
  if (allowed.has(origin)) return true

  const forwardedHost = firstForwardedValue(req.get?.('x-forwarded-host'))
  const requestHost = forwardedHost || firstForwardedValue(req.get?.('host'))
  const forwardedProto = firstForwardedValue(req.get?.('x-forwarded-proto'))
  const requestProto = forwardedProto || req.protocol || 'http'
  return origin === normalizedOrigin(`${requestProto}://${requestHost}`)
}

function requireSameOrigin(options = {}) {
  return (req, res, next) => {
    if (isSameOriginMutation(req, options)) return next()
    return res.status(403).json({ error: 'Cross-origin mutation rejected' })
  }
}

function secureTokenEqual(expected, supplied) {
  if (!expected || !supplied) return false
  const expectedDigest = crypto.createHash('sha256').update(String(expected)).digest()
  const suppliedDigest = crypto.createHash('sha256').update(String(supplied)).digest()
  return crypto.timingSafeEqual(expectedDigest, suppliedDigest)
}

module.exports = {
  configuredOrigins,
  isSameOriginMutation,
  requireSameOrigin,
  secureTokenEqual,
}
