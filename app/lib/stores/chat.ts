import { map } from 'nanostores';

export interface Message {
  id: string;
  content: string;
  role: 'user' | 'assistant';
  timestamp: number;
}

export interface ChatStore {
  started: boolean;
  aborted: boolean;
  showChat: boolean;
  messages: Message[];
  pendingMessage: Message | null;
  isGenerating: boolean;
  error: string | null;
  currentAssistantMessage: string | null;
}

const initialState: ChatStore = {
  started: false,
  aborted: false,
  showChat: true,
  messages: [],
  pendingMessage: null,
  isGenerating: false,
  error: null,
  currentAssistantMessage: null,
};

export const chatStore = map<ChatStore>(initialState);

export const clearChat = () => {
  chatStore.set(initialState);
};

export const addMessage = (message: Omit<Message, 'timestamp'>) => {
  const timestamp = Date.now();
  // Validate timestamp before adding
  if (isNaN(timestamp)) {
    console.error('Invalid timestamp generated');
    return;
  }

  const newMessage = {
    ...message,
    timestamp,
  };

  const currentMessages = chatStore.get().messages;
  chatStore.setKey('messages', [...currentMessages, newMessage]);
};
