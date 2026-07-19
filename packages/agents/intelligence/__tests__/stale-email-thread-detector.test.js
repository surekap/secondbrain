const test = require('node:test')
const assert = require('node:assert/strict')
const { detectStaleEmailThreads, stripReplyPrefix } = require('../services/stale-email-thread-detector')

test('stale-email-thread-detector: ignores a Phi drawdown thread that was later acknowledged', () => {
  const emails = [
    {
      id: 45615,
      thread_id: 'phi-drawdown',
      subject: 'Re: 4th Drawdown Notice for Phi Capital Growth Fund-1.6 - 20046',
      from_address: 'Niranjan Kumar Sharma <niranjan.kumar@hartex.in>',
      date: '2026-03-30T10:46:30.000Z',
      body_text: 'Please provide PAN, GST Certificate, Cancelled Cheque, MCA Master Data so we can proceed.',
    },
    {
      id: 45924,
      thread_id: 'phi-drawdown',
      subject: 'Re: 4th Drawdown Notice for Phi Capital Growth Fund-1.6 - 20046',
      from_address: 'Deepanshu Bhatia <db@phicapital.in>',
      date: '2026-04-02T06:57:26.000Z',
      body_text: 'Thanks Niranjan. Acknowledging receipt of the same.',
    },
  ]

  const stale = detectStaleEmailThreads(emails, { now: '2026-06-26T00:00:00Z', staleDays: 14 })
  assert.equal(stale.length, 0)
})

test('stale-email-thread-detector: promotes old internal follow-up awaiting external close', () => {
  const emails = [
    {
      id: 1,
      thread_id: 'sivaram-april',
      subject: 'Re: Follow up with Sivaram - Phi Capital',
      from_address: 'Prateek Sureka <ps@hartex.in>',
      date: '2026-04-08T08:00:00.000Z',
      body_text: 'Sivaram, please confirm the next steps and share the pending details at the earliest.',
    },
  ]

  const stale = detectStaleEmailThreads(emails, { now: '2026-06-26T00:00:00Z', staleDays: 14 })
  assert.equal(stale.length, 1)
  assert.equal(stale[0].pending_direction, 'awaiting_external_response')
  assert.match(stale[0].title, /Sivaram|Phi Capital/i)
  assert.match(stale[0].recommended_next_action, /Follow up/)
})

test('stale-email-thread-detector: promotes old external request with no later close', () => {
  const emails = [
    {
      id: 2,
      thread_id: 'external-request',
      subject: 'Need confirmation on documents',
      from_address: 'Sivaram Padmanabhan <sivaram@phicapital.in>',
      date: '2026-04-10T08:00:00.000Z',
      body_text: 'Please confirm and send the documents required to proceed.',
    },
  ]

  const stale = detectStaleEmailThreads(emails, { now: '2026-06-26T00:00:00Z', staleDays: 14 })
  assert.equal(stale.length, 1)
  assert.equal(stale[0].pending_direction, 'external_request_unresolved')
  assert.match(stale[0].recommended_next_action, /Reply or delegate/)
})

test('stale-email-thread-detector: treats corrected operational reporting as closure', () => {
  const emails = [
    {
      id: 31,
      thread_id: 'oem-may-collections',
      subject: 'Re: Collection report up to 14-06-2026',
      from_address: 'Navneet Chabra <navneet.chabra@hartex.in>',
      date: '2026-06-16T22:19:27.000Z',
      body_text: 'OEM collections for May are reflected as ₹5.80 Cr although actual collections exceed ₹12 Cr. Kindly rectify.',
    },
    {
      id: 32,
      thread_id: 'oem-may-collections',
      subject: 'Re: Collection report up to 16-06-2026',
      from_address: 'Raja Sudhakar <raja.sudhakar@hartex.in>',
      date: '2026-06-17T08:44:16.000Z',
      body_text: 'The observation for May 2026 has been addressed and the necessary correction has been implemented.',
    },
  ]

  const stale = detectStaleEmailThreads(emails, { now: '2026-07-19T00:00:00Z', staleDays: 14 })
  assert.equal(stale.length, 0)
})

test('stale-email-thread-detector: strips repeated reply prefixes', () => {
  assert.equal(stripReplyPrefix('Re: Fwd: RE:  Test subject'), 'Test subject')
})

test('stale-email-thread-detector: ignores newsletters, itineraries, and bulk transactional mail', () => {
  const emails = [
    { id: 10, subject: 'Unlock AI-driven insights with Dell', from_address: 'Dell Technologies <DellTechnologies_APJ@comm.delltechnologies.com>', date: '2026-06-01T00:00:00Z', body_text: 'View Online unsubscribe please click to learn more' },
    { id: 11, subject: 'Your IndiGo Itinerary - OB88MG', from_address: 'IndiGo <reservations@customer.goindigo.in>', date: '2026-06-01T00:00:00Z', body_text: 'Payment Status CONFIRMED Please arrive at airport' },
    { id: 12, subject: 'Payment Advice::PRATEEK SUREKA::SUREKA', from_address: 'Straight2axis@axis.bank.in', date: '2026-06-01T00:00:00Z', body_text: 'This is a system generated email. Please do not reply to this mail.' },
    { id: 13, subject: 'Invitation: Prateek Sir Meeting @ Tue Jun 2, 2026', from_address: 'Avisek <avisek@example.com>', date: '2026-06-01T00:00:00Z', body_text: 'Join with Google Meet Join Zoom Meeting' },
    { id: 14, subject: 'Your pre-sale is live! "Kisi Aur Ka" is on iTunes', from_address: 'DistroKid <mailbot@distrokid.com>', date: '2026-06-01T00:00:00Z', body_text: 'Hi, your single is live on iTunes' },
    { id: 15, subject: 'ACTION: Connect with your South Asia - Members MicroForum Pair!', from_address: 'MicroForum <microforum@ypo.org>', date: '2026-06-01T00:00:00Z', body_text: 'DO NOT REPLY TO THIS EMAIL Please contact your peer' },
    { id: 16, subject: 'Pending Invoices Awaiting Your Approval', from_address: 'help@grapevine.hartex.in', date: '2026-06-01T00:00:00Z', body_text: 'SPIC - Invoice Approval Required. This is an automated notification from SPIC. Please do not reply to this email.' },
    { id: 17, subject: 'This Month at Penn Engineering: May 2026', from_address: 'Penn Engineering News <info@seas.upenn.edu>', date: '2026-06-01T00:00:00Z', body_text: 'Newsletter graduation highlights please view online unsubscribe' },
    { id: 18, subject: 'Sandbox scheduled a new maintenance - Scheduled Disaster Recovery Drill', from_address: 'alert@sandbox.co.in', date: '2026-06-01T00:00:00Z', body_text: 'Please be informed maintenance is scheduled' },
    { id: 19, subject: 'May Updates: Simplifying probation, payroll & goal tracking', from_address: 'Abinaya from KekaHR <abinaya.s@kekahr.com>', date: '2026-06-01T00:00:00Z', body_text: 'What is new in Keka product updates please read more unsubscribe' },
  ]
  const stale = detectStaleEmailThreads(emails, { now: '2026-06-26T00:00:00Z', staleDays: 14 })
  assert.equal(stale.length, 0)
})
