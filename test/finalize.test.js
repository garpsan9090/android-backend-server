const { finalizeInvestment } = require('../services/investmentEarnings');

jest.mock('../prisma', () => ({
  prisma: (() => {
    const txnCreateMany = jest.fn();
    const txnAggregate = jest.fn();
    const txnUpdate = jest.fn();

    return {
      transaction: {
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
      investmentEarning: {
        createMany: jest.fn(),
        aggregate: jest.fn(),
        findMany: jest.fn(),
      },
      holiday: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn((fn) => fn({
        investmentEarning: { createMany: txnCreateMany, aggregate: txnAggregate },
        transaction: { update: txnUpdate },
      })),
      // expose txn fns for assertions
      __txn: { txnCreateMany, txnAggregate, txnUpdate },
    };
  })(),
}));

const { prisma } = require('../prisma');

describe('finalizeInvestment', () => {
  beforeEach(() => jest.clearAllMocks());

  test('creates earnings and updates transaction', async () => {
    const txnId = 'test-inv-1';
    const createdAt = new Date('2026-07-01T00:00:00.000Z');
    prisma.transaction.findUnique.mockResolvedValue({ id: txnId, amount: 1000, returnPercent: 10, createdAt, investmentStartAt: createdAt, investmentDurationDays: 3 });
    // configure transaction-scoped mocks
    const txn = prisma.__txn;
    txn.txnCreateMany.mockResolvedValue({ count: 3 });
    txn.txnAggregate.mockResolvedValue({ _sum: { amount: 30 } });
    txn.txnUpdate.mockResolvedValue(true);

    await finalizeInvestment(txnId);

    expect(prisma.transaction.findUnique).toHaveBeenCalledWith({ where: { id: txnId } });
    expect(txn.txnCreateMany).toHaveBeenCalled();
    expect(txn.txnUpdate).toHaveBeenCalled();
  });
});
