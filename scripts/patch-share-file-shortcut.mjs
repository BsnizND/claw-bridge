#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const shortcutPath = process.argv[2];

if (!shortcutPath) {
  console.error('Usage: patch-share-file-shortcut.mjs <unsigned-shortcut>');
  process.exit(2);
}

if (!existsSync(shortcutPath)) {
  console.error(`ERROR: shortcut file not found: ${shortcutPath}`);
  process.exit(2);
}

const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-shortcut-patch-'));
const jsonPath = join(tempDir, 'shortcut.json');

function plistContainsString(value, needle) {
  if (typeof value === 'string') {
    return value.includes(needle);
  }
  if (Array.isArray(value)) {
    return value.some((item) => plistContainsString(item, needle));
  }
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => plistContainsString(item, needle));
  }
  return false;
}

try {
  execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', jsonPath, shortcutPath], { stdio: 'pipe' });
  const workflow = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const actions = workflow.WFWorkflowActions;

  if (!Array.isArray(actions)) {
    throw new Error('WFWorkflowActions is missing from compiled shortcut');
  }

  const requestIndex = actions.findIndex((action) => {
    const params = action?.WFWorkflowActionParameters;
    return (
      action?.WFWorkflowActionIdentifier === 'is.workflow.actions.downloadurl' &&
      plistContainsString(params?.WFURL, '/shortcuts/share-file')
    );
  });

  if (requestIndex === -1) {
    throw new Error('could not find /shortcuts/share-file Get Contents of URL action');
  }

  const params = actions[requestIndex].WFWorkflowActionParameters;
  params.WFHTTPMethod = 'POST';
  params.WFHTTPBodyType = 'File';
  delete params.WFFormValues;
  delete params.WFJSONValues;
  params.WFRequestVariable = {
    Value: {
      Type: 'Variable',
      VariableName: 'firstImage'
    },
    WFSerializationType: 'WFTextTokenAttachment'
  };

  writeFileSync(jsonPath, JSON.stringify(workflow), 'utf8');
  execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', shortcutPath, jsonPath], { stdio: 'pipe' });
  console.log('Patched image upload action to use Request Body: File (firstImage variable).');
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}
