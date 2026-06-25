const test = require('node:test');
const assert = require('node:assert/strict');
const { recommendContactTier, recommendContactTiers, nextTouchAt } = require('../services/contact-tierer');

test('contact-tierer: strong family/professional contacts become tier_1 with monthly cadence', () => {
  const rec = recommendContactTier({
    id: 1,
    display_name: 'Arun Sureka',
    relationship_type: 'family',
    relationship_strength: 'strong',
    comm_count: 30,
    insight_count: 3,
    is_noise: false,
    last_interaction_at: '2026-06-20T00:00:00Z',
  });

  assert.equal(rec.relationship_tier, 'tier_1');
  assert.equal(rec.preferred_cadence_days, 30);
  assert.equal(rec.dormant_threshold_days, 30);
  assert.ok(rec.strategic_importance_score >= 80);
});

test('contact-tierer: moderate active contacts become tier_2 with 60 day cadence', () => {
  const rec = recommendContactTier({
    id: 2,
    display_name: 'Operator Contact',
    relationship_type: 'professional_contact',
    relationship_strength: 'moderate',
    comm_count: 12,
    insight_count: 1,
    is_noise: false,
    last_interaction_at: '2026-06-01T00:00:00Z',
  });

  assert.equal(rec.relationship_tier, 'tier_2');
  assert.equal(rec.preferred_cadence_days, 60);
});

test('contact-tierer: weak stale contacts become tier_3 and noise remains noise', () => {
  assert.equal(recommendContactTier({ relationship_strength: 'weak', comm_count: 2 }).relationship_tier, 'tier_3');
  assert.equal(recommendContactTier({ is_noise: true, relationship_strength: 'strong', comm_count: 50 }).relationship_tier, 'noise');
});

test('contact-tierer: nextTouchAt is cadence after last interaction', () => {
  assert.equal(nextTouchAt('2026-06-01T00:00:00Z', 30).toISOString(), '2026-07-01T00:00:00.000Z');
});

test('contact-tierer: self contact is not a relationship obligation', () => {
  const rec = recommendContactTier({
    id: 284,
    display_name: 'Prateek Sureka',
    relationship_type: 'family',
    relationship_strength: 'strong',
    comm_count: 100,
    insight_count: 10,
    last_interaction_at: '2026-06-20T00:00:00Z',
  });

  assert.equal(rec.relationship_tier, 'noise');
  assert.equal(rec.next_suggested_touch_at, null);
  assert.equal(rec.intro_sensitivity, 'do_not_intro');
});

test('contact-tierer: duplicate display names keep only one next-touch obligation', () => {
  const recs = recommendContactTiers([
    { id: 55, display_name: 'Viaan Sureka', relationship_type: 'family', relationship_strength: 'moderate', comm_count: 30, last_interaction_at: '2026-03-19T05:26:40Z' },
    { id: 3082, display_name: 'Viaan Sureka', relationship_type: 'family', relationship_strength: 'moderate', comm_count: 30, last_interaction_at: '2026-03-19T05:26:40Z' },
  ]);

  const active = recs.filter(r => r.next_suggested_touch_at);
  const suppressed = recs.filter(r => r.duplicate_of_contact_id);
  assert.equal(active.length, 1);
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0].next_suggested_touch_at, null);
});
