const test = require('node:test');
const assert = require('node:assert/strict');

const { buildWeeklyEarningsSummary } = require('../services/investmentEarnings');

test('buildWeeklyEarningsSummary shows total unclaimed balance and unlocks claim after 5 trading days', () => {
  const now = new Date('2026-08-17T12:00:00+05:30');
  const earnings = [
    { creditedAt: new Date('2026-08-17T00:00:00+05:30'), amount: 100, status: 'unclaimed' },
    { creditedAt: new Date('2026-08-18T00:00:00+05:30'), amount: 120, status: 'unclaimed' },
    { creditedAt: new Date('2026-08-19T00:00:00+05:30'), amount: 140, status: 'unclaimed' },
    { creditedAt: new Date('2026-08-20T00:00:00+05:30'), amount: 160, status: 'unclaimed' },
    { creditedAt: new Date('2026-08-21T00:00:00+05:30'), amount: 180, status: 'unclaimed' },
  ];

  const summary = buildWeeklyEarningsSummary(earnings, now);

  assert.equal(summary.totalUnclaimed, 700);
  assert.equal(summary.completedTradingDays, 5);
  assert.equal(summary.claimAllowed, true);
  assert.equal(summary.alreadyClaimed, false);
});

test('buildWeeklyEarningsSummary resets to zero after the week is claimed', () => {
  const now = new Date('2026-08-17T12:00:00+05:30');
  const earnings = [
    { creditedAt: new Date('2026-08-17T00:00:00+05:30'), amount: 100, status: 'claimed', claimedAt: new Date('2026-08-18T00:00:00+05:30') },
    { creditedAt: new Date('2026-08-18T00:00:00+05:30'), amount: 120, status: 'claimed', claimedAt: new Date('2026-08-19T00:00:00+05:30') },
    { creditedAt: new Date('2026-08-19T00:00:00+05:30'), amount: 140, status: 'claimed', claimedAt: new Date('2026-08-20T00:00:00+05:30') },
    { creditedAt: new Date('2026-08-20T00:00:00+05:30'), amount: 160, status: 'claimed', claimedAt: new Date('2026-08-21T00:00:00+05:30') },
    { creditedAt: new Date('2026-08-21T00:00:00+05:30'), amount: 180, status: 'claimed', claimedAt: new Date('2026-08-22T00:00:00+05:30') },
  ];

  const summary = buildWeeklyEarningsSummary(earnings, now);

  assert.equal(summary.totalUnclaimed, 0);
  assert.equal(summary.completedTradingDays, 0);
  assert.equal(summary.alreadyClaimed, true);
  assert.equal(summary.claimAllowed, false);
});
