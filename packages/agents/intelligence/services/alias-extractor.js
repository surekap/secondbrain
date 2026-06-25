'use strict'

const TITLE_RE = /^(?:dr\.?|mr\.?|mrs\.?|ms\.?|prof\.?|shri|smt\.?|sri)\s+/i
const COMPANY_SUFFIX_RE = /\b(pvt\.\s*ltd\.?|private\s+limited|limited|ltd\.?|llp|inc\.?|corp\.?|corporation|gmbh|llc|plc)\b/gi

function normalized(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function contactAliases(contact = {}) {
  const display = String(contact.display_name || contact.name || '').trim()
  if (!display || display.length < 2) return []

  const aliases = new Set()
  const withoutTitle = display.replace(TITLE_RE, '').trim()
  const parts = withoutTitle.split(/\s+/)

  aliases.add(display)
  if (withoutTitle !== display) aliases.add(withoutTitle)

  if (parts.length >= 2) {
    aliases.add(parts[0])
    aliases.add(parts[parts.length - 1])
    if (parts.length >= 3) {
      aliases.add(parts.slice(0, 2).join(' '))
      aliases.add(parts.slice(-2).join(' '))
    }
  }

  return Array.from(aliases)
    .filter(a => a.length >= 2 && a !== display)
    .map(alias => ({
      entity_type: 'contact',
      entity_id: contact.id,
      alias,
      source: 'name_derivation',
      confidence: alias === withoutTitle ? 0.95 : 0.75,
    }))
}

function organizationAliases(org = {}) {
  const name = String(org.name || '').trim()
  if (!name || name.length < 3) return []

  const aliases = new Set()
  let short = name
    .replace(COMPANY_SUFFIX_RE, '')
    .replace(/\s*[,.]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  aliases.add(name)
  if (short !== name && short.length >= 3) aliases.add(short)

  const parts = name.split(/\s+/)
  if (parts.length >= 3) {
    const firstTwo = parts.slice(0, 2).join(' ')
    if (firstTwo.length >= 3) aliases.add(firstTwo)
  }

  return Array.from(aliases)
    .filter(a => a.length >= 3 && a !== name)
    .map(alias => ({
      entity_type: 'organization',
      entity_id: org.id,
      alias,
      source: 'name_derivation',
      confidence: alias === short ? 0.9 : 0.7,
    }))
}

function extractAliases(contacts = [], organizations = []) {
  const aliases = []
  for (const contact of contacts) {
    aliases.push(...contactAliases(contact))
  }
  for (const org of organizations) {
    aliases.push(...organizationAliases(org))
  }
  return aliases
}

module.exports = {
  contactAliases,
  organizationAliases,
  extractAliases,
  normalized,
}
