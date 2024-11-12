import { toast } from 'react-toastify';
import { atom, map, type MapStore, type ReadableAtom, type WritableAtom } from 'nanostores';
import type { EditorDocument, ScrollPosition } from '~/components/editor/codemirror/CodeMirrorEditor';
import { ActionRunner } from '~/lib/runtime/action-runner';
import type { ActionCallbackData, ArtifactCallbackData } from '~/lib/runtime/message-parser';
import { webcontainer } from '~/lib/webcontainer';
import type { ITerminal } from '~/types/terminal';
import { unreachable } from '~/utils/unreachable';
import { EditorStore } from './editor';
import { FilesStore, type FileMap } from './files';
import { PreviewsStore } from './previews';
import { TerminalStore } from './terminal';
import JSZip from 'jszip';
import fileSaver from 'file-saver';
const { saveAs } = fileSaver;
import { Octokit } from '@octokit/rest';
import { Buffer } from 'buffer';
import { createScopedLogger } from '~/utils/logger';
const logger = createScopedLogger('WorkbenchStore');

export interface ArtifactState {
  id: string;
  title: string;
  closed: boolean;
  runner: ActionRunner;
}

export type ArtifactUpdateState = Pick<ArtifactState, 'title' | 'closed'>;

type Artifacts = MapStore<Record<string, ArtifactState>>;

export type WorkbenchViewType = 'code' | 'preview';

// Add type for repo response
type GitHubRepo = {
  data: {
    owner: {
      login: string;
    };
    name: string;
    default_branch: string;
    html_url: string;
  };
};

// Add import status type
export type ImportStatus = {
  stage: 'importing' | 'installing' | 'starting' | 'complete' | 'error';
  message: string;
  progress?: {
    current: number;
    total: number;
  };
};

export class WorkbenchStore {
  #previewsStore = new PreviewsStore(webcontainer);
  #filesStore = new FilesStore(webcontainer);
  #editorStore = new EditorStore(this.#filesStore);
  #terminalStore = new TerminalStore(webcontainer);

  artifacts: Artifacts = import.meta.hot?.data.artifacts ?? map({});

  showWorkbench: WritableAtom<boolean> = import.meta.hot?.data.showWorkbench ?? atom(false);
  currentView: WritableAtom<WorkbenchViewType> = import.meta.hot?.data.currentView ?? atom('code');
  unsavedFiles: WritableAtom<Set<string>> = import.meta.hot?.data.unsavedFiles ?? atom(new Set<string>());
  modifiedFiles = new Set<string>();
  artifactIdList: string[] = [];

  // Add status atom
  importStatus: WritableAtom<ImportStatus | null> = atom(null);

  terminalOutput = atom<string>('');
  aiTerminalOutput = atom<string>('');

  constructor() {
    if (import.meta.hot) {
      import.meta.hot.data.artifacts = this.artifacts;
      import.meta.hot.data.unsavedFiles = this.unsavedFiles;
      import.meta.hot.data.showWorkbench = this.showWorkbench;
      import.meta.hot.data.currentView = this.currentView;
    }
  }

  get previews() {
    return this.#previewsStore.previews;
  }

  get files() {
    return this.#filesStore.files;
  }

  get currentDocument(): ReadableAtom<EditorDocument | undefined> {
    return this.#editorStore.currentDocument;
  }

  get selectedFile(): ReadableAtom<string | undefined> {
    return this.#editorStore.selectedFile;
  }

  get firstArtifact(): ArtifactState | undefined {
    return this.#getArtifact(this.artifactIdList[0]);
  }

  get filesCount(): number {
    return this.#filesStore.filesCount;
  }

  get showTerminal() {
    return this.#terminalStore.showTerminal;
  }

  toggleTerminal(value?: boolean) {
    this.#terminalStore.toggleTerminal(value);
  }

  attachTerminal(terminal: ITerminal) {
    this.#terminalStore.attachTerminal(terminal);
  }

  onTerminalResize(cols: number, rows: number) {
    this.#terminalStore.onTerminalResize(cols, rows);
  }

  setDocuments(files: FileMap) {
    this.#editorStore.setDocuments(files);

    if (this.#filesStore.filesCount > 0 && this.currentDocument.get() === undefined) {
      // we find the first file and select it
      for (const [filePath, dirent] of Object.entries(files)) {
        if (dirent?.type === 'file') {
          this.setSelectedFile(filePath);
          break;
        }
      }
    }
  }

  setShowWorkbench(show: boolean) {
    this.showWorkbench.set(show);
  }

  setCurrentDocumentContent(newContent: string) {
    const filePath = this.currentDocument.get()?.filePath;

    if (!filePath) {
      return;
    }

    const originalContent = this.#filesStore.getFile(filePath)?.content;
    const unsavedChanges = originalContent !== undefined && originalContent !== newContent;

    this.#editorStore.updateFile(filePath, newContent);

    const currentDocument = this.currentDocument.get();

    if (currentDocument) {
      const previousUnsavedFiles = this.unsavedFiles.get();

      if (unsavedChanges && previousUnsavedFiles.has(currentDocument.filePath)) {
        return;
      }

      const newUnsavedFiles = new Set(previousUnsavedFiles);

      if (unsavedChanges) {
        newUnsavedFiles.add(currentDocument.filePath);
      } else {
        newUnsavedFiles.delete(currentDocument.filePath);
      }

      this.unsavedFiles.set(newUnsavedFiles);
    }
  }

  setCurrentDocumentScrollPosition(position: ScrollPosition) {
    const editorDocument = this.currentDocument.get();

    if (!editorDocument) {
      return;
    }

    const { filePath } = editorDocument;

    this.#editorStore.updateScrollPosition(filePath, position);
  }

  setSelectedFile(filePath: string | undefined) {
    this.#editorStore.setSelectedFile(filePath);
  }

  async saveFile(filePath: string) {
    const documents = this.#editorStore.documents.get();
    const document = documents[filePath];

    if (document === undefined) {
      return;
    }

    await this.#filesStore.saveFile(filePath, document.value);

    const newUnsavedFiles = new Set(this.unsavedFiles.get());
    newUnsavedFiles.delete(filePath);

    this.unsavedFiles.set(newUnsavedFiles);
  }

  async saveCurrentDocument() {
    const currentDocument = this.currentDocument.get();

    if (currentDocument === undefined) {
      return;
    }

    await this.saveFile(currentDocument.filePath);
  }

  resetCurrentDocument() {
    const currentDocument = this.currentDocument.get();

    if (currentDocument === undefined) {
      return;
    }

    const { filePath } = currentDocument;
    const file = this.#filesStore.getFile(filePath);

    if (!file) {
      return;
    }

    this.setCurrentDocumentContent(file.content);
  }

  async saveAllFiles() {
    for (const filePath of this.unsavedFiles.get()) {
      await this.saveFile(filePath);
    }
  }

  getFileModifcations() {
    return this.#filesStore.getFileModifications();
  }

  resetAllFileModifications() {
    this.#filesStore.resetFileModifications();
  }

  abortAllActions() {
    // TODO: what do we wanna do and how do we wanna recover from this?
  }

  addArtifact({ messageId, title, id }: ArtifactCallbackData) {
    const artifact = this.#getArtifact(messageId);

    if (artifact) {
      return;
    }

    if (!this.artifactIdList.includes(messageId)) {
      this.artifactIdList.push(messageId);
    }

    this.artifacts.setKey(messageId, {
      id,
      title,
      closed: false,
      runner: new ActionRunner(webcontainer),
    });
  }

  updateArtifact({ messageId }: ArtifactCallbackData, state: Partial<ArtifactUpdateState>) {
    const artifact = this.#getArtifact(messageId);

    if (!artifact) {
      return;
    }

    this.artifacts.setKey(messageId, { ...artifact, ...state });
  }

  async addAction(data: ActionCallbackData) {
    const { messageId } = data;
    logger.debug('Adding action', { messageId, action: data.action });

    const artifact = this.#getArtifact(messageId);

    if (!artifact) {
      logger.error('Artifact not found for action', { messageId });
      unreachable('Artifact not found');
    }

    artifact.runner.addAction(data);
  }

  async runAction(data: ActionCallbackData) {
    const { messageId } = data;
    logger.debug('Running action', { messageId, action: data.action });

    const artifact = this.#getArtifact(messageId);

    if (!artifact) {
      logger.error('Artifact not found for action', { messageId });
      unreachable('Artifact not found');
    }

    try {
      await artifact.runner.runAction(data);
      logger.debug('Action completed', { messageId, action: data.action });
    } catch (error) {
      logger.error('Action failed', { messageId, action: data.action, error });
    }
  }

  #getArtifact(id: string) {
    const artifacts = this.artifacts.get();
    return artifacts[id];
  }

  async downloadZip() {
    const zip = new JSZip();
    const files = this.files.get();

    for (const [filePath, dirent] of Object.entries(files)) {
      if (dirent?.type === 'file' && !dirent.isBinary) {
        // remove '/home/project/' from the beginning of the path
        const relativePath = filePath.replace(/^\/home\/project\//, '');

        // split the path into segments
        const pathSegments = relativePath.split('/');

        // if there's more than one segment, we need to create folders
        if (pathSegments.length > 1) {
          let currentFolder = zip;

          for (let i = 0; i < pathSegments.length - 1; i++) {
            currentFolder = currentFolder.folder(pathSegments[i])!;
          }
          currentFolder.file(pathSegments[pathSegments.length - 1], dirent.content);
        } else {
          // if there's only one segment, it's a file in the root
          zip.file(relativePath, dirent.content);
        }
      }
    }

    const content = await zip.generateAsync({ type: 'blob' });
    saveAs(content, 'project.zip');
  }

  async syncFiles(targetHandle: FileSystemDirectoryHandle) {
    const files = this.files.get();
    const syncedFiles = [];

    for (const [filePath, dirent] of Object.entries(files)) {
      if (dirent?.type === 'file' && !dirent.isBinary) {
        const relativePath = filePath.replace(/^\/home\/project\//, '');
        const pathSegments = relativePath.split('/');
        let currentHandle = targetHandle;

        for (let i = 0; i < pathSegments.length - 1; i++) {
          currentHandle = await currentHandle.getDirectoryHandle(pathSegments[i], { create: true });
        }

        // create or get the file
        const fileHandle = await currentHandle.getFileHandle(pathSegments[pathSegments.length - 1], { create: true });

        // write the file content
        const writable = await fileHandle.createWritable();
        await writable.write(dirent.content);
        await writable.close();

        syncedFiles.push(relativePath);
      }
    }

    return syncedFiles;
  }

  async pushToGitHub(repoName: string, githubUsername: string, ghToken: string) {
    try {
      const githubToken = ghToken;
      const owner = githubUsername;

      if (!githubToken) {
        throw new Error('GitHub token is not set in environment variables');
      }

      const octokit = new Octokit({ auth: githubToken });

      let repoData: GitHubRepo['data'];
      try {
        const { data } = await octokit.repos.get({ owner, repo: repoName });
        repoData = data;
      } catch (error) {
        if (error instanceof Error && 'status' in error && error.status === 404) {
          const { data } = await octokit.repos.createForAuthenticatedUser({
            name: repoName,
            private: false,
            auto_init: true,
          });
          repoData = data;
        } else {
          console.log('cannot create repo!');
          throw error;
        }
      }

      const files = this.files.get();
      if (!files || Object.keys(files).length === 0) {
        throw new Error('No files found to push');
      }

      const blobs = await Promise.all(
        Object.entries(files).map(async ([filePath, dirent]) => {
          if (dirent?.type === 'file' && dirent.content) {
            const { data: blob } = await octokit.git.createBlob({
              owner: repoData.owner.login,
              repo: repoData.name,
              content: Buffer.from(dirent.content).toString('base64'),
              encoding: 'base64',
            });
            return { path: filePath.replace(/^\/home\/project\//, ''), sha: blob.sha };
          }
        }),
      );

      const validBlobs = blobs.filter(Boolean);

      if (validBlobs.length === 0) {
        throw new Error('No valid files to push');
      }

      const { data: ref } = await octokit.git.getRef({
        owner: repoData.owner.login,
        repo: repoData.name,
        ref: `heads/${repoData.default_branch || 'main'}`,
      });
      const latestCommitSha = ref.object.sha;

      const { data: newTree } = await octokit.git.createTree({
        owner: repoData.owner.login,
        repo: repoData.name,
        base_tree: latestCommitSha,
        tree: validBlobs.map((blob) => ({
          path: blob!.path,
          mode: '100644',
          type: 'blob',
          sha: blob!.sha,
        })),
      });

      const { data: newCommit } = await octokit.git.createCommit({
        owner: repoData.owner.login,
        repo: repoData.name,
        message: 'Initial commit from your app',
        tree: newTree.sha,
        parents: [latestCommitSha],
      });

      await octokit.git.updateRef({
        owner: repoData.owner.login,
        repo: repoData.name,
        ref: `heads/${repoData.default_branch || 'main'}`,
        sha: newCommit.sha,
      });

      alert(`Repository created and code pushed: ${repoData.html_url}`);
    } catch (error) {
      console.error('Error pushing to GitHub:', error instanceof Error ? error.message : String(error));
    }
  }

  async importLocalRepo(directoryHandle: FileSystemDirectoryHandle) {
    try {
      await this.#filesStore.clearFiles();

      // First count total files (excluding node_modules)
      let totalFiles = 0;
      const countFiles = async (dirHandle: FileSystemDirectoryHandle) => {
        for await (const entry of dirHandle.values()) {
          // Skip node_modules directory and hidden files
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;

          if (entry.kind === 'file') {
            totalFiles++;
          } else if (entry.kind === 'directory') {
            await countFiles(entry as FileSystemDirectoryHandle);
          }
        }
      };
      await countFiles(directoryHandle);

      this.importStatus.set({
        stage: 'importing',
        message: 'Importing project files...',
        progress: { current: 0, total: totalFiles },
      });

      let currentFiles = 0;
      const readDirectory = async (dirHandle: FileSystemDirectoryHandle, path = '') => {
        for await (const entry of dirHandle.values()) {
          // Skip node_modules directory and hidden files
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;

          const entryPath = path ? `${path}/${entry.name}` : entry.name;

          if (entry.kind === 'file') {
            try {
              const fileHandle = entry as FileSystemFileHandle;
              const file = await fileHandle.getFile();

              // Skip files larger than 10MB
              if (file.size > 10 * 1024 * 1024) {
                console.warn(`Skipping large file: ${entryPath} (${(file.size / 1024 / 1024).toFixed(2)}MB)`);
                currentFiles++;
                this.importStatus.set({
                  stage: 'importing',
                  message: 'Importing project files...',
                  progress: { current: currentFiles, total: totalFiles },
                });
                continue;
              }

              // Read file in chunks if it's larger than 1MB
              let content = '';
              if (file.size > 1024 * 1024) {
                const chunks = [];
                const reader = file.stream().getReader();

                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  chunks.push(new TextDecoder().decode(value));
                }
                content = chunks.join('');
              } else {
                content = await file.text();
              }

              await this.#filesStore.saveFile(`/home/project/${entryPath}`, content);
              currentFiles++;

              this.importStatus.set({
                stage: 'importing',
                message: 'Importing project files...',
                progress: { current: currentFiles, total: totalFiles },
              });
            } catch (error) {
              console.error(`Error importing file ${entryPath}:`, error);
              // Continue with next file instead of failing the whole import
              currentFiles++;
              this.importStatus.set({
                stage: 'importing',
                message: `Skipped file ${entryPath} due to error`,
                progress: { current: currentFiles, total: totalFiles },
              });
            }
          } else if (entry.kind === 'directory') {
            await readDirectory(entry as FileSystemDirectoryHandle, entryPath);
          }
        }
      };

      await readDirectory(directoryHandle);

      // Show the workbench after import
      this.setShowWorkbench(true);
      this.currentView.set('code');

      this.importStatus.set({ stage: 'complete', message: 'Project imported successfully!' });
      toast.success('Project imported! Check the chat for next steps.');

      return true;
    } catch (error) {
      console.error('Error importing repository:', error);
      this.importStatus.set({ stage: 'error', message: 'Failed to import repository' });
      throw error;
    }
  }

  async runAICommand(command: string) {
    this.aiTerminalOutput.set(this.aiTerminalOutput.get() + '\n> ' + command);
    // Implement command execution logic here
  }
}

export const workbenchStore = new WorkbenchStore();
