import { WebContainer } from '@webcontainer/api';
import { map, type MapStore } from 'nanostores';
import * as nodePath from 'node:path';
import type { BoltAction } from '~/types/actions';
import { createScopedLogger } from '~/utils/logger';
import { unreachable } from '~/utils/unreachable';
import type { ActionCallbackData } from './message-parser';

const logger = createScopedLogger('ActionRunner');

export type ActionStatus = 'pending' | 'running' | 'complete' | 'aborted' | 'failed';

export type BaseActionState = BoltAction & {
  status: Exclude<ActionStatus, 'failed'>;
  abort: () => void;
  executed: boolean;
  abortSignal: AbortSignal;
};

export type FailedActionState = BoltAction &
  Omit<BaseActionState, 'status'> & {
    status: Extract<ActionStatus, 'failed'>;
    error: string;
  };

export type ActionState = BaseActionState | FailedActionState;

type BaseActionUpdate = Partial<Pick<BaseActionState, 'status' | 'abort' | 'executed'>>;

export type ActionStateUpdate =
  | BaseActionUpdate
  | (Omit<BaseActionUpdate, 'status'> & { status: 'failed'; error: string });

type ActionsMap = MapStore<Record<string, ActionState>>;

export class ActionRunner {
  #webcontainer: Promise<WebContainer>;
  #currentExecutionPromise: Promise<void> = Promise.resolve();

  actions: ActionsMap = map({});

  constructor(webcontainerPromise: Promise<WebContainer>) {
    this.#webcontainer = webcontainerPromise;
  }

  addAction(data: ActionCallbackData) {
    const { actionId } = data;

    const actions = this.actions.get();
    const action = actions[actionId];

    if (action) {
      // action already added
      return;
    }

    const abortController = new AbortController();

    this.actions.setKey(actionId, {
      ...data.action,
      status: 'pending',
      executed: false,
      abort: () => {
        abortController.abort();
        this.#updateAction(actionId, { status: 'aborted' });
      },
      abortSignal: abortController.signal,
    });

    this.#currentExecutionPromise.then(() => {
      this.#updateAction(actionId, { status: 'running' });
    });
  }

  async runAction(data: ActionCallbackData) {
    const { actionId } = data;
    const action = this.actions.get()[actionId];

    if (!action) {
      unreachable(`Action ${actionId} not found`);
    }

    if (action.executed) {
      return;
    }

    this.#updateAction(actionId, { ...action, ...data.action, executed: true });

    this.#currentExecutionPromise = this.#currentExecutionPromise
      .then(() => {
        return this.#executeAction(actionId);
      })
      .catch((error) => {
        console.error('Action failed:', error);
      });
  }

  async #executeAction(actionId: string) {
    const action = this.actions.get()[actionId];

    this.#updateAction(actionId, { status: 'running' });

    try {
      switch (action.type) {
        case 'shell': {
          await this.#runShellAction(action);
          break;
        }
        case 'file': {
          await this.#runFileAction(action);
          break;
        }
        case 'import': {
          await this.#importRepository(action);
          break;
        }
      }

      this.#updateAction(actionId, {
        status: action.abortSignal.aborted ? 'aborted' : 'complete',
      });
    } catch (error) {
      this.#updateAction(actionId, {
        status: 'failed',
        error: error instanceof Error ? error.message : 'Action failed',
      });
      throw error;
    }
  }

  async #runShellAction(action: ActionState) {
    const webcontainer = await this.#webcontainer;

    logger.debug(`Starting shell command: ${action.content}`);

    const process = await webcontainer.spawn('jsh', ['-c', action.content], {
      env: { npm_config_yes: true },
    });

    action.abortSignal.addEventListener('abort', () => {
      logger.debug('Aborting shell command');
      process.kill();
    });

    const exitPromise = new Promise<number>((resolve, reject) => {
      process.exit.then(resolve).catch(reject);
    });

    process.output
      .pipeTo(
        new WritableStream({
          write(data) {
            logger.debug(`Process output: ${data}`);
            console.log(data);
          },
        }),
      )
      .catch((error: any) => {
        logger.error('Error piping process output:', error);
      });

    const exitCode = await Promise.race([
      exitPromise,
      new Promise<number>((resolve) => {
        setTimeout(() => {
          if (action.content.includes('next dev') || action.content.includes('npm')) {
            logger.debug('Long-running process detected, marking as complete');
            resolve(0);
          }
        }, 5000);
      }),
    ]);

    logger.debug(`Process terminated with code ${exitCode}`);

    if (exitCode !== 0 && !action.content.includes('next dev')) {
      throw new Error(`Process failed with exit code ${exitCode}`);
    }
  }

  async #runFileAction(action: ActionState) {
    if (action.type !== 'file') {
      unreachable('Expected file action');
    }

    const webcontainer = await this.#webcontainer;

    let folder = nodePath.dirname(action.filePath);

    // remove trailing slashes
    folder = folder.replace(/\/+$/g, '');

    if (folder !== '.') {
      try {
        await webcontainer.fs.mkdir(folder, { recursive: true });
        logger.debug('Created folder', folder);
      } catch (error) {
        logger.error('Failed to create folder\n\n', error);
      }
    }

    try {
      await webcontainer.fs.writeFile(action.filePath, action.content);
      logger.debug(`File written ${action.filePath}`);
    } catch (error) {
      logger.error('Failed to write file\n\n', error);
    }
  }

  async #importRepository(action: ActionState) {
    if (action.type !== 'import') {
      unreachable('Expected import action');
    }

    const webcontainer = await this.#webcontainer;
    logger.debug('Starting repository import');

    try {
      // Create base directory if needed
      const folder = action.targetPath || '.';
      if (folder !== '.') {
        await webcontainer.fs.mkdir(folder, { recursive: true });
      }

      // Write files from the import action
      for (const file of action.files) {
        const filePath = `${folder}/${file.path}`;
        const fileDir = nodePath.dirname(filePath);

        // Create directories if needed
        if (fileDir !== '.') {
          await webcontainer.fs.mkdir(fileDir, { recursive: true });
        }

        // Write file content
        await webcontainer.fs.writeFile(filePath, file.content);
        logger.debug(`Imported file: ${filePath}`);
      }

      // Run post-import commands if specified
      if (action.postImportCommands?.length) {
        for (const command of action.postImportCommands) {
          const process = await webcontainer.spawn('jsh', ['-c', command]);

          // Handle command output
          process.output.pipeTo(
            new WritableStream({
              write(data) {
                logger.debug(`Command output: ${data}`);
                console.log(data);
              },
            }),
          );

          const exitCode = await process.exit;
          if (exitCode !== 0) {
            throw new Error(`Post-import command failed: ${command}`);
          }
        }
      }

      logger.debug('Repository import completed successfully');
    } catch (error) {
      logger.error('Repository import failed:', error);
      throw error;
    }
  }

  #updateAction(id: string, newState: ActionStateUpdate) {
    const actions = this.actions.get();

    this.actions.setKey(id, { ...actions[id], ...newState });
  }
}
