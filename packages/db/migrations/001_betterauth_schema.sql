-- BetterAuth schema migration
-- Generated from better-auth v1.4.18 with organization + apiKey plugins
-- DO NOT hand-edit — regenerate via: npx @better-auth/cli generate
-- PlanetScale/Vitess: no foreign key constraints

CREATE TABLE `user` (
  `id` VARCHAR(36) NOT NULL PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `email` VARCHAR(255) NOT NULL UNIQUE,
  `emailVerified` BOOLEAN NOT NULL DEFAULT FALSE,
  `image` VARCHAR(255),
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE `session` (
  `id` VARCHAR(36) NOT NULL PRIMARY KEY,
  `userId` VARCHAR(36) NOT NULL,
  `token` VARCHAR(255) NOT NULL UNIQUE,
  `expiresAt` DATETIME NOT NULL,
  `ipAddress` VARCHAR(255),
  `userAgent` VARCHAR(255),
  `activeOrganizationId` VARCHAR(36),
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE `account` (
  `id` VARCHAR(36) NOT NULL PRIMARY KEY,
  `userId` VARCHAR(36) NOT NULL,
  `accountId` VARCHAR(255) NOT NULL,
  `providerId` VARCHAR(255) NOT NULL,
  `accessToken` TEXT,
  `refreshToken` TEXT,
  `accessTokenExpiresAt` DATETIME,
  `refreshTokenExpiresAt` DATETIME,
  `scope` VARCHAR(255),
  `idToken` TEXT,
  `password` VARCHAR(255),
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE `verification` (
  `id` VARCHAR(36) NOT NULL PRIMARY KEY,
  `identifier` VARCHAR(255) NOT NULL,
  `value` VARCHAR(255) NOT NULL,
  `expiresAt` DATETIME NOT NULL,
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE `organization` (
  `id` VARCHAR(36) NOT NULL PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `slug` VARCHAR(255) NOT NULL UNIQUE,
  `logo` VARCHAR(255),
  `metadata` TEXT,
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE `member` (
  `id` VARCHAR(36) NOT NULL PRIMARY KEY,
  `organizationId` VARCHAR(36) NOT NULL,
  `userId` VARCHAR(36) NOT NULL,
  `role` VARCHAR(255) NOT NULL DEFAULT 'member',
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_member_org` (`organizationId`),
  INDEX `idx_member_user` (`userId`)
);

CREATE TABLE `invitation` (
  `id` VARCHAR(36) NOT NULL PRIMARY KEY,
  `organizationId` VARCHAR(36) NOT NULL,
  `email` VARCHAR(255) NOT NULL,
  `role` VARCHAR(255),
  `status` VARCHAR(255) NOT NULL DEFAULT 'pending',
  `expiresAt` DATETIME NOT NULL,
  `inviterId` VARCHAR(36) NOT NULL,
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_invitation_org` (`organizationId`),
  INDEX `idx_invitation_email` (`email`)
);

CREATE TABLE `apikey` (
  `id` VARCHAR(36) NOT NULL PRIMARY KEY,
  `name` VARCHAR(255),
  `start` VARCHAR(255),
  `prefix` VARCHAR(255),
  `key` VARCHAR(255) NOT NULL,
  `userId` VARCHAR(36) NOT NULL,
  `refillInterval` INT,
  `refillAmount` INT,
  `lastRefillAt` DATETIME,
  `enabled` BOOLEAN DEFAULT TRUE,
  `rateLimitEnabled` BOOLEAN DEFAULT TRUE,
  `rateLimitTimeWindow` INT,
  `rateLimitMax` INT,
  `requestCount` INT DEFAULT 0,
  `remaining` INT,
  `lastRequest` DATETIME,
  `expiresAt` DATETIME,
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `permissions` TEXT,
  `metadata` TEXT,
  INDEX `idx_apikey_key` (`key`),
  INDEX `idx_apikey_user` (`userId`)
);
