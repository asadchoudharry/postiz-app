// Standalone jest config for the REKTRS suites (the repo root
// jest.config.ts needs @nx/jest, which is not installed in this tree —
// same approach as the W3/W4/W6 builds). Runs every rektrs spec.
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  roots: [
    '<rootDir>/libraries/nestjs-libraries/src/rektrs',
    '<rootDir>/libraries/nestjs-libraries/src/database/prisma/posts',
    '<rootDir>/apps/orchestrator/src/activities',
  ],
  testMatch: ['**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/libraries/nestjs-libraries/tsconfig.json',
        isolatedModules: true,
      },
    ],
  },
  moduleNameMapper: {
    '^@gitroom/nestjs-libraries/(.*)$':
      '<rootDir>/libraries/nestjs-libraries/src/$1',
    '^@gitroom/backend/(.*)$': '<rootDir>/apps/backend/src/$1',
    '^@gitroom/helpers/(.*)$': '<rootDir>/libraries/helpers/src/$1',
    '^@gitroom/orchestrator/(.*)$': '<rootDir>/apps/orchestrator/src/$1',
    '^@gitroom/react/(.*)$': '<rootDir>/libraries/react-shared-libraries/src/$1',
  },
};
