(async () => {
  try {
    const { prisma } = require('./prisma');
    await prisma.$connect();
    console.log('PRISMA CONNECT OK');
    await prisma.$disconnect();
    process.exit(0);
  } catch (err) {
    console.error('PRISMA CONNECT ERROR');
    console.error(err);
    process.exit(1);
  }
})();
