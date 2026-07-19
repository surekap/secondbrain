'use strict'
const fs = require('fs')

/**
 * Extract text from a file based on its mime type.
 * Returns a string of extracted text, or null if unsupported/failed.
 * @param {string} filePath
 * @param {string} mimeType
 * @param {number} [maxChars=3000]
 */
async function extractText(filePath, mimeType, maxChars = 3000) {
  if (!filePath || !fs.existsSync(filePath)) return null

  try {
    const mime = (mimeType || '').toLowerCase()

    // PDF
    if (mime.includes('pdf')) {
      const { PDFParse } = require('pdf-parse')
      const buf = fs.readFileSync(filePath)
      const parser = new PDFParse({ data: buf })
      try {
        const data = await parser.getText()
        return (data.text || '').slice(0, maxChars)
      } finally {
        await parser.destroy()
      }
    }

    // Excel / spreadsheet
    if (mime.includes('spreadsheet') || mime.includes('excel') ||
        mime.includes('xlsx') || mime.includes('xls') ||
        filePath.match(/\.(xlsx|xls|csv)$/i)) {
      const XLSX = require('xlsx')
      const wb = XLSX.readFile(filePath)
      const texts = []
      for (const sheetName of wb.SheetNames.slice(0, 3)) {
        const ws = wb.Sheets[sheetName]
        const csv = XLSX.utils.sheet_to_csv(ws)
        texts.push(`[Sheet: ${sheetName}]\n${csv}`)
      }
      return texts.join('\n\n').slice(0, maxChars)
    }

    // Word documents (extract raw text from XML)
    if (mime.includes('wordprocessingml') || mime.includes('msword') ||
        filePath.match(/\.(docx?)$/i)) {
      // Basic docx: unzip and read word/document.xml
      try {
        const AdmZip = require('adm-zip')
        const zip = new AdmZip(filePath)
        const entry = zip.getEntry('word/document.xml')
        if (entry) {
          const xml = entry.getData().toString('utf8')
          const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
          return text.slice(0, maxChars)
        }
      } catch {
        // adm-zip not available or not a docx
      }
      return null
    }

    // Plain text
    if (mime.includes('text/') || filePath.match(/\.(txt|md|csv)$/i)) {
      return fs.readFileSync(filePath, 'utf8').slice(0, maxChars)
    }

    return null
  } catch (err) {
    console.error('[docParser] extractText error:', err.message)
    return null
  }
}

module.exports = { extractText }
