import { defineModuleDrizzleConfig } from '../../../src/db/drizzle-config.js';

export default defineModuleDrizzleConfig({
  name: 'widgets',
  schema: './test/fixtures/widgets/schema.ts',
  out: './test/fixtures/widgets/drizzle',
});
