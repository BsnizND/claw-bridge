import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('Apple project metadata', () => {
  it('keeps the Apple marketing version aligned with the package release', () => {
    const packageVersion = JSON.parse(read('package.json')) as { version: string };
    const projectSpec = read('apps/OpenClawWatch/project.yml');
    const projectFile = read('apps/OpenClawWatch/OpenClawWatch.xcodeproj/project.pbxproj');
    const marketingVersion = projectSpec.match(/MARKETING_VERSION: "([^"]+)"/)?.[1];
    const buildVersion = projectSpec.match(/CURRENT_PROJECT_VERSION: "([^"]+)"/)?.[1];

    expect(marketingVersion).toBe(packageVersion.version);
    expect(buildVersion).toMatch(/^\d+$/);
    expect(projectFile.match(/MARKETING_VERSION = ([^;]+);/g)).toEqual([
      `MARKETING_VERSION = ${marketingVersion};`,
      `MARKETING_VERSION = ${marketingVersion};`
    ]);
    expect(projectFile.match(/CURRENT_PROJECT_VERSION = ([^;]+);/g)).toEqual([
      `CURRENT_PROJECT_VERSION = ${buildVersion};`,
      `CURRENT_PROJECT_VERSION = ${buildVersion};`
    ]);
  });

  it('keeps the legacy bundle credential bridge explicit and migration-only', () => {
    const projectSpec = read('apps/OpenClawWatch/project.yml');
    const legacyMigrationKey = 'ClawBridgeLegacyMigrationBearerToken';

    expect(projectSpec.match(new RegExp(legacyMigrationKey, 'g'))).toHaveLength(2);
    expect(read('apps/OpenClawWatch/Sources/iOS/Info.plist')).toContain(legacyMigrationKey);
    expect(read('apps/OpenClawWatch/Sources/WatchExtension/Info.plist')).toContain(legacyMigrationKey);
    expect(read('apps/OpenClawWatch/Config/Bridge.local.example.xcconfig')).toContain(
      'Remove this line for the next'
    );
    expect(projectSpec).not.toContain('ClawBridgeDefaultBearerToken:');
  });
});
