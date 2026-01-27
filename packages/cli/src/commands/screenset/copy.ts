import fs from 'fs-extra';
import path from 'path';
import type { CommandDefinition } from '../../core/command.js';
import type { ScreensetCategory } from '../../core/types.js';
import { validationOk, validationError } from '../../core/types.js';
import {
  parseIdsFile,
  generateTransformationMap,
  transformContent,
  transformFileName,
} from '../../generators/transform.js';
import { toPascalCase } from '../../generators/utils.js';
import { copyDirectoryWithTransform } from '../../utils/fs.js';
import { getScreensetsDir, screensetExists, loadConfig } from '../../utils/project.js';
import { isCamelCase, isReservedScreensetName } from '../../utils/validation.js';

/**
 * Arguments for screenset copy command
 */
export interface ScreensetCopyArgs {
  source: string;
  target: string;
  category?: ScreensetCategory;
}

/**
 * Result of screenset copy command
 */
export interface ScreensetCopyResult {
  sourcePath: string;
  targetPath: string;
  files: string[];
  transformations: number;
}

/**
 * Screenset copy command implementation
 */
export const screensetCopyCommand: CommandDefinition<
  ScreensetCopyArgs,
  ScreensetCopyResult
> = {
  name: 'screenset:copy',
  description: 'Copy an existing screenset with transformed IDs',
  args: [
    {
      name: 'source',
      description: 'Name of the source screenset',
      required: true,
    },
    {
      name: 'target',
      description: 'Name of the target screenset',
      required: true,
    },
  ],
  options: [
    {
      name: 'category',
      shortName: 'c',
      description: 'Category for the new screenset (overrides source)',
      type: 'string',
      choices: ['drafts', 'mockups', 'production'],
    },
  ],

  validate(args, ctx) {
    // Must be inside a project
    if (!ctx.projectRoot) {
      return validationError(
        'NOT_IN_PROJECT',
        'Not inside a HAI3 project. Run this command from a project root.'
      );
    }

    // Validate source
    if (!args.source) {
      return validationError('MISSING_SOURCE', 'Source screenset name is required');
    }

    // Validate target
    if (!args.target) {
      return validationError('MISSING_TARGET', 'Target screenset name is required');
    }

    if (!isCamelCase(args.target)) {
      return validationError(
        'INVALID_TARGET_NAME',
        "Target screenset name must be camelCase (e.g., 'billing', 'userProfile')"
      );
    }

    if (isReservedScreensetName(args.target)) {
      return validationError(
        'RESERVED_NAME',
        `'${args.target}' is a reserved name and cannot be used`
      );
    }

    if (args.source === args.target) {
      return validationError(
        'SAME_NAME',
        'Source and target screenset names must be different'
      );
    }

    return validationOk();
  },

  async execute(args, ctx): Promise<ScreensetCopyResult> {
    const { logger, projectRoot } = ctx;
    const { source, target } = args;
    // Default category to 'drafts' for copies
    const category: ScreensetCategory = args.category ?? 'drafts';

    // Check if UIKit is configured - screensets require a UI kit
    const config = await loadConfig(projectRoot!);
    if (!config?.uikit || config.uikit === 'none') {
      throw new Error(
        'Cannot copy screenset: No UI kit configured.\n' +
        'Screensets require UI components (Button, Card, etc.) from a UI kit.\n' +
        'Please install a UI kit first, then update hai3.config.json with your uikit identifier.\n' +
        'Example: { "hai3": true, "layer": "app", "uikit": "@hai3/uikit" }'
      );
    }

    const screensetsDir = getScreensetsDir(projectRoot!);
    const sourcePath = path.join(screensetsDir, source);
    const targetPath = path.join(screensetsDir, target);

    // Check source exists
    if (!(await screensetExists(projectRoot!, source))) {
      throw new Error(
        `Source screenset '${source}' not found at src/screensets/${source}/`
      );
    }

    // Check target doesn't exist
    if (await screensetExists(projectRoot!, target)) {
      throw new Error(
        `Target screenset '${target}' already exists at src/screensets/${target}/`
      );
    }

    logger.info(`Copying screenset '${source}' to '${target}'...`);
    logger.newline();

    // Parse source ids.ts
    const idsFilePath = path.join(sourcePath, 'ids.ts');
    if (!(await fs.pathExists(idsFilePath))) {
      throw new Error(`Source screenset is missing ids.ts file`);
    }

    logger.step(1, 3, 'Analyzing source screenset...');
    const originalIds = await parseIdsFile(idsFilePath);
    const transformations = generateTransformationMap(source, target, originalIds);
    logger.success(`Found ${transformations.length} IDs to transform`);

    // Build category transformation
    const categoryEnumMap: Record<ScreensetCategory, string> = {
      drafts: 'ScreensetCategory.Drafts',
      mockups: 'ScreensetCategory.Mockups',
      production: 'ScreensetCategory.Production',
    };
    const newCategoryValue = categoryEnumMap[category];

    // Build screenset name for display (PascalCase with spaces)
    const targetDisplayName = toPascalCase(target);

    // Copy with transformations
    logger.step(2, 3, 'Copying and transforming files...');
    const copiedFiles = await copyDirectoryWithTransform(
      sourcePath,
      targetPath,
      (content, _filePath) => {
        let result = transformContent(content, source, target, transformations);
        // Update category
        result = result.replace(
          /ScreensetCategory\.(Drafts|Mockups|Production)/g,
          newCategoryValue
        );
        // Update screenset display name (e.g., name: 'Chat' -> name: 'ChatCopy')
        result = result.replace(
          /^(\s*name:\s*)['"]([^'"]+)['"]/m,
          `$1'${targetDisplayName}'`
        );
        return result;
      },
      (fileName) => transformFileName(fileName, source, target)
    );

    logger.success(`Copied ${copiedFiles.length} files`);

    // Done
    logger.step(3, 3, 'Done!');
    logger.newline();
    logger.success(`Created screenset '${target}' from '${source}'`);
    logger.newline();
    logger.log('Next steps:');
    logger.log(`  1. Review src/screensets/${target}/ids.ts`);
    logger.log(`  2. Update translations as needed`);
    logger.log(`  3. Run 'npm run arch:check' to verify`);
    logger.newline();

    return {
      sourcePath,
      targetPath,
      files: copiedFiles,
      transformations: transformations.length,
    };
  },
};
