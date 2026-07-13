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

  it('does not compile a bearer-token default into Apple bundles', () => {
    const tokenKey = 'ClawBridgeDefaultBearerToken';
    expect(read('apps/OpenClawWatch/project.yml')).not.toContain(tokenKey);
    expect(read('apps/OpenClawWatch/Sources/iOS/Info.plist')).not.toContain(tokenKey);
    expect(read('apps/OpenClawWatch/Sources/WatchExtension/Info.plist')).not.toContain(tokenKey);
    expect(read('apps/OpenClawWatch/Config/Bridge.local.example.xcconfig')).not.toContain(
      'CLAW_BRIDGE_DEFAULT_BEARER_TOKEN'
    );
  });
});
