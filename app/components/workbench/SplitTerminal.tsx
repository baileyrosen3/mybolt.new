import { useStore } from '@nanostores/react';
import { workbenchStore } from '~/lib/stores/workbench';
import { classNames } from '~/utils/classNames';

export const SplitTerminal = () => {
  const aiTerminalOutput = useStore(workbenchStore.aiTerminalOutput);
  const userTerminalOutput = useStore(workbenchStore.terminalOutput);
  const terminalVisible = useStore(workbenchStore.showTerminal);

  if (!terminalVisible) return null;

  return (
    <div className="flex h-full gap-2 p-2">
      {/* User Terminal */}
      <div className="flex-1 bg-[#1E1E1E] rounded-lg overflow-hidden flex flex-col">
        <div className="px-4 py-2 bg-[#2D2D2D] text-gray-300 text-sm font-medium">User Terminal</div>
        <div className="flex-1 p-4 font-mono text-sm text-gray-300 whitespace-pre-wrap overflow-auto">
          {userTerminalOutput || 'No output yet...'}
        </div>
      </div>

      {/* AI Terminal */}
      <div className="flex-1 bg-[#1E1E1E] rounded-lg overflow-hidden flex flex-col">
        <div className="px-4 py-2 bg-[#2D2D2D] text-gray-300 text-sm font-medium">Bolt Terminal</div>
        <div className="flex-1 p-4 font-mono text-sm text-gray-300 whitespace-pre-wrap overflow-auto">
          {aiTerminalOutput || 'No output yet...'}
        </div>
      </div>
    </div>
  );
};
