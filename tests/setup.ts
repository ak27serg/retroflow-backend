import { prisma } from '../src/utils/prisma';
import { beforeAll, afterAll, beforeEach } from '@jest/globals';

// Global test setup
beforeAll(async () => {
  // Connect to test database
  console.log('Setting up test database...');
});

afterAll(async () => {
  // Clean up and disconnect
  console.log('Cleaning up test database...');
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Clean database before each test
  await cleanDatabase();
});

async function cleanDatabase() {
  const tablenames = await prisma.$queryRaw<
    Array<{ tablename: string }>
  >`SELECT tablename FROM pg_tables WHERE schemaname='public'`;

  const tables = tablenames
    .map(({ tablename }) => tablename)
    .filter((name) => name !== '_prisma_migrations')
    .map((name) => `"public"."${name}"`)
    .join(', ');

  try {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables} CASCADE;`);
  } catch (error) {
    console.log({ error });
  }
}

export { cleanDatabase };